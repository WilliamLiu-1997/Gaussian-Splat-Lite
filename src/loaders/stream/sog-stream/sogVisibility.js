import * as THREE from "three";
import { streamViews } from "../StreamCameras.js";
import { readSogLodLeaf, selectSogLods } from "./sogLod.js";
/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose.
 */
export function captureSogView(cameras, group) {
  group.updateWorldMatrix(true, false);
  const views = [];
  for (const camera of streamViews(cameras)) {
    const projection = camera.projectionMatrix.elements;
    views.push({
      // Invert matrixWorld like the splat projection: Camera.matrixWorldInverse
      // can omit rig scale.
      modelView: new THREE.Matrix4()
        .copy(camera.matrixWorld)
        .invert()
        .multiply(group.matrixWorld).elements,
      fovScale:
        projection[11] === 0
          ? 1
          : 1 /
            (Math.max(Math.abs(projection[0]), Math.abs(projection[5])) *
              Math.tan(Math.PI / 8)),
    });
  }
  let shown = cameras.length > 0;
  for (let node = group; node; node = node.parent) shown &&= node.visible;
  return { cameras: views, shown };
}
/** Stable key of a view, for skipping unchanged selection requests. */
export function getSogViewKey(view) {
  return view.cameras
    .map((camera) => `${camera.modelView.join(",")}/${camera.fovScale}`)
    .join(";");
}
/** Worker traversal state keeps leaf identities stable between selections. */
export class SogVisibility {
  constructor(manifest) {
    this.manifest = manifest;
    this.leaves = [];
    this.cameras = [];
    this.bound = new THREE.Box3();
    this.typicalHalfSize = new THREE.Vector3();
    this.shrink = new THREE.Vector3();
    this.closest = new THREE.Vector3();
    this.inverseModelView = new THREE.Matrix4();
    const { leafBounds } = manifest;
    const halfSizes = new Float64Array(leafBounds.length / 6);
    for (let axis = 0; axis < 3; axis++) {
      for (let id = 0; id < halfSizes.length; id++) {
        const offset = id * 6;
        halfSizes[id] =
          (leafBounds[offset + axis + 3] - leafBounds[offset + axis]) * 0.5;
      }
      halfSizes.sort();
      this.typicalHalfSize.setComponent(
        axis,
        halfSizes[halfSizes.length >>> 1],
      );
    }
  }
  prepareCameras(view) {
    const cameras = this.cameras;
    cameras.length = Math.min(cameras.length, view.cameras.length);
    view.cameras.forEach((camera, index) => {
      let state = cameras[index];
      if (!state) {
        state = {
          modelView: new THREE.Matrix4(),
          cameraPosition: new THREE.Vector3(),
          fovScale: 1,
        };
        cameras[index] = state;
      }
      state.modelView.fromArray(camera.modelView);
      this.inverseModelView.copy(state.modelView).invert();
      state.cameraPosition.setFromMatrixPosition(this.inverseModelView);
      state.fovScale = camera.fovScale;
    });
    return cameras;
  }
  collect({ view, lodBehindPenalty, lodDistanceShrink }) {
    const cameras = this.prepareCameras(view);
    const regions = [];
    const { shown } = view;
    const { leafBounds } = this.manifest;
    for (let id = 0; shown && id < leafBounds.length / 6; id++) {
      const offset = id * 6;
      this.bound.min.fromArray(leafBounds, offset);
      this.bound.max.fromArray(leafBounds, offset + 3);
      // Only the distance box shrinks; source and rendering bounds stay intact.
      this.bound
        .getSize(this.shrink)
        .multiplyScalar(0.5)
        .sub(this.typicalHalfSize)
        .clampScalar(0, Number.POSITIVE_INFINITY)
        .multiplyScalar(lodDistanceShrink);
      this.bound.min.add(this.shrink);
      this.bound.max.sub(this.shrink);
      // Keep surrounding regions in the budget. Any camera can request finer
      // detail; only the part of the direction behind that camera is penalized.
      let distance = Number.POSITIVE_INFINITY;
      for (const { modelView, cameraPosition, fovScale } of cameras) {
        this.bound
          .clampPoint(cameraPosition, this.closest)
          .applyMatrix4(modelView);
        // View-space +Z is behind the camera. This equals a smooth angular
        // distance multiplier, without dividing by zero inside the box.
        const penalizedDistance =
          this.closest.length() +
          Math.max(0, this.closest.z) * (lodBehindPenalty - 1);
        distance = Math.min(
          distance,
          Math.max(penalizedDistance * fovScale, 1e-6),
        );
      }
      this.leaves[id] ??= readSogLodLeaf(this.manifest, id);
      regions.push({ leaf: this.leaves[id], distance });
    }
    return regions;
  }
  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(request) {
    const regions = this.collect(request);
    const targets = selectSogLods(regions, this.manifest.lodLevels, request);
    regions.sort((a, b) => a.distance - b.distance || a.leaf.id - b.leaf.id);
    const result = new Uint32Array(targets.size * 2);
    let offset = 0;
    for (const { leaf } of regions) {
      const target = targets.get(leaf.id);
      if (!target) continue;
      result[offset++] = leaf.id;
      result[offset++] = leaf.lods.indexOf(target);
    }
    return result;
  }
}
