//! Resident RAD tree traversal. Source indices and projection arithmetic retain
//! the same ordering and f64 precision as the streaming scheduler.

use std::{cmp::Ordering, collections::BinaryHeap};

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

struct View {
    matrix: [f64; 16],
    pixel_scale: f64,
    radius_scale: f64,
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
        let mut matrix = [0.0; 16];
        matrix.copy_from_slice(&values[..16]);
        let m = &matrix;
        // sqrt(||A||_1 ||A||_inf) also bounds nonuniform scale and shear.
        let columns = (m[0].abs() + m[1].abs() + m[2].abs())
            .max(m[4].abs() + m[5].abs() + m[6].abs())
            .max(m[8].abs() + m[9].abs() + m[10].abs());
        let rows = (m[0].abs() + m[4].abs() + m[8].abs())
            .max(m[1].abs() + m[5].abs() + m[9].abs())
            .max(m[2].abs() + m[6].abs() + m[10].abs());
        Ok(Self {
            matrix,
            pixel_scale: values[16],
            radius_scale: (columns * rows).sqrt(),
            orthographic: values[17] == 1.0,
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
    let mut size = 0.0_f64;
    for view in views {
        let m = &view.matrix;
        let vx = m[0] * x + m[4] * y + m[8] * z + m[12];
        let vy = m[1] * x + m[5] * y + m[9] * z + m[13];
        let vz = m[2] * x + m[6] * y + m[10] * z + m[14];
        let radius = tree.radii[local] as f64 * view.radius_scale;
        let distance = hypot3(vx, vy, vz);
        // A merged Gaussian does not enclose its subtree: keep coarse coverage
        // behind the camera rather than pruning its descendants.
        let facing = if distance > 0.0 {
            (-vz / distance).max(0.0)
        } else {
            1.0
        };
        let weight = if view.orthographic {
            if vz <= 0.0 {
                1.0
            } else {
                0.05
            }
        } else {
            0.05 + 0.95 * facing * facing
        };
        let divisor = if view.orthographic {
            1.0
        } else {
            (distance - radius).max(1e-6)
        };
        size = size.max(2.0 * radius * view.pixel_scale * weight / divisor);
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
        page.tree = Some(Tree {
            generation,
            centers,
            radii,
            child_start: child_start.to_vec(),
            child_count: child_count.to_vec(),
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
            || views.len() % 18 != 0
        {
            return Err(js_error("Invalid RAD LOD request"));
        }
        let views = views
            .chunks_exact(18)
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

    fn enqueue(
        &mut self,
        index: u32,
        page_index: usize,
        views: &[View],
        threshold: f64,
        hysteresis: f64,
    ) -> Result<()> {
        let page = &mut self.pages[page_index];
        let local = (index - page.base) as usize;
        ensure!(
            !contains(&page.seen, local),
            "RAD tree contains a cycle or shared child"
        );
        insert(&mut page.seen, local);
        let tree = page
            .tree
            .as_ref()
            .context("RAD selection references an unavailable page")?;
        let count = tree.child_count.get(local).copied().unwrap_or(0);
        // Terminal nodes never change the cut budget or request pages. Their
        // page was already touched by the parent, so heap insertion is redundant.
        if count == 0 {
            return Ok(());
        }
        let threshold = threshold
            * if contains(&page.refined, local) {
                1.0 - hysteresis
            } else {
                1.0 + hysteresis
            };
        let score = projected_size(tree, local, views) / threshold;
        if score <= 1.0 {
            return Ok(());
        }
        // Cache f64::total_cmp's exact key once instead of at every heap comparison.
        let bits = score.to_bits() as i64;
        let key = bits ^ (((bits >> 63) as u64 >> 1) as i64);
        self.heap.push(Candidate {
            index,
            page: page_index,
            key,
        });
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
        self.enqueue(0, 0, views, threshold, hysteresis)?;
        let mut cut_count = 1_u64;
        while let Some(candidate) = self.heap.pop() {
            let page = &self.pages[candidate.page];
            let local = (candidate.index - page.base) as usize;
            let tree = page.tree.as_ref().unwrap();
            let count = tree.child_count[local] as u32;
            if cut_count - 1 + count as u64 > budget as u64 {
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
            let mut child_page = first;
            for child in start..end as u32 {
                while child - self.pages[child_page].base >= self.pages[child_page].count {
                    child_page += 1;
                }
                self.enqueue(child, child_page, views, threshold, hysteresis)?;
            }
            cut_count += count as u64 - 1;
            insert(&mut self.pages[candidate.page].next_refined, local);
        }
        // Every seen node remains in the cut unless it was successfully refined.
        // Ordered pages and set bits produce stable source order without sorting.
        self.indices.reserve(cut_count as usize);
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
