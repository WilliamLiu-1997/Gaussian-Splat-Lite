import * as THREE from "three";
import { SPLAT_TEX_WIDTH } from "../data/defines.js";
import { emptySplatTexture, getTextureSize } from "../data/textureLayout.js";
import { SplatEdit, SplatEdits } from "../scene/SplatEdit.js";
import { SplatMesh } from "../scene/SplatMesh.js";
import { threeRevision } from "../utils/three.js";
import { decomposeSplatTransform } from "../utils/transforms.js";
import {
  getViews,
  isWebGPURenderer,
  usesNativeWebGPU,
} from "./rendererUtils.js";
import { WebGLFallbackAccumulatorGenerator } from "./webgl-fallback/AccumulatorGenerator.js";
import {
  createWebGLAccumulatorTarget,
  generateWebGLAccumulator,
  getWebGLGenerateUniforms,
  hasStochasticSeeds,
} from "./webgl/AccumulatorGenerator.js";
export class SplatAccumulator {
  constructor() {
    this.time = 0;
    this.deltaTime = 0;
    this.viewOrigin = new THREE.Vector3();
    this.previousOrigin = new THREE.Vector3();
    this.viewDirection = new THREE.Vector3();
    this.maxSplats = 0;
    this.numSplats = 0;
    this.target = null;
    this.mapping = [];
    this.version = -1;
    this.mappingVersion = -1;
    this.transformScale = new THREE.Vector3();
    this.transformQuaternion = new THREE.Quaternion();
    this.fallbackGenerator = null;
    // Reused by every prepareGenerate(), which runs each frame.
    this.sceneNodes = {
      layerMask: 0,
      excludedObjects: undefined,
      meshes: [],
      meshCount: 0,
      shownMeshes: [],
      shownCount: 0,
      edits: [],
      editCount: 0,
    };
    this.frameContext = {
      time: 0,
      deltaTime: 0,
      globalEdits: this.sceneNodes.edits,
    };
    if (threeRevision < 186) {
      throw new Error("Gaussian Splat Lite requires Three.js r186 or above");
    }
  }
  dispose() {
    this.disposeStorage();
    this.mapping = [];
    const nodes = this.sceneNodes;
    nodes.meshes.length = nodes.shownMeshes.length = nodes.edits.length = 0;
    nodes.meshCount = nodes.shownCount = nodes.editCount = 0;
    nodes.excludedObjects = undefined;
    this.numSplats = 0;
    this.version = -1;
    this.mappingVersion = -1;
  }
  disposeStorage() {
    this.target?.dispose();
    this.target = null;
    this.fallbackGenerator?.dispose();
    this.fallbackGenerator = null;
    this.maxSplats = 0;
  }
  getTextures() {
    const textures = this.target?.textures;
    return textures
      ? [textures[0], textures[1]]
      : SplatAccumulator.emptyTextures;
  }
  getStochasticSeeds() {
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
  refreshTransforms(renderer) {
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
  ensureGenerate({
    maxSplats,
    renderer,
    shrinkResources = false,
    stochasticSeeds = false,
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
    this.target = createWebGLAccumulatorTarget(
      width,
      height,
      depth,
      stochasticSeeds,
    );
    if (fallback)
      this.fallbackGenerator = new WebGLFallbackAccumulatorGenerator(
        stochasticSeeds,
      );
    return true;
  }
  prepareUniforms(mesh, uniforms, matrixWorld = mesh.matrixWorld) {
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
  generate({ mesh, base, count, renderer }) {
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
    frameCallbacks = true,
    excludedObjects,
  }) {
    // Preserve the previous metadata before replacing this accumulator's
    // mapping. Native WebGPU prepares this metadata in place, so reading these
    // values later would compare the new mapping with itself and suppress
    // required updates.
    const previousMapping = previous.mapping;
    const previousCount = previousMapping.length;
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
    let layerMask = 0;
    for (const view of getViews(layerCamera)) layerMask |= view.layers.mask;
    // One walk finds models and edits; capture exclusions apply only to models.
    const nodes = this.sceneNodes;
    nodes.layerMask = layerMask;
    nodes.excludedObjects = excludedObjects;
    nodes.meshCount = nodes.shownCount = nodes.editCount = 0;
    collectSceneNodes(scene, true, false, false, nodes);
    const { meshes, shownMeshes, edits } = nodes;
    const meshCount = nodes.meshCount;
    meshes.length = meshCount;
    edits.length = nodes.editCount;
    const frameContext = this.frameContext;
    frameContext.time = this.time;
    frameContext.deltaTime = this.deltaTime;
    let sceneMayChange = false;
    for (let index = 0; index < meshCount; index++) {
      const mesh = meshes[index];
      if (
        (frameCallbacks && mesh.onFrame != null) ||
        mesh.frameUpdate !== SplatMesh.prototype.frameUpdate
      )
        sceneMayChange = true;
      mesh.frameUpdate(frameContext, frameCallbacks);
    }
    // A frame callback, or a subclass's own frame update, may add, remove or
    // hide objects; only then walk the scene again.
    if (sceneMayChange) {
      nodes.shownCount = 0;
      collectShownMeshes(scene, nodes);
    }
    const shownCount = nodes.shownCount;
    shownMeshes.length = shownCount;
    const native = usesNativeWebGPU(renderer);
    // Native WebGPU prepares in place: `previous` is this accumulator, so read
    // each previous entry before writing the new one over it.
    const mapping = this.mapping;
    let maxSplats = 0;
    let mapped = 0;
    let splatsUpdated = false;
    let mappingUpdated = false;
    let sortUpdated = false;
    this.numSplats = 0;
    for (let index = 0; index < shownCount; index++) {
      const node = shownMeshes[index];
      // Mesh opacity is the final multiplier after SDF opacity edits, so zero
      // remains fully transparent even when an SDF sets or adds opacity.
      if (!node.splats || !(node.opacity > 0)) continue;
      const count = node.numSplats;
      const base = maxSplats;
      maxSplats += native
        ? count
        : Math.ceil(count / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      // Meshes without data reserve no range: native sorting reads every
      // index below numSplats.
      if (count <= 0) continue;
      const last = previousMapping[mapped];
      if (
        last === undefined ||
        last.node !== node ||
        last.base !== base ||
        last.count !== count ||
        last.mappingVersion !== node.mappingVersion
      ) {
        mappingUpdated = true;
      } else {
        if (last.version !== node.version) splatsUpdated = true;
        if (last.sortVersion !== node.sortVersion) sortUpdated = true;
      }
      // Reuse pose snapshots when native WebGPU rebuilds this mapping in place.
      mapping[mapped] ??= { matrixWorld: new THREE.Matrix4() };
      const entry = mapping[mapped];
      entry.node = node;
      entry.matrixWorld.copy(node.matrixWorld);
      entry.source = node.splats;
      entry.version = node.version;
      entry.sortVersion = node.sortVersion;
      entry.centerVersion = node.centerVersion;
      entry.mappingVersion = node.mappingVersion;
      entry.base = base;
      entry.count = count;
      mapped++;
      this.numSplats = base + count;
    }
    mapping.length = mapped;
    if (mapped !== previousCount) mappingUpdated = true;
    if (mappingUpdated) splatsUpdated = sortUpdated = true;
    const shViewChanged =
      !this.viewOrigin.equals(previousOrigin) && hasViewDependentColor(mapping);
    this.version = previousVersion + (splatsUpdated || shViewChanged ? 1 : 0);
    this.mappingVersion = previousMappingVersion + (mappingUpdated ? 1 : 0);
    return {
      version: this.version,
      sortUpdated,
      requiredMaxSplats: getTextureSize(
        Math.max(1, maxSplats),
        native ? 256 : 1,
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
  static emptyTexture = emptySplatTexture;
  static emptyTextures = [
    SplatAccumulator.emptyTexture,
    SplatAccumulator.emptyTexture,
  ];
}
/**
 * Collects, in scene order: Splat meshes on the layers, those of them whose
 * ancestors are all visible, and visible edits outside any Splat mesh.
 * Excluded subtrees still contribute global edits, matching display rendering.
 */
function collectSceneNodes(
  node,
  parentVisible,
  insideMesh,
  parentExcluded,
  nodes,
) {
  const visible = parentVisible && node.visible !== false;
  const excluded = parentExcluded || nodes.excludedObjects?.has(node) === true;
  const isMesh = node instanceof SplatMesh;
  if (isMesh) {
    if (!excluded && (nodes.layerMask & node.layers.mask) !== 0) {
      nodes.meshes[nodes.meshCount++] = node;
      if (visible) nodes.shownMeshes[nodes.shownCount++] = node;
    }
  } else if (visible && !insideMesh && node instanceof SplatEdit) {
    nodes.edits[nodes.editCount++] = node;
  }
  const children = node.children;
  for (let index = 0, length = children.length; index < length; index++) {
    collectSceneNodes(
      children[index],
      visible,
      insideMesh || isMesh,
      excluded,
      nodes,
    );
  }
}
function collectShownMeshes(node, nodes) {
  if (node.visible === false || nodes.excludedObjects?.has(node)) return;
  if (node instanceof SplatMesh && (nodes.layerMask & node.layers.mask) !== 0) {
    nodes.shownMeshes[nodes.shownCount++] = node;
  }
  const children = node.children;
  for (let index = 0, length = children.length; index < length; index++) {
    collectShownMeshes(children[index], nodes);
  }
}
function hasViewDependentColor(mapping) {
  for (const { node, source } of mapping) {
    if (node.maxSh > 0 && (source?.getNumSh() ?? 0) > 0) return true;
  }
  return false;
}
