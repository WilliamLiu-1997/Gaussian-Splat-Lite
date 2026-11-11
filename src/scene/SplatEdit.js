import * as THREE from "three";
import { emptyUintTexture } from "../data/textureLayout.js";
import { rebaseAffineTransform } from "../utils/transforms.js";
import {
  BLIND_ACTIVE,
  SplatEditBlindField,
  encodeBlindSelection,
} from "./SplatEditBlindField.js";
export const SplatEditSdfType = {
  ALL: "all",
  PLANE: "plane",
  SPHERE: "sphere",
  BOX: "box",
  ELLIPSOID: "ellipsoid",
  CYLINDER: "cylinder",
  CAPSULE: "capsule",
  INFINITE_CONE: "infinite_cone",
};
/** RGBA-only operations supported by the edit pipeline. */
export const SplatEditRgbaBlendMode = {
  MULTIPLY_RGBA: "multiply_rgba",
  SET_RGBA: "set_rgba",
  ADD_RGBA: "add_rgba",
};
/** @internal Edit group flag shared with the generate shaders. */
export const EDIT_BLIND = 1 << 9;

/** A signed-distance shape carrying optional color and opacity channels. */
export class SplatEditSdf extends THREE.Object3D {
  constructor(options = {}) {
    super();
    this.type = options.type ?? "sphere";
    this.invert = options.invert ?? false;
    this.opacity = options.opacity;
    this.color = options.color ?? {};
    this.radius = options.radius ?? 0;
  }
}
/** An ordered RGBA operation evaluated over spatial SDF shapes. */
export class SplatEdit extends THREE.Object3D {
  static nextOrdering = 1;
  constructor(options = {}) {
    super();
    this.rgbaBlendMode = options.rgbaBlendMode ?? "multiply_rgba";
    this.sdfSmooth = options.sdfSmooth ?? 0;
    this.softEdge = options.softEdge ?? 0;
    this.invert = options.invert ?? false;
    this.sdfs = options.sdfs ?? null;
    this.ordering = SplatEdit.nextOrdering++;
    this.name = options.name ?? `Edit ${this.ordering}`;
  }
  addSdf(sdf) {
    this.sdfs ??= [];
    if (!this.sdfs.includes(sdf)) {
      this.sdfs.push(sdf);
    }
  }
  removeSdf(sdf) {
    if (this.sdfs) {
      this.sdfs = this.sdfs.filter((candidate) => candidate !== sdf);
    }
  }
}
const SDF_TEXELS = 6;
const SDF_RGBA_MASK_SHIFT = 16;
const MIN_CAPACITY = 16;
const scratchFloat = new Float32Array(1);
const scratchUint = new Uint32Array(scratchFloat.buffer);
const scratchSizes = new THREE.Vector4();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
/** Encodes SDF geometry/RGBA and edit operations as regular integer textures. */
export class SplatEdits {
  constructor({ maxSdfs = 0, maxEdits = 0 } = {}) {
    this.hasBlind = false;
    this.numSdfs = 0;
    this.numEdits = 0;
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
  update(groups, coordinateOrigin, shrinkResources = false, blindFields = []) {
    const selectionCount = groups.reduce((total, { edit, selections }) => {
      const spatial = edit instanceof SplatEdit;
      const selectionType = spatial ? SplatEditSdf : SplatEditBlindField;
      if (
        selections.some((selection) => !(selection instanceof selectionType))
      ) {
        throw new Error(
          spatial
            ? "SplatEdit only accepts SplatEditSdf selections"
            : "SplatEditBlind only accepts SplatEditBlindField selections",
        );
      }
      return total + selections.length;
    }, 0);
    this.hasBlind = false;
    let updated = this.ensureCapacity(
      selectionCount,
      groups.length,
      shrinkResources,
    );
    if (this.numSdfs !== selectionCount || this.numEdits !== groups.length) {
      this.numSdfs = selectionCount;
      this.numEdits = groups.length;
      updated = true;
    }
    const sizes = scratchSizes;
    const inverseOwnScale = scratchScale;
    const worldToSdf = scratchMatrix;
    let selectionIndex = 0;
    let sdfUpdated = false;
    let editUpdated = false;
    groups.forEach(({ edit, selections }, editIndex) => {
      const spatial = edit instanceof SplatEdit;
      editUpdated =
        this.encodeEdit(editIndex, edit, selectionIndex, selections.length) ||
        editUpdated;
      for (const selection of selections) {
        if (!spatial) {
          const record = encodeBlindSelection(selection, blindFields);
          this.hasBlind ||= (record[3] & BLIND_ACTIVE) !== 0;
          const base = selectionIndex++ * SDF_TEXELS * 4;
          for (let word = 0; word < record.length; word++)
            sdfUpdated =
              this.setSdfUint(base + word, record[word]) || sdfUpdated;
          continue;
        }
        const sdf = selection;
        sdf.updateWorldMatrix(true, false);
        worldToSdf.copy(sdf.matrixWorld);
        // These shapes already use scale as dimensions. Preserve their
        // independent corner/cap radius instead of scaling it a second time.
        const dimensional =
          sdf.type === "box" ||
          sdf.type === "ellipsoid" ||
          sdf.type === "capsule";
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
        if (sdf.type !== "all") {
          worldToSdf.invert();
          if (coordinateOrigin)
            rebaseAffineTransform(worldToSdf, coordinateOrigin);
        }

        sizes.set(
          dimensional ? Math.abs(sdf.scale.x) : 1,
          dimensional ? Math.abs(sdf.scale.y) : 1,
          dimensional ? Math.abs(sdf.scale.z) : 1,
          sdf.radius,
        );
        switch (sdf.type) {
          case "all":
            // Only distanceScale matters; unused transforms must not dirty ALL.
            worldToSdf.identity();
            sizes.set(0, 0, 0, 0);
            break;
          case "plane":
            // Only the z row contributes to plane distance.
            for (let offset = 0; offset < 16; offset += 4) {
              e[offset] = 0;
              e[offset + 1] = 0;
            }
            sizes.set(0, 0, 0, 0);
            break;
          case "box":
            sizes.x -= sizes.w;
            sizes.y -= sizes.w;
            sizes.z -= sizes.w;
            break;
          case "ellipsoid":
            // Inverse radii and the signed distance at the center.
            sizes.w = -Math.min(sizes.x, sizes.y, sizes.z);
            if (sizes.w < 0)
              sizes.set(1 / sizes.x, 1 / sizes.y, 1 / sizes.z, sizes.w);
            else sizes.set(0, 0, 0, 0);
            // Normalize output coordinates, including the rebased translation.
            for (let offset = 0; offset < 16; offset += 4) {
              e[offset] *= sizes.x;
              e[offset + 1] *= sizes.y;
              e[offset + 2] *= sizes.z;
            }
            break;
          case "capsule":
            sizes.y *= 0.5;
            break;
          case "infinite_cone": {
            const angle = sdf.radius * (Math.PI * 0.25);
            sizes.x = Math.sin(angle);
            sizes.y = Math.cos(angle);
            break;
          }
        }

        sdfUpdated =
          this.encodeSdf(
            selectionIndex,
            sdf,
            worldToSdf,
            distanceScale,
            sizes,
          ) || sdfUpdated;
        selectionIndex += 1;
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
  ensureCapacity(selections, edits, shrinkResources) {
    let updated = false;
    const maxSdfs = getEditCapacity(selections, this.maxSdfs, shrinkResources);
    const maxEdits = getEditCapacity(edits, this.maxEdits, shrinkResources);
    if (maxSdfs !== this.maxSdfs) {
      this.maxSdfs = maxSdfs;
      this.sdfTexture.dispose();
      this.sdfData = new Uint32Array(this.maxSdfs * SDF_TEXELS * 4);
      this.sdfTexture = makeUintTexture(this.sdfData, SDF_TEXELS, this.maxSdfs);
      updated = true;
    }
    if (maxEdits !== this.maxEdits) {
      this.maxEdits = maxEdits;
      this.editTexture.dispose();
      this.editData = new Uint32Array(this.maxEdits * 4);
      this.editTexture = makeUintTexture(this.editData, 1, this.maxEdits);
      updated = true;
    }
    return updated;
  }
  encodeEdit(index, edit, selectionFirst, selectionCount) {
    if (selectionFirst > 0xffff || selectionCount > 0xffff) {
      throw new Error("An edit supports at most 65535 selections");
    }
    const base = index * 4;
    const blend = rgbaBlendModeToNumber(edit.rgbaBlendMode);
    const spatial = edit instanceof SplatEdit;
    const flags =
      blend | (edit.invert ? 1 << 8 : 0) | (spatial ? 0 : EDIT_BLIND);
    // Zero keeps hard edges/unions; nonzero parameters are stored as reciprocals.
    const invSoftEdge = edit.softEdge === 0 ? 0 : 1 / edit.softEdge;
    const invSmoothAmount =
      spatial && selectionCount > 1 && edit.sdfSmooth !== 0
        ? 1 / edit.sdfSmooth
        : 0;

    let updated = this.setEditUint(base, flags);
    updated =
      this.setEditUint(base + 1, selectionFirst | (selectionCount << 16)) ||
      updated;
    updated = this.setEditFloat(base + 2, invSoftEdge) || updated;
    updated = this.setEditFloat(base + 3, invSmoothAmount) || updated;
    return updated;
  }
  encodeSdf(index, sdf, matrix, distanceScale, sizes) {
    const base = index * SDF_TEXELS * 4;
    const color = sdf.color;
    const rgbaMask =
      (color.r === undefined ? 0 : 1) |
      (color.g === undefined ? 0 : 1 << 1) |
      (color.b === undefined ? 0 : 1 << 2) |
      (sdf.opacity === undefined ? 0 : 1 << 3);
    const flags = sdfTypeToNumber(sdf.type) | (rgbaMask << SDF_RGBA_MASK_SHIFT);
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
    // The sign carries shape inversion; zero disables collapsed transforms.
    const signedScale = sdf.invert ? -distanceScale : distanceScale;
    updated = this.setSdfFloat(base + 23, signedScale) || updated;
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
  setSdfUint(offset, value) {
    const updated = this.sdfData[offset] !== value;
    this.sdfData[offset] = value;
    return updated;
  }
  setSdfFloat(offset, value) {
    scratchFloat[0] = value;
    return this.setSdfUint(offset, scratchUint[0]);
  }
  setEditUint(offset, value) {
    const updated = this.editData[offset] !== value;
    this.editData[offset] = value;
    return updated;
  }
  setEditFloat(offset, value) {
    scratchFloat[0] = value;
    return this.setEditUint(offset, scratchUint[0]);
  }
  static emptyTexture = emptyUintTexture;
}
function getEditCapacity(count, capacity, shrinkResources) {
  if (shrinkResources) return Math.max(MIN_CAPACITY, count);
  return count > capacity ? Math.max(count, capacity * 2) : capacity;
}
function rgbaBlendModeToNumber(mode) {
  switch (mode) {
    case "multiply_rgba":
      return 0;
    case "set_rgba":
      return 1;
    case "add_rgba":
      return 2;
  }
}
function sdfTypeToNumber(type) {
  switch (type) {
    case "all":
      return 0;
    case "plane":
      return 1;
    case "sphere":
      return 2;
    case "box":
      return 3;
    case "ellipsoid":
      return 4;
    case "cylinder":
      return 5;
    case "capsule":
      return 6;
    case "infinite_cone":
      return 7;
  }
}
function makeUintTexture(data, width, height) {
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
