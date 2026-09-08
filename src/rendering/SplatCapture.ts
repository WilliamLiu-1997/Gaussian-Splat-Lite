import * as THREE from "three";
import type {
  GaussianSplatRenderer,
  GaussianSplatRendererOptions,
} from "./GaussianSplatRenderer";
import type { SplatBackend } from "./backend";
import {
  type GaussianSplatCompatibleRenderer,
  setRendererRenderTarget,
} from "./rendererUtils";

// Public target fields stay on the renderer so existing callers retain ownership access.
type CaptureHost = Pick<
  GaussianSplatRenderer,
  | "target"
  | "backTarget"
  | "superPixels"
  | "targetPixels"
  | "superXY"
  | "renderer"
  | "update"
  | "renderTarget"
  | "readTarget"
  | "renderCubeMap"
>;

type CaptureScope = { activate(): void; restore(): void };

/** Offscreen targets, pixel readback, cube captures and environment-map filtering. */
export class SplatCapture {
  constructor(
    private readonly host: CaptureHost,
    private readonly backend: SplatBackend,
    private readonly beginCapture: () => CaptureScope,
  ) {}

  initialize(options: GaussianSplatRendererOptions["target"]) {
    if (options) {
      const {
        width,
        height,
        doubleBuffer,
        superXY: origSuperXY,
        ...origTargetOptions
      } = options;
      const superXY = Math.max(1, Math.min(4, origSuperXY ?? 1));
      if (width * superXY > 8192 || height * superXY > 8192) {
        throw new Error("Target size too large");
      }
      this.host.superXY = superXY;

      const superWidth = width * superXY;
      const superHeight = height * superXY;
      const targetOptions: THREE.RenderTargetOptions = {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.SRGBColorSpace,
        ...origTargetOptions,
      };

      this.host.target = new THREE.WebGLRenderTarget(
        superWidth,
        superHeight,
        targetOptions,
      );
      if (doubleBuffer) {
        this.host.backTarget = new THREE.WebGLRenderTarget(
          superWidth,
          superHeight,
          targetOptions,
        );
      }
    }
  }

  dispose() {
    if (this.host.target) {
      this.host.target.dispose();
      this.host.target = undefined;
    }
    if (this.host.backTarget) {
      this.host.backTarget.dispose();
      this.host.backTarget = undefined;
    }
  }

  renderTarget({
    scene,
    camera,
  }: { scene: THREE.Scene; camera: THREE.Camera }): THREE.WebGLRenderTarget {
    const target = this.host.backTarget ?? this.host.target;
    if (!target) {
      throw new Error("No target");
    }

    const previousTarget = this.host.renderer.getRenderTarget();
    const scope = this.beginCapture();
    try {
      this.host.renderer.setRenderTarget(target);
      scope.activate();
      this.host.renderer.render(scene, camera);
    } finally {
      scope.restore();
      setRendererRenderTarget(this.host.renderer, previousTarget);
    }

    if (target !== this.host.target) {
      // Swap back buffer and target
      [this.host.target, this.host.backTarget] = [
        this.host.backTarget,
        this.host.target,
      ];
    }
    return target;
  }

  // Read back the previously rendered target image as a Uint8Array of packed
  // RGBA values (in that order). Subsequent calls to this.host.readTarget()
  // will reuse the same buffers to minimize memory allocations.
  async readTarget(): Promise<Uint8Array> {
    if (!this.host.target) {
      throw new Error("Must initialize with target");
    }
    const { width, height } = this.host.target;
    const byteSize = width * height * 4;
    if (!this.host.superPixels || this.host.superPixels.length < byteSize) {
      this.host.superPixels = new Uint8Array(byteSize);
    }
    const superPixels = this.host.superPixels;

    await this.backend.readPixels(this.host.target, superPixels);

    const { superXY } = this.host;
    if (superXY === 1) {
      return superPixels;
    }

    const subWidth = width / superXY;
    const subHeight = height / superXY;
    const subSize = subWidth * subHeight * 4;
    if (!this.host.targetPixels || this.host.targetPixels.length < subSize) {
      this.host.targetPixels = new Uint8Array(subSize);
    }
    const targetPixels = this.host.targetPixels;

    const super2 = superXY * superXY;
    for (let y = 0; y < subHeight; y++) {
      const row = y * subWidth;
      for (let x = 0; x < subWidth; x++) {
        const superCol = x * superXY;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < superXY; sy++) {
          const superRow = (y * superXY + sy) * width;
          for (let sx = 0; sx < superXY; sx++) {
            const superIndex = (superRow + superCol + sx) * 4;
            r += superPixels[superIndex];
            g += superPixels[superIndex + 1];
            b += superPixels[superIndex + 2];
            a += superPixels[superIndex + 3];
          }
        }
        const pixelIndex = (row + x) * 4;
        targetPixels[pixelIndex] = r / super2;
        targetPixels[pixelIndex + 1] = g / super2;
        targetPixels[pixelIndex + 2] = b / super2;
        targetPixels[pixelIndex + 3] = a / super2;
      }
    }
    return targetPixels;
  }

  async renderReadTarget({
    scene,
    camera,
  }: {
    scene: THREE.Scene;
    camera: THREE.Camera;
  }): Promise<Uint8Array> {
    if (this.backend.kind === "webgpu") await this.backend.precompile;
    this.host.renderTarget({ scene, camera });
    return this.host.readTarget();
  }

  // Data and buffers used for environment map rendering
  private static cubeRender: {
    target: THREE.WebGLCubeRenderTarget;
    cubeCamera: THREE.CubeCamera;
    near: number;
    far: number;
  } | null = null;
  private static pmrem: {
    fromCubemap(texture: THREE.Texture): { texture: THREE.Texture };
    dispose(): void;
  } | null = null;
  private static pmremRenderer: GaussianSplatCompatibleRenderer | null = null;

  // Renders out the scene to a cube map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces.
  async renderCubeMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1000,
    hideObjects = [],
    update = true,
    filter = false,
  }: {
    scene: THREE.Scene;
    worldCenter: THREE.Vector3;
    size?: number;
    near?: number;
    far?: number;
    hideObjects: THREE.Object3D[];
    update: boolean;
    filter: boolean;
  }): Promise<THREE.CubeTexture> {
    if (
      !SplatCapture.cubeRender ||
      SplatCapture.cubeRender.target.width !== size ||
      SplatCapture.cubeRender.near !== near ||
      SplatCapture.cubeRender.far !== far
    ) {
      if (SplatCapture.cubeRender) {
        SplatCapture.cubeRender.target.dispose();
      }
      const target = new THREE.WebGLCubeRenderTarget(size, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: filter,
        minFilter: filter ? THREE.LinearMipMapLinearFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        colorSpace: filter ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace,
      });
      const cubeCamera = new THREE.CubeCamera(near, far, target);
      SplatCapture.cubeRender = { target, cubeCamera, near, far };
    }

    const { target, cubeCamera } = SplatCapture.cubeRender;
    cubeCamera.position.copy(worldCenter);

    // Save the visibility state of objects we want to hide before render
    const objectVisibility = new Map<THREE.Object3D, boolean>();
    for (const object of hideObjects) {
      if (!objectVisibility.has(object)) {
        objectVisibility.set(object, object.visible);
      }
      object.visible = false;
    }

    const scope = this.beginCapture();
    try {
      if (update) {
        const tempCamera = new THREE.Camera();
        tempCamera.position.copy(worldCenter);
        await this.host.update({ scene, camera: tempCamera });
      }

      scope.activate();
      // Update the CubeCamera, which performs 6 cube face renders
      cubeCamera.update(this.host.renderer as THREE.WebGLRenderer, scene);
      return target.texture;
    } finally {
      scope.restore();
      for (const [object, visible] of objectVisibility.entries()) {
        object.visible = visible;
      }
    }
  }

  async readCubeTargets(): Promise<Uint8Array[]> {
    if (!SplatCapture.cubeRender) {
      throw new Error("No cube render");
    }

    const { target } = SplatCapture.cubeRender;
    const { width, height } = target;
    const promises = [];
    const buffers = [];

    for (let i = 0; i < target.texture.images.length; ++i) {
      const byteSize = width * height * 4;
      const readback = new Uint8Array(byteSize);
      buffers.push(readback);
      const promise = this.backend.readPixels(target, readback, i);
      promises.push(promise);
    }

    await Promise.all(promises);
    return buffers;
  }

  // Renders out the scene to an environment map that can be used for
  // Image-based lighting or similar applications. First optionally updates Gsplats,
  // sorts them with respect to the provided worldCenter, renders 6 cube faces,
  // then pre-filters them using THREE.PMREMGenerator and returns a THREE.Texture
  // that can assigned directly to a THREE.MeshStandardMaterial.envMap property.
  async renderEnvMap({
    scene,
    worldCenter,
    size = 256,
    near = 0.1,
    far = 1000,
    hideObjects = [],
    update = true,
  }: {
    scene: THREE.Scene;
    worldCenter: THREE.Vector3;
    size?: number;
    near?: number;
    far?: number;
    hideObjects: THREE.Object3D[];
    update: boolean;
  }): Promise<THREE.Texture> {
    const cubeTexture = await this.host.renderCubeMap({
      scene,
      worldCenter,
      size,
      near,
      far,
      hideObjects,
      update,
      filter: true,
    });
    // Pre-filter the cube map using THREE.PMREMGenerator if requested
    if (SplatCapture.pmremRenderer !== this.host.renderer) {
      SplatCapture.pmrem?.dispose();
      SplatCapture.pmrem = this.backend.createPMREMGenerator();
      SplatCapture.pmremRenderer = this.host.renderer;
    }

    const pmrem = SplatCapture.pmrem;
    if (!pmrem) throw new Error("PMREM generator is not initialized");
    return pmrem.fromCubemap(cubeTexture).texture;
  }

  // Utility function to recursively set the envMap property for any
  // THREE.MeshStandardMaterial within the subtree of root.
  recurseSetEnvMap(root: THREE.Object3D, envMap: THREE.Texture) {
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        if (Array.isArray(node.material)) {
          for (const material of node.material) {
            if (material instanceof THREE.MeshStandardMaterial) {
              material.envMap = envMap;
            }
          }
        } else {
          if (node.material instanceof THREE.MeshStandardMaterial) {
            node.material.envMap = envMap;
          }
        }
      }
    });
  }
}
