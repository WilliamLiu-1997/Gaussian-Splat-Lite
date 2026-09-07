import * as THREE from "three";
import {
  type SogLodIndex,
  type SogLodLeaf,
  type SogVisibleLeaf,
  readSogLodLeaf,
} from "./sogLod";

/** Per-index traversal state keeps leaf identities stable between frames. */
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

  constructor(private readonly manifest: SogLodIndex) {}

  collect(camera: THREE.Camera, group: THREE.Object3D) {
    camera.updateWorldMatrix(true, false);
    group.updateWorldMatrix(true, false);
    this.modelView.multiplyMatrices(
      camera.matrixWorldInverse,
      group.matrixWorld,
    );
    this.clip.multiplyMatrices(camera.projectionMatrix, this.modelView);
    this.inverseModelView.copy(this.modelView).invert();
    this.cameraPosition.setFromMatrixPosition(this.inverseModelView);
    this.frustum.setFromProjectionMatrix(
      this.clip,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    const visible: SogVisibleLeaf[] = [];
    let shown = camera.layers.test(group.layers);
    for (let node: THREE.Object3D | null = group; node; node = node.parent)
      shown &&= node.visible;
    const nodes = this.manifest.nodes;
    const projection = camera.projectionMatrix.elements;
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
    return { shown, visible };
  }
}
