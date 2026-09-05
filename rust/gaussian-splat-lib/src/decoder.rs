use std::any::Any;

use miniz_oxide::inflate::{
    core::{
        decompress,
        inflate_flags::{TINFL_FLAG_HAS_MORE_INPUT, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF},
        DecompressorOxide,
    },
    TINFLStatus,
};

use crate::{
    ply::{PlyDecoder, PLY_MAGIC},
    spz::{SpzDecoder, SPZ_MAGIC},
};

pub trait ChunkReceiver: Any {
    /// Supplies the exact encoded input length when the caller knows it before
    /// decoding starts. Container decoders can use this to validate metadata
    /// before allocating output storage.
    fn set_expected_input_size(&mut self, _size: usize) -> anyhow::Result<()> {
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
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SplatProps<'a> {
    pub center: &'a [f32],
    pub opacity: &'a [f32],
    pub rgb: &'a [f32],
    pub scale: &'a [f32],
    pub quat: &'a [f32],
    pub sh1: &'a [f32],
    pub sh2: &'a [f32],
    pub sh3: &'a [f32],
}

#[allow(unused)]
pub trait SplatReceiver: 'static {
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        Ok(())
    }
    fn finish(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps);
    /// Accepts the same batch with scale supplied in natural-log space.
    /// Receivers that store log scale should override this to avoid exp/log
    /// conversion; the default preserves the public linear-scale contract.
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
    fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]);
    fn set_ln_scale(&mut self, base: usize, count: usize, ln_scale: &[f32]) {
        let scale: Vec<f32> = ln_scale.iter().map(|value| value.exp()).collect();
        self.set_scale(base, count, &scale);
    }
    fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]);

    fn set_sh(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32]) {}
    fn set_sh1(&mut self, base: usize, count: usize, sh1: &[f32]) {}
    fn set_sh2(&mut self, base: usize, count: usize, sh2: &[f32]) {}
    fn set_sh3(&mut self, base: usize, count: usize, sh3: &[f32]) {}
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
    buffer_gz: Option<Vec<u8>>,
    inner: Option<Box<dyn ChunkReceiver>>,
    expected_input_size: Option<usize>,
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
            buffer_gz: None,
            inner,
            expected_input_size: None,
        }
    }

    pub fn into_splats(self) -> T {
        let inner_any = self.inner.unwrap().into_any();
        let inner_any = match inner_any.downcast::<PlyDecoder<T>>() {
            Ok(ply) => {
                return ply.into_splats();
            }
            Err(inner_any) => inner_any,
        };
        let inner_any = match inner_any.downcast::<SpzDecoder<T>>() {
            Ok(spz) => {
                return spz.into_splats();
            }
            Err(inner_any) => inner_any,
        };
        let _ = inner_any;
        panic!("Invalid decoder type");
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
        self.buffer_gz = None;
        self.inner = Some(inner);
        Ok(())
    }
}

const GZIP_MAGIC: u32 = 0x00088b1f; // Gzip deflate

impl<T: SplatReceiver> ChunkReceiver for MultiDecoder<T> {
    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }

    fn set_expected_input_size(&mut self, size: usize) -> anyhow::Result<()> {
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

            let mut detection_complete = false;

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
                if self.buffer_gz.is_none() {
                    self.buffer_gz = try_gunzip(&self.buffer, 4)?;
                }
                if let Some(buffer_gz) = self.buffer_gz.as_ref() {
                    detection_complete = true;
                    if buffer_gz.len() >= 4 {
                        let magic = u32::from_le_bytes([
                            buffer_gz[0],
                            buffer_gz[1],
                            buffer_gz[2],
                            buffer_gz[3],
                        ]);
                        if magic == SPZ_MAGIC {
                            return self.init_file_type(SplatFileType::SPZ);
                        }
                    }
                }
            } else {
                detection_complete = true;
            }

            if detection_complete {
                if let Some(pathname) = &self.pathname {
                    if let Some(file_type) = SplatFileType::from_pathname(pathname) {
                        return self.init_file_type(file_type);
                    }
                    return Err(anyhow::anyhow!("Unknown file type"));
                }

                Err(anyhow::anyhow!("Unknown file type"))
            } else {
                Ok(())
            }
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
    let Some(end) = parse_gzip_header(buffer)? else {
        return Ok(None);
    };

    let mut buffer_gz = vec![0u8; max_bytes];
    let mut decompressor = DecompressorOxide::new();
    let (status, _in_consumed, out_written) = decompress(
        &mut decompressor,
        &buffer[end..],
        &mut buffer_gz,
        0,
        TINFL_FLAG_HAS_MORE_INPUT | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
    );
    match status {
        TINFLStatus::Failed => Ok(Some(Vec::new())),
        TINFLStatus::Done | TINFLStatus::HasMoreOutput => {
            buffer_gz.truncate(out_written);
            Ok(Some(buffer_gz))
        }
        TINFLStatus::NeedsMoreInput => {
            // Do nothing, try again next time
            Ok(None)
        }
        _ => Err(anyhow::anyhow!("Decompression failed: {:?}", status)),
    }
}

pub(crate) fn parse_gzip_header(buffer: &[u8]) -> anyhow::Result<Option<usize>> {
    if buffer.len() < 10 {
        return Ok(None);
    }
    if buffer[0] != 0x1f || buffer[1] != 0x8b || buffer[2] != 8 {
        return Err(anyhow::anyhow!("Invalid gzip header"));
    }

    let flags = buffer[3];
    if flags & 0xe0 != 0 {
        return Err(anyhow::anyhow!("Invalid gzip flags"));
    }
    let mut end = 10;

    if (flags & 0x04) != 0 {
        if buffer.len() < end + 2 {
            return Ok(None);
        }
        let extra_len = (buffer[end] as usize) | ((buffer[end + 1] as usize) << 8);
        end += 2;
        if buffer.len() < end + extra_len {
            return Ok(None);
        }
        end += extra_len;
    }

    for flag in [0x08, 0x10] {
        if flags & flag != 0 {
            let Some(null) = buffer[end..].iter().position(|byte| *byte == 0) else {
                return Ok(None);
            };
            end += null + 1;
        }
    }

    if (flags & 0x02) != 0 {
        if buffer.len() < end + 2 {
            return Ok(None);
        }
        let expected = u16::from_le_bytes([buffer[end], buffer[end + 1]]);
        if crc32fast::hash(&buffer[..end]) as u16 != expected {
            return Err(anyhow::anyhow!("Gzip header checksum mismatch"));
        }
        end += 2;
    }

    Ok(Some(end))
}
