//! SOG metadata and property decoding into a SplatReceiver.
//! Only the current property group and packed SH palette remain in the decoder.
use std::{array, collections::HashSet, io::Read};

use anyhow::{bail, ensure, Context, Result};
use flate2::read::DeflateDecoder;
use serde_json::Value;

use crate::{
    decoder::{QuantizedProperty, ScalarLookup, SplatInit, SplatReceiver},
    opacity::sog_opacity_lookup,
    splat_encode::{decode_position_sog, decode_quat_sog_v3, ShLookup},
};

const BATCH: usize = 65536;
const SH_COEFFS: [usize; 5] = [0, 3, 8, 15, 24];
const SH_WORDS: [usize; 5] = [0, 4, 8, 16, 24];
const SH_C0: f32 = 0.282_094_8;

fn integer(value: &Value, name: &str) -> Result<usize> {
    let value = value
        .as_u64()
        .with_context(|| format!("{name} must be an integer"))?;
    usize::try_from(value).with_context(|| format!("{name} is too large"))
}

fn number(value: &Value, name: &str) -> Result<f32> {
    let value = value
        .as_f64()
        .with_context(|| format!("{name} must be a number"))? as f32;
    ensure!(value.is_finite(), "{name} must be finite");
    Ok(value)
}

fn numbers<const N: usize>(value: &Value, name: &str) -> Result<[f32; N]> {
    let values = value
        .as_array()
        .with_context(|| format!("{name} must be an array"))?;
    ensure!(values.len() == N, "{name} must have {N} entries");
    let mut result = [0.0; N];
    for (out, value) in result.iter_mut().zip(values) {
        *out = number(value, name)?;
    }
    Ok(result)
}

fn ranges<const N: usize>(section: &Value, name: &str) -> Result<([f32; N], [f32; N])> {
    let mins = numbers::<N>(&section["mins"], &format!("{name}.mins"))?;
    let maxs = numbers::<N>(&section["maxs"], &format!("{name}.maxs"))?;
    ensure!(
        mins.iter()
            .zip(maxs)
            .all(|(min, max)| *min <= max && (max - min).is_finite()),
        "invalid {name} range"
    );
    Ok((mins, maxs))
}

fn codebook(section: &Value, name: &str) -> Result<[f32; 256]> {
    let name = format!("{name}.codebook");
    let mut values = section["codebook"].clone();
    // Older SOG writers emitted a null first entry; match PlayCanvas's repair.
    if values.get(0).is_some_and(Value::is_null) {
        let next = number(&values[1], &name)?;
        values[0] = Value::from(next + (next - number(&values[255], &name)?) / 255.0);
    }
    numbers::<256>(&values, &name)
}

fn lookup<const N: usize>(section: &Value, version: usize, name: &str) -> Result<[[f32; 256]; N]> {
    if version >= 2 {
        return Ok([codebook(section, name)?; N]);
    }
    let (mins, maxs) = ranges::<N>(section, name)?;
    Ok(array::from_fn(|d| {
        array::from_fn(|b| mins[d] + (maxs[d] - mins[d]) * (b as f32 / 255.0))
    }))
}

struct Metadata {
    version: usize,
    count: usize,
    means: ([f32; 3], [f32; 3]),
    scales: [ScalarLookup; 3],
    colors: [ScalarLookup; 4],
    sh: [f32; 256],
    degree: usize,
    palette_count: usize,
    groups: Vec<(&'static str, Vec<String>)>,
    blind: Vec<Value>,
    warnings: Vec<String>,
}

impl Metadata {
    fn parse(text: &str, keep_blind: bool) -> Result<Self> {
        let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .context("invalid meta.json")?;
        let version = match root.get("version") {
            None => 1,
            Some(value) => integer(value, "version")?,
        };
        ensure!(
            (1..=3).contains(&version),
            "unsupported metadata version {version}"
        );
        if let Some(value) = root.get("model") {
            let model = value.as_str().context("model must be a string")?;
            ensure!(
                matches!(model, "default" | "antialiased"),
                "unsupported splat model {model}"
            );
        }
        let count = if version >= 2 {
            integer(&root["count"], "count")?
        } else {
            let shape = root["means"]["shape"]
                .as_array()
                .context("means.shape is required for V1")?;
            ensure!(
                shape.len() == 2 && integer(&shape[1], "means.shape[1]")? == 3,
                "invalid means.shape"
            );
            integer(&shape[0], "means.shape[0]")?
        };
        ensure!(count <= u32::MAX as usize / 4, "splat count is too large");
        let means = ranges::<3>(&root["means"], "means")?;
        ensure!(
            means
                .0
                .iter()
                .chain(&means.1)
                .all(|value| value.abs().exp_m1().is_finite()),
            "position range exceeds float32"
        );
        let scales = lookup::<3>(&root["scales"], version, "scales")?;
        let mut colors = lookup::<4>(&root["sh0"], version, "sh0")?;
        for component in colors.iter_mut().take(3) {
            for value in component {
                *value = 0.5 + SH_C0 * *value;
            }
        }
        if version == 3 {
            colors[3] = sog_opacity_lookup();
        } else if version == 2 {
            colors[3] = array::from_fn(|b| b as f32 / 255.0);
        } else {
            for value in &mut colors[3] {
                *value = 1.0 / (1.0 + (-*value).exp());
            }
        }
        if let Some(encoding) = root["quats"].get("encoding") {
            ensure!(
                encoding.as_str() == Some("quaternion_packed"),
                "unsupported quaternion encoding"
            );
        }
        let files = |section: &str, count: usize| -> Result<Vec<String>> {
            let names = root[section]["files"]
                .as_array()
                .with_context(|| format!("{section}.files is required"))?;
            ensure!(names.len() == count, "invalid {section}.files length");
            names
                .iter()
                .map(|name| {
                    name.as_str()
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .context("asset filename must be a nonempty string")
                })
                .collect()
        };
        let mut scales_files = files("scales", 1)?;
        scales_files.extend(files("quats", 1)?);
        let mut groups = vec![
            ("means", files("means", 2)?),
            ("scales", scales_files),
            ("sh0", files("sh0", 1)?),
        ];
        let (mut degree, mut palette_count, mut sh) = (0, 0, [0.0; 256]);
        if let Some(section) = root.get("shN").filter(|value| !value.is_null()) {
            let names = files("shN", 2)?;
            if version >= 2 {
                if let Some(value) = section.get("bands") {
                    degree = integer(value, "shN.bands")?;
                    let max_degree = if version == 3 { 4 } else { 3 };
                    ensure!((1..=max_degree).contains(&degree), "invalid shN.bands");
                }
                if let Some(value) = section.get("count") {
                    palette_count = integer(value, "shN.count")?;
                    let limit = if version == 3 { 1 << 24 } else { 65536 };
                    ensure!((1..=limit).contains(&palette_count), "invalid shN.count");
                }
                sh = codebook(section, "shN")?;
            } else {
                let min = number(&section["mins"], "shN.mins")?;
                let max = number(&section["maxs"], "shN.maxs")?;
                ensure!(min <= max && (max - min).is_finite(), "invalid shN range");
                sh = array::from_fn(|b| min + (max - min) * (b as f32 / 255.0));
            }
            groups.insert(0, ("centroids", vec![names[0].clone()]));
            groups.push(("labels", vec![names[1].clone()]));
        }
        let mut warnings = Vec::new();
        let mut blind = Vec::new();
        if keep_blind {
            for (texture, file) in blind_textures(&root, version, &mut warnings) {
                blind.push(texture);
                groups.push(("blind", vec![file]));
            }
        }
        Ok(Self {
            version,
            count,
            means,
            scales: scales.map(|values| QuantizedProperty::LnScale.lookup(values)),
            colors: array::from_fn(|d| {
                let property = if d == 3 {
                    QuantizedProperty::Opacity
                } else {
                    QuantizedProperty::Rgb
                };
                property.lookup(colors[d])
            }),
            sh,
            degree,
            palette_count,
            groups,
            blind,
            warnings,
        })
    }
}

/// Blind textures hold optional application data: an invalid one is skipped
/// with a warning instead of failing the whole model.
fn blind_textures(
    root: &Value,
    version: usize,
    warnings: &mut Vec<String>,
) -> Vec<(Value, String)> {
    let Some(value) = root.get("blind") else {
        return Vec::new();
    };
    if version != 3 {
        warnings.push("blind data requires SOG v3; ignored".to_owned());
        return Vec::new();
    }
    let Some(textures) = value.as_array() else {
        warnings.push("blind must be an array; ignored".to_owned());
        return Vec::new();
    };
    let mut names = HashSet::new();
    let mut kept = Vec::new();
    for (index, texture) in textures.iter().enumerate() {
        match blind_texture(texture) {
            Ok((file, ids)) if ids.iter().all(|id| !names.contains(id)) => {
                names.extend(ids);
                kept.push((texture.clone(), file));
            }
            Ok(_) => warnings.push(format!(
                "blind texture {index} repeats a field name; ignored"
            )),
            Err(error) => warnings.push(format!("blind texture {index}: {error}; ignored")),
        }
    }
    kept
}

/// Validates one texture; returns its image name and its fields' identifiers.
fn blind_texture(texture: &Value) -> Result<(String, Vec<String>)> {
    let files = texture["files"]
        .as_array()
        .context("files must be an array")?;
    let file = match files.as_slice() {
        [file] => file.as_str().filter(|s| !s.is_empty()),
        _ => None,
    }
    .context("files must name one image")?;
    let fields = texture["fields"]
        .as_array()
        .context("fields must be an array")?;
    ensure!(!fields.is_empty(), "fields must not be empty");
    let mut bytes = 0;
    let mut ids = Vec::new();
    for field in fields {
        let name = field["name"]
            .as_str()
            .context("field name must be a string")?;
        // The SOG v3 proposal requires names to stay distinct as shader identifiers.
        let id = name
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("_");
        ensure!(
            !id.is_empty() && !ids.contains(&id),
            "empty or repeated field name {name}"
        );
        ids.push(id);
        let kind = field["type"]
            .as_str()
            .context("field type must be a string")?;
        bytes += match kind {
            "u8" | "unorm8" => 1,
            "u16" | "f16" | "unorm16" => 2,
            "u24" => 3,
            "u32" | "f32" => 4,
            _ => bail!("unsupported field type {kind}"),
        };
        if let Some(range) = field.get("range") {
            let range = range
                .as_array()
                .filter(|values| values.len() == 2)
                .context("field range must have 2 entries")?;
            let min = range[0].as_f64().context("field range must be numbers")?;
            let max = range[1].as_f64().context("field range must be numbers")?;
            ensure!(
                min.is_finite() && max.is_finite() && min <= max && (max - min).is_finite(),
                "invalid field range"
            );
        }
    }
    ensure!(bytes <= 4, "fields exceed four bytes");
    Ok((file.to_owned(), ids))
}

struct Image {
    width: usize,
    height: usize,
    channels: usize,
    bytes: Vec<u8>,
}

impl Image {
    fn channel(&self, pixel: usize, channel: usize) -> u8 {
        if self.channels == 3 && channel == 3 {
            255
        } else {
            self.bytes[pixel * self.channels + channel]
        }
    }

    fn new(bytes: Vec<u8>, width: usize, height: usize, channels: usize) -> Result<Self> {
        ensure!(
            width > 0 && height > 0 && matches!(channels, 3 | 4),
            "invalid image dimensions or channels"
        );
        let size = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(channels))
            .context("image dimensions overflow")?;
        ensure!(bytes.len() == size, "image byte length mismatch");
        Ok(Self {
            width,
            height,
            channels,
            bytes,
        })
    }
}

pub fn unpack(bytes: Vec<u8>, method: u32, size: usize, crc: f64) -> Result<Vec<u8>> {
    ensure!(
        crc == -1.0
            || (crc.is_finite() && crc >= 0.0 && crc.fract() == 0.0 && crc <= u32::MAX as f64),
        "invalid ZIP CRC"
    );
    let known_size = size != 0 || crc >= 0.0;
    let bytes = match method {
        0 => bytes,
        8 => {
            // Probe one byte beyond the declared size so excess output is rejected.
            let limit = if known_size {
                (size as u64).saturating_add(1)
            } else {
                u64::MAX
            };
            let mut decoded = Vec::new();
            DeflateDecoder::new(bytes.as_slice())
                .take(limit)
                .read_to_end(&mut decoded)
                .context("invalid ZIP deflate stream")?;
            decoded
        }
        _ => bail!("unsupported ZIP method {method}"),
    };
    ensure!(
        !known_size || bytes.len() == size,
        "ZIP entry size mismatch"
    );
    if crc >= 0.0 {
        ensure!(
            crc32fast::hash(&bytes) == crc as u32,
            "ZIP entry CRC mismatch"
        );
    }
    Ok(bytes)
}

pub fn decode_sog_meta(bytes: Vec<u8>, method: u32, size: usize, crc: f64) -> Result<String> {
    Ok(String::from_utf8(unpack(bytes, method, size, crc)?)?)
}

pub struct SogDecoder<T: SplatReceiver> {
    meta: Metadata,
    max_sh: usize,
    splats: T,
    initialized: bool,
    group: usize,
    base: usize,
    images: Vec<Image>,
    dimensions: Option<(usize, usize)>,
    palette: Vec<u32>,
    positions: Vec<f32>,
    floats: Vec<f32>,
    labels: Vec<u32>,
    blind_index: usize,
}

impl<T: SplatReceiver> SogDecoder<T> {
    /// `blind: false` skips Blind textures, so their images are never planned or decoded.
    pub fn new(splats: T, metadata: &str, max_sh: usize, blind: bool) -> Result<Self> {
        ensure!(max_sh <= 4, "maxSh must be between 0 and 4");
        let mut meta = Metadata::parse(metadata, blind)?;
        if max_sh == 0 {
            meta.groups
                .retain(|(role, _)| !matches!(*role, "centroids" | "labels"));
        }
        Ok(Self {
            meta,
            max_sh,
            splats,
            initialized: false,
            group: 0,
            base: 0,
            images: Vec::new(),
            dimensions: None,
            palette: Vec::new(),
            positions: Vec::new(),
            floats: Vec::new(),
            labels: Vec::new(),
            blind_index: 0,
        })
    }

    pub fn plan(&self) -> Vec<&[String]> {
        self.meta
            .groups
            .iter()
            .map(|(_, files)| files.as_slice())
            .collect()
    }

    pub fn blind_metadata(&self) -> &[Value] {
        &self.meta.blind
    }

    /// Metadata problems that were skipped instead of failing the load.
    pub fn warnings(&self) -> &[String] {
        &self.meta.warnings
    }

    pub fn finish(&mut self) -> Result<()> {
        ensure!(self.group == self.meta.groups.len(), "decode is incomplete");
        self.splats.finish()
    }

    pub fn into_splats(self) -> T {
        self.splats
    }
}

impl<T: SplatReceiver> SogDecoder<T> {
    pub fn decode_image(
        &mut self,
        bytes: Vec<u8>,
        width: usize,
        height: usize,
        channels: usize,
    ) -> Result<()> {
        ensure!(
            self.base == 0
                && self.group < self.meta.groups.len()
                && self.images.len() < self.meta.groups[self.group].1.len(),
            "invalid asset sequence"
        );
        let image = Image::new(bytes, width, height, channels)?;
        if self.meta.groups[self.group].0 != "centroids" {
            ensure!(
                image.width * image.height >= self.meta.count,
                "texture has fewer pixels than splats"
            );
            let dimensions = (image.width, image.height);
            ensure!(
                self.dimensions
                    .is_none_or(|expected| dimensions == expected),
                "per-splat texture dimensions differ"
            );
            self.dimensions = Some(dimensions);
        }
        self.images.push(image);
        Ok(())
    }

    fn init_splats(&mut self) -> Result<()> {
        if self.initialized {
            return Ok(());
        }
        self.splats.init_splats(&SplatInit {
            num_splats: self.meta.count,
            max_sh_degree: self.meta.degree.min(self.max_sh),
            indexed_sh: self.meta.degree.min(self.max_sh) > 0,
        })?;
        self.initialized = true;
        Ok(())
    }

    fn decode_palette(&mut self) -> Result<()> {
        let image = &self.images[0];
        let degree = match image.width {
            192 => 1,
            512 => 2,
            960 => 3,
            1536 if self.meta.version == 3 => 4,
            _ => bail!("invalid centroid texture width"),
        };
        if self.meta.degree == 0 {
            self.meta.degree = degree;
        }
        if self.meta.palette_count == 0 {
            self.meta.palette_count = image.height * 64;
        }
        ensure!(
            degree == self.meta.degree,
            "centroid width does not match shN.bands"
        );
        let limit = if self.meta.version == 3 {
            1 << 24
        } else {
            65536
        };
        ensure!(
            (1..=limit).contains(&self.meta.palette_count)
                && self.meta.palette_count <= image.height * 64,
            "invalid centroid count or height"
        );
        let num_sh = degree.min(self.max_sh);
        let words = SH_WORDS[num_sh];
        let lookup = ShLookup::new(self.meta.sh);
        self.palette.resize(self.meta.palette_count * words, 0);
        for label in 0..self.meta.palette_count {
            let pixel = (label / 64) * image.width + (label % 64) * SH_COEFFS[degree];
            for coeff in 0..SH_COEFFS[num_sh] {
                self.palette[label * words + coeff] =
                    lookup.encode(array::from_fn(|d| image.channel(pixel + coeff, d)));
            }
        }
        self.init_splats()
    }

    pub fn decode_batch(&mut self) -> Result<bool> {
        ensure!(
            self.group < self.meta.groups.len()
                && self.images.len() == self.meta.groups[self.group].1.len(),
            "property group is incomplete"
        );
        let role = self.meta.groups[self.group].0;
        if role == "centroids" {
            self.decode_palette()?;
            self.images.clear();
            self.group += 1;
            return Ok(true);
        }
        self.init_splats()?;
        let count = BATCH.min(self.meta.count - self.base);
        let splats = &mut self.splats;
        let image = &self.images[0];
        match role {
            "blind" => {
                self.labels.resize(count, 0);
                for (i, word) in self.labels.iter_mut().enumerate() {
                    *word = u32::from_le_bytes(array::from_fn(|d| image.channel(self.base + i, d)));
                }
                splats.set_blind(self.blind_index, self.base, &self.labels);
            }
            "means" => {
                let (mins, maxs) = self.meta.means;
                let position =
                    |d: usize, code: usize| decode_position_sog(code as u16, mins[d], maxs[d]);
                if self.meta.count >= BATCH && self.positions.is_empty() {
                    self.positions = (0..3 * 65536)
                        .map(|index| position(index / 65536, index % 65536))
                        .collect();
                }
                self.floats.resize(count * 3, 0.0);
                for i in 0..count {
                    for d in 0..3 {
                        let code = image.channel(self.base + i, d) as usize
                            | ((self.images[1].channel(self.base + i, d) as usize) << 8);
                        self.floats[i * 3 + d] = if self.positions.is_empty() {
                            position(d, code)
                        } else {
                            self.positions[d * 65536 + code]
                        };
                    }
                }
                splats.set_center(self.base, count, &self.floats);
            }
            "scales" => {
                let quat_image = &self.images[1];
                splats.set_quantized(
                    self.base,
                    count,
                    QuantizedProperty::LnScale,
                    &self.meta.scales,
                    |i, d| image.channel(self.base + i, d),
                );
                // v3 keeps an exponential map in RGB, v1 and v2 smallest-three.
                if self.meta.version == 3 {
                    splats.set_quat_from(
                        self.base,
                        count,
                        |i| {
                            decode_quat_sog_v3(array::from_fn(|d| {
                                quat_image.channel(self.base + i, d)
                            }))
                        },
                        &mut self.floats,
                    );
                } else {
                    splats.set_quat_sog(
                        self.base,
                        count,
                        |i| array::from_fn(|d| quat_image.channel(self.base + i, d)),
                        &mut self.floats,
                    )?;
                }
            }
            "sh0" => {
                splats.set_quantized(
                    self.base,
                    count,
                    QuantizedProperty::Rgb,
                    &self.meta.colors[..3],
                    |i, d| image.channel(self.base + i, d),
                );
                splats.set_quantized(
                    self.base,
                    count,
                    QuantizedProperty::Opacity,
                    &self.meta.colors[3..],
                    |i, _| image.channel(self.base + i, 3),
                );
            }
            "labels" => {
                self.labels.resize(count, 0);
                for (i, label) in self.labels.iter_mut().enumerate() {
                    *label = image.channel(self.base + i, 0) as u32
                        | ((image.channel(self.base + i, 1) as u32) << 8);
                    if self.meta.version == 3 {
                        *label |= (image.channel(self.base + i, 2) as u32) << 16;
                    }
                    ensure!(
                        (*label as usize) < self.meta.palette_count,
                        "SH label exceeds palette at splat {}",
                        self.base + i
                    );
                }
                splats.set_sh_palette(
                    self.base,
                    count,
                    self.meta.degree.min(self.max_sh),
                    &self.palette,
                    &self.labels,
                );
            }
            _ => unreachable!("property groups are assigned by Metadata::parse"),
        }
        self.base += count;
        if self.base == self.meta.count {
            if role == "blind" {
                self.blind_index += 1;
            }
            self.images.clear();
            self.positions = Vec::new();
            self.base = 0;
            self.group += 1;
            return Ok(true);
        }
        Ok(false)
    }
}

#[cfg(test)]
mod rotation_tests {
    use super::*;
    use crate::decoder::SplatProps;
    use serde_json::json;

    #[derive(Default)]
    struct Rotations(Vec<f32>);
    impl SplatReceiver for Rotations {
        fn set_batch(&mut self, _: usize, _: usize, _: &SplatProps) {}
        fn set_center(&mut self, _: usize, _: usize, _: &[f32]) {}
        fn set_opacity(&mut self, _: usize, _: usize, _: &[f32]) {}
        fn set_rgb(&mut self, _: usize, _: usize, _: &[f32]) {}
        fn set_scale(&mut self, _: usize, _: usize, _: &[f32]) {}
        fn set_quat(&mut self, _: usize, _: usize, values: &[f32]) {
            self.0.extend_from_slice(values);
        }
    }

    fn metadata(version: usize) -> Value {
        let mut meta = json!({
            "version": version, "count": 2,
            "means": {"mins": [0,0,0], "maxs": [1,1,1], "files": ["low", "high"]},
            "scales": {"codebook": vec![0.0;256], "files": ["scale"]},
            "quats": {"files": ["rotation"]},
            "sh0": {"codebook": vec![0.0;256], "files": ["color"]}
        });
        if version == 1 {
            meta["means"]["shape"] = json!([2, 3]);
            meta["scales"]["mins"] = json!([0, 0, 0]);
            meta["scales"]["maxs"] = json!([1, 1, 1]);
            meta["sh0"]["mins"] = json!([0, 0, 0, 0]);
            meta["sh0"]["maxs"] = json!([1, 1, 1, 1]);
        }
        meta
    }

    // Identity and a half-turn around X, as each version stores them.
    fn decode(version: usize) -> Vec<f32> {
        let meta = metadata(version).to_string();
        let mut decoder = SogDecoder::new(Rotations::default(), &meta, 0, false).unwrap();
        let plan: Vec<Vec<String>> = decoder.plan().into_iter().map(<[String]>::to_vec).collect();
        for group in plan {
            for name in group {
                let pixels = match (name.as_str(), version) {
                    // The alpha of the v3 texture holds nothing.
                    ("rotation", 3) => [128, 128, 128, 0, 255, 128, 128, 17],
                    ("rotation", _) => [128, 128, 128, 252, 128, 128, 128, 253],
                    _ => [0, 0, 0, 255, 0, 0, 0, 255],
                };
                decoder.decode_image(pixels.to_vec(), 2, 1, 4).unwrap();
            }
            while !decoder.decode_batch().unwrap() {}
        }
        decoder.finish().unwrap();
        decoder.into_splats().0
    }

    #[test]
    fn each_version_decodes_its_rotation_encoding() {
        let expected = [0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        for (version, tolerance) in [(1, 0.005), (2, 0.005), (3, 1e-6)] {
            let actual = decode(version);
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.iter().zip(expected) {
                assert!((actual - expected).abs() < tolerance);
            }
        }
    }

    #[test]
    fn rotation_texture_is_required() {
        for version in [2, 3] {
            let meta = Metadata::parse(&metadata(version).to_string(), false).unwrap();
            assert_eq!(meta.groups[1].1, ["scale", "rotation"]);
            for invalid in [Value::Null, json!({"files": []}), json!({"files": [""]})] {
                let mut meta = metadata(version);
                meta["quats"] = invalid;
                assert!(Metadata::parse(&meta.to_string(), false).is_err());
            }
            let mut meta = metadata(version);
            meta.as_object_mut().unwrap().remove("quats");
            assert!(Metadata::parse(&meta.to_string(), false).is_err());
        }
    }
}

#[cfg(test)]
mod unpack_tests {
    use std::io::Read;

    use flate2::{read::DeflateEncoder, Compression};

    use super::unpack;

    #[test]
    fn inflates_zip_entries_with_exact_size_and_crc() {
        let data = b"{\"version\":2}".repeat(100);
        let crc = crc32fast::hash(&data);
        let mut packed = Vec::new();
        DeflateEncoder::new(data.as_slice(), Compression::new(6))
            .read_to_end(&mut packed)
            .unwrap();
        let unpack = |bytes: &[u8], size: usize, crc: f64| unpack(bytes.to_vec(), 8, size, crc);
        assert_eq!(unpack(&packed, data.len(), crc as f64).unwrap(), data);
        assert_eq!(unpack(&packed, 0, -1.0).unwrap(), data);
        // Declared size without CRC: the size alone must reject longer or shorter output.
        assert!(unpack(&packed, data.len() - 1, -1.0).is_err());
        assert!(unpack(&packed, data.len() + 1, -1.0).is_err());
        assert!(unpack(&packed, data.len(), (crc ^ 1) as f64).is_err());
        assert!(unpack(&packed[..packed.len() - 1], data.len(), crc as f64).is_err());
        assert!(unpack(&packed[..packed.len() / 2], 0, -1.0).is_err());
    }
}
