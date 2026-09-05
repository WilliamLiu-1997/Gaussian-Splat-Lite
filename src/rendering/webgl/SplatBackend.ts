import * as THREE from "three";
import type {
  CPUOrderingUpdate,
  SplatMaterial,
  SplatMaterialOptions,
} from "../backend";
import { isXRRenderTarget } from "../rendererUtils";
import {
  ORDERING_TEXTURE_WIDTH,
  SPLATS_PER_ORDERING_ROW,
  type Uniforms,
  emptyOrdering,
} from "../uniforms";
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
  private orderingTexture: THREE.DataTexture | null = null;

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
    return (
      Math.max(1, Math.ceil(count / SPLATS_PER_ORDERING_ROW)) *
      SPLATS_PER_ORDERING_ROW
    );
  }

  get cpuOrdering(): Uint32Array | null {
    return (this.orderingTexture?.image.data as Uint32Array | null) ?? null;
  }

  setCPUOrdering({
    ordering,
    activeSplats,
    requiredCapacity,
    shrink,
  }: CPUOrderingUpdate) {
    const rows = requiredCapacity / SPLATS_PER_ORDERING_ROW;
    const activeRows = Math.ceil(activeSplats / SPLATS_PER_ORDERING_ROW);
    if (
      this.orderingTexture &&
      (rows > this.orderingTexture.image.height ||
        (shrink && rows !== this.orderingTexture.image.height))
    ) {
      this.orderingTexture.dispose();
      this.orderingTexture = null;
    }
    if (!this.orderingTexture) {
      this.orderingTexture = new THREE.DataTexture(
        ordering,
        ORDERING_TEXTURE_WIDTH,
        rows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      this.orderingTexture.needsUpdate = true;
    } else {
      this.orderingTexture.image.data = ordering;
      if (!this.renderer.properties.has(this.orderingTexture)) {
        this.orderingTexture.needsUpdate = true;
      } else if (activeRows > 0) {
        uploadU32DataTextureRows(
          this.renderer,
          this.orderingTexture,
          ORDERING_TEXTURE_WIDTH,
          activeRows,
          ordering,
        );
      }
    }
  }

  bindOrdering(_material: SplatMaterial, uniforms: Uniforms) {
    uniforms.ordering.value = this.orderingTexture ?? emptyOrdering;
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
    this.orderingTexture?.dispose();
    this.orderingTexture = null;
  }
}
