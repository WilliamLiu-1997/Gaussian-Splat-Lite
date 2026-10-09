import { SogRegionSplats } from "../../../data/SogRegionSplats.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** Regions share one source, one scene node and one accumulator generation call. */
export class SogStreamBatch extends SplatMesh {
  constructor(capacity, numSh, group, onEmpty) {
    const source = new SogRegionSplats(capacity, numSh);
    super({ splats: source });
    this.numSh = numSh;
    this.group = group;
    this.onEmpty = onEmpty;
    this.slots = new Map();
    this.source = source;
    this.name = "sog-batch";
  }
  get residentBytes() {
    return this.source.residentBytes;
  }
  writeRegion(start, data) {
    const count = data.numSplats;
    // The scheduler assigns disjoint fixed slots; only occupancy changes.
    this.source.write(start, data);
    this.slots.set(start, count);
  }
  setRegionOpacity(start, opacity) {
    const count = this.slots.get(start);
    if (count === undefined) return;
    const changed = this.source.setOpacity(start, count, opacity);
    if (!changed) return;
    if (changed.visibilityChanged) {
      this.numSplats = this.source.getNumSplats();
      this.updateMappingVersion();
      if (this.numSplats > 0 && this.parent !== this.group) {
        this.layers.mask = this.group.layers.mask;
        this.group.add(this);
      } else if (this.numSplats === 0) this.removeFromParent();
    } else this.updateVersion({ sort: false });
  }
  releaseRegion(start) {
    if (!this.slots.has(start)) return;
    this.setRegionOpacity(start, 0);
    this.source.release(start);
    this.slots.delete(start);
    if (!this.slots.size) {
      this.dispose();
      this.onEmpty();
    }
  }
}
