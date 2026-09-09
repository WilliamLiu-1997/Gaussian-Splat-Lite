//! SOG metadata, image and property decoding into a SplatReceiver.
//! Only the current property group and packed SH palette remain in the decoder.
use std::{array, io::Cursor};

use anyhow::{anyhow, bail, ensure, Context, Result};
use serde_json::Value;

use crate::{
    decoder::{SplatInit, SplatReceiver},
    splat_encode::encode_splat_sh_rgb,
};

const BATCH: usize = 65536;
const SH_COEFFS: [usize; 4] = [0, 3, 8, 15];
const SH_WORDS: [usize; 4] = [0, 4, 8, 16];
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
    if version == 2 {
        return Ok([codebook(section, name)?; N]);
    }
    let (mins, maxs) = ranges::<N>(section, name)?;
    Ok(array::from_fn(|d| {
        array::from_fn(|b| mins[d] + (maxs[d] - mins[d]) * (b as f32 / 255.0))
    }))
}

struct Metadata {
    count: usize,
    means: ([f32; 3], [f32; 3]),
    scales: [[f32; 256]; 3],
    colors: [[f32; 256]; 4],
    sh: [f32; 256],
    degree: usize,
    palette_count: usize,
    groups: Vec<(&'static str, Vec<String>)>,
}

impl Metadata {
    fn parse(text: &str) -> Result<Self> {
        let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .context("invalid meta.json")?;
        let version = match root.get("version") {
            None => 1,
            Some(value) => integer(value, "version")?,
        };
        ensure!(
            version == 1 || version == 2,
            "unsupported metadata version {version}"
        );
        if let Some(value) = root.get("model") {
            let model = value.as_str().context("model must be a string")?;
            ensure!(
                matches!(model, "default" | "antialiased"),
                "unsupported splat model {model}"
            );
        }
        let count = if version == 2 {
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
        if version == 2 {
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
        let mut geometry = files("scales", 1)?;
        geometry.extend(files("quats", 1)?);
        let mut groups = vec![
            ("means", files("means", 2)?),
            ("scales", geometry),
            ("sh0", files("sh0", 1)?),
        ];
        let (mut degree, mut palette_count, mut sh) = (0, 0, [0.0; 256]);
        if let Some(section) = root.get("shN").filter(|value| !value.is_null()) {
            ensure!(section.is_object(), "shN must be an object");
            let names = files("shN", 2)?;
            if version == 2 {
                if let Some(value) = section.get("bands") {
                    degree = integer(value, "shN.bands")?;
                    ensure!((1..=3).contains(&degree), "shN.bands must be 1, 2, or 3");
                }
                if let Some(value) = section.get("count") {
                    palette_count = integer(value, "shN.count")?;
                    ensure!((1..=65536).contains(&palette_count), "invalid shN.count");
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
        Ok(Self {
            count,
            means,
            scales,
            colors,
            sh,
            degree,
            palette_count,
            groups,
        })
    }
}

struct Image {
    width: usize,
    height: usize,
    channels: usize,
    bytes: Vec<u8>,
}

impl Image {
    fn channel(&self, pixel: usize, channel: usize) -> u8 {
        match (self.channels, channel) {
            (1 | 3, 3) => 255,
            (2, 3) => self.bytes[pixel * 2 + 1],
            (1 | 2, _) => self.bytes[pixel * self.channels],
            _ => self.bytes[pixel * self.channels + channel],
        }
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            let mut decoder = png::Decoder::new_with_limits(
                Cursor::new(bytes),
                png::Limits { bytes: usize::MAX },
            );
            decoder.set_transformations(png::Transformations::EXPAND);
            let mut reader = decoder.read_info().context("invalid PNG")?;
            ensure!(
                reader.info().bit_depth != png::BitDepth::Sixteen,
                "16-bit PNG is unsupported"
            );
            ensure!(
                reader.info().animation_control.is_none(),
                "animated PNG is unsupported"
            );
            let size = reader.output_buffer_size();
            let mut bytes = vec![0; size];
            let frame = reader.next_frame(&mut bytes).context("PNG decode failed")?;
            ensure!(
                frame.bit_depth == png::BitDepth::Eight,
                "PNG must decode to 8-bit samples"
            );
            let channels = frame.color_type.samples();
            bytes.truncate(frame.buffer_size());
            return Ok(Self {
                width: frame.width as usize,
                height: frame.height as usize,
                channels,
                bytes,
            });
        }
        ensure!(
            bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            "asset must be a lossless WebP or 8-bit PNG"
        );
        let mut decoder =
            image_webp::WebPDecoder::new(Cursor::new(bytes)).context("invalid WebP")?;
        ensure!(
            !decoder.is_animated() && !decoder.is_lossy(),
            "animated or lossy WebP is unsupported"
        );
        let (width, height) = decoder.dimensions();
        let size = decoder
            .output_buffer_size()
            .context("WebP dimensions overflow")?;
        let channels = if decoder.has_alpha() { 4 } else { 3 };
        let mut bytes = vec![0; size];
        decoder
            .read_image(&mut bytes)
            .context("WebP decode failed")?;
        Ok(Self {
            width: width as usize,
            height: height as usize,
            channels,
            bytes,
        })
    }
}

fn unpack(bytes: Vec<u8>, method: u32, size: usize, crc: f64) -> Result<Vec<u8>> {
    ensure!(
        crc == -1.0
            || (crc.is_finite() && crc >= 0.0 && crc.fract() == 0.0 && crc <= u32::MAX as f64),
        "invalid ZIP CRC"
    );
    let known_size = size != 0 || crc >= 0.0;
    let bytes = match method {
        0 => bytes,
        8 => miniz_oxide::inflate::decompress_to_vec_with_limit(
            &bytes,
            if known_size { size } else { usize::MAX },
        )
        .map_err(|error| anyhow!("invalid ZIP deflate stream: {error:?}"))?,
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
    splats: T,
    initialized: bool,
    group: usize,
    base: usize,
    images: Vec<Image>,
    dimensions: Option<(usize, usize)>,
    palette: Vec<u32>,
    positions: Vec<f32>,
    floats: Vec<f32>,
    labels: Vec<u16>,
}

impl<T: SplatReceiver> SogDecoder<T> {
    pub fn new(splats: T, metadata: &str) -> Result<Self> {
        let meta = Metadata::parse(metadata)?;
        let mut session = Self {
            meta,
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
        };
        // Missing SH bands (including V1) need the palette before allocation.
        if session.meta.degree != 0 || session.meta.groups[0].0 != "centroids" {
            session.init_splats()?;
        }
        Ok(session)
    }

    pub fn plan(&self) -> Vec<&[String]> {
        self.meta
            .groups
            .iter()
            .map(|(_, files)| files.as_slice())
            .collect()
    }

    pub fn finish(&mut self) -> Result<()> {
        ensure!(self.group == self.meta.groups.len(), "decode is incomplete");
        ensure!(self.initialized, "missing output");
        self.splats.finish()
    }

    pub fn into_splats(self) -> T {
        self.splats
    }
}

impl<T: SplatReceiver> SogDecoder<T> {
    pub fn decode_asset(
        &mut self,
        bytes: Vec<u8>,
        method: u32,
        size: usize,
        crc: f64,
    ) -> Result<()> {
        ensure!(
            self.base == 0
                && self.group < self.meta.groups.len()
                && self.images.len() < self.meta.groups[self.group].1.len(),
            "invalid asset sequence"
        );
        ensure!(matches!(method, 0 | 8), "invalid entry method");
        let bytes = unpack(bytes, method, size, crc)?;
        let image = Image::decode(&bytes)?;
        if self.meta.groups[self.group].0 != "centroids" {
            ensure!(
                image.width.saturating_mul(image.height) >= self.meta.count,
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
            max_sh_degree: self.meta.degree,
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
            _ => bail!("invalid centroid texture width"),
        };
        if self.meta.degree == 0 {
            self.meta.degree = degree;
        }
        if self.meta.palette_count == 0 {
            self.meta.palette_count = image
                .height
                .checked_mul(64)
                .context("palette size overflow")?;
        }
        ensure!(
            degree == self.meta.degree,
            "centroid width does not match shN.bands"
        );
        ensure!(
            (1..=65536).contains(&self.meta.palette_count)
                && self.meta.palette_count <= image.height.saturating_mul(64),
            "invalid centroid count or height"
        );
        let words = SH_WORDS[self.meta.degree];
        self.palette.resize(self.meta.palette_count * words, 0);
        for label in 0..self.meta.palette_count {
            let pixel = (label / 64) * image.width + (label % 64) * SH_COEFFS[degree];
            for coeff in 0..SH_COEFFS[self.meta.degree] {
                let rgb =
                    array::from_fn(|d| self.meta.sh[image.channel(pixel + coeff, d) as usize]);
                self.palette[label * words + coeff] = encode_splat_sh_rgb(rgb);
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
        let count = BATCH.min(self.meta.count - self.base);
        let splats = &mut self.splats;
        let image = &self.images[0];
        match role {
            "means" => {
                let (mins, maxs) = self.meta.means;
                let position = |d: usize, code: usize| {
                    let value = mins[d] + (maxs[d] - mins[d]) * (code as f32 / 65535.0);
                    value.signum() * value.abs().exp_m1()
                };
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
                self.floats.resize(count * 7, 0.0);
                let (scales, quats) = self.floats.split_at_mut(count * 3);
                let quat_image = &self.images[1];
                for i in 0..count {
                    for d in 0..3 {
                        scales[i * 3 + d] =
                            self.meta.scales[d][image.channel(self.base + i, d) as usize];
                    }
                    let [a, b, c] = array::from_fn(|d| {
                        (quat_image.channel(self.base + i, d) as f32 / 255.0 - 0.5)
                            * std::f32::consts::SQRT_2
                    });
                    let d = (1.0 - a * a - b * b - c * c).max(0.0).sqrt();
                    let quat = match quat_image.channel(self.base + i, 3) {
                        252 => [a, b, c, d],
                        253 => [d, b, c, a],
                        254 => [b, d, c, a],
                        255 => [b, c, d, a],
                        _ => bail!("invalid quaternion tag at splat {}", self.base + i),
                    };
                    let norm = quat.iter().map(|value| value * value).sum::<f32>().sqrt();
                    for d in 0..4 {
                        quats[i * 4 + d] = quat[d] / norm;
                    }
                }
                splats.set_ln_scale(self.base, count, scales);
                splats.set_quat(self.base, count, quats);
            }
            "sh0" => {
                self.floats.resize(count * 4, 0.0);
                let (rgb, opacity) = self.floats.split_at_mut(count * 3);
                for i in 0..count {
                    for d in 0..3 {
                        rgb[i * 3 + d] =
                            self.meta.colors[d][image.channel(self.base + i, d) as usize];
                    }
                    opacity[i] = self.meta.colors[3][image.channel(self.base + i, 3) as usize];
                }
                splats.set_rgb(self.base, count, rgb);
                splats.set_opacity(self.base, count, opacity);
            }
            "labels" => {
                self.labels.resize(count, 0);
                for (i, label) in self.labels.iter_mut().enumerate() {
                    *label = image.channel(self.base + i, 0) as u16
                        | ((image.channel(self.base + i, 1) as u16) << 8);
                    ensure!(
                        (*label as usize) < self.meta.palette_count,
                        "SH label exceeds palette at splat {}",
                        self.base + i
                    );
                }
                splats.set_sh_palette(
                    self.base,
                    count,
                    self.meta.degree,
                    &self.palette,
                    &self.labels,
                );
            }
            _ => bail!("unknown property group"),
        }
        self.base += count;
        if self.base == self.meta.count {
            self.images.clear();
            self.positions = Vec::new();
            self.base = 0;
            self.group += 1;
            return Ok(true);
        }
        Ok(false)
    }
}
