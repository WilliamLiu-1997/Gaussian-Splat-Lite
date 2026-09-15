use crate::raycast::splat_isosurface_radius;
use gaussian_splat_lib::splat_encode::{
    decode_splat_alpha_shape_amount, decode_splat_center, decode_splat_quat,
};
use half::f16;
use std::sync::OnceLock;

// Fixed source-opacity cutoff for cached local bounds.
const BOUNDS_MIN_ALPHA: f32 = 0.01;

fn scale_table() -> &'static [f32] {
    static SCALES: OnceLock<Box<[f32]>> = OnceLock::new();
    SCALES.get_or_init(|| {
        (0..=u16::MAX)
            .map(|code| f16::from_bits(code).to_f32().exp())
            .collect()
    })
}

/// Local bounds of rotated scale boxes at the fixed source-opacity cutoff.
pub struct SplatBounds {
    pub values: [f32; 6],
    scales: &'static [f32],
}

impl SplatBounds {
    pub fn new() -> Self {
        Self {
            values: [
                f32::INFINITY,
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ],
            scales: scale_table(),
        }
    }

    pub fn include(&mut self, center: &[u32], attributes: &[u32]) {
        let [alpha, shape] = decode_splat_alpha_shape_amount(center);
        let Some(radius) = splat_isosurface_radius(alpha, shape, BOUNDS_MIN_ALPHA) else {
            return;
        };
        let center = decode_splat_center(center);
        if !center.iter().all(|value| value.is_finite()) {
            return;
        }
        let sx = self.scales[(attributes[1] >> 16) as usize];
        let sy = self.scales[(attributes[2] & 0xffff) as usize];
        let sz = self.scales[(attributes[2] >> 16) as usize];
        let [x, y, z, w] = decode_splat_quat(attributes);
        let xx = 2.0 * x * x;
        let yy = 2.0 * y * y;
        let zz = 2.0 * z * z;
        let xy = 2.0 * x * y;
        let xz = 2.0 * x * z;
        let yz = 2.0 * y * z;
        let wx = 2.0 * w * x;
        let wy = 2.0 * w * y;
        let wz = 2.0 * w * z;
        // abs(rotation) * scale is equivalent to rotating all eight corners.
        let extent = [
            (1.0 - yy - zz).abs() * sx + (xy - wz).abs() * sy + (xz + wy).abs() * sz,
            (xy + wz).abs() * sx + (1.0 - xx - zz).abs() * sy + (yz - wx).abs() * sz,
            (xz - wy).abs() * sx + (yz + wx).abs() * sy + (1.0 - xx - yy).abs() * sz,
        ]
        .map(|value| value * radius);
        self.union(&[
            center[0] - extent[0],
            center[1] - extent[1],
            center[2] - extent[2],
            center[0] + extent[0],
            center[1] + extent[1],
            center[2] + extent[2],
        ]);
    }

    pub fn union(&mut self, bounds: &[f32; 6]) {
        for axis in 0..3 {
            let min = bounds[axis];
            let max = bounds[axis + 3];
            // Preserve NaN propagation from Math.min/Math.max for invalid scales.
            if min < self.values[axis] || min.is_nan() {
                self.values[axis] = min;
            }
            if max > self.values[axis + 3] || max.is_nan() {
                self.values[axis + 3] = max;
            }
        }
    }
}
