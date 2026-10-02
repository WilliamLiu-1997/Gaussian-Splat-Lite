import * as THREE from "three";

import { emptyUintTexture } from "../data/textureLayout";
import { rebaseAffineTransform } from "../utils/transforms";

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
  MULTIPLY_RGBA = "multiply_rgba",
  SET_RGBA = "set_rgba",
  ADD_RGBA = "add_rgba",
}

export type SplatEditSdfColor = {
  r?: number;
  g?: number;
  b?: number;
};

export type SplatEditSdfOptions = {
  type?: SplatEditSdfType;
  invert?: boolean;
  opacity?: number;
  color?: SplatEditSdfColor;
  radius?: number;
};

/** A signed-distance shape carrying optional color and opacity channels. */
export class SplatEditSdf extends THREE.Object3D {
  type: SplatEditSdfType;
  invert: boolean;
  opacity?: number;
  color: SplatEditSdfColor;
  radius: number;

  constructor(options: SplatEditSdfOptions = {}) {
    super();
    this.type = options.type ?? SplatEditSdfType.SPHERE;
    this.invert = options.invert ?? false;
    this.opacity = options.opacity;
    this.color = options.color ?? {};
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
      options.rgbaBlendMode ?? SplatEditRgbaBlendMode.MULTIPLY_RGBA;
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

const SDF_TEXELS = 6;
const SDF_RGBA_MASK_SHIFT = 16;
const MIN_CAPACITY = 16;
const scratchFloat = new Float32Array(1);
const scratchUint = new Uint32Array(scratchFloat.buffer);

/** Encodes SDF geometry/RGBA and edit operations as regular integer textures. */
export class SplatEdits {
  maxSdfs: number;
  numSdfs = 0;
  sdfData: Uint32Array;
  sdfTexture: THREE.DataTexture;

  maxEdits: number;
  numEdits = 0;
  editData: Uint32Array;
  editTexture: THREE.DataTexture;

  constructor({ maxSdfs = 0, maxEdits = 0 } = {}) {
    this.maxSdfs = Math.max(MIN_CAPACITY, maxSdfs);
    this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
    this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);

    this.maxEdits = Math.max(MIN_CAPACITY, maxEdits);
    this.editData = new Uint32Array(this.maxEdits * 4);
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

    const sizes = new THREE.Vector4();
    const inverseOwnScale = new THREE.Vector3();
    const worldToSdf = new THREE.Matrix4();
    let sdfIndex = 0;
    let sdfUpdated = false;
    let editUpdated = false;

    groups.forEach(({ edit, sdfs }, editIndex) => {
      editUpdated =
        this.encodeEdit(editIndex, edit, sdfIndex, sdfs.length) || editUpdated;

      for (const sdf of sdfs) {
        sdf.updateWorldMatrix(true, false);
        worldToSdf.copy(sdf.matrixWorld);
        // These shapes already use scale as dimensions. Preserve their
        // independent corner/cap radius instead of scaling it a second time.
        const dimensional =
          sdf.type === SplatEditSdfType.BOX ||
          sdf.type === SplatEditSdfType.ELLIPSOID ||
          sdf.type === SplatEditSdfType.CAPSULE;
        sizes.set(
          dimensional ? Math.abs(sdf.scale.x) : 1,
          dimensional ? Math.abs(sdf.scale.y) : 1,
          dimensional ? Math.abs(sdf.scale.z) : 1,
          sdf.radius,
        );
        const collapsed = worldToSdf.determinant() === 0;
        if (dimensional && !collapsed)
          worldToSdf.scale(
            inverseOwnScale.set(
              1 / sdf.scale.x,
              1 / sdf.scale.y,
              1 / sdf.scale.z,
            ),
          );
        const e = worldToSdf.elements;
        const distanceScale = collapsed
          ? 0
          : Math.min(
              Math.hypot(e[0], e[1], e[2]),
              Math.hypot(e[4], e[5], e[6]),
              Math.hypot(e[8], e[9], e[10]),
            );
        worldToSdf.invert();
        if (coordinateOrigin)
          rebaseAffineTransform(worldToSdf, coordinateOrigin);
        sdfUpdated =
          this.encodeSdf(sdfIndex, sdf, worldToSdf, distanceScale, sizes) ||
          sdfUpdated;
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
      this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);
      updated = true;
    }
    if (edits > this.maxEdits) {
      this.maxEdits = Math.max(edits, this.maxEdits * 2);
      this.editTexture.dispose();
      this.editData = new Uint32Array(this.maxEdits * 4);
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
    matrix: THREE.Matrix4,
    distanceScale: number,
    sizes: THREE.Vector4,
  ) {
    const base = index * SDF_TEXELS * 4;
    const color = sdf.color;
    const rgbaMask =
      (color.r === undefined ? 0 : 1) |
      (color.g === undefined ? 0 : 1 << 1) |
      (color.b === undefined ? 0 : 1 << 2) |
      (sdf.opacity === undefined ? 0 : 1 << 3);
    const flags =
      sdfTypeToNumber(sdf.type) |
      (sdf.invert ? 1 << 8 : 0) |
      (rgbaMask << SDF_RGBA_MASK_SHIFT);
    const e = matrix.elements;
    let updated = this.setSdfFloat(base, e[12]);
    updated = this.setSdfFloat(base + 1, e[13]) || updated;
    updated = this.setSdfFloat(base + 2, e[14]) || updated;
    updated = this.setSdfUint(base + 3, flags) || updated;
    for (let axis = 0; axis < 3; axis++) {
      updated = this.setSdfFloat(base + 4 + axis, e[axis]) || updated;
      updated = this.setSdfFloat(base + 8 + axis, e[4 + axis]) || updated;
      updated = this.setSdfFloat(base + 20 + axis, e[8 + axis]) || updated;
    }
    updated = this.setSdfFloat(base + 23, distanceScale) || updated;

    updated = this.setSdfFloat(base + 12, sizes.x) || updated;
    updated = this.setSdfFloat(base + 13, sizes.y) || updated;
    updated = this.setSdfFloat(base + 14, sizes.z) || updated;
    updated = this.setSdfFloat(base + 15, sizes.w) || updated;

    updated = this.setSdfFloat(base + 16, color.r ?? 0) || updated;
    updated = this.setSdfFloat(base + 17, color.g ?? 0) || updated;
    updated = this.setSdfFloat(base + 18, color.b ?? 0) || updated;
    updated = this.setSdfFloat(base + 19, sdf.opacity ?? 0) || updated;
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

  static emptyTexture = emptyUintTexture;
}

function rgbaBlendModeToNumber(mode: SplatEditRgbaBlendMode) {
  switch (mode) {
    case SplatEditRgbaBlendMode.MULTIPLY_RGBA:
      return 0;
    case SplatEditRgbaBlendMode.SET_RGBA:
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
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
