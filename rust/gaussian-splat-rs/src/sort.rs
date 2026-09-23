use std::ops::Range;

const DEPTH_INFINITY_F32: u32 = 0x7f800000;
// Full precision uses two 16-bit passes; fast sorting uses one 24-bit pass.
const FULL_RADIX_BITS: u32 = 16;
const FAST_KEY_SHIFT: u32 = 8;
const FAST_RADIX_BITS: u32 = 32 - FAST_KEY_SHIFT;

/// Persistent raw/radial centers and affine state for one renderer mesh.
pub struct MeshSortState {
    pub raw_centers: Vec<f32>,
    pub radial_centers: Vec<f32>,
    pub transform: [f64; 9],
    pub origin: [f64; 3],
    pub generation: u64,
}

impl Default for MeshSortState {
    fn default() -> Self {
        Self {
            raw_centers: Vec::new(),
            radial_centers: Vec::new(),
            transform: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            origin: [0.0; 3],
            generation: 0,
        }
    }
}

#[derive(Default)]
pub struct Sort32Buffers {
    /// persistent sort state indexed by the renderer-assigned mesh ID
    pub meshes: Vec<MeshSortState>,
    /// Wide counter avoids a rollover/reset path during a worker's lifetime.
    pub mesh_generation: u64,
    /// mesh ID backing each contiguous global splat range
    pub range_mesh_ids: Vec<u32>,
    /// first splat index for each contiguous mesh range
    pub range_bases: Vec<u32>,
    /// active splat count for each contiguous mesh range
    pub range_counts: Vec<u32>,
    /// f32 metric bit-patterns, shifted right by 8 in fast mode
    pub keys: Vec<u32>,
    /// output indices
    pub ordering: Vec<u32>,
    /// bucket counts / offsets for the current radix width
    pub buckets_lo: Vec<u32>,
    /// bucket counts / offsets for the current radix width
    pub buckets_hi: Vec<u32>,
    /// scratch space for (key, index)
    pub scratch: Vec<u64>,
    /// Occupied bucket range; fast mode skips unused buckets in the prefix sum.
    bucket_range: Range<usize>,
}

impl Sort32Buffers {
    pub fn ensure_mesh(&mut self, mesh_id: usize) -> &mut MeshSortState {
        if self.meshes.len() <= mesh_id {
            self.meshes.resize_with(mesh_id + 1, MeshSortState::default);
        }
        &mut self.meshes[mesh_id]
    }

    pub fn set_mesh_matrix(&mut self, mesh_id: usize, matrix: [f64; 16]) {
        let transform = [
            matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9],
            matrix[10],
        ];
        let mesh = self.ensure_mesh(mesh_id);
        if mesh.transform != transform {
            mesh.transform = transform;
            mesh.radial_centers.clear();
        }
        mesh.origin = [matrix[12], matrix[13], matrix[14]];
    }

    pub fn ensure_radial_centers(&mut self, mesh_id: usize) {
        let mesh = &mut self.meshes[mesh_id];
        if mesh.radial_centers.len() == mesh.raw_centers.len() {
            return;
        }
        let transform = mesh.transform;
        mesh.radial_centers.resize(mesh.raw_centers.len(), f32::NAN);
        for (source, target) in mesh
            .raw_centers
            .chunks_exact(3)
            .zip(mesh.radial_centers.chunks_exact_mut(3))
        {
            let [x, y, z] = [source[0] as f64, source[1] as f64, source[2] as f64];
            target[0] = (transform[0] * x + transform[3] * y + transform[6] * z) as f32;
            target[1] = (transform[1] * x + transform[4] * y + transform[7] * z) as f32;
            target[2] = (transform[2] * x + transform[5] * y + transform[8] * z) as f32;
        }
    }

    pub fn clear_mesh(&mut self, mesh_id: usize) {
        self.meshes[mesh_id] = MeshSortState::default();
    }

    #[cfg(test)]
    pub fn set_centers(&mut self, centers: &[f32]) {
        self.meshes.clear();
        self.meshes.push(MeshSortState {
            raw_centers: centers.to_vec(),
            radial_centers: centers.to_vec(),
            ..MeshSortState::default()
        });
        self.range_mesh_ids.clear();
        self.range_mesh_ids.push(0);
        self.range_bases.clear();
        self.range_bases.push(0);
        self.range_counts.clear();
        self.range_counts.push((centers.len() / 3) as u32);
    }

    /// Ensure key and output buffers can hold `max_splats` entries.
    pub fn ensure_size(&mut self, max_splats: usize) {
        if self.keys.len() < max_splats {
            self.keys.resize(max_splats, 0);
        }
        if self.ordering.len() < max_splats {
            self.ordering.resize(max_splats, 0);
        }
    }

    fn prepare_buckets<const FAST: bool>(&mut self) {
        let bits = if FAST {
            FAST_RADIX_BITS
        } else {
            FULL_RADIX_BITS
        };
        self.buckets_lo.resize(1 << bits, 0);
        if FAST {
            // Only the previous occupied range can contain counts or offsets.
            self.buckets_lo[self.bucket_range.clone()].fill(0);
            self.bucket_range = usize::MAX..0;
        } else {
            self.buckets_lo.fill(0);
            self.buckets_hi.resize(1 << bits, 0);
            self.buckets_hi.fill(0);
            self.bucket_range = 0..1 << bits;
        }
    }
}

/// Build non-negative float sort keys from mesh-relative centers and a Float64
/// world-space camera position, then sort them back-to-front. Axial sorting
/// folds each affine basis into the view direction and reads raw centers
/// directly. Radial sorting lazily materializes transformed centers and uses
/// squared distance, which preserves distance ordering without square roots.
pub fn sort32_centers_internal(
    buffers: &mut Sort32Buffers,
    max_splats: usize,
    num_splats: usize,
    camera_position: [f64; 3],
    direction: [f32; 3],
    radial: bool,
    fast_sort: bool,
) -> Result<u32, String> {
    if fast_sort {
        sort_centers::<true>(
            buffers,
            max_splats,
            num_splats,
            camera_position,
            direction,
            radial,
        )
    } else {
        sort_centers::<false>(
            buffers,
            max_splats,
            num_splats,
            camera_position,
            direction,
            radial,
        )
    }
}

fn sort_centers<const FAST: bool>(
    buffers: &mut Sort32Buffers,
    max_splats: usize,
    num_splats: usize,
    camera_position: [f64; 3],
    direction: [f32; 3],
    radial: bool,
) -> Result<u32, String> {
    let shift = if FAST { FAST_KEY_SHIFT } else { 0 };
    if num_splats > max_splats {
        return Err(format!(
            "Sort ordering buffer too small: {max_splats} < {num_splats}"
        ));
    }
    // The WASM setter validates the parallel arrays and creates every mesh.
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
        let mesh_center_values = buffers.meshes[mesh_id].raw_centers.len();
        if mesh_center_values < center_values {
            return Err(format!(
                "Sort center buffer for mesh {} too small: {} < {}",
                mesh_id, mesh_center_values, center_values
            ));
        }
        previous_end = end;
    }
    if radial {
        for range_index in 0..buffers.range_mesh_ids.len() {
            let mesh_id = buffers.range_mesh_ids[range_index] as usize;
            buffers.ensure_radial_centers(mesh_id);
        }
    }
    buffers.ensure_size(max_splats);
    buffers.prepare_buckets::<FAST>();

    {
        let Sort32Buffers {
            meshes,
            range_mesh_ids,
            range_bases,
            range_counts,
            keys,
            buckets_lo,
            buckets_hi,
            bucket_range,
            ..
        } = buffers;

        let invalid_key = f32::NAN.to_bits() >> shift;
        let mut next_index = 0usize;
        let direction64 = direction.map(f64::from);

        for (range_index, (&base, &count)) in
            range_bases.iter().zip(range_counts.iter()).enumerate()
        {
            let base = base as usize;
            let end = base + count as usize;
            keys[next_index..base].fill(invalid_key);

            let mesh = &meshes[range_mesh_ids[range_index] as usize];
            let camera_local = [
                (camera_position[0] - mesh.origin[0]) as f32,
                (camera_position[1] - mesh.origin[1]) as f32,
                (camera_position[2] - mesh.origin[2]) as f32,
            ];
            // Generate each key and tally its radix buckets while its value is
            // hot. Keep the invariant sort-mode branch outside the hot loop.
            // Gaps are marked invalid without a separate full key scan.
            // The validation above guarantees this mesh and range are present.
            let key_slice = &mut keys[base..end];
            // wasm32 has no scalar fused-multiply-add instruction. Using
            // `mul_add` here lowers to a costly software helper; explicit
            // multiply/add keeps the hot path in native Wasm instructions.
            // The semantic tradeoff is normal non-fused rounding; only metrics
            // within a few ULPs can change their relative order.
            if radial {
                let center_slice = &mesh.radial_centers[..count as usize * 3];
                for (center, key_out) in center_slice.chunks_exact(3).zip(key_slice.iter_mut()) {
                    let dx = center[0] - camera_local[0];
                    let dy = center[1] - camera_local[1];
                    let dz = center[2] - camera_local[2];
                    let metric = dx * dx + dy * dy + dz * dz;
                    let key = metric.to_bits() >> shift;
                    *key_out = key;
                    tally_key::<FAST>(key, buckets_lo, buckets_hi, bucket_range);
                }
            } else {
                let transform = mesh.transform;
                let local_direction = [
                    (transform[0] * direction64[0]
                        + transform[1] * direction64[1]
                        + transform[2] * direction64[2]) as f32,
                    (transform[3] * direction64[0]
                        + transform[4] * direction64[1]
                        + transform[5] * direction64[2]) as f32,
                    (transform[6] * direction64[0]
                        + transform[7] * direction64[1]
                        + transform[8] * direction64[2]) as f32,
                ];
                let offset = -(camera_local[0] * direction[0]
                    + camera_local[1] * direction[1]
                    + camera_local[2] * direction[2]);
                let center_slice = &mesh.raw_centers[..count as usize * 3];
                for (center, key_out) in center_slice.chunks_exact(3).zip(key_slice.iter_mut()) {
                    let metric = center[0] * local_direction[0]
                        + center[1] * local_direction[1]
                        + center[2] * local_direction[2]
                        + offset;
                    let key = metric.to_bits() >> shift;
                    *key_out = key;
                    tally_key::<FAST>(key, buckets_lo, buckets_hi, bucket_range);
                }
            }
            next_index = end;
        }
        keys[next_index..num_splats].fill(invalid_key);
    }

    Ok(sort_counted::<FAST>(buffers, num_splats))
}

/// Count valid keys without touching buckets for centers behind the camera.
#[inline(always)]
fn tally_key<const FAST: bool>(
    key: u32,
    buckets_lo: &mut [u32],
    buckets_hi: &mut [u32],
    bucket_range: &mut Range<usize>,
) {
    let bits = if FAST {
        FAST_RADIX_BITS
    } else {
        FULL_RADIX_BITS
    };
    let shift = if FAST { FAST_KEY_SHIFT } else { 0 };
    if key >= (DEPTH_INFINITY_F32 >> shift) {
        return;
    }
    let inverted = !key;
    let lo = (inverted & ((1 << bits) - 1)) as usize;
    if FAST {
        bucket_range.start = bucket_range.start.min(lo);
        bucket_range.end = bucket_range.end.max(lo + 1);
    }
    // The mask and shift guarantee both bucket indices are in bounds.
    unsafe { *buckets_lo.get_unchecked_mut(lo) += 1 };
    if !FAST {
        let hi = (inverted >> FULL_RADIX_BITS) as usize;
        unsafe { *buckets_hi.get_unchecked_mut(hi) += 1 };
    }
}

fn prefix_sum_exclusive(buckets: &mut [u32]) -> u32 {
    let mut sum = 0u32;
    for bucket in buckets.iter_mut() {
        let count = *bucket;
        *bucket = sum;
        sum += count;
    }
    sum
}

/// Finish the radix sort after `buckets_lo` and `buckets_hi` have already
/// been tallied for `keys[..num_splats]`.
fn sort_counted<const FAST: bool>(buffers: &mut Sort32Buffers, num_splats: usize) -> u32 {
    let bits = if FAST {
        FAST_RADIX_BITS
    } else {
        FULL_RADIX_BITS
    };
    let shift = if FAST { FAST_KEY_SHIFT } else { 0 };
    let Sort32Buffers {
        keys,
        ordering,
        buckets_lo,
        buckets_hi,
        scratch,
        bucket_range,
        ..
    } = buffers;
    let keys = &keys[..num_splats];

    // All-invalid input leaves the range inverted; normalize it to empty.
    bucket_range.start = bucket_range.start.min(bucket_range.end);
    let active_splats = prefix_sum_exclusive(&mut buckets_lo[bucket_range.clone()]);
    if !FAST {
        prefix_sum_exclusive(buckets_hi);
    }

    if active_splats == 0 {
        return 0;
    }

    if !FAST && scratch.len() < num_splats {
        scratch.resize(num_splats, 0);
    }

    // Fast mode writes the final indices directly. Full precision keeps keys
    // alongside indices so pass 2 can scan sequentially instead of gathering.
    macro_rules! place {
        ($key:expr, $index:expr) => {{
            if $key < (DEPTH_INFINITY_F32 >> shift) {
                let inv = !$key;
                let lo = (inv & ((1 << bits) - 1)) as usize;
                let bucket = unsafe { buckets_lo.get_unchecked_mut(lo) };
                let pos = *bucket as usize;
                *bucket += 1;
                // pos < active_splats <= num_splats; both targets are sized above.
                if FAST {
                    unsafe { *ordering.get_unchecked_mut(pos) = $index as u32 };
                } else {
                    let inv_index = ((inv as u64) << 32) | ($index as u64);
                    unsafe { *scratch.get_unchecked_mut(pos) = inv_index };
                }
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

    if FAST {
        return active_splats;
    }

    // Only full precision reaches pass 2: use the high 16 bits of the inverted key.
    macro_rules! place2 {
        ($inv_index:expr) => {{
            let index = $inv_index as u32;
            let hi = ($inv_index >> (32 + FULL_RADIX_BITS)) as usize;
            let bucket = unsafe { buckets_hi.get_unchecked_mut(hi) };
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

    debug_assert_eq!(buckets_hi[(1 << FULL_RADIX_BITS) - 1], active_splats);
    active_splats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sort_internal<const FAST: bool>(
        buffers: &mut Sort32Buffers,
        max_splats: usize,
        num_splats: usize,
    ) -> u32 {
        buffers.ensure_size(max_splats);
        buffers.prepare_buckets::<FAST>();

        for &key in &buffers.keys[..num_splats] {
            tally_key::<FAST>(
                key,
                &mut buffers.buckets_lo,
                &mut buffers.buckets_hi,
                &mut buffers.bucket_range,
            );
        }

        sort_counted::<FAST>(buffers, num_splats)
    }

    #[test]
    fn returns_early_when_every_key_is_invalid() {
        let mut buffers = Sort32Buffers::default();
        buffers.keys = vec![0x7f800000, 0x7fc00000, 0x80000000, 0xff800000];
        buffers.ordering = vec![7, 7, 7, 7];

        assert_eq!(sort_internal::<false>(&mut buffers, 4, 4), 0);
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

        let active = sort_internal::<false>(&mut buffers, 7, 7);

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

        let active = sort_internal::<false>(&mut buffers, values.len(), values.len());

        assert_eq!(active, 4);
        assert_eq!(&buffers.ordering[..active as usize], &[1, 3, 0, 5]);
    }

    #[test]
    fn matches_a_stable_reference_sort_across_reused_buffers() {
        let mut buffers = Sort32Buffers::default();
        let mut state = 0x1234_5678_u32;

        for len in [0_usize, 1, 7, 8, 9, 257, 4097, 0, 9] {
            for fast in [true, true, false, true, false] {
                buffers.ensure_size(len);
                let mut expected = Vec::with_capacity(len);
                for index in 0..len {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let bits = match index % 31 {
                        0 => f32::NAN.to_bits(),
                        1 => f32::INFINITY.to_bits(),
                        2 => (-0.0_f32).to_bits(),
                        3 => (-1.0_f32).to_bits(),
                        _ => {
                            let base = [0, 0x00800000, 0x3f800000, 0x6f800000, 0x7f7f8000]
                                [(state >> 24) as usize % 5];
                            base | (state & 0x7fff)
                        }
                    };
                    buffers.keys[index] = if fast { bits >> FAST_KEY_SHIFT } else { bits };
                    if bits < DEPTH_INFINITY_F32 {
                        expected.push(index as u32);
                    }
                }
                expected.sort_by_key(|&index| std::cmp::Reverse(buffers.keys[index as usize]));
                let active = if fast {
                    sort_internal::<true>(&mut buffers, len, len)
                } else {
                    sort_internal::<false>(&mut buffers, len, len)
                };
                assert_eq!(&buffers.ordering[..active as usize], expected.as_slice());
            }
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

        let active = sort32_centers_internal(
            &mut buffers,
            4,
            4,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            true,
            false,
        )
        .unwrap();

        assert_eq!(active, 3);
        assert_eq!(&buffers.ordering[..active as usize], &[1, 3, 0]);
    }

    #[test]
    fn builds_axial_keys_from_camera_direction() {
        let mut buffers = Sort32Buffers::default();
        // Preserve nearby depth differences and exclude centers behind the camera.
        let depths = [1.0_f32, 1.0001, -1.0, -200.0];
        let centers: Vec<_> = depths.iter().flat_map(|&d| [0.0, 0.0, -d]).collect();
        buffers.set_centers(&centers);

        for fast in [false, true] {
            let active = sort32_centers_internal(
                &mut buffers,
                depths.len(),
                depths.len(),
                [0.0, 0.0, 0.0],
                [0.0, 0.0, -1.0],
                false,
                fast,
            )
            .unwrap();

            assert_eq!(active, 2);
            assert_eq!(&buffers.ordering[..active as usize], &[1, 0]);
            let shift = if fast { FAST_KEY_SHIFT } else { 0 };
            assert_eq!(buffers.keys[0], 1.0_f32.to_bits() >> shift);
        }
    }

    #[test]
    fn rejects_an_ordering_buffer_smaller_than_the_scene() {
        let mut buffers = Sort32Buffers::default();
        buffers.set_centers(&[0.0; 6]);

        let error = sort32_centers_internal(
            &mut buffers,
            1,
            2,
            [0.0, 0.0, 0.0],
            [0.0, 0.0, -1.0],
            true,
            false,
        )
        .unwrap_err();

        assert!(error.contains("ordering buffer too small"));
    }
}
