import * as THREE from "three";
import {
  type SogLodIndex,
  type SogLodLeaf,
  type SogVisibleLeaf,
  readSogLodLeaf,
  selectSogLods,
} from "./sogLod";

export type SogView = {
  modelView: number[];
  projection: number[];
  coordinateSystem: THREE.CoordinateSystem;
  reversedDepth: boolean;
  shown: boolean;
};

/** Capture the view without traversing the manifest or reducing matrix precision. */
export function captureSogView(
  camera: THREE.Camera,
  group: THREE.Object3D,
): SogView {
  camera.updateWorldMatrix(true, false);
  group.updateWorldMatrix(true, false);
  const modelView = new THREE.Matrix4().multiplyMatrices(
    camera.matrixWorldInverse,
    group.matrixWorld,
  );
  let shown = camera.layers.test(group.layers);
  for (let node: THREE.Object3D | null = group; node; node = node.parent)
    shown &&= node.visible;
  return {
    modelView: modelView.elements,
    projection: camera.projectionMatrix.toArray(),
    coordinateSystem: camera.coordinateSystem,
    reversedDepth: camera.reversedDepth,
    shown,
  };
}

/** Worker traversal state keeps leaf identities stable between selections. */
export class SogVisibility {
  private readonly leaves = new Map<number, SogLodLeaf>();
  private readonly clip = new THREE.Matrix4();
  private readonly modelView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  private readonly bound = new THREE.Box3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly closest = new THREE.Vector3();
  private readonly inverseModelView = new THREE.Matrix4();

  constructor(
    private readonly manifest: Pick<
      SogLodIndex,
      "nodes" | "leafOffsets" | "lods"
    >,
  ) {}

  private collect(view: SogView) {
    this.modelView.fromArray(view.modelView);
    this.clip.fromArray(view.projection).multiply(this.modelView);
    this.inverseModelView.copy(this.modelView).invert();
    this.cameraPosition.setFromMatrixPosition(this.inverseModelView);
    this.frustum.setFromProjectionMatrix(
      this.clip,
      view.coordinateSystem,
      view.reversedDepth,
    );
    const visible: SogVisibleLeaf[] = [];
    const { shown } = view;
    const nodes = this.manifest.nodes;
    const projection = view.projection;
    const fovScale =
      1 /
      (Math.max(Math.abs(projection[0]), Math.abs(projection[5])) *
        Math.tan(Math.PI / 8));
    for (let index = 0; shown && index < nodes.length / 8; ) {
      const offset = index * 8;
      this.bound.min.fromArray(nodes, offset);
      this.bound.max.fromArray(nodes, offset + 3);
      if (!this.frustum.intersectsBox(this.bound)) {
        index = nodes[offset + 6];
        continue;
      }
      index++;
      const id = nodes[offset + 7];
      if (id >= 0) {
        let leaf = this.leaves.get(id);
        if (!leaf) {
          leaf = readSogLodLeaf(this.manifest, id);
          this.leaves.set(id, leaf);
        }
        this.bound.getBoundingSphere(this.sphere).applyMatrix4(this.modelView);
        this.bound
          .clampPoint(this.cameraPosition, this.closest)
          .applyMatrix4(this.modelView);
        const radius = this.sphere.radius;
        const projectedRadius =
          projection[11] === 0
            ? Math.min(radius * Math.abs(projection[5]), 1)
            : radius /
              Math.max(radius + this.closest.length() * fovScale, 1e-12);
        visible.push({
          leaf,
          weight: Math.max(1e-12, projectedRadius * projectedRadius),
        });
      }
    }
    return visible;
  }

  /** Transfer only [leaf ID, LOD ordinal] pairs in loading priority order. */
  select(view: SogView, budget: number): Uint32Array {
    const visible = this.collect(view);
    const targets = selectSogLods(visible, budget);
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
