import {
  get_raycast_buffer,
  get_raycast_buffer2,
  get_raycast_indices,
  raycast_splat_buffers,
} from "gaussian-splat-rs";
import * as THREE from "three";
import { Splats } from "../data/Splats.js";
import { SplatRaycastQuery } from "../data/raycast.js";
import * as wasm from "../runtime/wasm.js";
import { SplatEdit, SplatEditSdf, SplatEdits } from "./SplatEdit.js";
let raycastVisibleIndices = new Uint32Array(0);
const raycastWorldToMesh = new THREE.Matrix4();
const raycastDirectionMatrix = new THREE.Matrix3();
const raycastOrigin = new THREE.Vector3();
const raycastDirection = new THREE.Vector3();
const NO_EDIT_GROUPS = Object.freeze([]);
function validateSplatMeshInitializationInputs(options) {
  const inputs = [];
  if (options.url !== undefined) inputs.push("url");
  if (options.file !== undefined) inputs.push("file");
  if (options.fileBytes !== undefined) inputs.push("fileBytes");
  if (options.splats !== undefined) inputs.push("splats");
  if (inputs.length > 1) {
    throw new Error(
      `SplatMesh initialization inputs are mutually exclusive; provide only one of url, file, fileBytes, or splats (received: ${inputs.join(", ")})`,
    );
  }
}
/** A scene object backed by a fixed encoded splat source and RGBA SDF edits. */
export class SplatMesh extends THREE.Object3D {
  get isInitialized() {
    return this.splats?.isInitialized ?? false;
  }
  get initialized() {
    const source = this.splats;
    if (!source) return Promise.resolve(this);
    // Read every frame: the callbacks live in their own method, so this
    // getter allocates nothing while the source is unchanged.
    if (source.initialized !== this.lastInitialization)
      this.followInitialization(source);
    return this.readiness;
  }
  followInitialization(source) {
    const pending = source.initialized;
    this.lastInitialization = pending;
    this.readiness = pending.then(
      async () => {
        if (pending !== this.splats?.initialized) return this.initialized;
        this.numSplats = source.getNumSplats();
        this.updateMappingVersion();
        await this.onLoad?.(this);
        return this;
      },
      (error) => {
        if (pending !== this.splats?.initialized) return this.initialized;
        throw error;
      },
    );
    void this.readiness.catch(() => {});
  }
  constructor(options = {}) {
    super();
    this.numSplats = 0;
    this.recolor = new THREE.Color(1, 1, 1);
    this.opacity = 1;
    this.maxSh = 3;
    this.edits = null;
    this.sdfEdits = null;
    this.version = 0;
    this.sortVersion = 0;
    this.centerVersion = 0;
    this.mappingVersion = 0;
    this.lastNumSplats = -1;
    this.lastMaxSh = -1;
    this.lastMatrixWorld = new THREE.Matrix4();
    this.hasLastMatrixWorld = false;
    this.lastRecolor = new THREE.Vector4().setScalar(Number.NaN);
    this.sdfCoordinateOrigin = new THREE.Vector3();
    if (options.splats && !(options.splats instanceof Splats)) {
      throw new TypeError("SplatMesh splats must be a Splats instance");
    }
    validateSplatMeshInitializationInputs(options);
    this.splats =
      options.splats ??
      new Splats({
        url: options.url,
        file: options.file,
        fileBytes: options.fileBytes,
        fileType: options.fileType,
        fileName: options.fileName,
        resolveFile: options.resolveFile,
        postDecode: options.postDecode,
        onProgress: options.onProgress,
      });
    this.numSplats = this.splats.getNumSplats();
    this.editable = options.editable ?? true;
    this.raycastable = options.raycastable ?? true;
    this.minRaycastOpacity = options.minRaycastOpacity ?? 0.15;
    this.onFrame = options.onFrame;
    this.onLoad = options.onLoad;
    void this.initialized;
  }
  forEachSplat(callback) {
    this.splats?.forEachSplat(callback);
  }
  dispose() {
    super.dispose();
    this.sdfEdits?.dispose();
    this.sdfEdits = null;
    this.splats?.dispose();
    this.splats = undefined;
    this.numSplats = 0;
    this.updateMappingVersion();
  }
  /** Copy cached local bounds; false includes scale/rotation and shape at source alpha 0.01. */
  getBoundingBox(centersOnly = true, target = new THREE.Box3()) {
    if (!this.isInitialized) {
      throw new Error(
        "Cannot get bounding box before SplatMesh is initialized",
      );
    }
    return (
      this.splats?.getBoundingBox(centersOnly, target) ?? target.makeEmpty()
    );
  }
  frameUpdate(
    { time, deltaTime, globalEdits, shrinkResources = false },
    callbacks = true,
  ) {
    if (callbacks) this.onFrame?.({ mesh: this, time, deltaTime });
    const source = this.splats;
    if (!source) {
      return;
    }
    // Follow source reinitialization even when callers only keep rendering.
    void this.initialized;
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
    const { r, g, b } = this.recolor;
    const opacity = THREE.MathUtils.clamp(this.opacity, 0, 1);
    const last = this.lastRecolor;
    if (r !== last.x || g !== last.y || b !== last.z || opacity !== last.w) {
      last.set(r, g, b, opacity);
      updated = true;
    }
    const groups = this.collectEditGroups(globalEdits);
    if (shrinkResources && groups.length === 0 && this.sdfEdits) {
      this.sdfEdits.dispose();
      this.sdfEdits = null;
      updated = true;
    } else if (groups.length > 0 && !this.sdfEdits) {
      this.sdfEdits = new SplatEdits({
        maxEdits: groups.length,
        maxSdfs: groups.reduce((total, group) => total + group.sdfs.length, 0),
      });
      updated = true;
    }
    const sdfCoordinateOrigin = this.sdfCoordinateOrigin.setFromMatrixPosition(
      this.matrixWorld,
    );
    if (
      this.sdfEdits?.update(groups, sdfCoordinateOrigin, shrinkResources)
        .updated
    ) {
      // RGBA-only SDF changes preserve centers and their existing sort order.
      updated = true;
    }
    if (updated) {
      this.version += 1;
      if (centersUpdated || transformUpdated) this.sortVersion += 1;
      if (centersUpdated) this.centerVersion += 1;
    }
  }
  /** Edits applying to this mesh, in order, each with its SDF shapes. */
  collectEditGroups(globalEdits) {
    if (!this.editable) return NO_EDIT_GROUPS;
    const local = this.edits;
    // Most meshes have no edits; a mesh without children has none of its own.
    if (
      globalEdits.length === 0 &&
      (local ? local.length === 0 : this.children.length === 0)
    )
      return NO_EDIT_GROUPS;
    const edits = new Set(globalEdits);
    if (local) {
      for (const edit of local) edits.add(edit);
    } else {
      this.traverseVisible((node) => {
        if (node instanceof SplatEdit) edits.add(node);
      });
    }
    const orderedEdits = Array.from(edits).sort(
      (left, right) => left.ordering - right.ordering,
    );
    return orderedEdits.map((edit) => {
      if (edit.sdfs) return { edit, sdfs: edit.sdfs };
      const sdfs = [];
      edit.traverseVisible((node) => {
        if (node instanceof SplatEditSdf) sdfs.push(node);
      });
      return { edit, sdfs };
    });
  }
  updateVersion({ sort = true } = {}) {
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
  set needsUpdate(value) {
    if (value) this.updateVersion();
  }
  raycast(raycaster, intersects) {
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
    const splats = this.splats;
    if (raycastVisibleIndices.length !== capacity)
      raycastVisibleIndices = new Uint32Array(capacity);
    let count = 0;
    const flush = () => {
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
      const hitIndices = get_raycast_indices();
      for (let index = 0; index < distances.length; index += 1) {
        const distance = distances[index];
        const splatIndex = raycastVisibleIndices[hitIndices[index]];
        const hit = {
          distance,
          point: ray.at(distance, new THREE.Vector3()),
          object: this,
          index: splatIndex,
          sourceIndex: splats.getSourceIndex(splatIndex),
        };
        intersects.push(hit);
      }
      count = 0;
    };
    const query = new SplatRaycastQuery(origin, direction, near, far);
    splats.forEachRaycastRange(query, (start, length) => {
      for (let base = start; base < start + length; ) {
        const copied = Math.min(capacity - count, start + length - base);
        splats.copySplatRecords(
          buffer.subarray(count * 4),
          buffer2.subarray(count * 4),
          base,
          copied,
        );
        for (let i = 0; i < copied; i++)
          raycastVisibleIndices[count + i] = base + i;
        count += copied;
        base += copied;
        if (count === capacity) flush();
      }
    });
    if (count) flush();
  }
}
