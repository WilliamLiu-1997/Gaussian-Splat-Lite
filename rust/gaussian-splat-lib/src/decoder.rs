use std::any::Any;

use flate2::{Decompress, FlushDecompress, Status};

use crate::{
    ply::{PlyDecoder, PLY_MAGIC},
    splat_encode::{
        decode_quat_sog, decode_quat_spz, decode_quat_spz_legacy, decode_splat_sh_rgb,
        encode_splat_opacity,
    },
    spz::{SpzDecoder, SPZ_MAGIC},
};

pub trait ChunkReceiver: Any {
    /// Supplies the exact encoded input length when the caller knows it before
    /// decoding starts. Container decoders can use this to validate metadata
    /// before allocating output storage. File lengths use u64 independently of
    /// the address space used for individual input buffers.
    fn set_expected_input_size(&mut self, _size: u64) -> anyhow::Result<()> {
        Ok(())
    }
    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()>;
    fn finish(&mut self) -> anyhow::Result<()>;
    fn into_any(self: Box<Self>) -> Box<dyn Any>;
}

#[derive(Debug, Clone, Default)]
pub struct SplatInit {
    pub num_splats: usize,
    pub max_sh_degree: usize,
    pub indexed_sh: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SplatProps<'a> {
    pub center: &'a [f32],
    pub opacity: &'a [f32],
    pub rgb: &'a [f32],
    /// Prepacked RAD opacity; empty when opacity is supplied as floats.
    pub opacity_packed: &'a [u32],
    pub scale: &'a [f32],
    pub quat: &'a [f32],
    /// Smallest-three words for receivers that opt into PACKED_QUATERNIONS.
    pub quat_packed: &'a [u32],
    pub sh1: &'a [f32],
    pub sh2: &'a [f32],
    pub sh3: &'a [f32],
    pub sh4: &'a [f32],
}

#[derive(Clone, Copy)]
pub enum QuantizedProperty {
    Opacity,
    Rgb,
    LnScale,
}

pub struct ScalarLookup {
    pub values: [f32; 256],
    pub packed: [u32; 256],
}

impl QuantizedProperty {
    pub fn lookup(self, values: [f32; 256]) -> ScalarLookup {
        let packed = values.map(|value| match self {
            Self::Opacity => {
                let mut words = [0; 4];
                encode_splat_opacity(&mut words, value);
                words[3]
            }
            _ => half::f16::from_f32(value).to_bits() as u32,
        });
        ScalarLookup { values, packed }
    }
}

#[allow(unused)]
pub trait SplatReceiver: 'static {
    const SUPPORTS_COMPRESSED_PLY: bool = true;
    /// Accepts packed rotation words; float rotations may be unnormalized.
    const PACKED_QUATERNIONS: bool = false;
    /// Keeps one shared SH palette plus per-splat labels. RAD then supplies the
    /// palette with the first chunk only and later chunks through `set_sh_labels`.
    const SHARED_SH: bool = false;

    /// Reserve the decoder's estimated live working memory before allocation.
    /// Budgeted receivers can spill their output storage to make room.
    fn reserve_decoder_memory(&mut self, _bytes: usize) -> anyhow::Result<()> {
        Ok(())
    }
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        Ok(())
    }
    fn finish(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps);
    /// Accepts the same batch with scale supplied in natural-log space.
    /// Receivers that store log scale should override this to avoid exp/log
    /// conversion; the default converts back to linear scale.
    fn set_batch_ln_scale(
        &mut self,
        base: usize,
        count: usize,
        batch: &SplatProps,
        ln_scale: &[f32],
    ) {
        let scale: Vec<f32> = ln_scale.iter().map(|value| value.exp()).collect();
        self.set_batch(
            base,
            count,
            &SplatProps {
                scale: &scale,
                ..*batch
            },
        );
    }

    fn set_center(&mut self, base: usize, count: usize, center: &[f32]);
    fn set_opacity(&mut self, base: usize, count: usize, opacity: &[f32]);
    fn set_rgb(&mut self, base: usize, count: usize, rgb: &[f32]);
    /// Reads point-major RGB half bits, allowing packed receivers to copy them directly.
    fn set_rgb_f16(&mut self, base: usize, count: usize, rgb: &[u16]) {
        let values: Vec<f32> = rgb
            .iter()
            .map(|&bits| half::f16::from_bits(bits).to_f32())
            .collect();
        self.set_rgb(base, count, &values);
    }
    fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]);
    fn set_ln_scale(&mut self, base: usize, count: usize, ln_scale: &[f32]) {
        let scale: Vec<f32> = ln_scale.iter().map(|value| value.exp()).collect();
        self.set_scale(base, count, &scale);
    }
    /// Reads point-major log-scale half bits; zero linear scales use negative infinity.
    fn set_ln_scale_f16(&mut self, base: usize, count: usize, scales: &[u16]) {
        let values: Vec<f32> = scales
            .iter()
            .map(|&bits| half::f16::from_bits(bits).to_f32())
            .collect();
        self.set_ln_scale(base, count, &values);
    }
    fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]);

    /// Reads SPZ v3+ rotations without an intermediate float batch for packed receivers.
    /// Float receivers reuse the decoder-owned scratch buffer.
    fn set_quat_spz(&mut self, base: usize, count: usize, bytes: &[u8], scratch: &mut Vec<f32>) {
        scratch.clear();
        scratch.extend(
            bytes
                .chunks_exact(4)
                .flat_map(|bytes| decode_quat_spz(u32::from_le_bytes(bytes.try_into().unwrap()))),
        );
        self.set_quat(base, count, scratch);
    }

    fn set_quat_spz_legacy(
        &mut self,
        base: usize,
        count: usize,
        bytes: &[u8],
        scratch: &mut Vec<f32>,
    ) {
        scratch.clear();
        scratch.extend(
            bytes
                .chunks_exact(3)
                .flat_map(|bytes| decode_quat_spz_legacy(bytes.try_into().unwrap())),
        );
        self.set_quat(base, count, scratch);
    }

    /// Reads SOG rotation pixels, preserving float output for unpacked receivers.
    fn set_quat_sog<F: Fn(usize) -> [u8; 4]>(
        &mut self,
        base: usize,
        count: usize,
        code: F,
        scratch: &mut Vec<f32>,
    ) -> anyhow::Result<()> {
        scratch.clear();
        scratch.reserve_exact(count * 4);
        for i in 0..count {
            let quat = decode_quat_sog(code(i))
                .ok_or_else(|| anyhow::anyhow!("invalid quaternion tag at splat {}", base + i))?;
            let norm = quat.iter().map(|value| value * value).sum::<f32>().sqrt();
            scratch.extend(quat.map(|value| value / norm));
        }
        self.set_quat(base, count, scratch);
        Ok(())
    }

    /// Reads rotations on demand, allowing packed receivers to bound scratch storage.
    fn set_quat_from<F: Fn(usize) -> [f32; 4]>(
        &mut self,
        base: usize,
        count: usize,
        quat: F,
        scratch: &mut Vec<f32>,
    ) {
        scratch.clear();
        scratch.extend((0..count).flat_map(quat));
        self.set_quat(base, count, scratch);
    }

    /// Reads quantized components without requiring an intermediate float batch.
    /// `lookup` contains one shared table or one per component; `code` receives
    /// the splat and component indices. The default passes decoded floats on.
    fn set_quantized<F: Fn(usize, usize) -> u8>(
        &mut self,
        base: usize,
        count: usize,
        property: QuantizedProperty,
        lookup: &[ScalarLookup],
        code: F,
    ) where
        Self: Sized,
    {
        let dimensions = if matches!(property, QuantizedProperty::Opacity) {
            1
        } else {
            3
        };
        let mut values = Vec::with_capacity(count * dimensions);
        for i in 0..count {
            for d in 0..dimensions {
                values.push(lookup[d % lookup.len()].values[code(i, d) as usize]);
            }
        }
        match property {
            QuantizedProperty::Opacity => self.set_opacity(base, count, &values),
            QuantizedProperty::Rgb => self.set_rgb(base, count, &values),
            QuantizedProperty::LnScale => self.set_ln_scale(base, count, &values),
        }
    }

    fn set_sh(
        &mut self,
        base: usize,
        count: usize,
        sh1: &[f32],
        sh2: &[f32],
        sh3: &[f32],
        sh4: &[f32],
    ) {
    }
    fn set_sh1(&mut self, base: usize, count: usize, sh1: &[f32]) {}
    fn set_sh2(&mut self, base: usize, count: usize, sh2: &[f32]) {}
    fn set_sh3(&mut self, base: usize, count: usize, sh3: &[f32]) {}
    fn set_sh4(&mut self, base: usize, count: usize, sh4: &[f32]) {}

    /// Writes one SH band (1–4); `word` receives the splat and RGB coefficient indices.
    fn set_sh_packed<F: Fn(usize, usize) -> u32>(
        &mut self,
        base: usize,
        count: usize,
        band: usize,
        word: F,
    ) where
        Self: Sized,
    {
        let coefficients = [3, 5, 7, 9][band - 1];
        let mut values = Vec::with_capacity(count * coefficients * 3);
        for i in 0..count {
            for k in 0..coefficients {
                values.extend(decode_splat_sh_rgb(word(i, k)));
            }
        }
        match band {
            1 => self.set_sh1(base, count, &values),
            2 => self.set_sh2(base, count, &values),
            3 => self.set_sh3(base, count, &values),
            4 => self.set_sh4(base, count, &values),
            _ => unreachable!(),
        }
    }

    /// Expands a packed shared SH palette through the normal band setters.
    /// Encoded receivers can override this to copy palette words directly.
    fn set_sh_palette(
        &mut self,
        base: usize,
        count: usize,
        degree: usize,
        palette: &[u32],
        labels: &[u32],
    ) {
        let stride = [0, 4, 8, 16, 24][degree];
        let mut values = Vec::new();
        let mut offset = 0;
        for (band, coefficients) in [3, 5, 7, 9].into_iter().enumerate().take(degree) {
            values.resize(count * coefficients * 3, 0.0);
            for (i, &label) in labels.iter().take(count).enumerate() {
                for coefficient in 0..coefficients {
                    let word = palette[label as usize * stride + offset + coefficient];
                    let start = (i * coefficients + coefficient) * 3;
                    values[start..start + 3].copy_from_slice(&decode_splat_sh_rgb(word));
                }
            }
            match band {
                0 => self.set_sh1(base, count, &values),
                1 => self.set_sh2(base, count, &values),
                2 => self.set_sh3(base, count, &values),
                3 => self.set_sh4(base, count, &values),
                _ => unreachable!(),
            }
            offset += coefficients;
        }
    }

    /// Labels into a palette supplied earlier; called only when `SHARED_SH` is set.
    fn set_sh_labels(&mut self, base: usize, count: usize, degree: usize, labels: &[u32]) {
        unreachable!("SH labels without a palette require SHARED_SH");
    }
}

#[derive(Debug, Clone, Copy)]
pub enum SplatFileType {
    PLY,
    SPZ,
}

impl SplatFileType {
    pub fn to_enum_str(self) -> &'static str {
        match self {
            Self::PLY => "ply",
            Self::SPZ => "spz",
        }
    }

    pub fn from_enum_str(enum_str: &str) -> anyhow::Result<Self> {
        match enum_str {
            "ply" => Ok(Self::PLY),
            "spz" => Ok(Self::SPZ),
            _ => Err(anyhow::anyhow!("Invalid file type: {}", enum_str)),
        }
    }

    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.to_lowercase().as_str() {
            "ply" => Some(Self::PLY),
            "spz" => Some(Self::SPZ),
            _ => None,
        }
    }

    pub fn from_pathname(pathname: &str) -> Option<Self> {
        let clean_path = pathname.split_once('?').map_or(pathname, |(path, _)| path);
        let clean_path = clean_path
            .split_once('#')
            .map_or(clean_path, |(path, _)| path);
        clean_path
            .split('.')
            .next_back()
            .and_then(Self::from_extension)
    }
}

pub struct MultiDecoder<T: SplatReceiver> {
    pub file_type: Option<SplatFileType>,
    pub pathname: Option<String>,
    splats: Option<T>,
    buffer: Vec<u8>,
    inner: Option<Box<dyn ChunkReceiver>>,
    expected_input_size: Option<u64>,
}

impl<T: SplatReceiver> MultiDecoder<T> {
    pub fn new(splats: T, file_type: Option<SplatFileType>, pathname: Option<&str>) -> Self {
        let (splats, inner) = if let Some(file_type) = file_type {
            (None, Some(new_decoder(file_type, splats)))
        } else {
            (Some(splats), None)
        };
        Self {
            file_type,
            pathname: pathname.map(|s| s.to_string()),
            splats,
            buffer: Vec::new(),
            inner,
            expected_input_size: None,
        }
    }

    pub fn into_splats(self) -> T {
        match self.inner.unwrap().into_any().downcast::<PlyDecoder<T>>() {
            Ok(ply) => ply.into_splats(),
            Err(inner) => inner.downcast::<SpzDecoder<T>>().unwrap().into_splats(),
        }
    }

    fn init_file_type(&mut self, file_type: SplatFileType) -> anyhow::Result<()> {
        self.file_type = Some(file_type);
        let splats = self.splats.take().unwrap();
        let mut inner = new_decoder(file_type, splats);
        if let Some(size) = self.expected_input_size {
            inner.set_expected_input_size(size)?;
        }
        inner.push(&self.buffer)?;
        self.buffer.clear();
        self.inner = Some(inner);
        Ok(())
    }
}

const GZIP_MAGIC: u32 = 0x00088b1f; // Gzip deflate

impl<T: SplatReceiver> ChunkReceiver for MultiDecoder<T> {
    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }

    fn set_expected_input_size(&mut self, size: u64) -> anyhow::Result<()> {
        if let Some(inner) = self.inner.as_mut() {
            inner.set_expected_input_size(size)?;
        }
        self.expected_input_size = Some(size);
        Ok(())
    }

    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        if self.file_type.is_none() {
            self.buffer.extend_from_slice(bytes);
            if self.buffer.len() < 4 {
                return Ok(());
            }

            let magic = u32::from_le_bytes([
                self.buffer[0],
                self.buffer[1],
                self.buffer[2],
                self.buffer[3],
            ]);
            if (magic & 0x00ffffff) == PLY_MAGIC {
                return self.init_file_type(SplatFileType::PLY);
            }
            if magic == SPZ_MAGIC {
                // SPZ v4 starts directly with NGSP instead of a gzip wrapper.
                return self.init_file_type(SplatFileType::SPZ);
            }
            if (magic & 0x00ffffff) == GZIP_MAGIC {
                // Gzipped file, unpack beginning to check magic number
                let Some(prefix) = try_gunzip(&self.buffer, 4)? else {
                    return Ok(());
                };
                if prefix == SPZ_MAGIC.to_le_bytes() {
                    return self.init_file_type(SplatFileType::SPZ);
                }
            }

            if let Some(file_type) = self
                .pathname
                .as_deref()
                .and_then(SplatFileType::from_pathname)
            {
                return self.init_file_type(file_type);
            }
            Err(anyhow::anyhow!("Unknown file type"))
        } else {
            self.inner.as_mut().unwrap().push(bytes)
        }
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        if self.file_type.is_none() {
            return Err(anyhow::anyhow!("Unknown file type"));
        }
        self.inner.as_mut().unwrap().finish()
    }
}

fn new_decoder<T: SplatReceiver>(file_type: SplatFileType, splats: T) -> Box<dyn ChunkReceiver> {
    match file_type {
        SplatFileType::PLY => Box::new(PlyDecoder::new(splats)),
        SplatFileType::SPZ => Box::new(SpzDecoder::new(splats)),
    }
}

fn try_gunzip(buffer: &[u8], max_bytes: usize) -> anyhow::Result<Option<Vec<u8>>> {
    let mut buffer_gz = vec![0u8; max_bytes];
    let mut decompressor = Decompress::new_gzip(15);
    let status = decompressor
        .decompress(buffer, &mut buffer_gz, FlushDecompress::None)
        .map_err(|error| anyhow::anyhow!("Decompression failed: {}", error))?;
    let out_written = decompressor.total_out() as usize;
    if status != Status::StreamEnd && out_written < max_bytes {
        // Header or first bytes still incomplete: try again next time.
        return Ok(None);
    }
    buffer_gz.truncate(out_written);
    Ok(Some(buffer_gz))
}
