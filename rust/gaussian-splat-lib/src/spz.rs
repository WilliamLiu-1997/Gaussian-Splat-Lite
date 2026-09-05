use miniz_oxide::inflate::core::inflate_flags::{
    TINFL_FLAG_HAS_MORE_INPUT, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
};
use miniz_oxide::inflate::core::{decompress, DecompressorOxide};
use miniz_oxide::inflate::TINFLStatus;
use std::io::Read;

use crate::decoder::{parse_gzip_header, ChunkReceiver, SplatInit, SplatReceiver};
use crate::splat_encode::get_splat_tex_size_u64;

pub const SPZ_MAGIC: u32 = 0x5053474e; // "NGSP"
const SH_C0: f32 = 0.28209479177387814;
const MAX_SPLAT_CHUNK: usize = 65536;
const NGSP_HEADER_SIZE: usize = 32;
const TOC_ENTRY_SIZE: usize = 16;
const MAX_ZSTD_WINDOW_SIZE: u64 = 100 * 1024 * 1024;
const MAX_PACKED_MODEL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
// ZSTD blocks contain at most 128 KiB of compressed payload. This buffer can
// hold a complete block and checksum; frame headers are smaller than that.
const MAX_ZSTD_BLOCK_SIZE: usize = 128 * 1024;
const MAX_ZSTD_FRAME_HEADER_SIZE: usize = 18;
const ZSTD_BLOCK_HEADER_SIZE: usize = 3;
const ZSTD_CHECKSUM_SIZE: usize = 4;
const MAX_V4_COMPRESSED_BUFFER_SIZE: usize =
    MAX_ZSTD_BLOCK_SIZE + ZSTD_BLOCK_HEADER_SIZE + ZSTD_CHECKSUM_SIZE;

// Header flag bits (byte 14 of the SPZ header).
const FLAG_HAS_EXTENSIONS: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpzDecoderStage {
    Centers,
    Alphas,
    Rgb,
    Scales,
    Quats,
    Sh,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpzFormat {
    Unknown,
    Gzip,
    Ngsp,
}

struct V4HeaderInfo {
    version: u32,
    num_splats: usize,
    sh_degree: usize,
    fractional_bits: u8,
    num_streams: usize,
    toc_byte_offset: usize,
    toc_end: usize,
}

enum V4Stage {
    NeedHeader,
    SkipExtensions {
        header: V4HeaderInfo,
        remaining: usize,
    },
    NeedToc(V4HeaderInfo),
    NeedStream {
        streams: Vec<V4StreamInfo>,
        next_stream: usize,
        decoder: Box<V4StreamDecoder>,
    },
    Done,
}

#[derive(Debug, Clone, Copy)]
struct V4StreamInfo {
    compressed_size: usize,
    uncompressed_size: usize,
}

#[derive(Default)]
struct V4StreamDecoder {
    decoder: ruzstd::FrameDecoder,
    compressed_received: usize,
    decoded_size: usize,
    header_validated: bool,
    has_checksum: bool,
}

pub struct SpzDecoder<T: SplatReceiver> {
    splats: T,
    format: SpzFormat,
    decompressor: DecompressorOxide,
    compressed: Vec<u8>,
    decompressed: Vec<u8>,
    gzip_header_done: bool,
    gzip_deflate_done: bool,
    gzip_crc: crc32fast::Hasher,
    gzip_size: u32,
    out_pos: usize,
    raw: Vec<u8>,
    v4_stage: V4Stage,
    expected_input_size: Option<usize>,
    buffer: Vec<u8>,
    buffer_offset: usize,
    state: Option<SpzDecoderState>,
    done: bool,
    #[cfg(test)]
    v4_peak_compressed_buffer_size: usize,
}

impl<T: SplatReceiver> SpzDecoder<T> {
    pub fn new(splats: T) -> Self {
        Self {
            splats,
            format: SpzFormat::Unknown,
            decompressor: DecompressorOxide::new(),
            compressed: Vec::new(),
            decompressed: Vec::new(),
            buffer: Vec::new(),
            state: None,
            gzip_header_done: false,
            gzip_deflate_done: false,
            gzip_crc: crc32fast::Hasher::new(),
            gzip_size: 0,
            out_pos: 0,
            done: false,
            raw: Vec::new(),
            v4_stage: V4Stage::NeedHeader,
            expected_input_size: None,
            buffer_offset: 0,
            #[cfg(test)]
            v4_peak_compressed_buffer_size: 0,
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
            self.poll_sections();
        }
        Ok(())
    }

    fn poll_header(&mut self) -> anyhow::Result<()> {
        let buffer = &self.buffer[self.buffer_offset..];
        if buffer.len() < 16 {
            return Ok(());
        }

        let header = parse_common_header(buffer)?;
        if !(1..=3).contains(&header.version) {
            return Err(anyhow::anyhow!(
                "Unsupported legacy SPZ version: {}",
                header.version
            ));
        }
        self.buffer_offset += 16;
        self.init_state(
            header.version,
            header.num_splats,
            header.sh_degree,
            header.fractional_bits,
        )
    }

    fn init_state(
        &mut self,
        version: u32,
        num_splats: usize,
        sh_degree: usize,
        fractional_bits: u8,
    ) -> anyhow::Result<()> {
        if num_splats == 0 {
            return Err(anyhow::anyhow!("SPZ point count must be greater than zero"));
        }
        validate_splat_parameters(sh_degree, fractional_bits)?;

        validate_packed_model_size(num_splats, sh_degree)?;

        self.state = Some(SpzDecoderState::new(
            version,
            num_splats,
            sh_degree,
            fractional_bits,
        ));

        self.splats.init_splats(&SplatInit {
            num_splats,
            max_sh_degree: sh_degree,
        })?;

        Ok(())
    }

    fn try_decode_v4(&mut self) -> anyhow::Result<()> {
        loop {
            let stage = std::mem::replace(&mut self.v4_stage, V4Stage::Done);
            match stage {
                V4Stage::Done => return Ok(()),
                V4Stage::NeedHeader => {
                    if self.raw.len() < NGSP_HEADER_SIZE {
                        self.v4_stage = V4Stage::NeedHeader;
                        return Ok(());
                    }
                    let header = parse_v4_header(&self.raw)?;
                    let extension_size = header.toc_byte_offset - NGSP_HEADER_SIZE;
                    if let Some(expected_size) = self.expected_input_size {
                        if header.toc_end > expected_size {
                            return Err(anyhow::anyhow!(
                                "v4 TOC end {} exceeds expected input size {}",
                                header.toc_end,
                                expected_size
                            ));
                        }
                    }

                    self.raw.clear();
                    self.v4_stage = if extension_size == 0 {
                        V4Stage::NeedToc(header)
                    } else {
                        V4Stage::SkipExtensions {
                            header,
                            remaining: extension_size,
                        }
                    };
                }
                V4Stage::SkipExtensions { header, remaining } => {
                    if remaining > 0 {
                        self.v4_stage = V4Stage::SkipExtensions { header, remaining };
                        return Ok(());
                    }
                    self.v4_stage = V4Stage::NeedToc(header);
                }
                V4Stage::NeedToc(header) => {
                    let toc_size = header.toc_end - header.toc_byte_offset;
                    if self.raw.len() < toc_size {
                        self.v4_stage = V4Stage::NeedToc(header);
                        return Ok(());
                    }
                    let (streams, total_size) = walk_v4_toc(&self.raw, &header)?;
                    if let Some(expected_size) = self.expected_input_size {
                        if total_size != expected_size {
                            return Err(anyhow::anyhow!(
                                "v4 TOC size mismatch: expected input size {}, got {}",
                                expected_size,
                                total_size
                            ));
                        }
                    }
                    self.init_state(
                        header.version,
                        header.num_splats,
                        header.sh_degree,
                        header.fractional_bits,
                    )?;
                    self.raw = Vec::with_capacity(MAX_V4_COMPRESSED_BUFFER_SIZE);
                    self.v4_stage = V4Stage::NeedStream {
                        streams,
                        next_stream: 0,
                        decoder: Box::default(),
                    };
                }
                V4Stage::NeedStream {
                    streams,
                    next_stream,
                    mut decoder,
                } => {
                    let stream = streams[next_stream];
                    if !self.decode_v4_stream(stream, next_stream, decoder.as_mut())? {
                        self.v4_stage = V4Stage::NeedStream {
                            streams,
                            next_stream,
                            decoder,
                        };
                        return Ok(());
                    }

                    let next_stream = next_stream + 1;
                    if next_stream == streams.len() {
                        self.v4_stage = V4Stage::Done;
                        self.done = true;
                    } else {
                        // init() resets ruzstd while retaining its working buffers.
                        decoder.compressed_received = 0;
                        decoder.decoded_size = 0;
                        decoder.header_validated = false;
                        self.v4_stage = V4Stage::NeedStream {
                            streams,
                            next_stream,
                            decoder,
                        };
                    }
                }
            }
        }
    }

    fn v4_input_needed(&self) -> usize {
        match &self.v4_stage {
            V4Stage::NeedHeader => NGSP_HEADER_SIZE.saturating_sub(self.raw.len()),
            V4Stage::SkipExtensions { remaining, .. } => *remaining,
            V4Stage::NeedToc(header) => {
                (header.toc_end - header.toc_byte_offset).saturating_sub(self.raw.len())
            }
            V4Stage::NeedStream {
                streams,
                next_stream,
                decoder,
            } => streams[*next_stream]
                .compressed_size
                .saturating_sub(decoder.compressed_received)
                .min(MAX_V4_COMPRESSED_BUFFER_SIZE.saturating_sub(self.raw.len())),
            V4Stage::Done => 0,
        }
    }

    fn push_v4(&mut self, mut bytes: &[u8]) -> anyhow::Result<()> {
        loop {
            self.try_decode_v4()?;
            if bytes.is_empty() {
                return Ok(());
            }
            if matches!(self.v4_stage, V4Stage::Done) {
                return Err(anyhow::anyhow!(
                    "v4 compressed data size mismatch: trailing data"
                ));
            }

            let needed = self.v4_input_needed();
            if needed == 0 {
                return Err(anyhow::anyhow!("v4 decoder made no progress"));
            }
            let take = needed.min(bytes.len());
            if let V4Stage::SkipExtensions { remaining, .. } = &mut self.v4_stage {
                *remaining -= take;
            } else {
                self.raw.extend_from_slice(&bytes[..take]);
                if let V4Stage::NeedStream { decoder, .. } = &mut self.v4_stage {
                    decoder.compressed_received += take;
                    #[cfg(test)]
                    {
                        self.v4_peak_compressed_buffer_size =
                            self.v4_peak_compressed_buffer_size.max(self.raw.len());
                    }
                }
            }
            bytes = &bytes[take..];
        }
    }

    fn decode_v4_stream(
        &mut self,
        stream: V4StreamInfo,
        stream_index: usize,
        stream_decoder: &mut V4StreamDecoder,
    ) -> anyhow::Result<bool> {
        let num_splats = self.state.as_ref().unwrap().num_splats;
        // walk_v4_toc already validated count × record width.
        let bytes_per_item = stream.uncompressed_size / num_splats;
        let max_chunk_size = MAX_SPLAT_CHUNK * bytes_per_item;
        let input_complete = stream_decoder.compressed_received == stream.compressed_size;

        if !stream_decoder.header_validated {
            if self.raw.len() < MAX_ZSTD_FRAME_HEADER_SIZE && !input_complete {
                return Ok(false);
            }
            let (has_checksum, header_size) =
                validate_zstd_frame(&self.raw, stream.uncompressed_size)?;
            stream_decoder.has_checksum = has_checksum;
            let mut header = &self.raw[..header_size];
            stream_decoder
                .decoder
                .init(&mut header)
                .map_err(|error| anyhow::anyhow!("v4 ZSTD init failed: {}", error))?;
            self.raw.drain(..header_size);
            stream_decoder.header_validated = true;
        }

        loop {
            let mut made_progress = false;

            if self.buffer_offset > 0 {
                self.compact_buffer();
            }

            while stream_decoder.decoder.can_collect() > 0 {
                let output_remaining = stream
                    .uncompressed_size
                    .saturating_sub(stream_decoder.decoded_size);
                let output_limit = output_remaining.saturating_add(1);
                let chunk_space = max_chunk_size.saturating_sub(self.buffer.len());
                let read_size = stream_decoder
                    .decoder
                    .can_collect()
                    .min(output_limit)
                    .min(chunk_space);
                if read_size == 0 {
                    break;
                }

                let output_start = self.buffer.len();
                self.buffer.resize(output_start + read_size, 0);
                let written = stream_decoder
                    .decoder
                    .read(&mut self.buffer[output_start..])
                    .map_err(|error| anyhow::anyhow!("v4 ZSTD decompress failed: {}", error))?;
                self.buffer.truncate(output_start + written);
                if written == 0 {
                    break;
                }
                made_progress = true;
                stream_decoder.decoded_size += written;
                if stream_decoder.decoded_size > stream.uncompressed_size {
                    return Err(anyhow::anyhow!(
                        "v4 ZSTD size mismatch: expected {}, got at least {}",
                        stream.uncompressed_size,
                        stream_decoder.decoded_size
                    ));
                }

                if self.buffer.len() == max_chunk_size {
                    self.consume_v4_output_chunk();
                }
            }

            if stream_decoder.decoder.is_finished() {
                let consumed = stream_decoder.decoder.bytes_read_from_source() as usize;
                if consumed < stream.compressed_size {
                    return Err(anyhow::anyhow!(
                        "trailing bytes in v4 ZSTD stream: {}",
                        stream.compressed_size - consumed
                    ));
                }
                if stream_decoder.decoder.can_collect() == 0 {
                    if stream_decoder.decoded_size != stream.uncompressed_size {
                        return Err(anyhow::anyhow!(
                            "v4 ZSTD size mismatch: expected {}, got {}",
                            stream.uncompressed_size,
                            stream_decoder.decoded_size
                        ));
                    }
                    if stream_decoder.has_checksum
                        && stream_decoder.decoder.get_checksum_from_data()
                            != stream_decoder.decoder.get_calculated_checksum()
                    {
                        return Err(anyhow::anyhow!("v4 ZSTD checksum mismatch"));
                    }
                    if !self.buffer.is_empty() {
                        self.consume_v4_output_chunk();
                    }
                    return Ok(true);
                }
            }

            if !stream_decoder.decoder.is_finished() {
                if let Some(block_size) =
                    next_zstd_block_input(&self.raw, stream_decoder.has_checksum)?
                {
                    // Restrict the slice to exactly one block (plus the final
                    // checksum, when present) so ruzstd cannot accumulate the
                    // output of many small/RLE blocks before we drain it.
                    let (consumed, _) = stream_decoder
                        .decoder
                        .decode_from_to(&self.raw[..block_size], &mut [])
                        .map_err(|error| anyhow::anyhow!("v4 ZSTD decompress failed: {}", error))?;
                    debug_assert_eq!(consumed, block_size);
                    self.raw.drain(..consumed);
                    made_progress |= consumed > 0;
                }
            }

            if !made_progress {
                if input_complete {
                    return Err(anyhow::anyhow!(
                        "v4 ZSTD stream {} ended before its frame was complete",
                        stream_index
                    ));
                }
                if self.raw.len() >= MAX_V4_COMPRESSED_BUFFER_SIZE {
                    return Err(anyhow::anyhow!(
                        "v4 ZSTD stream {} made no progress with {} buffered bytes",
                        stream_index,
                        self.raw.len()
                    ));
                }
                return Ok(false);
            }
        }
    }

    fn consume_v4_output_chunk(&mut self) {
        self.buffer_offset = 0;
        self.poll_sections();
        debug_assert_eq!(self.buffer_offset, self.buffer.len());
        self.buffer.clear();
        self.buffer_offset = 0;
    }

    fn compact_buffer(&mut self) {
        if self.buffer_offset == 0 {
            return;
        }
        let remaining = self.buffer.len() - self.buffer_offset;
        self.buffer.copy_within(self.buffer_offset.., 0);
        self.buffer.truncate(remaining);
        self.buffer_offset = 0;
    }

    fn poll_sections(&mut self) {
        let state = self.state.as_mut().unwrap();
        loop {
            use SpzDecoderStage::*;
            let sh_components = 3 * state.sh_degree * (state.sh_degree + 2);
            let (bytes_per_item, components, next_stage) = match state.stage {
                Centers => (if state.version == 1 { 6 } else { 9 }, 3, Alphas),
                Alphas => (1, 1, Rgb),
                Rgb => (3, 3, Scales),
                Scales => (3, 3, Quats),
                Quats => (if state.version >= 3 { 4 } else { 3 }, 4, Sh),
                Sh if state.sh_degree > 0 => (sh_components, sh_components, Done),
                Sh | Done => {
                    state.stage = Done;
                    return;
                }
            };
            let input = &self.buffer[self.buffer_offset..];
            let Some(chunk) = state.chunk_size(input.len(), bytes_per_item) else {
                return;
            };
            let input = &input[..chunk * bytes_per_item];
            state.output.resize(chunk * components, 0.0);
            let output = &mut state.output;
            let base = state.next_splat;

            match state.stage {
                Centers => {
                    if state.version == 1 {
                        for (out, bytes) in output.iter_mut().zip(input.chunks_exact(2)) {
                            *out = read_f16_le(bytes);
                        }
                    } else {
                        let frac = (1_u32 << state.fractional_bits) as f32;
                        for (out, bytes) in output.iter_mut().zip(input.chunks_exact(3)) {
                            *out = read_i24_le(bytes) as f32 / frac;
                        }
                    }
                    self.splats.set_center(base, chunk, output);
                }
                Alphas | Rgb | Scales => {
                    for (out, byte) in output.iter_mut().zip(input) {
                        *out = match state.stage {
                            Alphas => *byte as f32 / 255.0,
                            Rgb => (*byte as f32 / 255.0 - 0.5) * (SH_C0 / 0.15) + 0.5,
                            Scales => *byte as f32 / 16.0 - 10.0,
                            _ => unreachable!(),
                        };
                    }
                    match state.stage {
                        Alphas => self.splats.set_opacity(base, chunk, output),
                        Rgb => self.splats.set_rgb(base, chunk, output),
                        Scales => self.splats.set_ln_scale(base, chunk, output),
                        _ => unreachable!(),
                    }
                }
                Quats => {
                    for (out, bytes) in output
                        .chunks_exact_mut(4)
                        .zip(input.chunks_exact(bytes_per_item))
                    {
                        if state.version >= 3 {
                            let mut packed = read_u32_le(bytes);
                            let largest = (packed >> 30) as usize;
                            let mut sum_squares = 0.0;
                            for j in (0..4).rev() {
                                if j == largest {
                                    continue;
                                }
                                let magnitude = std::f32::consts::FRAC_1_SQRT_2
                                    * ((packed & 511) as f32 / 511.0);
                                out[j] = if packed & 512 != 0 {
                                    -magnitude
                                } else {
                                    magnitude
                                };
                                sum_squares += out[j] * out[j];
                                packed >>= 10;
                            }
                            out[largest] = (1.0 - sum_squares).max(0.0).sqrt();
                        } else {
                            for j in 0..3 {
                                out[j] = bytes[j] as f32 / 127.5 - 1.0;
                            }
                            out[3] = (1.0 - (out[0] * out[0] + out[1] * out[1] + out[2] * out[2]))
                                .max(0.0)
                                .sqrt();
                        }
                    }
                    self.splats.set_quat(base, chunk, output);
                }
                Sh => {
                    // Input is point-major; receivers take a separate slice per SH band.
                    let mut band_offset = 0;
                    for width in [9, 15, 21].into_iter().take(state.sh_degree) {
                        for (i, point) in input.chunks_exact(sh_components).enumerate() {
                            let start = band_offset * chunk + i * width;
                            for (out, byte) in output[start..start + width]
                                .iter_mut()
                                .zip(&point[band_offset..band_offset + width])
                            {
                                *out = (*byte as f32 - 128.0) / 128.0;
                            }
                        }
                        band_offset += width;
                    }
                    self.splats.set_sh(
                        base,
                        chunk,
                        &output[..9 * chunk],
                        if state.sh_degree >= 2 {
                            &output[9 * chunk..24 * chunk]
                        } else {
                            &[]
                        },
                        if state.sh_degree >= 3 {
                            &output[24 * chunk..]
                        } else {
                            &[]
                        },
                    );
                }
                Done => unreachable!(),
            }

            self.buffer_offset += chunk * bytes_per_item;
            state.next_splat += chunk;
            if state.next_splat == state.num_splats {
                state.next_splat = 0;
                state.stage = next_stage;
            }
        }
    }

    fn poll_decompress(&mut self) -> anyhow::Result<()> {
        if self.done {
            return if self.compressed.is_empty() {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Trailing data after gzip stream"))
            };
        }
        if !self.gzip_header_done {
            let Some(header_size) = parse_gzip_header(&self.compressed)? else {
                return Ok(());
            };
            self.compressed.drain(..header_size);
            self.gzip_header_done = true;
        }
        let mut in_offset = 0;
        let flags: u32 = TINFL_FLAG_HAS_MORE_INPUT | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
        while !self.gzip_deflate_done && in_offset < self.compressed.len() {
            // Ensure at least 64 KiB free space; keep last 32 KiB history at buffer start
            const WINDOW: usize = 32 * 1024;
            let free = self.decompressed.len().saturating_sub(self.out_pos);
            if free < 64 * 1024 {
                let keep_start = self.out_pos.saturating_sub(WINDOW);
                let keep_len = self.out_pos - keep_start;
                // Move last WINDOW bytes to beginning
                if keep_len > 0 {
                    // Use copy_within handles overlap
                    self.decompressed.copy_within(keep_start..self.out_pos, 0);
                }
                self.out_pos = keep_len;
            }

            let (status, in_consumed, out_written) = decompress(
                &mut self.decompressor,
                &self.compressed[in_offset..],
                &mut self.decompressed,
                self.out_pos,
                flags,
            );

            if out_written > 0 {
                self.gzip_crc
                    .update(&self.decompressed[self.out_pos..self.out_pos + out_written]);
                self.gzip_size = self.gzip_size.wrapping_add(out_written as u32);
                self.compact_buffer();
                self.buffer.extend_from_slice(
                    &self.decompressed[self.out_pos..self.out_pos + out_written],
                );
                self.out_pos += out_written;
                self.poll()?;
            }

            in_offset += in_consumed;
            match status {
                TINFLStatus::Done => {
                    self.gzip_deflate_done = true;
                    break;
                }
                TINFLStatus::NeedsMoreInput => {
                    if in_consumed == 0 && out_written == 0 {
                        break;
                    }
                }
                TINFLStatus::HasMoreOutput => {
                    // Continue with same input, will loop again; ensure space on next iteration
                    continue;
                }
                _ => return Err(anyhow::anyhow!("Decompression failed: {:?}", status)),
            }
        }
        if in_offset > 0 {
            self.compressed.drain(..in_offset);
        }
        if self.gzip_deflate_done && self.compressed.len() >= 8 {
            if self.compressed.len() != 8 {
                return Err(anyhow::anyhow!("Trailing data after gzip stream"));
            }
            if read_u32_le(&self.compressed[..4]) != self.gzip_crc.clone().finalize()
                || read_u32_le(&self.compressed[4..8]) != self.gzip_size
            {
                return Err(anyhow::anyhow!("Gzip checksum or size mismatch"));
            }
            self.compressed.clear();
            self.done = true;
        }
        Ok(())
    }
}

struct CommonHeaderFields {
    version: u32,
    num_splats: usize,
    sh_degree: usize,
    fractional_bits: u8,
    flags: u8,
}

fn parse_common_header(buffer: &[u8]) -> anyhow::Result<CommonHeaderFields> {
    debug_assert!(buffer.len() >= 15);
    let magic = read_u32_le(&buffer[0..4]);
    if magic != SPZ_MAGIC {
        return Err(anyhow::anyhow!("Invalid SPZ magic: 0x{:08x}", magic));
    }

    Ok(CommonHeaderFields {
        version: read_u32_le(&buffer[4..8]),
        num_splats: read_u32_le(&buffer[8..12]) as usize,
        sh_degree: buffer[12] as usize,
        fractional_bits: buffer[13],
        flags: buffer[14],
    })
}

fn parse_v4_header(raw: &[u8]) -> anyhow::Result<V4HeaderInfo> {
    debug_assert!(raw.len() >= NGSP_HEADER_SIZE);
    let header = parse_common_header(raw)?;
    if header.version != 4 {
        return Err(anyhow::anyhow!(
            "Unsupported NGSP version: {}",
            header.version
        ));
    }

    if header.flags & FLAG_HAS_EXTENSIONS != 0 {
        eprintln!(
            "[SPZ WARNING] parse_v4_header: extensions were skipped at load time; \
             unpacked data may be incorrect due to unknown packing behavior"
        );
    }

    let num_streams = raw[15] as usize;
    let toc_byte_offset = read_u32_le(&raw[16..20]) as usize;
    if toc_byte_offset < NGSP_HEADER_SIZE {
        return Err(anyhow::anyhow!(
            "Invalid v4 tocByteOffset: {} < {}",
            toc_byte_offset,
            NGSP_HEADER_SIZE
        ));
    }

    let toc_size = num_streams * TOC_ENTRY_SIZE;
    let toc_end = toc_byte_offset
        .checked_add(toc_size)
        .ok_or_else(|| anyhow::anyhow!("v4 TOC end overflow"))?;

    Ok(V4HeaderInfo {
        version: header.version,
        num_splats: header.num_splats,
        sh_degree: header.sh_degree,
        fractional_bits: header.fractional_bits,
        num_streams,
        toc_byte_offset,
        toc_end,
    })
}

fn walk_v4_toc(raw: &[u8], header: &V4HeaderInfo) -> anyhow::Result<(Vec<V4StreamInfo>, usize)> {
    debug_assert!(raw.len() >= header.toc_end - header.toc_byte_offset);
    let expected_sizes = expected_v4_stream_sizes(header)?;
    if header.num_streams != expected_sizes.len() {
        return Err(anyhow::anyhow!(
            "v4 stream count mismatch: expected {}, got {}",
            expected_sizes.len(),
            header.num_streams
        ));
    }

    let mut streams = Vec::with_capacity(header.num_streams);
    let mut data_cursor = header.toc_end;

    for (index, expected_size) in expected_sizes.into_iter().enumerate() {
        let entry = index * TOC_ENTRY_SIZE;
        let compressed_size = usize::try_from(read_u64_le(&raw[entry..entry + 8]))
            .map_err(|_| anyhow::anyhow!("v4 stream too large"))?;
        let uncompressed_size = usize::try_from(read_u64_le(&raw[entry + 8..entry + 16]))
            .map_err(|_| anyhow::anyhow!("v4 uncompressed stream too large"))?;
        if uncompressed_size != expected_size {
            return Err(anyhow::anyhow!(
                "v4 uncompressed stream size mismatch at index {}: expected {}, got {}",
                index,
                expected_size,
                uncompressed_size
            ));
        }

        streams.push(V4StreamInfo {
            compressed_size,
            uncompressed_size,
        });
        data_cursor = data_cursor
            .checked_add(compressed_size)
            .ok_or_else(|| anyhow::anyhow!("v4 stream offset overflow"))?;
    }

    Ok((streams, data_cursor))
}

fn expected_v4_stream_sizes(header: &V4HeaderInfo) -> anyhow::Result<Vec<usize>> {
    let checked_size = |components: usize| {
        header
            .num_splats
            .checked_mul(components)
            .ok_or_else(|| anyhow::anyhow!("v4 attribute size overflow"))
    };
    let mut sizes = vec![
        checked_size(9)?,
        checked_size(1)?,
        checked_size(3)?,
        checked_size(3)?,
        checked_size(4)?,
    ];
    let sh_components = match header.sh_degree {
        1 => Some(9),
        2 => Some(24),
        3 => Some(45),
        _ => None,
    };
    if let Some(sh_components) = sh_components {
        sizes.push(checked_size(sh_components)?);
    }
    Ok(sizes)
}

fn packed_model_size_bytes(num_splats: usize, sh_degree: usize) -> u64 {
    let (_, _, _, max_splats) = get_splat_tex_size_u64(num_splats as u64);
    let texture_count = match sh_degree {
        0 => 2_u64,
        1 => 3,
        2 => 4,
        3 => 6,
        _ => unreachable!(),
    };

    // Each packed texture stores four u32 values per padded splat.
    max_splats * texture_count * 16
}

fn validate_packed_model_size(num_splats: usize, sh_degree: usize) -> anyhow::Result<()> {
    let packed_bytes = packed_model_size_bytes(num_splats, sh_degree);
    if packed_bytes > MAX_PACKED_MODEL_BYTES {
        return Err(anyhow::anyhow!(
            "SPZ packed model requires {} bytes, exceeding the {} byte limit",
            packed_bytes,
            MAX_PACKED_MODEL_BYTES
        ));
    }
    Ok(())
}

fn validate_zstd_frame(compressed: &[u8], expected_size: usize) -> anyhow::Result<(bool, usize)> {
    let (frame, header_size) = ruzstd::frame::read_frame_header(compressed)
        .map_err(|error| anyhow::anyhow!("v4 ZSTD header failed: {}", error))?;
    let content_size = frame.header.frame_content_size();
    if content_size != 0 && content_size != expected_size as u64 {
        return Err(anyhow::anyhow!(
            "v4 ZSTD frame content size differs from TOC"
        ));
    }
    let window_size = frame
        .header
        .window_size()
        .map_err(|error| anyhow::anyhow!("v4 ZSTD window failed: {}", error))?;
    if window_size > MAX_ZSTD_WINDOW_SIZE {
        return Err(anyhow::anyhow!(
            "v4 ZSTD window too large: {} bytes",
            window_size
        ));
    }
    Ok((
        frame.header.descriptor.content_checksum_flag(),
        header_size as usize,
    ))
}

fn next_zstd_block_input(input: &[u8], has_checksum: bool) -> anyhow::Result<Option<usize>> {
    if input.len() < ZSTD_BLOCK_HEADER_SIZE {
        return Ok(None);
    }

    let header = (input[0] as u32) | ((input[1] as u32) << 8) | ((input[2] as u32) << 16);
    let last_block = header & 1 != 0;
    let block_type = (header >> 1) & 0x3;
    let block_size = ((header >> 3) & 0x1f_ffff) as usize;
    if block_size > MAX_ZSTD_BLOCK_SIZE {
        return Err(anyhow::anyhow!(
            "v4 ZSTD block too large: {} bytes",
            block_size
        ));
    }

    let body_size = match block_type {
        0 | 2 => block_size,
        1 => 1,
        _ => return Err(anyhow::anyhow!("v4 ZSTD reserved block type")),
    };
    let checksum_size = usize::from(last_block && has_checksum) * ZSTD_CHECKSUM_SIZE;
    let size = ZSTD_BLOCK_HEADER_SIZE + body_size + checksum_size;
    if input.len() < size {
        return Ok(None);
    }
    Ok(Some(size))
}

fn validate_splat_parameters(sh_degree: usize, fractional_bits: u8) -> anyhow::Result<()> {
    if sh_degree > 3 {
        return Err(anyhow::anyhow!(
            "SPZ SH degree {} is not supported by Gaussian Splat Lite (handles 0-3)",
            sh_degree
        ));
    }
    if fractional_bits >= 32 {
        return Err(anyhow::anyhow!(
            "Unsupported SPZ fractional bits: {}",
            fractional_bits
        ));
    }
    Ok(())
}

impl<T: SplatReceiver> ChunkReceiver for SpzDecoder<T> {
    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any> {
        self
    }

    fn set_expected_input_size(&mut self, size: usize) -> anyhow::Result<()> {
        self.expected_input_size = Some(size);
        Ok(())
    }

    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        let mut bytes = bytes;
        if self.format == SpzFormat::Unknown {
            let take = (4 - self.raw.len()).min(bytes.len());
            self.raw.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.raw.len() < 4 {
                return Ok(());
            }

            let magic = read_u32_le(&self.raw[0..4]);
            if magic == SPZ_MAGIC {
                self.format = SpzFormat::Ngsp;
            } else if (magic & 0x00ffffff) == 0x00088b1f {
                self.format = SpzFormat::Gzip;
                self.compressed = std::mem::take(&mut self.raw);
                self.decompressed.resize(128 * 1024, 0);
            } else {
                return Err(anyhow::anyhow!(
                    "Unrecognized SPZ format: leading bytes 0x{:08x}",
                    magic
                ));
            }
        }

        match self.format {
            SpzFormat::Gzip => {
                self.compressed.extend_from_slice(bytes);
                self.poll_decompress()
            }
            SpzFormat::Ngsp => self.push_v4(bytes),
            SpzFormat::Unknown => unreachable!(),
        }
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        match self.format {
            SpzFormat::Gzip => {
                self.poll_decompress()?;
                if !self.done {
                    return Err(anyhow::anyhow!("Truncated gzip stream"));
                }
            }
            SpzFormat::Ngsp => {
                if !self.done {
                    return Err(anyhow::anyhow!("Truncated SPZ v4 stream"));
                }
            }
            SpzFormat::Unknown => {
                return Err(anyhow::anyhow!("Empty SPZ stream"));
            }
        }

        if let Some(state) = &self.state {
            if state.stage != SpzDecoderStage::Done {
                return Err(anyhow::anyhow!(
                    "Incomplete SPZ stream: stage = {:?}, sh_degree = {}",
                    state.stage,
                    state.sh_degree
                ));
            }
        } else {
            return Err(anyhow::anyhow!("Invalid SPZ stream"));
        }
        self.splats.finish()?;
        Ok(())
    }
}

struct SpzDecoderState {
    version: u32,
    num_splats: usize,
    sh_degree: usize,
    fractional_bits: u8,
    next_splat: usize,
    stage: SpzDecoderStage,
    output: Vec<f32>,
}

impl SpzDecoderState {
    fn new(version: u32, num_splats: usize, sh_degree: usize, fractional_bits: u8) -> Self {
        Self {
            version,
            num_splats,
            sh_degree,
            fractional_bits,
            next_splat: 0,
            stage: SpzDecoderStage::Centers,
            output: Vec::with_capacity(MAX_SPLAT_CHUNK * 4),
        }
    }

    fn chunk_size(&self, input_len: usize, bytes_per_item: usize) -> Option<usize> {
        let available = input_len / bytes_per_item;
        let remaining = self.num_splats - self.next_splat;
        if available < remaining && available < MAX_SPLAT_CHUNK {
            None
        } else {
            Some(remaining.min(available).min(MAX_SPLAT_CHUNK))
        }
    }
}

#[inline]
fn read_u32_le(buf: &[u8]) -> u32 {
    u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]])
}

#[inline]
fn read_u64_le(buf: &[u8]) -> u64 {
    u64::from_le_bytes([
        buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
    ])
}

#[inline]
fn read_f16_le(two: &[u8]) -> f32 {
    let bits = u16::from_le_bytes([two[0], two[1]]);
    half::f16::from_bits(bits).to_f32()
}

#[inline]
fn read_i24_le(three: &[u8]) -> i32 {
    let v = (three[2] as u32) << 16 | (three[1] as u32) << 8 | (three[0] as u32);
    if (v & 0x0080_0000) != 0 {
        (v | 0xFF00_0000) as i32
    } else {
        v as i32
    }
}

#[cfg(test)]
mod tests {
    use miniz_oxide::deflate::compress_to_vec;

    use super::*;
    use crate::decoder::{MultiDecoder, SplatFileType, SplatProps};

    #[derive(Default)]
    struct TestSplats {
        num_splats: usize,
        centers: Vec<f32>,
        opacity: Vec<f32>,
        rgb: Vec<f32>,
        scales: Vec<f32>,
        quats: Vec<f32>,
        sh1: Vec<f32>,
        sh2: Vec<f32>,
        sh3: Vec<f32>,
        finished: bool,
    }

    impl SplatReceiver for TestSplats {
        fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
            self.num_splats = init.num_splats;
            Ok(())
        }

        fn finish(&mut self) -> anyhow::Result<()> {
            self.finished = true;
            Ok(())
        }

        fn set_batch(&mut self, _base: usize, _count: usize, _batch: &SplatProps) {}

        fn set_center(&mut self, base: usize, count: usize, center: &[f32]) {
            copy_splat_values(&mut self.centers, base, count, 3, center);
        }

        fn set_opacity(&mut self, base: usize, count: usize, opacity: &[f32]) {
            copy_splat_values(&mut self.opacity, base, count, 1, opacity);
        }

        fn set_rgb(&mut self, base: usize, count: usize, rgb: &[f32]) {
            copy_splat_values(&mut self.rgb, base, count, 3, rgb);
        }

        fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]) {
            copy_splat_values(&mut self.scales, base, count, 3, scale);
        }

        fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]) {
            copy_splat_values(&mut self.quats, base, count, 4, quat);
        }

        fn set_sh(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32]) {
            copy_splat_values(&mut self.sh1, base, count, 9, sh1);
            if !sh2.is_empty() {
                copy_splat_values(&mut self.sh2, base, count, 15, sh2);
            }
            if !sh3.is_empty() {
                copy_splat_values(&mut self.sh3, base, count, 21, sh3);
            }
        }
    }

    #[derive(Default)]
    struct CountingSplats {
        num_splats: usize,
        centers: usize,
        opacity: usize,
        rgb: usize,
        scales: usize,
        quats: usize,
        finished: bool,
    }

    impl CountingSplats {
        fn add(seen: &mut usize, base: usize, count: usize) {
            assert_eq!(base, *seen);
            assert!(count <= MAX_SPLAT_CHUNK);
            *seen += count;
        }
    }

    impl SplatReceiver for CountingSplats {
        fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
            self.num_splats = init.num_splats;
            Ok(())
        }

        fn finish(&mut self) -> anyhow::Result<()> {
            assert_eq!(self.centers, self.num_splats);
            assert_eq!(self.opacity, self.num_splats);
            assert_eq!(self.rgb, self.num_splats);
            assert_eq!(self.scales, self.num_splats);
            assert_eq!(self.quats, self.num_splats);
            self.finished = true;
            Ok(())
        }

        fn set_batch(&mut self, _base: usize, _count: usize, _batch: &SplatProps) {
            unreachable!();
        }

        fn set_center(&mut self, base: usize, count: usize, _center: &[f32]) {
            Self::add(&mut self.centers, base, count);
        }

        fn set_opacity(&mut self, base: usize, count: usize, _opacity: &[f32]) {
            Self::add(&mut self.opacity, base, count);
        }

        fn set_rgb(&mut self, base: usize, count: usize, _rgb: &[f32]) {
            Self::add(&mut self.rgb, base, count);
        }

        fn set_scale(&mut self, _base: usize, _count: usize, _scale: &[f32]) {
            unreachable!();
        }

        fn set_ln_scale(&mut self, base: usize, count: usize, _ln_scale: &[f32]) {
            Self::add(&mut self.scales, base, count);
        }

        fn set_quat(&mut self, base: usize, count: usize, _quat: &[f32]) {
            Self::add(&mut self.quats, base, count);
        }
    }

    fn copy_splat_values(
        destination: &mut Vec<f32>,
        base: usize,
        count: usize,
        components: usize,
        source: &[f32],
    ) {
        let start = base * components;
        let end = (base + count) * components;
        destination.resize(destination.len().max(end), 0.0);
        destination[start..end].copy_from_slice(&source[..count * components]);
    }

    fn write_u32_at(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn write_u64_at(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn zstd_raw_frame(data: &[u8]) -> Vec<u8> {
        let uncompressed_size = data.len();
        assert!(uncompressed_size > 0);
        assert!(u32::try_from(uncompressed_size).is_ok());

        let mut frame = Vec::with_capacity(
            uncompressed_size
                + 4
                + MAX_ZSTD_FRAME_HEADER_SIZE
                + uncompressed_size.div_ceil(MAX_ZSTD_BLOCK_SIZE) * ZSTD_BLOCK_HEADER_SIZE,
        );
        frame.extend_from_slice(&ruzstd::frame::MAGIC_NUM.to_le_bytes());
        if uncompressed_size <= u8::MAX as usize {
            // Single segment, one-byte frame content size, no checksum.
            frame.push(0x20);
            frame.push(uncompressed_size as u8);
        } else {
            // Single segment, four-byte frame content size, no checksum.
            frame.push(0xa0);
            frame.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
        }

        let mut remaining = uncompressed_size;
        while remaining > 0 {
            let block_size = remaining.min(MAX_ZSTD_BLOCK_SIZE);
            remaining -= block_size;
            let last_block = usize::from(remaining == 0);
            let block_header = ((block_size as u32) << 3) | last_block as u32;
            let block_header = block_header.to_le_bytes();
            frame.extend_from_slice(&block_header[..ZSTD_BLOCK_HEADER_SIZE]);
            let start = uncompressed_size - remaining - block_size;
            frame.extend_from_slice(&data[start..start + block_size]);
        }
        frame
    }

    fn assemble_v4_file<B: AsRef<[u8]>>(
        num_splats: usize,
        sh_degree: u8,
        streams: &[(B, usize)],
    ) -> Vec<u8> {
        let toc_offset = NGSP_HEADER_SIZE;
        let mut file = vec![0; toc_offset + streams.len() * TOC_ENTRY_SIZE];

        write_u32_at(&mut file, 0, SPZ_MAGIC);
        write_u32_at(&mut file, 4, 4);
        write_u32_at(&mut file, 8, num_splats as u32);
        file[12] = sh_degree;
        file[13] = 12;
        file[15] = streams.len() as u8;
        write_u32_at(&mut file, 16, toc_offset as u32);

        for (index, (stream, uncompressed_size)) in streams.iter().enumerate() {
            let stream = stream.as_ref();
            let entry = toc_offset + index * TOC_ENTRY_SIZE;
            write_u64_at(&mut file, entry, stream.len() as u64);
            write_u64_at(&mut file, entry + 8, *uncompressed_size as u64);
            file.extend_from_slice(stream);
        }
        file
    }

    fn v4_raw_file(num_splats: usize) -> Vec<u8> {
        let widths = [9_usize, 1, 3, 3, 4];
        let streams: Vec<(Vec<u8>, usize)> = widths
            .iter()
            .map(|width| {
                let uncompressed_size = num_splats * width;
                (
                    zstd_raw_frame(&vec![0; uncompressed_size]),
                    uncompressed_size,
                )
            })
            .collect();
        assemble_v4_file(num_splats, 0, &streams)
    }

    fn v4_file_with_sh_degree(sh_degree: u8) -> Vec<u8> {
        // Each constant is an independent ZSTD frame generated at compression
        // level 12 from one attribute stream for a single splat.
        const POSITIONS: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x49, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0xe0,
            0xff, 0x00, 0x08, 0x00, 0x5f, 0xc4, 0x24, 0x4c,
        ];
        const ALPHAS: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x09, 0x00, 0x00, 0x80, 0x9f, 0x84, 0x60, 0x70,
        ];
        const COLORS: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x19, 0x00, 0x00, 0x80, 0x80, 0x80, 0x6c, 0x4c,
            0xdd, 0x7c,
        ];
        const SCALES: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x19, 0x00, 0x00, 0xa0, 0xa0, 0xa0, 0x2d, 0x51,
            0xa5, 0xa3,
        ];
        const ROTATIONS: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x2d,
            0xc1, 0x1e, 0x07,
        ];
        const SH_DEGREE_3: &[u8] = &[
            0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x60, 0x69, 0x01, 0x00, 0x80, 0x81, 0x82, 0x83, 0x84,
            0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92,
            0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0,
            0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xb3, 0x70,
            0xc4, 0x87,
        ];

        let mut streams = vec![
            (POSITIONS, 9_usize),
            (ALPHAS, 1_usize),
            (COLORS, 3_usize),
            (SCALES, 3_usize),
            (ROTATIONS, 4_usize),
        ];
        match sh_degree {
            0 => {}
            3 => streams.push((SH_DEGREE_3, 45)),
            _ => panic!("test fixture only supports SH degrees 0 and 3"),
        }
        assemble_v4_file(1, sh_degree, &streams)
    }

    fn v4_file() -> Vec<u8> {
        v4_file_with_sh_degree(0)
    }

    fn legacy_v3_file() -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend_from_slice(&SPZ_MAGIC.to_le_bytes());
        raw.extend_from_slice(&3_u32.to_le_bytes());
        raw.extend_from_slice(&1_u32.to_le_bytes());
        raw.extend_from_slice(&[0, 12, 0, 0]);
        raw.extend_from_slice(&[
            0x00, 0x10, 0x00, // x = 1
            0x00, 0xe0, 0xff, // y = -2
            0x00, 0x08, 0x00, // z = 0.5
            0x80, // alpha
            0x80, 0x80, 0x80, // RGB
            0xa0, 0xa0, 0xa0, // unit scales
            0x00, 0x00, 0x00, 0xc0, // identity quaternion
        ]);

        gzip_file(&raw)
    }

    fn gzip_file(raw: &[u8]) -> Vec<u8> {
        let compressed = compress_to_vec(raw, 6);
        let mut gzip = vec![0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0];
        gzip.extend_from_slice(&compressed);
        gzip.extend_from_slice(&crc32fast::hash(raw).to_le_bytes());
        gzip.extend_from_slice(&(raw.len() as u32).to_le_bytes());
        gzip
    }

    fn decode_in_chunks(file: &[u8], chunk_size: usize) -> anyhow::Result<TestSplats> {
        let mut decoder = MultiDecoder::new(TestSplats::default(), None, None);
        for chunk in file.chunks(chunk_size) {
            decoder.push(chunk)?;
        }
        assert!(matches!(decoder.file_type, Some(SplatFileType::SPZ)));
        decoder.finish()?;
        Ok(decoder.into_splats())
    }

    fn decode_error(file: &[u8]) -> String {
        let mut decoder = MultiDecoder::new(TestSplats::default(), None, None);
        for chunk in file.chunks(7) {
            if let Err(error) = decoder.push(chunk) {
                return error.to_string();
            }
        }
        decoder
            .finish()
            .expect_err("malformed SPZ v4 unexpectedly decoded")
            .to_string()
    }

    fn assert_test_splat(splats: &TestSplats) {
        assert_eq!(splats.num_splats, 1);
        assert!(splats.finished);
        assert_eq!(splats.centers, [1.0, -2.0, 0.5]);
        assert!((splats.opacity[0] - 128.0 / 255.0).abs() < 1e-6);
        let expected_rgb = (128.0 / 255.0 - 0.5) * (SH_C0 / 0.15) + 0.5;
        for value in &splats.rgb {
            assert!((*value - expected_rgb).abs() < 1e-6);
        }
        assert_eq!(splats.scales, [1.0, 1.0, 1.0]);
        assert_eq!(splats.quats, [0.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn decodes_chunked_spz_v4_and_detects_raw_ngsp_magic() {
        let splats = decode_in_chunks(&v4_file(), 1).unwrap();
        assert_test_splat(&splats);
    }

    #[test]
    fn incrementally_decodes_multi_block_v4_streams_with_bounded_input() {
        let num_splats = MAX_SPLAT_CHUNK + 1;
        let file = v4_raw_file(num_splats);
        let mut decoder = SpzDecoder::new(CountingSplats::default());
        for chunk in file.chunks(4093) {
            decoder.push(chunk).unwrap();
        }

        assert!(decoder.v4_peak_compressed_buffer_size <= MAX_V4_COMPRESSED_BUFFER_SIZE);
        assert!(decoder.v4_peak_compressed_buffer_size >= MAX_ZSTD_BLOCK_SIZE);
        assert!(decoder.raw.capacity() <= MAX_V4_COMPRESSED_BUFFER_SIZE);
        decoder.finish().unwrap();
        let splats = decoder.into_splats();
        assert_eq!(splats.num_splats, num_splats);
        assert!(splats.finished);
    }

    #[test]
    fn decodes_all_spz_v4_sh_bands() {
        let splats = decode_in_chunks(&v4_file_with_sh_degree(3), 5).unwrap();
        assert_test_splat(&splats);

        assert_eq!(splats.sh1.len(), 9);
        assert_eq!(splats.sh2.len(), 15);
        assert_eq!(splats.sh3.len(), 21);
        for (index, value) in splats
            .sh1
            .iter()
            .chain(&splats.sh2)
            .chain(&splats.sh3)
            .enumerate()
        {
            assert!((*value - index as f32 / 128.0).abs() < 1e-6);
        }
    }

    #[test]
    fn keeps_legacy_gzip_v3_decoding() {
        let splats = decode_in_chunks(&legacy_v3_file(), 3).unwrap();
        assert_test_splat(&splats);
    }

    #[test]
    fn decodes_gzip_across_output_windows_and_splat_chunks() {
        let count = MAX_SPLAT_CHUNK + 1;
        let mut raw = vec![0; 16 + count * 20];
        write_u32_at(&mut raw, 0, SPZ_MAGIC);
        write_u32_at(&mut raw, 4, 3);
        write_u32_at(&mut raw, 8, count as u32);
        raw[13] = 12;
        let file = gzip_file(&raw);
        for chunk_size in [1, 4093, file.len()] {
            let mut decoder = SpzDecoder::new(CountingSplats::default());
            for chunk in file.chunks(chunk_size) {
                decoder.push(chunk).unwrap();
            }
            decoder.finish().unwrap();
            assert!(decoder.into_splats().finished);
        }
    }

    #[test]
    fn rejects_missing_gzip_trailer() {
        let file = legacy_v3_file();
        for missing in 1..=8 {
            assert!(decode_in_chunks(&file[..file.len() - missing], 3).is_err());
        }
    }

    #[test]
    fn rejects_corrupt_v4_checksum() {
        let mut file = v4_file();
        *file.last_mut().unwrap() ^= 1;
        assert!(decode_in_chunks(&file, 3).is_err());
    }

    #[test]
    fn rejects_corrupt_gzip_trailer_and_trailing_data() {
        for offset in [8, 4] {
            let mut file = legacy_v3_file();
            let index = file.len() - offset;
            file[index] ^= 1;
            assert!(decode_in_chunks(&file, 1).is_err());
        }
        let mut file = legacy_v3_file();
        file.push(0);
        assert!(decode_in_chunks(&file, 1).is_err());
        assert!(decode_in_chunks(&file, file.len()).is_err());
    }

    #[test]
    fn decodes_optional_gzip_headers_across_chunk_boundaries() {
        let original = legacy_v3_file();
        let mut file = original[..10].to_vec();
        file[3] = 0x1e; // Extra data, filename, comment, header CRC.
        file.extend_from_slice(&[3, 0, 10, 20, 30]);
        file.extend_from_slice(b"model.spz\0comment\0");
        let header_crc = crc32fast::hash(&file) as u16;
        file.extend_from_slice(&header_crc.to_le_bytes());
        let header_size = file.len();
        file.extend_from_slice(&original[10..]);
        for chunk_size in [1, 7, file.len()] {
            assert_test_splat(&decode_in_chunks(&file, chunk_size).unwrap());
        }
        file[header_size - 1] ^= 1;
        assert!(decode_in_chunks(&file, 1).is_err());
    }

    #[test]
    fn rejects_v4_frame_content_size_mismatch() {
        let mut file = v4_raw_file(1);
        let first_frame = NGSP_HEADER_SIZE + 5 * TOC_ENTRY_SIZE;
        file[first_frame + 5] = 10; // Frame claims 10 bytes, TOC and payload contain 9.
        assert!(decode_error(&file).contains("frame content size"));
    }

    #[test]
    fn v3_and_v4_decode_multiple_points_and_all_supported_sh_degrees() {
        for degree in 0..=3 {
            let count = 4;
            let widths = [9, 1, 3, 3, 4, 3 * degree * (degree + 2)];
            let mut attributes: Vec<Vec<u8>> = widths.iter().map(|w| vec![0; count * w]).collect();
            let mut expected_quats = Vec::new();
            for point in 0..count {
                for axis in 0..3 {
                    let fixed = ((point * 3 + axis) as i32 - 6) * 4096;
                    let start = point * 9 + axis * 3;
                    attributes[0][start..start + 3].copy_from_slice(&fixed.to_le_bytes()[..3]);
                }
                attributes[1][point] = (point * 85) as u8;
                attributes[2][point * 3..point * 3 + 3].fill((point * 85) as u8);
                attributes[3][point * 3..point * 3 + 3].fill(160);
                // Exercise each omitted quaternion component and both stored signs.
                let mut packed = point as u32;
                let mut quat = [0.0_f32; 4];
                let mut sum = 0.0;
                for (axis, value) in quat.iter_mut().enumerate() {
                    if axis == point {
                        continue;
                    }
                    let magnitude = 64 * (axis + 1) as u32;
                    let negative = axis % 2 == 1;
                    packed = (packed << 10) | (u32::from(negative) << 9) | magnitude;
                    *value = std::f32::consts::FRAC_1_SQRT_2 * (magnitude as f32 / 511.0);
                    if negative {
                        *value = -*value;
                    }
                    sum += *value * *value;
                }
                quat[point] = (1.0 - sum).sqrt();
                expected_quats.extend_from_slice(&quat);
                attributes[4][point * 4..point * 4 + 4].copy_from_slice(&packed.to_le_bytes());
            }
            for (i, value) in attributes[5].iter_mut().enumerate() {
                *value = i as u8;
            }
            let streams: Vec<_> = attributes
                .iter()
                .filter(|a| !a.is_empty())
                .map(|a| (zstd_raw_frame(a), a.len()))
                .collect();
            let v4 = assemble_v4_file(count, degree as u8, &streams);
            let mut raw = v4[..16].to_vec();
            write_u32_at(&mut raw, 4, 3);
            raw[15] = 0;
            for attribute in &attributes {
                raw.extend_from_slice(attribute);
            }
            let v3 = gzip_file(&raw);
            for file in [&v3, &v4] {
                for chunk_size in [1, 7, file.len()] {
                    let splats = decode_in_chunks(file, chunk_size).unwrap();
                    assert_eq!(
                        splats.centers,
                        (-6..6).map(|v| v as f32).collect::<Vec<_>>()
                    );
                    assert_eq!(splats.scales, vec![1.0; 12]);
                    for (actual, expected) in splats.quats.iter().zip(&expected_quats) {
                        assert!((actual - expected).abs() < 1e-6);
                    }
                    for point in 0..count {
                        assert_eq!(splats.opacity[point], (point * 85) as f32 / 255.0);
                        let color = ((point * 85) as f32 / 255.0 - 0.5) * (SH_C0 / 0.15) + 0.5;
                        assert_eq!(&splats.rgb[point * 3..point * 3 + 3], &[color; 3]);
                    }
                    let mut offset = 0;
                    for (band, width) in [&splats.sh1, &splats.sh2, &splats.sh3]
                        .into_iter()
                        .zip([9, 15, 21])
                        .take(degree)
                    {
                        for point in 0..count {
                            for component in 0..width {
                                let byte = attributes[5][point * widths[5] + offset + component];
                                assert_eq!(
                                    band[point * width + component],
                                    (byte as f32 - 128.0) / 128.0
                                );
                            }
                        }
                        offset += width;
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_truncated_spz_v4() {
        let mut file = v4_file();
        file.pop();

        let mut decoder = MultiDecoder::new(TestSplats::default(), None, None);
        for chunk in file.chunks(7) {
            decoder.push(chunk).unwrap();
        }
        let error = decoder.finish().unwrap_err();
        assert!(error.to_string().contains("Truncated SPZ v4 stream"));
    }

    #[test]
    fn rejects_malformed_spz_v4_metadata_and_trailing_data() {
        let mut wrong_stream_count = v4_file();
        wrong_stream_count[15] = 4;
        assert!(decode_error(&wrong_stream_count).contains("stream count mismatch"));

        let mut wrong_uncompressed_size = v4_file();
        write_u64_at(&mut wrong_uncompressed_size, NGSP_HEADER_SIZE + 8, 8);
        assert!(decode_error(&wrong_uncompressed_size).contains("stream size mismatch"));

        let mut invalid_fractional_bits = v4_file();
        invalid_fractional_bits[13] = 32;
        assert!(decode_error(&invalid_fractional_bits).contains("fractional bits"));

        let mut unsupported_sh_degree = v4_file();
        unsupported_sh_degree[12] = 4;
        assert!(decode_error(&unsupported_sh_degree).contains("SH degree"));

        let mut trailing_data = v4_file();
        trailing_data.push(0);
        assert!(decode_error(&trailing_data).contains("compressed data size mismatch"));

        let mut trailing_stream_data = v4_file();
        let first_compressed_size =
            read_u64_le(&trailing_stream_data[NGSP_HEADER_SIZE..NGSP_HEADER_SIZE + 8]) as usize;
        let first_stream_end = NGSP_HEADER_SIZE + 5 * TOC_ENTRY_SIZE + first_compressed_size;
        trailing_stream_data.insert(first_stream_end, 0xaa);
        write_u64_at(
            &mut trailing_stream_data,
            NGSP_HEADER_SIZE,
            (first_compressed_size + 1) as u64,
        );
        assert!(decode_error(&trailing_stream_data).contains("trailing bytes"));
    }
}
