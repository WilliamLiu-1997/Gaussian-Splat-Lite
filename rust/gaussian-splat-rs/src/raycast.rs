use gaussian_splat_lib::splat_encode::{
    decode_splat_center, decode_splat_opacity, decode_splat_quat,
};
use half::f16;

const F16_CODE_COUNT: usize = u16::MAX as usize + 1;

pub struct RaycastTables {
    min_opacity_bits: Option<u32>,
    radius_scales: Box<[f32; F16_CODE_COUNT]>,
    scales: Box<[f32; F16_CODE_COUNT]>,
}

impl Default for RaycastTables {
    fn default() -> Self {
        Self {
            min_opacity_bits: None,
            radius_scales: vec![0.0; F16_CODE_COUNT]
                .into_boxed_slice()
                .try_into()
                .expect("opacity-radius table has a fixed size"),
            scales: (0..F16_CODE_COUNT)
                .map(|code| f16::from_bits(code as u16).to_f32().exp())
                .collect::<Vec<_>>()
                .into_boxed_slice()
                .try_into()
                .expect("scale table has a fixed size"),
        }
    }
}

impl RaycastTables {
    fn get(&mut self, min_opacity: f32) -> (&[f32; F16_CODE_COUNT], &[f32; F16_CODE_COUNT]) {
        let min_opacity_bits = min_opacity.to_bits();
        if self.min_opacity_bits != Some(min_opacity_bits) {
            for (opacity_code, radius_scale) in self.radius_scales.iter_mut().enumerate() {
                let encoded_opacity = decode_splat_opacity(&[0, 0, 0, opacity_code as u32]);
                *radius_scale =
                    opacity_isosurface_radius(encoded_opacity, min_opacity).unwrap_or(0.0);
            }
            self.min_opacity_bits = Some(min_opacity_bits);
        }
        (&self.radius_scales, &self.scales)
    }
}

pub fn raycast_splat_ellipsoids(
    buffer: &[u32],
    buffer2: &[u32],
    distances: &mut Vec<f32>,
    origin: [f32; 3],
    dir: [f32; 3],
    min_opacity: f32,
    tables: &mut RaycastTables,
    near: f32,
    far: f32,
) {
    assert_eq!(buffer.len(), buffer2.len());
    if !min_opacity.is_finite() || min_opacity >= 1.0 || near > far {
        return;
    }
    let dir_length_squared = vec3_dot(dir, dir);
    if dir_length_squared <= f32::EPSILON || !dir_length_squared.is_finite() {
        return;
    }
    let inv_dir_length_squared = 1.0 / dir_length_squared;
    let (radius_scales, scale_table) = tables.get(min_opacity);

    for (splat_a, splat_b) in buffer.chunks(4).zip(buffer2.chunks(4)) {
        let opacity_code = splat_a[3] as u16 as usize;
        let radius_scale = radius_scales[opacity_code];
        if radius_scale == 0.0 {
            continue;
        }

        let center = decode_splat_center(splat_a);
        let scale_codes = [
            (splat_b[1] >> 16) as u16,
            splat_b[2] as u16,
            (splat_b[2] >> 16) as u16,
        ];
        let longest_code = scale_codes
            .into_iter()
            .max_by_key(|&code| f16_order_key(code))
            .unwrap();
        let radius = scale_table[longest_code as usize] * radius_scale;
        if !raycast_sphere_may_hit(
            origin,
            dir,
            inv_dir_length_squared,
            center,
            radius,
            near,
            far,
        ) {
            continue;
        }

        let scale = scale_codes.map(|code| scale_table[code as usize] * radius_scale);
        let quat = decode_splat_quat(splat_b);
        if let Some(t) = raycast_ellipsoid(origin, dir, center, scale, quat, near, far) {
            distances.push(t);
        }
    }
}

#[inline]
fn f16_order_key(bits: u16) -> u16 {
    bits ^ (((bits as i16 >> 15) as u16) | 0x8000)
}

/// Returns the standard-deviation radius whose rendered alpha equals the
/// raycast threshold. Values above one encode the alternate splat shape: its
/// center alpha is one and `4 * opacity - 3` is the shape used by the shader.
#[inline]
fn opacity_isosurface_radius(encoded_opacity: f32, min_opacity: f32) -> Option<f32> {
    if !encoded_opacity.is_finite() || !min_opacity.is_finite() || encoded_opacity <= 0.0 {
        return None;
    }

    let center_opacity = encoded_opacity.min(1.0);
    // A zero cutoff would give a Gaussian infinite support. The smallest
    // positive f32 keeps that case finite while behaving as an effectively
    // disabled alpha cutoff.
    let relative_opacity = min_opacity.max(f32::MIN_POSITIVE) / center_opacity;
    if relative_opacity >= 1.0 {
        return None;
    }

    let gaussian_at_boundary = if encoded_opacity <= 1.0 {
        // alpha = center_opacity * exp(-0.5 * radius^2)
        relative_opacity
    } else {
        // Keep this decode and kernel inverse in sync with splatVertex.glsl
        // and splatFragment.glsl. The R8 shape amount is clamped to one, so
        // the decoded shape is at most 5.
        let shape = (encoded_opacity * 4.0 - 3.0).min(5.0);
        let power = ((shape * shape - 1.0) / std::f32::consts::E).exp();

        // alpha = 1 - (1 - exp(-0.5 * radius^2))^power
        // ln_1p/exp_m1 retain precision for small opacity thresholds.
        -((-relative_opacity).ln_1p() / power).exp_m1()
    };

    Some((-2.0 * gaussian_at_boundary.ln()).sqrt())
}

fn raycast_ellipsoid(
    origin: [f32; 3],
    dir: [f32; 3],
    center: [f32; 3],
    scale: [f32; 3],
    quat: [f32; 4],
    near: f32,
    far: f32,
) -> Option<f32> {
    let origin = vec3_sub(origin, center);
    let inv_quat = [-quat[0], -quat[1], -quat[2], quat[3]];

    // Model the Gaussian splat as an ellipsoid for higher quality raycasting
    let local_origin = quat_vec(inv_quat, origin);
    let local_dir = quat_vec(inv_quat, dir);

    let min_scale = scale[0].max(scale[1]).max(scale[2]) * 0.01;
    if scale[2] < min_scale {
        // Treat it as a flat elliptical disk
        if local_dir[2].abs() < 1e-6 {
            return None;
        }
        let t = -local_origin[2] / local_dir[2];
        let p_x = local_origin[0] + t * local_dir[0];
        let p_y = local_origin[1] + t * local_dir[1];
        if sqr(p_x / scale[0]) + sqr(p_y / scale[1]) > 1.0 {
            return None;
        }
        raycast_t_in_range(t, near, far)
    } else if scale[1] < min_scale {
        // Treat it as a flat elliptical disk
        if local_dir[1].abs() < 1e-6 {
            return None;
        }
        let t = -local_origin[1] / local_dir[1];
        let p_x = local_origin[0] + t * local_dir[0];
        let p_z = local_origin[2] + t * local_dir[2];
        if sqr(p_x / scale[0]) + sqr(p_z / scale[2]) > 1.0 {
            return None;
        }
        raycast_t_in_range(t, near, far)
    } else if scale[0] < min_scale {
        // Treat it as a flat elliptical disk
        if local_dir[0].abs() < 1e-6 {
            return None;
        }
        let t = -local_origin[0] / local_dir[0];
        let p_y = local_origin[1] + t * local_dir[1];
        let p_z = local_origin[2] + t * local_dir[2];
        if sqr(p_y / scale[1]) + sqr(p_z / scale[2]) > 1.0 {
            return None;
        }
        raycast_t_in_range(t, near, far)
    } else {
        let inv_scale = [1.0 / scale[0], 1.0 / scale[1], 1.0 / scale[2]];
        let local_origin = vec3_mul(local_origin, inv_scale);
        let local_dir = vec3_mul(local_dir, inv_scale);

        let a = vec3_dot(local_dir, local_dir);
        let b = vec3_dot(local_origin, local_dir);
        let c = vec3_dot(local_origin, local_origin) - 1.0;
        let discriminant = b * b - a * c;
        if discriminant < 0.0 {
            return None;
        }

        let sqrt_discriminant = discriminant.sqrt();
        let entry_t = (-b - sqrt_discriminant) / a;
        if entry_t > far {
            None
        } else if entry_t >= near {
            Some(entry_t)
        } else {
            // The ray starts inside the ellipsoid, or enters it before the
            // Raycaster near plane. Return the exit surface when it is the
            // first ellipsoid boundary inside the accepted ray interval.
            let exit_t = (-b + sqrt_discriminant) / a;
            raycast_t_in_range(exit_t, near, far)
        }
    }
}

#[inline]
fn raycast_t_in_range(t: f32, near: f32, far: f32) -> Option<f32> {
    (t >= near && t <= far).then_some(t)
}

// Use the ellipsoid's longest semi-axis as a conservative bounding sphere.
// The direction is intentionally not assumed to be normalized: SplatMesh
// transforms it into mesh space without normalization so that `t` remains in
// the raycaster's world-distance units.
fn raycast_sphere_may_hit(
    origin: [f32; 3],
    dir: [f32; 3],
    inv_dir_length_squared: f32,
    center: [f32; 3],
    radius: f32,
    near: f32,
    far: f32,
) -> bool {
    if !radius.is_finite() {
        // Preserve the exact path for malformed data rather than introducing
        // a broad-phase false negative.
        return true;
    }

    let offset = vec3_sub(origin, center);
    let closest_t = (-vec3_dot(offset, dir) * inv_dir_length_squared)
        .max(near)
        .min(far);
    let closest = [
        offset[0] + closest_t * dir[0],
        offset[1] + closest_t * dir[1],
        offset[2] + closest_t * dir[2],
    ];
    vec3_dot(closest, closest) <= radius * radius
}

fn sqr(x: f32) -> f32 {
    x * x
}

fn vec3_sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn vec3_mul(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

fn vec3_dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn vec3_cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn quat_vec(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let q_vec = [q[0], q[1], q[2]];
    let uv = vec3_cross(q_vec, v);
    let uuv = vec3_cross(q_vec, uv);
    [
        v[0] + 2.0 * (q[3] * uv[0] + uuv[0]),
        v[1] + 2.0 * (q[3] * uv[1] + uuv[1]),
        v[2] + 2.0 * (q[3] * uv[2] + uuv[2]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use gaussian_splat_lib::splat_encode::encode_splat;

    fn assert_near(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1e-5,
            "expected {expected}, got {actual}"
        );
    }

    fn unit_splat() -> ([u32; 4], [u32; 4]) {
        let mut splat_a = [0; 4];
        let mut splat_b = [0; 4];
        encode_splat(
            &mut splat_a,
            &mut splat_b,
            [0.0; 3],
            1.0,
            [1.0; 3],
            [1.0; 3],
            [0.0, 0.0, 0.0, 1.0],
        );
        (splat_a, splat_b)
    }

    #[test]
    fn sizes_gaussian_splats_at_the_opacity_isosurface() {
        let opacity = 0.8;
        let threshold = 0.1;
        let radius = opacity_isosurface_radius(opacity, threshold).unwrap();

        assert_near(opacity * (-0.5 * radius * radius).exp(), threshold);
        assert!(opacity_isosurface_radius(0.1, threshold).is_none());
        assert!(opacity_isosurface_radius(0.05, threshold).is_none());
    }

    #[test]
    fn inverts_the_special_shape_kernel() {
        let encoded_opacity = 1.5;
        let threshold = 0.1;
        let radius = opacity_isosurface_radius(encoded_opacity, threshold).unwrap();
        let shape = encoded_opacity * 4.0 - 3.0;
        let power = ((shape * shape - 1.0) / std::f32::consts::E).exp();
        let gaussian = (-0.5 * radius * radius).exp();
        let alpha = 1.0 - (1.0 - gaussian).powf(power);

        assert_near(alpha, threshold);
    }

    #[test]
    fn clamps_the_special_shape_like_the_shader() {
        let threshold = 0.1;
        assert_near(
            opacity_isosurface_radius(2.0, threshold).unwrap(),
            opacity_isosurface_radius(4.0, threshold).unwrap(),
        );
    }

    #[test]
    fn rejects_rays_outside_the_opacity_isosurface() {
        let (splat_a, splat_b) = unit_splat();

        let threshold = 0.1;
        let radius = opacity_isosurface_radius(1.0, threshold).unwrap();
        let mut tables = RaycastTables::default();
        let mut cast = |x: f32| {
            let mut distances = Vec::new();
            raycast_splat_ellipsoids(
                &splat_a,
                &splat_b,
                &mut distances,
                [x, 0.0, -5.0],
                [0.0, 0.0, 1.0],
                threshold,
                &mut tables,
                0.0,
                10.0,
            );
            distances
        };

        assert_eq!(cast(radius * 0.99).len(), 1);
        assert!(cast(radius * 1.01).is_empty());
    }

    #[test]
    fn uses_the_largest_encoded_scale_for_broad_phase() {
        let mut splat_a = [0; 4];
        let mut splat_b = [0; 4];
        encode_splat(
            &mut splat_a,
            &mut splat_b,
            [0.0; 3],
            1.0,
            [1.0; 3],
            [0.5, 1.0, 2.0],
            [0.0, 0.0, 0.0, 1.0],
        );

        let threshold = 0.1;
        let radius = opacity_isosurface_radius(1.0, threshold).unwrap();
        let mut distances = Vec::new();
        raycast_splat_ellipsoids(
            &splat_a,
            &splat_b,
            &mut distances,
            [-10.0, 0.0, 1.5 * radius],
            [1.0, 0.0, 0.0],
            threshold,
            &mut RaycastTables::default(),
            0.0,
            20.0,
        );

        assert_eq!(distances.len(), 1);
    }

    #[test]
    fn returns_the_exit_surface_when_the_ray_starts_inside() {
        let (splat_a, splat_b) = unit_splat();
        let threshold = 0.1;
        let radius = opacity_isosurface_radius(1.0, threshold).unwrap();
        let mut distances = Vec::new();
        let mut tables = RaycastTables::default();

        raycast_splat_ellipsoids(
            &splat_a,
            &splat_b,
            &mut distances,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            threshold,
            &mut tables,
            0.0,
            10.0,
        );

        assert_eq!(distances.len(), 1);
        assert_near(distances[0], radius);
    }

    #[test]
    fn returns_the_exit_surface_when_entry_precedes_near() {
        let (splat_a, splat_b) = unit_splat();
        let threshold = 0.1;
        let radius = opacity_isosurface_radius(1.0, threshold).unwrap();
        let mut distances = Vec::new();
        let mut tables = RaycastTables::default();

        raycast_splat_ellipsoids(
            &splat_a,
            &splat_b,
            &mut distances,
            [0.0, 0.0, -5.0],
            [0.0, 0.0, 1.0],
            threshold,
            &mut tables,
            5.0,
            10.0,
        );

        assert_eq!(distances.len(), 1);
        assert_near(distances[0], 5.0 + radius);
    }

    #[test]
    fn rebuilds_the_opacity_table_only_for_a_new_threshold() {
        let mut table = RaycastTables::default();
        let opacity_code = 0x3c00; // f16 1.0

        let low_threshold_radius = table.get(0.1).0[opacity_code];
        assert_eq!(table.min_opacity_bits, Some(0.1_f32.to_bits()));
        assert_near(table.get(0.1).0[opacity_code], low_threshold_radius);

        let high_threshold_radius = table.get(0.2).0[opacity_code];
        assert_eq!(table.min_opacity_bits, Some(0.2_f32.to_bits()));
        assert!(high_threshold_radius < low_threshold_radius);
    }
}
