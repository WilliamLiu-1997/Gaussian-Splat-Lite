import * as THREE from "three";
// Target mode fills the budget up to eight times finer than the limit rules;
// detail beyond that would not be visible.
const MIN_TARGET_NEED = 1 / 8;
/** Binary heap; `before(a, b)` puts a ahead of b. */
class Heap {
  constructor(before) {
    this.before = before;
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const items = this.items;
    let slot = items.length;
    items.push(item);
    while (slot) {
      const parent = (slot - 1) >>> 1;
      if (!this.before(item, items[parent])) break;
      items[slot] = items[parent];
      slot = parent;
    }
    items[slot] = item;
  }
  pop() {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (items.length) {
      let slot = 0;
      for (;;) {
        let child = slot * 2 + 1;
        if (child >= items.length) break;
        if (
          child + 1 < items.length &&
          this.before(items[child + 1], items[child])
        )
          child++;
        if (!this.before(items[child], last)) break;
        items[slot] = items[child];
        slot = child;
      }
      items[slot] = last;
    }
    return first;
  }
}
/**
 * XGRIDS Web SDK detail rules: Unit distance bands for LCC, projected node
 * error for LCC2. Refinements are spent in order of need until the budget is
 * full ("target"), or only where those rules ask for them ("limit").
 */
export class LccSelection {
  constructor(index) {
    this.index = index;
    this.box = new THREE.Box3();
    this.point = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.size = new THREE.Vector3();
    this.finestCount = 0;
    for (let node = 0; node < index.numNodes; node++)
      if (!index.childCount[node]) this.finestCount += index.counts[node];
    if (index.format === "lcc")
      this.units = index.roots.filter((root) => {
        let count = 0;
        for (let node = root; node < root + index.levels; node++)
          count += index.counts[node];
        return count >= 100;
      });
    // The coarsest displayed node of each LCC Unit, or each LCC2 root.
    this.coverage =
      index.format === "lcc"
        ? this.units.map((root) => {
            for (let node = root; node < root + index.levels; node++)
              if (index.counts[node] >= 50) return node;
            return -1;
          })
        : index.roots;
    this.empty =
      index.format === "lcc"
        ? !this.units.some((root) =>
            index.counts
              .subarray(root, root + index.levels)
              .some((count) => count >= 50),
          )
        : index.info.levelSplats.every((count) => count === 0);
  }
  select({
    view,
    budget,
    splatBudgetMode,
    lodStepDistance,
    maxScreenSpaceError,
  }) {
    if (!view.shown || !view.cameras.length)
      return { nodes: new Uint32Array(), around: new Uint32Array() };
    const index = this.index;
    const cameras = view.cameras.map((camera) => {
      const modelView = new THREE.Matrix4().fromArray(camera.modelView);
      const projection = new THREE.Matrix4().fromArray(camera.projection);
      return {
        modelView,
        position: new THREE.Vector3().setFromMatrixPosition(
          modelView.clone().invert(),
        ),
        frustum: new THREE.Frustum().setFromProjectionMatrix(
          projection.clone().multiply(modelView),
          camera.coordinateSystem,
          camera.reversedDepth,
        ),
        pixelScale: (Math.abs(camera.projection[5]) * camera.height) / 2,
        orthographic: camera.projection[11] === 0,
        scale: modelView.getMaxScaleOnAxis(),
      };
    });
    const fill = splatBudgetMode === "target";
    const nodes =
      index.format === "lcc"
        ? this.selectUnits(cameras, budget, lodStepDistance, fill)
        : this.selectTree(cameras, budget, maxScreenSpaceError, fill);
    return { nodes, around: this.around(cameras, nodes) };
  }
  /**
   * Coarse coverage within 100 model units of a camera, outside the selection.
   * Like the SDK's download around the camera, it stays resident so turning
   * shows coarse data at once.
   */
  around(cameras, nodes) {
    const index = this.index;
    const selected = new Set(nodes);
    const around = [];
    this.coverage.forEach((node, i) => {
      if (node < 0 || selected.has(node)) return;
      // An LCC Unit is covered when any of its LODs is selected.
      if (index.format === "lcc")
        for (let n = this.units[i]; n < this.units[i] + index.levels; n++)
          if (selected.has(n)) return;
      this.box.min.fromArray(index.bounds, node * 6);
      this.box.max.fromArray(index.bounds, node * 6 + 3);
      if (
        cameras.some(
          ({ position }) => this.box.distanceToPoint(position) <= 100,
        )
      )
        around.push(node);
    });
    return Uint32Array.from(around);
  }
  selectTree(cameras, budget, maxScreenSpaceError, fill) {
    const index = this.index;
    const metrics = new Map();
    const measure = (node) => {
      let result = metrics.get(node);
      if (result) return result;
      this.box.min.fromArray(index.bounds, node * 6);
      this.box.max.fromArray(index.bounds, node * 6 + 3);
      let distance = Number.POSITIVE_INFINITY;
      let visible = false;
      let refine = false;
      let need = 0;
      const level = index.level[node];
      const error =
        index.levels > 1
          ? this.box.getSize(this.size).length() *
            0.1 *
            (0.1 + (0.9 * level) / (index.levels - 1))
          : 0;
      for (const camera of cameras) {
        const seen = camera.frustum.intersectsBox(this.box);
        const near = this.box
          .clampPoint(camera.position, this.point)
          .applyMatrix4(camera.modelView)
          .length();
        if (!visible || seen)
          distance = seen && !visible ? near : Math.min(distance, near);
        visible ||= seen;
        if (!seen) continue;
        const pixels = error * camera.scale * camera.pixelScale;
        // Priority uses the nearest point, so the nodes around the camera
        // refine first even when their centers are far away.
        need = Math.max(
          need,
          pixels /
            (camera.orthographic ? 1 : Math.max(0.1, near)) /
            maxScreenSpaceError,
        );
        if (refine) continue;
        // Perspective distance bands avoid a close node staying coarse
        // because its center is far away. Orthographic error has no depth.
        if (!camera.orthographic && near < 10)
          refine = level > (near < 5 ? 0 : 1);
        else {
          const depth = camera.orthographic
            ? 1
            : Math.max(
                0.1,
                this.box
                  .getCenter(this.center)
                  .applyMatrix4(camera.modelView)
                  .length(),
              );
          refine = pixels / depth > maxScreenSpaceError;
        }
      }
      // Virtual preview levels always give way to the first exported level.
      const preview = level > index.maxLod;
      result = {
        node,
        distance,
        visible,
        refine: visible && (refine || preview) && index.childCount[node] > 0,
        need: preview ? Number.POSITIVE_INFINITY : need,
      };
      metrics.set(node, result);
      return result;
    };
    const heap = new Heap(
      (a, b) => a.need > b.need || (a.need === b.need && a.node < b.node),
    );
    // Only visible roots need coverage. Hidden children of a visible parent
    // stay at their coarse level so replacement still has all its siblings.
    const roots = index.roots.filter((node) => measure(node).visible);
    const selected = new Set(roots);
    const full = this.finestCount <= budget;
    let remaining = budget;
    for (const node of roots) {
      remaining -= index.counts[node];
      heap.push(measure(node));
    }
    while (heap.size) {
      const { node, visible, refine, need } = heap.pop();
      const wanted = full || refine || (fill && need >= MIN_TARGET_NEED);
      if (!visible || !index.childCount[node] || !wanted) continue;
      const first = index.firstChild[node];
      const end = first + index.childCount[node];
      let cost = -index.counts[node];
      for (let child = first; child < end; child++) cost += index.counts[child];
      // A replacement that does not fit keeps this branch; others continue.
      if (cost > remaining) continue;
      remaining -= cost;
      selected.delete(node);
      for (let child = first; child < end; child++) {
        selected.add(child);
        heap.push(measure(child));
      }
    }
    return Uint32Array.from(
      [...selected].sort((a, b) => {
        const x = measure(a);
        const y = measure(b);
        return (
          Number(y.visible) - Number(x.visible) ||
          x.distance - y.distance ||
          a - b
        );
      }),
    );
  }
  selectUnits(cameras, budget, step, fill) {
    const index = this.index;
    // The SDK shows LOD0, or LOD1, uniformly when that entire level fits.
    const fullLevel = index.info.levelSplats.findIndex(
      (count, level) => level < 2 && count > 0 && count < budget,
    );
    this.box.min.fromArray(index.sceneBounds);
    this.box.max.fromArray(index.sceneBounds, 3);
    const size = this.box.getSize(this.size);
    const diagonal = Math.ceil(size.length());
    const lowerHeight = this.box.min.z + 0.2 * size.z;
    const heightSpan = 0.6 * size.z;
    // Near the ground the SDK excludes distant Units, rather than keeping
    // all of them at the coarsest LOD. The range expands for aerial views.
    const ranges = cameras.map(({ position }) => {
      const height = heightSpan
        ? Math.min(1, Math.abs(position.z - lowerHeight) / heightSpan)
        : 1;
      return fullLevel >= 0 || fill || height === 1
        ? Number.POSITIVE_INFINITY
        : THREE.MathUtils.lerp(200, diagonal, height);
    });
    const units = [];
    for (const node of this.units) {
      this.box.min.fromArray(index.bounds, node * 6);
      this.box.max.fromArray(index.bounds, node * 6 + 3);
      this.box.getCenter(this.center);
      let distance = Number.POSITIVE_INFINITY;
      let centerDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < cameras.length; i++) {
        const camera = cameras[i];
        if (!camera.frustum.intersectsBox(this.box)) continue;
        const near = this.box.distanceToPoint(camera.position);
        if (near > ranges[i]) continue;
        distance = Math.min(distance, near);
        centerDistance = Math.min(
          centerDistance,
          this.center.distanceTo(camera.position),
        );
      }
      if (Number.isFinite(distance))
        units.push({ node, distance, centerDistance });
    }
    // Distances are in model coordinates, matching the SDK. LOD uses the
    // nearest box point; budget priority uses the Unit center.
    units.sort(
      (a, b) => a.centerDistance - b.centerDistance || a.node - b.node,
    );
    // Each Unit starts at its coarsest displayed LOD and refines toward its
    // distance band, or toward LOD0 when filling the budget. Like the SDK's
    // LodLevelUp limit, no node may take more than half the budget, so one
    // dense Unit cannot starve its neighbors.
    const maxNodeSplats =
      fullLevel >= 0 ? Number.POSITIVE_INFINITY : budget / 2;
    const chains = [];
    let remaining = budget;
    for (const unit of units) {
      const level =
        fullLevel >= 0
          ? fullLevel
          : fill
            ? 0
            : unit.distance >= 200
              ? index.levels - 1
              : Math.min(index.levels - 1, Math.round(unit.distance / step));
      // The SDK does not display nodes with fewer than 50 records.
      const chain = [];
      for (
        let node = unit.node;
        node < unit.node + index.levels - level;
        node++
      )
        if (index.counts[node] >= 50) chain.push(node);
      if (!chain.length) continue;
      // Without a uniform level, drop the farthest Units whose coarsest
      // displayed levels no longer fit, as the SDK does.
      if (fullLevel < 0 && index.counts[chain[0]] > remaining) break;
      remaining -= index.counts[chain[0]];
      chains.push({ chain, step: 0, distance: unit.distance });
    }
    if (fullLevel < 0) {
      const heap = new Heap(
        (a, b) => a.need > b.need || (a.need === b.need && a.order < b.order),
      );
      const queue = (unit, order) => {
        const next = unit.chain[unit.step + 1];
        if (next === undefined) return;
        // LOD b covers distances below b + 0.5 steps; a larger ratio means
        // the Unit is further from its band. Beyond 1 the band is satisfied.
        const need = ((index.level[next] + 0.5) * step) / unit.distance;
        if (need >= MIN_TARGET_NEED) heap.push({ unit, order, need });
      };
      chains.forEach(queue);
      while (heap.size) {
        const { unit, order } = heap.pop();
        const current = index.counts[unit.chain[unit.step]];
        const next = index.counts[unit.chain[unit.step + 1]];
        // Only this Unit stops when its next LOD does not fit.
        if (next > maxNodeSplats || next - current > remaining) continue;
        remaining -= next - current;
        unit.step++;
        queue(unit, order);
      }
    }
    return Uint32Array.from(chains, ({ chain, step }) =>
      fullLevel >= 0 ? chain.at(-1) : chain[step],
    );
  }
}
