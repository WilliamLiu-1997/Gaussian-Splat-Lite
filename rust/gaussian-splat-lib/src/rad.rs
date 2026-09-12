//! Spark RAD version 1 / RADC decoding (Spark v2.1.0 wire format).
//!
//! Property codecs are adapted from Spark's MIT-licensed `rad.rs`.
//! Copyright 2025 WORLD LABS TECHNOLOGIES, INC. See THIRD_PARTY_LICENSES.md.
//! Full decoding validates the complete chunk before publishing output or
//! changing its codebook cache. Codebook initialization validates the container
//! and codebooks only, for a root already decoded by another worker.
//! `gz` denotes **raw DEFLATE**, not a gzip wrapper.

use std::{array, borrow::Cow, collections::HashSet, sync::LazyLock};

use anyhow::{bail, ensure, Context, Result};
use half::f16;
use miniz_oxide::inflate::decompress_to_vec_with_limit;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    decoder::{QuantizedProperty, ScalarLookup, SplatInit, SplatProps, SplatReceiver},
    splat_encode::{
        encode_splat_sh_rgb, f16_table, ShLookup, F16_LOOKUP, F16_SH_LOOKUP, LOD_OPACITY_LOOKUP,
    },
};

pub const RAD_MAGIC: u32 = 0x30444152;
pub const RAD_CHUNK_MAGIC: u32 = 0x43444152;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static LN_F16_LINEAR: LazyLock<Box<[f32; 65536]>> =
    LazyLock::new(|| f16_table(|bits| f16::from_bits(bits).to_f32().exp()));
static OCT_ANGLES: LazyLock<[[f32; 2]; 256]> = LazyLock::new(|| {
    array::from_fn(|r| {
        let half_theta = r as f32 / 255.0 * 0.5 * std::f32::consts::PI;
        let (s, w) = half_theta.sin_cos();
        [s, w]
    })
});

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
                chunk.offset % 8 == 0 && chunk.bytes % 8 == 0,
                "RAD chunk range is not 8-byte aligned"
            );
            let (base, count) = self.chunk_bounds(index)?;
            ensure!(
                u64::from(base) == next_base && count > 0,
                "RAD chunk ranges must cover splats once in order"
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
    let chunks_start = align8(length)?
        .checked_add(8)
        .context("RAD header size overflow")?;
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
        count
            .checked_mul(self.property.dimensions())
            .and_then(|n| n.checked_mul(bytes_per_component))
            .context("RAD decoded property size overflow")
    }
}

/// Validated values and quantized properties. Tree pointers retain file-global indices.
#[derive(Default)]
struct DecodedChunk {
    pub base: u32,
    pub count: usize,
    pub max_sh: usize,
    pub centers: Vec<f32>,
    pub opacity: Vec<f32>,
    pub opacity_packed: Vec<u32>,
    pub rgb: Vec<f32>,
    pub rgb_f16: Vec<u16>,
    pub quantized: Vec<(QuantizedProperty, ScalarLookup, Vec<u8>)>,
    pub scales: Vec<f32>,
    pub scales_f16: Vec<u16>,
    pub quaternions: Vec<f32>,
    pub packed_sh: [Vec<u32>; 3],
    pub sh_labels: Option<(usize, Vec<u32>)>,
    pub child_start: Option<Vec<u32>>,
    pub child_count: Option<Vec<u16>>,
    /// Conservative projected-size radius, not a subtree spatial bounding box.
    pub lod_radii: Option<Vec<f32>>,
}

impl DecodedChunk {
    fn decode_quantized(&mut self, prop: &Property, mut data: Cow<'_, [u8]>) -> Result<()> {
        let count = self.count;
        if matches!(prop.encoding, Encoding::R8Delta | Encoding::S8Delta) {
            for plane in data.to_mut().chunks_exact_mut(count) {
                let mut last = 0u8;
                for code in plane {
                    last = last.wrapping_add(*code);
                    *code = last;
                }
            }
        }
        let values = array::from_fn(|b| {
            if matches!(prop.encoding, Encoding::S8 | Encoding::S8Delta) {
                (b as u8 as i8 as f32 / 127.0) * prop.max.unwrap()
            } else {
                (b as f32 / 255.0) * (prop.max.unwrap() - prop.min.unwrap()) + prop.min.unwrap()
            }
        });
        ensure!(
            data.iter().all(|&b| values[b as usize].is_finite()),
            "Non-finite RAD {:?} value",
            prop.property
        );
        match prop.property {
            PropertyName::Alpha => {
                ensure!(
                    data.iter().all(|&b| values[b as usize] >= 0.0),
                    "Negative RAD opacity"
                );
                // Keep file alpha for LOD radii; the lookup supplies raw opacity.
                if self.lod_radii.is_some() {
                    self.opacity = data.iter().map(|&b| values[b as usize]).collect();
                }
                let property = QuantizedProperty::Opacity;
                self.quantized.push((
                    property,
                    property.lookup(values.map(decode_opacity)),
                    data.into_owned(),
                ));
            }
            PropertyName::Rgb => {
                let property = QuantizedProperty::Rgb;
                self.quantized
                    .push((property, property.lookup(values), data.into_owned()));
            }
            _ => {
                let lookup = ShLookup::new(values);
                let coefficients = prop.property.dimensions() / 3;
                let words = &mut self.packed_sh[prop.property.sh_degree() - 1];
                words.reserve(count * coefficients);
                for i in 0..count {
                    for k in 0..coefficients {
                        words
                            .push(lookup.encode(array::from_fn(|d| data[(k * 3 + d) * count + i])));
                    }
                }
            }
        }
        Ok(())
    }

    /// Validates f16 component planes and packs point-major RGB coefficients.
    fn decode_f16_sh(&mut self, property: PropertyName, data: &[u8]) -> Result<()> {
        let values = &*F16_LOOKUP;
        ensure!(
            data.chunks_exact(2)
                .all(|b| values[u16::from_le_bytes([b[0], b[1]]) as usize].is_finite()),
            "Non-finite RAD {:?} value",
            property
        );
        let lookup = &*F16_SH_LOOKUP;
        let coefficients = property.dimensions() / 3;
        let words = &mut self.packed_sh[property.sh_degree() - 1];
        words.reserve(self.count * coefficients);
        for i in 0..self.count {
            for k in 0..coefficients {
                words.push(lookup.encode_indices(array::from_fn(|d| {
                    let offset = ((k * 3 + d) * self.count + i) * 2;
                    u16::from_le_bytes([data[offset], data[offset + 1]]) as usize
                })));
            }
        }
        Ok(())
    }

    /// Packs f32 component planes without an intermediate float batch.
    fn decode_f32_sh(&mut self, property: PropertyName, data: &[u8]) -> Result<()> {
        ensure!(
            data.chunks_exact(4)
                .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite()),
            "Non-finite RAD {:?} value",
            property
        );
        let count = self.count;
        let coefficients = property.dimensions() / 3;
        let words = &mut self.packed_sh[property.sh_degree() - 1];
        words.reserve(count * coefficients);
        for i in 0..count {
            for k in 0..coefficients {
                words.push(encode_splat_sh_rgb(array::from_fn(|d| {
                    let offset = ((k * 3 + d) * count + i) * 4;
                    f32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
                })));
            }
        }
        Ok(())
    }

    fn decode_scales(&mut self, prop: &Property, data: Cow<'_, [u8]>) -> Result<()> {
        match prop.encoding {
            Encoding::Ln0R8 => {
                let min = prop.min.unwrap();
                let step = (prop.max.unwrap() - min) / 254.0;
                let mut values: [f32; 256] = array::from_fn(|code| {
                    if code == 0 {
                        f32::NEG_INFINITY
                    } else {
                        min + (code - 1) as f32 * step
                    }
                });
                let linear = values.map(f32::exp);
                self.decode_scale_values(false, |index| linear[data[index] as usize])?;
                // Underflow retains the zero-scale disabling semantics.
                for (value, scale) in values.iter_mut().zip(linear) {
                    if scale == 0.0 {
                        *value = f32::NEG_INFINITY;
                    }
                }
                let property = QuantizedProperty::LnScale;
                self.quantized
                    .push((property, property.lookup(values), data.into_owned()));
                Ok(())
            }
            Encoding::LnF16 => {
                let lookup = &*LN_F16_LINEAR;
                self.scales_f16.reserve(self.count * 3);
                for i in 0..self.count {
                    let bits: [u16; 3] = array::from_fn(|d| {
                        let offset = (d * self.count + i) * 2;
                        u16::from_le_bytes([data[offset], data[offset + 1]])
                    });
                    let linear = bits.map(|bits| lookup[bits as usize]);
                    ensure!(
                        linear.iter().all(|v| v.is_finite()),
                        "Non-finite RAD Scales value"
                    );
                    ensure!(linear.iter().all(|v| *v >= 0.0), "Negative RAD scale");
                    self.scales_f16.extend((0..3).map(|d| {
                        if linear[d] == 0.0 {
                            f16::NEG_INFINITY.to_bits()
                        } else {
                            bits[d]
                        }
                    }));
                    if let Some(radii) = &mut self.lod_radii {
                        radii.push((linear[0] + linear[1] + linear[2]) / 3.0);
                    }
                }
                Ok(())
            }
            Encoding::F32 => self.decode_scale_values(true, |index| {
                f32::from_le_bytes(data[index * 4..index * 4 + 4].try_into().unwrap())
            }),
            _ => unreachable!("validated RAD scale encoding"),
        }
    }

    /// Reads linear scales from component planes; quantized output skips float storage.
    fn decode_scale_values(
        &mut self,
        store_values: bool,
        read: impl Fn(usize) -> f32,
    ) -> Result<()> {
        if store_values {
            self.scales.reserve(self.count * 3);
        }
        for i in 0..self.count {
            let linear: [f32; 3] = array::from_fn(|d| read(d * self.count + i));
            ensure!(
                linear.iter().all(|v| v.is_finite()),
                "Non-finite RAD Scales value"
            );
            ensure!(linear.iter().all(|v| *v >= 0.0), "Negative RAD scale");
            if store_values {
                self.scales.extend(linear);
            }
            if let Some(radii) = &mut self.lod_radii {
                radii.push((linear[0] + linear[1] + linear[2]) / 3.0);
            }
        }
        Ok(())
    }
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
    codebooks_f16: [bool; 3],
    // Separate degrees keep omitted bands zero when chunks use different maxSh.
    palettes: [Option<Vec<u32>>; 3],
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
            codebooks_f16: [false; 3],
            palettes: array::from_fn(|_| None),
            chunk_bounds,
        })
    }

    /// Decodes one page into the same receiver contract used by PLY, SPZ and SOG.
    pub fn decode_chunk<T: SplatReceiver>(
        &mut self,
        bytes: &[u8],
        mut splats: T,
    ) -> Result<(T, RadChunk)> {
        let chunk = self.decode_chunk_data(bytes, false)?;
        splats.init_splats(&SplatInit {
            num_splats: chunk.count,
            max_sh_degree: chunk.max_sh,
        })?;
        let batch = SplatProps {
            center: &chunk.centers,
            opacity: &chunk.opacity,
            opacity_packed: &chunk.opacity_packed,
            rgb: &chunk.rgb,
            scale: &chunk.scales,
            quat: &chunk.quaternions,
            ..Default::default()
        };
        splats.set_batch(0, chunk.count, &batch);
        if !chunk.rgb_f16.is_empty() {
            splats.set_rgb_f16(0, chunk.count, &chunk.rgb_f16);
        }
        if !chunk.scales_f16.is_empty() {
            splats.set_ln_scale_f16(0, chunk.count, &chunk.scales_f16);
        }
        for (property, lookup, codes) in &chunk.quantized {
            splats.set_quantized(
                0,
                chunk.count,
                *property,
                std::slice::from_ref(lookup),
                |i, d| codes[d * chunk.count + i],
            );
        }
        if let Some((degree, labels)) = chunk.sh_labels {
            splats.set_sh_palette(0, chunk.count, degree, self.sh_palette(degree), &labels);
        }
        for (band, words) in chunk.packed_sh.iter().enumerate() {
            if !words.is_empty() {
                let coefficients = [3, 5, 7][band];
                splats.set_sh_packed(0, chunk.count, band + 1, |i, k| words[i * coefficients + k]);
            }
        }
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

    /// Seed codebooks from an already validated root; checks metadata and codebook
    /// payloads without decoding geometry, labels, or tree payloads again.
    pub fn initialize_codebooks(&mut self, bytes: &[u8]) -> Result<()> {
        self.decode_chunk_data(bytes, true).map(|_| ())
    }

    /// Quantize validated codebooks once for each requested degree.
    fn sh_palette(&mut self, degree: usize) -> &[u32] {
        self.palettes[degree - 1].get_or_insert_with(|| {
            let stride = [0, 4, 8, 16][degree];
            let mut palette = vec![0; self.meta.sh_code_count.unwrap() as usize * stride];
            let mut offset = 0;
            for (band, coefficients) in [3, 5, 7].into_iter().enumerate().take(degree) {
                let codebook = self.codebooks[band].as_ref().unwrap();
                let half_lookup = self.codebooks_f16[band].then(|| &*F16_SH_LOOKUP);
                for (label, entry) in codebook.chunks_exact(coefficients * 3).enumerate() {
                    for (i, rgb) in entry.chunks_exact(3).enumerate() {
                        palette[label * stride + offset + i] = if let Some(lookup) = half_lookup {
                            lookup.encode_indices(array::from_fn(|d| {
                                f16::from_f32(rgb[d]).to_bits() as usize
                            }))
                        } else {
                            encode_splat_sh_rgb(rgb.try_into().unwrap())
                        };
                    }
                }
                offset += coefficients;
            }
            palette
        })
    }

    fn decode_chunk_data(&mut self, bytes: &[u8], codebooks_only: bool) -> Result<DecodedChunk> {
        ensure!(bytes.len() >= 8, "Incomplete RADC header");
        ensure!(
            bytes[..4] == RAD_CHUNK_MAGIC.to_le_bytes(),
            "Invalid RADC magic"
        );
        let json_length = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let payload_start = align8(json_length)?
            .checked_add(16)
            .context("RADC header size overflow")?;
        ensure!(bytes.len() >= payload_start, "Incomplete RADC metadata");
        let chunk: RadChunkMeta = serde_json::from_slice(&bytes[8..8 + json_length])
            .context("Invalid or unsupported RADC metadata")?;
        if codebooks_only {
            ensure!(
                chunk.base == 0,
                "RAD codebook initialization requires chunk 0"
            );
        }
        ensure!(
            chunk.version == 1,
            "Unsupported RADC version: {}",
            chunk.version
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
        // allocating large output buffers. Expected lengths also bound inflation.
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
        let mut pending_f16 = [false; 3];
        let mut result = DecodedChunk {
            base: chunk.base as u32,
            count,
            max_sh,
            lod_radii: (lod_tree && !codebooks_only).then(|| Vec::with_capacity(count)),
            ..DecodedChunk::default()
        };
        let mut labels: Option<Vec<u32>> = None;
        for prop in &chunk.properties {
            if (codebooks_only && !prop.property.is_code())
                || prop.property.sh_degree() > decode_sh
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
                PropertyName::Rgb if prop.encoding == Encoding::F16 => {
                    ensure!(
                        data.chunks_exact(2)
                            .all(|b| u16::from_le_bytes([b[0], b[1]]) & 0x7c00 != 0x7c00),
                        "Non-finite RAD Rgb value"
                    );
                    result.rgb_f16 = decode_u16(&data, 3, count);
                }
                name if name.sh_degree() > 0
                    && !name.is_code()
                    && prop.encoding == Encoding::F16 =>
                {
                    result.decode_f16_sh(name, &data)?;
                }
                name if name.sh_degree() > 0
                    && !name.is_code()
                    && prop.encoding == Encoding::F32 =>
                {
                    result.decode_f32_sh(name, &data)?;
                }
                name if matches!(
                    name,
                    PropertyName::Alpha
                        | PropertyName::Rgb
                        | PropertyName::Sh1
                        | PropertyName::Sh2
                        | PropertyName::Sh3
                ) && matches!(
                    prop.encoding,
                    Encoding::R8 | Encoding::R8Delta | Encoding::S8 | Encoding::S8Delta
                ) =>
                {
                    result.decode_quantized(prop, data)?
                }
                PropertyName::Scales => result.decode_scales(prop, data)?,
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
                            if prop.encoding == Encoding::F16 {
                                let lookup = &*LOD_OPACITY_LOOKUP;
                                result.opacity_packed = data
                                    .chunks_exact(2)
                                    .map(|b| lookup[u16::from_le_bytes([b[0], b[1]]) as usize])
                                    .collect();
                            }
                        }
                        PropertyName::Rgb => result.rgb = values,
                        PropertyName::Orientation => result.quaternions = values,
                        _ if name.is_code() => {
                            pending_f16[name.sh_degree() - 1] = prop.encoding == Encoding::F16;
                            pending_codes[name.sh_degree() - 1] = Some(values);
                        }
                        _ => unreachable!("property handled by a specialized decoder"),
                    }
                }
            }
        }
        if labels_present {
            for band in 0..decode_sh {
                pending_codes[band]
                    .as_ref()
                    .or(self.codebooks[band].as_ref())
                    .context("RAD SH codebook unavailable; decode chunk 0 first")?;
            }
        }
        if codebooks_only {
            self.cache_codebooks(pending_codes, pending_f16);
            return Ok(result);
        }
        if labels_present && decode_sh > 0 {
            let labels = labels.context("Missing decoded RAD SH labels")?;
            let code_count = self.meta.sh_code_count.unwrap() as usize;
            ensure!(
                labels.iter().all(|label| (*label as usize) < code_count),
                "RAD SH label exceeds codebook"
            );
            result.sh_labels = Some((decode_sh, labels));
        } else {
            for band in 0..decode_sh {
                ensure!(
                    result.packed_sh[band].len() == count * [3, 5, 7][band],
                    "Missing RAD SH{} coefficients",
                    band + 1
                );
            }
        }
        if lod_tree {
            validate_local_tree(
                result.base,
                self.meta.count as u32,
                result.child_start.as_ref().unwrap(),
                result.child_count.as_ref().unwrap(),
            )?;
            // Scale decoding supplied the means; alpha can appear later in the file.
            for (radius, &opacity) in result
                .lod_radii
                .as_mut()
                .unwrap()
                .iter_mut()
                .zip(&result.opacity)
            {
                let expansion = if opacity <= 1.0 {
                    1.0
                } else {
                    1.0 + 2.8 * (opacity - 1.0)
                };
                *radius *= expansion;
                ensure!(radius.is_finite(), "RAD LOD radius overflow");
            }
        }
        // LOD radii use file alpha; receivers get raw or prepacked opacity.
        if !result.opacity_packed.is_empty()
            || result
                .quantized
                .iter()
                .any(|(property, _, _)| matches!(property, QuantizedProperty::Opacity))
        {
            result.opacity.clear();
        } else {
            for opacity in &mut result.opacity {
                *opacity = decode_opacity(*opacity);
            }
        }
        // Commit only after the chunk, labels, and tree have all passed checks.
        self.cache_codebooks(pending_codes, pending_f16);
        Ok(result)
    }

    fn cache_codebooks(&mut self, pending_codes: [Option<Vec<f32>>; 3], pending_f16: [bool; 3]) {
        if pending_codes.iter().any(Option::is_some) {
            self.palettes.fill(None);
        }
        for (band, (cached, pending)) in self.codebooks.iter_mut().zip(pending_codes).enumerate() {
            if pending.is_some() {
                *cached = pending;
                self.codebooks_f16[band] = pending_f16[band];
            }
        }
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

fn decode_opacity(opacity: f32) -> f32 {
    if opacity > 1.0 {
        let shape = opacity.min(2.0).mul_add(4.0, -3.0);
        ((shape * shape - 1.0) / std::f32::consts::E).exp()
    } else {
        opacity
    }
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
        Oct88R8 => return Ok(decode_quat_oct88r8(data, count)),
        Ln0R8 | LnF16 | U16 | U32 => bail!("Unexpected encoding for floating RAD property"),
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

fn decode_quat_oct88r8(data: &[u8], count: usize) -> Vec<f32> {
    let mut result = Vec::with_capacity(4 * count);
    let angles = &*OCT_ANGLES;
    for i in 0..count {
        let index = i * 3;
        let axis = decode_oct_axis([data[index], data[index + 1]]);
        let [s, w] = angles[data[index + 2] as usize];
        result.extend([axis[0] * s, axis[1] * s, axis[2] * s, w]);
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

fn decode_oct_axis([u, v]: [u8; 2]) -> [f32; 3] {
    let [x, y] = [u, v].map(|x| x as f32 / 255.0 * 2.0 - 1.0);
    let z = 1.0 - x.abs() - y.abs();
    let t = (-z).max(0.0);
    let [x, y] = [x, y].map(|x| if x >= 0.0 { x - t } else { x + t });
    let length = (x * x + y * y + z * z).sqrt();
    [x / length, y / length, z / length]
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniz_oxide::deflate::compress_to_vec;
    use serde_json::json;

    fn chunk(base: u32, half: bool, bad_geometry: bool, last_code: f32) -> Vec<u8> {
        let mut payload = Vec::new();
        let mut properties = Vec::new();
        let mut add = |name: &str, encoding: &str, bytes: Vec<u8>| {
            let compressed = compress_to_vec(&bytes, 6);
            properties.push(json!({"property": name, "encoding": encoding,
                "offset": payload.len(), "bytes": compressed.len(), "compression": "gz"}));
            payload.extend(compressed);
            payload.resize((payload.len() + 7) & !7, 0);
        };
        for (name, dimensions, value) in [
            ("center", 3, if bad_geometry { f32::NAN } else { 1.0 }),
            ("alpha", 1, 1.0),
            ("rgb", 3, 0.5),
            ("scales", 3, 1.0),
            ("orientation", 3, 0.0),
        ] {
            add(name, "f32", value.to_le_bytes().repeat(dimensions * 2));
        }
        add("sh_label", "u16", vec![0, 0, 1, 0]);
        if base == 0 {
            for (name, dimensions) in [("sh1_code", 9), ("sh2_code", 15), ("sh3_code", 21)] {
                let values = (0..dimensions * 2).map(|i| {
                    if name == "sh3_code" && i == dimensions * 2 - 1 {
                        last_code
                    } else {
                        (i as f32 - 10.0) / 32.0
                    }
                });
                let bytes = if half {
                    values
                        .flat_map(|v| f16::from_f32(v).to_bits().to_le_bytes())
                        .collect()
                } else {
                    values.flat_map(f32::to_le_bytes).collect()
                };
                add(name, if half { "f16" } else { "f32" }, bytes);
            }
        }
        let metadata = serde_json::to_vec(&json!({"version": 1, "base": base,
            "count": 2, "maxSh": 3, "payloadBytes": payload.len(), "properties": properties}))
        .unwrap();
        let mut bytes = RAD_CHUNK_MAGIC.to_le_bytes().to_vec();
        bytes.extend((metadata.len() as u32).to_le_bytes());
        bytes.extend(&metadata);
        bytes.resize(8 + ((metadata.len() + 7) & !7), 0);
        bytes.extend((payload.len() as u64).to_le_bytes());
        bytes.extend(payload);
        bytes
    }

    fn fixture(half: bool, bad_geometry: bool, degree: usize) -> (RadDecoder, Vec<u8>, Vec<u8>) {
        let root = chunk(0, half, bad_geometry, 0.25);
        let next = chunk(2, half, false, 0.25);
        let meta = RadMeta::from_json(
            &json!({"version": 1, "type": "gsplat",
            "count": 4, "maxSh": 3, "shCodeCount": 2, "chunkSize": 2,
            "allChunkBytes": root.len() + next.len(), "chunks": [
                {"offset": 0, "bytes": root.len()},
                {"offset": root.len(), "bytes": next.len()}
            ]})
            .to_string(),
        )
        .unwrap();
        (RadDecoder::new(meta, degree).unwrap(), root, next)
    }

    #[test]
    fn codebook_initialization_matches_full_root_for_later_chunks() {
        for half in [false, true] {
            for degree in 0..=3 {
                let (mut seeded, root, next) = fixture(half, false, degree);
                let mut full = RadDecoder::new(seeded.meta.clone(), degree).unwrap();
                full.decode_chunk_data(&root, false).unwrap();
                seeded.initialize_codebooks(&root).unwrap();
                assert_eq!(full.codebooks, seeded.codebooks);
                assert_eq!(full.codebooks_f16, seeded.codebooks_f16);
                let expected = full.decode_chunk_data(&next, false).unwrap();
                let actual = seeded.decode_chunk_data(&next, false).unwrap();
                assert_eq!(actual.sh_labels, expected.sh_labels);
                if degree > 0 {
                    assert_eq!(full.sh_palette(degree), seeded.sh_palette(degree));
                }
            }
        }
    }

    #[test]
    fn codebook_initialization_skips_geometry_but_checks_container() {
        let (mut decoder, root, next) = fixture(true, true, 3);
        assert!(decoder.decode_chunk_data(&root, false).is_err());
        decoder.initialize_codebooks(&root).unwrap();
        assert!(decoder.decode_chunk_data(&next, false).is_ok());
        assert!(decoder.initialize_codebooks(&next).is_err());
        assert!(decoder
            .initialize_codebooks(&root[..root.len() - 1])
            .is_err());
    }

    #[test]
    fn failed_codebook_initialization_preserves_cache_and_palette() {
        for half in [false, true] {
            let (mut decoder, root, _) = fixture(half, false, 3);
            let bad = chunk(0, half, false, f32::INFINITY);
            decoder.initialize_codebooks(&root).unwrap();
            let palette = decoder.sh_palette(3).to_vec();
            let codes = decoder.codebooks.clone();
            // Keep the directory consistent so the failure tests the payload.
            decoder.meta.chunks[0].bytes = bad.len() as u64;
            assert!(decoder
                .initialize_codebooks(&bad)
                .unwrap_err()
                .to_string()
                .contains("Non-finite"));
            assert_eq!(decoder.codebooks, codes);
            assert_eq!(decoder.palettes[2].as_deref(), Some(palette.as_slice()));
        }
    }
}
