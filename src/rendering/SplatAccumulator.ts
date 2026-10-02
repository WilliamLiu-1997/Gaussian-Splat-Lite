import * as THREE from "three";

import { SPLAT_TEX_WIDTH } from "../data/defines";
import { emptySplatTexture, getTextureSize } from "../data/textureLayout";
import { SplatEdit, SplatEdits } from "../scene/SplatEdit";
import { SplatMesh } from "../scene/SplatMesh";
import { threeRevision } from "../utils/three";
import { decomposeSplatTransform } from "../utils/transforms";
import {
  type GaussianSplatCompatibleRenderer,
  getViews,
  isWebGPURenderer,
  usesNativeWebGPU,
} from "./rendererUtils";
import {
  WebGLFallbackAccumulatorGenerator,
  createWebGLFallbackAccumulatorTarget,
} from "./webgl-fallback/AccumulatorGenerator";
import {
  createWebGLAccumulatorTarget,
  generateWebGLAccumulator,
  getWebGLGenerateUniforms,
  hasStochasticSeeds,
} from "./webgl/AccumulatorGenerator";

export type SplatMapping = {
  node: SplatMesh;
  matrixWorld: THREE.Matrix4;
  source: SplatMesh["splats"];
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
  private readonly previousOrigin = new THREE.Vector3();
  viewDirection = new THREE.Vector3();
  maxSplats = 0;
  numSplats = 0;
  target: THREE.WebGLArrayRenderTarget | null = null;
  mapping: SplatMapping[] = [];
  version = -1;
  mappingVersion = -1;

  private transformScale = new THREE.Vector3();
  private transformQuaternion = new THREE.Quaternion();
  private fallbackGenerator: WebGLFallbackAccumulatorGenerator | null = null;

  constructor() {
    if (threeRevision < 186) {
      throw new Error("Gaussian Splat Lite requires Three.js r186 or above");
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
    this.fallbackGenerator?.dispose();
    this.fallbackGenerator = null;
    this.maxSplats = 0;
  }

  getTextures(): SplatDataTextures {
    const textures = this.target?.textures;
    return textures
      ? [textures[0], textures[1]]
      : SplatAccumulator.emptyTextures;
  }

  getStochasticSeeds(): THREE.Texture {
    return this.target?.textures[2] ?? SplatAccumulator.emptyTexture;
  }

  /** Whether this accumulator was generated for stochastic rendering. */
  get hasStochasticSeeds() {
    return this.target !== null && hasStochasticSeeds(this.target);
  }

  /**
   * Regenerate moved meshes in place, without changing the source ranges used
   * by an in-flight sort. WebGL backends only.
   */
  refreshTransforms(renderer: GaussianSplatCompatibleRenderer) {
    let changed = false;
    for (const entry of this.mapping) {
      const { node, source, base, count } = entry;
      if (entry.matrixWorld.equals(node.matrixWorld)) continue;
      // A new source/LOD mapping needs matching indices before it can be shown.
      if (
        !source ||
        source !== node.splats ||
        source.needsUpdate ||
        source.getNumSplats() !== count ||
        entry.centerVersion !== node.centerVersion ||
        entry.mappingVersion !== node.mappingVersion
      )
        continue;
      this.generate({ mesh: node, base, count, renderer });
      entry.matrixWorld.copy(node.matrixWorld);
      changed = true;
    }
    if (changed) this.version++;
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
    stochasticSeeds = false,
  }: {
    maxSplats: number;
    renderer?: GaussianSplatCompatibleRenderer;
    shrinkResources?: boolean;
    stochasticSeeds?: boolean;
  }) {
    if (renderer && usesNativeWebGPU(renderer)) {
      throw new Error(
        "Accumulator texture generation requires a WebGL backend",
      );
    }
    const {
      width,
      height,
      depth,
      maxSplats: capacity,
    } = getTextureSize(Math.max(1, maxSplats), 1);
    const reusable = shrinkResources
      ? capacity === this.maxSplats
      : capacity <= this.maxSplats;

    const fallback = renderer !== undefined && isWebGPURenderer(renderer);
    if (
      this.target &&
      reusable &&
      fallback === (this.fallbackGenerator !== null) &&
      stochasticSeeds === hasStochasticSeeds(this.target)
    ) {
      return false;
    }
    // Keep the prepared mapping and versions while replacing only its GPU
    // storage. Full dispose() also severs references to source meshes.
    this.disposeStorage();

    this.maxSplats = capacity;
    this.target = fallback
      ? createWebGLFallbackAccumulatorTarget(
          width,
          height,
          depth,
          stochasticSeeds,
        )
      : createWebGLAccumulatorTarget(width, height, depth, stochasticSeeds);
    if (fallback)
      this.fallbackGenerator = new WebGLFallbackAccumulatorGenerator(
        stochasticSeeds,
      );
    return true;
  }

  prepareUniforms(
    mesh: SplatMesh,
    uniforms: GenerateUniforms,
    matrixWorld = mesh.matrixWorld,
  ) {
    const source = mesh.splats;
    if (!source) {
      throw new Error("SplatMesh has no source");
    }
    source.setTextureUniforms(uniforms);
    // A mesh keeps its seed when other meshes enter/leave the packed mapping.
    // Combine it on the GPU with the physical source index, before LOD compaction.
    uniforms.stochasticSeedBase.value =
      Math.imul(mesh.id + 1, 0x9e3779b9) >>> 0;
    uniforms.numSh.value = Math.min(mesh.maxSh, source.getNumSh());

    uniforms.objectReflected.value = decomposeSplatTransform(
      matrixWorld,
      this.transformScale,
      this.transformQuaternion,
    );
    uniforms.objectBasis.value.setFromMatrix4(matrixWorld);
    uniforms.objectOffset.value.setFromMatrixPosition(matrixWorld);
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
    if (usesNativeWebGPU(renderer)) {
      throw new Error(
        "Accumulator texture generation requires a WebGL backend",
      );
    }
    if (base + count > this.maxSplats) {
      throw new Error("Splat generation range exceeds accumulator capacity");
    }

    if (!this.target) throw new Error("Accumulator target is not initialized");
    if (isWebGPURenderer(renderer)) {
      if (!this.fallbackGenerator)
        throw new Error("WebGL fallback accumulator is not initialized");
      this.prepareUniforms(mesh, this.fallbackGenerator.uniforms);
      this.fallbackGenerator.generate({
        renderer,
        target: this.target,
        base,
        count,
      });
      return;
    }
    this.prepareUniforms(mesh, getWebGLGenerateUniforms());
    generateWebGLAccumulator({ renderer, target: this.target, base, count });
  }

  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    layerCamera = camera,
    previous,
  }: {
    renderer: GaussianSplatCompatibleRenderer;
    scene: THREE.Scene;
    timer: THREE.Timer;
    camera: THREE.Camera;
    layerCamera?: THREE.Camera;
    previous: SplatAccumulator;
  }) {
    // Preserve the previous metadata before replacing this accumulator's
    // mapping. Native WebGPU prepares this metadata in place, so reading these
    // values later would compare the new mapping with itself and suppress
    // required updates.
    const previousMapping = previous.mapping;
    const previousVersion = previous.version;
    const previousMappingVersion = previous.mappingVersion;

    const previousOrigin = this.previousOrigin.copy(previous.viewOrigin);
    this.viewOrigin.setFromMatrixPosition(camera.matrixWorld);
    this.viewDirection
      .setFromMatrixColumn(camera.matrixWorld, 2)
      .normalize()
      .negate();
    this.time = timer.getElapsed();
    this.deltaTime = timer.getDelta();

    // Meshes on any eye's layers draw in both eyes; each eye's projection
    // still culls to its own view.
    const layerMask = getViews(layerCamera).reduce(
      (mask, view) => mask | view.layers.mask,
      0,
    );

    const allMeshes: SplatMesh[] = [];
    scene.traverse((node) => {
      if (node instanceof SplatMesh && (layerMask & node.layers.mask) !== 0) {
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
      mesh.frameUpdate({
        time: this.time,
        deltaTime: this.deltaTime,
        camera,
        globalEdits: Array.from(globalEdits),
      });
    }

    const visibleMeshes: SplatMesh[] = [];
    scene.traverseVisible((node) => {
      // Mesh opacity is the final multiplier after SDF opacity edits, so zero
      // remains fully transparent even when an SDF sets or adds opacity.
      if (
        node instanceof SplatMesh &&
        (layerMask & node.layers.mask) !== 0 &&
        node.opacity > 0
      ) {
        visibleMeshes.push(node);
      }
    });
    const { maxSplats, mapping: ranges } = this.generateMapping(
      visibleMeshes.map((mesh) => mesh.numSplats),
      usesNativeWebGPU(renderer),
    );

    // Native WebGPU rebuilds the mapping every frame. Reuse this accumulator's
    // pose snapshots; its previous mapping is only compared by version below.
    const poses = this.mapping.map(({ matrixWorld }) => matrixWorld);
    this.mapping = [];
    this.numSplats = 0;
    ranges.forEach(({ base, count }, index) => {
      const node = visibleMeshes[index];
      if (!node.splats || count <= 0) return;
      this.mapping.push({
        node,
        matrixWorld: (poses.pop() ?? new THREE.Matrix4()).copy(
          node.matrixWorld,
        ),
        source: node.splats,
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
    const shViewChanged =
      !this.viewOrigin.equals(previousOrigin) &&
      this.mapping.some(
        ({ node, source }) => node.maxSh > 0 && (source?.getNumSh() ?? 0) > 0,
      );
    this.version = previousVersion + (splatsUpdated || shViewChanged ? 1 : 0);
    this.mappingVersion = previousMappingVersion + (mappingUpdated ? 1 : 0);

    return {
      version: this.version,
      sortUpdated,
      requiredMaxSplats: getTextureSize(
        Math.max(1, maxSplats),
        usesNativeWebGPU(renderer) ? 256 : 1,
      ).maxSplats,
      generate: (shrinkResources = false, stochasticSeeds = false) => {
        this.ensureGenerate({
          maxSplats,
          renderer,
          shrinkResources,
          stochasticSeeds,
        });
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
