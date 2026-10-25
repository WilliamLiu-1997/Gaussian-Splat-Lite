//! XGRIDS LCC COMPRESS records. Data organization format originated from XGRIDS.
use crate::decoder::{SplatInit, SplatProps, SplatReceiver};
use anyhow::{ensure, Result};

/// Decode one indexed node, or interleaved environment records, into the usual
/// receiver. Ranges are scale min/max followed by SH min/max, each XYZ.
pub fn decode_lcc<R: SplatReceiver>(
    data: &[u8],
    sh: Option<&[u8]>,
    interleaved_sh: bool,
    ranges: &[f32],
    mut receiver: R,
) -> Result<R> {
    ensure!(
        ranges.len() == 12 && ranges.iter().all(|v| v.is_finite()),
        "LCC: invalid quantization ranges"
    );
    let stride = if interleaved_sh { 96 } else { 32 };
    ensure!(data.len() % stride == 0, "LCC: truncated base records");
    let count = data.len() / stride;
    if let Some(sh) = sh {
        ensure!(
            !interleaved_sh && sh.len() == count * 64,
            "LCC: SH record count mismatch"
        );
    }
    let has_sh = interleaved_sh || sh.is_some();
    receiver.init_splats(&SplatInit {
        num_splats: count,
        max_sh_degree: if has_sh { 3 } else { 0 },
    })?;
    let word = |bytes: &[u8], offset: usize| {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    };
    // Bound decoder scratch independently of the node size.
    for base in (0..count).step_by(1024) {
        let len = (count - base).min(1024);
        let mut centers = Vec::with_capacity(len * 3);
        let mut colors = Vec::with_capacity(len * 3);
        let mut scales = Vec::with_capacity(len * 3);
        let mut opacity = Vec::with_capacity(len);
        let mut quats = Vec::with_capacity(len * 4);
        let mut coefficients = [Vec::new(), Vec::new(), Vec::new()];
        for index in base..base + len {
            let record = &data[index * stride..(index + 1) * stride];
            for axis in 0..3 {
                let center = f32::from_bits(word(record, axis * 4));
                ensure!(center.is_finite(), "LCC: non-finite position");
                centers.push(center);
                colors.push(record[12 + axis] as f32 / 255.0);
                let code =
                    u16::from_le_bytes(record[16 + axis * 2..18 + axis * 2].try_into().unwrap());
                let scale =
                    ranges[axis] + (ranges[axis + 3] - ranges[axis]) * (code as f32 / 65535.0);
                ensure!(scale >= 0.0, "LCC: negative scale");
                scales.push(scale);
            }
            opacity.push(record[15] as f32 / 255.0);
            let encoded = word(record, 22);
            let mut quat = [0.0; 4];
            let omitted = (encoded >> 30) as usize;
            let mut component = 0;
            let mut squared = 0.0;
            for (axis, value) in quat.iter_mut().enumerate() {
                if axis == omitted {
                    continue;
                }
                *value = ((encoded >> (component * 10)) & 1023) as f32 / 1023.0
                    * std::f32::consts::SQRT_2
                    - std::f32::consts::FRAC_1_SQRT_2;
                squared += *value * *value;
                component += 1;
            }
            quat[omitted] = (1.0 - squared).max(0.0).sqrt();
            quats.extend_from_slice(&quat);
            if has_sh {
                let bytes = if interleaved_sh {
                    &record[32..96]
                } else {
                    &sh.unwrap()[index * 64..(index + 1) * 64]
                };
                for coefficient in 0..15 {
                    let encoded = word(bytes, coefficient * 4);
                    let codes = [
                        (encoded & 2047) as f32 / 2047.0,
                        ((encoded >> 11) & 1023) as f32 / 1023.0,
                        (encoded >> 21) as f32 / 2047.0,
                    ];
                    let band = if coefficient < 3 {
                        0
                    } else if coefficient < 8 {
                        1
                    } else {
                        2
                    };
                    for (axis, code) in codes.into_iter().enumerate() {
                        coefficients[band]
                            .push(ranges[6 + axis] + (ranges[9 + axis] - ranges[6 + axis]) * code);
                    }
                }
            }
        }
        receiver.set_batch(
            base,
            len,
            &SplatProps {
                center: &centers,
                opacity: &opacity,
                rgb: &colors,
                scale: &scales,
                quat: &quats,
                sh1: &coefficients[0],
                sh2: &coefficients[1],
                sh3: &coefficients[2],
                ..Default::default()
            },
        );
    }
    receiver.finish()?;
    Ok(receiver)
}
