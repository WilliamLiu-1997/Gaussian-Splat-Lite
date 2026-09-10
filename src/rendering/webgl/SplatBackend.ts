import * as THREE from "three";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { isXRRenderTarget } from "../rendererUtils";
import { type Uniforms, emptyOrdering } from "../uniforms";
import { OrderingTexture } from "./OrderingTexture";
import { getShaders } from "./shaders";
import { uploadU32DataTextureRows } from "./textureUtils";

export function configureWebGLSplatOutput(
  renderer: THREE.WebGLRenderer,
  target: THREE.RenderTarget | null,
  uniforms: Uniforms,
  markerUsers: number,
) {
  const xrTarget = isXRRenderTarget(target);
  // A compose target may carry the XR flag for output-space blending only.
  const xrOutput = xrTarget && renderer.xr.enabled;
  uniforms.stochasticResolve.value =
    markerUsers > 0 &&
    (!renderer.xr.isPresenting ||
      (!xrOutput &&
        (target?.texture.type === THREE.HalfFloatType ||
          target?.texture.type === THREE.FloatType)));
  const blendSpace =
    target === null
      ? renderer.outputColorSpace
      : xrTarget
        ? target.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
  uniforms.encodeLinear.value = blendSpace !== THREE.SRGBColorSpace;
}

function createMaterial(uniforms: Uniforms, options: SplatMaterialOptions) {
  const shaders = getShaders();
  const defines: Record<string, number> = {};
  if (
    options.vertexShader === undefined &&
    options.fragmentShader === undefined
  ) {
    defines.GSL_COLOR_IN_VERTEX = 1;
  }
  return new THREE.ShaderMaterial({
    ...options,
    defines,
    glslVersion: THREE.GLSL3,
    vertexShader: options.vertexShader ?? shaders.splatVertex,
    fragmentShader: options.fragmentShader ?? shaders.splatFragment,
    uniforms,
    side: THREE.FrontSide,
    allowOverride: false,
  });
}

/** WebGL materials, ordering-texture uploads, and framebuffer readback. */
export class WebGLSplatBackend {
  readonly kind = "webgl";
  readonly material: THREE.ShaderMaterial;
  private readonly ordering = new OrderingTexture();

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    uniforms: Uniforms,
    options: SplatMaterialOptions,
  ) {
    this.material = createMaterial(uniforms, options);
    const extension = renderer
      .getContext()
      .getExtension("WEBGL_provoking_vertex");
    extension?.provokingVertexWEBGL(extension.FIRST_VERTEX_CONVENTION_WEBGL);
  }

  createDepthMaterial(uniforms: Uniforms) {
    return createMaterial(uniforms, {
      premultipliedAlpha: false,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });
  }

  getOrderingCapacity(count: number) {
    return this.ordering.getCapacity(count);
  }

  get cpuOrdering(): Uint32Array | null {
    return this.ordering.data;
  }

  setCPUOrdering(update: CPUOrderingUpdate) {
    this.ordering.update(update, (texture, rows) => {
      uploadU32DataTextureRows(
        this.renderer,
        texture,
        texture.image.width,
        rows,
        update.ordering,
      );
    });
  }

  bindOrdering(_material: SplatMaterial, uniforms: Uniforms) {
    uniforms.ordering.value = this.ordering.texture ?? emptyOrdering;
  }

  async readPixels(
    target: THREE.WebGLRenderTarget,
    pixels: Uint8Array,
    face = 0,
  ) {
    await this.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      target.width,
      target.height,
      pixels,
      face,
    );
  }

  createPMREMGenerator() {
    return new THREE.PMREMGenerator(this.renderer);
  }

  dispose() {
    this.ordering.dispose();
  }
}
