import type { RadMeta } from "../../rad/radFormat";
import { getRadChunkSpan } from "../../rad/radFormat";

/** CPU-only data retained in the dataset worker, never GPU source storage. */
export type RadLodChunk = {
  base: number;
  numSplats: number;
  centers: Float32Array;
  radii: Float32Array;
  childStart?: Uint32Array;
  childCount?: Uint16Array;
};

export type RadLodView = {
  /** Object-to-camera transform; doubles preserve large scene translations. */
  viewFromObject: number[];
  /** Pixels per camera-space unit at depth 1, including projection zoom. */
  pixelScale: number;
  orthographic: boolean;
};

export type RadLodRequest = {
  views: RadLodView[];
  splatBudget: number;
  pixelThreshold: number;
  residentChunks: number[];
  hysteresis?: number;
};

export type RadLodSelection = {
  /** Stable file indices. The scheduler maps these to occupied GPU slots. */
  indices: Uint32Array;
  wantedChunks: Uint32Array;
  /** Ancestor and selected pages required by this cut. */
  touchedChunks: Uint32Array;
};

/** Resolve global indices without assuming that chunks are 64K records. */
export function radChunkIndex(meta: RadMeta, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.count)
    throw new Error("RAD tree index is out of range");
  const size = meta.chunkSize ?? meta.count;
  const candidate = Math.floor(index / size);
  if (candidate < meta.chunks.length) {
    const range = getRadChunkSpan(meta, candidate);
    if (index >= range.base && index < range.base + range.count)
      return candidate;
  }
  let low = 0;
  let high = meta.chunks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const range = getRadChunkSpan(meta, middle);
    if (index < range.base) high = middle;
    else if (index >= range.base + range.count) low = middle + 1;
    else return middle;
  }
  throw new Error("RAD tree references a gap in the chunk directory");
}

class PriorityHeap {
  indices = new Uint32Array(256);
  scores = new Float64Array(256);
  length = 0;

  push(index: number, score: number) {
    if (this.length === this.indices.length) {
      const indices = new Uint32Array(this.length * 2);
      const scores = new Float64Array(this.length * 2);
      indices.set(this.indices);
      scores.set(this.scores);
      this.indices = indices;
      this.scores = scores;
    }
    let offset = this.length++;
    while (offset > 0) {
      const parent = (offset - 1) >>> 1;
      if (
        this.scores[parent] > score ||
        (this.scores[parent] === score && this.indices[parent] < index)
      )
        break;
      this.indices[offset] = this.indices[parent];
      this.scores[offset] = this.scores[parent];
      offset = parent;
    }
    this.indices[offset] = index;
    this.scores[offset] = score;
  }

  pop(): number {
    const result = this.indices[0];
    const index = this.indices[--this.length];
    const score = this.scores[this.length];
    let offset = 0;
    while (offset * 2 + 1 < this.length) {
      let child = offset * 2 + 1;
      const right = child + 1;
      if (
        right < this.length &&
        (this.scores[right] > this.scores[child] ||
          (this.scores[right] === this.scores[child] &&
            this.indices[right] < this.indices[child]))
      )
        child = right;
      if (
        score > this.scores[child] ||
        (score === this.scores[child] && index < this.indices[child])
      )
        break;
      this.indices[offset] = this.indices[child];
      this.scores[offset] = this.scores[child];
      offset = child;
    }
    this.indices[offset] = index;
    this.scores[offset] = score;
    return result;
  }
}

// Reuse bounded traversal scratch between camera updates in one worker.
const heaps = new WeakMap<RadMeta, PriorityHeap>();

type PreparedView = RadLodView & { radiusScale: number };

function prepareView(view: RadLodView): PreparedView {
  const m = view.viewFromObject;
  // sqrt(||A||_1 ||A||_inf) bounds the largest singular value, including shear.
  const columns = Math.max(
    Math.abs(m[0]) + Math.abs(m[1]) + Math.abs(m[2]),
    Math.abs(m[4]) + Math.abs(m[5]) + Math.abs(m[6]),
    Math.abs(m[8]) + Math.abs(m[9]) + Math.abs(m[10]),
  );
  const rows = Math.max(
    Math.abs(m[0]) + Math.abs(m[4]) + Math.abs(m[8]),
    Math.abs(m[1]) + Math.abs(m[5]) + Math.abs(m[9]),
    Math.abs(m[2]) + Math.abs(m[6]) + Math.abs(m[10]),
  );
  return { ...view, radiusScale: Math.sqrt(columns * rows) };
}

/** Conservative diameter used for refinement, not a subtree bounding volume. */
function projectedSize(
  chunk: RadLodChunk,
  local: number,
  views: PreparedView[],
) {
  const i3 = local * 3;
  const x = chunk.centers[i3];
  const y = chunk.centers[i3 + 1];
  const z = chunk.centers[i3 + 2];
  const radius = chunk.radii[local];
  let size = 0;
  for (const view of views) {
    const m = view.viewFromObject;
    const vx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const vy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const vz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const worldRadius = radius * view.radiusScale;
    const distance = Math.hypot(vx, vy, vz);
    // Retain low-resolution coverage behind the camera; never cull a subtree
    // on the assumption that a merged Gaussian encloses its descendants.
    const facing = distance > 0 ? Math.max(0, -vz / distance) : 1;
    const weight = view.orthographic
      ? vz <= 0
        ? 1
        : 0.05
      : 0.05 + 0.95 * facing * facing;
    const divisor = view.orthographic
      ? 1
      : Math.max(1e-6, distance - worldRadius);
    size = Math.max(
      size,
      (2 * worldRadius * view.pixelScale * weight) / divisor,
    );
  }
  return size;
}

/** Select an ancestor-exclusive cut, keeping parents until their children are resident. */
export function selectRadLod(
  meta: RadMeta,
  chunks: ReadonlyMap<number, RadLodChunk>,
  request: RadLodRequest,
  previousRefined: ReadonlySet<number> = new Set(),
): RadLodSelection & { refinedNodes: Set<number> } {
  const { splatBudget, pixelThreshold, views } = request;
  if (
    !Number.isSafeInteger(splatBudget) ||
    splatBudget < 1 ||
    !Number.isFinite(pixelThreshold) ||
    pixelThreshold <= 0 ||
    views.length === 0 ||
    views.some(
      (view) =>
        view.viewFromObject.length !== 16 ||
        !view.viewFromObject.every(Number.isFinite) ||
        !Number.isFinite(view.pixelScale) ||
        view.pixelScale <= 0,
    )
  )
    throw new Error("Invalid RAD LOD request");
  const hysteresis = request.hysteresis ?? 0.15;
  if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= 1)
    throw new Error("Invalid RAD LOD hysteresis");
  const empty = () => ({
    indices: new Uint32Array(0),
    wantedChunks: new Uint32Array(meta.count ? [0] : []),
    touchedChunks: new Uint32Array(0),
    refinedNodes: new Set<number>(),
  });
  if (!meta.count) return empty();
  const resident = new Set(request.residentChunks);
  if (!resident.has(0) || !chunks.has(0)) return empty();
  const preparedViews = views.map(prepareView);

  const heap = heaps.get(meta) ?? new PriorityHeap();
  heaps.set(meta, heap);
  heap.length = 0;
  const touched = new Set<number>([0]);
  const wanted = new Set<number>();
  const refined = new Set<number>();
  const seen = new Set<number>([0]);
  let residentCount = 0;
  for (const page of resident)
    residentCount += chunks.get(page)?.numSplats ?? 0;
  const output = new Uint32Array(Math.min(splatBudget, residentCount));
  let written = 0;
  let cutCount = 1;

  const read = (index: number) => {
    const page = radChunkIndex(meta, index);
    const chunk = chunks.get(page);
    if (!resident.has(page) || !chunk)
      throw new Error("RAD selection references an unavailable page");
    const local = index - chunk.base;
    if (local < 0 || local >= chunk.numSplats)
      throw new Error("RAD chunk base does not match its tree indices");
    return { page, chunk, local };
  };
  const score = (index: number) => {
    const { chunk, local } = read(index);
    const threshold = previousRefined.has(index)
      ? pixelThreshold * (1 - hysteresis)
      : pixelThreshold * (1 + hysteresis);
    return projectedSize(chunk, local, preparedViews) / threshold;
  };
  heap.push(0, score(0));

  while (heap.length) {
    const priority = heap.scores[0];
    const index = heap.pop();
    const { page, chunk, local } = read(index);
    touched.add(page);
    const count = chunk.childCount?.[local] ?? 0;
    if (priority <= 1 || count === 0 || cutCount - 1 + count > splatBudget) {
      output[written++] = index;
      continue;
    }
    const start = chunk.childStart?.[local];
    if (start === undefined || start + count > meta.count)
      throw new Error("RAD child range is out of bounds");
    const first = radChunkIndex(meta, start);
    const last = radChunkIndex(meta, start + count - 1);
    let ready = true;
    for (let childPage = first; childPage <= last; childPage++) {
      if (!resident.has(childPage) || !chunks.has(childPage)) {
        wanted.add(childPage);
        ready = false;
      } else touched.add(childPage);
    }
    if (!ready) {
      output[written++] = index;
      continue;
    }
    for (let child = start; child < start + count; child++) {
      if (seen.has(child))
        throw new Error("RAD tree contains a cycle or shared child");
      seen.add(child);
      heap.push(child, score(child));
    }
    cutCount += count - 1;
    refined.add(index);
  }
  // Stable source order avoids unnecessary source-index and sort-cache updates
  // when priorities change while the actual cut stays the same.
  const indices = written === output.length ? output : output.slice(0, written);
  indices.sort();
  return {
    indices,
    wantedChunks: Uint32Array.from(wanted),
    touchedChunks: Uint32Array.from(touched),
    refinedNodes: refined,
  };
}
