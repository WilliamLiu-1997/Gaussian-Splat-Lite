import * as THREE from "three";

import { rebaseAffineTransform } from "./cameraRelative";

export enum SplatEditSdfType {
  ALL = "all",
  PLANE = "plane",
  SPHERE = "sphere",
  BOX = "box",
  ELLIPSOID = "ellipsoid",
  CYLINDER = "cylinder",
  CAPSULE = "capsule",
  INFINITE_CONE = "infinite_cone",
}

/** RGBA-only operations supported by the SDF pipeline. */
export enum SplatEditRgbaBlendMode {
  MULTIPLY = "multiply",
  SET_RGB = "set_rgb",
  ADD_RGBA = "add_rgba",
}

export type SplatEditSdfOptions = {
  type?: SplatEditSdfType;
  invert?: boolean;
  opacity?: number;
  color?: THREE.Color;
  radius?: number;
};

/** A signed-distance shape carrying only color and opacity. */
export class SplatEditSdf extends THREE.Object3D {
  type: SplatEditSdfType;
  invert: boolean;
  opacity: number;
  color: THREE.Color;
  radius: number;

  constructor(options: SplatEditSdfOptions = {}) {
    super();
    this.type = options.type ?? SplatEditSdfType.SPHERE;
    this.invert = options.invert ?? false;
    this.opacity = options.opacity ?? 1;
    this.color = options.color ?? new THREE.Color(1, 1, 1);
    this.radius = options.radius ?? 0;
  }
}

export type SplatEditOptions = {
  name?: string;
  rgbaBlendMode?: SplatEditRgbaBlendMode;
  sdfSmooth?: number;
  softEdge?: number;
  invert?: boolean;
  sdfs?: SplatEditSdf[];
};

/** An ordered RGBA operation evaluated over one or more SDF shapes. */
export class SplatEdit extends THREE.Object3D {
  ordering: number;
  rgbaBlendMode: SplatEditRgbaBlendMode;
  sdfSmooth: number;
  softEdge: number;
  invert: boolean;
  sdfs: SplatEditSdf[] | null;

  static nextOrdering = 1;

  constructor(options: SplatEditOptions = {}) {
    super();
    this.rgbaBlendMode =
      options.rgbaBlendMode ?? SplatEditRgbaBlendMode.MULTIPLY;
    this.sdfSmooth = options.sdfSmooth ?? 0;
    this.softEdge = options.softEdge ?? 0;
    this.invert = options.invert ?? false;
    this.sdfs = options.sdfs ?? null;
    this.ordering = SplatEdit.nextOrdering++;
    this.name = options.name ?? `Edit ${this.ordering}`;
  }

  addSdf(sdf: SplatEditSdf) {
    this.sdfs ??= [];
    if (!this.sdfs.includes(sdf)) {
      this.sdfs.push(sdf);
    }
  }

  removeSdf(sdf: SplatEditSdf) {
    if (this.sdfs) {
      this.sdfs = this.sdfs.filter((candidate) => candidate !== sdf);
    }
  }
}

export type SplatEditGroup = { edit: SplatEdit; sdfs: SplatEditSdf[] };

const SDF_TEXELS = 5;
const MIN_CAPACITY = 16;
const scratchFloat = new Float32Array(1);
const scratchUint = new Uint32Array(scratchFloat.buffer);

/** Encodes SDF geometry/RGBA and edit operations as regular integer textures. */
export class SplatEdits {
  maxSdfs: number;
  numSdfs = 0;
  sdfData: Uint32Array;
  sdfFloatData: Float32Array;
  sdfTexture: THREE.DataTexture;

  maxEdits: number;
  numEdits = 0;
  editData: Uint32Array;
  editFloatData: Float32Array;
  editTexture: THREE.DataTexture;

  constructor({ maxSdfs = 0, maxEdits = 0 } = {}) {
    this.maxSdfs = Math.max(MIN_CAPACITY, maxSdfs);
    this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
    this.sdfFloatData = new Float32Array(this.sdfData.buffer);
    this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);

    this.maxEdits = Math.max(MIN_CAPACITY, maxEdits);
    this.editData = new Uint32Array(this.maxEdits * 4);
    this.editFloatData = new Float32Array(this.editData.buffer);
    this.editTexture = makeUintTexture(this.editData, 1, this.maxEdits);
  }

  dispose() {
    this.sdfTexture.dispose();
    this.editTexture.dispose();
  }

  update(
    groups: SplatEditGroup[],
    coordinateOrigin?: THREE.Vector3,
  ): { updated: boolean } {
    const sdfCount = groups.reduce(
      (total, group) => total + group.sdfs.length,
      0,
    );
    let updated = this.ensureCapacity(sdfCount, groups.length);

    if (this.numSdfs !== sdfCount || this.numEdits !== groups.length) {
      this.numSdfs = sdfCount;
      this.numEdits = groups.length;
      updated = true;
    }

    const center = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const inverseScale = new THREE.Vector3();
    const sizes = new THREE.Vector4();
    const worldToSdf = new THREE.Matrix4();
    let sdfIndex = 0;
    let sdfUpdated = false;
    let editUpdated = false;

    groups.forEach(({ edit, sdfs }, editIndex) => {
      editUpdated =
        this.encodeEdit(editIndex, edit, sdfIndex, sdfs.length) || editUpdated;

      for (const sdf of sdfs) {
        sizes.set(sdf.scale.x, sdf.scale.y, sdf.scale.z, sdf.radius);
        const originalScale = sdf.scale.clone();
        try {
          sdf.scale.setScalar(1);
          sdf.updateWorldMatrix(true, false);
          worldToSdf.copy(sdf.matrixWorld).invert();
          // Only the internal numeric frame changes. SDF Object3D transforms,
          // sizes, smoothing distances, and edit semantics remain world-space.
          if (coordinateOrigin) {
            rebaseAffineTransform(worldToSdf, coordinateOrigin);
          }
          worldToSdf.decompose(center, quaternion, inverseScale);
        } finally {
          sdf.scale.copy(originalScale);
          sdf.updateWorldMatrix(true, false);
        }

        sdfUpdated =
          this.encodeSdf(
            sdfIndex,
            sdf,
            center,
            quaternion,
            inverseScale,
            sizes,
          ) || sdfUpdated;
        sdfIndex += 1;
      }
    });

    if (sdfUpdated) {
      this.sdfTexture.needsUpdate = true;
    }
    if (editUpdated) {
      this.editTexture.needsUpdate = true;
    }
    return { updated: updated || sdfUpdated || editUpdated };
  }

  private ensureCapacity(sdfs: number, edits: number) {
    let updated = false;
    if (sdfs > this.maxSdfs) {
      this.maxSdfs = Math.max(sdfs, this.maxSdfs * 2);
      this.sdfTexture.dispose();
      this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
      this.sdfFloatData = new Float32Array(this.sdfData.buffer);
      this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);
      updated = true;
    }
    if (edits > this.maxEdits) {
      this.maxEdits = Math.max(edits, this.maxEdits * 2);
      this.editTexture.dispose();
      this.editData = new Uint32Array(this.maxEdits * 4);
      this.editFloatData = new Float32Array(this.editData.buffer);
      this.editTexture = makeUintTexture(this.editData, 1, this.maxEdits);
      updated = true;
    }
    return updated;
  }

  private encodeEdit(
    index: number,
    edit: SplatEdit,
    sdfFirst: number,
    sdfCount: number,
  ) {
    if (sdfFirst > 0xffff || sdfCount > 0xffff) {
      throw new Error("An SDF edit supports at most 65535 shapes");
    }
    const base = index * 4;
    const blend = rgbaBlendModeToNumber(edit.rgbaBlendMode);
    const flags = blend | (edit.invert ? 1 << 8 : 0);
    let updated = this.setEditUint(base, flags);
    updated =
      this.setEditUint(base + 1, sdfFirst | (sdfCount << 16)) || updated;
    updated = this.setEditFloat(base + 2, edit.softEdge) || updated;
    updated = this.setEditFloat(base + 3, edit.sdfSmooth) || updated;
    return updated;
  }

  private encodeSdf(
    index: number,
    sdf: SplatEditSdf,
    center: THREE.Vector3,
    quaternion: THREE.Quaternion,
    scale: THREE.Vector3,
    sizes: THREE.Vector4,
  ) {
    const base = index * SDF_TEXELS * 4;
    const flags = sdfTypeToNumber(sdf.type) | (sdf.invert ? 1 << 8 : 0);
    let updated = this.setSdfFloat(base, center.x);
    updated = this.setSdfFloat(base + 1, center.y) || updated;
    updated = this.setSdfFloat(base + 2, center.z) || updated;
    updated = this.setSdfUint(base + 3, flags) || updated;

    updated = this.setSdfFloat(base + 4, quaternion.x) || updated;
    updated = this.setSdfFloat(base + 5, quaternion.y) || updated;
    updated = this.setSdfFloat(base + 6, quaternion.z) || updated;
    updated = this.setSdfFloat(base + 7, quaternion.w) || updated;

    updated = this.setSdfFloat(base + 8, scale.x) || updated;
    updated = this.setSdfFloat(base + 9, scale.y) || updated;
    updated = this.setSdfFloat(base + 10, scale.z) || updated;
    updated = this.setSdfUint(base + 11, 0) || updated;

    updated = this.setSdfFloat(base + 12, sizes.x) || updated;
    updated = this.setSdfFloat(base + 13, sizes.y) || updated;
    updated = this.setSdfFloat(base + 14, sizes.z) || updated;
    updated = this.setSdfFloat(base + 15, sizes.w) || updated;

    updated = this.setSdfFloat(base + 16, sdf.color.r) || updated;
    updated = this.setSdfFloat(base + 17, sdf.color.g) || updated;
    updated = this.setSdfFloat(base + 18, sdf.color.b) || updated;
    updated = this.setSdfFloat(base + 19, sdf.opacity) || updated;
    return updated;
  }

  private setSdfUint(offset: number, value: number) {
    const updated = this.sdfData[offset] !== value;
    this.sdfData[offset] = value;
    return updated;
  }

  private setSdfFloat(offset: number, value: number) {
    scratchFloat[0] = value;
    return this.setSdfUint(offset, scratchUint[0]);
  }

  private setEditUint(offset: number, value: number) {
    const updated = this.editData[offset] !== value;
    this.editData[offset] = value;
    return updated;
  }

  private setEditFloat(offset: number, value: number) {
    scratchFloat[0] = value;
    return this.setEditUint(offset, scratchUint[0]);
  }

  static emptyTexture = makeUintTexture(new Uint32Array(4), 1, 1);
}

function rgbaBlendModeToNumber(mode: SplatEditRgbaBlendMode) {
  switch (mode) {
    case SplatEditRgbaBlendMode.MULTIPLY:
      return 0;
    case SplatEditRgbaBlendMode.SET_RGB:
      return 1;
    case SplatEditRgbaBlendMode.ADD_RGBA:
      return 2;
  }
}

function sdfTypeToNumber(type: SplatEditSdfType) {
  switch (type) {
    case SplatEditSdfType.ALL:
      return 0;
    case SplatEditSdfType.PLANE:
      return 1;
    case SplatEditSdfType.SPHERE:
      return 2;
    case SplatEditSdfType.BOX:
      return 3;
    case SplatEditSdfType.ELLIPSOID:
      return 4;
    case SplatEditSdfType.CYLINDER:
      return 5;
    case SplatEditSdfType.CAPSULE:
      return 6;
    case SplatEditSdfType.INFINITE_CONE:
      return 7;
  }
}

function makeUintTexture(data: Uint32Array, width: number, height: number) {
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedIntType,
  );
  texture.internalFormat = "RGBA32UI";
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
