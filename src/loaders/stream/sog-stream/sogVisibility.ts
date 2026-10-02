import * as THREE from "three";
import { streamViews } from "../StreamCameras";
import {
  type SogLodIndex,
  type SogLodLeaf,
  type SogVisibleLeaf,
  readSogLodLeaf,
  selectSogLods,
} from "./sogLod";

export type SogCamera = {
  modelView: number[];
  projection: number[];
  coordinateSystem: THREE.CoordinateSystem;
  reversedDepth: boolean;
};

export type SogView = {
  /** The registered cameras that see the group; selection serves all of them. */
  cameras: SogCamera[];
  shown: boolean;
};

type CameraState = {
  modelView: THREE.Matrix4;
  frustum: THREE.Frustum;
  cameraPosition: THREE.Vector3;
  fovScale: number;
};

/**
 * Capture the cameras that see the group without traversing the manifest or
 * reducing matrix precision. WebXR selects detail from each eye's current pose and frustum.
 */
export function captureSogView(
  cameras: readonly THREE.Camera[],
  group: THREE.Object3D,
): SogView {
  group.updateWorldMatrix(true, false);
  const views: SogCamera[] = [];
  for (const camera of streamViews(cameras)) {
    views.push({
      // Invert matrixWorld like the splat projection: Camera.matrixWorldInverse
      // can omit rig scale.
      modelView: new THREE.Matrix4()
        .copy(camera.matrixWorld)
        .invert()
        .multiply(group.matrixWorld).elements,
      projection: camera.projectionMatrix.toArray(),
      coordinateSystem: camera.coordinateSystem,
      reversedDepth: camera.reversedDepth,
    });
  }
  let shown = cameras.length > 0;
  for (let node: THREE.Object3D | null = group; node; node = node.parent)
    shown &&= node.visible;
  return { cameras: views, shown };
}

/** Stable key of a view, for skipping unchanged selection requests. */
export function getSogViewKey(view: SogView) {
  return view.cameras
    .map(
      (camera) =>
        `${camera.modelView.join(",")}/${camera.projection.join(",")}/${camera.coordinateSystem}/${camera.reversedDepth}`,
    )
    .join(";");
}

/** Worker traversal state keeps leaf identities stable between selections. */
export class SogVisibility {
  private readonly leaves = new Map<number, SogLodLeaf>();
  private readonly cameras: CameraState[] = [];
  private readonly clip = new THREE.Matrix4();
  private readonly bound = new THREE.Box3();
  private readonly closest = new THREE.Vector3();
  private readonly inverseModelView = new THREE.Matrix4();

  constructor(
    private readonly manifest: Pick<
      SogLodIndex,
      "nodes" | "leafOffsets" | "lods" | "upgradeRatios"
    >,
  ) {}

  private prepareCameras(view: SogView) {
    const cameras = this.cameras;
    cameras.length = Math.min(cameras.length, view.cameras.length);
    view.cameras.forEach((camera, index) => {
      let state = cameras[index];
      if (!state) {
        state = {
          modelView: new THREE.Matrix4(),
          frustum: new THREE.Frustum(),
          cameraPosition: new THREE.Vector3(),
          fovScale: 1,
        };
        cameras[index] = state;
      }
      state.modelView.fromArray(camera.modelView);
      this.clip.fromArray(camera.projection).multiply(state.modelView);
      this.inverseModelView.copy(state.modelView).invert();
      state.cameraPosition.setFromMatrixPosition(this.inverseModelView);
      state.frustum.setFromProjectionMatrix(
        this.clip,
        camera.coordinateSystem,
        camera.reversedDepth,
      );
      const projection = camera.projection;
      state.fovScale =
        projection[11] === 0
          ? 1
          : 1 /
            (Math.max(Math.abs(projection[0]), Math.abs(projection[5])) *
              Math.tan(Math.PI / 8));
    });
    return cameras;
  }

  private collect(view: SogView) {
    const cameras = this.prepareCameras(view);
    const visible: SogVisibleLeaf[] = [];
    const { shown } = view;
    const nodes = this.manifest.nodes;
    for (let index = 0; shown && index < nodes.length / 8; ) {
      const offset = index * 8;
      this.bound.min.fromArray(nodes, offset);
      this.bound.max.fromArray(nodes, offset + 3);
      const id = nodes[offset + 7];
      if (id < 0) {
        // A branch only needs one view that sees it.
        if (cameras.some(({ frustum }) => frustum.intersectsBox(this.bound)))
          index++;
        else index = nodes[offset + 6];
        continue;
      }
      // A leaf tests each view once for visibility and detail together: the
      // nearest view that sees it decides its detail.
      let seen = false;
      let weight = 1e-12;
      for (const { modelView, frustum, cameraPosition, fovScale } of cameras) {
        if (!frustum.intersectsBox(this.bound)) continue;
        seen = true;
        this.bound
          .clampPoint(cameraPosition, this.closest)
          .applyMatrix4(modelView);
        // World-space distance to the box, without weighting by its radius.
        const distance = Math.max(this.closest.length() * fovScale, 1e-6);
        weight = Math.max(weight, 1 / distance ** 1.5);
      }
      if (!seen) {
        index = nodes[offset + 6];
        continue;
      }
      index++;
      let leaf = this.leaves.get(id);
      if (!leaf) {
        leaf = readSogLodLeaf(this.manifest, id);
        this.leaves.set(id, leaf);
      }
      visible.push({ leaf, weight });
    }
    return visible;
  }

  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(view: SogView, budget: number): Uint32Array {
    const visible = this.collect(view);
    const targets = selectSogLods(visible, budget, this.manifest);
    visible.sort((a, b) => b.weight - a.weight || a.leaf.id - b.leaf.id);
    const result = new Uint32Array(targets.size * 2);
    let offset = 0;
    for (const { leaf } of visible) {
      const target = targets.get(leaf.id);
      if (!target) continue;
      result[offset++] = leaf.id;
      result[offset++] = leaf.lods.indexOf(target);
    }
    return result;
  }
}
