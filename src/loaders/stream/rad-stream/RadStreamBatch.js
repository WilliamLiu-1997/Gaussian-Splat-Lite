import { RadPageView } from "../../../data/RadPagedSplats.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** One input's pages in a pool, drawn with that input's transform. */
export class RadStreamBatch extends SplatMesh {
  constructor(storage, maxSh) {
    const source = new RadPageView(storage);
    super({ splats: source, maxSh });
    this.source = source;
    this.name = "rad-batch";
  }
  /** Redraw after the pool's fade coefficients change. */
  fadeChanged() {
    if (this.numSplats === 0) return false;
    this.updateVersion({ sort: false });
    return true;
  }
  commitSelection(cut) {
    this.source.commitSelection(cut);
    this.numSplats = this.source.getNumSplats();
    this.updateMappingVersion();
  }
  /** Drop outgoing records, or redraw when only the fade opacity changed. */
  finishFade(faded) {
    if (!this.source.finishFade()) return faded && this.fadeChanged();
    this.numSplats = this.source.getNumSplats();
    this.updateMappingVersion();
    return true;
  }
  dispose() {
    this.removeFromParent();
    super.dispose();
    this.numSplats = 0;
  }
}
