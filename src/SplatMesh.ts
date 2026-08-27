import * as THREE from "three";

import {
  get_raycast_buffer,
  get_raycast_buffer2,
  raycast_splat_buffers,
} from "gaussian-splat-rs";
import { SplatEdit, SplatEditSdf, SplatEdits } from "./SplatEdit";
import { type SplatInput, Splats } from "./Splats";
import type { SplatFileType } from "./defines";
import type { SplatPostDecodeProgram } from "./postDecode";
import * as wasm from "./wasm";

const raycastWorldToMesh = new THREE.Matrix4();
const raycastDirectionMatrix = new THREE.Matrix3();
const raycastOrigin = new THREE.Vector3();
const raycastDirection = new THREE.Vector3();

export type SplatMeshOptions = {
  url?: string;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  stream?: ReadableStream;
  /** Exact number of bytes yielded by stream; also used for allocation validation. */
  streamLength?: number;
  /** Declarative per-splat transform executed in the decode worker. */
  postDecode?: SplatPostDecodeProgram;
  splats?: Splats;
  maxSplats?: number;
  constructSplats?: (splats: Splats) => Promise<void> | void;
  onProgress?: (event: ProgressEvent) => void;
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
  camera: THREE.Camera;
  globalEdits: SplatEdit[];
};

function validateSplatMeshInitializationInputs(options: SplatMeshOptions) {
  const inputs: string[] = [];
  if (options.url !== undefined) inputs.push("url");
  if (options.fileBytes !== undefined) inputs.push("fileBytes");
  if (options.stream !== undefined) inputs.push("stream");
  if (options.splats !== undefined) inputs.push("splats");
  if (options.constructSplats !== undefined) inputs.push("constructSplats");
  if (inputs.length > 1) {
    throw new Error(
      `SplatMesh initialization inputs are mutually exclusive; provide only one of url, fileBytes, stream, splats, or constructSplats (received: ${inputs.join(", ")})`,
    );
  }
}

/** A scene object backed by a fixed encoded splat source and RGBA SDF edits. */
export class SplatMesh extends THREE.Object3D {
  initialized: Promise<SplatMesh>;
  isInitialized = false;

  splats?: Splats;

  numSplats = 0;
  recolor = new THREE.Color(1, 1, 1);
  opacity = 1;
  maxSh = 3;

  edits: SplatEdit[] | null = null;
  editable: boolean;
  raycastable: boolean;
  minRaycastOpacity: number;
  sdfEdits: SplatEdits | null = null;

  onFrame?: SplatMeshOptions["onFrame"];

  version = 0;
  sortVersion = 0;
  centerVersion = 0;
  mappingVersion = 0;

  private lastSplats?: Splats;
  private lastNumSplats = -1;
  private lastMaxSh = -1;
  private lastMatrixWorld = new THREE.Matrix4();
  private hasLastMatrixWorld = false;
  private lastRecolor = new THREE.Vector4().setScalar(Number.NaN);
  private viewOrigin = new THREE.Vector3();
  private lastViewOrigin = new THREE.Vector3().setScalar(Number.NaN);
  private sdfCoordinateOrigin = new THREE.Vector3();

  constructor(options: SplatMeshOptions = {}) {
    super();

    if (options.splats && !(options.splats instanceof Splats)) {
      throw new TypeError("SplatMesh splats must be a Splats instance");
    }
    validateSplatMeshInitializationInputs(options);
    this.splats =
      options.splats ??
      new Splats({
        url: options.url,
        fileBytes: options.fileBytes,
        fileType: options.fileType,
        fileName: options.fileName,
        stream: options.stream,
        streamLength: options.streamLength,
        postDecode: options.postDecode,
        maxSplats: options.maxSplats,
        construct: options.constructSplats,
        onProgress: options.onProgress,
      });

    this.numSplats = this.splats.getNumSplats();
    this.editable = options.editable ?? true;
    this.raycastable = options.raycastable ?? true;
    this.minRaycastOpacity = options.minRaycastOpacity ?? 0.05;
    this.onFrame = options.onFrame;

    if (!this.splats.isInitialized) {
      this.initialized = this.splats.initialized.then(async () => {
        this.numSplats = this.splats?.getNumSplats() ?? 0;
        this.updateMappingVersion();
        this.isInitialized = true;
        await options.onLoad?.(this);
        return this;
      });
    } else {
      this.isInitialized = true;
      const maybePromise = options.onLoad?.(this);
      this.initialized =
        maybePromise instanceof Promise
          ? maybePromise.then(() => this)
          : Promise.resolve(this);
    }
  }

  pushSplats(splats: readonly SplatInput[]) {
    if (!this.splats) {
      throw new Error("Cannot push Splats after SplatMesh is disposed");
    }
    this.splats.pushSplats(splats);
    this.numSplats = this.splats.getNumSplats();
  }

  setSplats(indices: readonly number[], splats: readonly SplatInput[]) {
    if (!this.splats) {
      throw new Error("Cannot set Splats after SplatMesh is disposed");
    }
    this.splats.setSplats(indices, splats);
    this.numSplats = this.splats.getNumSplats();
  }

  removeSplats(indices: readonly number[]) {
    if (!this.splats) {
      throw new Error("Cannot remove Splats after SplatMesh is disposed");
    }
    this.splats.removeSplats(indices);
    this.numSplats = this.splats.getNumSplats();
  }

  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ) {
    this.splats?.forEachSplat(callback);
  }

  dispose() {
    // @ts-ignore Object base class has a dispose method in Three.js >= r186
    super.dispose?.();

    this.sdfEdits?.dispose();
    this.sdfEdits = null;
    this.splats?.dispose();
    this.splats = undefined;
  }

  getBoundingBox(centersOnly = true) {
    if (!this.isInitialized) {
      throw new Error(
        "Cannot get bounding box before SplatMesh is initialized",
      );
    }
    const minimum = new THREE.Vector3().setScalar(Number.POSITIVE_INFINITY);
    const maximum = new THREE.Vector3().setScalar(Number.NEGATIVE_INFINITY);
    const corner = new THREE.Vector3();

    if (centersOnly) {
      this.splats?.forEachCenter((_index, x, y, z) => {
        if (Number.isNaN(x)) return;
        corner.set(x, y, z);
        minimum.min(corner);
        maximum.max(corner);
      });
      return new THREE.Box3(minimum, maximum);
    }

    const signs = [-1, 1];
    this.splats?.forEachSplat((_index, center, scales, quaternion) => {
      for (const x of signs) {
        for (const y of signs) {
          for (const z of signs) {
            corner
              .set(x * scales.x, y * scales.y, z * scales.z)
              .applyQuaternion(quaternion)
              .add(center);
            minimum.min(corner);
            maximum.max(corner);
          }
        }
      }
    });
    return new THREE.Box3(minimum, maximum);
  }

  frameUpdate({ time, deltaTime, camera, globalEdits }: SplatMeshFrameContext) {
    this.onFrame?.({ mesh: this, time, deltaTime });

    const source = this.splats;
    if (!source) {
      return;
    }
    this.splats = source;

    let updated = false;
    let centersUpdated = false;
    let transformUpdated = false;
    const count = source.getNumSplats();
    if (source !== this.lastSplats) {
      this.lastSplats = source;
      updated = true;
      centersUpdated = true;
    }
    if (count !== this.lastNumSplats) {
      this.lastNumSplats = count;
      this.numSplats = count;
      this.mappingVersion += 1;
      updated = true;
      centersUpdated = true;
    }
    if (source.needsUpdate) {
      updated = true;
      centersUpdated = true;
    }
    if (this.maxSh !== this.lastMaxSh) {
      this.lastMaxSh = this.maxSh;
      updated = true;
    }
    if (this.maxSh > 0 && source.getNumSh() > 0) {
      camera.getWorldPosition(this.viewOrigin);
      if (!this.viewOrigin.equals(this.lastViewOrigin)) {
        this.lastViewOrigin.copy(this.viewOrigin);
        // Directional SH changes appearance but never changes splat depth.
        updated = true;
      }
    }

    this.updateWorldMatrix(true, false);
    if (
      !this.hasLastMatrixWorld ||
      !this.lastMatrixWorld.equals(this.matrixWorld)
    ) {
      this.lastMatrixWorld.copy(this.matrixWorld);
      this.hasLastMatrixWorld = true;
      updated = true;
      transformUpdated = true;
    }

    const recolor = new THREE.Vector4(
      this.recolor.r,
      this.recolor.g,
      this.recolor.b,
      this.opacity,
    );
    if (!recolor.equals(this.lastRecolor)) {
      this.lastRecolor.copy(recolor);
      updated = true;
    }

    const edits = new Set<SplatEdit>();
    if (this.editable) {
      for (const edit of globalEdits) edits.add(edit);
      if (this.edits) {
        for (const edit of this.edits) edits.add(edit);
      } else {
        this.traverseVisible((node) => {
          if (node instanceof SplatEdit) edits.add(node);
        });
      }
    }
    const orderedEdits = Array.from(edits).sort(
      (left, right) => left.ordering - right.ordering,
    );
    const groups = orderedEdits.map((edit) => {
      if (edit.sdfs) return { edit, sdfs: edit.sdfs };
      const sdfs: SplatEditSdf[] = [];
      edit.traverseVisible((node) => {
        if (node instanceof SplatEditSdf) sdfs.push(node);
      });
      return { edit, sdfs };
    });

    if (groups.length > 0 && !this.sdfEdits) {
      this.sdfEdits = new SplatEdits({
        maxEdits: groups.length,
        maxSdfs: groups.reduce((total, group) => total + group.sdfs.length, 0),
      });
      updated = true;
    }
    const sdfCoordinateOrigin = this.sdfCoordinateOrigin.setFromMatrixPosition(
      this.matrixWorld,
    );
    if (this.sdfEdits?.update(groups, sdfCoordinateOrigin).updated) {
      // RGBA-only SDF changes preserve centers and their existing sort order.
      updated = true;
    }

    if (updated) {
      this.version += 1;
      if (centersUpdated || transformUpdated) this.sortVersion += 1;
      if (centersUpdated) this.centerVersion += 1;
    }
  }

  updateVersion({ sort = true }: { sort?: boolean } = {}) {
    this.version += 1;
    if (sort) {
      this.sortVersion += 1;
      this.centerVersion += 1;
    }
  }

  updateMappingVersion() {
    this.mappingVersion += 1;
    this.updateVersion();
  }

  set needsUpdate(value: boolean) {
    if (value) this.updateVersion();
  }

  raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    if (!wasm.isInitialized() || !this.raycastable || !this.splats) {
      return;
    }

    const { near, far, ray } = raycaster;
    if (
      this.numSplats === 0 ||
      !Number.isFinite(this.minRaycastOpacity) ||
      this.minRaycastOpacity >= 1 ||
      near > far
    ) {
      return;
    }
    const worldToMesh = raycastWorldToMesh.copy(this.matrixWorld).invert();
    const origin = raycastOrigin.copy(ray.origin).applyMatrix4(worldToMesh);
    const direction = raycastDirection
      .copy(ray.direction)
      .applyMatrix3(raycastDirectionMatrix.setFromMatrix4(worldToMesh));
    const buffer = get_raycast_buffer();
    const buffer2 = get_raycast_buffer2();
    const capacity = buffer.length / 4;

    for (let base = 0; base < this.numSplats; base += capacity) {
      const count = Math.min(capacity, this.numSplats - base);
      this.splats.copySplatRecords(buffer, buffer2, base, count);
      const distances = raycast_splat_buffers(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        this.minRaycastOpacity,
        near,
        far,
        count,
      );

      for (let index = 0; index < distances.length; index += 1) {
        const distance = distances[index];
        intersects.push({
          distance,
          point: ray.at(distance, new THREE.Vector3()),
          object: this,
        });
      }
    }
  }
}
