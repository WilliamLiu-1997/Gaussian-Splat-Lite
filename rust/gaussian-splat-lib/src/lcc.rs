//! XGRIDS LCC "COMPRESS" records into a SplatReceiver, following the LCC
//! whitepaper and PlayCanvas splat-transform's reader. Data organization
//! format originated from XGRIDS.
use anyhow::{ensure, Result};

use crate::decoder::{SplatProps, SplatReceiver};

/// Position, RGBA, scale, rotation and normal of one splat in data.bin.
pub const LCC_RECORD_BYTES: usize = 32;
/// Fifteen packed RGB coefficients and four reserved bytes in shcoef.bin.
pub const LCC_SH_BYTES: usize = 64;
/// Records per receiver batch; callers can copy input in pieces of this size.
pub const LCC_BATCH: usize = 4096;

const SQRT_2: f32 = std::f32::consts::SQRT_2;
const FRAC_1_SQRT_2: f32 = std::f32::consts::FRAC_1_SQRT_2;
// Component placement of the reconstructed value, by the stored 2-bit index.
const QUAT_ORDER: [[usize; 4]; 4] = [[3, 0, 1, 2], [0, 3, 1, 2], [0, 1, 3, 2], [0, 1, 2, 3]];

/// Linear dequantization ranges from the `scale` and `shcoef` attributes
/// (or their `env` variants) of meta.lcc.
#[derive(Clone, Copy, Debug)]
pub struct LccRanges {
    pub scale_min: [f32; 3],
    pub scale_max: [f32; 3],
    pub sh_min: [f32; 3],
    pub sh_max: [f32; 3],
}

/// Where a batch's SH records are stored relative to its base records.
#[derive(Clone, Copy, Debug)]
pub enum LccSh<'a> {
    None,
    /// shcoef.bin: one 64-byte record per splat.
    Separate(&'a [u8]),
    /// environment.bin: each 32-byte record is followed by its 64 SH bytes.
    Interleaved,
}

impl LccSh<'_> {
    pub fn record_bytes(&self) -> usize {
        match self {
            Self::Interleaved => LCC_RECORD_BYTES + LCC_SH_BYTES,
            _ => LCC_RECORD_BYTES,
        }
    }

    pub fn degree(&self) -> usize {
        if matches!(self, Self::None) {
            0
        } else {
            3
        }
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn mix(min: f32, max: f32, t: f32) -> f32 {
    (1.0 - t) * min + t * max
}

/// Smallest-three quaternion: three 10-bit components and the index of the
/// omitted largest one, returned as XYZW.
pub fn decode_lcc_rotation(word: u32) -> [f32; 4] {
    let mut q = [0.0; 4];
    for (d, value) in q.iter_mut().take(3).enumerate() {
        *value = ((word >> (10 * d)) & 1023) as f32 / 1023.0 * SQRT_2 - FRAC_1_SQRT_2;
    }
    q[3] = (1.0 - (q[0] * q[0] + q[1] * q[1] + q[2] * q[2]).min(1.0)).sqrt();
    QUAT_ORDER[(word >> 30) as usize].map(|d| q[d])
}

/// Batch storage reused across calls; the receiver must already be initialized
/// for the total splat count and the layout's SH degree.
pub struct LccDecoder {
    ranges: LccRanges,
    center: Vec<f32>,
    opacity: Vec<f32>,
    rgb: Vec<f32>,
    scale: Vec<f32>,
    quat: Vec<f32>,
    // Bands 1, 2 and 3 hold 3, 5 and 7 RGB coefficients.
    sh: [Vec<f32>; 3],
}

impl LccDecoder {
    pub fn new(ranges: LccRanges) -> Self {
        Self {
            ranges,
            center: Vec::new(),
            opacity: Vec::new(),
            rgb: Vec::new(),
            scale: Vec::new(),
            quat: Vec::new(),
            sh: Default::default(),
        }
    }

    /// Decodes whole records starting at splat `start`. Normals are not used.
    pub fn decode<R: SplatReceiver>(
        &mut self,
        receiver: &mut R,
        start: usize,
        records: &[u8],
        sh: LccSh,
    ) -> Result<()> {
        let stride = sh.record_bytes();
        ensure!(
            records.len().is_multiple_of(stride),
            "LCC: record data is not a whole number of records"
        );
        let count = records.len() / stride;
        if let LccSh::Separate(sh) = sh {
            ensure!(
                sh.len() == count * LCC_SH_BYTES,
                "LCC: SH data length does not match the record count"
            );
        }
        let degree = sh.degree();
        self.center.resize(count * 3, 0.0);
        self.opacity.resize(count, 0.0);
        self.rgb.resize(count * 3, 0.0);
        self.scale.resize(count * 3, 0.0);
        self.quat.resize(count * 4, 0.0);
        if degree > 0 {
            for (band, width) in self.sh.iter_mut().zip([3, 5, 7]) {
                band.resize(count * width * 3, 0.0);
            }
        }
        let ranges = self.ranges;
        for i in 0..count {
            let record = &records[i * stride..i * stride + LCC_RECORD_BYTES];
            for d in 0..3 {
                self.center[i * 3 + d] =
                    f32::from_le_bytes(record[d * 4..d * 4 + 4].try_into().unwrap());
                self.rgb[i * 3 + d] = record[12 + d] as f32 / 255.0;
                let code = read_u16(record, 16 + d * 2) as f32 / 65535.0;
                self.scale[i * 3 + d] = mix(ranges.scale_min[d], ranges.scale_max[d], code);
            }
            self.opacity[i] = record[15] as f32 / 255.0;
            // The rotation word starts at byte 22, two bytes past a word boundary.
            self.quat[i * 4..i * 4 + 4].copy_from_slice(&decode_lcc_rotation(read_u32(record, 22)));
            let coefficients = match sh {
                LccSh::None => continue,
                LccSh::Separate(sh) => &sh[i * LCC_SH_BYTES..][..LCC_SH_BYTES],
                LccSh::Interleaved => &records[i * stride + LCC_RECORD_BYTES..][..LCC_SH_BYTES],
            };
            // Coefficients 1-3, 4-8 and 9-15 form bands 1-3, each packed as 11, 10
            // and 11 bits of RGB. The last four bytes are padding.
            for k in 0..15 {
                let (band, index, width) = match k {
                    0..3 => (0, k, 3),
                    3..8 => (1, k - 3, 5),
                    _ => (2, k - 8, 7),
                };
                let word = read_u32(coefficients, k * 4);
                let codes = [
                    (word & 2047) as f32 / 2047.0,
                    ((word >> 11) & 1023) as f32 / 1023.0,
                    ((word >> 21) & 2047) as f32 / 2047.0,
                ];
                let target = (i * width + index) * 3;
                for (c, code) in codes.into_iter().enumerate() {
                    self.sh[band][target + c] = mix(ranges.sh_min[c], ranges.sh_max[c], code);
                }
            }
        }
        let band = |index: usize| -> &[f32] {
            if degree == 0 {
                &[]
            } else {
                &self.sh[index]
            }
        };
        receiver.set_batch(
            start,
            count,
            &SplatProps {
                center: &self.center,
                opacity: &self.opacity,
                rgb: &self.rgb,
                scale: &self.scale,
                quat: &self.quat,
                sh1: band(0),
                sh2: band(1),
                sh3: band(2),
                ..Default::default()
            },
        );
        Ok(())
    }
}
