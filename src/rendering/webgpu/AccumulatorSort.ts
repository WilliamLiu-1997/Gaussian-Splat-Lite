import * as THREE from "three";
import * as TSL from "three/tsl";
import type { WebGPURenderer } from "three/webgpu";

import { emptySplatTexture } from "../../data/textureLayout";
import { WebGPURadixSort } from "./RadixSort";
import { splatTexCoord } from "./shaderUtils";

// biome-ignore lint/suspicious/noExplicitAny: Three does not expose one public compute-node type.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

type PrecompilableWebGPURenderer = WebGPURenderer & {
  compileComputeAsync(computeNodes: TSLNode[]): Promise<void>;
};

type SortUniforms = {
  splats: { value: THREE.Texture };
  direction: { value: THREE.Vector3 };
  radial: { value: boolean };
};

function createKeyGenerator(uniforms: SortUniforms) {
  const splats = N.textureLoad(emptySplatTexture).onObjectUpdate(
    () => uniforms.splats.value,
  );
  const direction = N.uniform(new THREE.Vector3(), "vec3").onObjectUpdate(
    () => uniforms.direction.value,
  );
  const radial = N.uniform(false, "bool").onObjectUpdate(
    () => uniforms.radial.value,
  );

  return (inputIndex: TSLNode) => {
    const index = N.uint(inputIndex);
    const coord = splatTexCoord(index);
    const center = N.uintBitsToFloat(splats.load(coord.xy).depth(coord.z).xyz);
    const metric = N.select(
      radial,
      center.dot(center),
      center.dot(direction).add(100),
    );
    const metricBits = N.floatBitsToUint(metric);
    const key = N.uint(0xffffffff).toVar();
    N.If(
      metric.greaterThanEqual(0).and(metricBits.lessThan(N.uint(0x7f800000))),
      () => {
        key.assign(N.uint(0xffffffff).sub(metricBits));
      },
    );
    return key;
  };
}

/** GPU radix sort over the generated accumulator's camera-relative centers. */
export class WebGPUAccumulatorSort {
  private readonly sorter: WebGPURadixSort;
  private readonly uniforms: SortUniforms;

  constructor(capacity: number) {
    this.uniforms = {
      splats: { value: emptySplatTexture },
      direction: { value: new THREE.Vector3() },
      radial: { value: false },
    };
    this.sorter = new WebGPURadixSort(
      capacity,
      createKeyGenerator(this.uniforms),
    );
  }

  get ordering() {
    return this.sorter.ordering;
  }

  get capacity() {
    return this.sorter.capacity;
  }

  precompile(renderer: WebGPURenderer) {
    return (renderer as PrecompilableWebGPURenderer).compileComputeAsync(
      this.sorter.nodes,
    );
  }

  resize(capacity: number, shrinkResources = false) {
    this.sorter.resize(capacity, shrinkResources);
  }

  sort({
    renderer,
    splats,
    count,
    direction,
    radial,
  }: {
    renderer: WebGPURenderer;
    splats: THREE.Texture;
    count: number;
    direction: THREE.Vector3;
    radial: boolean;
  }) {
    if (count <= 0) return;
    this.uniforms.splats.value = splats;
    this.uniforms.direction.value.copy(direction);
    this.uniforms.radial.value = radial;
    renderer.compute(this.sorter.prepare(count));
  }

  dispose() {
    this.sorter.dispose();
  }
}
