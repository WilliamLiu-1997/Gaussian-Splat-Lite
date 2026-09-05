use std::array;
use std::collections::HashMap;
use std::f32::consts::SQRT_2;

use anyhow::anyhow;

use crate::decoder::{ChunkReceiver, SplatInit, SplatProps, SplatReceiver};

pub const PLY_MAGIC: u32 = 0x00796c70; // "ply"
const MAX_SPLAT_CHUNK: usize = 65536;
const SH_C0: f32 = 0.28209479177387814;
const SUPER_CHUNK_SIZE: usize = 256;
const POINT_CLOUD_PROPERTIES: [&str; 6] = ["x", "y", "z", "red", "green", "blue"];
const DEFAULT_POINT_SCALE: f32 = 0.001;

pub struct PlyDecoder<T: SplatReceiver> {
    splats: T,
    buffer: Vec<u8>,
    state: Option<PlyState>,
}

impl<T: SplatReceiver> PlyDecoder<T> {
    pub fn new(splats: T) -> Self {
        Self {
            splats,
            buffer: Vec::new(),
            state: None,
        }
    }

    pub fn into_splats(self) -> T {
        self.splats
    }

    fn poll(&mut self) -> anyhow::Result<()> {
        if self.state.is_none() {
            self.poll_header()?;
        }
        if self.state.is_some() {
            self.poll_data()?;
        }
        Ok(())
    }

    fn poll_header(&mut self) -> anyhow::Result<()> {
        if self.buffer.len() < 4 {
            return Ok(());
        }
        let magic = u32::from_le_bytes([
            self.buffer[0],
            self.buffer[1],
            self.buffer[2],
            self.buffer[3],
        ]);
        if (magic & 0x00ffffff) != PLY_MAGIC {
            return Err(anyhow!("Invalid PLY file"));
        }

        const TERMINATOR: &[u8] = b"end_header\n";
        let header_end = self
            .buffer
            .windows(TERMINATOR.len())
            .position(|window| window == TERMINATOR);
        let Some(header_end) = header_end else {
            if self.buffer.len() >= 65536 {
                return Err(anyhow!("PLY header too large"));
            }
            return Ok(());
        };

        let header = std::str::from_utf8(&self.buffer[..header_end])?;
        let parsed = parse_header(header)?;

        let state = if parsed.is_supersplat {
            let state = SuperSplatState::new(parsed)?;
            self.splats.init_splats(&SplatInit {
                num_splats: state.num_splats,
                max_sh_degree: state.max_sh_degree,
            })?;
            PlyState::SuperSplat(state)
        } else if parsed.is_pointcloud {
            let state = PointCloudDecoderState::new(
                parsed.num_splats,
                parsed.vertex.record_size,
                &parsed.vertex.properties,
            )?;
            self.splats.init_splats(&SplatInit {
                num_splats: parsed.num_splats,
                max_sh_degree: 0,
            })?;
            PlyState::PointCloud(state)
        } else {
            let state = PlyDecoderState::new(
                parsed.num_splats,
                parsed.vertex.record_size,
                &parsed.vertex.properties,
            )?;
            self.splats.init_splats(&SplatInit {
                num_splats: parsed.num_splats,
                max_sh_degree: state.max_sh_degree,
            })?;
            PlyState::Standard(state)
        };

        self.buffer.drain(..header_end + TERMINATOR.len());
        self.state = Some(state);
        Ok(())
    }

    fn poll_data(&mut self) -> anyhow::Result<()> {
        match self.state {
            Some(PlyState::PointCloud(_)) => self.poll_data_pointcloud(),
            Some(PlyState::Standard(_)) => self.poll_data_standard(),
            Some(PlyState::SuperSplat(_)) => self.poll_data_supersplat(),
            None => unreachable!(),
        }
    }

    fn poll_data_pointcloud(&mut self) -> anyhow::Result<()> {
        let Some(PlyState::PointCloud(state)) = self.state.as_mut() else {
            unreachable!()
        };
        let mut offset = 0;
        loop {
            let available = (self.buffer.len() - offset) / state.record_size;
            let remaining = state.num_splats.saturating_sub(state.next_splat);
            let count = remaining.min(available).min(MAX_SPLAT_CHUNK);
            if count == 0 {
                break;
            }

            state.output.ensure(count, 0);

            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                let base = offset + i * state.record_size;

                for d in 0..3 {
                    state.output.center[i3 + d] = state.xyz[d].get_f32(&self.buffer, base);
                }
                state.output.opacity[i] = match state.alpha {
                    Some(alpha) => alpha.get_f32(&self.buffer, base),
                    None => 1.0,
                };
                for d in 0..3 {
                    state.output.rgb[i3 + d] = state.rgb[d].get_f32(&self.buffer, base);
                }
                state.output.scale[i3..i3 + 3].fill(DEFAULT_POINT_SCALE);
                state.output.quat[i4..i4 + 4].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
            }

            self.splats.set_batch(
                state.next_splat,
                count,
                &SplatProps {
                    scale: &state.output.scale[..count * 3],
                    ..state.output.props(count, 0)
                },
            );

            state.next_splat += count;
            offset += count * state.record_size;
        }

        self.buffer.drain(..offset);
        Ok(())
    }

    fn poll_data_standard(&mut self) -> anyhow::Result<()> {
        let Some(PlyState::Standard(state)) = self.state.as_mut() else {
            unreachable!()
        };
        let mut offset = 0;
        loop {
            let available = (self.buffer.len() - offset) / state.record_size;
            let remaining = state.num_splats.saturating_sub(state.next_splat);
            let count = remaining.min(available).min(MAX_SPLAT_CHUNK);
            if count == 0 {
                break;
            }

            state.output.ensure(count, state.max_sh_degree);

            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                let base = offset + i * state.record_size;

                for d in 0..3 {
                    state.output.center[i3 + d] = state.xyz[d].get_f32(&self.buffer, base);
                }
                let op_logistic = state.op_logi.get_f32(&self.buffer, base);
                state.output.opacity[i] = 1.0 / (1.0 + (-op_logistic).exp());
                for d in 0..3 {
                    state.output.rgb[i3 + d] =
                        0.5 + state.f_dc[d].get_f32(&self.buffer, base) * SH_C0;
                }
                for d in 0..3 {
                    state.output.scale[i3 + d] = state.scale[d].get_f32(&self.buffer, base);
                }
                let quat: [f32; 4] = array::from_fn(|d| state.rot[d].get_f32(&self.buffer, base));
                let quat_magnitude = quat.map(|x| x.powi(2)).iter().sum::<f32>().sqrt();
                for d in 0..4 {
                    state.output.quat[i4 + d] = quat[d] / quat_magnitude;
                }

                if let Some(sh1) = state.sh1 {
                    let i9 = i * 9;
                    for d in 0..9 {
                        state.output.sh1[i9 + d] = sh1[d].get_f32(&self.buffer, base);
                    }
                }
                if let Some(sh2) = state.sh2 {
                    let i15 = i * 15;
                    for d in 0..15 {
                        state.output.sh2[i15 + d] = sh2[d].get_f32(&self.buffer, base);
                    }
                }
                if let Some(sh3) = state.sh3 {
                    let i21 = i * 21;
                    for d in 0..21 {
                        state.output.sh3[i21 + d] = sh3[d].get_f32(&self.buffer, base);
                    }
                }
            }

            self.splats.set_batch_ln_scale(
                state.next_splat,
                count,
                &state.output.props(count, state.max_sh_degree),
                &state.output.scale[..count * 3],
            );

            state.next_splat += count;
            offset += count * state.record_size;
        }

        self.buffer.drain(..offset);
        Ok(())
    }

    fn poll_data_supersplat(&mut self) -> anyhow::Result<()> {
        let Some(PlyState::SuperSplat(state)) = self.state.as_mut() else {
            unreachable!()
        };
        let mut offset = 0;
        while state.current_element < state.elements.len() {
            let elem_kind;
            let elem_count;
            let elem_record_size;
            let elem_read;
            {
                let elem = &state.elements[state.current_element];
                elem_kind = elem.kind;
                elem_count = elem.desc.count;
                elem_record_size = elem.desc.record_size;
                elem_read = elem.read;
            }

            let available = (self.buffer.len() - offset) / elem_record_size;
            if available == 0 {
                break;
            }
            let remaining = elem_count.saturating_sub(elem_read);
            let chunk = remaining.min(available).min(MAX_SPLAT_CHUNK);
            if chunk == 0 {
                break;
            }

            match elem_kind {
                PlyElementKind::Chunk => {
                    state.decode_chunks(chunk, offset, elem_record_size, &self.buffer)?;
                }
                PlyElementKind::Vertex => {
                    state.decode_vertices(
                        chunk,
                        elem_read,
                        offset,
                        elem_record_size,
                        &self.buffer,
                    )?;
                    self.splats.set_batch_ln_scale(
                        elem_read,
                        chunk,
                        &state.output.props(chunk, 0),
                        &state.output.scale[..chunk * 3],
                    );
                }
                PlyElementKind::Sh => {
                    if state.sh_props.is_some() {
                        state.decode_sh(chunk, elem_read, offset, elem_record_size, &self.buffer);
                        self.splats.set_sh(
                            elem_read,
                            chunk,
                            &state.output.sh1[..chunk * 9],
                            if state.max_sh_degree >= 2 {
                                &state.output.sh2[..chunk * 15]
                            } else {
                                &[][..]
                            },
                            if state.max_sh_degree >= 3 {
                                &state.output.sh3[..chunk * 21]
                            } else {
                                &[][..]
                            },
                        );
                    }
                }
                PlyElementKind::Other => {
                    // Skip unknown element
                }
            }

            {
                let elem = &mut state.elements[state.current_element];
                elem.read += chunk;
                if elem.read == elem.desc.count {
                    state.current_element += 1;
                }
            }
            offset += chunk * elem_record_size;
        }

        self.buffer.drain(..offset);
        Ok(())
    }
}

impl<T: SplatReceiver> ChunkReceiver for PlyDecoder<T> {
    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any> {
        self
    }

    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        self.buffer.extend_from_slice(bytes);
        self.poll()?;
        Ok(())
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        self.poll()?;

        let Some(state) = self.state.as_ref() else {
            return Err(anyhow!("Invalid PLY file"));
        };

        // Note: We don't check if buffer is empty here because PLY files can have
        // trailing data (padding, comments, etc.) after the declared number of elements.
        // As long as we've read the correct number of splats, we're good.

        match state {
            PlyState::PointCloud(state) => {
                if state.next_splat != state.num_splats {
                    return Err(anyhow!(
                        "Expected {} splats, got {}",
                        state.num_splats,
                        state.next_splat
                    ));
                }
            }
            PlyState::Standard(state) => {
                if state.next_splat != state.num_splats {
                    return Err(anyhow!(
                        "Expected {} splats, got {}",
                        state.num_splats,
                        state.next_splat
                    ));
                }
            }
            PlyState::SuperSplat(state) => {
                if let Some(vertex_elem) = state
                    .elements
                    .iter()
                    .find(|e| matches!(e.kind, PlyElementKind::Vertex))
                {
                    if vertex_elem.read != vertex_elem.desc.count
                        || vertex_elem.desc.count != state.num_splats
                    {
                        return Err(anyhow!(
                            "Expected {} splats, got {}",
                            state.num_splats,
                            vertex_elem.read
                        ));
                    }
                }
                if let Some(sh_elem) = state
                    .elements
                    .iter()
                    .find(|e| matches!(e.kind, PlyElementKind::Sh))
                {
                    if sh_elem.read != sh_elem.desc.count {
                        return Err(anyhow!(
                            "Expected {} SH records, got {}",
                            sh_elem.desc.count,
                            sh_elem.read
                        ));
                    }
                }
            }
        }

        self.splats.finish()?;
        Ok(())
    }
}

#[derive(Debug)]
enum PlyState {
    PointCloud(PointCloudDecoderState),
    Standard(PlyDecoderState),
    SuperSplat(SuperSplatState),
}

#[derive(Clone, Debug)]
struct PlyElementDesc {
    name: String,
    count: usize,
    record_size: usize,
    properties: HashMap<String, PlyProperty>,
}

#[derive(Default)]
struct PlyElementBuilder {
    name: String,
    count: usize,
    properties: Vec<(String, PlyProperty)>,
    record_size: usize,
}

impl PlyElementBuilder {
    fn new(name: &str, count: usize) -> Self {
        Self {
            name: name.to_string(),
            count,
            ..Default::default()
        }
    }

    fn add_property(&mut self, name: &str, ty: PlyPropertyType) {
        let prop = PlyProperty {
            ty,
            offset: self.record_size,
        };
        self.record_size += ty.size();
        self.properties.push((name.to_string(), prop));
    }

    fn build(self) -> PlyElementDesc {
        PlyElementDesc {
            name: self.name,
            count: self.count,
            record_size: self.record_size,
            properties: self.properties.into_iter().collect(),
        }
    }
}

struct ParsedHeader {
    elements: Vec<PlyElementDesc>,
    vertex: PlyElementDesc,
    chunk: Option<PlyElementDesc>,
    sh: Option<PlyElementDesc>,
    num_splats: usize,
    is_pointcloud: bool,
    is_supersplat: bool,
}

fn parse_property_type(s: &str) -> anyhow::Result<PlyPropertyType> {
    let ty = match s {
        "char" => PlyPropertyType::Char,
        "uchar" => PlyPropertyType::Uchar,
        "short" => PlyPropertyType::Short,
        "ushort" => PlyPropertyType::Ushort,
        "int" => PlyPropertyType::Int,
        "uint" => PlyPropertyType::Uint,
        "float" => PlyPropertyType::Float,
        "double" => PlyPropertyType::Double,
        _ => return Err(anyhow!("Unsupported PLY property type: {}", s)),
    };
    Ok(ty)
}

fn parse_header(header: &str) -> anyhow::Result<ParsedHeader> {
    let mut builders: Vec<PlyElementBuilder> = Vec::new();
    let mut current: Option<PlyElementBuilder> = None;
    let mut format_seen = false;

    for (line_index, raw_line) in header.lines().enumerate() {
        let line = raw_line.trim();
        if line_index == 0 {
            if line != "ply" {
                return Err(anyhow!("Invalid PLY header"));
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }

        let fields: Vec<_> = line.split_whitespace().collect();
        match fields[0] {
            "format" if fields.len() == 3 => {
                format_seen = true;
                if fields[1] != "binary_little_endian" {
                    return Err(anyhow!("Unsupported PLY format: {}", fields[1]));
                }
                if fields[2] != "1.0" {
                    return Err(anyhow!("Unsupported PLY version: {}", fields[2]));
                }
            }
            "comment" | "obj_info" => {
                // ignore
            }
            "element" if fields.len() == 3 => {
                if let Some(cur) = current.take() {
                    builders.push(cur);
                }
                current = Some(PlyElementBuilder::new(fields[1], fields[2].parse()?));
            }
            "property" => {
                if fields.get(1).copied() == Some("list") {
                    return Err(anyhow!("PLY list properties are not supported"));
                }
                if fields.len() != 3 {
                    return Err(anyhow!("Invalid property line: {}", line));
                }
                let Some(cur) = current.as_mut() else {
                    return Err(anyhow!("Property outside of element"));
                };
                let ty = parse_property_type(fields[1])?;
                cur.add_property(fields[2], ty);
            }
            "end_header" => {
                break;
            }
            _ => return Err(anyhow!("Unsupported PLY header line: {}", line)),
        }
    }

    if let Some(cur) = current.take() {
        builders.push(cur);
    }
    if !format_seen {
        return Err(anyhow!("Missing PLY format line"));
    }

    let elements: Vec<PlyElementDesc> = builders.into_iter().map(|b| b.build()).collect();
    let vertex = elements
        .iter()
        .find(|e| e.name == "vertex")
        .cloned()
        .ok_or(anyhow!("Missing vertex element"))?;
    let chunk = elements.iter().find(|e| e.name == "chunk").cloned();
    let sh = elements.iter().find(|e| e.name == "sh").cloned();
    let is_pointcloud = POINT_CLOUD_PROPERTIES
        .iter()
        .all(|&p| vertex.properties.contains_key(p));

    Ok(ParsedHeader {
        num_splats: vertex.count,
        vertex,
        chunk,
        sh,
        is_pointcloud,
        is_supersplat: elements.iter().any(|e| e.name == "chunk"),
        elements,
    })
}

#[derive(Clone, Copy, Debug)]
struct SuperSplatChunk {
    min_x: f32,
    min_y: f32,
    min_z: f32,
    max_x: f32,
    max_y: f32,
    max_z: f32,
    min_scale_x: f32,
    min_scale_y: f32,
    min_scale_z: f32,
    max_scale_x: f32,
    max_scale_y: f32,
    max_scale_z: f32,
    min_r: f32,
    min_g: f32,
    min_b: f32,
    max_r: f32,
    max_g: f32,
    max_b: f32,
}

#[derive(Clone, Copy, Debug)]
struct SuperSplatChunkProps {
    min_x: PlyProperty,
    min_y: PlyProperty,
    min_z: PlyProperty,
    max_x: PlyProperty,
    max_y: PlyProperty,
    max_z: PlyProperty,
    min_scale_x: PlyProperty,
    min_scale_y: PlyProperty,
    min_scale_z: PlyProperty,
    max_scale_x: PlyProperty,
    max_scale_y: PlyProperty,
    max_scale_z: PlyProperty,
    min_r: Option<PlyProperty>,
    min_g: Option<PlyProperty>,
    min_b: Option<PlyProperty>,
    max_r: Option<PlyProperty>,
    max_g: Option<PlyProperty>,
    max_b: Option<PlyProperty>,
}

#[derive(Clone, Copy, Debug)]
struct SuperSplatVertexProps {
    packed_position: PlyProperty,
    packed_rotation: PlyProperty,
    packed_scale: PlyProperty,
    packed_color: PlyProperty,
}

#[derive(Clone, Debug)]
struct SuperSplatShProps {
    f_rest: Vec<PlyProperty>,
    sh1_props: Vec<usize>,
    sh2_props: Vec<usize>,
    sh3_props: Vec<usize>,
    num_f_rest: usize,
}

#[derive(Debug, Default)]
struct PlyOutput {
    center: Vec<f32>,
    opacity: Vec<f32>,
    rgb: Vec<f32>,
    scale: Vec<f32>,
    quat: Vec<f32>,
    sh1: Vec<f32>,
    sh2: Vec<f32>,
    sh3: Vec<f32>,
}

impl PlyOutput {
    fn ensure(&mut self, count: usize, sh_degree: usize) {
        for (output, width) in [
            (&mut self.center, 3),
            (&mut self.opacity, 1),
            (&mut self.rgb, 3),
            (&mut self.scale, 3),
            (&mut self.quat, 4),
            (&mut self.sh1, if sh_degree >= 1 { 9 } else { 0 }),
            (&mut self.sh2, if sh_degree >= 2 { 15 } else { 0 }),
            (&mut self.sh3, if sh_degree >= 3 { 21 } else { 0 }),
        ] {
            if output.len() < count * width {
                output.resize(count * width, 0.0);
            }
        }
    }

    // Scale is supplied separately: point clouds use linear scale, while
    // standard and SuperSplat PLY records provide natural-log scale.
    fn props(&self, count: usize, sh_degree: usize) -> SplatProps<'_> {
        SplatProps {
            center: &self.center[..count * 3],
            opacity: &self.opacity[..count],
            rgb: &self.rgb[..count * 3],
            quat: &self.quat[..count * 4],
            sh1: &self.sh1[..if sh_degree >= 1 { count * 9 } else { 0 }],
            sh2: &self.sh2[..if sh_degree >= 2 { count * 15 } else { 0 }],
            sh3: &self.sh3[..if sh_degree >= 3 { count * 21 } else { 0 }],
            ..Default::default()
        }
    }
}

#[derive(Debug)]
struct SuperSplatState {
    elements: Vec<PlyElementState>,
    current_element: usize,
    num_splats: usize,
    max_sh_degree: usize,
    chunk_props: SuperSplatChunkProps,
    vertex_props: SuperSplatVertexProps,
    sh_props: Option<SuperSplatShProps>,
    chunks: Vec<SuperSplatChunk>,
    output: PlyOutput,
    temp_rest: Vec<f32>,
}

impl SuperSplatState {
    fn new(parsed: ParsedHeader) -> anyhow::Result<Self> {
        let chunk_desc = parsed
            .chunk
            .ok_or(anyhow!("Missing chunk element for SuperSplat PLY"))?;
        let vertex_desc = parsed.vertex;
        let expected_chunks = vertex_desc.count.div_ceil(SUPER_CHUNK_SIZE);
        if chunk_desc.count < expected_chunks {
            return Err(anyhow!(
                "Not enough chunk records: have {}, need at least {}",
                chunk_desc.count,
                expected_chunks
            ));
        }

        let chunk_props = SuperSplatChunkProps {
            min_x: required_property(&chunk_desc.properties, "min_x")?,
            min_y: required_property(&chunk_desc.properties, "min_y")?,
            min_z: required_property(&chunk_desc.properties, "min_z")?,
            max_x: required_property(&chunk_desc.properties, "max_x")?,
            max_y: required_property(&chunk_desc.properties, "max_y")?,
            max_z: required_property(&chunk_desc.properties, "max_z")?,
            min_scale_x: required_property(&chunk_desc.properties, "min_scale_x")?,
            min_scale_y: required_property(&chunk_desc.properties, "min_scale_y")?,
            min_scale_z: required_property(&chunk_desc.properties, "min_scale_z")?,
            max_scale_x: required_property(&chunk_desc.properties, "max_scale_x")?,
            max_scale_y: required_property(&chunk_desc.properties, "max_scale_y")?,
            max_scale_z: required_property(&chunk_desc.properties, "max_scale_z")?,
            min_r: chunk_desc.properties.get("min_r").copied(),
            min_g: chunk_desc.properties.get("min_g").copied(),
            min_b: chunk_desc.properties.get("min_b").copied(),
            max_r: chunk_desc.properties.get("max_r").copied(),
            max_g: chunk_desc.properties.get("max_g").copied(),
            max_b: chunk_desc.properties.get("max_b").copied(),
        };

        let vertex_props = SuperSplatVertexProps {
            packed_position: required_property(&vertex_desc.properties, "packed_position")?,
            packed_rotation: required_property(&vertex_desc.properties, "packed_rotation")?,
            packed_scale: required_property(&vertex_desc.properties, "packed_scale")?,
            packed_color: required_property(&vertex_desc.properties, "packed_color")?,
        };

        let max_sh_degree = parsed
            .sh
            .as_ref()
            .map(|desc| sh_degree(&desc.properties))
            .transpose()?
            .unwrap_or(0);
        let sh_props = if let Some(sh_desc) = parsed.sh.as_ref() {
            if sh_desc.count != vertex_desc.count {
                return Err(anyhow!(
                    "SH element count ({}) must match vertex count ({})",
                    sh_desc.count,
                    vertex_desc.count
                ));
            }
            let num_f_rest = f_rest_offset(max_sh_degree) * 3;
            (max_sh_degree > 0).then(|| {
                let f_rest = (0..num_f_rest)
                    .map(|index| sh_desc.properties[&format!("f_rest_{index}")])
                    .collect();

                let stride = num_f_rest / 3;
                let sh1_props: Vec<usize> = (0..3)
                    .flat_map(|k| (0..3).map(move |d| k + d * stride))
                    .collect();
                let sh2_props: Vec<usize> = (0..5)
                    .flat_map(|k| (0..3).map(move |d| 3 + k + d * stride))
                    .collect();
                let sh3_props: Vec<usize> = (0..7)
                    .flat_map(|k| (0..3).map(move |d| 8 + k + d * stride))
                    .collect();

                SuperSplatShProps {
                    f_rest,
                    sh1_props,
                    sh2_props,
                    sh3_props,
                    num_f_rest,
                }
            })
        } else {
            None
        };

        let elements = parsed
            .elements
            .into_iter()
            .map(|desc| {
                let kind = match desc.name.as_str() {
                    "chunk" => PlyElementKind::Chunk,
                    "vertex" => PlyElementKind::Vertex,
                    "sh" => PlyElementKind::Sh,
                    _ => PlyElementKind::Other,
                };
                PlyElementState {
                    desc,
                    kind,
                    read: 0,
                }
            })
            .collect();

        Ok(Self {
            elements,
            current_element: 0,
            num_splats: vertex_desc.count,
            max_sh_degree,
            chunk_props,
            vertex_props,
            sh_props,
            chunks: Vec::new(),
            output: PlyOutput::default(),
            temp_rest: Vec::new(),
        })
    }

    fn decode_chunks(
        &mut self,
        count: usize,
        offset: usize,
        record_size: usize,
        data: &[u8],
    ) -> anyhow::Result<()> {
        for i in 0..count {
            let base = offset + i * record_size;
            let c = SuperSplatChunk {
                min_x: self.chunk_props.min_x.get_raw_f32(data, base),
                min_y: self.chunk_props.min_y.get_raw_f32(data, base),
                min_z: self.chunk_props.min_z.get_raw_f32(data, base),
                max_x: self.chunk_props.max_x.get_raw_f32(data, base),
                max_y: self.chunk_props.max_y.get_raw_f32(data, base),
                max_z: self.chunk_props.max_z.get_raw_f32(data, base),
                min_scale_x: self.chunk_props.min_scale_x.get_raw_f32(data, base),
                min_scale_y: self.chunk_props.min_scale_y.get_raw_f32(data, base),
                min_scale_z: self.chunk_props.min_scale_z.get_raw_f32(data, base),
                max_scale_x: self.chunk_props.max_scale_x.get_raw_f32(data, base),
                max_scale_y: self.chunk_props.max_scale_y.get_raw_f32(data, base),
                max_scale_z: self.chunk_props.max_scale_z.get_raw_f32(data, base),
                min_r: self
                    .chunk_props
                    .min_r
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(0.0),
                min_g: self
                    .chunk_props
                    .min_g
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(0.0),
                min_b: self
                    .chunk_props
                    .min_b
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(0.0),
                max_r: self
                    .chunk_props
                    .max_r
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(1.0),
                max_g: self
                    .chunk_props
                    .max_g
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(1.0),
                max_b: self
                    .chunk_props
                    .max_b
                    .map(|p| p.get_raw_f32(data, base))
                    .unwrap_or(1.0),
            };
            self.chunks.push(c);
        }
        Ok(())
    }

    fn decode_vertices(
        &mut self,
        count: usize,
        base_index: usize,
        offset: usize,
        record_size: usize,
        data: &[u8],
    ) -> anyhow::Result<()> {
        self.output.ensure(count, self.max_sh_degree);

        for i in 0..count {
            let splat_index = base_index + i;
            let Some(chunk) = self.chunks.get(splat_index / SUPER_CHUNK_SIZE) else {
                return Err(anyhow!("Missing PLY chunk for splat {}", splat_index));
            };
            let base = offset + i * record_size;

            let packed_position = self.vertex_props.packed_position.get_u32(data, base);
            let packed_rotation = self.vertex_props.packed_rotation.get_u32(data, base);
            let packed_scale = self.vertex_props.packed_scale.get_u32(data, base);
            let packed_color = self.vertex_props.packed_color.get_u32(data, base);

            let x = (((packed_position >> 21) & 2047) as f32 / 2047.0)
                * (chunk.max_x - chunk.min_x)
                + chunk.min_x;
            let y = (((packed_position >> 11) & 1023) as f32 / 1023.0)
                * (chunk.max_y - chunk.min_y)
                + chunk.min_y;
            let z = ((packed_position & 2047) as f32 / 2047.0) * (chunk.max_z - chunk.min_z)
                + chunk.min_z;

            let r0 = (((packed_rotation >> 20) & 1023) as f32 / 1023.0 - 0.5) * SQRT_2;
            let r1 = (((packed_rotation >> 10) & 1023) as f32 / 1023.0 - 0.5) * SQRT_2;
            let r2 = ((packed_rotation & 1023) as f32 / 1023.0 - 0.5) * SQRT_2;
            let rr = (1.0 - r0 * r0 - r1 * r1 - r2 * r2).max(0.0).sqrt();
            let r_order = (packed_rotation >> 30) & 3;
            let quat_x = if r_order == 0 {
                r0
            } else if r_order == 1 {
                rr
            } else {
                r1
            };
            let quat_y = if r_order <= 1 {
                r1
            } else if r_order == 2 {
                rr
            } else {
                r2
            };
            let quat_z = if r_order <= 2 { r2 } else { rr };
            let quat_w = if r_order == 0 { rr } else { r0 };

            let scale_x = (((packed_scale >> 21) & 2047) as f32 / 2047.0)
                * (chunk.max_scale_x - chunk.min_scale_x)
                + chunk.min_scale_x;
            let scale_y = (((packed_scale >> 11) & 1023) as f32 / 1023.0)
                * (chunk.max_scale_y - chunk.min_scale_y)
                + chunk.min_scale_y;
            let scale_z = ((packed_scale & 2047) as f32 / 2047.0)
                * (chunk.max_scale_z - chunk.min_scale_z)
                + chunk.min_scale_z;

            let r = (((packed_color >> 24) & 255) as f32 / 255.0) * (chunk.max_r - chunk.min_r)
                + chunk.min_r;
            let g = (((packed_color >> 16) & 255) as f32 / 255.0) * (chunk.max_g - chunk.min_g)
                + chunk.min_g;
            let b = (((packed_color >> 8) & 255) as f32 / 255.0) * (chunk.max_b - chunk.min_b)
                + chunk.min_b;
            let opacity = (packed_color & 255) as f32 / 255.0;

            let i3 = i * 3;
            let i4 = i * 4;
            self.output.center[i3] = x;
            self.output.center[i3 + 1] = y;
            self.output.center[i3 + 2] = z;
            self.output.scale[i3] = scale_x;
            self.output.scale[i3 + 1] = scale_y;
            self.output.scale[i3 + 2] = scale_z;
            self.output.rgb[i3] = r;
            self.output.rgb[i3 + 1] = g;
            self.output.rgb[i3 + 2] = b;
            self.output.opacity[i] = opacity;
            self.output.quat[i4] = quat_x;
            self.output.quat[i4 + 1] = quat_y;
            self.output.quat[i4 + 2] = quat_z;
            self.output.quat[i4 + 3] = quat_w;
        }
        Ok(())
    }

    fn decode_sh(
        &mut self,
        count: usize,
        _base_index: usize,
        offset: usize,
        record_size: usize,
        data: &[u8],
    ) {
        let num_f_rest = match self.sh_props.as_ref() {
            Some(sh_props) => sh_props.num_f_rest,
            None => return,
        };
        if self.temp_rest.len() < num_f_rest {
            self.temp_rest.resize(num_f_rest, 0.0);
        }
        self.output.ensure(count, self.max_sh_degree);
        let Some(sh_props) = self.sh_props.as_ref() else {
            return;
        };

        for i in 0..count {
            let base = offset + i * record_size;
            for (idx, prop) in sh_props.f_rest.iter().enumerate() {
                self.temp_rest[idx] = prop.get_raw_f32(data, base);
            }

            if self.max_sh_degree >= 1 {
                let start = i * 9;
                for (j, idx) in sh_props.sh1_props.iter().enumerate() {
                    self.output.sh1[start + j] = self.temp_rest[*idx] * 8.0 / 255.0 - 4.0;
                }
            }
            if self.max_sh_degree >= 2 {
                let start = i * 15;
                for (j, idx) in sh_props.sh2_props.iter().enumerate() {
                    self.output.sh2[start + j] = self.temp_rest[*idx] * 8.0 / 255.0 - 4.0;
                }
            }
            if self.max_sh_degree >= 3 {
                let start = i * 21;
                for (j, idx) in sh_props.sh3_props.iter().enumerate() {
                    self.output.sh3[start + j] = self.temp_rest[*idx] * 8.0 / 255.0 - 4.0;
                }
            }
        }
    }
}

#[derive(Debug)]
struct PlyElementState {
    desc: PlyElementDesc,
    kind: PlyElementKind,
    read: usize,
}

#[derive(Clone, Copy, Debug)]
enum PlyElementKind {
    Chunk,
    Vertex,
    Sh,
    Other,
}

#[derive(Debug)]
struct PlyDecoderState {
    num_splats: usize,
    record_size: usize,
    next_splat: usize,

    xyz: [PlyProperty; 3],
    scale: [PlyProperty; 3],
    rot: [PlyProperty; 4],
    op_logi: PlyProperty,
    f_dc: [PlyProperty; 3],
    max_sh_degree: usize,
    sh1: Option<[PlyProperty; 9]>,
    sh2: Option<[PlyProperty; 15]>,
    sh3: Option<[PlyProperty; 21]>,

    output: PlyOutput,
}

impl PlyDecoderState {
    fn new(
        num_splats: usize,
        record_size: usize,
        properties: &HashMap<String, PlyProperty>,
    ) -> anyhow::Result<Self> {
        let xyz = required_properties(properties, ["x", "y", "z"])?;
        let scale = required_properties(properties, ["scale_0", "scale_1", "scale_2"])?;
        let rot = required_properties(properties, ["rot_1", "rot_2", "rot_3", "rot_0"])?;
        let op_logi = required_property(properties, "opacity")?;
        let f_dc = required_properties(properties, ["f_dc_0", "f_dc_1", "f_dc_2"])?;

        let max_sh_degree = sh_degree(properties)?;
        let sh1 = sh_properties(properties, max_sh_degree, 1);
        let sh2 = sh_properties(properties, max_sh_degree, 2);
        let sh3 = sh_properties(properties, max_sh_degree, 3);

        Ok(Self {
            num_splats,
            record_size,
            next_splat: 0,
            xyz,
            scale,
            rot,
            op_logi,
            f_dc,
            max_sh_degree,
            sh1,
            sh2,
            sh3,
            output: PlyOutput::default(),
        })
    }
}

#[derive(Debug)]
struct PointCloudDecoderState {
    num_splats: usize,
    record_size: usize,
    next_splat: usize,

    xyz: [PlyProperty; 3],
    rgb: [PlyProperty; 3],
    alpha: Option<PlyProperty>,

    output: PlyOutput,
}

impl PointCloudDecoderState {
    fn new(
        num_splats: usize,
        record_size: usize,
        properties: &HashMap<String, PlyProperty>,
    ) -> anyhow::Result<Self> {
        let xyz = required_properties(properties, ["x", "y", "z"])?;
        let rgb = required_properties(properties, ["red", "green", "blue"])?;
        let alpha = properties.get("alpha").copied();

        Ok(Self {
            num_splats,
            record_size,
            next_splat: 0,
            xyz,
            rgb,
            alpha,
            output: PlyOutput::default(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub enum PlyPropertyType {
    Char,
    Uchar,
    Short,
    Ushort,
    Int,
    Uint,
    Float,
    Double,
}

impl PlyPropertyType {
    pub fn size(&self) -> usize {
        match self {
            PlyPropertyType::Char | PlyPropertyType::Uchar => 1,
            PlyPropertyType::Short | PlyPropertyType::Ushort => 2,
            PlyPropertyType::Int | PlyPropertyType::Uint | PlyPropertyType::Float => 4,
            PlyPropertyType::Double => 8,
        }
    }

    pub fn get_f32(&self, data: &[u8], offset: usize) -> f32 {
        self.read_f32::<true>(data, offset)
    }

    pub fn get_raw_f32(&self, data: &[u8], offset: usize) -> f32 {
        self.read_f32::<false>(data, offset)
    }

    // Specialize at compile time so non-byte fields avoid normalization work
    // and an extra type dispatch in the decode loop.
    fn read_f32<const NORMALIZE_BYTES: bool>(&self, data: &[u8], offset: usize) -> f32 {
        match self {
            PlyPropertyType::Float => {
                let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
                f32::from_le_bytes(bytes)
            }
            PlyPropertyType::Double => {
                let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
                f64::from_le_bytes(bytes) as f32
            }
            PlyPropertyType::Char if NORMALIZE_BYTES => data[offset] as i8 as f32 / 255.0,
            PlyPropertyType::Uchar if NORMALIZE_BYTES => data[offset] as f32 / 255.0,
            PlyPropertyType::Char => data[offset] as i8 as f32,
            PlyPropertyType::Uchar => data[offset] as f32,
            PlyPropertyType::Short => {
                let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
                i16::from_le_bytes(bytes) as f32
            }
            PlyPropertyType::Ushort => {
                let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
                u16::from_le_bytes(bytes) as f32
            }
            PlyPropertyType::Int => {
                let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
                i32::from_le_bytes(bytes) as f32
            }
            PlyPropertyType::Uint => {
                let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
                u32::from_le_bytes(bytes) as f32
            }
        }
    }

    pub fn get_u32(&self, data: &[u8], offset: usize) -> u32 {
        match self {
            PlyPropertyType::Uint | PlyPropertyType::Int | PlyPropertyType::Float => {
                let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
                match self {
                    PlyPropertyType::Uint => u32::from_le_bytes(bytes),
                    PlyPropertyType::Int => i32::from_le_bytes(bytes) as u32,
                    PlyPropertyType::Float => f32::from_le_bytes(bytes).to_bits(),
                    _ => unreachable!(),
                }
            }
            PlyPropertyType::Ushort => {
                let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
                u16::from_le_bytes(bytes) as u32
            }
            PlyPropertyType::Short => {
                let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
                i16::from_le_bytes(bytes) as u32
            }
            PlyPropertyType::Uchar => data[offset] as u32,
            PlyPropertyType::Char => data[offset] as i8 as u32,
            PlyPropertyType::Double => {
                let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
                f64::from_le_bytes(bytes) as u32
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PlyProperty {
    pub ty: PlyPropertyType,
    pub offset: usize,
}

impl PlyProperty {
    pub fn get_f32(&self, data: &[u8], record_offset: usize) -> f32 {
        self.ty.get_f32(data, record_offset + self.offset)
    }

    pub fn get_raw_f32(&self, data: &[u8], record_offset: usize) -> f32 {
        self.ty.get_raw_f32(data, record_offset + self.offset)
    }

    pub fn get_u32(&self, data: &[u8], record_offset: usize) -> u32 {
        self.ty.get_u32(data, record_offset + self.offset)
    }
}

fn required_property(
    properties: &HashMap<String, PlyProperty>,
    name: &str,
) -> anyhow::Result<PlyProperty> {
    properties
        .get(name)
        .copied()
        .ok_or_else(|| anyhow!("Missing {name} property"))
}

fn required_properties<const N: usize>(
    properties: &HashMap<String, PlyProperty>,
    names: [&str; N],
) -> anyhow::Result<[PlyProperty; N]> {
    let mut result = [PlyProperty {
        ty: PlyPropertyType::Float,
        offset: 0,
    }; N];
    for (property, name) in result.iter_mut().zip(names) {
        *property = required_property(properties, name)?;
    }
    Ok(result)
}

fn sh_degree(properties: &HashMap<String, PlyProperty>) -> anyhow::Result<usize> {
    let count = (0..)
        .take_while(|i| properties.contains_key(&format!("f_rest_{i}")))
        .count();
    match count {
        0 => Ok(0),
        9 => Ok(1),
        24 => Ok(2),
        45 => Ok(3),
        _ => Err(anyhow!("Invalid number of f_rest properties: {count}")),
    }
}

fn sh_properties<const N: usize>(
    properties: &HashMap<String, PlyProperty>,
    max_degree: usize,
    degree: usize,
) -> Option<[PlyProperty; N]> {
    (max_degree >= degree)
        .then(|| array::from_fn(|i| properties[&f_rest_name(max_degree, degree, i / 3, i % 3)]))
}

fn f_rest_offset(degree: usize) -> usize {
    match degree {
        0 => 0,
        1 => 3,
        2 => 8,
        3 => 15,
        _ => unreachable!(),
    }
}

fn f_rest_name(max_sh_degree: usize, degree: usize, k: usize, d: usize) -> String {
    let stride = f_rest_offset(max_sh_degree);
    let offset = f_rest_offset(degree - 1);
    format!("f_rest_{}", stride * d + offset + k)
}
