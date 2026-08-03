const DEPTH_INFINITY_F32: u32 = 0x7f800000;
// 16-bit radix (2 passes)
const RADIX_BITS: u32 = 16;
const RADIX_BASE: usize = 1 << RADIX_BITS; // 65536
const RADIX_MASK: u32 = RADIX_BASE as u32 - 1;

#[derive(Default)]
pub struct Sort32Buffers {
    /// raw f32 bit-patterns (one per splat)
    pub readback: Vec<u32>,
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
    /// ensure all internal buffers are large enough for up to `max_splats`
    pub fn ensure_size(&mut self, max_splats: usize) {
        if self.readback.len() < max_splats {
            self.readback.resize(max_splats, 0);
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
pub fn sort32_internal(
    buffers: &mut Sort32Buffers,
    max_splats: usize,
    num_splats: usize,
) -> Result<u32, String> {
    buffers.ensure_size(max_splats);

    let Sort32Buffers {
        readback,
        ordering,
        buckets16lo,
        buckets16hi,
        scratch,
    } = buffers;
    let keys = &readback[..num_splats];

    // Tally low and high buckets.
    buckets16lo.fill(0);
    buckets16hi.fill(0);

    macro_rules! tick {
        ($key:expr) => {{
            if $key < DEPTH_INFINITY_F32 {
                let inv = !$key;
                let lo = inv & RADIX_MASK;
                let hi = inv >> RADIX_BITS;

                // The mask and shift guarantee both bucket indices are in bounds.
                unsafe { *buckets16lo.get_unchecked_mut(lo as usize) += 1 };
                unsafe { *buckets16hi.get_unchecked_mut(hi as usize) += 1 };
            }
        }};
    }

    let mut chunks = keys.chunks_exact(8);
    for chunk in chunks.by_ref() {
        tick!(chunk[0]);
        tick!(chunk[1]);
        tick!(chunk[2]);
        tick!(chunk[3]);
        tick!(chunk[4]);
        tick!(chunk[5]);
        tick!(chunk[6]);
        tick!(chunk[7]);
    }
    for &key in chunks.remainder() {
        tick!(key);
    }

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
        buffers.readback = vec![0x7f800000, 0x7fc00000, 0x80000000, 0xff800000];
        buffers.ordering = vec![7, 7, 7, 7];

        assert_eq!(sort32_internal(&mut buffers, 4, 4), Ok(0));
        assert_eq!(buffers.ordering, [7, 7, 7, 7]);
    }

    #[test]
    fn orders_finite_keys_descending_and_stably() {
        let mut buffers = Sort32Buffers::default();
        buffers.readback = vec![
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
        for (dst, value) in buffers.readback.iter_mut().zip(values) {
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
                buffers.readback[index] = value.to_bits();
                expected.push((index as u32, value));
            }
            expected.sort_by(|left, right| right.1.total_cmp(&left.1));

            let active = sort32_internal(&mut buffers, len, len).unwrap();
            let expected_indices: Vec<u32> = expected.into_iter().map(|(index, _)| index).collect();

            assert_eq!(active as usize, len);
            assert_eq!(&buffers.ordering[..len], expected_indices.as_slice());
        }
    }
}
