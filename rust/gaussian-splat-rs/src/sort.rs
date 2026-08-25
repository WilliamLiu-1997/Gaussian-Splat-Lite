const DEPTH_INFINITY_F32: u32 = 0x7f800000;
// 16-bit radix (2 passes)
const RADIX_BITS: u32 = 16;
const RADIX_BASE: usize = 1 << RADIX_BITS; // 65536
const RADIX_MASK: u32 = RADIX_BASE as u32 - 1;

/// Persistent raw/radial centers and affine state for one renderer mesh.
pub struct MeshSortState {
    pub raw_centers: Vec<f32>,
    pub radial_centers: Vec<f32>,
    pub transform: [f64; 9],
    pub origin: [f64; 3],
    pub generation: u32,
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
    /// current mesh center cache generation
    pub mesh_generation: u32,
    /// mesh ID backing each contiguous global splat range
    pub range_mesh_ids: Vec<u32>,
    /// first splat index for each contiguous mesh range
    pub range_bases: Vec<u32>,
    /// active splat count for each contiguous mesh range
    pub range_counts: Vec<u32>,
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
        let mesh = self.ensure_mesh(mesh_id);
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
            .meshes
            .get(mesh_id)
            .map_or(0, |mesh| mesh.raw_centers.len());
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

    {
        let Sort32Buffers {
            meshes,
            range_mesh_ids,
            range_bases,
            range_counts,
            keys,
            buckets16lo,
            buckets16hi,
            ..
        } = buffers;
        buckets16lo.fill(0);
        buckets16hi.fill(0);

        let invalid_key = f32::NAN.to_bits();
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
            // Generate each key and tally both radix passes while its value is
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
                    let key = metric.to_bits();
                    *key_out = key;
                    tally_key(key, buckets16lo, buckets16hi);
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
                let offset = 100.0
                    - (camera_local[0] * direction[0]
                        + camera_local[1] * direction[1]
                        + camera_local[2] * direction[2]);
                let center_slice = &mesh.raw_centers[..count as usize * 3];
                for (center, key_out) in center_slice.chunks_exact(3).zip(key_slice.iter_mut()) {
                    let metric = center[0] * local_direction[0]
                        + center[1] * local_direction[1]
                        + center[2] * local_direction[2]
                        + offset;
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
