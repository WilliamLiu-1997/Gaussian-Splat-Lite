import * as THREE from "three";
import { SPLATS_PER_INSTANCE } from "./SplatGeometry";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  setRendererRenderTarget,
} from "./rendererUtils";

/** Pixels at or below this transmittance reject farther batches. */
export const STOP_TRANSMITTANCE = 1 / 1024;
/** Largest front-to-back batch count for layered overdraw. */
export const MAX_LAYERED_BATCHES = 8;

export type DepthDescriptor = {
  format: THREE.DepthTexturePixelFormat;
  type: THREE.TextureDataType;
};

const UNSEEDED_DEPTH: DepthDescriptor = {
  format: THREE.DepthFormat,
  type: THREE.UnsignedIntType,
};
// Display and capture sizes alternate without reallocating.
const CACHED_TARGETS = 2;

/** The draw recording the Splats, which its backend can interrupt in order. */
export interface LayeredPass {
  readonly width: number;
  readonly height: number;
  readonly viewport: THREE.Vector4;
  readonly scissor: THREE.Vector4;
  /** Format for a private copy of the pass depth, or null without depth. */
  readonly depth: DepthDescriptor | null;
  /** Whether this target scales ArrayCamera viewports by the pixel ratio. */
  readonly scaledViewports: boolean;
  /**
   * Copies the pass depth into `depth` when given and lets nested renders run
   * between earlier and later draws of the pass. Returns false on failure,
   * leaving the pass untouched.
   */
  open(depth: THREE.DepthTexture | null): boolean;
  /** Continues the pass after nested renders. */
  close(): void;
}

/** Backend drawing of layer batches and stop masks. */
export interface LayeredBackend {
  readonly colorType: THREE.TextureDataType;
  readonly batchMesh: THREE.Mesh;
  readonly stopMaterial: THREE.Material;
  currentPass(camera: THREE.Camera): LayeredPass | null;
  /** Batches to draw front to back, or null when none can be drawn. */
  planBatches(camera: THREE.Camera, batches: number): number[] | null;
  prepareBatch(batch: number): void;
  /** Sets the layers that stop masks and composites read. */
  bindLayers(texture: THREE.Texture): void;
}

type LayerTargets = {
  key: string;
  layers: THREE.WebGLRenderTarget;
  stops: THREE.WebGLRenderTarget;
  ready: boolean;
};

/**
 * Front-to-back first ranks for `batches` batches of `total` sorted Splats.
 * Sizes double toward the back, so stop masks cover the nearest Splats
 * sooner; boundaries stay on whole quad groups.
 */
export function planBatchRanges(total: number, batches: number) {
  const ranges: [first: number, count: number][] = [];
  let first = 0;
  for (let batch = 0; batch < batches; batch++) {
    let end = total;
    if (batch + 1 < batches) {
      end = Math.floor(total / 2 ** (batches - 1 - batch));
      end -= end % SPLATS_PER_INSTANCE;
    }
    ranges.push([first, end - first]);
    first = end;
  }
  return ranges;
}

/** Under blending: color += transmittance * premultiplied color, alpha *= 1 - alpha. */
export function useUnderBlending(material: THREE.Material) {
  Object.assign(material, {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

export function fullscreenTriangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  return geometry;
}

/**
 * Front-to-back sorted drawing. At the Splat's draw, the backend interrupts
 * the active pass: batches accumulate premultiplied color and remaining
 * transmittance in a private target seeded with the pass depth, and a stop
 * pass between batches moves opaque pixels to the nearest depth so hardware
 * depth testing rejects farther Splats there. The Splat's own draw then
 * composites the layers, keeping its place in the scene's draw order.
 */
export class LayeredOverdraw {
  private readonly targets: LayerTargets[] = [];
  private readonly stopMesh: THREE.Mesh;
  private readonly fullscreenCamera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0,
    1,
  );
  private readonly clearColor = new THREE.Color();

  constructor(
    private readonly renderer: GaussianSplatCompatibleRenderer,
    private readonly backend: LayeredBackend,
  ) {
    this.stopMesh = new THREE.Mesh(fullscreenTriangle(), backend.stopMaterial);
    this.stopMesh.frustumCulled = false;
    this.stopMesh.matrixAutoUpdate = false;
  }

  /**
   * Draws up to `batches` layers for the pass drawing the Splats and returns
   * whether they are ready to composite. Returns false, leaving the pass as
   * is, when that pass cannot be interrupted.
   */
  render(camera: THREE.Camera, batches: number, depthTest: boolean) {
    const { renderer, backend } = this;
    const pass = backend.currentPass(camera);
    if (!pass) return false;
    const plan = backend.planBatches(camera, batches);
    if (!plan || plan.length === 0) return false;
    const seed = depthTest ? pass.depth : null;

    const target = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const { autoClear, autoClearColor, autoClearDepth, autoClearStencil } =
      renderer;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const mrt = isWebGPURenderer(renderer) ? renderer.getMRT() : null;
    // WebGLRenderer counts every render call as a frame.
    const info = isWebGPURenderer(renderer) ? null : renderer.info;
    const frame = info?.render.frame ?? 0;
    const autoReset = info?.autoReset ?? false;
    let open = false;
    try {
      if (info) info.autoReset = false;
      if (isWebGPURenderer(renderer)) renderer.setMRT(null);
      const targets = this.acquire(pass, seed ?? UNSEEDED_DEPTH);
      for (const layerTarget of [targets.layers, targets.stops]) {
        layerTarget.viewport.copy(pass.viewport);
        layerTarget.scissor.copy(pass.scissor);
      }
      open = pass.open(
        seed ? (targets.layers.depthTexture as THREE.DepthTexture) : null,
      );
      if (!open) return false;
      backend.bindLayers(targets.layers.texture);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClearStencil = false;
      for (let i = 0; i < plan.length; i++) {
        if (i > 0) {
          // Clearing the stop color avoids loading it; depth is shared.
          renderer.autoClear = true;
          renderer.autoClearColor = true;
          renderer.autoClearDepth = false;
          setRendererRenderTarget(renderer, targets.stops);
          renderer.render(this.stopMesh, this.fullscreenCamera);
        }
        // The first batch clears to zero RGB and full transmittance.
        renderer.autoClear = i === 0;
        renderer.autoClearColor = true;
        renderer.autoClearDepth = seed === null;
        backend.prepareBatch(plan[i]);
        setRendererRenderTarget(renderer, targets.layers);
        renderer.render(backend.batchMesh, camera);
      }
      return true;
    } finally {
      renderer.setClearColor(this.clearColor, clearAlpha);
      Object.assign(renderer, {
        autoClear,
        autoClearColor,
        autoClearDepth,
        autoClearStencil,
      });
      if (isWebGPURenderer(renderer)) renderer.setMRT(mrt);
      setRendererRenderTarget(
        renderer,
        target,
        activeCubeFace,
        activeMipmapLevel,
      );
      if (open) pass.close();
      if (info) {
        info.autoReset = autoReset;
        info.render.frame = frame;
      }
    }
  }

  private acquire(pass: LayeredPass, depth: DepthDescriptor) {
    const { renderer, targets } = this;
    const { width, height } = pass;
    const key = `${width}x${height}:${depth.format}:${depth.type}`;
    let index = targets.findIndex((entry) => entry.key === key);
    if (index < 0) {
      const texture = new THREE.DepthTexture(width, height, depth.type);
      texture.format = depth.format;
      texture.name = "GaussianSplatRenderer.layerDepth";
      const stencilBuffer = depth.format === THREE.DepthStencilFormat;
      // Stop masks sample the layers, so they draw into a minimal color
      // target sharing the layers' depth.
      const layers = new THREE.WebGLRenderTarget(width, height, {
        type: this.backend.colorType,
        depthTexture: texture,
        stencilBuffer,
      });
      const stops = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        depthTexture: texture,
        stencilBuffer,
      });
      layers.texture.name = "GaussianSplatRenderer.layers";
      stops.texture.name = "GaussianSplatRenderer.layerStops";
      targets.unshift({ key, layers, stops, ready: false });
      if (targets.length > CACHED_TARGETS) {
        const evicted = targets.pop() as LayerTargets;
        disposeTargets(evicted);
      }
      index = 0;
    } else if (index > 0) {
      targets.unshift(...targets.splice(index, 1));
    }
    const entry = targets[0];
    for (const layerTarget of [entry.layers, entry.stops]) {
      (
        layerTarget as THREE.WebGLRenderTarget & {
          isPostProcessingRenderTarget?: boolean;
        }
      ).isPostProcessingRenderTarget = pass.scaledViewports;
    }
    if (!entry.ready) {
      // Node renderers clear new depth attachments on first use unless they
      // were cleared explicitly, which would drop the seeded depth. The
      // layers own the shared depth texture, so they allocate it first.
      for (const layerTarget of [entry.layers, entry.stops]) {
        setRendererRenderTarget(renderer, layerTarget);
        renderer.clear(false, true, false);
      }
      entry.ready = true;
    }
    return entry;
  }

  /** Releases GPU memory; the next render allocates it again. */
  release() {
    for (const entry of this.targets) disposeTargets(entry);
    this.targets.length = 0;
  }

  dispose() {
    this.release();
    this.stopMesh.geometry.dispose();
  }
}

function disposeTargets({ layers, stops }: LayerTargets) {
  layers.dispose();
  stops.dispose();
  layers.depthTexture?.dispose();
}
