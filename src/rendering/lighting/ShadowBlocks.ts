import * as THREE from "three";
import { SPLATS_PER_INSTANCE, type SplatGeometry } from "../SplatGeometry";
import type { Uniforms } from "../uniforms";

type Bounds = {
  versions: number[];
  count: number;
  values: Float64Array;
};
const boundsCache = new WeakMap<THREE.Texture, Bounds>();

/** Center bounds include every record, including opacity that SDFs can restore. */
function getBounds(uniforms: Uniforms, count: number) {
  const first = uniforms.sourceSplats.value as THREE.DataArrayTexture;
  const indices = uniforms.sourceIndices.value as THREE.DataArrayTexture;
  const versions = [
    first.version,
    Number(uniforms.sourceIndexed.value),
    indices.id,
    indices.version,
  ];
  let cached = boundsCache.get(first);
  if (
    cached?.count === count &&
    versions.every((value, i) => value === cached?.versions[i])
  )
    return cached.values;
  const packed = first.image.data as Uint32Array;
  const centers = new Float32Array(
    packed.buffer,
    packed.byteOffset,
    packed.length,
  );
  const sourceIndices = uniforms.sourceIndexed.value
    ? (indices.image.data as Uint32Array)
    : null;
  const values = new Float64Array(Math.ceil(count / SPLATS_PER_INSTANCE) * 6);
  for (
    let start = 0, block = 0;
    start < count;
    start += SPLATS_PER_INSTANCE, block += 6
  ) {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    const end = Math.min(start + SPLATS_PER_INSTANCE, count);
    for (let i = start; i < end; i++) {
      const offset = (sourceIndices ? sourceIndices[i] : i) * 4;
      const x = centers[offset];
      const y = centers[offset + 1];
      const z = centers[offset + 2];
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      z1 = Math.max(z1, z);
    }
    values.set(
      [
        (x0 + x1) * 0.5,
        (y0 + y1) * 0.5,
        (z0 + z1) * 0.5,
        (x1 - x0) * 0.5,
        (y1 - y0) * 0.5,
        (z1 - z0) * 0.5,
      ],
      block,
    );
  }
  cached = { versions, count, values };
  boundsCache.set(first, cached);
  return values;
}

/** Compact 128-record draw blocks against each light face, without GPU readback. */
export class ShadowBlocks {
  private attribute = new THREE.InstancedBufferAttribute(new Uint32Array(1), 1);
  private texture: THREE.DataTexture | null = null;
  private indices = this.attribute.array;
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private readonly planes = new Float64Array(24);

  constructor(
    private readonly geometry: SplatGeometry,
    private readonly uniforms: Uniforms,
    private readonly node: boolean,
  ) {
    this.attribute.gpuType = THREE.IntType;
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    if (node) geometry.setAttribute("shadowBlock", this.attribute);
    else uniforms.shadowBlocks = { value: null };
  }

  update(
    count: number,
    matrixWorld: THREE.Matrix4,
    camera: THREE.Camera,
    clipXY: number,
  ) {
    const bounds = getBounds(this.uniforms, count);
    const blocks = bounds.length / 6;
    if (this.indices.length < blocks || (!this.node && !this.texture)) {
      if (this.node) {
        this.geometry.dispose();
        this.attribute = new THREE.InstancedBufferAttribute(
          new Uint32Array(blocks),
          1,
        );
        this.attribute.gpuType = THREE.IntType;
        this.attribute.setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute("shadowBlock", this.attribute);
        this.indices = this.attribute.array;
      } else {
        // WebGLObjects uploads vertex attributes once per frame, before
        // onBeforeShadow. A texture can upload the current list for every face.
        this.texture?.dispose();
        const height = Math.max(1, Math.ceil(blocks / 2048));
        this.indices = new Uint32Array(2048 * height);
        this.texture = new THREE.DataTexture(
          this.indices,
          2048,
          height,
          THREE.RedIntegerFormat,
          THREE.UnsignedIntType,
        );
        this.uniforms.shadowBlocks.value = this.texture;
      }
    }
    this.matrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    // The vertex shader rejects centers outside this expanded frustum before
    // projecting their footprints. Center bounds are sufficient even for large
    // Gaussians: expanding them by scale would submit blocks that cannot draw.
    const elements = this.matrix.elements;
    for (let column = 0; column < 4; column++) {
      elements[column * 4] /= clipXY;
      elements[column * 4 + 1] /= clipXY;
    }
    this.frustum.setFromProjectionMatrix(
      this.matrix,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    const m = matrixWorld.elements;
    for (let i = 0; i < 6; i++) {
      const { normal: n, constant } = this.frustum.planes[i];
      this.planes.set(
        [
          n.x * m[0] + n.y * m[1] + n.z * m[2],
          n.x * m[4] + n.y * m[5] + n.z * m[6],
          n.x * m[8] + n.y * m[9] + n.z * m[10],
          n.x * m[12] + n.y * m[13] + n.z * m[14] + constant,
        ],
        i * 4,
      );
    }
    let visible = 0;
    for (let block = 0; block < blocks; block++) {
      const b = block * 6;
      let inside = true;
      for (let p = 0; p < 24; p += 4) {
        const x = this.planes[p];
        const y = this.planes[p + 1];
        const z = this.planes[p + 2];
        const center =
          x * bounds[b] +
          y * bounds[b + 1] +
          z * bounds[b + 2] +
          this.planes[p + 3];
        const extent =
          Math.abs(x) * bounds[b + 3] +
          Math.abs(y) * bounds[b + 4] +
          Math.abs(z) * bounds[b + 5];
        if (center + extent < -1e-5 * (1 + Math.abs(center) + extent)) {
          inside = false;
          break;
        }
      }
      if (inside) this.indices[visible++] = block * SPLATS_PER_INSTANCE;
    }
    if (this.texture) this.texture.needsUpdate = true;
    else {
      this.attribute.clearUpdateRanges();
      if (visible) this.attribute.addUpdateRange(0, visible);
      this.attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = visible;
  }

  dispose() {
    this.texture?.dispose();
  }
}
