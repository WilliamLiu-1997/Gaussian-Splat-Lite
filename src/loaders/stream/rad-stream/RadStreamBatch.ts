import {
  RadPagedSplats,
  type RadPagedSplatsOptions,
} from "../../../data/RadPagedSplats";
import { SplatMesh } from "../../../scene/SplatMesh";

/** A fixed pool of RAD pages sharing one scene node and accumulator call. */
export class RadStreamBatch extends SplatMesh {
  readonly source: RadPagedSplats;

  constructor(options: RadPagedSplatsOptions) {
    const source = new RadPagedSplats(options);
    super({ splats: source });
    this.source = source;
    this.name = "rad-batch";
    this.maxSh = source.numSh;
  }

  setSelection(indices: Uint32Array, fades?: Uint8Array) {
    if (!this.source.setSelection(indices, fades)) return false;
    this.numSplats = this.source.getNumSplats();
    // Count alone cannot detect replacing a parent with a single child or a
    // same-sized cut: invalidate the mapping and sort/center versions together.
    this.updateMappingVersion();
    return true;
  }

  setFadeProgress(progress: number) {
    if (!this.source.setFadeProgress(progress)) return false;
    this.updateVersion({ sort: false });
    return true;
  }

  finishFadeIn() {
    if (!this.source.finishFadeIn()) return false;
    this.updateVersion({ sort: false });
    return true;
  }

  override dispose() {
    this.removeFromParent();
    super.dispose();
    this.numSplats = 0;
  }
}
