//! Spark RAD version 1 / RADC decoding (Spark v2.1.0 wire format).
//!
//! Property codecs are adapted from Spark's MIT-licensed `rad.rs`.
//! Copyright 2025 WORLD LABS TECHNOLOGIES, INC. See THIRD_PARTY_LICENSES.md.
//! This implementation validates the complete chunk before publishing output or
//! changing its codebook cache. `gz` denotes **raw DEFLATE**, not a gzip wrapper.

use std::{array, borrow::Cow, collections::HashSet};

use anyhow::{bail, ensure, Context, Result};
use half::f16;
use miniz_oxide::inflate::decompress_to_vec_with_limit;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::decoder::{SplatInit, SplatProps, SplatReceiver};

pub const RAD_MAGIC: u32 = 0x30444152;
pub const RAD_CHUNK_MAGIC: u32 = 0x43444152;
pub const MAX_HEADER_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 512 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// These limits bound a single decode's temporary memory even for malicious
// metadata/compression. They are far above Spark's usual 65,536-record pages.
const MAX_PROPERTY_BYTES: usize = 256 * 1024 * 1024;
const MAX_CHUNK_SPLATS: usize = 2 * 1024 * 1024;
const MAX_CODE_COUNT: u32 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RadChunkRange {
    pub offset: u64,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RadMeta {
    pub version: u32,
    #[serde(rename = "type")]
    pub ty: String,
    pub count: u64,
    #[serde(rename = "maxSh", skip_serializing_if = "Option::is_none")]
    pub max_sh: Option<u32>,
    #[serde(rename = "lodTree", skip_serializing_if = "Option::is_none")]
    pub lod_tree: Option<bool>,
    #[serde(rename = "chunkSize", skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u32>,
    #[serde(rename = "allChunkBytes")]
    pub all_chunk_bytes: u64,
    pub chunks: Vec<RadChunkRange>,
    #[serde(rename = "shCodeCount", skip_serializing_if = "Option::is_none")]
    pub sh_code_count: Option<u32>,
    // Preserve advisory encoding, comments, and future optional metadata. Source
    // packing hints do not affect the decoded physical values we return.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl RadMeta {
    pub fn from_json(json: &str) -> Result<Self> {
        ensure!(json.len() <= MAX_HEADER_BYTES, "RAD metadata is too large");
        let meta: Self = serde_json::from_str(json).context("Invalid RAD metadata JSON")?;
        meta.validate()?;
        Ok(meta)
    }

    pub fn chunk_bounds(&self, index: usize) -> Result<(u32, u32)> {
        let chunk = self
            .chunks
            .get(index)
            .context("RAD chunk index out of bounds")?;
        let size = self.chunk_size.map(u64::from).unwrap_or(self.count);
        let inferred_base = (index as u64)
            .checked_mul(size)
            .context("RAD chunk base overflow")?;
        let base = chunk.base.map(u64::from).unwrap_or(inferred_base);
        ensure!(base <= self.count, "RAD chunk base exceeds splat count");
        let count = chunk
            .count
            .map(u64::from)
            .unwrap_or(size.min(self.count - base));
        ensure!(
            base.checked_add(count).is_some_and(|end| end <= self.count),
            "RAD chunk range exceeds splat count"
        );
        Ok((base as u32, count as u32))
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1,
            "Unsupported RAD version: {}",
            self.version
        );
        ensure!(self.ty == "gsplat", "Unsupported RAD type: {}", self.ty);
        ensure!(
            self.count <= u32::MAX as u64,
            "RAD splat count exceeds u32 index limit"
        );
        ensure!(self.max_sh.unwrap_or(0) <= 3, "Unsupported RAD SH degree");
        ensure!(
            self.sh_code_count.unwrap_or(0) <= MAX_CODE_COUNT,
            "RAD SH codebook exceeds decode limit"
        );
        safe_integer(self.all_chunk_bytes, "allChunkBytes")?;
        if self.count == 0 {
            ensure!(
                self.chunks.is_empty() && self.all_chunk_bytes == 0,
                "Empty RAD must have no chunks"
            );
            return Ok(());
        }
        ensure!(
            self.chunk_size.unwrap_or(self.count as u32) > 0,
            "RAD chunkSize must be positive"
        );
        ensure!(!self.chunks.is_empty(), "RAD contains no chunks");
        let mut next_base = 0_u64;
        let mut total_bytes = 0_u64;
        let mut inline_ranges = Vec::new();
        for (index, chunk) in self.chunks.iter().enumerate() {
            safe_integer(chunk.offset, "chunk offset")?;
            safe_integer(chunk.bytes, "chunk bytes")?;
            let end = chunk
                .offset
                .checked_add(chunk.bytes)
                .context("RAD chunk byte range overflow")?;
            safe_integer(end, "chunk byte range end")?;
            ensure!(
                chunk.bytes >= 16,
                "RAD chunk is shorter than its container header"
            );
            ensure!(
                chunk.bytes <= MAX_CHUNK_BYTES as u64,
                "RAD encoded chunk exceeds memory limit"
            );
            ensure!(
                chunk.offset % 8 == 0 && chunk.bytes % 8 == 0,
                "RAD chunk range is not 8-byte aligned"
            );
            let (base, count) = self.chunk_bounds(index)?;
            ensure!(
                u64::from(base) == next_base && count > 0,
                "RAD chunk ranges must cover splats once in order"
            );
            ensure!(
                count as usize <= MAX_CHUNK_SPLATS,
                "RAD chunk exceeds {}-splat decode limit",
                MAX_CHUNK_SPLATS
            );
            next_base += u64::from(count);
            total_bytes = total_bytes
                .checked_add(chunk.bytes)
                .context("RAD total chunk bytes overflow")?;
            if let Some(filename) = &chunk.filename {
                ensure!(!filename.is_empty(), "RAD chunk filename must not be empty");
            } else {
                ensure!(
                    end <= self.all_chunk_bytes,
                    "RAD inline chunk exceeds allChunkBytes"
                );
                inline_ranges.push((chunk.offset, end));
            }
        }
        ensure!(
            next_base == self.count,
            "RAD chunk ranges do not cover the complete dataset"
        );
        ensure!(
            total_bytes <= self.all_chunk_bytes,
            "RAD chunk byte totals exceed allChunkBytes"
        );
        inline_ranges.sort_unstable();
        ensure!(
            inline_ranges.windows(2).all(|pair| pair[0].1 <= pair[1].0),
            "Overlapping RAD inline chunks"
        );
        Ok(())
    }
}

fn safe_integer(value: u64, name: &str) -> Result<()> {
    ensure!(
        value <= MAX_SAFE_INTEGER,
        "RAD {name} exceeds JavaScript safe integer range"
    );
    Ok(())
}

fn align8(value: usize) -> Result<usize> {
    Ok(value.checked_add(7).context("RAD alignment overflow")? & !7)
}

/// Returns `None` only when more bytes are needed. Includes alignment padding in
/// the required header, so callers can start reading at `chunks_start` directly.
pub fn decode_rad_header(bytes: &[u8]) -> Result<Option<(RadMeta, u64)>> {
    if bytes.len() < 4 {
        return Ok(None);
    }
    ensure!(bytes[..4] == RAD_MAGIC.to_le_bytes(), "Invalid RAD magic");
    if bytes.len() < 8 {
        return Ok(None);
    }
    let length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    ensure!(length <= MAX_HEADER_BYTES, "RAD metadata is too large");
    let chunks_start = 8 + align8(length)?;
    if bytes.len() < chunks_start {
        return Ok(None);
    }
    let meta: RadMeta =
        serde_json::from_slice(&bytes[8..8 + length]).context("Invalid RAD metadata JSON")?;
    meta.validate()?;
    ensure!(
        meta.all_chunk_bytes
            .checked_add(chunks_start as u64)
            .is_some_and(|end| end <= MAX_SAFE_INTEGER),
        "RAD complete byte range exceeds JavaScript safe integer range"
    );
    Ok(Some((meta, chunks_start as u64)))
}

#[derive(Clone, Debug, Deserialize)]
struct RadChunkMeta {
    version: u32,
    base: u64,
    count: u64,
    #[serde(rename = "payloadBytes")]
    payload_bytes: u64,
    #[serde(rename = "maxSh")]
    max_sh: Option<u32>,
    #[serde(rename = "lodTree")]
    lod_tree: Option<bool>,
    properties: Vec<Property>,
}

#[derive(Clone, Debug, Deserialize)]
struct Property {
    offset: u64,
    bytes: u64,
    property: PropertyName,
    encoding: Encoding,
    compression: Option<String>,
    min: Option<f32>,
    max: Option<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
enum PropertyName {
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "alpha")]
    Alpha,
    #[serde(rename = "rgb")]
    Rgb,
    #[serde(rename = "scales")]
    Scales,
    #[serde(rename = "orientation")]
    Orientation,
    #[serde(rename = "sh1")]
    Sh1,
    #[serde(rename = "sh2")]
    Sh2,
    #[serde(rename = "sh3")]
    Sh3,
    #[serde(rename = "sh1_code")]
    Sh1Code,
    #[serde(rename = "sh2_code")]
    Sh2Code,
    #[serde(rename = "sh3_code")]
    Sh3Code,
    #[serde(rename = "sh_label")]
    ShLabel,
    #[serde(rename = "child_count")]
    ChildCount,
    #[serde(rename = "child_start")]
    ChildStart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
enum Encoding {
    #[serde(rename = "f32")]
    F32,
    #[serde(rename = "f16")]
    F16,
    #[serde(rename = "f32_lebytes")]
    F32LeBytes,
    #[serde(rename = "f16_lebytes")]
    F16LeBytes,
    #[serde(rename = "r8")]
    R8,
    #[serde(rename = "r8_delta")]
    R8Delta,
    #[serde(rename = "s8")]
    S8,
    #[serde(rename = "s8_delta")]
    S8Delta,
    #[serde(rename = "ln_0r8")]
    Ln0R8,
    #[serde(rename = "ln_f16")]
    LnF16,
    #[serde(rename = "oct88r8")]
    Oct88R8,
    #[serde(rename = "u16")]
    U16,
    #[serde(rename = "u32")]
    U32,
}

impl PropertyName {
    fn sh_degree(self) -> usize {
        match self {
            Self::Sh1 | Self::Sh1Code => 1,
            Self::Sh2 | Self::Sh2Code => 2,
            Self::Sh3 | Self::Sh3Code => 3,
            _ => 0,
        }
    }
    fn is_code(self) -> bool {
        matches!(self, Self::Sh1Code | Self::Sh2Code | Self::Sh3Code)
    }
    fn dimensions(self) -> usize {
        match self {
            Self::Center | Self::Rgb | Self::Scales | Self::Orientation => 3,
            Self::Sh1 | Self::Sh1Code => 9,
            Self::Sh2 | Self::Sh2Code => 15,
            Self::Sh3 | Self::Sh3Code => 21,
            _ => 1,
        }
    }
}

impl Property {
    fn validate(&self, count: usize) -> Result<usize> {
        use Encoding::*;
        use PropertyName::*;
        let valid = match self.property {
            Center => matches!(self.encoding, F32 | F16 | F32LeBytes | F16LeBytes),
            Alpha => matches!(self.encoding, F32 | F16 | R8),
            Rgb => matches!(self.encoding, F32 | F16 | R8 | R8Delta),
            Scales => matches!(self.encoding, F32 | Ln0R8 | LnF16),
            Orientation => matches!(self.encoding, F32 | F16 | Oct88R8),
            Sh1 | Sh2 | Sh3 | Sh1Code | Sh2Code | Sh3Code => {
                matches!(self.encoding, F32 | F16 | R8 | R8Delta | S8 | S8Delta)
            }
            ShLabel => matches!(self.encoding, U16 | U32),
            ChildCount => self.encoding == U16,
            ChildStart => self.encoding == U32,
        };
        ensure!(
            valid,
            "Unsupported RAD {:?} encoding: {:?}",
            self.property,
            self.encoding
        );
        ensure!(
            self.compression
                .as_deref()
                .is_none_or(|value| value == "gz"),
            "Unsupported RAD compression: {:?}",
            self.compression
        );
        if matches!(self.encoding, R8 | R8Delta | Ln0R8) {
            let min = self.min.context("RAD quantized property missing min")?;
            let max = self.max.context("RAD quantized property missing max")?;
            ensure!(
                min.is_finite() && max.is_finite() && min <= max && (max - min).is_finite(),
                "Invalid RAD quantization range"
            );
        }
        if matches!(self.encoding, S8 | S8Delta) {
            ensure!(
                self.max.is_some_and(|max| max.is_finite() && max >= 0.0),
                "RAD signed property requires finite nonnegative max"
            );
        }
        let bytes_per_component = match self.encoding {
            F32 | F32LeBytes | U32 => 4,
            F16 | F16LeBytes | LnF16 | U16 => 2,
            _ => 1,
        };
        let expected = count
            .checked_mul(self.property.dimensions())
            .and_then(|n| n.checked_mul(bytes_per_component))
            .context("RAD decoded property size overflow")?;
        ensure!(
            expected <= MAX_PROPERTY_BYTES,
            "RAD decoded property exceeds memory limit"
        );
        Ok(expected)
    }
}

/// Unpacked, validated physical values. Tree pointers retain file-global indices.
#[derive(Debug)]
struct DecodedChunk {
    pub base: u32,
    pub count: usize,
    pub max_sh: usize,
    pub centers: Vec<f32>,
    pub opacity: Vec<f32>,
    pub rgb: Vec<f32>,
    pub scales: Vec<f32>,
    pub quaternions: Vec<f32>,
    pub sh: [Vec<f32>; 3],
    pub child_start: Option<Vec<u32>>,
    pub child_count: Option<Vec<u16>>,
    /// Conservative projected-size radius, not a subtree spatial bounding box.
    pub lod_radii: Option<Vec<f32>>,
}

/// Page metadata kept alongside the decoded SplatReceiver output.
#[derive(Debug)]
pub struct RadChunk {
    pub base: u32,
    pub child_start: Option<Vec<u32>>,
    pub child_count: Option<Vec<u16>>,
    pub lod_radii: Option<Vec<f32>>,
}

pub struct RadDecoder {
    pub meta: RadMeta,
    max_sh: usize,
    codebooks: [Option<Vec<f32>>; 3],
    chunk_bounds: Vec<(u32, u32)>,
}

impl RadDecoder {
    pub fn new(meta: RadMeta, max_sh: usize) -> Result<Self> {
        meta.validate()?;
        ensure!(max_sh <= 3, "RAD maxSh must be between 0 and 3");
        let chunk_bounds = (0..meta.chunks.len())
            .map(|index| meta.chunk_bounds(index))
            .collect::<Result<_>>()?;
        Ok(Self {
            meta,
            max_sh,
            codebooks: array::from_fn(|_| None),
            chunk_bounds,
        })
    }

    /// Decodes one page into the same receiver contract used by PLY, SPZ and SOG.
    pub fn decode_chunk<T: SplatReceiver>(
        &mut self,
        bytes: &[u8],
        mut splats: T,
    ) -> Result<(T, RadChunk)> {
        let mut chunk = self.decode_chunk_data(bytes)?;
        // Spark stores LOD-encoded alpha in RAD. Restore raw opacity for the
        // shared receiver, after computing LOD radii from the file values.
        for opacity in &mut chunk.opacity {
            if *opacity > 1.0 {
                let shape = opacity.min(2.0).mul_add(4.0, -3.0);
                *opacity = ((shape * shape - 1.0) / std::f32::consts::E).exp();
            }
        }
        splats.init_splats(&SplatInit {
            num_splats: chunk.count,
            max_sh_degree: chunk.max_sh,
        })?;
        splats.set_batch(
            0,
            chunk.count,
            &SplatProps {
                center: &chunk.centers,
                opacity: &chunk.opacity,
                rgb: &chunk.rgb,
                scale: &chunk.scales,
                quat: &chunk.quaternions,
                sh1: &chunk.sh[0],
                sh2: &chunk.sh[1],
                sh3: &chunk.sh[2],
            },
        );
        splats.finish()?;
        Ok((
            splats,
            RadChunk {
                base: chunk.base,
                child_start: chunk.child_start,
                child_count: chunk.child_count,
                lod_radii: chunk.lod_radii,
            },
        ))
    }

    fn decode_chunk_data(&mut self, bytes: &[u8]) -> Result<DecodedChunk> {
        ensure!(
            bytes.len() <= MAX_CHUNK_BYTES,
            "RADC encoded chunk exceeds memory limit"
        );
        ensure!(bytes.len() >= 8, "Incomplete RADC header");
        ensure!(
            bytes[..4] == RAD_CHUNK_MAGIC.to_le_bytes(),
            "Invalid RADC magic"
        );
        let json_length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        ensure!(
            json_length <= MAX_HEADER_BYTES,
            "RADC metadata is too large"
        );
        let payload_start = 16 + align8(json_length)?;
        ensure!(bytes.len() >= payload_start, "Incomplete RADC metadata");
        let chunk: RadChunkMeta = serde_json::from_slice(&bytes[8..8 + json_length])
            .context("Invalid or unsupported RADC metadata")?;
        ensure!(
            chunk.version == 1,
            "Unsupported RADC version: {}",
            chunk.version
        );
        ensure!(
            chunk.count <= MAX_CHUNK_SPLATS as u64,
            "RADC count exceeds decode limit"
        );
        ensure!(
            chunk
                .base
                .checked_add(chunk.count)
                .is_some_and(|end| end <= self.meta.count),
            "RADC splat range exceeds dataset"
        );
        safe_integer(chunk.payload_bytes, "payloadBytes")?;
        let payload_length =
            u64::from_le_bytes(bytes[payload_start - 8..payload_start].try_into().unwrap());
        ensure!(
            chunk.payload_bytes == payload_length,
            "RADC payloadBytes disagrees with container length"
        );
        ensure!(
            payload_length == (bytes.len() - payload_start) as u64,
            "Incomplete RADC payload or unexpected trailing bytes"
        );
        ensure!(
            payload_length % 8 == 0,
            "RADC payload is not 8-byte aligned"
        );
        let chunk_index = self
            .chunk_bounds
            .binary_search_by_key(&chunk.base, |&(base, _)| u64::from(base))
            .ok()
            .context("RADC base does not match a declared chunk")?;
        ensure!(
            u64::from(self.chunk_bounds[chunk_index].1) == chunk.count,
            "RADC count does not match declared chunk"
        );
        let range = &self.meta.chunks[chunk_index];
        ensure!(
            range.bytes == bytes.len() as u64,
            "RADC byte length disagrees with chunk directory"
        );
        let header_sh = self.meta.max_sh.unwrap_or(0) as usize;
        let declared_sh = chunk.max_sh.unwrap_or(header_sh as u32) as usize;
        ensure!(declared_sh <= 3, "Unsupported RADC SH degree");
        ensure!(
            declared_sh <= header_sh,
            "RADC SH degree exceeds RAD header"
        );
        // Keep every page compatible with the dataset's source textures. A
        // chunk may contain fewer bands; the receiver leaves its absent upper
        // bands at zero instead of returning incompatible texture arrays.
        let max_sh = self.max_sh.min(header_sh);
        let decode_sh = self.max_sh.min(declared_sh);
        let lod_tree = chunk.lod_tree.or(self.meta.lod_tree).unwrap_or(false);
        ensure!(
            chunk
                .lod_tree
                .is_none_or(|lod| lod == self.meta.lod_tree.unwrap_or(false)),
            "RADC lodTree disagrees with RAD header"
        );
        let count = chunk.count as usize;
        let payload = &bytes[payload_start..];
        let mut names = HashSet::new();
        let mut ranges = Vec::new();
        // Validate every property, including bands that maxSh will omit, before
        // allocating large output buffers. The length cap also bounds inflation.
        for prop in &chunk.properties {
            ensure!(
                names.insert(prop.property),
                "Duplicate RAD property: {:?}",
                prop.property
            );
            ensure!(prop.offset % 8 == 0, "RAD property offset is not aligned");
            let end = prop
                .offset
                .checked_add(prop.bytes)
                .context("RAD property range overflow")?;
            ensure!(end <= payload_length, "RAD property extends beyond payload");
            let padded_end = prop
                .offset
                .checked_add(align8(
                    usize::try_from(prop.bytes)
                        .context("RAD property bytes exceed address space")?,
                )? as u64)
                .context("RAD property alignment overflow")?;
            ensure!(
                padded_end <= payload_length,
                "RAD property padding extends beyond payload"
            );
            ranges.push((prop.offset, padded_end));
            let records = if prop.property.is_code() {
                ensure!(
                    chunk.base == 0,
                    "RAD SH codebooks must be in the first chunk"
                );
                self.meta
                    .sh_code_count
                    .filter(|n| *n > 0)
                    .context("RAD codebook requires positive shCodeCount")? as usize
            } else {
                count
            };
            prop.validate(records)?;
            ensure!(
                prop.property.sh_degree() <= declared_sh,
                "RAD SH property exceeds declared degree"
            );
        }
        ranges.sort_unstable();
        ensure!(
            ranges.windows(2).all(|pair| pair[0].1 <= pair[1].0),
            "Overlapping RAD properties"
        );
        for required in [
            PropertyName::Center,
            PropertyName::Alpha,
            PropertyName::Rgb,
            PropertyName::Scales,
            PropertyName::Orientation,
        ] {
            ensure!(
                names.contains(&required),
                "Missing required RAD property: {:?}",
                required
            );
        }
        let has_children =
            names.contains(&PropertyName::ChildStart) && names.contains(&PropertyName::ChildCount);
        ensure!(
            names.contains(&PropertyName::ChildStart) == names.contains(&PropertyName::ChildCount),
            "RAD requires both child_start and child_count"
        );
        ensure!(
            has_children == lod_tree,
            "RAD tree properties disagree with lodTree"
        );
        let labels_present = names.contains(&PropertyName::ShLabel);
        if labels_present {
            ensure!(
                self.meta.sh_code_count.is_some_and(|count| count > 0),
                "RAD SH labels require positive shCodeCount"
            );
            ensure!(
                !names
                    .iter()
                    .any(|name| name.sh_degree() > 0 && !name.is_code()),
                "RAD cannot mix SH labels and direct coefficients"
            );
        }
        let mut pending_codes: [Option<Vec<f32>>; 3] = array::from_fn(|_| None);
        let mut result = DecodedChunk {
            base: chunk.base as u32,
            count,
            max_sh,
            centers: Vec::new(),
            opacity: Vec::new(),
            rgb: Vec::new(),
            scales: Vec::new(),
            quaternions: Vec::new(),
            sh: array::from_fn(|_| Vec::new()),
            child_start: None,
            child_count: None,
            lod_radii: None,
        };
        let mut labels: Option<Vec<u32>> = None;
        for prop in &chunk.properties {
            if prop.property.sh_degree() > decode_sh
                || (prop.property == PropertyName::ShLabel && decode_sh == 0)
            {
                continue;
            }
            let records = if prop.property.is_code() {
                self.meta.sh_code_count.unwrap() as usize
            } else {
                count
            };
            let expected = prop.validate(records)?;
            let encoded = &payload[prop.offset as usize..(prop.offset + prop.bytes) as usize];
            let data: Cow<'_, [u8]> = if prop.compression.is_some() {
                Cow::Owned(
                    decompress_to_vec_with_limit(encoded, expected).map_err(|error| {
                        anyhow::anyhow!(
                            "RAD {:?} DEFLATE failed: {:?}",
                            prop.property,
                            error.status
                        )
                    })?,
                )
            } else {
                Cow::Borrowed(encoded)
            };
            ensure!(
                data.len() == expected,
                "RAD {:?} decoded length: expected {}, got {}",
                prop.property,
                expected,
                data.len()
            );
            match prop.property {
                PropertyName::ChildStart => result.child_start = Some(decode_u32(&data, 1, count)),
                PropertyName::ChildCount => result.child_count = Some(decode_u16(&data, 1, count)),
                PropertyName::ShLabel => {
                    labels = Some(if prop.encoding == Encoding::U16 {
                        decode_u16(&data, 1, count)
                            .into_iter()
                            .map(u32::from)
                            .collect()
                    } else {
                        decode_u32(&data, 1, count)
                    })
                }
                name => {
                    let values = decode_float_property(prop, &data, records)?;
                    ensure!(
                        values.iter().all(|value| value.is_finite()),
                        "Non-finite RAD {:?} value",
                        name
                    );
                    match name {
                        PropertyName::Center => result.centers = values,
                        PropertyName::Alpha => {
                            ensure!(
                                values.iter().all(|value| *value >= 0.0),
                                "Negative RAD opacity"
                            );
                            result.opacity = values;
                        }
                        PropertyName::Rgb => result.rgb = values,
                        PropertyName::Scales => {
                            ensure!(
                                values.iter().all(|value| *value >= 0.0),
                                "Negative RAD scale"
                            );
                            result.scales = values;
                        }
                        PropertyName::Orientation => result.quaternions = values,
                        _ if name.is_code() => pending_codes[name.sh_degree() - 1] = Some(values),
                        _ => result.sh[name.sh_degree() - 1] = values,
                    }
                }
            }
        }
        if labels_present && decode_sh > 0 {
            let labels = labels.as_ref().context("Missing decoded RAD SH labels")?;
            let code_count =
                self.meta
                    .sh_code_count
                    .context("RAD SH labels require shCodeCount")? as usize;
            ensure!(
                labels.iter().all(|label| (*label as usize) < code_count),
                "RAD SH label exceeds codebook"
            );
            for band in 0..decode_sh {
                ensure!(
                    result.sh[band].is_empty(),
                    "RAD cannot mix SH labels and direct coefficients"
                );
                let codebook = pending_codes[band]
                    .as_ref()
                    .or(self.codebooks[band].as_ref())
                    .context("RAD SH codebook unavailable; decode chunk 0 first")?;
                let dimensions = [9, 15, 21][band];
                let mut coefficients = Vec::with_capacity(count * dimensions);
                for &label in labels {
                    let start = label as usize * dimensions;
                    coefficients.extend_from_slice(&codebook[start..start + dimensions]);
                }
                result.sh[band] = coefficients;
            }
        }
        for band in 0..decode_sh {
            ensure!(
                result.sh[band].len() == count * [9, 15, 21][band],
                "Missing RAD SH{} coefficients",
                band + 1
            );
        }
        if lod_tree {
            validate_local_tree(
                result.base,
                self.meta.count as u32,
                result.child_start.as_ref().unwrap(),
                result.child_count.as_ref().unwrap(),
            )?;
            let mut radii = Vec::with_capacity(count);
            for (scales, &opacity) in result.scales.chunks_exact(3).zip(&result.opacity) {
                let expansion = if opacity <= 1.0 {
                    1.0
                } else {
                    1.0 + 2.8 * (opacity - 1.0)
                };
                let avg_scale = (scales[0] + scales[1] + scales[2]) / 3.0;
                let radius = expansion * avg_scale;
                ensure!(radius.is_finite(), "RAD LOD radius overflow");
                radii.push(radius);
            }
            result.lod_radii = Some(radii);
        }
        // Commit only after the chunk, labels, and tree have all passed checks.
        for (cached, pending) in self.codebooks.iter_mut().zip(pending_codes) {
            if pending.is_some() {
                *cached = pending;
            }
        }
        Ok(result)
    }
}

fn validate_local_tree(base: u32, total: u32, starts: &[u32], counts: &[u16]) -> Result<()> {
    let end = base as u64 + starts.len() as u64;
    let mut ranges = Vec::new();
    let mut indegree = vec![0_u8; starts.len()];
    for (local, (&start, &count)) in starts.iter().zip(counts).enumerate() {
        if count == 0 {
            continue;
        }
        let child_end = u64::from(start) + u64::from(count);
        ensure!(
            child_end <= u64::from(total),
            "RAD child range exceeds dataset"
        );
        let index = base as u64 + local as u64;
        ensure!(
            !(u64::from(start) <= index && index < child_end),
            "RAD tree contains a self-reference"
        );
        ranges.push((u64::from(start), child_end));
        for child in u64::from(start).max(u64::from(base))..child_end.min(end) {
            let degree = &mut indegree[(child - u64::from(base)) as usize];
            ensure!(*degree == 0, "RAD tree child has multiple parents");
            *degree = 1;
        }
    }
    ranges.sort_unstable();
    ensure!(
        ranges.windows(2).all(|pair| pair[0].1 <= pair[1].0),
        "Overlapping RAD child ranges"
    );
    let mut queue: Vec<usize> = indegree
        .iter()
        .enumerate()
        .filter_map(|(index, &degree)| (degree == 0).then_some(index))
        .collect();
    let mut cursor = 0;
    while cursor < queue.len() {
        let local = queue[cursor];
        cursor += 1;
        let child_end = u64::from(starts[local]) + u64::from(counts[local]);
        for child in u64::from(starts[local]).max(u64::from(base))..child_end.min(end) {
            let index = (child - u64::from(base)) as usize;
            indegree[index] -= 1;
            if indegree[index] == 0 {
                queue.push(index);
            }
        }
    }
    ensure!(
        queue.len() == starts.len(),
        "RAD tree contains a cycle within a chunk"
    );
    Ok(())
}

fn decode_float_property(prop: &Property, data: &[u8], count: usize) -> Result<Vec<f32>> {
    use Encoding::*;
    let dims = prop.property.dimensions();
    let decoded = match prop.encoding {
        F32 => decode_f32(data, dims, count),
        F16 => decode_f16(data, dims, count),
        F32LeBytes => decode_f32_lebytes(data, dims, count),
        F16LeBytes => decode_f16_lebytes(data, dims, count),
        R8 => decode_r8(data, dims, count, prop.min.unwrap(), prop.max.unwrap()),
        R8Delta => decode_r8_delta(data, dims, count, prop.min.unwrap(), prop.max.unwrap()),
        S8 => decode_s8(data, dims, count, prop.max.unwrap()),
        S8Delta => decode_s8_delta(data, dims, count, prop.max.unwrap()),
        Ln0R8 => decode_ln_0r8(data, dims, count, prop.min.unwrap(), prop.max.unwrap()),
        LnF16 => decode_f16(data, dims, count)
            .into_iter()
            .map(f32::exp)
            .collect(),
        Oct88R8 => return Ok(decode_quat_oct88r8(data, count)),
        U16 | U32 => bail!("Integer encoding for floating RAD property"),
    };
    if prop.property == PropertyName::Orientation {
        ensure!(
            decoded.iter().all(|value| value.is_finite()),
            "Non-finite RAD orientation"
        );
        let mut quaternions = Vec::with_capacity(4 * count);
        for xyz in decoded.chunks_exact(3) {
            let length_squared = xyz.iter().map(|value| value * value).sum::<f32>();
            ensure!(length_squared.is_finite(), "RAD orientation overflow");
            let w = (1.0 - length_squared).max(0.0).sqrt();
            quaternions.extend([xyz[0], xyz[1], xyz[2], w]);
        }
        Ok(quaternions)
    } else {
        Ok(decoded)
    }
}

fn decode_f32(data: &[u8], dims: usize, count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i * 4;
        for _ in 0..dims {
            result.push(f32::from_le_bytes(
                data[index..index + 4].try_into().unwrap(),
            ));
            index += count * 4;
        }
    }
    result
}

fn decode_f16(data: &[u8], dims: usize, count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i * 2;
        for _ in 0..dims {
            result.push(f16::from_le_bytes(data[index..index + 2].try_into().unwrap()).to_f32());
            index += count * 2;
        }
    }
    result
}

fn decode_f32_lebytes(data: &[u8], dims: usize, count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    let stride = count * dims;
    for i in 0..count {
        for d in 0..dims {
            let index = count * d + i;
            result.push(f32::from_le_bytes(array::from_fn(|b| {
                data[index + stride * b]
            })));
        }
    }
    result
}

fn decode_f16_lebytes(data: &[u8], dims: usize, count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    let stride = count * dims;
    for i in 0..count {
        for d in 0..dims {
            let index = count * d + i;
            result.push(f16::from_le_bytes(array::from_fn(|b| data[index + stride * b])).to_f32());
        }
    }
    result
}

fn decode_r8(data: &[u8], dims: usize, count: usize, min: f32, max: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i;
        for _ in 0..dims {
            result.push((data[index] as f32 / 255.0) * (max - min) + min);
            index += count;
        }
    }
    result
}

fn decode_s8(data: &[u8], dims: usize, count: usize, max: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i;
        for _ in 0..dims {
            result.push(((data[index] as i8) as f32 / 127.0) * max);
            index += count;
        }
    }
    result
}

fn decode_r8_delta(data: &[u8], dims: usize, count: usize, min: f32, max: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    let mut last = vec![0u8; dims];
    for i in 0..count {
        let mut index = i;
        for d in 0..dims {
            let value = last[d].wrapping_add(data[index]);
            last[d] = value;
            result.push((value as f32 / 255.0) * (max - min) + min);
            index += count;
        }
    }
    result
}

fn decode_s8_delta(data: &[u8], dims: usize, count: usize, max: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    let mut last = vec![0u8; dims];
    for i in 0..count {
        let mut index = i;
        for d in 0..dims {
            let value = last[d].wrapping_add(data[index]);
            last[d] = value;
            result.push(((value as i8) as f32 / 127.0) * max);
            index += count;
        }
    }
    result
}

fn decode_ln_0r8(data: &[u8], dims: usize, count: usize, min: f32, max: f32) -> Vec<f32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i;
        for _ in 0..dims {
            result.push(decode_scale8(data[index], min, max));
            index += count;
        }
    }
    result
}

fn decode_quat_oct88r8(data: &[u8], count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(4 * count);
    for i in 0..count {
        let index = i * 3;
        result.extend(decode_quat_oct888([
            data[index],
            data[index + 1],
            data[index + 2],
        ]));
    }
    result
}

fn decode_u16(data: &[u8], dims: usize, count: usize) -> Vec<u16> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i * 2;
        for _ in 0..dims {
            result.push(u16::from_le_bytes([data[index], data[index + 1]]));
            index += count * 2;
        }
    }
    result
}

fn decode_u32(data: &[u8], dims: usize, count: usize) -> Vec<u32> {
    let mut result = Vec::with_capacity(dims * count);
    for i in 0..count {
        let mut index = i * 4;
        for _ in 0..dims {
            result.push(u32::from_le_bytes([
                data[index],
                data[index + 1],
                data[index + 2],
                data[index + 3],
            ]));
            index += count * 4;
        }
    }
    result
}

fn decode_quat_oct888([u, v, r]: [u8; 3]) -> [f32; 4] {
    let [x, y] = [u, v].map(|x| x as f32 / 255.0 * 2.0 - 1.0);
    let z = 1.0 - x.abs() - y.abs();
    let t = (-z).max(0.0);
    let [x, y] = [x, y].map(|x| if x >= 0.0 { x - t } else { x + t });
    let length = (x * x + y * y + z * z).sqrt();
    let axis = [x / length, y / length, z / length];

    let half_theta = r as f32 / 255.0 * 0.5 * std::f32::consts::PI;
    let (s, w) = half_theta.sin_cos();
    [axis[0] * s, axis[1] * s, axis[2] * s, w]
}

fn decode_scale8(scale: u8, ln_scale_min: f32, ln_scale_max: f32) -> f32 {
    if scale == 0 {
        0.0
    } else {
        let ln_scale_scale = (ln_scale_max - ln_scale_min) / 254.0;
        (ln_scale_min + (scale - 1) as f32 * ln_scale_scale).exp()
    }
}
