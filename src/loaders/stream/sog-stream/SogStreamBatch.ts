import type * as THREE from "three";
import { SogRegionSplats } from "../../../data/SogRegionSplats";
import type { SplatResult } from "../../../data/defines";
import { SplatMesh } from "../../../scene/SplatMesh";

/** Regions share one source, one scene node and one accumulator generation call. */
export class SogStreamBatch extends SplatMesh {
  private readonly source: SogRegionSplats;
  private readonly slots = new Map<number, number>();

  constructor(
    capacity: number,
    readonly numSh: number,
    private readonly group: THREE.Group,
    private readonly onEmpty: () => void,
  ) {
    const source = new SogRegionSplats(capacity, numSh);
    super({ splats: source });
    this.source = source;
    this.name = "sog-batch";
  }

  get residentBytes() {
    return this.source.residentBytes;
  }

  beginUpdate() {
    this.source.beginUpdate();
    this.layers.mask = this.group.layers.mask;
  }

  uploadBytes(start: number, count: number) {
    return this.source.uploadBytes(start, count);
  }

  writeRegion(start: number, data: SplatResult) {
    const count = data.numSplats;
    // The scheduler assigns disjoint fixed slots; only occupancy changes.
    if (this.slots.has(start))
      throw new Error("Streaming batch region slot is occupied");
    this.source.write(start, data);
    this.slots.set(start, count);
  }

  setRegionOpacity(start: number, opacity: number) {
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

  releaseRegion(start: number) {
    if (!this.slots.has(start)) return;
    this.setRegionOpacity(start, 0);
    this.slots.delete(start);
    if (!this.slots.size) {
      this.dispose();
      this.onEmpty();
      return;
    }
  }
}
