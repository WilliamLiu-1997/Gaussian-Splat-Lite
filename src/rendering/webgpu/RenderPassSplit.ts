import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { DepthDescriptor, LayeredPass } from "../LayeredOverdraw";

// Three.js r186 WebGPU backend internals. Nested renders submit their own
// command buffers immediately, while the active pass is submitted when its
// render finishes. Work that must see earlier draws in the same pass, and be
// seen by later ones, therefore has to end and resubmit that pass. Every access
// is checked; an unexpected shape leaves the caller on its regular draw path.

type GPUTextureLike = {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly sampleCount: number;
  readonly dimension: string;
  readonly format: string;
};

type RenderPassLike = {
  end(): void;
  endOcclusionQuery(): void;
  executeBundles?: unknown;
};

type TimestampWrites = {
  querySet: unknown;
  beginningOfPassWriteIndex?: number;
  endOfPassWriteIndex?: number;
};

type PassDescriptor = {
  colorAttachments: { loadOp?: string }[];
  depthStencilAttachment?: { depthLoadOp?: string; stencilLoadOp?: string };
  timestampWrites?: TimestampWrites;
};

type CommandEncoderLike = {
  beginRenderPass(descriptor: PassDescriptor): RenderPassLike;
  copyTextureToTexture(
    source: { texture: GPUTextureLike },
    destination: { texture: GPUTextureLike },
    size: [number, number, number],
  ): void;
  finish(): unknown;
};

type RenderContextData = {
  encoder?: CommandEncoderLike;
  currentPass?: RenderPassLike | null;
  descriptor?: PassDescriptor;
  currentSets?: unknown;
  currentBlendColor?: THREE.Color;
  currentBlendAlpha?: number;
  currentStencilRef?: number;
  occlusionQuerySet?: unknown;
  occlusionQueryIndex?: number;
  lastOcclusionObject?: THREE.Object3D | null;
};

type RenderContextLike = {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly depth: boolean;
  readonly stencil: boolean;
  readonly depthTexture: THREE.DepthTexture | null;
  readonly renderTarget:
    | (THREE.RenderTarget & {
        isRenderTarget3D?: boolean;
        isPostProcessingRenderTarget?: boolean;
      })
    | null;
  readonly viewport: boolean;
  readonly viewportValue: THREE.Vector4 & {
    minDepth?: number;
    maxDepth?: number;
  };
  readonly scissor: boolean;
  readonly scissorValue: THREE.Vector4;
  readonly activeMipmapLevel: number;
};

type BackendLike = {
  isWebGPUBackend?: boolean;
  compatibilityMode?: boolean | null;
  device?: {
    createCommandEncoder(descriptor?: { label?: string }): CommandEncoderLike;
    queue: { submit(commands: unknown[]): void };
  };
  get(object: object): RenderContextData & { texture?: GPUTextureLike };
  updateViewport?(context: RenderContextLike): void;
  updateScissor?(context: RenderContextLike): void;
  _resetRenderContextData?(data: RenderContextData): void;
  utils?: { getSampleCountRenderContext?(context: RenderContextLike): number };
};

type ReadyBackend = BackendLike &
  Required<Pick<BackendLike, "device" | "updateViewport" | "updateScissor">>;

type RendererInternals = {
  _currentRenderContext?: RenderContextLike | null;
  getCanvasTarget?(): { depthTexture?: THREE.DepthTexture };
};

type OpenPass = RenderContextData & {
  encoder: CommandEncoderLike;
  currentPass: RenderPassLike;
  descriptor: PassDescriptor;
};

// Copies require identical depth formats.
const DEPTH_FORMATS: Record<string, DepthDescriptor> = {
  depth16unorm: { format: THREE.DepthFormat, type: THREE.UnsignedShortType },
  depth24plus: { format: THREE.DepthFormat, type: THREE.UnsignedIntType },
  depth32float: { format: THREE.DepthFormat, type: THREE.FloatType },
  "depth24plus-stencil8": {
    format: THREE.DepthStencilFormat,
    type: THREE.UnsignedInt248Type,
  },
  "depth32float-stencil8": {
    format: THREE.DepthStencilFormat,
    type: THREE.FloatType,
  },
};

function isOpenPass(data: RenderContextData): data is OpenPass {
  // Array-texture targets record each layer into bundles and keep no pass
  // encoder open; their draws run when the render finishes.
  return (
    typeof data.currentPass?.end === "function" &&
    typeof data.currentPass.executeBundles === "function" &&
    typeof data.encoder?.beginRenderPass === "function" &&
    Array.isArray(data.descriptor?.colorAttachments)
  );
}

/**
 * The single-sample render pass drawing the current Three.js object, when
 * it can be split. Cube faces, MRT and ArrayCamera viewports are supported.
 */
export function currentWebGPUPass(
  renderer: WebGPURenderer,
): LayeredPass | null {
  const internals = renderer as unknown as RendererInternals;
  const backend = renderer.backend as unknown as BackendLike;
  const context = internals._currentRenderContext;
  if (
    !context ||
    backend.isWebGPUBackend !== true ||
    backend.compatibilityMode === true ||
    !backend.device ||
    typeof backend.get !== "function" ||
    typeof backend.updateViewport !== "function" ||
    typeof backend.updateScissor !== "function" ||
    backend.utils?.getSampleCountRenderContext?.(context) !== 1 ||
    context.activeMipmapLevel !== 0 ||
    context.renderTarget?.isRenderTarget3D === true ||
    (context.viewportValue.minDepth ?? 0) !== 0 ||
    (context.viewportValue.maxDepth ?? 1) !== 1
  ) {
    return null;
  }
  const data = backend.get(context);
  if (!isOpenPass(data)) return null;

  let source: GPUTextureLike | null = null;
  let depth: DepthDescriptor | null = null;
  if (context.depth) {
    const texture = context.renderTarget
      ? context.depthTexture
      : internals.getCanvasTarget?.().depthTexture;
    source = texture ? (backend.get(texture).texture ?? null) : null;
    depth = source ? (DEPTH_FORMATS[source.format] ?? null) : null;
    // Cube faces share one 2D depth texture; layered depth cannot be copied.
    if (
      !source ||
      !depth ||
      source.dimension !== "2d" ||
      source.depthOrArrayLayers !== 1 ||
      source.sampleCount !== 1 ||
      source.width !== context.width ||
      source.height !== context.height
    ) {
      return null;
    }
  }
  return new WebGPUPass(backend as ReadyBackend, data, context, source, depth);
}

class WebGPUPass implements LayeredPass {
  private timestampWrites: TimestampWrites | undefined;
  private suspended = false;

  constructor(
    private readonly backend: ReadyBackend,
    private readonly data: OpenPass,
    private readonly context: RenderContextLike,
    private readonly source: GPUTextureLike | null,
    readonly depth: DepthDescriptor | null,
  ) {}

  get width() {
    return this.context.width;
  }

  get height() {
    return this.context.height;
  }

  get viewport() {
    return this.context.viewportValue;
  }

  get scissor() {
    return this.context.scissorValue;
  }

  get scaledViewports() {
    const target = this.context.renderTarget;
    return target === null || target.isPostProcessingRenderTarget === true;
  }

  /**
   * Ends the pass and submits the draws recorded so far, after copying its
   * depth when requested. Work submitted before close() runs between them.
   */
  open(depthTexture: THREE.DepthTexture | null) {
    const { data, backend, source } = this;
    const copy = depthTexture
      ? (backend.get(depthTexture).texture ?? null)
      : null;
    if (
      depthTexture &&
      (!copy ||
        !source ||
        copy.format !== source.format ||
        copy.width !== source.width ||
        copy.height !== source.height)
    ) {
      return false;
    }
    const pass = data.currentPass;
    // A query left open by the previous object must close within its pass.
    const occluder = data.lastOcclusionObject;
    if (data.occlusionQuerySet !== undefined && occluder) {
      if (occluder.occlusionTest === true) {
        pass.endOcclusionQuery();
        data.occlusionQueryIndex = (data.occlusionQueryIndex ?? 0) + 1;
      }
      data.lastOcclusionObject = null;
    }
    // Nested passes rewrite Three's shared timestamp descriptor.
    const writes = data.descriptor.timestampWrites;
    this.timestampWrites = writes
      ? {
          querySet: writes.querySet,
          endOfPassWriteIndex: writes.endOfPassWriteIndex,
        }
      : undefined;
    pass.end();
    if (copy && source) {
      data.encoder.copyTextureToTexture(
        { texture: source },
        { texture: copy },
        [source.width, source.height, 1],
      );
    }
    backend.device.queue.submit([data.encoder.finish()]);
    data.encoder = backend.device.createCommandEncoder({
      label: `renderContext_${this.context.id}`,
    });
    this.suspended = true;
    return true;
  }

  /** Reopens the pass with its attachments loaded and its state reset. */
  close() {
    if (!this.suspended) return;
    this.suspended = false;
    const { data, backend, context } = this;
    const { descriptor } = data;
    for (const attachment of descriptor.colorAttachments) {
      attachment.loadOp = "load";
    }
    const depthStencil = descriptor.depthStencilAttachment;
    if (depthStencil && context.depth) depthStencil.depthLoadOp = "load";
    if (depthStencil && context.stencil) depthStencil.stencilLoadOp = "load";
    // Keep the pass start recorded before suspension.
    descriptor.timestampWrites = this.timestampWrites;
    data.currentPass = data.encoder.beginRenderPass(descriptor);
    if (typeof backend._resetRenderContextData === "function") {
      backend._resetRenderContextData(data);
    } else {
      data.currentSets = {
        attributes: {},
        bindingGroups: [],
        pipeline: null,
        index: null,
      };
      data.currentBlendColor?.setRGB(0, 0, 0);
      data.currentBlendAlpha = 0;
      data.currentStencilRef = 0;
    }
    if (context.viewport) backend.updateViewport(context);
    if (context.scissor) backend.updateScissor(context);
  }
}
