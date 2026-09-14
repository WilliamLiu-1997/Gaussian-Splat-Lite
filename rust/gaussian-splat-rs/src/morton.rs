use js_sys::{Array, Float32Array, Uint32Array};

use crate::bounds::SplatBounds;

// Keep in sync with SPLAT_BOUNDS_BLOCK_SIZE in data/defines.ts.
const BOUNDS_BLOCK_SIZE: usize = 256;
use wasm_bindgen::prelude::*;

const fn interleave(value: u32) -> u32 {
    let mut bits = value & 0x3ff;
    bits = (bits | (bits << 16)) & 0x030000ff;
    bits = (bits | (bits << 8)) & 0x0300f00f;
    bits = (bits | (bits << 4)) & 0x030c30c3;
    (bits | (bits << 2)) & 0x09249249
}

// The 10-bit expansion is shared by all axes and computed at compile time.
static MORTON_BITS: [u32; 1024] = {
    let mut table = [0; 1024];
    let mut value = 0;
    while value < table.len() {
        table[value] = interleave(value as u32);
        value += 1;
    }
    table
};

fn position(packed: &[u32], index: u32) -> [f64; 3] {
    let offset = index as usize * 4;
    std::array::from_fn(|axis| f32::from_bits(packed[offset + axis]) as f64)
}

fn sort_range(
    packed: &[u32],
    order: &mut [u32],
    scratch: &mut [u32],
    keys: &mut [u32],
    key_scratch: &mut [u32],
) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &index in order.iter() {
        let p = position(packed, index);
        if !(p[0] + p[1] + p[2]).is_finite() {
            continue;
        }
        for axis in 0..3 {
            min[axis] = min[axis].min(p[axis]);
            max[axis] = max[axis].max(p[axis]);
        }
    }
    if min[0] > max[0] || min == max {
        return (min, max);
    }
    // Match JS double precision, including large coordinates and cell boundaries.
    let scale: [f64; 3] = std::array::from_fn(|axis| {
        let extent = max[axis] - min[axis];
        if extent == 0.0 {
            0.0
        } else {
            1024.0 / extent
        }
    });
    // Each pass sees the same keys, so count all three digits during encoding.
    let mut histograms = [[0_usize; 1024]; 3];
    for (entry, &index) in order.iter().enumerate() {
        let p = position(packed, index);
        let key = if (p[0] + p[1] + p[2]).is_finite() {
            let cell: [u32; 3] = std::array::from_fn(|axis| {
                ((p[axis] - min[axis]) * scale[axis]).min(1023.0) as u32
            });
            MORTON_BITS[cell[0] as usize]
                | (MORTON_BITS[cell[1] as usize] << 1)
                | (MORTON_BITS[cell[2] as usize] << 2)
        } else {
            0x3fffffff
        };
        keys[entry] = key;
        for (pass, histogram) in histograms.iter_mut().enumerate() {
            histogram[((key >> (pass * 10)) & 1023) as usize] += 1;
        }
    }

    // Carry keys with indices so every pass reads them sequentially.
    // Stable three-pass radix sort; slices let every refined cell reuse storage.
    let mut source = &mut *order;
    let mut target = &mut *scratch;
    let mut source_keys = &mut *keys;
    let mut target_keys = &mut *key_scratch;
    for (pass, offsets) in histograms.iter_mut().enumerate() {
        let shift = pass * 10;
        let mut offset = 0;
        for size in offsets.iter_mut() {
            let count = *size;
            *size = offset;
            offset += count;
        }
        for (&index, &key) in source.iter().zip(source_keys.iter()) {
            let offset = &mut offsets[((key >> shift) & 1023) as usize];
            target[*offset] = index;
            target_keys[*offset] = key;
            *offset += 1;
        }
        std::mem::swap(&mut source, &mut target);
        std::mem::swap(&mut source_keys, &mut target_keys);
    }
    order.copy_from_slice(scratch);

    // Three passes leave the sorted keys in key_scratch; read them in place.
    let mut first = 0;
    while first < order.len() {
        let key = key_scratch[first];
        let mut next = first + 1;
        while next < order.len() && key_scratch[next] == key {
            next += 1;
        }
        if next - first > 256 {
            sort_range(
                packed,
                &mut order[first..next],
                &mut scratch[first..next],
                &mut keys[first..next],
                &mut key_scratch[first..next],
            );
        }
        first = next;
    }
    (min, max)
}

#[wasm_bindgen]
pub fn morton_reorder(
    count: u32,
    arrays: Array,
    sort_centers: Option<Uint32Array>,
    source_ids: Option<Uint32Array>,
    center_only_bounds: Float32Array,
    bounds: Float32Array,
    bounds_blocks: Option<Float32Array>,
) -> Result<Uint32Array, JsValue> {
    let words = count
        .checked_mul(4)
        .ok_or_else(|| js_sys::Error::new("Morton record count exceeds the array limit"))?;
    let arrays = arrays
        .iter()
        .map(|array| array.dyn_into::<Uint32Array>())
        .collect::<Result<Vec<_>, _>>()?;
    // Validate before writing any attributes so malformed input cannot be partly reordered.
    if center_only_bounds.length() != 6 {
        return Err(js_sys::Error::new("Center bounds must contain six values").into());
    }
    if bounds.length() != 6 {
        return Err(js_sys::Error::new("Bounds must contain six values").into());
    }
    if bounds_blocks.as_ref().is_some_and(|array| {
        array.length() as usize != (count as usize).div_ceil(BOUNDS_BLOCK_SIZE) * 12
    }) {
        return Err(js_sys::Error::new("Incorrect Morton bounds block length").into());
    }
    if arrays.len() < 2
        || arrays.iter().any(|array| array.length() < words)
        || sort_centers
            .as_ref()
            .is_some_and(|array| array.length() < count * 3)
        || source_ids
            .as_ref()
            .is_some_and(|array| array.length() < count)
    {
        return Err(js_sys::Error::new(
            "Morton attribute arrays are shorter than the record count",
        )
        .into());
    }
    let mut full_bounds = SplatBounds::new();
    let mut source = arrays[0].subarray(0, words).to_vec();
    let mut order: Vec<u32> = (0..count).collect();
    let mut scratch = vec![0; source.len()];
    if bounds_blocks.is_none() {
        arrays[1].subarray(0, words).copy_to(&mut scratch);
        // Ordinary loads scan matching records sequentially before reusing the buffer.
        for (center, attributes) in source.chunks_exact(4).zip(scratch.chunks_exact(4)) {
            full_bounds.include(center, attributes);
        }
    }
    // Reuse the record buffer for radix indices and both key buffers.
    let (radix_scratch, keys) = scratch.split_at_mut(count as usize);
    let (keys, key_scratch) = keys.split_at_mut(count as usize);
    let (min, max) = sort_range(
        &source,
        &mut order,
        radix_scratch,
        keys,
        &mut key_scratch[..count as usize],
    );
    center_only_bounds.copy_from(&[
        min[0] as f32,
        min[1] as f32,
        min[2] as f32,
        max[0] as f32,
        max[1] as f32,
        max[2] as f32,
    ]);
    for (index, array) in arrays.iter().enumerate() {
        let array = array.subarray(0, words);
        if index > 0 {
            array.copy_to(&mut source);
        }
        if index == 1 && bounds_blocks.is_some() {
            // Scratch holds sorted centers. Accumulate each block before replacing
            // its centers with matching attributes; reuse both Morton record buffers.
            let mut output = vec![0.0; (count as usize).div_ceil(BOUNDS_BLOCK_SIZE) * 12];
            for ((centers, indices), block) in scratch
                .chunks_mut(BOUNDS_BLOCK_SIZE * 4)
                .zip(order.chunks(BOUNDS_BLOCK_SIZE))
                .zip(output.chunks_mut(12))
            {
                block[..3].fill(f32::INFINITY);
                block[3..6].fill(f32::NEG_INFINITY);
                let mut local = SplatBounds::new();
                for (record, &source_index) in centers.chunks_exact_mut(4).zip(indices) {
                    let offset = source_index as usize * 4;
                    let attributes = &source[offset..offset + 4];
                    let center: [f32; 3] = std::array::from_fn(|axis| f32::from_bits(record[axis]));
                    if center.iter().all(|value| value.is_finite()) {
                        for axis in 0..3 {
                            block[axis] = block[axis].min(center[axis]);
                            block[axis + 3] = block[axis + 3].max(center[axis]);
                        }
                    }
                    local.include(record, attributes);
                    record.copy_from_slice(attributes);
                }
                block[6..].copy_from_slice(&local.values);
                full_bounds.union(&local.values);
            }
            bounds_blocks.as_ref().unwrap().copy_from(&output);
        } else {
            permute::<4>(&source, &mut scratch, &order);
        }
        array.copy_from(&scratch);
    }
    bounds.copy_from(&full_bounds.values);
    if let Some(centers) = sort_centers {
        let size = count as usize * 3;
        let centers = centers.subarray(0, count * 3);
        centers.copy_to(&mut source[..size]);
        permute::<3>(&source, &mut scratch, &order);
        centers.copy_from(&scratch[..size]);
    }
    if let Some(ids) = source_ids {
        ids.subarray(0, count)
            .copy_to(&mut source[..count as usize]);
        for index in &mut order {
            *index = source[*index as usize];
        }
    }
    Ok(Uint32Array::from(order.as_slice()))
}

fn permute<const STRIDE: usize>(source: &[u32], target: &mut [u32], order: &[u32]) {
    for (record, &index) in target.chunks_exact_mut(STRIDE).zip(order) {
        let offset = index as usize * STRIDE;
        record.copy_from_slice(&source[offset..offset + STRIDE]);
    }
}
