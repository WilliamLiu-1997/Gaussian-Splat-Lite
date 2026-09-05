import * as THREE from "three";

import { SPLAT_TEX_WIDTH } from "../data/defines";
import { emptySplatTexture, getTextureSize } from "../data/textureLayout";
import { SplatEdit, SplatEdits } from "../scene/SplatEdit";
import { SplatMesh } from "../scene/SplatMesh";
import { threeMrtArray } from "../utils/three";
import { decomposeSplatTransform } from "../utils/transforms";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "./rendererUtils";
import { makeGenerateUniforms } from "./uniforms";
import {
  createWebGLAccumulatorTarget,
  generateWebGLAccumulator,
  getWebGLGenerateUniforms,
} from "./webgl/AccumulatorGenerator";
import { WebGPUAccumulatorGenerator } from "./webgpu/AccumulatorGenerator";

export type SplatMapping = {
  node: SplatMesh;
  version: number;
  sortVersion: number;
  centerVersion: number;
  mappingVersion: number;
  base: number;
  count: number;
};

type GenerateUniforms = Record<string, THREE.IUniform>;
type SplatDataTextures = readonly [THREE.Texture, THREE.Texture];

export class SplatAccumulator {
  time = 0;
  deltaTime = 0;
  viewOrigin = new THREE.Vector3();
  viewDirection = new THREE.Vector3();
  maxSplats = 0;
  numSplats = 0;
  target: THREE.WebGLArrayRenderTarget | null = null;
  mapping: SplatMapping[] = [];
  version = -1;
  mappingVersion = -1;

  private transformScale = new THREE.Vector3();
  private transformQuaternion = new THREE.Quaternion();
  private webGPUGenerator: WebGPUAccumulatorGenerator | null = null;

  constructor() {
    if (!threeMrtArray) {
      throw new Error("Gaussian Splat Lite requires THREE.js r179 or above");
    }
  }

  dispose() {
    this.disposeStorage();
    this.mapping = [];
    this.numSplats = 0;
    this.version = -1;
    this.mappingVersion = -1;
  }

  private disposeStorage() {
    this.target?.dispose();
    this.target = null;
    this.webGPUGenerator?.dispose();
    this.webGPUGenerator = null;
    this.maxSplats = 0;
  }

  getTextures(): SplatDataTextures {
    return (this.webGPUGenerator?.textures ??
      this.target?.textures ??
      SplatAccumulator.emptyTextures) as SplatDataTextures;
  }

  generateMapping(splatCounts: number[], compact = false) {
    let maxSplats = 0;
    const mapping = splatCounts.map((count) => {
      const base = maxSplats;
      maxSplats += compact
        ? count
        : Math.ceil(count / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      return { base, count };
    });
    return { maxSplats, mapping };
  }

  ensureGenerate({
    maxSplats,
    renderer,
    shrinkResources = false,
  }: {
    maxSplats: number;
    renderer?: GaussianSplatCompatibleRenderer;
    shrinkResources?: boolean;
  }) {
    const {
      width,
      height,
      depth,
      maxSplats: capacity,
    } = getTextureSize(Math.max(1, maxSplats));
    const reusable = shrinkResources
      ? capacity === this.maxSplats
      : capacity <= this.maxSplats;

    if (renderer && isWebGPURenderer(renderer)) {
      if (this.webGPUGenerator && reusable) return false;

      if (this.webGPUGenerator) {
        this.webGPUGenerator.setSize(width, height, depth);
      } else {
        this.disposeStorage();
        this.webGPUGenerator = new WebGPUAccumulatorGenerator({
          uniforms: makeGenerateUniforms(),
          width,
          height,
          depth,
        });
      }
      this.maxSplats = capacity;
      return true;
    }

    if (this.target && reusable) {
      return false;
    }
    // Keep the prepared mapping and versions while replacing only its GPU
    // storage. Full dispose() also severs references to source meshes.
    this.disposeStorage();

    this.maxSplats = capacity;
    this.target = createWebGLAccumulatorTarget(width, height, depth);
    return true;
  }

  private prepareUniforms(mesh: SplatMesh, uniforms: GenerateUniforms) {
    const source = mesh.splats;
    if (!source) {
      throw new Error("SplatMesh has no source");
    }
    source.setTextureUniforms(uniforms);
    uniforms.numSh.value = Math.min(mesh.maxSh, source.getNumSh());

    decomposeSplatTransform(
      mesh.matrixWorld,
      this.transformScale,
      this.transformQuaternion,
    );
    uniforms.objectBasis.value.setFromMatrix4(mesh.matrixWorld);
    uniforms.objectOffset.value.setFromMatrixPosition(mesh.matrixWorld);
    // THREE.Vector3 and Matrix4 use JS numbers, so this subtraction happens
    // before the value is narrowed to a float32 WebGL uniform.
    uniforms.objectOffset.value.sub(this.viewOrigin);
    // Match PlayCanvas' work-buffer transform: centers use the complete affine
    // basis, while splat shape uses the decomposed rotation and positive
    // per-axis scale. This is intentionally an approximation for non-uniform
    // transforms while preserving ordinary scale/quaternion storage and zero
    // scale axes.
    uniforms.objectLnScale.value.set(
      Math.log(this.transformScale.x),
      Math.log(this.transformScale.y),
      Math.log(this.transformScale.z),
    );
    uniforms.objectQuaternion.value.copy(this.transformQuaternion);
    uniforms.recolor.value.set(
      mesh.recolor.r,
      mesh.recolor.g,
      mesh.recolor.b,
      THREE.MathUtils.clamp(mesh.opacity, 0, 1),
    );

    const edits = mesh.sdfEdits;
    uniforms.numSdfs.value = edits?.numSdfs ?? 0;
    uniforms.numEdits.value = edits?.numEdits ?? 0;
    uniforms.sdfTexture.value = edits?.sdfTexture ?? SplatEdits.emptyTexture;
    uniforms.editTexture.value = edits?.editTexture ?? SplatEdits.emptyTexture;
  }

  generate({
    mesh,
    base,
    count,
    renderer,
  }: {
    mesh: SplatMesh;
    base: number;
    count: number;
    renderer: GaussianSplatCompatibleRenderer;
  }) {
    if (base + count > this.maxSplats) {
      throw new Error("Splat generation range exceeds accumulator capacity");
    }

    if (isWebGPURenderer(renderer)) {
      if (!this.webGPUGenerator) {
        throw new Error("WebGPU accumulator is not initialized");
      }
      this.prepareUniforms(mesh, this.webGPUGenerator.uniforms);
      this.webGPUGenerator.generate({ renderer, base, count });
      return;
    }

    if (!this.target) throw new Error("Accumulator target is not initialized");
    this.prepareUniforms(mesh, getWebGLGenerateUniforms());
    generateWebGLAccumulator({ renderer, target: this.target, base, count });
  }

  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    previous,
  }: {
    renderer: GaussianSplatCompatibleRenderer;
    scene: THREE.Scene;
    timer: THREE.Timer;
    camera: THREE.Camera;
    previous: SplatAccumulator;
  }) {
    // Preserve the previous metadata before replacing this accumulator's
    // mapping. In synchronous-sort mode `previous` and `this` are the same
    // accumulator, so reading these values later would compare the new mapping
    // with itself and suppress required regeneration/sorting.
    const previousMapping = previous.mapping;
    const previousVersion = previous.version;
    const previousMappingVersion = previous.mappingVersion;

    camera.getWorldPosition(this.viewOrigin);
    camera.getWorldDirection(this.viewDirection);
    this.time = timer.getElapsed();
    this.deltaTime = timer.getDelta();

    const allMeshes: SplatMesh[] = [];
    scene.traverse((node) => {
      if (node instanceof SplatMesh && camera.layers.test(node.layers)) {
        allMeshes.push(node);
      }
    });

    const globalEdits = new Set<SplatEdit>();
    scene.traverseVisible((node) => {
      if (!(node instanceof SplatEdit)) return;
      let ancestor = node.parent;
      while (ancestor && !(ancestor instanceof SplatMesh)) {
        ancestor = ancestor.parent;
      }
      if (!ancestor) globalEdits.add(node);
    });

    for (const mesh of allMeshes) {
      try {
        mesh.frameUpdate({
          time: this.time,
          deltaTime: this.deltaTime,
          camera,
          globalEdits: Array.from(globalEdits),
        });
      } catch (error) {
        console.error("SplatMesh frame update failed", error);
      }
    }

    const visibleMeshes: SplatMesh[] = [];
    scene.traverseVisible((node) => {
      // Mesh opacity is the final multiplier after SDF opacity edits, so zero
      // remains fully transparent even when an SDF sets or adds opacity.
      if (
        node instanceof SplatMesh &&
        camera.layers.test(node.layers) &&
        node.opacity > 0
      ) {
        visibleMeshes.push(node);
      }
    });
    const { maxSplats, mapping: ranges } = this.generateMapping(
      visibleMeshes.map((mesh) => mesh.numSplats),
      isWebGPURenderer(renderer),
    );

    this.mapping = [];
    this.numSplats = 0;
    ranges.forEach(({ base, count }, index) => {
      const node = visibleMeshes[index];
      if (!node.splats || count <= 0) return;
      this.mapping.push({
        node,
        version: node.version,
        sortVersion: node.sortVersion,
        centerVersion: node.centerVersion,
        mappingVersion: node.mappingVersion,
        base,
        count,
      });
      this.numSplats = Math.max(this.numSplats, base + count);
    });

    const { splatsUpdated, mappingUpdated, sortUpdated } = checkMappingVersions(
      previousMapping,
      this.mapping,
    );
    this.version = previousVersion + (splatsUpdated ? 1 : 0);
    this.mappingVersion = previousMappingVersion + (mappingUpdated ? 1 : 0);

    return {
      version: this.version,
      sortUpdated,
      requiredMaxSplats: getTextureSize(Math.max(1, maxSplats)).maxSplats,
      generate: (shrinkResources = false) => {
        this.ensureGenerate({ maxSplats, renderer, shrinkResources });
        for (const { node, base, count } of this.mapping) {
          this.generate({ mesh: node, base, count, renderer });
        }
      },
    };
  }

  checkVersions(other: SplatMapping[]) {
    return checkMappingVersions(this.mapping, other);
  }

  static emptyTexture = emptySplatTexture;

  static emptyTextures: SplatDataTextures = [
    SplatAccumulator.emptyTexture,
    SplatAccumulator.emptyTexture,
  ];
}

function checkMappingVersions(
  previousMapping: SplatMapping[],
  nextMapping: SplatMapping[],
) {
  if (previousMapping.length !== nextMapping.length) {
    return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
  }
  const mappingUpdated = previousMapping.some((item, index) => {
    const next = nextMapping[index];
    return (
      item.node !== next.node ||
      item.base !== next.base ||
      item.count !== next.count ||
      item.mappingVersion !== next.mappingVersion
    );
  });
  if (mappingUpdated) {
    return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
  }
  return {
    splatsUpdated: previousMapping.some(
      (item, index) => item.version !== nextMapping[index].version,
    ),
    mappingUpdated: false,
    sortUpdated: previousMapping.some(
      (item, index) => item.sortVersion !== nextMapping[index].sortVersion,
    ),
  };
}
