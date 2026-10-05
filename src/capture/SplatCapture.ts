import * as THREE from "three";
import { CubeRenderTarget, PMREMGenerator } from "three/webgpu";
import { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer";
import {
  isWebGPURenderer,
  setRendererRenderTarget,
  usesNativeWebGPU,
} from "../rendering/rendererUtils";
import { WebGLCapture } from "./WebGLCapture";
import { WebGPUCapture } from "./WebGPUCapture";
import { downsamplePixels, readPixels } from "./pixels";
import { withCaptureState } from "./rendererState";
import { captureSceneView } from "./sceneView";

export type SplatCaptureTargetOptions = {
  width: number;
  height: number;
  doubleBuffer?: boolean;
  superXY?: number;
} & Omit<THREE.RenderTargetOptions, "stencilBuffer">;

export interface SplatCaptureOptions {
  splatRenderer: GaussianSplatRenderer;
  target?: SplatCaptureTargetOptions;
}

export interface SplatCaptureCubeOptions {
  scene: THREE.Scene;
  worldCenter: THREE.Vector3;
  size?: number;
  near?: number;
  far?: number;
  hideObjects?: THREE.Object3D[];
  filter?: boolean;
}

export type SplatCaptureEnvOptions = Omit<SplatCaptureCubeOptions, "filter">;

type SceneView = { scene: THREE.Scene; camera: THREE.Camera };

type CubeRender = {
  target: THREE.WebGLCubeRenderTarget | CubeRenderTarget;
  camera: THREE.CubeCamera;
  near: number;
  far: number;
};

/** Optional offscreen capture and environment maps, independent of core rendering. */
export class SplatCapture {
  readonly splatRenderer: GaussianSplatRenderer;
  readonly superXY: number;
  target?: THREE.RenderTarget;
  backTarget?: THREE.RenderTarget;
  superPixels?: Uint8Array;
  targetPixels?: Uint8Array;

  private disposed = false;
  private readonly captureRenderer: GaussianSplatRenderer;
  private readonly capturePass: WebGLCapture | WebGPUCapture;
  // Captures share one Splat renderer and its sort, so they run one at a time.
  private pending: Promise<unknown> = Promise.resolve();
  // Keyed by `filter`: an environment capture keeps an earlier cube texture valid.
  private readonly cubeRenders = new Map<boolean, CubeRender>();
  private lastCube: CubeRender | null = null;
  private pmrem: THREE.PMREMGenerator | PMREMGenerator | null = null;

  constructor({ splatRenderer, target }: SplatCaptureOptions) {
    this.splatRenderer = splatRenderer;
    this.capturePass = isWebGPURenderer(this.renderer)
      ? new WebGPUCapture(this.renderer)
      : new WebGLCapture(this.renderer);
    this.superXY = target?.superXY ?? 1;
    if (
      !Number.isInteger(this.superXY) ||
      this.superXY < 1 ||
      this.superXY > 4
    ) {
      throw new Error("Splat capture superXY must be an integer from 1 to 4");
    }
    if (target) this.initializeTarget(target);
    this.captureRenderer = new GaussianSplatRenderer({
      renderer: this.renderer,
      timer: splatRenderer.timer,
      autoUpdate: false,
      stochastic: false,
    });
    // The display renderer already runs each model's onFrame.
    this.captureRenderer.frameCallbacks = false;
  }

  private initializeTarget(target: SplatCaptureTargetOptions) {
    const {
      width,
      height,
      doubleBuffer,
      superXY: _superXY,
      ...options
    } = target;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * this.superXY > 8192 ||
      height * this.superXY > 8192
    ) {
      throw new Error(
        "Splat capture dimensions must be positive integers up to 8192 / superXY",
      );
    }
    const targetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      ...options,
      // Three.js attaches stencil only together with depth.
      stencilBuffer: options.depthBuffer !== false && this.stencilBuffer,
    };
    const superWidth = width * this.superXY;
    const superHeight = height * this.superXY;
    this.target = isWebGPURenderer(this.renderer)
      ? new THREE.RenderTarget(superWidth, superHeight, targetOptions)
      : new THREE.WebGLRenderTarget(superWidth, superHeight, targetOptions);
    if (doubleBuffer) {
      this.backTarget = this.target.clone();
    }
  }

  get renderer() {
    return this.splatRenderer.renderer;
  }

  private get stencilBuffer() {
    const { renderer } = this;
    // The attributes are null while the WebGL context is lost.
    return isWebGPURenderer(renderer)
      ? renderer.stencil
      : renderer.getContextAttributes()?.stencil === true;
  }

  private assertActive() {
    if (this.disposed) throw new Error("Splat capture is disposed");
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task);
    this.pending = result.catch(() => {});
    return result;
  }

  private async renderCapture(
    { scene, camera }: SceneView,
    draw: () => void,
    radial = false,
    hideObjects: THREE.Object3D[] = [],
  ) {
    this.assertActive();
    const { splatRenderer: source, captureRenderer } = this;

    Object.assign(captureRenderer, {
      maxStdDev: source.maxStdDev,
      minPixelRadius: source.minPixelRadius,
      minAlpha: source.minAlpha,
      preBlurAmount: source.preBlurAmount,
      blurAmount: source.blurAmount,
      clipXY: source.clipXY,
      focalAdjustment: source.focalAdjustment,
      fastSort: source.fastSort,
      premultipliedAlpha: source.premultipliedAlpha,
      transparent: source.transparent,
      depthTest: source.depthTest,
      depthWrite: source.depthWrite,
      encodeLinear: source.encodeLinear,
      sortRadial: radial || source.sortRadial,
    });
    // Stencil masking is set on the Splat material, not on the renderer.
    const sourceMaterial = source.material;
    const captureMaterial = captureRenderer.material;
    captureMaterial.stencilWrite = sourceMaterial.stencilWrite;
    captureMaterial.stencilWriteMask = sourceMaterial.stencilWriteMask;
    captureMaterial.stencilFunc = sourceMaterial.stencilFunc;
    captureMaterial.stencilRef = sourceMaterial.stencilRef;
    captureMaterial.stencilFuncMask = sourceMaterial.stencilFuncMask;
    captureMaterial.stencilFail = sourceMaterial.stencilFail;
    captureMaterial.stencilZFail = sourceMaterial.stencilZFail;
    captureMaterial.stencilZPass = sourceMaterial.stencilZPass;
    captureRenderer.layers.mask = camera.layers.mask;
    const view = { scene: captureSceneView(scene, hideObjects), camera };
    // Models and their edits are shared with the display, so every capture
    // checks them. Version checks reuse generated data and ordering while valid.
    await captureRenderer.update(view);
    // The display can update shared models while a WebGL sort is pending.
    // Appearance changes refresh the data without repeating that sort.
    if (
      captureRenderer.display.mapping.some(
        ({ node, version }) => node.version !== version,
      )
    ) {
      await captureRenderer.update(view);
    }
    this.assertActive();

    // Suppress only other Splat draws, preserving their children's visibility.
    const layers = new Map<THREE.Layers, number>();
    scene.traverse((object) => {
      if (object instanceof GaussianSplatRenderer) {
        layers.set(object.layers, object.layers.mask);
      }
    });
    const visibility = new Map(
      hideObjects.map((object) => [object, object.visible]),
    );
    try {
      for (const layer of layers.keys()) layer.mask = 0;
      for (const object of visibility.keys()) object.visible = false;
      scene.add(captureRenderer);
      withCaptureState(this.renderer, draw);
    } finally {
      scene.remove(captureRenderer);
      for (const [layer, mask] of layers) layer.mask = mask;
      for (const [object, visible] of visibility) object.visible = visible;
    }
  }

  /** Snapshots the camera now; the capture may wait for earlier ones. */
  private targetCapture({ scene, camera }: SceneView) {
    this.assertActive();
    camera.updateWorldMatrix(true, false);
    const Camera = camera.constructor as new () => THREE.Camera;
    const captureCamera = new Camera().copy(camera, false);
    captureCamera.matrixAutoUpdate = false;
    captureCamera.matrix.copy(camera.matrixWorld);
    return async () => {
      this.assertActive();
      const target = this.backTarget ?? this.target;
      if (!target)
        throw new Error("Initialize SplatCapture with target options");
      const stencilBuffer = target.depthBuffer && this.stencilBuffer;
      if (target.stencilBuffer !== stencilBuffer) {
        target.dispose();
        target.stencilBuffer = stencilBuffer;
      }
      await this.renderCapture({ scene, camera: captureCamera }, () => {
        setRendererRenderTarget(this.renderer, target);
        this.capturePass.render(scene, captureCamera);
      });
      if (target !== this.target) {
        [this.target, this.backTarget] = [this.backTarget, this.target];
      }
      return target;
    };
  }

  async renderTarget(view: SceneView): Promise<THREE.RenderTarget> {
    return this.enqueue(this.targetCapture(view));
  }

  /** Reuses the returned buffer; copy it if a later read must not overwrite it. */
  async readTarget(): Promise<Uint8Array> {
    this.assertActive();
    const target = this.target;
    if (!target) throw new Error("Initialize SplatCapture with target options");
    const { width, height } = target;
    if (width % this.superXY !== 0 || height % this.superXY !== 0) {
      throw new Error(
        "Splat capture target dimensions must be divisible by superXY",
      );
    }
    const byteSize = width * height * 4;
    if (this.superPixels?.length !== byteSize) {
      this.superPixels = new Uint8Array(byteSize);
    }
    const pixels = this.superPixels;
    await readPixels(this.renderer, target, pixels);
    this.assertActive();
    if (this.superXY === 1) return pixels;

    const subSize = byteSize / (this.superXY * this.superXY);
    if (this.targetPixels?.length !== subSize) {
      this.targetPixels = new Uint8Array(subSize);
    }
    downsamplePixels(pixels, width, height, this.superXY, this.targetPixels);
    return this.targetPixels;
  }

  async renderReadTarget(view: SceneView): Promise<Uint8Array> {
    const capture = this.targetCapture(view);
    // Read in the same turn, before a queued capture can redraw the target.
    return this.enqueue(async () => {
      await capture();
      return this.readTarget();
    });
  }

  private renderCube(scene: THREE.Scene, camera: THREE.CubeCamera) {
    const { renderer } = this;
    camera.updateMatrixWorld();
    if (camera.coordinateSystem !== renderer.coordinateSystem) {
      camera.coordinateSystem = renderer.coordinateSystem;
      camera.updateCoordinateSystem();
    }
    const target = camera.renderTarget;
    const generateMipmaps = target.texture.generateMipmaps;
    target.texture.generateMipmaps = false;
    try {
      for (let face = 0; face < 6; face++) {
        // Generate cube mipmaps only after all six resolved faces are ready.
        if (face === 5) target.texture.generateMipmaps = generateMipmaps;
        setRendererRenderTarget(
          renderer,
          target,
          face,
          camera.activeMipmapLevel,
        );
        this.capturePass.render(scene, camera.children[face] as THREE.Camera);
      }
      target.texture.needsPMREMUpdate = true;
    } finally {
      target.texture.generateMipmaps = generateMipmaps;
    }
  }

  /** Validates and snapshots the center now; the capture may wait for earlier ones. */
  private cubeCapture({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1000,
    hideObjects = [],
    filter = false,
  }: SplatCaptureCubeOptions) {
    this.assertActive();
    if (!Number.isInteger(size) || size < 1 || size > 8192) {
      throw new Error(
        "Splat capture cube size must be a positive integer up to 8192",
      );
    }
    if (!(near > 0 && far > near && Number.isFinite(far))) {
      throw new Error("Splat capture cube requires 0 < near < far < Infinity");
    }
    const center = worldCenter.clone();
    return async () => {
      this.assertActive();
      const stencilBuffer = this.stencilBuffer;
      let cubeRender = this.cubeRenders.get(filter);
      if (
        !cubeRender ||
        cubeRender.target.width !== size ||
        cubeRender.target.stencilBuffer !== stencilBuffer ||
        cubeRender.near !== near ||
        cubeRender.far !== far
      ) {
        cubeRender?.target.dispose();
        if (this.lastCube === cubeRender) this.lastCube = null;
        const Target = isWebGPURenderer(this.renderer)
          ? CubeRenderTarget
          : THREE.WebGLCubeRenderTarget;
        const target = new Target(size, {
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          stencilBuffer,
          generateMipmaps: filter,
          minFilter: filter
            ? THREE.LinearMipmapLinearFilter
            : THREE.LinearFilter,
          colorSpace: filter
            ? THREE.LinearSRGBColorSpace
            : THREE.SRGBColorSpace,
        });
        const camera = new THREE.CubeCamera(near, far, target);
        cubeRender = { target, camera, near, far };
        this.cubeRenders.set(filter, cubeRender);
      }

      const { target, camera } = cubeRender;
      camera.position.copy(center);
      const updateCamera = new THREE.PerspectiveCamera(90, 1, near, far);
      updateCamera.position.copy(center);
      await this.renderCapture(
        { scene, camera: updateCamera },
        () => this.renderCube(scene, camera),
        true,
        hideObjects,
      );
      this.lastCube = cubeRender;
      return target.texture;
    };
  }

  async renderCubeMap(
    options: SplatCaptureCubeOptions,
  ): Promise<THREE.CubeTexture> {
    return this.enqueue(this.cubeCapture(options));
  }

  /** Faces of the latest cube capture, in the WebGL layout on every backend. */
  async readCubeTargets(): Promise<Uint8Array[]> {
    // Queued with captures: the six reads span awaits.
    return this.enqueue(async () => {
      this.assertActive();
      if (!this.lastCube)
        throw new Error("Render a cube map before reading its faces");
      const { target } = this.lastCube;
      const native = usesNativeWebGPU(this.renderer);
      const faces: Uint8Array[] = [];
      // Keep WebGL framebuffer readback sequential, including its async cleanup.
      for (let face = 0; face < 6; face++) {
        const pixels = new Uint8Array(target.width * target.height * 4);
        // Native WebGPU stores +X and -X swapped, and each face reads back
        // rotated 180 degrees from the WebGL layout.
        const source = native && face < 2 ? 1 - face : face;
        await readPixels(this.renderer, target, pixels, source);
        if (native) new Uint32Array(pixels.buffer).reverse();
        faces.push(pixels);
      }
      this.assertActive();
      return faces;
    });
  }

  /** The caller owns the result; texture.dispose() also releases its render target. */
  async renderEnvMap(options: SplatCaptureEnvOptions): Promise<THREE.Texture> {
    const capture = this.cubeCapture({ ...options, filter: true });
    // Filter in the same turn, before a queued capture can redraw the cube.
    return this.enqueue(async () => {
      const cube = await capture();
      this.assertActive();
      this.pmrem ??= isWebGPURenderer(this.renderer)
        ? new PMREMGenerator(this.renderer)
        : new THREE.PMREMGenerator(this.renderer);
      const pmrem = this.pmrem;
      const target = withCaptureState(this.renderer, () =>
        pmrem.fromCubemap(cube),
      );
      const disposeTarget = () => {
        target.texture.removeEventListener("dispose", disposeTarget);
        target.dispose();
      };
      target.texture.addEventListener("dispose", disposeTarget);
      return target.texture;
    });
  }

  recurseSetEnvMap(root: THREE.Object3D, envMap: THREE.Texture) {
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial) {
          // Shaders depend on the map's presence and mapping, not its contents.
          if (material.envMap?.mapping !== envMap.mapping) {
            material.needsUpdate = true;
          }
          material.envMap = envMap;
        }
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.captureRenderer.dispose();
    this.capturePass.dispose();
    this.target?.dispose();
    this.backTarget?.dispose();
    for (const { target } of this.cubeRenders.values()) target.dispose();
    this.pmrem?.dispose();
    this.target = undefined;
    this.backTarget = undefined;
    this.superPixels = undefined;
    this.targetPixels = undefined;
    this.cubeRenders.clear();
    this.lastCube = null;
    this.pmrem = null;
  }
}
