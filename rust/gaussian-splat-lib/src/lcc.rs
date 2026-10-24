//! LCC 5.0 COMPRESS records, based on XGRIDS LCCWhitepaper revision
//! b38c2eb31be24e4220f23c69c4a0f3306356920e. Coordinates remain source-local.

use anyhow::{ensure, Context};
use serde::Deserialize;

use crate::decoder::{SplatInit, SplatProps, SplatReceiver};

const BATCH: usize = 1024;
const DEFAULT_MAX_POINTS: usize = 1_000_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub enum LccFileType {
    Portable,
    Quality,
}

/// Metadata is explicit because an LCC byte range has no self-describing header.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LccDecodeContext {
    pub version: String,
    pub encoding: String,
    pub file_type: LccFileType,
    pub count: usize,
    #[serde(default = "default_max_points")]
    pub max_points: usize,
    #[serde(default)]
    pub environment: bool,
    pub scale_min: [f32; 3],
    pub scale_max: [f32; 3],
    pub sh_min: Option<[f32; 3]>,
    pub sh_max: Option<[f32; 3]>,
}

fn default_max_points() -> usize {
    DEFAULT_MAX_POINTS
}

impl LccDecodeContext {
    pub fn from_json(json: &str) -> anyhow::Result<Self> {
        ensure!(
            json.len() <= 16 * 1024,
            "LCC: decode context byte limit exceeded"
        );
        let context: Self = serde_json::from_str(json).context("LCC: invalid decode context")?;
        context.validate()?;
        Ok(context)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(self.version == "5.0", "LCC: unsupported version");
        ensure!(self.encoding == "COMPRESS", "LCC: unsupported encoding");
        ensure!(
            self.max_points > 0 && self.count <= self.max_points,
            "LCC: decode point limit exceeded"
        );
        validate_range(self.scale_min, self.scale_max)?;
        ensure!(
            self.scale_min.iter().all(|v| *v >= 0.0),
            "LCC: scales must be physical and nonnegative"
        );
        if self.file_type == LccFileType::Quality {
            validate_range(
                self.sh_min.context("LCC: missing Quality shMin")?,
                self.sh_max.context("LCC: missing Quality shMax")?,
            )?;
        }
        Ok(())
    }

    /// Validate lengths before the WASM bridge copies input or allocates output.
    pub fn validate_lengths(&self, base_length: usize, sh_length: usize) -> anyhow::Result<()> {
        self.validate()?;
        let quality = self.file_type == LccFileType::Quality;
        let stride = if self.environment && quality { 96 } else { 32 };
        let expected_base = self
            .count
            .checked_mul(stride)
            .context("LCC: base size overflow")?;
        let expected_sh = if quality && !self.environment {
            self.count
                .checked_mul(64)
                .context("LCC: SH size overflow")?
        } else {
            0
        };
        ensure!(
            base_length == expected_base,
            "LCC: base length/count mismatch"
        );
        ensure!(
            sh_length == expected_sh,
            "LCC: missing, truncated, or unexpected SH payload"
        );
        Ok(())
    }
}

fn validate_range(min: [f32; 3], max: [f32; 3]) -> anyhow::Result<()> {
    ensure!(
        (0..3).all(|d| min[d].is_finite() && max[d].is_finite() && min[d] <= max[d]),
        "LCC: invalid quantization range"
    );
    Ok(())
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn lerp(min: f32, max: f32, code: u32, denominator: u32) -> f32 {
    // f64 subtraction avoids overflow for finite, opposite-sign f32 endpoints.
    (f64::from(min) + (f64::from(max) - f64::from(min)) * f64::from(code) / f64::from(denominator))
        as f32
}

fn decode_rotation(word: u32) -> [f32; 4] {
    const ORDER: [[usize; 4]; 4] = [[3, 0, 1, 2], [0, 3, 1, 2], [0, 1, 3, 2], [0, 1, 2, 3]];
    let mut stored = [0.0; 4];
    for (d, value) in stored.iter_mut().take(3).enumerate() {
        *value = ((word >> (10 * d)) & 1023) as f32 / 1023.0 * std::f32::consts::SQRT_2
            - std::f32::consts::FRAC_1_SQRT_2;
    }
    let sum: f32 = stored[..3].iter().map(|v| v * v).sum();
    stored[3] = (1.0 - sum.clamp(0.0, 1.0)).sqrt();
    let mut quat = ORDER[(word >> 30) as usize].map(|d| stored[d]);
    let norm = quat.iter().map(|v| v * v).sum::<f32>().sqrt();
    for value in &mut quat {
        *value /= norm;
    }
    quat
}

fn decode_sh(bytes: &[u8], min: [f32; 3], max: [f32; 3]) -> [f32; 45] {
    let mut values = [0.0; 45];
    for k in 0..15 {
        let word = read_u32(bytes, k * 4);
        let codes = [word & 2047, (word >> 11) & 1023, (word >> 21) & 2047];
        for d in 0..3 {
            values[k * 3 + d] = lerp(min[d], max[d], codes[d], [2047, 1023, 2047][d]);
        }
    }
    // The whitepaper reads 15 words; the final four bytes are reserved padding.
    values
}

/// Decode exact record ranges in source order, including transparent records.
/// For environment data `base` contains interleaved base+SH and `sh` is empty.
/// Normals are unused. No global transform, basis conversion, or reprojection is applied.
pub fn decode_lcc<R: SplatReceiver>(
    base: &[u8],
    sh: &[u8],
    context: &LccDecodeContext,
    mut receiver: R,
) -> anyhow::Result<R> {
    context.validate_lengths(base.len(), sh.len())?;
    let quality = context.file_type == LccFileType::Quality;
    let stride = if context.environment && quality {
        96
    } else {
        32
    };
    // Reject bad records before initializing or publishing receiver storage.
    for record in base.chunks_exact(stride) {
        for d in 0..3 {
            ensure!(
                f32::from_bits(read_u32(record, d * 4)).is_finite(),
                "LCC: nonfinite position"
            );
        }
    }
    receiver.reserve_decoder_memory(1024 * 1024)?;
    receiver.init_splats(&SplatInit {
        num_splats: context.count,
        max_sh_degree: if quality { 3 } else { 0 },
    })?;
    let mut center = [0.0; BATCH * 3];
    let mut rgb = [0.0; BATCH * 3];
    let mut opacity = [0.0; BATCH];
    let mut scale = [0.0; BATCH * 3];
    let mut quat = [0.0; BATCH * 4];
    let mut sh1 = [0.0; BATCH * 9];
    let mut sh2 = [0.0; BATCH * 15];
    let mut sh3 = [0.0; BATCH * 21];
    for start in (0..context.count).step_by(BATCH) {
        let count = BATCH.min(context.count - start);
        for i in 0..count {
            let index = start + i;
            let record = &base[index * stride..index * stride + 32];
            for d in 0..3 {
                center[i * 3 + d] = f32::from_bits(read_u32(record, d * 4));
                rgb[i * 3 + d] = record[12 + d] as f32 / 255.0;
                let code = u16::from_le_bytes(record[16 + d * 2..18 + d * 2].try_into().unwrap());
                scale[i * 3 + d] = lerp(
                    context.scale_min[d],
                    context.scale_max[d],
                    u32::from(code),
                    65535,
                );
            }
            opacity[i] = record[15] as f32 / 255.0;
            // Rotation starts at byte 22, not the next aligned u32 at byte 24.
            quat[i * 4..i * 4 + 4].copy_from_slice(&decode_rotation(read_u32(record, 22)));
            if quality {
                let encoded = if context.environment {
                    &base[index * stride + 32..index * stride + 96]
                } else {
                    &sh[index * 64..index * 64 + 64]
                };
                let values = decode_sh(encoded, context.sh_min.unwrap(), context.sh_max.unwrap());
                sh1[i * 9..i * 9 + 9].copy_from_slice(&values[..9]);
                sh2[i * 15..i * 15 + 15].copy_from_slice(&values[9..24]);
                sh3[i * 21..i * 21 + 21].copy_from_slice(&values[24..]);
            }
        }
        receiver.set_batch(
            start,
            count,
            &SplatProps {
                center: &center[..count * 3],
                rgb: &rgb[..count * 3],
                opacity: &opacity[..count],
                scale: &scale[..count * 3],
                quat: &quat[..count * 4],
                sh1: if quality { &sh1[..count * 9] } else { &[] },
                sh2: if quality { &sh2[..count * 15] } else { &[] },
                sh3: if quality { &sh3[..count * 21] } else { &[] },
                ..Default::default()
            },
        );
    }
    receiver.finish()?;
    Ok(receiver)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::splat_encode::{
        decode_splat_ln_scale, decode_splat_quat, encode_splat_quat, encode_splat_scale,
    };

    #[derive(Debug, Default)]
    struct Capture {
        initialized: bool,
        finished: bool,
        centers: Vec<f32>,
        scales: Vec<f32>,
        quats: Vec<f32>,
        colors: Vec<f32>,
        opacity: Vec<f32>,
        sh: [Vec<f32>; 3],
    }
    impl SplatReceiver for Capture {
        fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
            self.initialized = true;
            self.centers.resize(init.num_splats * 3, 0.0);
            Ok(())
        }
        fn finish(&mut self) -> anyhow::Result<()> {
            self.finished = true;
            Ok(())
        }
        fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
            self.centers[base * 3..(base + count) * 3].copy_from_slice(batch.center);
            self.scales.extend(batch.scale);
            self.quats.extend(batch.quat);
            self.colors.extend(batch.rgb);
            self.opacity.extend(batch.opacity);
            self.sh[0].extend(batch.sh1);
            self.sh[1].extend(batch.sh2);
            self.sh[2].extend(batch.sh3);
        }
        fn set_center(&mut self, _: usize, _: usize, _: &[f32]) {
            unreachable!()
        }
        fn set_opacity(&mut self, _: usize, _: usize, _: &[f32]) {
            unreachable!()
        }
        fn set_rgb(&mut self, _: usize, _: usize, _: &[f32]) {
            unreachable!()
        }
        fn set_scale(&mut self, _: usize, _: usize, _: &[f32]) {
            unreachable!()
        }
        fn set_quat(&mut self, _: usize, _: usize, _: &[f32]) {
            unreachable!()
        }
    }
    fn context(quality: bool, count: usize) -> LccDecodeContext {
        LccDecodeContext {
            version: "5.0".into(),
            encoding: "COMPRESS".into(),
            file_type: if quality {
                LccFileType::Quality
            } else {
                LccFileType::Portable
            },
            count,
            max_points: DEFAULT_MAX_POINTS,
            environment: false,
            scale_min: [0.0, 1.0, 2.0],
            scale_max: [1.0, 3.0, 5.0],
            sh_min: Some([-1.0, -2.0, -3.0]),
            sh_max: Some([2.0, 4.0, 6.0]),
        }
    }
    fn record(omitted: u32, alpha: u8) -> [u8; 32] {
        let mut bytes = [0; 32];
        for (d, v) in [1.25f32, -2.5, 3.75].into_iter().enumerate() {
            bytes[d * 4..d * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        bytes[12..16].copy_from_slice(&[0, 127, 255, alpha]);
        for (d, code) in [0u16, 32768, 65535].into_iter().enumerate() {
            bytes[16 + d * 2..18 + d * 2].copy_from_slice(&code.to_le_bytes());
        }
        let rotation = 512 | (512 << 10) | (512 << 20) | (omitted << 30);
        bytes[22..26].copy_from_slice(&rotation.to_le_bytes());
        bytes[26..32].fill(0xff); // Detect accidentally aligned rotation reads.
        bytes
    }
    fn close(a: f32, b: f32, tolerance: f32) {
        assert!((a - b).abs() <= tolerance, "{a} != {b}");
    }

    #[test]
    fn portable_physical_scales_rgba_and_unaligned_quaternion() {
        for omitted in 0..4 {
            for alpha in [0, 255] {
                let decoded = decode_lcc(
                    &record(omitted, alpha),
                    &[],
                    &context(false, 1),
                    Capture::default(),
                )
                .unwrap();
                assert!(decoded.initialized && decoded.finished);
                assert_eq!(decoded.centers, [1.25, -2.5, 3.75]);
                assert_eq!(decoded.colors, [0.0, 127.0 / 255.0, 1.0]);
                assert_eq!(decoded.opacity, [alpha as f32 / 255.0]);
                close(decoded.scales[0], 0.0, 0.0);
                close(decoded.scales[1], 1.0 + 32768.0 / 65535.0 * 2.0, 1e-6);
                close(decoded.scales[2], 5.0, 0.0);
                close(decoded.quats[omitted as usize], 1.0, 2e-6);
                close(decoded.quats.iter().map(|v| v * v).sum(), 1.0, 1e-6);
                let mut packed = [0; 4];
                encode_splat_scale(&mut packed, decoded.scales.clone().try_into().unwrap());
                assert_eq!(decode_splat_ln_scale(&packed)[0], f32::NEG_INFINITY);
                close(decode_splat_ln_scale(&packed)[2].exp(), 5.0, 0.002);
                encode_splat_quat(&mut packed, decoded.quats.clone().try_into().unwrap());
                let repacked = decode_splat_quat(&packed);
                let dot: f32 = repacked
                    .iter()
                    .zip(&decoded.quats)
                    .map(|(a, b)| a * b)
                    .sum();
                assert!(dot.abs() > 0.99999);
                assert!(decoded.sh.iter().all(Vec::is_empty));
            }
        }
    }

    #[test]
    fn quaternion_component_order_and_signs() {
        let codes = [128u32, 512, 900];
        let values = codes.map(|v| {
            v as f32 / 1023.0 * std::f32::consts::SQRT_2 - std::f32::consts::FRAC_1_SQRT_2
        });
        let missing = (1.0 - values.iter().map(|v| v * v).sum::<f32>()).sqrt();
        let [a, b, c] = values;
        let expected = [
            [missing, a, b, c],
            [a, missing, b, c],
            [a, b, missing, c],
            [a, b, c, missing],
        ];
        for omitted in 0..4 {
            let q = decode_rotation(codes[0] | codes[1] << 10 | codes[2] << 20 | omitted << 30);
            for d in 0..4 {
                close(q[d], expected[omitted as usize][d], 1e-6);
            }
        }
    }

    #[test]
    fn quaternion_saturation_stays_finite_and_unit_length() {
        for omitted in 0..4 {
            let q = decode_rotation(0x3fff_ffff | omitted << 30);
            assert!(q.iter().all(|v| v.is_finite()));
            close(q.iter().map(|v| v * v).sum(), 1.0, 1e-6);
        }
    }

    #[test]
    fn quality_all_coefficients_channels_and_reserved_padding() {
        let mut sh = [0; 64];
        for k in 0..15 {
            let word: u32 = match k % 3 {
                0 => 2047,
                1 => 1023 << 11,
                _ => 2047 << 21,
            };
            sh[k * 4..k * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        sh[60..].fill(0xff);
        let decoded =
            decode_lcc(&record(3, 255), &sh, &context(true, 1), Capture::default()).unwrap();
        assert_eq!(decoded.sh.each_ref().map(|v| v.len()), [9, 15, 21]);
        let from_receiver: Vec<f32> = decoded.sh.into_iter().flatten().collect();
        let decoded = decode_sh(&sh, [-1.0, -2.0, -3.0], [2.0, 4.0, 6.0]);
        assert_eq!(from_receiver, decoded);
        for k in 0..15 {
            for d in 0..3 {
                assert_eq!(
                    decoded[k * 3 + d],
                    if k % 3 == d {
                        [2.0, 4.0, 6.0][d]
                    } else {
                        [-1.0, -2.0, -3.0][d]
                    }
                );
            }
        }
        // A non-extreme word distinguishes 11/10/11 bit placement and divisors.
        let word = 19u32 | (37 << 11) | (59 << 21);
        sh[..4].copy_from_slice(&word.to_le_bytes());
        let decoded = decode_sh(&sh, [0.0; 3], [1.0; 3]);
        close(decoded[0], 19.0 / 2047.0, 1e-7);
        close(decoded[1], 37.0 / 1023.0, 1e-7);
        close(decoded[2], 59.0 / 2047.0, 1e-7);
    }

    #[test]
    fn environment_interleaves_each_record_and_uses_distinct_ranges() {
        for quality in [false, true] {
            let mut ctx = context(quality, 2);
            ctx.environment = true;
            ctx.scale_min = [10.0; 3];
            ctx.scale_max = [20.0; 3];
            ctx.sh_min = Some([100.0; 3]);
            ctx.sh_max = Some([200.0; 3]);
            let mut bytes = Vec::new();
            for alpha in [0, 255] {
                bytes.extend(record(3, alpha));
                if quality {
                    bytes.extend([if alpha == 0 { 0 } else { 255 }; 64]);
                }
            }
            let decoded = decode_lcc(&bytes, &[], &ctx, Capture::default()).unwrap();
            assert_eq!(decoded.opacity, [0.0, 1.0]);
            assert_eq!(decoded.scales[0], 10.0);
            assert_eq!(decoded.scales[2], 20.0);
            if quality {
                for (band, stride) in decoded.sh.iter().zip([9, 15, 21]) {
                    assert_eq!(&band[..stride], vec![100.0; stride]);
                    assert_eq!(&band[stride..], vec![200.0; stride]);
                }
            }
        }
    }

    #[test]
    fn invalid_context_lengths_positions_and_admission_fail() {
        let base = record(3, 255);
        let mut ctx = context(true, 1);
        assert!(decode_lcc(&base, &[], &ctx, Capture::default()).is_err());
        assert!(decode_lcc(&base, &[0; 63], &ctx, Capture::default()).is_err());
        ctx.file_type = LccFileType::Portable;
        assert!(decode_lcc(&base[..31], &[], &ctx, Capture::default()).is_err());
        assert!(decode_lcc(&base, &[0; 64], &ctx, Capture::default()).is_err());
        let mut bad = base;
        bad[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode_lcc(&bad, &[], &ctx, Capture::default()).is_err());
        bad[..4].copy_from_slice(&f32::INFINITY.to_le_bytes());
        assert!(decode_lcc(&bad, &[], &ctx, Capture::default()).is_err());
        ctx.scale_min[0] = -1.0;
        assert!(ctx.validate().is_err());
        ctx.scale_min[0] = 2.0;
        assert!(ctx.validate().is_err());
        ctx.scale_min[0] = f32::NAN;
        assert!(ctx.validate().is_err());
        ctx = context(true, 1);
        ctx.sh_min = None;
        assert!(ctx.validate().is_err());
        ctx = context(true, 1);
        ctx.version = "6.0".into();
        assert!(ctx.validate().is_err());
        ctx = context(true, 1);
        ctx.encoding = "gzip".into();
        assert!(ctx.validate().is_err());
        ctx = context(true, 2);
        ctx.max_points = 1;
        assert!(ctx.validate().is_err());
        ctx = context(false, usize::MAX);
        ctx.max_points = usize::MAX;
        assert!(ctx.validate_lengths(0, 0).is_err());
        assert!(LccDecodeContext::from_json("{}").is_err());
        assert!(LccDecodeContext::from_json(&" ".repeat(16385)).is_err());
        assert!(lerp(-f32::MAX, f32::MAX, 32768, 65535).is_finite());
        let parsed = LccDecodeContext::from_json(r#"{"version":"5.0","encoding":"COMPRESS","fileType":"Portable","count":0,"scaleMin":[0,0,0],"scaleMax":[1,1,1]}"#).unwrap();
        assert_eq!(parsed.max_points, DEFAULT_MAX_POINTS);
        assert!(!parsed.environment);
        assert!(LccDecodeContext::from_json(r#"{"version":"5.0","encoding":"COMPRESS","fileType":"Guess","count":0,"scaleMin":[0,0,0],"scaleMax":[1,1,1]}"#).is_err());
    }

    fn check_export_numerical_ranges(manifest: &std::path::Path) -> anyhow::Result<Vec<Capture>> {
        use std::{
            fs::File,
            io::{ErrorKind, Read, Seek, SeekFrom},
        };
        let meta: serde_json::Value = serde_json::from_reader(File::open(manifest)?)?;
        let directory = manifest
            .parent()
            .context("manifest needs a parent directory")?;
        let companion = |lower: &str, capitalized: &str| {
            File::open(directory.join(lower)).or_else(|error| {
                if error.kind() == ErrorKind::NotFound {
                    File::open(directory.join(capitalized))
                } else {
                    Err(error)
                }
            })
        };
        let quality = serde_json::from_value::<LccFileType>(meta["fileType"].clone())?
            == LccFileType::Quality;
        let mut samples = Vec::new();
        for environment in [false, true] {
            let mut input = if environment {
                match companion("environment.bin", "Environment.bin") {
                    Ok(file) => file,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                }
            } else {
                companion("data.bin", "Data.bin")?
            };
            let scale_name = if environment { "envscale" } else { "scale" };
            let sh_name = if environment { "envshcoef" } else { "shcoef" };
            let attributes = meta["attributes"]
                .as_array()
                .context("missing attributes")?;
            let scale = attributes
                .iter()
                .find(|a| a["name"] == scale_name)
                .context("missing scale range")?;
            let sh_range = attributes.iter().find(|a| a["name"] == sh_name);
            let stride = if environment && quality { 96 } else { 32 };
            let length = input.metadata()?.len();
            ensure!(length % stride == 0, "base length/stride mismatch");
            let records = length / stride;
            let count = records.min(10_000) as usize;
            let ctx = LccDecodeContext::from_json(&serde_json::json!({
                "version": meta["version"], "encoding": meta["encoding"], "fileType": meta["fileType"],
                "count": count, "maxPoints": count.max(1), "environment": environment,
                "scaleMin": scale["min"], "scaleMax": scale["max"],
                "shMin": sh_range.map(|a| &a["min"]), "shMax": sh_range.map(|a| &a["max"]),
            }).to_string())?;
            let mut sh_input = if quality && !environment {
                let file = companion("shcoef.bin", "Shcoef.bin")?;
                ensure!(
                    file.metadata()?.len() == records * 64,
                    "SH length/count mismatch"
                );
                Some(file)
            } else {
                None
            };
            let mut base = vec![0; count * stride as usize];
            let mut sh = vec![0; if sh_input.is_some() { count * 64 } else { 0 }];
            for i in 0..count {
                let index = i as u64 * records / count as u64;
                input.seek(SeekFrom::Start(index * stride))?;
                input.read_exact(&mut base[i * stride as usize..(i + 1) * stride as usize])?;
                if let Some(input) = &mut sh_input {
                    input.seek(SeekFrom::Start(index * 64))?;
                    input.read_exact(&mut sh[i * 64..(i + 1) * 64])?;
                }
            }
            let decoded = decode_lcc(&base, &sh, &ctx, Capture::default())?;
            for i in 0..count {
                assert_eq!(
                    decoded.centers[i * 3],
                    f32::from_bits(read_u32(&base, i * stride as usize))
                );
                for d in 0..3 {
                    let scale = decoded.scales[i * 3 + d];
                    assert!(scale >= ctx.scale_min[d] && scale <= ctx.scale_max[d]);
                }
                let norm: f32 = decoded.quats[i * 4..i * 4 + 4].iter().map(|v| v * v).sum();
                close(norm, 1.0, 2e-6);
            }
            for band in &decoded.sh {
                for rgb in band.chunks_exact(3) {
                    for d in 0..3 {
                        assert!(
                            rgb[d].is_finite()
                                && rgb[d] >= ctx.sh_min.unwrap()[d]
                                && rgb[d] <= ctx.sh_max.unwrap()[d]
                        );
                    }
                }
            }
            let ranges: Vec<(f32, f32)> = (0..3)
                .map(|d| {
                    decoded
                        .scales
                        .iter()
                        .skip(d)
                        .step_by(3)
                        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), v| {
                            (lo.min(*v), hi.max(*v))
                        })
                })
                .collect();
            let sh_range = decoded
                .sh
                .iter()
                .flatten()
                .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), v| {
                    (lo.min(*v), hi.max(*v))
                });
            eprintln!(
                "LCC sample: environment={environment}, samples={count}, physical scales={ranges:?}, SH={sh_range:?}; positions finite, quaternions normalized"
            );
            samples.push(decoded);
        }
        Ok(samples)
    }

    #[test]
    #[ignore = "requires a private export supplied through LCC_SAMPLE"]
    fn real_export_numerical_ranges() {
        let manifest = std::env::var_os("LCC_SAMPLE").expect("set LCC_SAMPLE");
        check_export_numerical_ranges(std::path::Path::new(&manifest)).unwrap();
    }

    #[test]
    fn export_harness_accepts_profiles_optional_environment_and_companion_casing() {
        use std::{fs, io::ErrorKind, time::SystemTime};
        let directory = std::env::temp_dir().join(format!(
            "lcc-harness-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let result = (|| -> anyhow::Result<()> {
            // Synthetic records test the harness, not genuine-export compatibility.
            for (quality, capitalized, environment) in [
                (false, false, false),
                (true, false, false),
                (false, true, true),
                (true, true, true),
            ] {
                let name = |lower, upper| if capitalized { upper } else { lower };
                let mut attributes = vec![serde_json::json!({
                    "name": "scale", "min": [0, 1, 2], "max": [1, 3, 5]
                })];
                if quality {
                    attributes.push(serde_json::json!({
                        "name": "shcoef", "min": [-1, -2, -3], "max": [2, 4, 6]
                    }));
                }
                if environment {
                    attributes.push(serde_json::json!({
                        "name": "envscale", "min": [10, 20, 30], "max": [12, 24, 36]
                    }));
                    if quality {
                        attributes.push(serde_json::json!({
                            "name": "envshcoef", "min": [100, 200, 300], "max": [110, 220, 330]
                        }));
                    }
                }
                let manifest = directory.join("synthetic.lcc");
                let mut meta = serde_json::json!({
                    "version": "5.0", "encoding": "COMPRESS",
                    "fileType": if quality { "Quality" } else { "Portable" },
                    "attributes": attributes
                });
                fs::write(&manifest, meta.to_string())?;
                let data = directory.join(name("data.bin", "Data.bin"));
                fs::write(&data, [record(3, 0), record(3, 255)].concat())?;
                let sh = directory.join(name("shcoef.bin", "Shcoef.bin"));
                if quality {
                    fs::write(&sh, [[0; 64], [255; 64]].concat())?;
                }
                let env = directory.join(name("environment.bin", "Environment.bin"));
                if environment {
                    let mut bytes = Vec::new();
                    for alpha in [0, 255] {
                        bytes.extend(record(3, alpha));
                        if quality {
                            bytes.extend([alpha; 64]);
                        }
                    }
                    fs::write(&env, bytes)?;
                }
                let samples = check_export_numerical_ranges(&manifest)?;
                assert_eq!(samples.len(), if environment { 2 } else { 1 });
                for (index, decoded) in samples.iter().enumerate() {
                    assert!(decoded.initialized && decoded.finished);
                    assert_eq!(decoded.centers, [1.25, -2.5, 3.75].repeat(2));
                    assert_eq!(decoded.colors, [0.0, 127.0 / 255.0, 1.0].repeat(2));
                    assert_eq!(decoded.opacity, [0.0, 1.0]);
                    let expected_scale = if index == 0 {
                        [0.0, 1.0 + 2.0 * 32768.0 / 65535.0, 5.0]
                    } else {
                        [10.0, 20.0 + 4.0 * 32768.0 / 65535.0, 36.0]
                    };
                    for scale in decoded.scales.chunks_exact(3) {
                        for d in 0..3 {
                            close(scale[d], expected_scale[d], 2e-6);
                        }
                    }
                    for (band, stride) in decoded.sh.iter().zip([9, 15, 21]) {
                        assert_eq!(band.len(), if quality { 2 * stride } else { 0 });
                        if quality {
                            let (min, max) = if index == 0 {
                                ([-1.0, -2.0, -3.0], [2.0, 4.0, 6.0])
                            } else {
                                ([100.0, 200.0, 300.0], [110.0, 220.0, 330.0])
                            };
                            assert_eq!(band[..stride], min.repeat(stride / 3));
                            assert_eq!(band[stride..], max.repeat(stride / 3));
                        }
                    }
                }
                if environment {
                    let bytes = fs::read(&env)?;
                    fs::write(&env, [0; 31])?;
                    assert!(check_export_numerical_ranges(&manifest)
                        .unwrap_err()
                        .to_string()
                        .contains("base length/stride mismatch"));
                    fs::write(&env, bytes)?;
                }
                if quality {
                    fs::remove_file(&sh)?;
                    assert_eq!(
                        check_export_numerical_ranges(&manifest)
                            .unwrap_err()
                            .downcast_ref::<std::io::Error>()
                            .unwrap()
                            .kind(),
                        ErrorKind::NotFound
                    );
                    fs::write(&sh, [0; 127])?;
                    assert!(check_export_numerical_ranges(&manifest)
                        .unwrap_err()
                        .to_string()
                        .contains("SH length"));
                    fs::write(&sh, [0; 128])?;
                    meta["attributes"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|a| a["name"] != if environment { "envshcoef" } else { "shcoef" });
                    fs::write(&manifest, meta.to_string())?;
                    assert!(check_export_numerical_ranges(&manifest)
                        .unwrap_err()
                        .to_string()
                        .contains("missing Quality shMin"));
                    fs::remove_file(sh)?;
                }
                let unsupported = directory.join("other-data.bin");
                fs::rename(&data, &unsupported)?;
                assert_eq!(
                    check_export_numerical_ranges(&manifest)
                        .unwrap_err()
                        .downcast_ref::<std::io::Error>()
                        .unwrap()
                        .kind(),
                    ErrorKind::NotFound
                );
                fs::remove_file(unsupported)?;
                if environment {
                    fs::remove_file(env)?;
                }
            }
            Ok(())
        })();
        fs::remove_dir_all(directory).unwrap();
        result.unwrap();
    }

    #[test]
    fn empty_and_multiple_batches_preserve_source_order() {
        let empty = decode_lcc(&[], &[], &context(false, 0), Capture::default()).unwrap();
        assert!(empty.initialized && empty.finished && empty.centers.is_empty());
        let count = BATCH + 3;
        let mut base = Vec::new();
        for i in 0..count {
            let mut r = record(3, if i % 2 == 0 { 0 } else { 255 });
            r[..4].copy_from_slice(&(i as f32).to_le_bytes());
            base.extend(r);
        }
        let decoded = decode_lcc(&base, &[], &context(false, count), Capture::default()).unwrap();
        for i in 0..count {
            assert_eq!(decoded.centers[i * 3], i as f32);
            assert_eq!(decoded.opacity[i], (i % 2) as f32);
        }
    }
}
