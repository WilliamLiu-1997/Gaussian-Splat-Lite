import type {
  RadPagedSplats,
  RadPagedSplatsOptions,
  RadPreparedSelection,
} from "../../../data/RadPagedSplats.js";
import { SplatMesh } from "../../../scene/SplatMesh.js";
/** A fixed pool of RAD pages sharing one scene node and accumulator call. */
export declare class RadStreamBatch extends SplatMesh {
  readonly source: RadPagedSplats;
  constructor(options: RadPagedSplatsOptions);
  clearSelection(): boolean;
  setFadeProgress(progress: number): boolean;
  commitSelection(prepared: RadPreparedSelection): void;
  finishFade(): boolean;
  dispose(): void;
}
