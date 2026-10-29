use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

/// Codes per block: block `b` holds component `d` of code `8b + j` at
/// `(b * dims + d) * 8 + j`, so one vector load reads four codes.
const BLOCK: usize = 8;
/// Blocks compared with every point of a call before the next tile, so a
/// tile of codes stays cached.
const TILE: usize = 64;
/// Vectors of state per group of four points: the best distance and its
/// code for each lane of the two halves of a block, for each point.
const STATE: usize = 16;

/// The dot products of the four points from `point` with the eight codes of
/// the block at `code`: point p and half h in `[p * 2 + h]`.
macro_rules! dots {
    ($point:expr, $dims:expr, $code:expr) => {{
        let mut sums = [f32x4_splat(0.0); 8];
        for d in 0..$dims {
            let low = v128_load($code.add(d * BLOCK) as *const v128);
            let high = v128_load($code.add(d * BLOCK + 4) as *const v128);
            for p in 0..4 {
                let x = f32x4_splat(*$point.add(p * $dims + d));
                sums[p * 2] = f32x4_relaxed_madd(x, low, sums[p * 2]);
                sums[p * 2 + 1] = f32x4_relaxed_madd(x, high, sums[p * 2 + 1]);
            }
        }
        sums
    }};
}

/// Writes to `labels` the index of the nearest code of each of `count`
/// points, a multiple of 4, each with `dims` components. `codes` holds
/// `blocks` blocks and `norms` the squared length of each code; codes that
/// fill the last block need an infinite norm. `state` has room for
/// `count / 4 * 16` vectors. Ties go to the lowest index.
///
/// # Safety
///
/// Every pointer must address memory of this module large enough for the
/// counts given, `codes`, `norms` and `state` aligned to 16 bytes.
#[no_mangle]
#[target_feature(enable = "simd128,relaxed-simd")]
pub unsafe extern "C" fn nearest(
    points: *const f32,
    count: usize,
    dims: usize,
    codes: *const f32,
    norms: *const f32,
    blocks: usize,
    state: *mut v128,
    labels: *mut u32,
) {
    let groups = count / 4;
    for group in 0..groups {
        let saved = state.add(group * STATE);
        for k in 0..8 {
            *saved.add(k) = f32x4_splat(f32::INFINITY);
            *saved.add(8 + k) = u32x4_splat(0);
        }
    }
    let lanes = [u32x4(0, 1, 2, 3), u32x4(4, 5, 6, 7)];
    let two = f32x4_splat(2.0);
    let mut first = 0;
    while first < blocks {
        let last = (first + TILE).min(blocks);
        for group in 0..groups {
            let point = points.add(group * 4 * dims);
            let saved = state.add(group * STATE);
            let mut best = [f32x4_splat(0.0); 8];
            let mut index = [u32x4_splat(0); 8];
            for k in 0..8 {
                best[k] = *saved.add(k);
                index[k] = *saved.add(8 + k);
            }
            for block in first..last {
                let sums = dots!(point, dims, codes.add(block * dims * BLOCK));
                let base = u32x4_splat((block * BLOCK) as u32);
                for (half, lane) in lanes.iter().enumerate() {
                    let norm = v128_load(norms.add(block * BLOCK + half * 4) as *const v128);
                    let ids = u32x4_add(base, *lane);
                    for p in 0..4 {
                        let k = p * 2 + half;
                        let distance = f32x4_relaxed_nmadd(two, sums[k], norm);
                        let closer = f32x4_lt(distance, best[k]);
                        best[k] = v128_bitselect(distance, best[k], closer);
                        index[k] = v128_bitselect(ids, index[k], closer);
                    }
                }
            }
            for k in 0..8 {
                *saved.add(k) = best[k];
                *saved.add(8 + k) = index[k];
            }
        }
        first = last;
    }
    // Each lane kept its first nearest code; the lowest index wins among
    // lanes at the same distance.
    for group in 0..groups {
        let saved = state.add(group * STATE);
        for p in 0..4 {
            let mut nearest = f32::INFINITY;
            let mut label = 0;
            for half in 0..2 {
                let k = p * 2 + half;
                let distances: [f32; 4] = core::mem::transmute(*saved.add(k));
                let indices: [u32; 4] = core::mem::transmute(*saved.add(8 + k));
                for lane in 0..4 {
                    let distance = distances[lane];
                    if distance < nearest || (distance == nearest && indices[lane] < label) {
                        nearest = distance;
                        label = indices[lane];
                    }
                }
            }
            *labels.add(group * 4 + p) = label;
        }
    }
}

/// Writes the expanded distance of each of four points to every code of
/// `blocks` blocks to `out`, `blocks * 8` values per point.
#[target_feature(enable = "simd128,relaxed-simd")]
unsafe fn distances(
    points: *const f32,
    dims: usize,
    codes: *const f32,
    norms: *const f32,
    blocks: usize,
    out: *mut f32,
) {
    let two = f32x4_splat(2.0);
    for block in 0..blocks {
        let sums = dots!(points, dims, codes.add(block * dims * BLOCK));
        for half in 0..2 {
            let norm = v128_load(norms.add(block * BLOCK + half * 4) as *const v128);
            for p in 0..4 {
                let at = out.add(p * blocks * BLOCK + block * BLOCK + half * 4);
                let distance = f32x4_relaxed_nmadd(two, sums[p * 2 + half], norm);
                v128_store(at as *mut v128, distance);
            }
        }
    }
}

/// Writes the distance to the nearest code of blocks `first..first +
/// blocks` and its position for each of `count` points, a multiple of 4.
/// Ties go to the lowest position.
#[target_feature(enable = "simd128,relaxed-simd")]
#[allow(clippy::too_many_arguments)]
unsafe fn scan(
    points: *const f32,
    count: usize,
    dims: usize,
    codes: *const f32,
    norms: *const f32,
    first: usize,
    blocks: usize,
    found: *mut f32,
    index: *mut u32,
) {
    let lanes = [u32x4(0, 1, 2, 3), u32x4(4, 5, 6, 7)];
    let two = f32x4_splat(2.0);
    for group in 0..count / 4 {
        let point = points.add(group * 4 * dims);
        let mut best = [f32x4_splat(f32::INFINITY); 8];
        let mut ids = [u32x4_splat(u32::MAX); 8];
        for block in first..first + blocks {
            let sums = dots!(point, dims, codes.add(block * dims * BLOCK));
            let base = u32x4_splat((block * BLOCK) as u32);
            for (half, lane) in lanes.iter().enumerate() {
                let norm = v128_load(norms.add(block * BLOCK + half * 4) as *const v128);
                let at = u32x4_add(base, *lane);
                for p in 0..4 {
                    let k = p * 2 + half;
                    let distance = f32x4_relaxed_nmadd(two, sums[k], norm);
                    let closer = f32x4_lt(distance, best[k]);
                    best[k] = v128_bitselect(distance, best[k], closer);
                    ids[k] = v128_bitselect(at, ids[k], closer);
                }
            }
        }
        for p in 0..4 {
            let mut nearest = f32::INFINITY;
            let mut label = u32::MAX;
            for half in 0..2 {
                let k = p * 2 + half;
                let distances: [f32; 4] = core::mem::transmute(best[k]);
                let indices: [u32; 4] = core::mem::transmute(ids[k]);
                for lane in 0..4 {
                    let distance = distances[lane];
                    if distance < nearest || (distance == nearest && indices[lane] < label) {
                        nearest = distance;
                        label = indices[lane];
                    }
                }
            }
            *found.add(group * 4 + p) = nearest;
            *index.add(group * 4 + p) = label;
        }
    }
}

/// Sizes in bytes of the parts of the scratch memory of `probed`, each
/// rounded to 16 bytes: distances to the centers of four points, the groups
/// of each point, the points of each group, the gathered points of a group
/// with their nearest codes, and each point's best distance.
fn parts(count: usize, dims: usize, groups: usize, probes: usize) -> [usize; 8] {
    let rows = count + 4;
    [
        4 * groups.next_multiple_of(BLOCK) * 4,
        count * probes * 4,
        (groups + 1) * 4,
        count * probes * 4,
        rows * dims * 4,
        rows * 4,
        rows * 4,
        count * 4,
    ]
    .map(|bytes| bytes.next_multiple_of(16))
}

/// Bytes of scratch memory that `probed` needs.
#[no_mangle]
pub extern "C" fn probed_scratch(count: usize, dims: usize, groups: usize, probes: usize) -> usize {
    parts(count, dims, groups, probes).iter().sum()
}

/// Like `nearest`, but each of `count` points, a multiple of 4, searches
/// only the codes of the `probes` groups whose centers are nearest to it,
/// at most `groups`. Group g holds `sizes[g]` blocks of `codes` from block
/// `starts[g]`; the `groups` centers lie in blocks in `centers`, padded and
/// empty ones with infinite norms. Writes the position of each point's code
/// in `codes` to `labels`. Points are processed by group, so that each
/// group's codes are read once for all points that search them.
///
/// # Safety
///
/// As for `nearest`; `scratch` has `probed_scratch` bytes, aligned to 16.
#[no_mangle]
#[target_feature(enable = "simd128,relaxed-simd")]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn probed(
    points: *const f32,
    count: usize,
    dims: usize,
    centers: *const f32,
    center_norms: *const f32,
    groups: usize,
    codes: *const f32,
    norms: *const f32,
    starts: *const u32,
    sizes: *const u32,
    probes: usize,
    scratch: *mut u8,
    labels: *mut u32,
) {
    let center_blocks = groups.div_ceil(BLOCK);
    let width = center_blocks * BLOCK;
    let mut at = scratch;
    let [row, chosen, ends, lists, gathered, found, index, best] =
        parts(count, dims, groups, probes).map(|bytes| {
            let part = at;
            at = at.add(bytes);
            part
        });
    let (row, gathered, found, best) = (
        row as *mut f32,
        gathered as *mut f32,
        found as *mut f32,
        best as *mut f32,
    );
    let (chosen, ends, lists, index) = (
        chosen as *mut u32,
        ends as *mut u32,
        lists as *mut u32,
        index as *mut u32,
    );
    // The nearest `probes` groups of each point, nearest first, and the
    // number of points of each group.
    for g in 0..=groups {
        *ends.add(g) = 0;
    }
    for i in 0..count {
        if i % 4 == 0 {
            distances(
                points.add(i * dims),
                dims,
                centers,
                center_norms,
                center_blocks,
                row,
            );
        }
        let row = row.add((i % 4) * width);
        let pick = chosen.add(i * probes);
        let mut filled = 0;
        for g in 0..groups {
            let d = *row.add(g);
            if filled == probes && d >= *row.add(*pick.add(probes - 1) as usize) {
                continue;
            }
            let mut slot = filled.min(probes - 1);
            while slot > 0 && d < *row.add(*pick.add(slot - 1) as usize) {
                *pick.add(slot) = *pick.add(slot - 1);
                slot -= 1;
            }
            *pick.add(slot) = g as u32;
            filled = (filled + 1).min(probes);
        }
        for k in 0..probes {
            *ends.add(*pick.add(k) as usize + 1) += 1;
        }
        *best.add(i) = f32::INFINITY;
        *labels.add(i) = u32::MAX;
    }
    // Lists the points of each group in order; `ends[g]` then ends group g.
    for g in 0..groups {
        *ends.add(g + 1) += *ends.add(g);
    }
    for i in 0..count {
        for k in 0..probes {
            let g = *chosen.add(i * probes + k) as usize;
            *lists.add(*ends.add(g) as usize) = i as u32;
            *ends.add(g) += 1;
        }
    }
    let mut begin = 0;
    for g in 0..groups {
        let end = *ends.add(g) as usize;
        let n = end - begin;
        if n > 0 && *sizes.add(g) > 0 {
            // The last point fills the final group of 4.
            let rows = n.div_ceil(4) * 4;
            for r in 0..rows {
                let i = *lists.add(begin + r.min(n - 1)) as usize;
                core::ptr::copy_nonoverlapping(points.add(i * dims), gathered.add(r * dims), dims);
            }
            let (first, blocks) = (*starts.add(g) as usize, *sizes.add(g) as usize);
            scan(
                gathered, rows, dims, codes, norms, first, blocks, found, index,
            );
            for r in 0..n {
                let i = *lists.add(begin + r) as usize;
                let (d, c) = (*found.add(r), *index.add(r));
                if d < *best.add(i) || (d == *best.add(i) && c < *labels.add(i)) {
                    *best.add(i) = d;
                    *labels.add(i) = c;
                }
            }
        }
        begin = end;
    }
}
