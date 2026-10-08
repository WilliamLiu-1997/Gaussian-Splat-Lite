import type * as THREE from "three";
import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
import type { SplatAccumulator } from "./SplatAccumulator";
import type { SplatMaterial } from "./backend";

/** Optional behavior registered with a GaussianSplatRenderer. */
export interface SplatRendererPlugin {
  readonly name: string;
  init(renderer: GaussianSplatRenderer): void;
  dispose(): void;
  /** Independent renderer state, including offscreen captures. */
  clone?(): SplatRendererPlugin;
  /** Copy settings to an existing clone before its next capture. */
  copy?(source: SplatRendererPlugin): void;
  /** Called after the renderer's world matrix is updated. */
  sync?(): void;
  selectMaterial?(stochastic: boolean): SplatMaterial | null;
  startsFrame?(counterChanged: boolean): boolean;
  prepareDraw?(
    scene: THREE.Scene,
    camera: THREE.Camera,
    display: SplatAccumulator,
  ): void;
}
