import { getRenderFrame, getViews } from "../rendererUtils.js";
import { LightData } from "./LightData.js";
import { SceneLights } from "./SceneLights.js";
import { createNodeLitShading } from "./tsl/shading.js";
import { createWebGLLitShading } from "./webgl/shading.js";
import { SurfaceCache } from "./webgpu/SurfaceCache.js";

/**
 * Lighting of one GaussianSplatRenderer, and the renderer's one entry into
 * this folder.
 *
 * - `SceneLights` writes view-space records into shared `LightData` storage.
 * - `tsl/` and `webgl/` hold the shading a backend builds its shaded
 *   materials with: a Splat's estimated surface, and the lights evaluated on
 *   it.
 * - `webgpu/` hands the surface from native compute kernels to the draw.
 *
 * The backend selects materials and kernels by `shading`; Three compiles each
 * draw variant. Projection and sorting never depend on lights.
 */
export class SplatLighting {
  /** For a backend with compute kernels: what shaded ones cache of a Splat. */
  static createSurfaces(cache) {
    return new SurfaceCache(cache);
  }

  constructor(owner, backend) {
    this.owner = owner;
    this.renderer = backend.renderer;
    // WebGLRenderer shades in GLSL and prepares each draw, including each
    // WebXR eye, separately.
    this.classic = backend.kind === "webgl";
    this.lights = new SceneLights();
    this.data = new LightData(this.lights, this.renderer);
    this.lit = this.classic
      ? createWebGLLitShading(this.data)
      : createNodeLitShading(this.data, owner.uniforms);
    // Scene root and render call of the listed lights.
    this.root = null;
    this.frame = -1;
    this.enabled = false;
  }

  /** What the backend selects shaded materials by; null draws unlit. */
  get shading() {
    return this.enabled ? this.lit : null;
  }

  /** Collects the lights before the draw's uniforms update. */
  prepareDraw(scene, camera) {
    if (this.enabled) this.update(scene, camera, false);
  }

  /** Reduces light storage to the lights the camera sees, lit or not. */
  shrinkResources(scene, camera) {
    this.update(scene, camera, true);
  }

  update(scene, camera, shrink) {
    // WebGPURenderer may name an internal scene when rendering an Object3D.
    let root = this.owner;
    while (root !== scene && root.parent) root = root.parent;
    // One walk of the scene graph serves every draw of a render call, such
    // as both WebXR eyes on classic WebGL.
    const frame = getRenderFrame(this.renderer);
    if (shrink || frame !== this.frame || root !== this.root) {
      this.frame = frame;
      this.root = root;
      this.lights.collect(root);
    }
    this.lights.select(camera, shrink);
    this.data.update(this.classic ? [camera] : getViews(camera), shrink);
  }

  dispose() {
    this.data.dispose();
  }
}
