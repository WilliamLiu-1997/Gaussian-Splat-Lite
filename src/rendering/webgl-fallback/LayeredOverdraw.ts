import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  type LayeredBackend,
  LayeredOverdraw,
  type LayeredPass,
  planBatchRanges,
  useUnderBlending,
} from "../LayeredOverdraw";
import { SplatGeometry } from "../SplatGeometry";
import type { SplatMaterialOptions } from "../backend";
import {
  createLayerStopMaterial,
  createLayersNode,
} from "../tsl/LayeredMaterials";
import {
  type OrderingNode,
  createSplatNodeMaterial,
} from "../tsl/SplatMaterial";
import { uniformBinding } from "../tsl/shaderUtils";
import type { Uniforms } from "../uniforms";
import {
  blitDepth,
  copyDepthChecked,
  depthCopyKey,
  drawFramebufferDepth,
} from "../webgl/LayeredDepth";

// Three.js r186 WebGL-backend internals: the active render context and its
// occlusion query state. GL runs nested renders in call order, so the pass
// needs no split; only a query left open would count nested draws.
type RenderContextLike = {
  readonly width: number;
  readonly height: number;
  readonly depth: boolean;
  readonly renderTarget:
    | (THREE.RenderTarget & {
        isRenderTarget3D?: boolean;
        isPostProcessingRenderTarget?: boolean;
      })
    | null;
  readonly viewportValue: THREE.Vector4;
  readonly scissorValue: THREE.Vector4;
  readonly activeMipmapLevel: number;
};

type BackendLike = {
  isWebGLBackend?: boolean;
  gl?: WebGL2RenderingContext;
  extensions?: { has(name: string): boolean };
  get?(object: object): {
    lastOcclusionObject?: THREE.Object3D | null;
    occlusionQueryIndex?: number;
    textureGPU?: WebGLTexture;
  };
};

function currentFallbackPass(renderer: WebGPURenderer): LayeredPass | null {
  const context = (
    renderer as unknown as { _currentRenderContext?: RenderContextLike | null }
  )._currentRenderContext;
  const backend = renderer.backend as unknown as BackendLike;
  const { gl } = backend;
  if (
    !context ||
    !gl ||
    backend.isWebGLBackend !== true ||
    typeof backend.get !== "function" ||
    // XR output uses multiview or opaque framebuffers. Passes that render
    // eyes into their own targets remain supported.
    (renderer.xr.isPresenting && renderer.xr.enabled) ||
    context.activeMipmapLevel !== 0 ||
    context.renderTarget?.isRenderTarget3D === true ||
    // A per-pixel composite would blend across MSAA samples.
    (gl.getParameter(gl.SAMPLES) as number) > 0
  ) {
    return null;
  }
  const depth = context.depth ? drawFramebufferDepth(gl) : null;
  if (depth === undefined) return null;
  const target = context.renderTarget;
  const getData = backend.get.bind(backend);
  const source = gl.getParameter(
    gl.DRAW_FRAMEBUFFER_BINDING,
  ) as WebGLFramebuffer | null;
  return {
    width: context.width,
    height: context.height,
    viewport: context.viewportValue,
    scissor: context.scissorValue,
    depth,
    scaledViewports:
      target === null || target.isPostProcessingRenderTarget === true,
    open(depthTexture) {
      const data = getData(context);
      const occluder = data.lastOcclusionObject;
      if (occluder) {
        if (occluder.occlusionTest === true) {
          gl.endQuery(gl.ANY_SAMPLES_PASSED);
          data.occlusionQueryIndex = (data.occlusionQueryIndex ?? 0) + 1;
        }
        data.lastOcclusionObject = null;
      }
      if (!depthTexture || !depth) return true;
      const texture = getData(depthTexture).textureGPU;
      if (!texture) return false;
      return copyDepthChecked(gl, depthCopyKey(source, depth), () =>
        blitDepth(
          gl,
          source,
          texture,
          depth.format === THREE.DepthStencilFormat,
          context.width,
          context.height,
        ),
      );
    },
    close() {},
  };
}

/** WebGL fallback batches: CPU-sorted ranges read in reverse from the ordering texture. */
export function createFallbackLayers(
  renderer: WebGPURenderer,
  uniforms: Uniforms,
  options: SplatMaterialOptions,
  orderingNode: OrderingNode,
) {
  const extensions = (renderer.backend as unknown as BackendLike).extensions;
  // Float32 keeps the front-to-back tail that half floats round away.
  const colorType = extensions?.has("EXT_float_blend")
    ? THREE.FloatType
    : THREE.HalfFloatType;
  const layers = createLayersNode(colorType);
  const batchState: Uniforms = { first: { value: 0 }, count: { value: 0 } };
  const batchMaterial = createSplatNodeMaterial({
    uniforms,
    orderingNode,
    premultipliedAlpha: true,
    transparent: false,
    depthTest: true,
    depthWrite: false,
    sorted: true,
    batch: {
      first: uniformBinding(batchState, "first", "uint"),
      count: uniformBinding(batchState, "count", "uint"),
    },
  });
  useUnderBlending(batchMaterial);
  const geometry = new SplatGeometry();
  const batchMesh = new THREE.Mesh(geometry, batchMaterial);
  batchMesh.frustumCulled = false;
  batchMesh.matrixAutoUpdate = false;
  // The Splat renderer's own draw already passed the layer test.
  batchMesh.layers.enableAll();
  const stopMaterial = createLayerStopMaterial(renderer, layers);
  const supported = extensions?.has("EXT_color_buffer_float") === true;
  let ranges: [number, number][] = [];

  const backend: LayeredBackend = {
    colorType,
    batchMesh,
    stopMaterial,
    currentPass: () => (supported ? currentFallbackPass(renderer) : null),
    planBatches(_camera, count) {
      ranges = planBatchRanges(uniforms.splatCount.value as number, count);
      return ranges.flatMap(([, size], index) => (size > 0 ? [index] : []));
    },
    prepareBatch(index) {
      const [first, size] = ranges[index];
      batchState.first.value = first;
      batchState.count.value = size;
      geometry.setSplatCount(size);
    },
    bindLayers(texture) {
      layers.value = texture;
    },
  };
  const overdraw = new LayeredOverdraw(renderer, backend);
  // The uniform graph also serves sorted, stochastic and fallback frames.
  const material = createSplatNodeMaterial({
    uniforms,
    ...options,
    orderingNode,
    composite: {
      active: uniformBinding(uniforms, "layeredComposite", "bool"),
      layers,
    },
  });
  return {
    overdraw,
    material,
    dispose() {
      overdraw.dispose();
      material.dispose();
      batchMaterial.dispose();
      stopMaterial.dispose();
      geometry.dispose();
    },
  };
}
