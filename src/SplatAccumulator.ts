import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

import { SplatEdit, SplatEdits } from "./SplatEdit";
import { SplatMesh } from "./SplatMesh";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines";
import { getShaders } from "./shaders";
import splatGenerate from "./shaders/splatGenerate.glsl";
import { decomposeSplatTransform } from "./splatTransform";
import { IDENT_VERTEX_SHADER, getTextureSize, threeMrtArray } from "./utils";

export type SplatMapping = {
  node: SplatMesh;
  version: number;
  sortVersion: number;
  mappingVersion: number;
  base: number;
  count: number;
};

type GenerateUniforms = Record<string, THREE.IUniform>;

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
  packedSplats: boolean;

  private transformScale = new THREE.Vector3();
  private transformQuaternion = new THREE.Quaternion();

  constructor({ packedSplats = false }: { packedSplats?: boolean } = {}) {
    if (!threeMrtArray) {
      throw new Error("Gaussian Splat Lite requires THREE.js r179 or above");
    }
    this.packedSplats = packedSplats;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
  }

  getTextures(): THREE.DataArrayTexture[] {
    return this.target?.textures ?? SplatAccumulator.emptyTextures;
  }

  getSplatShapeTexture() {
    return (
      this.target?.textures[this.packedSplats ? 1 : 2] ??
      SplatAccumulator.emptySplatShape
    );
  }

  generateMapping(splatCounts: number[]) {
    let maxSplats = 0;
    const mapping = splatCounts.map((count) => {
      const base = maxSplats;
      maxSplats += Math.ceil(count / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      return { base, count };
    });
    return { maxSplats, mapping };
  }

  ensureGenerate({ maxSplats }: { maxSplats: number }) {
    if (this.target && Math.max(1, maxSplats) <= this.maxSplats) {
      return false;
    }
    this.dispose();

    const textureSize = getTextureSize(Math.max(1, maxSplats));
    const { width, height, depth } = textureSize;
    this.maxSplats = textureSize.maxSplats;
    this.target = new THREE.WebGLArrayRenderTarget(width, height, depth, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      format: THREE.RGBAIntegerFormat,
      type: THREE.UnsignedIntType,
    });
    this.target.scissorTest = true;

    const shape = this.target.texture.clone();
    shape.format = THREE.RedFormat;
    shape.type = THREE.UnsignedByteType;
    shape.internalFormat = "R8";
    if (!this.packedSplats) {
      const second = this.target.texture.clone();
      this.target.textures = [this.target.texture, second, shape];
    } else {
      this.target.textures = [this.target.texture, shape];
    }
    return true;
  }

  private getMaterial() {
    const key = this.packedSplats;
    let material = SplatAccumulator.materials.get(key);
    if (!material) {
      getShaders();
      const defines: Record<string, string> = {};
      if (this.packedSplats) defines.OUTPUT_PACKED = "1";
      material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: IDENT_VERTEX_SHADER,
        fragmentShader: splatGenerate,
        uniforms: makeGenerateUniforms(),
        defines,
        depthTest: false,
        depthWrite: false,
      });
      SplatAccumulator.materials.set(key, material);
    }
    return material;
  }

  private prepareMaterial(mesh: SplatMesh) {
    const source = mesh.splats;
    if (!source) {
      throw new Error("SplatMesh has no source");
    }
    const material = this.getMaterial();
    const uniforms = material.uniforms as GenerateUniforms;
    const [sourceSplats, sourceSplats2] = source.getSplatTextures();
    const sh = source.getShTextures();
    source.needsUpdate = false;

    uniforms.sourceSplats.value = sourceSplats;
    uniforms.sourceSplats2.value = sourceSplats2;
    uniforms.numSh.value = Math.min(mesh.maxSh, source.getNumSh());
    uniforms.sh1Texture.value = sh.sh1 ?? SplatAccumulator.emptyTexture;
    uniforms.sh2Texture.value = sh.sh2 ?? SplatAccumulator.emptyTexture;
    uniforms.sh3TextureA.value = sh.sh3a ?? SplatAccumulator.emptyTexture;
    uniforms.sh3TextureB.value = sh.sh3b ?? SplatAccumulator.emptyTexture;

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
    // transforms, but preserves ordinary scale/quaternion storage and 2DGS
    // zero axes.
    uniforms.objectScale.value.copy(this.transformScale);
    uniforms.objectQuaternion.value.copy(this.transformQuaternion);
    uniforms.recolor.value.set(
      mesh.recolor.r,
      mesh.recolor.g,
      mesh.recolor.b,
      mesh.opacity,
    );

    const edits = mesh.sdfEdits;
    uniforms.numSdfs.value = edits?.numSdfs ?? 0;
    uniforms.numEdits.value = edits?.numEdits ?? 0;
    uniforms.sdfTexture.value = edits?.sdfTexture ?? SplatEdits.emptyTexture;
    uniforms.editTexture.value = edits?.editTexture ?? SplatEdits.emptyTexture;

    SplatAccumulator.fullScreenQuad.material = material;
    return material;
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
    renderer: THREE.WebGLRenderer;
  }) {
    if (!this.target) throw new Error("Accumulator target is not initialized");
    if (base + count > this.maxSplats) {
      throw new Error("Splat generation range exceeds accumulator capacity");
    }

    const material = this.prepareMaterial(mesh);
    const uniforms = material.uniforms as GenerateUniforms;
    const renderState = this.saveRenderState(renderer);
    const nextBase =
      Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    uniforms.targetBase.value = base;
    uniforms.targetCount.value = count;

    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      uniforms.targetLayer.value = layer;
      const layerBase = layer * layerSize;
      const yStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const yEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH),
      );
      this.target.scissor.set(0, yStart, SPLAT_TEX_WIDTH, yEnd - yStart);
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      SplatAccumulator.fullScreenQuad.render(renderer);
      base += SPLAT_TEX_WIDTH * (yEnd - yStart);
    }
    this.resetRenderState(renderer, renderState);
  }

  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    previous,
  }: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    timer: THREE.Timer;
    camera: THREE.Camera;
    previous: SplatAccumulator;
  }) {
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
      if (node instanceof SplatMesh && camera.layers.test(node.layers)) {
        visibleMeshes.push(node);
      }
    });
    const { maxSplats, mapping: ranges } = this.generateMapping(
      visibleMeshes.map((mesh) => mesh.numSplats),
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
        mappingVersion: node.mappingVersion,
        base,
        count,
      });
      this.numSplats = Math.max(this.numSplats, base + count);
    });

    const { splatsUpdated, mappingUpdated, sortUpdated } =
      previous.checkVersions(this.mapping);
    this.version = previous.version + (splatsUpdated ? 1 : 0);
    this.mappingVersion = previous.mappingVersion + (mappingUpdated ? 1 : 0);

    return {
      version: this.version,
      sortUpdated,
      generate: () => {
        this.ensureGenerate({ maxSplats });
        for (const { node, base, count } of this.mapping) {
          this.generate({ mesh: node, base, count, renderer });
        }
      },
    };
  }

  checkVersions(other: SplatMapping[]) {
    if (this.mapping.length !== other.length) {
      return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
    }
    const mappingUpdated = this.mapping.some((item, index) => {
      const previous = other[index];
      return (
        item.node !== previous.node ||
        item.base !== previous.base ||
        item.count !== previous.count ||
        item.mappingVersion !== previous.mappingVersion
      );
    });
    if (mappingUpdated) {
      return { splatsUpdated: true, mappingUpdated: true, sortUpdated: true };
    }
    return {
      splatsUpdated: this.mapping.some(
        (item, index) => item.version !== other[index].version,
      ),
      mappingUpdated: false,
      sortUpdated: this.mapping.some(
        (item, index) => item.sortVersion !== other[index].sortVersion,
      ),
    };
  }

  private saveRenderState(renderer: THREE.WebGLRenderer) {
    return {
      target: renderer.getRenderTarget(),
      activeCubeFace: renderer.getActiveCubeFace(),
      activeMipmapLevel: renderer.getActiveMipmapLevel(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear,
    };
  }

  private resetRenderState(
    renderer: THREE.WebGLRenderer,
    state: ReturnType<SplatAccumulator["saveRenderState"]>,
  ) {
    renderer.setRenderTarget(
      state.target,
      state.activeCubeFace,
      state.activeMipmapLevel,
    );
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }

  static emptyTexture = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const texture = new THREE.DataArrayTexture(
      new Uint32Array(maxSplats * 4),
      width,
      height,
      depth,
    );
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptySplatShape = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const texture = new THREE.DataArrayTexture(
      new Uint8Array(maxSplats),
      width,
      height,
      depth,
    );
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.internalFormat = "R8";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyTextures = [
    SplatAccumulator.emptyTexture,
    SplatAccumulator.emptyTexture,
  ];
  private static materials = new Map<boolean, THREE.RawShaderMaterial>();
  private static fullScreenQuad = new FullScreenQuad(
    new THREE.RawShaderMaterial({ visible: false }),
  );
}

function makeGenerateUniforms(): GenerateUniforms {
  return {
    targetLayer: { value: 0 },
    targetBase: { value: 0 },
    targetCount: { value: 0 },
    sourceSplats: { value: SplatAccumulator.emptyTexture },
    sourceSplats2: { value: SplatAccumulator.emptyTexture },
    numSh: { value: 0 },
    sh1Texture: { value: SplatAccumulator.emptyTexture },
    sh2Texture: { value: SplatAccumulator.emptyTexture },
    sh3TextureA: { value: SplatAccumulator.emptyTexture },
    sh3TextureB: { value: SplatAccumulator.emptyTexture },
    objectBasis: { value: new THREE.Matrix3() },
    objectOffset: { value: new THREE.Vector3() },
    objectScale: { value: new THREE.Vector3(1, 1, 1) },
    objectQuaternion: { value: new THREE.Quaternion() },
    recolor: { value: new THREE.Vector4(1, 1, 1, 1) },
    numSdfs: { value: 0 },
    numEdits: { value: 0 },
    sdfTexture: { value: SplatEdits.emptyTexture },
    editTexture: { value: SplatEdits.emptyTexture },
  };
}
