import type * as THREE from "three";
import type { GaussianSplatCompatibleRenderer } from "../rendering/rendererUtils.js";
import type { PendingUploads } from "./pendingUploads.js";

export declare class ShPalette {
  readonly stride: number;
  /** Texture tile order; consuming a source may transfer it. */
  readonly data: Uint32Array;
  private readonly layout;
  private readonly width;
  private readonly height;
  private readonly depth;
  private dataTexture?;
  private uploaded;
  private uploadQueue?;
  constructor(data: Uint32Array, degree: 1 | 2 | 3 | 4);
  get texture(): THREE.DataArrayTexture;
  get byteLength(): number;
  get pendingUploadBytes(): number;
  /** A shared palette must be uploaded before its pages or regions can display. */
  prepareUpload(queue: PendingUploads): boolean;
  uploadPending(renderer: GaussianSplatCompatibleRenderer): void;
  word(label: number, coefficient: number): number;
  bind(uniforms: Record<string, THREE.IUniform>): void;
  dispose(): void;
}
