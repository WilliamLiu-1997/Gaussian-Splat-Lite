import * as THREE from "three";
import { StreamFrusta } from "../streamView.js";
import { readSogLodLeaf, selectSogLods } from "./sogLod.js";
/** Worker traversal state keeps leaf identities stable between selections. */
export class SogVisibility {
  constructor(manifest) {
    this.manifest = manifest;
    this.leaves = new Map();
    this.frusta = new StreamFrusta();
    this.bound = new THREE.Box3();
  }
  collect(view) {
    const cameras = this.frusta.prepare(view);
    const visible = [];
    const { shown } = view;
    const nodes = this.manifest.nodes;
    for (let index = 0; shown && index < nodes.length / 8; ) {
      const offset = index * 8;
      this.bound.min.fromArray(nodes, offset);
      this.bound.max.fromArray(nodes, offset + 3);
      const id = nodes[offset + 7];
      if (id < 0) {
        // A branch only needs one view that sees it.
        if (cameras.some(({ frustum }) => frustum.intersectsBox(this.bound)))
          index++;
        else index = nodes[offset + 6];
        continue;
      }
      // A leaf tests each view once for visibility and detail together: the
      // nearest view that sees it decides its detail.
      let seen = false;
      let distance = Number.POSITIVE_INFINITY;
      for (const camera of cameras) {
        if (!camera.frustum.intersectsBox(this.bound)) continue;
        seen = true;
        // World-space distance to the box, without weighting by its radius.
        distance = Math.min(distance, this.frusta.distance(camera, this.bound));
      }
      if (!seen) {
        index = nodes[offset + 6];
        continue;
      }
      index++;
      let leaf = this.leaves.get(id);
      if (!leaf) {
        leaf = readSogLodLeaf(this.manifest, id);
        this.leaves.set(id, leaf);
      }
      visible.push({ leaf, distance });
    }
    return visible;
  }
  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(request) {
    const visible = this.collect(request.view);
    const targets = selectSogLods(visible, this.manifest.lodLevels, request);
    visible.sort((a, b) => a.distance - b.distance || a.leaf.id - b.leaf.id);
    const result = new Uint32Array(targets.size * 2);
    let offset = 0;
    for (const { leaf } of visible) {
      const target = targets.get(leaf.id);
      if (!target) continue;
      result[offset++] = leaf.id;
      result[offset++] = leaf.lods.indexOf(target);
    }
    return result;
  }
}
