import { RadPagedSplats } from "../../../data/RadPagedSplats.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** A fixed pool of RAD pages sharing one scene node and accumulator call. */
export class RadStreamBatch extends SplatMesh {
  constructor(options) {
    const source = new RadPagedSplats(options);
    super({ splats: source });
    this.source = source;
    this.name = "rad-batch";
    this.maxSh = source.numSh;
  }
  clearSelection() {
    if (!this.source.clearSelection()) return false;
    this.numSplats = 0;
    this.updateMappingVersion();
    return true;
  }
  setFadeProgress(progress) {
    if (!this.source.setFadeProgress(progress)) return false;
    this.updateVersion({ sort: false });
    return true;
  }
  commitSelection(prepared) {
    this.source.commitSelection(prepared);
    this.numSplats = this.source.getNumSplats();
    this.updateMappingVersion();
  }
  finishFade() {
    if (!this.source.finishFade()) return false;
    if (this.numSplats !== this.source.getNumSplats()) {
      this.numSplats = this.source.getNumSplats();
      this.updateMappingVersion();
    } else this.updateVersion({ sort: false });
    return true;
  }
  dispose() {
    this.removeFromParent();
    super.dispose();
    this.numSplats = 0;
  }
}
