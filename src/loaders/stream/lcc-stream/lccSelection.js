import * as THREE from "three";
import { StreamFrusta } from "../streamView.js";
const EMPTY = new Uint32Array(0);
function emptyBounds() {
  return [
    ...new Array(3).fill(Number.POSITIVE_INFINITY),
    ...new Array(3).fill(Number.NEGATIVE_INFINITY),
  ];
}
/** Binary min-heap of node refinements, ordered by key then node ID. */
class RefinementHeap {
  constructor() {
    this.keys = [];
    this.nodes = [];
  }
  get size() {
    return this.nodes.length;
  }
  clear() {
    this.keys.length = this.nodes.length = 0;
  }
  less(a, b) {
    const { keys, nodes } = this;
    return keys[a] < keys[b] || (keys[a] === keys[b] && nodes[a] < nodes[b]);
  }
  swap(a, b) {
    const { keys, nodes } = this;
    [keys[a], keys[b]] = [keys[b], keys[a]];
    [nodes[a], nodes[b]] = [nodes[b], nodes[a]];
  }
  push(key, node) {
    let slot = this.nodes.length;
    this.keys.push(key);
    this.nodes.push(node);
    while (slot > 0) {
      const parent = (slot - 1) >> 1;
      if (!this.less(slot, parent)) break;
      this.swap(slot, parent);
      slot = parent;
    }
  }
  pop() {
    const node = this.nodes[0];
    const last = this.nodes.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.nodes.pop();
    for (let slot = 0; ; ) {
      const left = slot * 2 + 1;
      if (left >= last) break;
      const child =
        left + 1 < last && this.less(left + 1, left) ? left + 1 : left;
      if (!this.less(child, slot)) break;
      this.swap(child, slot);
      slot = child;
    }
    return node;
  }
}
/**
 * Worker-side LOD cuts. Every node is judged by its own bounds: the nearest
 * view that sees it sets its distance, and only visible nodes refine.
 */
export class LccSelection {
  constructor(table) {
    this.table = table;
    const count = table.nodeCount;
    this.frusta = new StreamFrusta();
    this.box = new THREE.Box3();
    this.seen = [];
    this.heap = new RefinementHeap();
    this.generation = 0;
    this.measured = new Uint32Array(count);
    this.visible = new Uint8Array(count);
    this.distance = new Float64Array(count);
    // 1 while a node is in the cut, 2 once refined; reset after each cut.
    this.state = new Uint8Array(count);
    this.childSplats = new Float64Array(count);
    for (let node = 0; node < count; node++) {
      const first = table.firstChild[node];
      for (let child = 0; child < table.childCount[node]; child++)
        this.childSplats[node] += table.count[first + child];
    }
    // Union of the loaded data bounds of each LCC Unit chain.
    this.chainBounds = new Map();
  }
  /** Memory retained for the table and selection scratch arrays. */
  get byteLength() {
    const table = this.table;
    let bytes = 0;
    for (const array of [
      table.count,
      table.level,
      table.parent,
      table.firstChild,
      table.childCount,
      table.location,
      table.start,
      table.bounds,
      table.cullBounds,
      table.roots,
      this.measured,
      this.visible,
      this.distance,
      this.state,
      this.childSplats,
    ])
      bytes += array.byteLength;
    return bytes;
  }
  measure(node, cameras) {
    if (this.measured[node] === this.generation) return;
    this.measured[node] = this.generation;
    const { bounds, cullBounds } = this.table;
    const { box, seen } = this;
    box.min.fromArray(cullBounds, node * 6);
    box.max.fromArray(cullBounds, node * 6 + 3);
    let visible = false;
    for (let index = 0; index < cameras.length; index++) {
      seen[index] = cameras[index].frustum.intersectsBox(box);
      visible ||= seen[index];
    }
    box.min.fromArray(bounds, node * 6);
    box.max.fromArray(bounds, node * 6 + 3);
    let distance = Number.POSITIVE_INFINITY;
    // The nearest view that sees a node decides its detail; hidden nodes
    // still order their coarse coverage by the nearest view.
    for (let index = 0; index < cameras.length; index++)
      if (!visible || seen[index])
        distance = Math.min(
          distance,
          this.frusta.distance(cameras[index], box),
        );
    this.visible[node] = visible ? 1 : 0;
    this.distance[node] = distance;
  }
  /**
   * Choose the cut within the budget. Coarse coverage of every root comes
   * first, visible roots nearest first. Refinements then proceed by distance
   * relative to their level's band; one that does not fit is skipped, so a
   * dense node cannot hold back the rest of the scene.
   */
  select({ view, budget, splatBudgetMode, lodBaseDistance, lodMultiplier }) {
    if (!view.shown || !view.cameras.length) return EMPTY;
    const table = this.table;
    const cameras = this.frusta.prepare(view);
    this.generation = (this.generation + 1) >>> 0 || 1;
    const limit = splatBudgetMode === "limit";
    const heap = this.heap;
    heap.clear();
    const touched = [];
    let remaining = budget;
    const consider = (node) => {
      if (!this.visible[node] || !table.childCount[node]) return;
      const band = lodMultiplier ** (table.level[node] - 1);
      const distance = this.distance[node];
      if (limit && distance >= lodBaseDistance * band) return;
      heap.push(distance / band, node);
    };
    const roots = Array.from(table.roots);
    for (const root of roots) this.measure(root, cameras);
    roots.sort(
      (a, b) =>
        this.visible[b] - this.visible[a] ||
        this.distance[a] - this.distance[b] ||
        a - b,
    );
    for (const root of roots) {
      if (table.count[root] > remaining) continue;
      remaining -= table.count[root];
      this.state[root] = 1;
      touched.push(root);
      consider(root);
    }
    while (heap.size) {
      const node = heap.pop();
      const cost = this.childSplats[node] - table.count[node];
      if (cost > remaining) continue;
      remaining -= cost;
      this.state[node] = 2;
      const first = table.firstChild[node];
      for (let child = first; child < first + table.childCount[node]; child++) {
        this.state[child] = 1;
        touched.push(child);
        this.measure(child, cameras);
        consider(child);
      }
    }
    const cut = touched.filter((node) => this.state[node] === 1);
    for (const node of touched) this.state[node] = 0;
    // Loading order: visible nodes nearest first, then coarse coverage behind.
    cut.sort(
      (a, b) =>
        this.visible[b] - this.visible[a] ||
        this.distance[a] - this.distance[b] ||
        a - b,
    );
    return Uint32Array.from(cut);
  }
  /**
   * Tighten bounds from loaded data. An LCC Unit's levels cover the same
   * region, so its whole chain shares the union of its loaded levels; LCC2
   * nodes keep their manifest bounds and widen culling to the data's extent.
   */
  setBounds(updates) {
    const table = this.table;
    for (const { node, centers, extent } of updates) {
      if (table.format === "lcc") {
        const levels = table.levels;
        const first = node - (node % levels);
        let chain = this.chainBounds.get(first);
        if (!chain) {
          chain = { centers: emptyBounds(), extent: emptyBounds() };
          this.chainBounds.set(first, chain);
        }
        for (let axis = 0; axis < 3; axis++) {
          for (const [target, source] of [
            [chain.centers, centers],
            [chain.extent, extent],
          ]) {
            target[axis] = Math.min(target[axis], source[axis]);
            target[axis + 3] = Math.max(target[axis + 3], source[axis + 3]);
          }
        }
        if (!(chain.centers[0] <= chain.centers[3])) continue;
        for (let chainNode = first; chainNode < first + levels; chainNode++) {
          table.bounds.set(chain.centers, chainNode * 6);
          table.cullBounds.set(chain.extent, chainNode * 6);
        }
      } else {
        for (let axis = 0; axis < 3; axis++) {
          const offset = node * 6 + axis;
          table.cullBounds[offset] = Math.min(
            table.cullBounds[offset],
            extent[axis],
          );
          table.cullBounds[offset + 3] = Math.max(
            table.cullBounds[offset + 3],
            extent[axis + 3],
          );
        }
      }
    }
  }
}
