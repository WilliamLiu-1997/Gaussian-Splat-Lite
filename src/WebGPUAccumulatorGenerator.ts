import * as THREE from "three";
import * as TSL from "three/tsl";
import { StorageArrayTexture, type WebGPURenderer } from "three/webgpu";

import { createGenerateProgram, splatTexCoord } from "./webgpuMaterials";

// biome-ignore lint/suspicious/noExplicitAny: Three does not expose one public compute-node type.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

const WORKGROUP_SIZE = 256;

type GenerateUniforms = Record<string, THREE.IUniform>;

function makeAccumulatorTexture(width: number, height: number, depth: number) {
  const texture = new StorageArrayTexture(width, height, depth);
  texture.format = THREE.RGBAIntegerFormat;
  texture.type = THREE.UnsignedIntType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function storeArrayTexture(
  texture: StorageArrayTexture,
  coord: TSLNode,
  value: TSLNode,
) {
  N.storageTexture(texture, coord.xy, value)
    .depth(coord.z)
    .toWriteOnly()
    .toStack();
}

/** Fixed compute graph that generates one accumulator into GPU-only textures. */
export class WebGPUAccumulatorGenerator {
  readonly uniforms: GenerateUniforms;
  readonly textures: readonly [StorageArrayTexture, StorageArrayTexture];

  private readonly computeNode: TSLNode;

  constructor({
    uniforms,
    width,
    height,
    depth,
  }: {
    uniforms: GenerateUniforms;
    width: number;
    height: number;
    depth: number;
  }) {
    this.uniforms = uniforms;
    this.textures = [
      makeAccumulatorTexture(width, height, depth),
      makeAccumulatorTexture(width, height, depth),
    ];

    const targetBase = N.uniform(
      uniforms.targetBase.value,
      "uint",
    ).onObjectUpdate(() => uniforms.targetBase.value);
    const generateAccumulator = createGenerateProgram({ uniforms });
    this.computeNode = N.Fn(() => {
      const index = N.uint(N.instanceIndex);
      const coord = splatTexCoord(index.add(targetBase));
      const { accumulatorA, accumulatorB } = generateAccumulator(index);
      storeArrayTexture(this.textures[0], coord, accumulatorA);
      storeArrayTexture(this.textures[1], coord, accumulatorB);
    })()
      .compute(1, [WORKGROUP_SIZE])
      .setName("Splat accumulator generate");
  }

  setSize(width: number, height: number, depth: number) {
    for (const texture of this.textures) {
      texture.setSize(width, height, depth);
    }
  }

  generate({
    renderer,
    base,
    count,
  }: {
    renderer: WebGPURenderer;
    base: number;
    count: number;
  }) {
    if (count <= 0) return;
    this.uniforms.targetBase.value = base;
    this.uniforms.targetCount.value = count;
    this.computeNode.count = count;
    renderer.compute(this.computeNode);
  }

  dispose() {
    this.computeNode.dispose();
    for (const texture of this.textures) texture.dispose();
  }
}
