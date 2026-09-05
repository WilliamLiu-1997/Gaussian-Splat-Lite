use std::array;

use half::f16;

pub const SPLAT_TEX_WIDTH_BITS: usize = 11;
pub const SPLAT_TEX_HEIGHT_BITS: usize = 11;

pub const SPLAT_TEX_WIDTH: usize = 1 << SPLAT_TEX_WIDTH_BITS;
pub const SPLAT_TEX_HEIGHT: usize = 1 << SPLAT_TEX_HEIGHT_BITS;
pub const SPLAT_TEX_MIN_HEIGHT: usize = 1;
pub const SPLAT_TEX_LAYER_SIZE: usize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;

const MAX_SPLAT_OPACITY: f32 = 1000.0;

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

/// Encodes raw opacity through 1000 as regular alpha plus Spark's nonlinear
/// wider-kernel shape amount.
pub fn encode_splat_opacity(splat_a: &mut [u32], opacity: f32) {
    let raw_opacity = opacity.clamp(0.0, MAX_SPLAT_OPACITY);
    splat_a[3] = if raw_opacity > 1.0 {
        let shape_amount = 0.25 * (raw_opacity.ln().mul_add(std::f32::consts::E, 1.0).sqrt() - 1.0);
        f16::ONE.to_bits() as u32 | ((f16::from_f32(shape_amount).to_bits() as u32) << 16)
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
        let kernel_shape = shape_amount.mul_add(4.0, 1.0);
        ((kernel_shape * kernel_shape - 1.0) / std::f32::consts::E)
            .exp()
            .min(MAX_SPLAT_OPACITY)
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
    let base = (max_abs.log2().floor() + 15.0).clamp(0.0, 31.0) as u32;
    // base is in 0..=31, so 2^(base - 15) is an exact normal f32.
    let divisor = f32::from_bits((base + 112) << 23) / 255.0;
    let u_rgb = abs_rgb.map(|x| (x / divisor).clamp(0.0, 255.0).round() as u32);
    let exp_signs = (base << 3)
        | if rgb[0] < 0.0 { 0x1 } else { 0 }
        | if rgb[1] < 0.0 { 0x2 } else { 0 }
        | if rgb[2] < 0.0 { 0x4 } else { 0 };
    u_rgb[0] | (u_rgb[1] << 8) | (u_rgb[2] << 16) | (exp_signs << 24)
}
