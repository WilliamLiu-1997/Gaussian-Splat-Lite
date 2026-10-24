import * as THREE from "three";
import type { Splats } from "../data/Splats.js";
import type { SplatFileType } from "../data/defines.js";
import type {
  SplatFileResolver,
  SplatProgressEvent,
} from "../loaders/loadTypes.js";
import type { SplatPostDecodeProgram } from "../loaders/postDecode/program.js";
import type { SceneRangeMetadata } from "../loaders/stream/scene-stream/SceneBatchAllocator.js";
import type { SplatEdit, SplatEdits } from "./SplatEdit.js";
export type SplatMeshOptions = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  /** Fixed SH limit 0–4 (default 4). Also caps storage when loading a file; existing Splats are unchanged. */
  maxSh?: number;
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
  /** Compact SDF edit storage during an explicit renderer shrink. */
  shrinkResources?: boolean;
};
export type SplatIntersection = THREE.Intersection<SplatMesh> & {
  /** Current readable index in this mesh's Splats. */
  index: number;
  /** Original file index; for streamed SOG, relative to this batch's chunk. */
  sourceIndex: number;
  /** File/range identity for a streamed LCC or LCC2 hit in a shared batch. */
  sceneStream?: SceneRangeMetadata;
