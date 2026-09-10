//! Resident RAD tree traversal. Source indices and projection arithmetic retain
//! the same ordering and f64 precision as the streaming scheduler.

use std::{cmp::Ordering, collections::BinaryHeap, ops::Range};

use anyhow::{ensure, Context, Result};
use gaussian_splat_lib::rad::RadMeta;
use js_sys::{Float32Array, Float64Array, Object, Reflect, Uint16Array, Uint32Array};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{error:#}")).into()
}

struct Tree {
    generation: f64,
    centers: Vec<f32>,
    radii: Vec<f32>,
    child_start: Vec<u32>,
    // Trailing leaf counts are omitted; an empty vector means a leaf-only page.
    child_count: Vec<u16>,
}

struct Page {
    base: u32,
    count: u32,
    tree: Option<Tree>,
    seen: Vec<u64>,
    refined: Vec<u64>,
    next_refined: Vec<u64>,
    resident: bool,
    touched: bool,
    wanted: bool,
}

fn contains(bits: &[u64], index: usize) -> bool {
    bits.get(index / 64)
        .is_some_and(|word| word & (1_u64 << (index % 64)) != 0)
}

fn insert(bits: &mut [u64], index: usize) {
    bits[index / 64] |= 1_u64 << (index % 64);
}

fn visit_range(bits: &mut [u64], range: Range<usize>) -> Result<()> {
    let mut start = range.start;
    while start < range.end {
        let offset = start % 64;
        let count = (range.end - start).min(64 - offset);
        let mask = (u64::MAX >> (64 - count)) << offset;
        let word = &mut bits[start / 64];
        ensure!(
            *word & mask == 0,
            "RAD tree contains a cycle or shared child"
        );
        *word |= mask;
        start += count;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Candidate {
    index: u32,
    page: usize,
    key: i64,
}

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.key == other.key
    }
}
impl Eq for Candidate {}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key
            .cmp(&other.key)
            .then_with(|| other.index.cmp(&self.index))
    }
}

// Model-view matrix, pixel scale, projection type, and X/Y projection rows.
const VIEW_VALUES: usize = 26;

struct View {
    origin: [f64; 3],
    depth: [f64; 3],
    clip_rows: [[f64; 4]; 2],
    pixel_scale: f64,
    orthographic: bool,
}

impl View {
    fn prepare(values: &[f64]) -> Result<Self> {
        ensure!(
            values.iter().all(|v| v.is_finite())
                && values[16] > 0.0
                && (values[17] == 0.0 || values[17] == 1.0),
            "Invalid RAD LOD view"
        );
        let m = values;
        let orthographic = values[17] == 1.0;
        let axes = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
        let max_entry = axes.into_iter().flatten().map(f64::abs).fold(0.0, f64::max);
        // Normalize before forming the inverse.
        let divisor = if max_entry > 0.0 { max_entry } else { 1.0 };
        let axes = axes.map(|axis| axis.map(|value| value / divisor));
        let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        let cross = |a: [f64; 3], b: [f64; 3]| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let inverse_rows = [
            cross(axes[1], axes[2]),
            cross(axes[2], axes[0]),
            cross(axes[0], axes[1]),
        ];
        let determinant = dot(axes[0], inverse_rows[0]);
        ensure!(
            determinant != 0.0,
            "RAD LOD view transform is not invertible"
        );
        let t = [m[12] / divisor, m[13] / divisor, m[14] / divisor];
        let origin = inverse_rows.map(|row| -dot(row, t) / determinant);
        let projection = &values[18..];
        // Project camera-relative object positions. Folding the camera basis
        // into these rows once per view preserves zoom and off-center bounds.
        let clip_rows = [0, 4].map(|start| {
            let row = &projection[start..];
            std::array::from_fn(|axis| {
                if axis == 3 {
                    row[3]
                } else {
                    row[0] * m[axis * 4] + row[1] * m[axis * 4 + 1] + row[2] * m[axis * 4 + 2]
                }
            })
        });
        ensure!(
            origin
                .iter()
                .chain(clip_rows.iter().flatten())
                .all(|value| value.is_finite()),
            "Invalid RAD LOD camera projection"
        );
        Ok(Self {
            origin,
            depth: [-m[2], -m[6], -m[10]],
            clip_rows,
            // Both projections use the camera's pixel scale without an extra
            // model-scale multiplier.
            pixel_scale: values[16],
            orthographic,
        })
    }
}

fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    let values = [x.abs(), y.abs(), z.abs()];
    let max = values[0].max(values[1]).max(values[2]);
    if max.is_infinite() {
        return max;
    }
    if values.iter().any(|value| value.is_nan()) {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    // Match Math.hypot's scaled, compensated sum without overflow/underflow.
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in values {
        let scaled = value / max;
        let corrected = scaled * scaled - compensation;
        let next = sum + corrected;
        compensation = (next - sum) - corrected;
        sum = next;
    }
    sum.sqrt() * max
}

fn projected_size(tree: &Tree, local: usize, views: &[View]) -> f64 {
    let center = &tree.centers[local * 3..local * 3 + 3];
    let [x, y, z] = [center[0] as f64, center[1] as f64, center[2] as f64];
    let radius = tree.radii[local] as f64;
    let mut size = 0.0_f64;
    for view in views {
        let [dx, dy, dz] = [x - view.origin[0], y - view.origin[1], z - view.origin[2]];
        let distance = hypot3(dx, dy, dz).max(1e-6);
        let depth = dx * view.depth[0] + dy * view.depth[1] + dz * view.depth[2];
        // A merged Gaussian does not enclose its subtree: keep coarse coverage
        // behind the camera rather than pruning its descendants.
        let mut weight = 0.05;
        if depth >= 0.0 {
            let [clip_x, clip_y] = view
                .clip_rows
                .map(|row| dx * row[0] + dy * row[1] + dz * row[2] + row[3]);
            let clip_w = if view.orthographic { 1.0 } else { depth };
            let extent = clip_w.max(clip_x.abs()).max(clip_y.abs());
            if extent > 0.0 {
                // Full weight inside the actual visible rectangle. Beyond its
                // edges, taper by squared inverse extent toward the 5% floor.
                let coverage = clip_w / extent;
                weight += 0.95 * coverage * coverage;
            }
        }
        size = size.max(2.0 * radius * view.pixel_scale * weight / distance);
    }
    size
}

#[wasm_bindgen]
pub struct RadLodTree {
    count: u32,
    chunk_size: u32,
    pages: Vec<Page>,
    heap: BinaryHeap<Candidate>,
    indices: Vec<u32>,
    wanted: Vec<u32>,
    touched: Vec<u32>,
}

#[wasm_bindgen]
impl RadLodTree {
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str) -> Result<Self, JsValue> {
        let meta = RadMeta::from_json(meta_json).map_err(js_error)?;
        let pages = (0..meta.chunks.len())
            .map(|index| {
                let (base, count) = meta.chunk_bounds(index)?;
                Ok(Page {
                    base,
                    count,
                    tree: None,
                    seen: Vec::new(),
                    refined: Vec::new(),
                    next_refined: Vec::new(),
                    resident: false,
                    touched: false,
                    wanted: false,
                })
            })
            .collect::<Result<Vec<_>>>()
            .map_err(js_error)?;
        Ok(Self {
            count: meta.count as u32,
            chunk_size: meta.chunk_size.unwrap_or(meta.count as u32),
            pages,
            heap: BinaryHeap::new(),
            indices: Vec::new(),
            wanted: Vec::new(),
            touched: Vec::new(),
        })
    }

    #[allow(clippy::too_many_arguments)] // Copy each transferred tree array once.
    pub fn retain_chunk(
        &mut self,
        index: u32,
        generation: f64,
        centers: Float32Array,
        radii: Float32Array,
        child_start: Uint32Array,
        child_count: Uint16Array,
    ) -> Result<(), JsValue> {
        let page = self
            .pages
            .get_mut(index as usize)
            .context("RAD chunk index out of bounds")
            .map_err(js_error)?;
        if page
            .tree
            .as_ref()
            .is_some_and(|tree| tree.generation > generation)
        {
            return Ok(());
        }
        let valid = generation.is_finite()
            && generation >= 0.0
            && generation.fract() == 0.0
            && generation <= 9_007_199_254_740_991.0
            && centers.length() as u64 == page.count as u64 * 3
            && radii.length() == page.count
            && (child_start.length() == 0 || child_start.length() == page.count)
            && (child_count.length() == 0 || child_count.length() == page.count);
        if !valid {
            return Err(js_error("Invalid RAD tree arrays or generation"));
        }
        let centers = centers.to_vec();
        let radii = radii.to_vec();
        if !centers.iter().all(|v| v.is_finite())
            || !radii.iter().all(|v| v.is_finite() && *v >= 0.0)
        {
            return Err(js_error("Invalid RAD tree center or radius"));
        }
        let words = (page.count as usize).div_ceil(64);
        page.seen.resize(words, 0);
        page.refined.resize(words, 0);
        page.next_refined.resize(words, 0);
        let mut child_count = child_count.to_vec();
        child_count.truncate(
            child_count
                .iter()
                .rposition(|&count| count != 0)
                .map_or(0, |index| index + 1),
        );
        page.tree = Some(Tree {
            generation,
            centers,
            radii,
            child_start: child_start.to_vec(),
            child_count,
        });
        Ok(())
    }

    pub fn release_chunk(&mut self, index: u32, generation: Option<f64>) {
        let Some(page) = self.pages.get_mut(index as usize) else {
            return;
        };
        if generation.is_none()
            || page
                .tree
                .as_ref()
                .is_some_and(|tree| Some(tree.generation) == generation)
        {
            page.tree = None;
            page.seen = Vec::new();
            page.next_refined = Vec::new();
            // Hysteresis refers to the last cut, even if this page is replaced
            // before the next decision. Clear it when that decision commits.
        }
    }

    pub fn select(
        &mut self,
        views: Float64Array,
        resident_chunks: Uint32Array,
        budget: u32,
        threshold: f64,
        hysteresis: f64,
    ) -> Result<JsValue, JsValue> {
        let views = views.to_vec();
        if budget == 0
            || !threshold.is_finite()
            || threshold <= 0.0
            || !hysteresis.is_finite()
            || !(0.0..1.0).contains(&hysteresis)
            || views.is_empty()
            || views.len() % VIEW_VALUES != 0
        {
            return Err(js_error("Invalid RAD LOD request"));
        }
        let views = views
            .chunks_exact(VIEW_VALUES)
            .map(View::prepare)
            .collect::<Result<Vec<_>>>()
            .map_err(js_error)?;
        self.traverse(
            &views,
            &resident_chunks.to_vec(),
            budget,
            threshold,
            hysteresis,
        )
        .map_err(js_error)?;
        let result = Object::new();
        for (key, values) in [
            ("indices", &self.indices),
            ("wantedChunks", &self.wanted),
            ("touchedChunks", &self.touched),
        ] {
            Reflect::set(&result, &key.into(), &Uint32Array::from(values.as_slice()))?;
        }
        for page in &mut self.pages {
            if page.tree.is_some() {
                std::mem::swap(&mut page.refined, &mut page.next_refined);
            } else {
                page.refined = Vec::new();
            }
        }
        Ok(result.into())
    }
}

impl RadLodTree {
    fn page_index(&self, index: u32) -> Result<usize> {
        ensure!(index < self.count, "RAD tree index is out of range");
        let candidate = (index / self.chunk_size) as usize;
        if let Some(page) = self.pages.get(candidate) {
            if index >= page.base && index - page.base < page.count {
                return Ok(candidate);
            }
        }
        // Metadata validation guarantees contiguous, ordered spans.
        Ok(self.pages.partition_point(|page| page.base <= index) - 1)
    }

    fn touch(&mut self, index: usize) {
        if !self.pages[index].touched {
            self.pages[index].touched = true;
            self.touched.push(index as u32);
        }
    }

    fn enqueue_range(
        &mut self,
        indices: Range<u32>,
        page_index: usize,
        max_children: u32,
        views: &[View],
        threshold: f64,
        hysteresis: f64,
    ) -> Result<()> {
        let page = &mut self.pages[page_index];
        let start = (indices.start - page.base) as usize;
        let end = (indices.end - page.base) as usize;
        visit_range(&mut page.seen, start..end)?;
        let tree = page
            .tree
            .as_ref()
            .context("RAD selection references an unavailable page")?;
        for (local, &count) in tree.child_count.iter().enumerate().take(end).skip(start) {
            // The remaining budget only shrinks. Keep these nodes in the cut without
            // scoring or queueing refinements that cannot fit; unary nodes still fit.
            if count == 0 || u32::from(count) > max_children {
                continue;
            }
            let threshold = threshold
                * if contains(&page.refined, local) {
                    1.0 - hysteresis
                } else {
                    1.0 + hysteresis
                };
            let score = projected_size(tree, local, views) / threshold;
            if score <= 1.0 {
                continue;
            }
            // Cache f64::total_cmp's exact key once instead of at every heap comparison.
            let bits = score.to_bits() as i64;
            let key = bits ^ (((bits >> 63) as u64 >> 1) as i64);
            self.heap.push(Candidate {
                index: page.base + local as u32,
                page: page_index,
                key,
            });
        }
        Ok(())
    }

    fn traverse(
        &mut self,
        views: &[View],
        resident: &[u32],
        budget: u32,
        threshold: f64,
        hysteresis: f64,
    ) -> Result<()> {
        self.heap.clear();
        self.indices.clear();
        self.wanted.clear();
        self.touched.clear();
        for page in &mut self.pages {
            page.resident = false;
            page.touched = false;
            page.wanted = false;
            page.seen.fill(0);
            page.next_refined.fill(0);
        }
        for &index in resident {
            if let Some(page) = self.pages.get_mut(index as usize) {
                page.resident = page.tree.is_some();
            }
        }
        if self.count == 0 {
            return Ok(());
        }
        if !self.pages[0].resident {
            self.wanted.push(0);
            return Ok(());
        }
        self.touch(0);
        self.enqueue_range(0..1, 0, budget, views, threshold, hysteresis)?;
        let mut remaining = budget - 1;
        let mut budget_pruned = false;
        while let Some(candidate) = self.heap.pop() {
            let page = &self.pages[candidate.page];
            let local = (candidate.index - page.base) as usize;
            let tree = page.tree.as_ref().unwrap();
            let count = tree.child_count[local] as u32;
            if count > remaining + 1 {
                if !budget_pruned {
                    // Discard permanently blocked candidates in one pass rather
                    // than draining the heap. Limit this scan to once per cut.
                    self.heap.retain(|candidate| {
                        let page = &self.pages[candidate.page];
                        let local = (candidate.index - page.base) as usize;
                        u32::from(page.tree.as_ref().unwrap().child_count[local]) <= remaining + 1
                    });
                    budget_pruned = true;
                }
                continue;
            }
            let start = *tree
                .child_start
                .get(local)
                .context("RAD child range is out of bounds")?;
            let end = start as u64 + count as u64;
            ensure!(end <= self.count as u64, "RAD child range is out of bounds");
            let first = self.page_index(start)?;
            let last = self.page_index((end - 1) as u32)?;
            let mut ready = true;
            for index in first..=last {
                let page = &mut self.pages[index];
                if page.resident {
                    self.touch(index);
                } else {
                    if !page.wanted {
                        page.wanted = true;
                        self.wanted.push(index as u32);
                    }
                    ready = false;
                }
            }
            if !ready {
                continue;
            }
            remaining -= count - 1;
            for child_page in first..=last {
                let page = &self.pages[child_page];
                let children = start.max(page.base)..(end as u32).min(page.base + page.count);
                self.enqueue_range(
                    children,
                    child_page,
                    remaining + 1,
                    views,
                    threshold,
                    hysteresis,
                )?;
            }
            insert(&mut self.pages[candidate.page].next_refined, local);
        }
        // Every seen node remains in the cut unless it was successfully refined.
        // Ordered pages and set bits produce stable source order without sorting.
        self.indices.reserve((budget - remaining) as usize);
        for page in &self.pages {
            for (word, (&seen, &refined)) in page.seen.iter().zip(&page.next_refined).enumerate() {
                let mut selected = seen & !refined;
                while selected != 0 {
                    self.indices
                        .push(page.base + word as u32 * 64 + selected.trailing_zeros());
                    selected &= selected - 1;
                }
            }
        }
        Ok(())
    }
}
