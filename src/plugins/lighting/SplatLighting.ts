import type * as THREE from "three";
import type { GaussianSplatRenderer } from "../../rendering/GaussianSplatRenderer";
import type { SplatAccumulator } from "../../rendering/SplatAccumulator";
import type { SplatBackend, SplatMaterial } from "../../rendering/backend";
import { type GetLightFlags, LightFlagsTexture } from "./LightFlags";
import { SceneLights } from "./SceneLights";
import { SplatShadows } from "./SplatShadows";
import { onSceneRender } from "./sceneHook";
import { NodeLitMaterials } from "./tsl/LitMaterials";
import { WebGLLitMaterial } from "./webgl/LitMaterial";
import { SurfaceCache } from "./webgpu/SurfaceCache";

/**
 * Lighting and shadows of one GaussianSplatRenderer, kept apart from its
 * unlit drawing. Each render of the renderer's scene, this lists the scene's
 * lights, places them in each view's own space on the CPU and hands them to
 * a lit variant of the Splat material, which shades Splats itself. Three.js
 * provides the lights' public properties and the shadow maps it draws, into
 * which SplatShadows casts; nothing here reads Three.js's own lighting.
 */
export class SplatLighting {
  private readonly lights: SceneLights;
  private readonly shadows: SplatShadows;
  private readonly materials: WebGLLitMaterial | NodeLitMaterials;
  private readonly surfaces: SurfaceCache | null;
  // Light flags of the displayed accumulator, on the WebGL backends.
  private flags: LightFlagsTexture | null = null;
  private scene: THREE.Scene | null = null;
  private unwatch: (() => void) | null = null;
  private on: boolean;
  // A lit render begins its frame before its shadow maps: see startsFrame.
  private beginning = false;
  private begun = false;

  private readonly onAttachment = () => this.sync();

  constructor(
    private readonly owner: GaussianSplatRenderer,
    private readonly backend: SplatBackend,
    enabled: boolean,
    private readonly flagsOf: GetLightFlags,
  ) {
    const { uniforms } = owner;
    this.on = enabled;
    this.lights = new SceneLights(owner.renderer);
    this.shadows = new SplatShadows(owner, backend.kind !== "webgl", flagsOf);
    this.surfaces =
      backend.kind === "webgpu"
        ? new SurfaceCache(backend.projection.cache, flagsOf)
        : null;
    if (backend.kind === "webgpu")
      backend.setProjectionExtension(this.surfaces);
    if (backend.kind === "webgl") {
      this.materials = new WebGLLitMaterial(
        uniforms,
        backend.options,
        backend.renderer.capabilities.reversedDepthBuffer,
      );
      // Until a scene's render lists them, there are no lights.
      this.materials.setLayout(this.lights.layout());
    } else {
      this.materials = new NodeLitMaterials(
        backend,
        uniforms,
        this.lights,
        backend.kind === "webgl-fallback",
        () => this.skipDraw(),
      );
    }
    this.apply();
    owner.addEventListener("added", this.onAttachment);
    owner.addEventListener("removed", this.onAttachment);
  }

  get enabled() {
    return this.on;
  }

  set enabled(value: boolean) {
    this.on = value;
    this.apply();
    if (!value) {
      // Casters and blurred maps survive scene changes, including capture
      // reattachments; switching lighting off releases them. Compiled shaders
      // stay until dispose().
      this.shadows.clear();
      if (this.materials instanceof NodeLitMaterials) this.materials.release();
    }
    this.sync();
  }

  /** What the lighting switch sets beside the material. */
  private apply() {
    const { backend, owner } = this;
    if (this.surfaces) this.surfaces.enabled.value = this.on;
    // WebGPURenderer draws a light's shadow map for materials Three.js lights
    // on objects that receive shadows: see ShadowMapRequests. WebGLRenderer
    // draws them all, and its variance maps would draw a receiver.
    if (backend.kind !== "webgl") owner.receiveShadow = this.on;
  }

  /** The material lit draws use, or null while lighting is off. */
  selectMaterial(stochastic: boolean): SplatMaterial | null {
    return this.on ? this.materials.select(stochastic) : null;
  }

  /** Watch the owner's scene while lighting is enabled. */
  sync() {
    let scene: THREE.Scene | null = null;
    if (this.on) {
      let root: THREE.Object3D = this.owner;
      while (root.parent) root = root.parent;
      if ((root as THREE.Scene).isScene) scene = root as THREE.Scene;
    }
    if (scene === this.scene) return;
    this.unwatch?.();
    this.unwatch = null;
    this.begun = false;
    this.scene = scene;
    if (!scene) return;
    this.unwatch = onSceneRender(scene, {
      begin: (renderer, camera) => this.beginRender(scene, renderer, camera),
      end: (renderer) => this.endRender(scene, renderer),
    });
    // The scene's lights may have changed while nothing here watched them.
    if (this.materials instanceof NodeLitMaterials)
      this.materials.refresh(null);
  }

  /** A render of the scene begins; its shadow maps come next. */
  private beginRender(
    scene: THREE.Scene,
    renderer: unknown,
    camera: THREE.Camera,
  ) {
    const { owner } = this;
    this.sync();
    if (scene !== this.scene || renderer !== owner.renderer) return;
    // A render with every material overridden is somebody's auxiliary pass,
    // as WebGPURenderer's shadow passes are; the frame it belongs to goes on.
    if (scene.overrideMaterial !== null) {
      this.setOverridden(true);
      return;
    }
    this.begun = false;
    // Three.js draws the owner, and with it its casters, for these views only.
    let drawn = owner.layers.test(camera.layers);
    for (
      let node: THREE.Object3D | null = owner;
      drawn && node;
      node = node.parent
    )
      drawn = node.visible;
    // Render lists are built next: the shader must fit the lights by then.
    this.listLights(scene, camera);
    if (!drawn) {
      this.shadows.hide();
      return;
    }
    // Shadow maps read models directly, so this frame's update comes first.
    this.beginning = true;
    owner.onBeforeRender(owner.renderer, scene, camera);
    this.beginning = false;
    this.begun = true;
    this.shadows.update(scene, this.lights.castsShadows);
  }

  /** Lists the lights of a render of `root` and readies the shader for them. */
  private listLights(root: THREE.Object3D, camera: THREE.Camera) {
    const { materials, lights } = this;
    lights.collect(root, camera);
    if (materials instanceof NodeLitMaterials) materials.refresh(lights.shape);
    else materials.setLayout(lights.layout());
  }

  /**
   * What a render draws the owner as part of. Three.js names it to the
   * owner's draw, but WebGPURenderer names a scene of its own when it renders
   * anything but a Scene: the owner's whole tree stands in for that.
   */
  private renderedRoot(named: THREE.Object3D) {
    let top: THREE.Object3D = this.owner;
    while (top !== named && top.parent) top = top.parent;
    return top;
  }

  private endRender(scene: THREE.Scene, renderer: unknown) {
    if (scene !== this.scene || renderer !== this.owner.renderer) return;
    // The render an overridden one ran inside of, if any, goes on.
    if (scene.overrideMaterial !== null) this.setOverridden(false);
  }

  /**
   * WebGPURenderer draws shadow maps as renders of the scene with a material
   * overriding the scene's. In those, casters draw, and lit Splats ask for
   * no shadow map: asking from inside a shadow pass would draw one there.
   */
  private setOverridden(overridden: boolean) {
    if (this.backend.kind === "webgl") return;
    this.shadows.setOverridden(overridden);
    this.owner.receiveShadow = this.on && !overridden;
  }

  /**
   * Whether a draw starts a frame of the owner. A lit render's frame starts
   * as the render begins, ahead of the render counter the owner otherwise
   * goes by; the draws of that render then continue it.
   */
  startsFrame(counterChanged: boolean) {
    if (this.beginning) return true;
    if (!this.begun) return counterChanged;
    this.begun = false;
    return false;
  }

  /**
   * Loads what a lit draw by `camera` in a render of `root` reads; on
   * WebGLRenderer the camera is one eye. Call last in the owner's
   * preparation: a draw whose shader cannot show the lights draws nothing.
   */
  prepareDraw(
    root: THREE.Object3D,
    camera: THREE.Camera,
    display: SplatAccumulator,
  ) {
    if (!this.on) return;
    const { materials, lights } = this;
    // A render of something else than the scene this follows, such as a part
    // of it, has the lights of what it renders; it began without notice.
    if (root !== this.scene) this.listLights(this.renderedRoot(root), camera);
    let flags: THREE.Texture | null = null;
    if (this.backend.kind !== "webgpu") {
      this.flags ??= new LightFlagsTexture(this.flagsOf);
      flags = this.flags.update(display.mapping, display.numSplats);
    }
    if (materials instanceof NodeLitMaterials) {
      // Its shaders load the lights themselves, once Three.js has drawn the
      // shadow maps of the draw.
      if (flags) materials.setFlags(flags);
      return;
    }
    // WebGLRenderer has drawn the render's shadow maps; the shader follows
    // them within the draw.
    materials.setLayout(lights.layout());
    if (!materials.fill(lights, camera, flags as THREE.Texture))
      this.skipDraw();
  }

  /** The draw being prepared cannot show the lights; draw again later. */
  private skipDraw() {
    const { owner, materials } = this;
    owner.geometry.setIndirect(null);
    owner.geometry.instanceCount = 0;
    if (materials instanceof NodeLitMaterials) materials.refresh(null);
    owner.setDirty();
  }

  dispose() {
    this.owner.removeEventListener("added", this.onAttachment);
    this.owner.removeEventListener("removed", this.onAttachment);
    this.unwatch?.();
    this.unwatch = null;
    this.scene = null;
    this.shadows.dispose();
    this.flags?.dispose();
    this.flags = null;
    this.materials.dispose();
    if (this.backend.kind === "webgpu" && this.surfaces) {
      const pending = this.owner.isDisposed
        ? this.backend.projection.whenIdle()
        : this.backend.setProjectionExtension(null);
      const surfaces = this.surfaces;
      void pending.then(() => surfaces.dispose());
    }
    if (this.backend.kind !== "webgl") this.owner.receiveShadow = false;
  }
}
