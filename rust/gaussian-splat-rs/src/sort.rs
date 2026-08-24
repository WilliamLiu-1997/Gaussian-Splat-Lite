const DEPTH_INFINITY_F32: u32 = 0x7f800000;
// 16-bit radix (2 passes)
const RADIX_BITS: u32 = 16;
const RADIX_BASE: usize = 1 << RADIX_BITS; // 65536
const RADIX_MASK: u32 = RADIX_BASE as u32 - 1;

#[derive(Default)]
pub struct Sort32Buffers {
    /// persistent xyz centers per mesh, indexed by the renderer-assigned mesh ID
    pub mesh_centers: Vec<Vec<f32>>,
    /// generation marker for each mesh center cache
    pub mesh_generations: Vec<u32>,
    /// current mesh center cache generation
    pub mesh_generation: u32,
    /// mesh ID backing each contiguous global splat range
    pub range_mesh_ids: Vec<u32>,
    /// first splat index for each contiguous mesh range
    pub range_bases: Vec<u32>,
    /// active splat count for each contiguous mesh range
    pub range_counts: Vec<u32>,
    /// Float64 world-space mesh origins (three f64 per range)
    pub range_origins: Vec<f64>,
    /// raw f32 metric bit-patterns (one per splat)
    pub keys: Vec<u32>,
    /// output indices
    pub ordering: Vec<u32>,
    /// bucket counts / offsets (length == RADIX_BASE)
    pub buckets16lo: Vec<u32>,
    /// bucket counts / offsets (length == RADIX_BASE)
    pub buckets16hi: Vec<u32>,
    /// scratch space for (key, index)
    pub scratch: Vec<u64>,
}

impl Sort32Buffers {
    #[cfg(test)]
    pub fn set_centers(&mut self, centers: &[f32]) {
        self.mesh_centers.clear();
        self.mesh_centers.push(centers.to_vec());
        self.range_mesh_ids.clear();
        self.range_mesh_ids.push(0);
        self.range_bases.clear();
        self.range_bases.push(0);
        self.range_counts.clear();
        self.range_counts.push((centers.len() / 3) as u32);
        self.range_origins.clear();
        self.range_origins.extend_from_slice(&[0.0, 0.0, 0.0]);
    }

    /// ensure all internal buffers are large enough for up to `max_splats`
    pub fn ensure_size(&mut self, max_splats: usize) {
        if self.keys.len() < max_splats {
            self.keys.resize(max_splats, 0);
        }
        if self.ordering.len() < max_splats {
            self.ordering.resize(max_splats, 0);
        }
        if self.scratch.len() < max_splats {
            self.scratch.resize(max_splats, 0);
        }
        if self.buckets16lo.len() < RADIX_BASE {
            self.buckets16lo.resize(RADIX_BASE, 0);
        }
        if self.buckets16hi.len() < RADIX_BASE {
            self.buckets16hi.resize(RADIX_BASE, 0);
        }
    }
}

/// Build non-negative float sort keys from mesh-relative centers and a Float64
/// world-space camera position, then sort them back-to-front. The camera-to-mesh
/// subtraction happens once per range in f64 and is narrowed only after large
/// world translations cancel. Radial sorting uses squared distance, which has
/// the same ordering as distance while avoiding one square root per splat.
pub fn sort32_centers_internal(
    buffers: &mut Sort32Buffers,
    max_splats: usize,
    num_splats: usize,
    camera_position: [f64; 3],
    direction: [f32; 3],
    radial: bool,
) -> Result<u32, String> {
    if num_splats > max_splats {
        return Err(format!(
            "Sort ordering buffer too small: {max_splats} < {num_splats}"
        ));
    }
    if buffers.range_mesh_ids.len() != buffers.range_bases.len()
        || buffers.range_bases.len() != buffers.range_counts.len()
    {
        return Err(format!(
            "Sort range mesh/base/count length mismatch: {}/{}/{}",
            buffers.range_mesh_ids.len(),
            buffers.range_bases.len(),
            buffers.range_counts.len(),
        ));
    }
    let expected_origin_values = buffers.range_bases.len().saturating_mul(3);
    if buffers.range_origins.len() != expected_origin_values {
        return Err(format!(
            "Sort range origin buffer has {} values, expected {}",
            buffers.range_origins.len(),
            expected_origin_values,
        ));
    }

    let mut previous_end = 0usize;
    for (range_index, (&base, &count)) in buffers
        .range_bases
        .iter()
        .zip(&buffers.range_counts)
        .enumerate()
    {
        let base = base as usize;
        let end = base
            .checked_add(count as usize)
            .ok_or_else(|| "Sort range overflow".to_string())?;
        if base < previous_end {
            return Err("Sort ranges must be ordered and non-overlapping".to_string());
        }
        if end > num_splats {
            return Err(format!(
                "Sort range [{base}, {end}) exceeds splat count {num_splats}"
            ));
        }
        let mesh_id = buffers.range_mesh_ids[range_index] as usize;
        let center_values = (count as usize).saturating_mul(3);
        let mesh_center_values = buffers
            .mesh_centers
            .get(mesh_id)
            .map_or(0, |centers| centers.len());
        if mesh_center_values < center_values {
            return Err(format!(
                "Sort center buffer for mesh {} too small: {} < {}",
                mesh_id, mesh_center_values, center_values
            ));
        }
        previous_end = end;
    }
    buffers.ensure_size(max_splats);

    {
        let Sort32Buffers {
            mesh_centers,
            range_mesh_ids,
            range_bases,
            range_counts,
            range_origins,
            keys,
            buckets16lo,
            buckets16hi,
            ..
        } = buffers;
        buckets16lo.fill(0);
        buckets16hi.fill(0);

        let invalid_key = f32::NAN.to_bits();
        let mut next_index = 0usize;

        for (range_index, (&base, &count)) in
            range_bases.iter().zip(range_counts.iter()).enumerate()
        {
            let base = base as usize;
            let end = base + count as usize;
            keys[next_index..base].fill(invalid_key);

            let origin_index = range_index * 3;
            let camera_local = [
                (camera_position[0] - range_origins[origin_index]) as f32,
                (camera_position[1] - range_origins[origin_index + 1]) as f32,
                (camera_position[2] - range_origins[origin_index + 2]) as f32,
            ];
            // Generate each key and tally both radix passes while its value is
            // hot. Keep the invariant sort-mode branch outside the hot loop.
            // Gaps are marked invalid without a separate full key scan.
            // The validation above guarantees this mesh and range are present.
            let center_slice =
                &mesh_centers[range_mesh_ids[range_index] as usize][..count as usize * 3];
            let key_slice = &mut keys[base..end];
            // wasm32 has no scalar fused-multiply-add instruction. Using
            // `mul_add` here lowers to a costly software helper; explicit
            // multiply/add keeps the hot path in native Wasm instructions.
            // The semantic tradeoff is normal non-fused rounding; only metrics
            // within a few ULPs can change their relative order.
            if radial {
                for (center, key_out) in center_slice.chunks_exact(3).zip(key_slice.iter_mut()) {
                    let dx = center[0] - camera_local[0];
                    let dy = center[1] - camera_local[1];
                    let dz = center[2] - camera_local[2];
                    let metric = dx * dx + dy * dy + dz * dz;
                    let key = metric.to_bits();
                    *key_out = key;
                    tally_key(key, buckets16lo, buckets16hi);
                }
            } else {
                for (center, key_out) in center_slice.chunks_exact(3).zip(key_slice.iter_mut()) {
                    let dx = center[0] - camera_local[0];
                    let dy = center[1] - camera_local[1];
                    let dz = center[2] - camera_local[2];
                    let metric = dx * direction[0] + dy * direction[1] + dz * direction[2] + 100.0;
                    let key = metric.to_bits();
                    *key_out = key;
                    tally_key(key, buckets16lo, buckets16hi);
                }
            }
            next_index = end;
        }
        keys[next_index..num_splats].fill(invalid_key);
    }

    sort32_counted_internal(buffers, num_splats)
}

/// Count a key into both radix passes without branching. Invalid keys add zero;
/// this favors the normal rendering case where nearly every splat is valid.
#[inline(always)]
fn tally_key(key: u32, buckets16lo: &mut [u32], buckets16hi: &mut [u32]) {
    let valid = (key < DEPTH_INFINITY_F32) as u32;
    let inverted = !key;
    let lo = (inverted & RADIX_MASK) as usize;
    let hi = (inverted >> RADIX_BITS) as usize;

    // The mask and shift guarantee both bucket indices are in bounds.
    unsafe { *buckets16lo.get_unchecked_mut(lo) += valid };
    unsafe { *buckets16hi.get_unchecked_mut(hi) += valid };
}

fn prefix_sum_exclusive(buckets: &mut [u32]) -> u32 {
    let mut sum = 0u32;
    for bucket in buckets.iter_mut() {
        let count = *bucket;
        *bucket = sum;
        sum = sum.wrapping_add(count);
    }
    sum
}

/// Two-pass radix sort (base 2^16) of 32-bit float bit-patterns,
/// descending order (largest keys first).
#[cfg(test)]
pub fn sort32_internal(
    buffers: &mut Sort32Buffers,
    max_splats: usize,
    num_splats: usize,
) -> Result<u32, String> {
    buffers.ensure_size(max_splats);

    {
        let Sort32Buffers {
            keys,
            buckets16lo,
            buckets16hi,
            ..
        } = buffers;
        let keys = &keys[..num_splats];

        buckets16lo.fill(0);
        buckets16hi.fill(0);

        let mut chunks = keys.chunks_exact(8);
        for chunk in chunks.by_ref() {
            tally_key(chunk[0], buckets16lo, buckets16hi);
            tally_key(chunk[1], buckets16lo, buckets16hi);
            tally_key(chunk[2], buckets16lo, buckets16hi);
            tally_key(chunk[3], buckets16lo, buckets16hi);
            tally_key(chunk[4], buckets16lo, buckets16hi);
            tally_key(chunk[5], buckets16lo, buckets16hi);
            tally_key(chunk[6], buckets16lo, buckets16hi);
            tally_key(chunk[7], buckets16lo, buckets16hi);
        }
        for &key in chunks.remainder() {
            tally_key(key, buckets16lo, buckets16hi);
        }
    }

    sort32_counted_internal(buffers, num_splats)
}

/// Finish the radix sort after `buckets16lo` and `buckets16hi` have already
/// been tallied for `keys[..num_splats]`.
fn sort32_counted_internal(buffers: &mut Sort32Buffers, num_splats: usize) -> Result<u32, String> {
    let Sort32Buffers {
        keys,
        ordering,
        buckets16lo,
        buckets16hi,
        scratch,
        ..
    } = buffers;
    let keys = &keys[..num_splats];

    let active_splats = prefix_sum_exclusive(buckets16lo);
    prefix_sum_exclusive(buckets16hi);

    if active_splats == 0 {
        return Ok(0);
    }

    // Pass 1: bucket by the low 16 bits of the inverted key. Keep the key
    // alongside the index so pass 2 can scan sequentially instead of gathering.
    macro_rules! place {
        ($key:expr, $index:expr) => {{
            if $key < DEPTH_INFINITY_F32 {
                let inv = !$key;
                let lo = (inv & RADIX_MASK) as usize;
                let bucket = unsafe { buckets16lo.get_unchecked_mut(lo) };
                let pos = *bucket as usize;
                *bucket += 1;
                let inv_index = ((inv as u64) << 32) | ($index as u64);

                // pos < active_splats <= max_splats <= scratch.len().
                unsafe { *scratch.get_unchecked_mut(pos) = inv_index };
            }
        }};
    }

    let mut chunks = keys.chunks_exact(8);
    let mut index = 0;
    for chunk in chunks.by_ref() {
        place!(chunk[0], index);
        place!(chunk[1], index + 1);
        place!(chunk[2], index + 2);
        place!(chunk[3], index + 3);
        place!(chunk[4], index + 4);
        place!(chunk[5], index + 5);
        place!(chunk[6], index + 6);
        place!(chunk[7], index + 7);
        index += 8;
    }
    for &key in chunks.remainder() {
        place!(key, index);
        index += 1;
    }

    // Pass 2: bucket by the high 16 bits of the inverted key.
    macro_rules! place2 {
        ($inv_index:expr) => {{
            let index = $inv_index as u32;
            let hi = (($inv_index >> 48) & RADIX_MASK as u64) as usize;
            let bucket = unsafe { buckets16hi.get_unchecked_mut(hi) };
            let pos = *bucket as usize;
            *bucket += 1;

            // pos < active_splats <= max_splats <= ordering.len().
            unsafe { *ordering.get_unchecked_mut(pos) = index };
        }};
    }

    let mut chunks = scratch[..active_splats as usize].chunks_exact(8);
    for chunk in chunks.by_ref() {
        place2!(chunk[0]);
        place2!(chunk[1]);
        place2!(chunk[2]);
        place2!(chunk[3]);
        place2!(chunk[4]);
        place2!(chunk[5]);
        place2!(chunk[6]);
        place2!(chunk[7]);
    }
    for &inv_index in chunks.remainder() {
        place2!(inv_index);
    }

    if buckets16hi[RADIX_BASE - 1] != active_splats {
        return Err(format!(
            "Expected {} active splats but got {}",
            active_splats,
            buckets16hi[RADIX_BASE - 1]
        ));
    }

    Ok(active_splats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_early_when_every_key_is_invalid() {
        let mut buffers = Sort32Buffers::default();
        buffers.keys = vec![0x7f800000, 0x7fc00000, 0x80000000, 0xff800000];
        buffers.ordering = vec![7, 7, 7, 7];

        assert_eq!(sort32_internal(&mut buffers, 4, 4), Ok(0));
        assert_eq!(buffers.ordering, [7, 7, 7, 7]);
    }

    #[test]
    fn orders_finite_keys_descending_and_stably() {
        let mut buffers = Sort32Buffers::default();
        buffers.keys = vec![
            0x3f800000, // 1.0
            0x7f800000, // +infinity, excluded
            0x00000000, // +0.0
            0x3f800000, // 1.0, kept after the first equal key
            0x7f7fffff, // largest finite f32
            0x80000000, // -0.0, excluded
            0x7fc00000, // NaN, excluded
        ];

        let active = sort32_internal(&mut buffers, 7, 7).unwrap();

        assert_eq!(active, 4);
        assert_eq!(&buffers.ordering[..active as usize], &[4, 0, 3, 2]);
    }

    #[test]
    fn sorts_finite_nonnegative_depths_descending_and_filters_invalid_keys() {
        let values = [1.0_f32, 3.0, f32::INFINITY, 2.0, f32::NAN, 0.0];
        let mut buffers = Sort32Buffers::default();
        buffers.ensure_size(values.len());
        for (dst, value) in buffers.keys.iter_mut().zip(values) {
            *dst = value.to_bits();
        }

        let active = sort32_internal(&mut buffers, values.len(), values.len()).unwrap();

        assert_eq!(active, 4);
        assert_eq!(&buffers.ordering[..active as usize], &[1, 3, 0, 5]);
    }

    #[test]
    fn matches_a_stable_reference_sort_across_reused_buffers() {
        let mut buffers = Sort32Buffers::default();
        let mut state = 0x1234_5678_u32;

        for len in [1_usize, 7, 8, 9, 257, 4097] {
            buffers.ensure_size(len);
            let mut expected = Vec::with_capacity(len);
            for index in 0..len {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let value = (state % 10_000) as f32 / 100.0;
                buffers.keys[index] = value.to_bits();
                expected.push((index as u32, value));
            }
            expected.sort_by(|left, right| right.1.total_cmp(&left.1));

            let active = sort32_internal(&mut buffers, len, len).unwrap();
            let expected_indices: Vec<u32> = expected.into_iter().map(|(index, _)| index).collect();

            assert_eq!(active as usize, len);
            assert_eq!(&buffers.ordering[..len], expected_indices.as_slice());
        }
    }

    #[test]
    fn builds_radial_keys_from_persistent_centers() {
        let mut buffers = Sort32Buffers::default();
        buffers.set_centers(&[
            1.0,
            0.0,
            0.0,
            3.0,
            0.0,
            0.0,
            f32::NAN,
            0.0,
            0.0,
            2.0,
            0.0,
            0.0,
        ]);

        let active =
            sort32_centers_internal(&mut buffers, 4, 4, [0.0, 0.0, 0.0], [0.0, 0.0, -1.0], true)
                .unwrap();

        assert_eq!(active, 3);
        assert_eq!(&buffers.ordering[..active as usize], &[1, 3, 0]);
    }

    #[test]
    fn builds_axial_keys_from_camera_direction() {
        let mut buffers = Sort32Buffers::default();
        buffers.set_centers(&[0.0, 0.0, -1.0, 0.0, 0.0, -3.0, 0.0, 0.0, -2.0]);

        let active =
            sort32_centers_internal(&mut buffers, 3, 3, [0.0, 0.0, 0.0], [0.0, 0.0, -1.0], false)
                .unwrap();

        assert_eq!(active, 3);
        assert_eq!(&buffers.ordering[..active as usize], &[1, 2, 0]);
    }

    #[test]
    fn rejects_an_ordering_buffer_smaller_than_the_scene() {
        let mut buffers = Sort32Buffers::default();
        buffers.set_centers(&[0.0; 6]);

        let error =
            sort32_centers_internal(&mut buffers, 1, 2, [0.0, 0.0, 0.0], [0.0, 0.0, -1.0], true)
                .unwrap_err();

        assert!(error.contains("ordering buffer too small"));
    }
}
