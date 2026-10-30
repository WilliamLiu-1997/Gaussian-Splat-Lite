import type {
  RadPageView,
  RadPagedSplats,
  RadPreparedViewCut,
} from "../../../data/RadPagedSplats.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** One input's pages in a pool, drawn with that input's transform. */
export declare class RadStreamBatch extends SplatMesh {
  readonly source: RadPageView;
  constructor(storage: RadPagedSplats, maxSh: number);
  /** Redraw after the pool's fade coefficients change. */
  fadeChanged(): boolean;
  commitSelection(cut: RadPreparedViewCut): void;
  /** Drop outgoing records, or redraw when only the fade opacity changed. */
  finishFade(faded: boolean): boolean;
  dispose(): void;
}
