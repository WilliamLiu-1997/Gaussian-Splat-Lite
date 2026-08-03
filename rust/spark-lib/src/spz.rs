use miniz_oxide::inflate::core::inflate_flags::{
    TINFL_FLAG_HAS_MORE_INPUT, TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
};
use miniz_oxide::inflate::core::{decompress, DecompressorOxide};
use miniz_oxide::inflate::TINFLStatus;
use std::io::Read;

use crate::decoder::{ChunkReceiver, SplatInit, SplatReceiver};

pub const SPZ_MAGIC: u32 = 0x5053474e; // "NGSP"
const SH_C0: f32 = 0.28209479177387814;
const MAX_SPLAT_CHUNK: usize = 65536;
const NGSP_HEADER_SIZE: usize = 32;
const TOC_ENTRY_SIZE: usize = 16;
const MAX_COMPRESSION_RATIO: u64 = 1024;
const MIN_BYTES_PER_SPLAT: u64 = 9;
const MAX_ZSTD_WINDOW_SIZE: u64 = 100 * 1024 * 1024;

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

#[derive(Debug, Clone)]
struct V4HeaderInfo {
    version: u32,
    num_splats: usize,
    sh_degree: usize,
    fractional_bits: u8,
    flags: u8,
    num_streams: usize,
    toc_byte_offset: usize,
    toc_end: usize,
}

enum V4Stage {
    NeedHeader,
    NeedToc(V4HeaderInfo),
    NeedStreams {
        header: V4HeaderInfo,
        streams: Vec<V4StreamInfo>,
        total_size: usize,
    },
    Done,
}

struct V4StreamInfo {
    compressed_offset: usize,
    compressed_size: usize,
    uncompressed_size: usize,
}

pub struct SpzDecoder<T: SplatReceiver> {
    splats: T,
    format: SpzFormat,
    decompressor: DecompressorOxide,
    compressed: Vec<u8>,
    decompressed: Vec<u8>,
    gzip_header_done: bool,
    out_pos: usize,
    raw: Vec<u8>,
    v4_stage: V4Stage,
    v4_total_size: Option<usize>,
    buffer: Vec<u8>,
    state: Option<SpzDecoderState>,
    done: bool,
}

impl<T: SplatReceiver> SpzDecoder<T> {
    pub fn new(splats: T) -> Self {
        Self {
            splats,
            format: SpzFormat::Unknown,
            decompressor: DecompressorOxide::new(),
            compressed: Vec::new(),
            decompressed: vec![0u8; 128 * 1024],
            buffer: Vec::new(),
            state: None,
            gzip_header_done: false,
            out_pos: 0,
            done: false,
            raw: Vec::new(),
            v4_stage: V4Stage::NeedHeader,
            v4_total_size: None,
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
            self.poll_sections()?;
        }
        Ok(())
    }

    fn poll_header(&mut self) -> anyhow::Result<()> {
        if self.buffer.len() < 16 {
            return Ok(());
        }

        let header = parse_common_header(&self.buffer)?;
        if !(1..=3).contains(&header.version) {
            return Err(anyhow::anyhow!(
                "Unsupported legacy SPZ version: {}",
                header.version
            ));
        }
        let _reserved = self.buffer[15];

        self.buffer.drain(..16);
        self.init_state(
            header.version,
            header.num_splats,
            header.sh_degree,
            header.fractional_bits,
            header.flags,
        )
    }

    fn init_state(
        &mut self,
        version: u32,
        num_splats: usize,
        sh_degree: usize,
        fractional_bits: u8,
        flags: u8,
    ) -> anyhow::Result<()> {
        if flags & 0x80 != 0 {
            return Err(anyhow::anyhow!(
                "Unsupported SPZ extension flags: 0x{:02x}",
                flags
            ));
        }

        self.state = Some(SpzDecoderState::new(
            version,
            num_splats,
            sh_degree,
            fractional_bits,
        )?);

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
                V4Stage::Done => {
                    if let Some(total_size) = self.v4_total_size {
                        if self.raw.len() != total_size {
                            return Err(anyhow::anyhow!(
                                "v4 compressed data size mismatch: expected {}, got {}",
                                total_size,
                                self.raw.len()
                            ));
                        }
                    }
                    self.v4_stage = V4Stage::Done;
                    return Ok(());
                }
                V4Stage::NeedHeader => {
                    if self.raw.len() < NGSP_HEADER_SIZE {
                        self.v4_stage = V4Stage::NeedHeader;
                        return Ok(());
                    }
                    self.v4_stage = V4Stage::NeedToc(parse_v4_header(&self.raw)?);
                }
                V4Stage::NeedToc(header) => {
                    if self.raw.len() < header.toc_end {
                        self.v4_stage = V4Stage::NeedToc(header);
                        return Ok(());
                    }
                    let (streams, total_size) = walk_v4_toc(&self.raw, &header)?;
                    validate_v4_point_count(header.num_splats, total_size)?;
                    self.v4_total_size = Some(total_size);
                    self.v4_stage = V4Stage::NeedStreams {
                        header,
                        streams,
                        total_size,
                    };
                }
                V4Stage::NeedStreams {
                    header,
                    streams,
                    total_size,
                } => {
                    if self.raw.len() < total_size {
                        self.v4_stage = V4Stage::NeedStreams {
                            header,
                            streams,
                            total_size,
                        };
                        return Ok(());
                    }
                    if self.raw.len() > total_size {
                        return Err(anyhow::anyhow!(
                            "v4 compressed data size mismatch: expected {}, got {}",
                            total_size,
                            self.raw.len()
                        ));
                    }

                    self.buffer.clear();
                    for stream in &streams {
                        let compressed = &self.raw[stream.compressed_offset
                            ..stream.compressed_offset + stream.compressed_size];
                        validate_zstd_frame(compressed, stream.uncompressed_size)?;

                        let mut decoder = ruzstd::StreamingDecoder::new(compressed)
                            .map_err(|error| anyhow::anyhow!("v4 ZSTD init failed: {}", error))?;
                        let output_start = self.buffer.len();
                        let read_limit = u64::try_from(stream.uncompressed_size)
                            .ok()
                            .and_then(|size| size.checked_add(1))
                            .ok_or_else(|| anyhow::anyhow!("v4 stream size overflow"))?;
                        decoder
                            .by_ref()
                            .take(read_limit)
                            .read_to_end(&mut self.buffer)
                            .map_err(|error| {
                                anyhow::anyhow!("v4 ZSTD decompress failed: {}", error)
                            })?;
                        let actual_size = self.buffer.len() - output_start;
                        if actual_size != stream.uncompressed_size {
                            return Err(anyhow::anyhow!(
                                "v4 ZSTD size mismatch: expected {}, got {}",
                                stream.uncompressed_size,
                                actual_size
                            ));
                        }
                        if !decoder.get_ref().is_empty() {
                            return Err(anyhow::anyhow!(
                                "trailing bytes in v4 ZSTD stream: {}",
                                decoder.get_ref().len()
                            ));
                        }
                    }

                    self.init_state(
                        header.version,
                        header.num_splats,
                        header.sh_degree,
                        header.fractional_bits,
                        header.flags,
                    )?;
                    self.poll_sections()?;
                    self.v4_stage = V4Stage::Done;
                    self.done = true;
                    return Ok(());
                }
            }
        }
    }

    fn poll_sections(&mut self) -> anyhow::Result<()> {
        let Some(state) = self.state.as_mut() else {
            unreachable!();
        };
        loop {
            match state.stage {
                SpzDecoderStage::Centers => {
                    let bytes_per_item = if state.version == 1 { 6 } else { 9 };
                    let avail_items = self.buffer.len() / bytes_per_item;
                    let remaining = state.num_splats - state.next_splat;
                    if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                        return Ok(());
                    }
                    let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                    if state.output.len() < chunk * 3 {
                        state.output.resize(chunk * 3, 0.0);
                    }
                    if state.version == 1 {
                        for i in 0..chunk {
                            let base = i * 6;
                            state.output[i * 3 + 0] = read_f16_le(&self.buffer[base..base + 2]);
                            state.output[i * 3 + 1] = read_f16_le(&self.buffer[base + 2..base + 4]);
                            state.output[i * 3 + 2] = read_f16_le(&self.buffer[base + 4..base + 6]);
                        }
                    } else {
                        let frac = (1_u32 << state.fractional_bits) as f32;
                        for i in 0..chunk {
                            let base = i * 9;
                            state.output[i * 3 + 0] =
                                read_i24_le(&self.buffer[base..base + 3]) as f32 / frac;
                            state.output[i * 3 + 1] =
                                read_i24_le(&self.buffer[base + 3..base + 6]) as f32 / frac;
                            state.output[i * 3 + 2] =
                                read_i24_le(&self.buffer[base + 6..base + 9]) as f32 / frac;
                        }
                    }

                    self.splats
                        .set_center(state.next_splat, chunk, &state.output);

                    self.buffer.drain(..chunk * bytes_per_item);
                    state.next_splat += chunk;
                    if state.next_splat == state.num_splats {
                        state.next_splat = 0;
                        state.stage = SpzDecoderStage::Alphas;
                    }
                }
                SpzDecoderStage::Alphas => {
                    let bytes_per_item = 1;
                    let avail_items = self.buffer.len() / bytes_per_item;
                    let remaining = state.num_splats - state.next_splat;
                    if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                        return Ok(());
                    }
                    let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                    if state.output.len() < chunk {
                        state.output.resize(chunk, 0.0);
                    }
                    for i in 0..chunk {
                        state.output[i] = self.buffer[i] as f32 / 255.0;
                    }

                    self.splats
                        .set_opacity(state.next_splat, chunk, &state.output);

                    self.buffer.drain(..chunk * bytes_per_item);
                    state.next_splat += chunk;
                    if state.next_splat == state.num_splats {
                        state.next_splat = 0;
                        state.stage = SpzDecoderStage::Rgb;
                    }
                }
                SpzDecoderStage::Rgb => {
                    let bytes_per_item = 3;
                    let avail_items = self.buffer.len() / bytes_per_item;
                    let remaining = state.num_splats - state.next_splat;
                    if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                        return Ok(());
                    }
                    let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                    let scale = SH_C0 / 0.15;
                    if state.output.len() < chunk * 3 {
                        state.output.resize(chunk * 3, 0.0);
                    }
                    for i in 0..chunk {
                        let b = i * 3;
                        state.output[b + 0] = (self.buffer[b] as f32 / 255.0 - 0.5) * scale + 0.5;
                        state.output[b + 1] =
                            (self.buffer[b + 1] as f32 / 255.0 - 0.5) * scale + 0.5;
                        state.output[b + 2] =
                            (self.buffer[b + 2] as f32 / 255.0 - 0.5) * scale + 0.5;
                    }

                    self.splats.set_rgb(state.next_splat, chunk, &state.output);

                    self.buffer.drain(..chunk * bytes_per_item);
                    state.next_splat += chunk;
                    if state.next_splat == state.num_splats {
                        state.next_splat = 0;
                        state.stage = SpzDecoderStage::Scales;
                    }
                }
                SpzDecoderStage::Scales => {
                    let bytes_per_item = 3;
                    let avail_items = self.buffer.len() / bytes_per_item;
                    let remaining = state.num_splats - state.next_splat;
                    if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                        return Ok(());
                    }
                    let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                    if state.output.len() < chunk * 3 {
                        state.output.resize(chunk * 3, 0.0);
                    }
                    for i in 0..chunk {
                        let b = i * 3;
                        state.output[b + 0] = ((self.buffer[b] as f32) / 16.0 - 10.0).exp();
                        state.output[b + 1] = ((self.buffer[b + 1] as f32) / 16.0 - 10.0).exp();
                        state.output[b + 2] = ((self.buffer[b + 2] as f32) / 16.0 - 10.0).exp();
                    }

                    self.splats
                        .set_scale(state.next_splat, chunk, &state.output);

                    self.buffer.drain(..chunk * bytes_per_item);
                    state.next_splat += chunk;
                    if state.next_splat == state.num_splats {
                        state.next_splat = 0;
                        state.stage = SpzDecoderStage::Quats;
                    }
                }
                SpzDecoderStage::Quats => {
                    let bytes_per_item = if state.version >= 3 { 4 } else { 3 };
                    let avail_items = self.buffer.len() / bytes_per_item;
                    let remaining = state.num_splats - state.next_splat;
                    if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                        return Ok(());
                    }
                    let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                    if state.output.len() < chunk * 4 {
                        state.output.resize(chunk * 4, 0.0);
                    }
                    if state.version >= 3 {
                        // Versions 3 and 4 use "smallest three" quaternion compression.
                        for i in 0..chunk {
                            let base = i * 4;
                            let comp = (self.buffer[base] as u32)
                                | ((self.buffer[base + 1] as u32) << 8)
                                | ((self.buffer[base + 2] as u32) << 16)
                                | ((self.buffer[base + 3] as u32) << 24);
                            let largest_index = (comp >> 30) as usize;
                            let mut remaining_values = comp;
                            let value_mask: u32 = (1u32 << 9) - 1; // 9 bits for magnitude
                            let max_value: f32 = std::f32::consts::FRAC_1_SQRT_2; // 1/sqrt(2)
                            let mut q = [0.0f32; 4];
                            let mut sum_squares = 0.0f32;

                            for j in (0..4).rev() {
                                if j != largest_index {
                                    let value = (remaining_values & value_mask) as f32;
                                    let sign = ((remaining_values >> 9) & 0x1) != 0;
                                    remaining_values >>= 10;
                                    let mut v = max_value * (value / value_mask as f32);
                                    if sign {
                                        v = -v;
                                    }
                                    q[j] = v;
                                    sum_squares += v * v;
                                }
                            }

                            let sq = 1.0 - sum_squares;
                            q[largest_index] = if sq > 0.0 { sq.sqrt() } else { 0.0 };

                            let o = i * 4;
                            state.output[o] = q[0];
                            state.output[o + 1] = q[1];
                            state.output[o + 2] = q[2];
                            state.output[o + 3] = q[3];
                        }
                    } else {
                        // Versions < 3 use 3 bytes (qx, qy, qz), reconstruct qw
                        for i in 0..chunk {
                            let base = i * 3;
                            let qx = self.buffer[base] as f32 / 127.5 - 1.0;
                            let qy = self.buffer[base + 1] as f32 / 127.5 - 1.0;
                            let qz = self.buffer[base + 2] as f32 / 127.5 - 1.0;
                            let qw = (1.0 - (qx * qx + qy * qy + qz * qz)).max(0.0).sqrt();
                            let o = i * 4;
                            state.output[o] = qx;
                            state.output[o + 1] = qy;
                            state.output[o + 2] = qz;
                            state.output[o + 3] = qw;
                        }
                    }

                    self.splats.set_quat(state.next_splat, chunk, &state.output);

                    self.buffer.drain(..chunk * bytes_per_item);
                    state.next_splat += chunk;
                    if state.next_splat == state.num_splats {
                        state.next_splat = 0;
                        state.stage = SpzDecoderStage::Sh;
                    }
                }
                SpzDecoderStage::Sh => {
                    if state.sh_degree == 0 {
                        state.stage = SpzDecoderStage::Done;
                    } else {
                        let sh_components = 3 * match state.sh_degree {
                            1 => 3,
                            2 => 8,
                            3 => 15,
                            _ => 0,
                        };
                        let bytes_per_item = sh_components;
                        let avail_items = self.buffer.len() / bytes_per_item;
                        let remaining = state.num_splats - state.next_splat;
                        if (avail_items < remaining) && (avail_items < MAX_SPLAT_CHUNK) {
                            return Ok(());
                        }
                        let chunk = remaining.min(avail_items).min(MAX_SPLAT_CHUNK);

                        let total_floats = chunk * sh_components;
                        if state.output.len() < total_floats {
                            state.output.resize(total_floats, 0.0);
                        }

                        for i in 0..chunk {
                            let base = i * sh_components;
                            for d in 0..3 {
                                for k in 0..3 {
                                    state.output[9 * i + k * 3 + d] =
                                        (self.buffer[base + k * 3 + d] as f32 - 128.0) / 128.0;
                                }
                            }
                            if state.sh_degree >= 2 {
                                for d in 0..3 {
                                    for k in 0..5 {
                                        state.output[9 * chunk + 15 * i + k * 3 + d] =
                                            (self.buffer[base + 9 + k * 3 + d] as f32 - 128.0)
                                                / 128.0;
                                    }
                                }
                            }
                            if state.sh_degree >= 3 {
                                for d in 0..3 {
                                    for k in 0..7 {
                                        state.output[24 * chunk + 21 * i + k * 3 + d] =
                                            (self.buffer[base + 24 + k * 3 + d] as f32 - 128.0)
                                                / 128.0;
                                    }
                                }
                            }
                        }

                        self.splats.set_sh(
                            state.next_splat,
                            chunk,
                            &state.output[0..chunk * 9],
                            if state.sh_degree >= 2 {
                                &state.output[9 * chunk..24 * chunk]
                            } else {
                                &[][..]
                            },
                            if state.sh_degree >= 3 {
                                &state.output[24 * chunk..total_floats]
                            } else {
                                &[][..]
                            },
                        );

                        self.buffer.drain(..chunk * bytes_per_item);
                        state.next_splat += chunk;
                        if state.next_splat == state.num_splats {
                            state.next_splat = 0;
                            state.stage = SpzDecoderStage::Done;
                        }
                    }
                }
                SpzDecoderStage::Done => return Ok(()),
            }
        }
    }

    fn poll_decompress(&mut self) -> anyhow::Result<()> {
        if !self.gzip_header_done {
            if !parse_gzip_header(&mut self.compressed)? {
                return Ok(());
            }
            self.gzip_header_done = true;
        }
        let mut in_offset = 0;
        let flags: u32 = TINFL_FLAG_HAS_MORE_INPUT | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
        loop {
            if in_offset >= self.compressed.len() {
                break;
            }
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
                self.buffer.extend_from_slice(
                    &self.decompressed[self.out_pos..self.out_pos + out_written],
                );
                self.out_pos += out_written;
                self.poll()?;
            }

            in_offset += in_consumed;
            match status {
                TINFLStatus::Done => {
                    self.done = true;
                    let remaining = self.compressed.len().saturating_sub(in_offset);
                    if remaining >= 8 {
                        in_offset += 8;
                    }
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
    validate_splat_parameters(header.sh_degree, header.fractional_bits)?;
    if header.flags & 0x80 != 0 {
        return Err(anyhow::anyhow!(
            "Unsupported SPZ extension flags: 0x{:02x}",
            header.flags
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

    let toc_size = num_streams
        .checked_mul(TOC_ENTRY_SIZE)
        .ok_or_else(|| anyhow::anyhow!("v4 TOC size overflow"))?;
    let toc_end = toc_byte_offset
        .checked_add(toc_size)
        .ok_or_else(|| anyhow::anyhow!("v4 TOC end overflow"))?;

    Ok(V4HeaderInfo {
        version: header.version,
        num_splats: header.num_splats,
        sh_degree: header.sh_degree,
        fractional_bits: header.fractional_bits,
        flags: header.flags,
        num_streams,
        toc_byte_offset,
        toc_end,
    })
}

fn walk_v4_toc(raw: &[u8], header: &V4HeaderInfo) -> anyhow::Result<(Vec<V4StreamInfo>, usize)> {
    debug_assert!(raw.len() >= header.toc_end);
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
        let entry = header.toc_byte_offset + index * TOC_ENTRY_SIZE;
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
            compressed_offset: data_cursor,
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
    if header.num_splats == 0 {
        return Ok(Vec::new());
    }

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
    if header.num_splats > 0 && header.sh_degree > 0 {
        let sh_components = match header.sh_degree {
            1 => 9,
            2 => 24,
            3 => 45,
            _ => unreachable!(),
        };
        sizes.push(checked_size(sh_components)?);
    }
    Ok(sizes)
}

fn validate_v4_point_count(num_splats: usize, file_size: usize) -> anyhow::Result<()> {
    if num_splats > i32::MAX as usize {
        return Err(anyhow::anyhow!(
            "v4 point count exceeds supported maximum: {}",
            num_splats
        ));
    }
    if num_splats > 0 {
        let max_splats = (u64::try_from(file_size)
            .unwrap_or(u64::MAX)
            .saturating_mul(MAX_COMPRESSION_RATIO))
            / MIN_BYTES_PER_SPLAT;
        if u64::try_from(num_splats).unwrap_or(u64::MAX) > max_splats {
            return Err(anyhow::anyhow!(
                "v4 point count {} is implausible for {} input bytes",
                num_splats,
                file_size
            ));
        }
    }
    Ok(())
}

fn validate_zstd_frame(compressed: &[u8], expected_size: usize) -> anyhow::Result<()> {
    let (frame, _) = ruzstd::frame::read_frame_header(compressed)
        .map_err(|error| anyhow::anyhow!("v4 ZSTD header failed: {}", error))?;
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

    let frame_size = frame.header.frame_content_size();
    if frame_size != 0 && frame_size != u64::try_from(expected_size).unwrap_or(u64::MAX) {
        return Err(anyhow::anyhow!(
            "v4 ZSTD frame size mismatch: expected {}, got {}",
            expected_size,
            frame_size
        ));
    }
    Ok(())
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

fn parse_gzip_header(buffer: &mut Vec<u8>) -> anyhow::Result<bool> {
    if buffer.len() < 10 {
        return Ok(false);
    }
    if buffer[0] != 0x1f || buffer[1] != 0x8b || buffer[2] != 8 {
        return Err(anyhow::anyhow!("Invalid gzip header"));
    }

    let flags = buffer[3];
    let mut end = 10;

    if (flags & 0x04) != 0 {
        if buffer.len() < end + 2 {
            return Ok(false);
        }
        let extra_len = (buffer[end] as usize) | ((buffer[end + 1] as usize) << 8);
        end += 2;
        if buffer.len() < end + extra_len {
            return Ok(false);
        }
        end += extra_len;
    }

    if (flags & 0x08) != 0 {
        let mut null = end;
        let mut found = false;
        while null < buffer.len() {
            if buffer[null] == 0 {
                null += 1;
                found = true;
                break;
            }
            null += 1;
        }
        if !found {
            return Ok(false);
        }
        end = null;
    }

    if (flags & 0x10) != 0 {
        let mut null = end;
        let mut found = false;
        while null < buffer.len() {
            if buffer[null] == 0 {
                null += 1;
                found = true;
                break;
            }
            null += 1;
        }
        if !found {
            return Ok(false);
        }
        end = null;
    }

    if (flags & 0x02) != 0 {
        if buffer.len() < end + 2 {
            return Ok(false);
        }
        end += 2;
    }

    buffer.drain(..end);
    Ok(true)
}

impl<T: SplatReceiver> ChunkReceiver for SpzDecoder<T> {
    fn into_any(self: Box<Self>) -> Box<dyn std::any::Any> {
        self
    }

    fn push(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        if self.format == SpzFormat::Unknown {
            self.raw.extend_from_slice(bytes);
            if self.raw.len() < 4 {
                return Ok(());
            }

            let magic = read_u32_le(&self.raw[0..4]);
            if magic == SPZ_MAGIC {
                self.format = SpzFormat::Ngsp;
            } else if (magic & 0x00ffffff) == 0x00088b1f {
                self.format = SpzFormat::Gzip;
                self.compressed = std::mem::take(&mut self.raw);
            } else {
                return Err(anyhow::anyhow!(
                    "Unrecognized SPZ format: leading bytes 0x{:08x}",
                    magic
                ));
            }
        } else {
            match self.format {
                SpzFormat::Gzip => self.compressed.extend_from_slice(bytes),
                SpzFormat::Ngsp => self.raw.extend_from_slice(bytes),
                SpzFormat::Unknown => unreachable!(),
            }
        }

        match self.format {
            SpzFormat::Gzip => self.poll_decompress(),
            SpzFormat::Ngsp => self.try_decode_v4(),
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
    fn new(
        version: u32,
        num_splats: usize,
        sh_degree: usize,
        fractional_bits: u8,
    ) -> anyhow::Result<Self> {
        validate_splat_parameters(sh_degree, fractional_bits)?;
        Ok(Self {
            version,
            num_splats,
            sh_degree,
            fractional_bits,
            next_splat: 0,
            stage: SpzDecoderStage::Centers,
            output: Vec::with_capacity(MAX_SPLAT_CHUNK * 4),
        })
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
            (POSITIONS, 9_u64),
            (ALPHAS, 1_u64),
            (COLORS, 3_u64),
            (SCALES, 3_u64),
            (ROTATIONS, 4_u64),
        ];
        match sh_degree {
            0 => {}
            3 => streams.push((SH_DEGREE_3, 45)),
            _ => panic!("test fixture only supports SH degrees 0 and 3"),
        }
        let toc_offset = NGSP_HEADER_SIZE;
        let mut file = vec![0; toc_offset + streams.len() * TOC_ENTRY_SIZE];

        write_u32_at(&mut file, 0, SPZ_MAGIC);
        write_u32_at(&mut file, 4, 4);
        write_u32_at(&mut file, 8, 1);
        file[12] = sh_degree;
        file[13] = 12;
        file[14] = 0;
        file[15] = streams.len() as u8;
        write_u32_at(&mut file, 16, toc_offset as u32);

        for (index, (stream, uncompressed_size)) in streams.iter().enumerate() {
            let entry = toc_offset + index * TOC_ENTRY_SIZE;
            write_u64_at(&mut file, entry, stream.len() as u64);
            write_u64_at(&mut file, entry + 8, *uncompressed_size);
            file.extend_from_slice(stream);
        }

        file
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

        let compressed = compress_to_vec(&raw, 6);
        let mut gzip = vec![0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0];
        gzip.extend_from_slice(&compressed);
        gzip.extend_from_slice(&[0; 8]);
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
