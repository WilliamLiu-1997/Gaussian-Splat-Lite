use std::array;

use gaussian_splat_lib::splat_encode::{decode_position_sog, decode_quat_sog_v3};
use wasm_bindgen::prelude::*;

/// Half the side lengths of the axis-aligned box of a Gaussian's three standard
/// deviations, from the variances along its axes and its rotation (x, y, z,
/// w) as SOG decodes it, of unit length up to rounding.
fn three_sigma(variance: [f64; 3], quat: [f32; 4]) -> [f64; 3] {
    let [x, y, z, w] = quat.map(f64::from);
    let length = (x * x + y * y + z * z + w * w).sqrt();
    let [x, y, z, w] = [x / length, y / length, z / length, w / length];
    let rotation = [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ];
    rotation.map(|row| {
        let sum: f64 = (0..3).map(|k| row[k] * row[k] * variance[k]).sum();
        3.0 * sum.max(1e-20).sqrt()
    })
}

/// The boxes of ranges of a SOG v3 chunk's splats: the three standard
/// deviations along each axis of the Gaussians that the SOG reader decodes
/// from the chunk's codes. Errors of later repacking for rendering are not
/// included. Each
/// splat has three 16-bit center codes in `means`, whose log-encoded values
/// range from `mins` to `maxs`, three labels of the 256 log scales of
/// `codebook` in `scales`, and three rotation bytes in `rotations`. `ranges`
/// holds the first splat and count of each range; each box is six values,
/// the least and then the most coordinates.
#[wasm_bindgen(js_name = sogBounds)]
pub fn sog_bounds(
    means: &[u16],
    mins: &[f32],
    maxs: &[f32],
    scales: &[u8],
    codebook: &[f32],
    rotations: &[u8],
    ranges: &[u32],
) -> Result<Vec<f64>, JsValue> {
    let count = means.len() / 3;
    let ranges_fit = ranges
        .chunks_exact(2)
        .all(|range| range[0] as usize + range[1] as usize <= count);
    if means.len() != count * 3
        || scales.len() != count * 3
        || rotations.len() != count * 3
        || mins.len() != 3
        || maxs.len() != 3
        || codebook.len() != 256
        || !ranges.len().is_multiple_of(2)
        || !ranges_fit
    {
        return Err(js_sys::Error::new("Invalid SOG geometry for bounds").into());
    }
    // The variance along an axis of each log scale of the codebook.
    let variances: Vec<f64> = codebook
        .iter()
        .map(|&ln| (2.0 * f64::from(ln)).exp())
        .collect();
    let mut boxes = Vec::with_capacity(ranges.len() * 3);
    for range in ranges.chunks_exact(2) {
        let first = range[0] as usize;
        let mut least = [f64::INFINITY; 3];
        let mut most = [f64::NEG_INFINITY; 3];
        for i in first..first + range[1] as usize {
            let extent = three_sigma(
                array::from_fn(|d| variances[scales[i * 3 + d] as usize]),
                decode_quat_sog_v3(array::from_fn(|d| rotations[i * 3 + d])),
            );
            for d in 0..3 {
                let center = f64::from(decode_position_sog(means[i * 3 + d], mins[d], maxs[d]));
                least[d] = least[d].min(center - extent[d]);
                most[d] = most[d].max(center + extent[d]);
            }
        }
        boxes.extend(least);
        boxes.extend(most);
    }
    Ok(boxes)
}
