//! Resident RAD tree traversal. Source indices and projection arithmetic retain
//! the same ordering and f64 precision as the streaming scheduler.

use std::ops::Range;

use anyhow::{ensure, Context, Result};
use gaussian_splat_lib::rad::RadMeta;
use js_sys::{
    Array, Float32Array, Float64Array, Object, Reflect, Uint16Array, Uint32Array, Uint8Array,
};
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
    // Nodes replaced by children during the current traversal.
    refined: Vec<u64>,
    resident: bool,
    touched: bool,
    wanted: bool,
}

struct Source {
    id: u32,
    count: u32,
    chunk_size: u32,
    pages: Vec<Page>,
    indices: Vec<u32>,
    views: Range<usize>,
    pool_group: usize,
}

impl Source {
    // Nonempty child ranges are validated when their page is registered.
    fn page_index(&self, index: u32) -> usize {
        let candidate = (index / self.chunk_size) as usize;
        if let Some(page) = self.pages.get(candidate) {
            if index >= page.base && index - page.base < page.count {
                return candidate;
            }
        }
        // Metadata validation guarantees contiguous, ordered spans.
        self.pages.partition_point(|page| page.base <= index) - 1
    }
}

// Keep RAD_POOL_PAGE_COUNT in src/data/defines.js in sync.
const POOL_PAGE_COUNT: usize = 8;

// Inputs of one stored SH degree share pools and page costs.
struct PoolBudget {
    sh: u8,
    page_bytes: [f64; 2],
    pages: usize,
}

impl PoolBudget {
    fn additional_capacity(&self, pages: usize) -> usize {
        ((self.pages + pages).div_ceil(POOL_PAGE_COUNT) - self.pages.div_ceil(POOL_PAGE_COUNT))
            * POOL_PAGE_COUNT
    }
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

struct Candidate {
    source_index: usize,
    index: u32,
    // Reject unaffordable refinements without looking up their tree page.
    child_count: u32,
    size: f64,
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
    // Validated finite centers and camera origins cannot produce NaN deltas.
    let values = [x.abs(), y.abs(), z.abs()];
    let max = values[0].max(values[1]).max(values[2]);
    if max.is_infinite() {
        return max;
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
#[derive(Default)]
pub struct RadLodTree {
    roots: Vec<usize>,
    sources: Vec<Source>,
    pool_budgets: Vec<PoolBudget>,
    stack: Vec<Candidate>,
    frontier: Vec<Candidate>,
    wanted: Vec<u32>,
    touched: Vec<u32>,
    reserved_bytes: [f64; 2],
    memory_limits: [f64; 2],
}

#[wasm_bindgen]
impl RadLodTree {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Keep each source's chunk and splat addresses local to its own directory.
    pub fn add_source(&mut self, id: u32, meta_json: &str) -> Result<(), JsValue> {
        let meta = RadMeta::from_json(meta_json).map_err(js_error)?;
        if self.sources.iter().any(|source| source.id == id) {
            return Err(js_error("RAD source already exists"));
        }
        let pages = (0..meta.chunks.len())
            .map(|index| {
                let (base, count) = meta.chunk_bounds(index)?;
                Ok(Page {
                    base,
                    count,
                    tree: None,
                    seen: Vec::new(),
                    refined: Vec::new(),
                    resident: false,
                    touched: false,
                    wanted: false,
                })
            })
            .collect::<Result<Vec<_>>>()
            .map_err(js_error)?;
        self.sources.push(Source {
            id,
            count: meta.count as u32,
            chunk_size: meta.chunk_size.unwrap_or(meta.count as u32),
            pages,
            indices: Vec::new(),
            views: 0..0,
            pool_group: 0,
        });
        Ok(())
    }

    /// Drop the entire local directory without changing any surviving address.
    pub fn remove_source(&mut self, id: u32) {
        self.sources.retain(|source| source.id != id);
    }

    #[allow(clippy::too_many_arguments)] // Copy each transferred tree array once.
    pub fn retain_chunk(
        &mut self,
        source_id: u32,
        index: u32,
        generation: f64,
        centers: Float32Array,
        radii: Float32Array,
        child_start: Uint32Array,
        child_count: Uint16Array,
    ) -> Result<(), JsValue> {
        let Some(source_index) = self.source_index(source_id) else {
            return Ok(());
        };
        let source = &mut self.sources[source_index];
        let page = source
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
        let valid = centers.length() as u64 == page.count as u64 * 3
            && radii.length() == page.count
            && (child_start.length() == 0 || child_start.length() == page.count)
            && (child_count.length() == 0 || child_count.length() == page.count);
        if !valid {
            return Err(js_error("Invalid RAD tree arrays"));
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
        let mut child_count = child_count.to_vec();
        child_count.truncate(
            child_count
                .iter()
                .rposition(|&count| count != 0)
                .map_or(0, |index| index + 1),
        );
        let child_start = child_start.to_vec();
        for (&start, &count) in child_start.iter().zip(&child_count) {
            if count != 0 && u64::from(start) + u64::from(count) > u64::from(source.count) {
                return Err(js_error("RAD child range is out of bounds"));
            }
        }
        page.tree = Some(Tree {
            generation,
            centers,
            radii,
            child_start,
            child_count,
        });
        Ok(())
    }

    pub fn release_chunk(&mut self, source_id: u32, index: u32, generation: Option<f64>) {
        let Some(page) = self
            .source_index(source_id)
            .and_then(|source_index| self.sources[source_index].pages.get_mut(index as usize))
        else {
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
            page.refined = Vec::new();
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn select(
        &mut self,
        views: Float64Array,
        source_ids: Uint32Array,
        source_sh: Uint8Array,
        page_bytes: Float64Array,
        resident_chunks: Uint32Array,
        budget: u32,
        threshold: f64,
        cpu_budget: f64,
        gpu_budget: f64,
        budget_tolerance: f64,
    ) -> Result<JsValue, JsValue> {
        let views = views.to_vec();
        let source_ids = source_ids.to_vec();
        let source_sh = source_sh.to_vec();
        let page_bytes = page_bytes.to_vec();
        if budget == 0
            || !cpu_budget.is_finite()
            || cpu_budget <= 0.0
            || !gpu_budget.is_finite()
            || gpu_budget <= 0.0
            || !budget_tolerance.is_finite()
            || budget_tolerance < 0.0
            || !threshold.is_finite()
            || threshold <= 0.0
            || views.is_empty()
            || source_ids.is_empty()
            || !resident_chunks.length().is_multiple_of(2)
            || source_sh.len() != source_ids.len()
            || page_bytes.len() != source_ids.len() * 2
            || page_bytes
                .iter()
                .any(|cost| !cost.is_finite() || *cost <= 0.0)
            || !views.len().is_multiple_of(VIEW_VALUES * source_ids.len())
        {
            return Err(js_error("Invalid RAD LOD request"));
        }
        let views = views
            .chunks_exact(VIEW_VALUES)
            .map(View::prepare)
            .collect::<Result<Vec<_>>>()
            .map_err(js_error)?;
        self.roots.clear();
        self.pool_budgets.clear();
        let view_count = views.len() / source_ids.len();
        let mut source_indices = Vec::with_capacity(source_ids.len());
        for (offset, id) in source_ids.into_iter().enumerate() {
            let sh = source_sh[offset];
            let group = self
                .pool_budgets
                .iter()
                .position(|pool| pool.sh == sh)
                .unwrap_or_else(|| {
                    self.pool_budgets.push(PoolBudget {
                        sh,
                        page_bytes: [page_bytes[offset * 2], page_bytes[offset * 2 + 1]],
                        pages: 0,
                    });
                    self.pool_budgets.len() - 1
                });
            let index = self
                .source_index(id)
                .context("RAD source does not exist")
                .map_err(js_error)?;
            source_indices.push(index);
            let source = &mut self.sources[index];
            source.views = offset * view_count..(offset + 1) * view_count;
            source.pool_group = group;
            if source.count > 0 {
                self.roots.push(index);
            }
        }
        self.memory_limits = [cpu_budget, gpu_budget];
        self.traverse(
            &views,
            &resident_chunks.to_vec(),
            budget,
            threshold,
            budget_tolerance,
        )
        .map_err(js_error)?;
        let result = Object::new();
        let sources = Array::new();
        for index in source_indices {
            let source = &self.sources[index];
            let cut = Object::new();
            Reflect::set(&cut, &"source".into(), &source.id.into())?;
            Reflect::set(
                &cut,
                &"indices".into(),
                &Uint32Array::from(source.indices.as_slice()),
            )?;
            sources.push(&cut);
        }
        Reflect::set(&result, &"sources".into(), &sources)?;
        for (key, values) in [
            ("wantedChunks", &self.wanted),
            ("touchedChunks", &self.touched),
        ] {
            Reflect::set(&result, &key.into(), &Uint32Array::from(values.as_slice()))?;
        }
        Ok(result.into())
    }
}

impl RadLodTree {
    fn source_index(&self, id: u32) -> Option<usize> {
        self.sources.iter().position(|source| source.id == id)
    }

    fn touch(&mut self, source_index: usize, page_index: usize) {
        if !self.sources[source_index].pages[page_index].touched {
            self.reserve_page(source_index, page_index);
            let source = &mut self.sources[source_index];
            source.pages[page_index].touched = true;
            self.touched.extend([source.id, page_index as u32]);
        }
    }

    // Missing pages are requested in refinement priority order.
    fn want(&mut self, source_index: usize, page_index: usize) {
        self.reserve_page(source_index, page_index);
        let source = &mut self.sources[source_index];
        let page = &mut source.pages[page_index];
        if !page.wanted {
            page.wanted = true;
            self.wanted.extend([source.id, page_index as u32]);
        }
    }

    fn reserve_page(&mut self, source_index: usize, page_index: usize) {
        let source = &self.sources[source_index];
        let page = &source.pages[page_index];
        if !page.touched && !page.wanted {
            let pool = &mut self.pool_budgets[source.pool_group];
            let capacity = pool.additional_capacity(1) as f64;
            for (reserved, cost) in self.reserved_bytes.iter_mut().zip(pool.page_bytes) {
                *reserved += cost * capacity;
            }
            pool.pages += 1;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue_range(
        &mut self,
        source_index: usize,
        indices: Range<u32>,
        page_index: usize,
        max_children: u32,
        views: &[View],
        threshold: f64,
    ) -> Result<()> {
        let source = &mut self.sources[source_index];
        let page = &mut source.pages[page_index];
        // Each input has its own views, including its model transform.
        let views = &views[source.views.clone()];
        let start = (indices.start - page.base) as usize;
        let end = (indices.end - page.base) as usize;
        visit_range(&mut page.seen, start..end)?;
        // Only resident pages are enqueued during this synchronous traversal.
        let tree = page.tree.as_ref().unwrap();
        for (local, &count) in tree.child_count.iter().enumerate().take(end).skip(start) {
            // The remaining budget only shrinks. Keep these nodes in the cut without
            // scoring or queueing refinements that cannot fit; unary nodes still fit.
            if count == 0 || u32::from(count) > max_children {
                continue;
            }
            let size = projected_size(tree, local, views);
            if size <= threshold {
                continue;
            }
            let candidate = Candidate {
                source_index,
                index: page.base + local as u32,
                child_count: u32::from(count),
                size,
            };
            self.stack.push(candidate);
        }
        Ok(())
    }

    #[inline(always)]
    fn refine(
        &mut self,
        candidate: Candidate,
        remaining: &mut u32,
        views: &[View],
        threshold: f64,
    ) -> Result<()> {
        let source_index = candidate.source_index;
        let source = &self.sources[source_index];
        let parent_page = source.page_index(candidate.index);
        let page = &source.pages[parent_page];
        let local = (candidate.index - page.base) as usize;
        let tree = page.tree.as_ref().unwrap();
        let start = *tree
            .child_start
            .get(local)
            .context("RAD child range is out of bounds")?;
        let end = start + candidate.child_count;
        let first = source.page_index(start);
        let last = source.page_index(end - 1);
        // Claim pages in refinement priority order, including missing pages.
        // Keeping the parent when its children do not fit produces a complete
        // coarser cut and lets the scheduler retire lower-priority old pages.
        let additional = (first..=last)
            .filter(|&index| !source.pages[index].touched && !source.pages[index].wanted)
            .count();
        let pool = &self.pool_budgets[source.pool_group];
        let capacity = pool.additional_capacity(additional) as f64;
        if (0..2).any(|kind| {
            self.reserved_bytes[kind] + capacity * pool.page_bytes[kind] > self.memory_limits[kind]
        }) {
            return Ok(());
        }
        let mut ready = true;
        for index in first..=last {
            if self.sources[source_index].pages[index].resident {
                self.touch(source_index, index);
            } else {
                self.want(source_index, index);
                ready = false;
            }
        }
        if !ready {
            return Ok(());
        }
        *remaining -= candidate.child_count - 1;
        for child_page in first..=last {
            let page = &self.sources[source_index].pages[child_page];
            let children = start.max(page.base)..end.min(page.base + page.count);
            self.enqueue_range(
                source_index,
                children,
                child_page,
                *remaining + 1,
                views,
                threshold,
            )?;
        }
        insert(
            &mut self.sources[source_index].pages[parent_page].refined,
            local,
        );
        Ok(())
    }

    fn traverse(
        &mut self,
        views: &[View],
        resident: &[u32],
        budget: u32,
        threshold: f64,
        budget_tolerance: f64,
    ) -> Result<()> {
        self.stack.clear();
        self.frontier.clear();
        self.wanted.clear();
        self.touched.clear();
        self.reserved_bytes = [0.0; 2];
        for source in &mut self.sources {
            source.indices.clear();
            for page in &mut source.pages {
                page.resident = false;
                page.touched = false;
                page.wanted = false;
                page.seen.fill(0);
                page.refined.fill(0);
            }
        }
        for pair in resident.chunks_exact(2) {
            if let Some(page) = self
                .source_index(pair[0])
                .and_then(|source_index| self.sources[source_index].pages.get_mut(pair[1] as usize))
            {
                page.resident = page.tree.is_some();
            }
        }
        let count: u64 = self
            .roots
            .iter()
            .map(|&index| u64::from(self.sources[index].count))
            .sum();
        if count == 0 {
            return Ok(());
        }
        ensure!(
            budget as usize >= self.roots.len(),
            "RAD splat budget must cover every source root"
        );
        let cap = (budget as f64 * (1.0 + budget_tolerance)).min(count as f64) as u32;
        let mut remaining = cap - self.roots.len() as u32;
        for root in 0..self.roots.len() {
            let source_index = self.roots[root];
            if !self.sources[source_index].pages[0].resident {
                self.want(source_index, 0);
                continue;
            }
            self.touch(source_index, 0);
            self.enqueue_range(source_index, 0..1, 0, remaining + 1, views, threshold)?;
        }
        ensure!(
            (0..2).all(|kind| self.reserved_bytes[kind] <= self.memory_limits[kind]),
            "RAD memory budgets must cover every source root"
        );
        let mut current = (threshold * 1000.0).min(f64::MAX);
        loop {
            // Finish a threshold round before stopping at the target, but
            // never exceed the allowed cap, even for a large sibling group.
            let unary_only = cap - remaining >= budget;
            if unary_only {
                current = threshold;
            }
            while let Some(candidate) = self.stack.pop() {
                if candidate.child_count > remaining + 1
                    || (unary_only && candidate.child_count != 1)
                {
                    continue;
                }
                if candidate.size <= current {
                    self.frontier.push(candidate);
                    continue;
                }
                self.refine(candidate, &mut remaining, views, threshold)?;
            }
            if self.frontier.is_empty() || current == threshold {
                break;
            }
            let ratio = (cap - remaining) as f64 / budget as f64;
            current = (0.99 * current * ratio.sqrt())
                .max(0.5 * current)
                .max(threshold);
            std::mem::swap(&mut self.stack, &mut self.frontier);
        }
        // Every seen node remains in the cut unless it was successfully refined.
        // Ordered pages and set bits produce stable source order without sorting.
        for source in &mut self.sources {
            for page in &source.pages {
                for (word, (&seen, &refined)) in page.seen.iter().zip(&page.refined).enumerate() {
                    let mut selected = seen & !refined;
                    while selected != 0 {
                        source
                            .indices
                            .push(page.base + word as u32 * 64 + selected.trailing_zeros());
                        selected &= selected - 1;
                    }
                }
            }
        }
        Ok(())
    }
}
