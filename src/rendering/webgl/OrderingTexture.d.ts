import type * as THREE from "three";
import type { CPUOrderingUpdate } from "../backend.js";
/** CPU ordering storage shared by both WebGL backends; uploads stay backend-specific. */
export declare class OrderingTexture {
  texture: THREE.DataTexture | null;
  getCapacity(count: number): number;
  get data(): Uint32Array | null;
  update(
    { ordering, activeSplats, requiredCapacity, shrink }: CPUOrderingUpdate,
    uploadRows: (texture: THREE.DataTexture, rows: number) => void,
  ): THREE.DataTexture;
  dispose(): void;
}
