use std::{array, sync::LazyLock};

use half::f16;

pub(crate) static F16_LOOKUP: LazyLock<Box<[f32; 65536]>> =
    LazyLock::new(|| f16_table(|bits| f16::from_bits(bits).to_f32()));
pub(crate) static F16_SH_LOOKUP: LazyLock<F16ShLookup> =
    LazyLock::new(|| F16ShLookup::from_values(F16_LOOKUP.as_ref()));
pub(crate) static LOD_OPACITY_LOOKUP: LazyLock<Box<[u32; 65536]>> = LazyLock::new(|| {
    // The only nontrivial interval is [1, 2]: its shape has 1025 possible values.
    let shape: [u16; 1025] = array::from_fn(|i| f16::from_f32(i as f32 / 1024.0).to_bits());
    f16_table(|bits| {
        if bits == 0x8000 {
            return u32::from(bits); // Preserve negative zero.
        }
        u32::from(bits.min(0x3c00))
            | (u32::from(shape[bits.saturating_sub(0x3c00).min(1024) as usize]) << 16)
    })
});

/// Builds a fixed-size table on the heap without a large temporary stack array.
pub(crate) fn f16_table<T>(value: impl Fn(u16) -> T) -> Box<[T; 65536]> {
    (0..=u16::MAX)
        .map(value)
        .collect::<Vec<_>>()
        .into_boxed_slice()
        .try_into()
        .ok()
        .unwrap()
}

pub const SPLAT_TEX_WIDTH_BITS: usize = 11;
pub const SPLAT_TEX_HEIGHT_BITS: usize = 11;

pub const SPLAT_TEX_WIDTH: usize = 1 << SPLAT_TEX_WIDTH_BITS;
pub const SPLAT_TEX_HEIGHT: usize = 1 << SPLAT_TEX_HEIGHT_BITS;
pub const SPLAT_TEX_MIN_HEIGHT: usize = 1;
pub const SPLAT_TEX_LAYER_SIZE: usize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;

pub fn get_splat_tex_size(num_splats: usize) -> (usize, usize, usize, usize) {
    let (width, height, depth, max_splats) = get_splat_tex_size_u64(num_splats as u64);
    (
        width as usize,
        height as usize,
        depth as usize,
        max_splats as usize,
    )
}

pub(crate) fn get_splat_tex_size_u64(num_splats: u64) -> (u64, u64, u64, u64) {
    let width = SPLAT_TEX_WIDTH as u64;
    let height = num_splats
        .div_ceil(width)
        .clamp(SPLAT_TEX_MIN_HEIGHT as u64, SPLAT_TEX_HEIGHT as u64);
    let depth = num_splats.div_ceil(SPLAT_TEX_LAYER_SIZE as u64).max(1);
    let max_splats = width * height * depth;
    (width, height, depth, max_splats)
}

pub fn encode_splat(
    splat_a: &mut [u32],
    splat_b: &mut [u32],
    center: [f32; 3],
    opacity: f32,
    rgb: [f32; 3],
    scale: [f32; 3],
    quat_xyzw: [f32; 4],
) {
    encode_splat_with_ln_scale(
        splat_a,
        splat_b,
        center,
        opacity,
        rgb,
        scale.map(f32::ln),
        quat_xyzw,
    );
}

pub fn encode_splat_with_ln_scale(
    splat_a: &mut [u32],
    splat_b: &mut [u32],
    center: [f32; 3],
    opacity: f32,
    rgb: [f32; 3],
    ln_scale: [f32; 3],
    quat_xyzw: [f32; 4],
) {
    splat_a[0] = center[0].to_bits();
    splat_a[1] = center[1].to_bits();
    splat_a[2] = center[2].to_bits();
    encode_splat_opacity(splat_a, opacity);
    splat_b[0] =
        f16::from_f32(rgb[0]).to_bits() as u32 | ((f16::from_f32(rgb[1]).to_bits() as u32) << 16);
    splat_b[1] = f16::from_f32(rgb[2]).to_bits() as u32
        | ((f16::from_f32(ln_scale[0]).to_bits() as u32) << 16);
    splat_b[2] = f16::from_f32(ln_scale[1]).to_bits() as u32
        | ((f16::from_f32(ln_scale[2]).to_bits() as u32) << 16);
    splat_b[3] = encode_quat_oct101012(quat_xyzw);
}

pub fn encode_splat_center(splat_a: &mut [u32], center: [f32; 3]) {
    splat_a[0] = center[0].to_bits();
    splat_a[1] = center[1].to_bits();
    splat_a[2] = center[2].to_bits();
}

pub fn decode_splat_center(splat_a: &[u32]) -> [f32; 3] {
    [
        f32::from_bits(splat_a[0]),
        f32::from_bits(splat_a[1]),
        f32::from_bits(splat_a[2]),
    ]
}

/// Encodes raw opacity as regular alpha plus Spark's nonlinear wider-kernel
/// shape amount. Shape is limited to [0, 1], matching the renderer's [1, 5].
pub fn encode_splat_opacity(splat_a: &mut [u32], opacity: f32) {
    let raw_opacity = opacity.clamp(0.0, f32::INFINITY);
    splat_a[3] = if raw_opacity > 1.0 {
        let shape_amount = 0.25 * (raw_opacity.ln().mul_add(std::f32::consts::E, 1.0).sqrt() - 1.0);
        f16::ONE.to_bits() as u32 | ((f16::from_f32(shape_amount.min(1.0)).to_bits() as u32) << 16)
    } else {
        // Keep the common Gaussian path in the low lane only. This also
        // preserves the existing NaN representation without encoding zero.
        f16::from_f32(raw_opacity).to_bits() as u32
    };
}

/// Recovers the public raw LoD opacity from the stored kernel shape amount.
pub fn decode_splat_opacity(splat_a: &[u32]) -> f32 {
    let opacity_word = splat_a[3];
    let shape_amount_bits = (opacity_word >> 16) as u16;
    if shape_amount_bits == 0 {
        return f16::from_bits(opacity_word as u16).to_f32();
    }

    let shape_amount = f16::from_bits(shape_amount_bits).to_f32();
    if shape_amount > 0.0 {
        let kernel_shape = shape_amount.min(1.0).mul_add(4.0, 1.0);
        ((kernel_shape * kernel_shape - 1.0) / std::f32::consts::E).exp()
    } else {
        f16::from_bits(opacity_word as u16).to_f32()
    }
}

/// Decodes the render-time alpha and shape-amount lanes.
pub fn decode_splat_alpha_shape_amount(splat_a: &[u32]) -> [f32; 2] {
    decode_splat_opacity_lanes(splat_a)
}

fn decode_splat_opacity_lanes(splat_a: &[u32]) -> [f32; 2] {
    [
        f16::from_bits(splat_a[3] as u16).to_f32(),
        f16::from_bits((splat_a[3] >> 16) as u16).to_f32(),
    ]
}

pub fn encode_splat_rgb(splat_b: &mut [u32], rgb: [f32; 3]) {
    splat_b[0] =
        f16::from_f32(rgb[0]).to_bits() as u32 | ((f16::from_f32(rgb[1]).to_bits() as u32) << 16);
    splat_b[1] = f16::from_f32(rgb[2]).to_bits() as u32 | (splat_b[1] & 0xffff0000);
}

pub fn encode_splat_scale(splat_b: &mut [u32], scale: [f32; 3]) {
    encode_splat_ln_scale(splat_b, scale.map(f32::ln));
}

pub fn encode_splat_ln_scale(splat_b: &mut [u32], ln_scale: [f32; 3]) {
    splat_b[1] = (splat_b[1] & 0xffff) | ((f16::from_f32(ln_scale[0]).to_bits() as u32) << 16);
    splat_b[2] = f16::from_f32(ln_scale[1]).to_bits() as u32
        | ((f16::from_f32(ln_scale[2]).to_bits() as u32) << 16);
}

pub fn decode_splat_ln_scale(splat_b: &[u32]) -> [f32; 3] {
    [
        (splat_b[1] >> 16) as u16,
        splat_b[2] as u16,
        (splat_b[2] >> 16) as u16,
    ]
    .map(|x| f16::from_bits(x).to_f32())
}

pub fn encode_splat_quat(splat_b: &mut [u32], quat_xyzw: [f32; 4]) {
    splat_b[3] = encode_quat_oct101012(quat_xyzw);
}

pub fn decode_splat_quat(splat_b: &[u32]) -> [f32; 4] {
    decode_quat_oct101012(splat_b[3])
}

pub fn encode_quat_oct101012(quat_xyzw: [f32; 4]) -> u32 {
    let quat = if quat_xyzw[3] < 0.0 {
        quat_xyzw.map(|x| -x)
    } else {
        quat_xyzw
    };
    let theta = 2.0 * quat[3].clamp(0.0, 1.0).acos();
    let s = (theta * 0.5).sin();

    let axis = if s.abs() < 1e-6 {
        [1.0, 0.0, 0.0]
    } else {
        array::from_fn(|i| quat[i] / s)
    };
    let sum = axis[0].abs() + axis[1].abs() + axis[2].abs();
    let mut p: [f32; 2] = array::from_fn(|i| axis[i] / sum);
    if axis[2] < 0.0 {
        p = [
            (1.0 - p[1].abs()) * if p[0] >= 0.0 { 1.0 } else { -1.0 },
            (1.0 - p[0].abs()) * if p[1] >= 0.0 { 1.0 } else { -1.0 },
        ];
    }

    let [u, v] = p.map(|x| ((x * 0.5 + 0.5) * 1023.0).clamp(0.0, 1023.0).round() as u32);
    let r = (theta / std::f32::consts::PI * 4095.0)
        .clamp(0.0, 4095.0)
        .round() as u32;
    (r << 20) | (v << 10) | u
}

pub fn decode_quat_oct101012(encoded: u32) -> [f32; 4] {
    let [u, v, r] = [encoded & 0x3ff, (encoded >> 10) & 0x3ff, encoded >> 20];
    let [x, y] = [u as f32 / 1023.0 * 2.0 - 1.0, v as f32 / 1023.0 * 2.0 - 1.0];
    let z = 1.0 - x.abs() - y.abs();
    let t = (-z).max(0.0);
    let [x, y] = [x, y].map(|x| if x >= 0.0 { x - t } else { x + t });
    let length = (x * x + y * y + z * z).sqrt();
    let axis = [x / length, y / length, z / length];

    let half_theta = r as f32 / 4095.0 * 0.5 * std::f32::consts::PI;
    let (s, w) = half_theta.sin_cos();
    [axis[0] * s, axis[1] * s, axis[2] * s, w]
}

pub fn encode_splat_sh_rgb(rgb: [f32; 3]) -> u32 {
    let abs_rgb = rgb.map(|x| x.abs());
    let max_abs = abs_rgb[0].max(abs_rgb[1].max(abs_rgb[2]));
    // The shared exponent is the upper endpoint of the unsigned mantissa's
    // range. Rounding down would saturate every value above a power of two.
    let base = (max_abs.log2().ceil() + 15.0).clamp(0.0, 31.0) as u32;
    // base is in 0..=31, so 2^(base - 15) is an exact normal f32.
    let divisor = f32::from_bits((base + 112) << 23) / 255.0;
    let u_rgb = abs_rgb.map(|x| (x / divisor).clamp(0.0, 255.0).round() as u32);
    let exp_signs = (base << 3)
        | if rgb[0] < 0.0 { 0x1 } else { 0 }
        | if rgb[1] < 0.0 { 0x2 } else { 0 }
        | if rgb[2] < 0.0 { 0x4 } else { 0 };
    u_rgb[0] | (u_rgb[1] << 8) | (u_rgb[2] << 16) | (exp_signs << 24)
}

/// Exact SH packing for a shared 8-bit component alphabet.
pub struct ShLookup {
    exponents: [u8; 256],
    signs: [u8; 256],
    mantissas: [[u8; 256]; 32],
}

impl ShLookup {
    pub fn new(values: [f32; 256]) -> Self {
        Self {
            exponents: values.map(|v| (encode_splat_sh_rgb([v, 0.0, 0.0]) >> 27) as u8),
            signs: values.map(|v| u8::from(v < 0.0)),
            mantissas: array::from_fn(|exponent| {
                let divisor = f32::from_bits(((exponent as u32) + 112) << 23) / 255.0;
                values.map(|v| (v.abs() / divisor).clamp(0.0, 255.0).round() as u8)
            }),
        }
    }

    pub fn encode(&self, rgb: [u8; 3]) -> u32 {
        let [r, g, b] = rgb.map(usize::from);
        let exponent = self.exponents[r]
            .max(self.exponents[g])
            .max(self.exponents[b]);
        let row = &self.mantissas[exponent as usize];
        let signs = self.signs[r] | (self.signs[g] << 1) | (self.signs[b] << 2);
        u32::from(row[r])
            | (u32::from(row[g]) << 8)
            | (u32::from(row[b]) << 16)
            | ((u32::from(exponent) * 8 + u32::from(signs)) << 24)
    }
}

/// Exact SH packing for the RAD f16 component alphabet.
pub(crate) struct F16ShLookup {
    // Exponents, signs, then one mantissa row per exponent, in one allocation.
    rows: Box<[[u8; 65536]; 34]>,
}

impl F16ShLookup {
    fn from_values(values: &[f32; 65536]) -> Self {
        let mut rows = Vec::with_capacity(34);
        rows.push(array::from_fn(|i| {
            (encode_splat_sh_rgb([values[i], 0.0, 0.0]) >> 27) as u8
        }));
        rows.push(array::from_fn(|i| u8::from(values[i] < 0.0)));
        for exponent in 0..32 {
            let divisor = f32::from_bits((exponent + 112) << 23) / 255.0;
            rows.push(array::from_fn(|i| {
                (values[i].abs() / divisor).clamp(0.0, 255.0).round() as u8
            }));
        }
        Self {
            rows: rows.into_boxed_slice().try_into().ok().unwrap(),
        }
    }

    pub(crate) fn encode_indices(&self, [r, g, b]: [usize; 3]) -> u32 {
        let [exponents, signs, mantissas @ ..] = &*self.rows;
        let exponent = exponents[r].max(exponents[g]).max(exponents[b]);
        let row = &mantissas[exponent as usize];
        let signs = signs[r] | (signs[g] << 1) | (signs[b] << 2);
        u32::from(row[r])
            | (u32::from(row[g]) << 8)
            | (u32::from(row[b]) << 16)
            | ((u32::from(exponent) * 8 + u32::from(signs)) << 24)
    }
}

/// Decodes a shared-exponent RGB SH coefficient written by encode_splat_sh_rgb.
pub fn decode_splat_sh_rgb(word: u32) -> [f32; 3] {
    let exponent_and_signs = word >> 24;
    let scale = f32::from_bits(((exponent_and_signs >> 3) + 112) << 23) / 255.0;
    array::from_fn(|component| {
        let magnitude = ((word >> (component * 8)) & 255) as f32 * scale;
        if exponent_and_signs & (1 << component) != 0 {
            -magnitude
        } else {
            magnitude
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f16_sh_lookup_preserves_mixed_exponents_and_signs() {
        for code in 0..65536 {
            let indices = [code, (code + 32768) % 65536, (code * 173 + 255) % 65536];
            let rgb = indices.map(|index| F16_LOOKUP[index]);
            if rgb.iter().all(|value| value.is_finite()) {
                assert_eq!(
                    F16_SH_LOOKUP.encode_indices(indices),
                    encode_splat_sh_rgb(rgb)
                );
            }
        }
    }
}
