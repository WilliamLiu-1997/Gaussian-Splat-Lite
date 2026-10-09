import * as THREE from "three";
import type { Splats } from "../data/Splats.js";
import type { SplatFileType } from "../data/defines.js";
import type {
  SplatFileResolver,
  SplatProgressEvent,
} from "../loaders/loadTypes.js";
import type { SplatPostDecodeProgram } from "../loaders/postDecode/program.js";
import type { SplatEdit, SplatEdits } from "./SplatEdit.js";
export type SplatMeshOptions = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  resolveFile?: SplatFileResolver;
  /** Declarative per-splat transform executed in the decode worker. */
  postDecode?: SplatPostDecodeProgram;
  splats?: Splats;
  onProgress?: (event: SplatProgressEvent) => void;
  onLoad?: (mesh: SplatMesh) => Promise<void> | void;
  editable?: boolean;
  raycastable?: boolean;
  minRaycastOpacity?: number;
  onFrame?: (context: {
    mesh: SplatMesh;
    time: number;
    deltaTime: number;
  }) => void;
};
export type SplatMeshFrameContext = {
  time: number;
  deltaTime: number;
  globalEdits: SplatEdit[];
};
export type SplatIntersection = THREE.Intersection<SplatMesh> & {
  /** Current readable index in this mesh's Splats. */
  index: number;
  /** Original file index; for streamed SOG, relative to this batch's chunk. */
  sourceIndex: number;
};
/** A scene object backed by a fixed encoded splat source and RGBA SDF edits. */
export declare class SplatMesh extends THREE.Object3D {
  private lastInitialization?;
  private readiness;
  private onLoad?;
  get isInitialized(): boolean;
  get initialized(): Promise<SplatMesh>;
  private followInitialization;
  splats?: Splats;
  numSplats: number;
  recolor: THREE.Color;
  opacity: number;
  maxSh: number;
  edits: SplatEdit[] | null;
  editable: boolean;
  raycastable: boolean;
  minRaycastOpacity: number;
  sdfEdits: SplatEdits | null;
  onFrame?: SplatMeshOptions["onFrame"];
  version: number;
  sortVersion: number;
  centerVersion: number;
  mappingVersion: number;
  private lastSplats?;
  private lastNumSplats;
  private lastMaxSh;
  private lastMatrixWorld;
  private hasLastMatrixWorld;
  private lastRecolor;
  private sdfCoordinateOrigin;
  constructor(options?: SplatMeshOptions);
  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ): void;
  dispose(): void;
  /** Copy cached local bounds; false includes scale/rotation and shape at source alpha 0.01. */
  getBoundingBox(centersOnly?: boolean, target?: THREE.Box3): THREE.Box3;
  frameUpdate(
    { time, deltaTime, globalEdits }: SplatMeshFrameContext,
    callbacks?: boolean,
  ): void;
  /** Edits applying to this mesh, in order, each with its SDF shapes. */
  private collectEditGroups;
  updateVersion({
    sort,
  }?: {
    sort?: boolean;
  }): void;
  updateMappingVersion(): void;
  set needsUpdate(value: boolean);
  raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void;
}
