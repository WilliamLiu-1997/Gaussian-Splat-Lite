import * as THREE from "three";
import * as TSL from "three/tsl";
import { StorageArrayTexture, type WebGPURenderer } from "three/webgpu";

import { makeGenerateUniforms } from "../uniforms";
import { createGenerateProgram } from "./GenerateProgram";
import { splatTexCoord } from "./shaderUtils";

// biome-ignore lint/suspicious/noExplicitAny: Three does not expose one public compute-node type.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

const WORKGROUP_SIZE = 256;
const BATCH_SIZE = 32;

type GenerateUniforms = Record<string, THREE.IUniform>;
type ComputeSlot = { uniforms: GenerateUniforms; node: TSLNode };
type PrecompilableRenderer = WebGPURenderer & {
  compileComputeAsync(nodes: TSLNode[]): Promise<void>;
};

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

/** Reusable compute slots sharing one accumulator's GPU-only output textures. */
export class WebGPUAccumulatorGenerator {
  readonly textures: readonly [StorageArrayTexture, StorageArrayTexture];
  ready: Promise<void> | null = null;
  compileError: unknown = null;

  private readonly slots: ComputeSlot[] = [];
  private readonly pending: TSLNode[] = [];
  private batching = false;
  private disposed = false;
  private precompileStarted = false;

  constructor({
    width,
    height,
    depth,
  }: {
    width: number;
    height: number;
    depth: number;
  }) {
    this.textures = [
      makeAccumulatorTexture(width, height, depth),
      makeAccumulatorTexture(width, height, depth),
    ];
    for (let index = 0; index < BATCH_SIZE; index++) {
      this.slots.push(this.createSlot());
    }
  }

  private createSlot(): ComputeSlot {
    const uniforms = makeGenerateUniforms();
    const targetBase = N.uniform(
      uniforms.targetBase.value,
      "uint",
    ).onObjectUpdate(() => uniforms.targetBase.value);
    const generateAccumulator = createGenerateProgram({ uniforms });
    const node = N.Fn(() => {
      const index = N.uint(N.instanceIndex);
      const coord = splatTexCoord(index.add(targetBase));
      const { accumulatorA, accumulatorB } = generateAccumulator(index);
      storeArrayTexture(this.textures[0], coord, accumulatorA);
      storeArrayTexture(this.textures[1], coord, accumulatorB);
    })()
      .compute(1, [WORKGROUP_SIZE])
      .setName("Splat accumulator generate");
    return { uniforms, node };
  }

  get uniforms(): GenerateUniforms {
    return this.slots[this.pending.length].uniforms;
  }

  precompile(renderer: WebGPURenderer) {
    if (this.precompileStarted || this.disposed) return;
    this.precompileStarted = true;
    this.ready = (renderer as PrecompilableRenderer)
      .compileComputeAsync(this.slots.map(({ node }) => node))
      .catch((error: unknown) => {
        this.compileError = error ?? new Error("Accumulator precompile failed");
      })
      .finally(() => {
        this.ready = null;
        // Compilation can create resources after the owner has been disposed.
        if (this.disposed) this.disposeResources();
      });
  }

  setSize(width: number, height: number, depth: number) {
    for (const texture of this.textures) {
      texture.setSize(width, height, depth);
    }
  }

  batch(renderer: WebGPURenderer, generate: () => void) {
    this.batching = true;
    try {
      generate();
      this.flush(renderer);
    } finally {
      this.batching = false;
      this.pending.length = 0;
    }
  }

  private flush(renderer: WebGPURenderer) {
    if (this.pending.length === 0) return;
    if (this.compileError !== null) throw this.compileError;
    if (this.ready) throw new Error("Accumulator precompile is still pending");
    renderer.compute(this.pending);
    // Queue writes for reused slots follow the preceding batch's submission.
    this.pending.length = 0;
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
    const { uniforms, node } = this.slots[this.pending.length];
    uniforms.targetBase.value = base;
    uniforms.targetCount.value = count;
    node.count = count;
    this.pending.push(node);
    if (!this.batching || this.pending.length === BATCH_SIZE) {
      this.flush(renderer);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    if (!this.ready) this.disposeResources();
  }

  private disposeResources() {
    for (const slot of this.slots) slot.node.dispose();
    this.slots.length = 0;
    for (const texture of this.textures) texture.dispose();
  }
}
