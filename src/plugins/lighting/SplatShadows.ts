import * as THREE from "three";
import type { GaussianSplatRenderer } from "../../rendering/GaussianSplatRenderer";
import { SplatAccumulator } from "../../rendering/SplatAccumulator";
import { SplatGeometry } from "../../rendering/SplatGeometry";
import {
  isWebGPURenderer,
  usesNativeWebGPU,
} from "../../rendering/rendererUtils";
import { type Uniforms, makeGenerateUniforms } from "../../rendering/uniforms";
import { SplatMesh } from "../../scene/SplatMesh";
import type { GetLightFlags } from "./LightFlags";
import { createShadowMaterial } from "./ShadowMaterial";

/**
 * The material every caster of one renderer draws with, and its uniforms.
 * Each ShadowDraw fills them in just before its own draw, so models that
 * come and go, as stream batches do, compile nothing.
 */
class ShadowCaster {
  readonly uniforms: Uniforms;
  readonly material: THREE.Material;
  /**
   * What a caster is to a color render. WebGPURenderer keeps casters out of
   * those; WebGLRenderer lists them with their material, which a material
   * that draws nothing stands in for, sparing a second compile of the caster.
   */
  readonly colorMaterial: THREE.Material;

  constructor(owner: GaussianSplatRenderer, node: boolean) {
    // Quality settings and the noise atlas follow the owner's color draw.
    const shared = owner.uniforms;
    this.uniforms = {
      ...makeGenerateUniforms(),
      maxStdDev: shared.maxStdDev,
      minAlpha: shared.minAlpha,
      edgeFade: shared.edgeFade,
      preBlurAmount: shared.preBlurAmount,
      blurAmount: shared.blurAmount,
      clipXY: shared.clipXY,
      focalAdjustment: shared.focalAdjustment,
      stochasticNoise: shared.stochasticNoise,
      // Shadow maps keep Splats of every size: most cover a texel or less.
      minPixelRadius: { value: 0 },
      renderSize: { value: new THREE.Vector2() },
      renderToViewQuat: { value: new THREE.Quaternion() },
      renderToViewPos: { value: new THREE.Vector3() },
      renderToViewScale: { value: 1 },
      near: { value: 0.1 },
      far: { value: 1000 },
    };
    const { renderer } = owner;
    this.material = createShadowMaterial(
      this.uniforms,
      node,
      isWebGPURenderer(renderer) && renderer.logarithmicDepthBuffer,
      // Transmitted maps need opaque black for samples that pass coverage.
      // The WebGL2 fallback also keeps the color mask for later clears.
      node &&
        (!usesNativeWebGPU(renderer) ||
          (isWebGPURenderer(renderer) && renderer.shadowMap.transmitted)),
    );
    this.colorMaterial = node
      ? this.material
      : new THREE.MeshBasicMaterial({
          colorWrite: false,
          depthWrite: false,
          depthTest: false,
        });
    // WebGLRenderer takes the side to draw from the color material, and
    // would otherwise cull front faces in shadow maps.
    this.colorMaterial.shadowSide = THREE.DoubleSide;
    // Node shadow passes show it; see SplatShadows.setOverridden.
    if (node) this.material.visible = false;
  }

  dispose() {
    this.material.dispose();
    if (this.colorMaterial !== this.material) this.colorMaterial.dispose();
  }
}

const viewAxisTmp = new THREE.Vector3();

/** Casts one model's shadows. Three.js draws it only into shadow maps. */
class ShadowDraw extends THREE.Mesh<SplatGeometry, THREE.Material> {
  // Holds each shadow view's origin, as the main Splat draw's holds its camera's.
  private readonly accumulator = new SplatAccumulator();
  private readonly sourceUniforms = makeGenerateUniforms();
  private sourcePrepared = false;
  private readonly viewScale = new THREE.Vector3();

  constructor(
    readonly source: SplatMesh,
    private readonly owner: GaussianSplatRenderer,
    private readonly caster: ShadowCaster,
    private readonly flagsOf: GetLightFlags,
  ) {
    super(new SplatGeometry(), caster.colorMaterial);
    this.customDepthMaterial = caster.material;
    this.customDistanceMaterial = caster.material;
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    this.castShadow = true;
    this.frustumCulled = false;
    this.geometry.instanceCount = 0;
  }

  raycast() {}

  beginRender() {
    this.sourcePrepared = false;
  }

  private prepareSource(splats: NonNullable<SplatMesh["splats"]>) {
    const { source } = this;
    // Keep the color update's dirty flag, but prepare textures and transforms
    // only once for all lights and cube faces of this scene render.
    const sourceNeedsUpdate = splats.needsUpdate;
    this.accumulator.prepareUniforms(source, this.sourceUniforms);
    splats.needsUpdate = sourceNeedsUpdate;
    this.sourceUniforms.numSh.value = 0;
    this.sourceUniforms.targetCount.value = splats.getNumSplats();
  }

  onBeforeShadow(
    _renderer: unknown,
    _object: THREE.Object3D,
    _camera: THREE.Camera,
    shadowCamera: THREE.Camera,
  ) {
    const { owner, source } = this;
    const { uniforms } = this.caster;
    const splats = source.splats;
    if (
      (this.flagsOf(source) & 4) === 0 ||
      !splats?.isInitialized ||
      source.opacity <= 0
    ) {
      this.geometry.instanceCount = 0;
      return;
    }
    const origin = this.accumulator.viewOrigin.setFromMatrixPosition(
      shadowCamera.matrixWorld,
    );
    // An orthographic camera can sit far from what it sees, and centers that
    // far from the origin lose float32 precision across the view. The middle
    // of its depth range is near the casters wherever the light is.
    const { isOrthographicCamera, near, far } =
      shadowCamera as THREE.OrthographicCamera;
    if (isOrthographicCamera) {
      origin.addScaledVector(
        viewAxisTmp
          .setFromMatrixColumn(shadowCamera.matrixWorld, 2)
          .normalize(),
        -(near + far) / 2,
      );
    }
    this.matrixWorld.makeTranslation(origin);
    // Cached maps and non-shadowed lights never prepare a source. The first
    // shadow view prepares it for all following views of this scene render.
    if (!this.sourcePrepared) {
      this.prepareSource(splats);
      this.sourcePrepared = true;
    }
    this.modelViewMatrix.multiplyMatrices(
      shadowCamera.matrixWorldInverse,
      this.matrixWorld,
    );
    for (const name in this.sourceUniforms)
      uniforms[name].value = this.sourceUniforms[name].value;
    // Only the translation changes between shadow views. Subtract their
    // origins on the CPU before uploading the view-relative offset.
    uniforms.objectOffset.value.setFromMatrixPosition(source.matrixWorld);
    uniforms.objectOffset.value.sub(origin);
    const count = uniforms.targetCount.value;
    const view = shadowCamera as THREE.PerspectiveCamera;
    uniforms.near.value = view.near;
    uniforms.far.value = view.far;
    this.modelViewMatrix.decompose(
      uniforms.renderToViewPos.value,
      uniforms.renderToViewQuat.value,
      this.viewScale,
    );
    uniforms.renderToViewScale.value =
      (this.viewScale.x + this.viewScale.y + this.viewScale.z) / 3;
    const target = owner.renderer.getRenderTarget();
    if (target) {
      uniforms.renderSize.value.set(target.viewport.z, target.viewport.w);
    } else {
      owner.renderer.getDrawingBufferSize(uniforms.renderSize.value);
    }
    this.geometry.setSplatCount(count);
    // Each model, light and cube face draws the material with its own values.
    const { material } = this.caster;
    const { renderer } = owner;
    if (isWebGPURenderer(renderer)) {
      const colorWrite =
        !usesNativeWebGPU(renderer) || renderer.shadowMap.transmitted;
      if (material.colorWrite !== colorWrite) {
        material.colorWrite = colorWrite;
        material.needsUpdate = true;
      }
    }
    if (material instanceof THREE.ShaderMaterial)
      material.uniformsNeedUpdate = true;
  }

  onAfterShadow() {
    // Only onBeforeShadow enables drawing; every other pass keeps zero quads.
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.removeFromParent();
    super.dispose();
    this.geometry.dispose();
    this.accumulator.dispose();
  }
}

/**
 * The shadow casters of one lit GaussianSplatRenderer: a ShadowDraw for each
 * model of its scene that casts, kept as children of the renderer.
 */
export class SplatShadows {
  private readonly draws = new Map<SplatMesh, ShadowDraw>();
  private caster: ShadowCaster | null = null;

  constructor(
    private readonly owner: GaussianSplatRenderer,
    /** Whether the renderer is a WebGPURenderer, on either backend. */
    private readonly node: boolean,
    private readonly flagsOf: GetLightFlags,
  ) {}

  /**
   * WebGPURenderer draws shadow maps as renders of the scene, with a material
   * overriding the scene's. Casters join the render lists of such renders
   * only; outside a shadow pass they draw nothing there either.
   */
  setOverridden(overridden: boolean) {
    if (this.node && this.caster) this.caster.material.visible = overridden;
  }

  /**
   * A color render of the scene begins: its shadow maps come next, if
   * `casting` says it draws any. A render that draws none lists no caster
   * and makes none.
   */
  update(scene: THREE.Scene, casting: boolean) {
    const { owner } = this;
    if (!casting && this.draws.size === 0) return;
    const sources = new Set<SplatMesh>();
    scene.traverseVisible((node) => {
      if (
        node instanceof SplatMesh &&
        (this.flagsOf(node) & 4) !== 0 &&
        node.isInitialized
      )
        sources.add(node);
    });
    for (const [source, draw] of this.draws) {
      if (sources.has(source)) continue;
      draw.dispose();
      this.draws.delete(source);
    }
    for (const source of sources) {
      let draw = this.draws.get(source);
      if (!draw) {
        if (!casting) continue;
        this.caster ??= new ShadowCaster(owner, this.node);
        draw = new ShadowDraw(source, owner, this.caster, this.flagsOf);
        this.draws.set(source, draw);
        owner.add(draw);
      }
      // Three.js tests casters against the color camera's layers.
      draw.layers.mask = source.layers.mask;
      draw.visible = casting;
      draw.beginRender();
    }
  }

  /** Three.js does not draw the owner in this render, nor its casters. */
  hide() {
    for (const draw of this.draws.values()) draw.visible = false;
  }

  /**
   * Lighting is off: takes every caster out of the scene. Their material
   * stays compiled for when lighting returns.
   */
  clear() {
    for (const draw of this.draws.values()) draw.dispose();
    this.draws.clear();
  }

  dispose() {
    this.clear();
    this.caster?.dispose();
    this.caster = null;
  }
}
