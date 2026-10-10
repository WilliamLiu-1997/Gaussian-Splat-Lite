import {
  ColorManagement,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearTransfer,
  Matrix4,
  type OrthographicCamera,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  UnsignedInt248Type,
  Vector2,
  type Vector3,
} from "three";
import {
  Node,
  type NodeBuilder,
  type NodeFrame,
  NodeUpdateType,
  RenderTarget,
  RendererUtils,
  type TextureNode,
  type WebGPURenderer,
} from "three/webgpu";
import { usesNativeWebGPU } from "../rendering/rendererUtils";
import { N } from "../rendering/tsl/tslCompat";
import {
  NEURAL_DENOISE_UNIFORM_FLOATS,
  neuralDenoiseShaders,
} from "./neuralDenoiseShaders";
import {
  type NeuralDenoiseModel,
  type NeuralDenoiseQuality,
  neuralDenoiseModels,
} from "./neuralDenoiseWeights";
import { createTAAState } from "./taaShared";

// This project's TypeScript setup has no WebGPU declarations; these cover
// what the denoiser calls.
type GpuView = object;
type GpuTexture = {
  createView(descriptor?: { aspect: string }): GpuView;
  destroy(): void;
};
type GpuBuffer = {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
};
type GpuPipeline = { getBindGroupLayout(index: number): object };
type GpuPassEncoder = {
  setPipeline(pipeline: GpuPipeline): void;
  setBindGroup(index: number, group: object): void;
  draw(vertices: number): void;
  end(): void;
};
type GpuCommandEncoder = {
  beginRenderPass(descriptor: object): GpuPassEncoder;
  copyTextureToBuffer(from: object, to: object, size: number[]): void;
  finish(): object;
};
type GpuDevice = {
  createTexture(descriptor: object): GpuTexture;
  createBuffer(descriptor: object): GpuBuffer;
  createSampler(descriptor: object): object;
  createShaderModule(descriptor: object): object;
  createBindGroupLayout(descriptor: object): object;
  createPipelineLayout(descriptor: object): object;
  createRenderPipeline(descriptor: object): GpuPipeline;
  createBindGroup(descriptor: object): object;
  createCommandEncoder(): GpuCommandEncoder;
  queue: {
    submit(commands: object[]): void;
    writeBuffer(buffer: GpuBuffer, offset: number, data: Float32Array): void;
  };
};
type GpuBackend = {
  device: GpuDevice;
  get(texture: Texture): { texture?: GpuTexture };
};
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
};
declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  MAP_READ: number;
};
declare const GPUShaderStage: { FRAGMENT: number };
declare const GPUMapMode: { READ: number };

const HALF = "rgba16float";
// A block's view depth and whether it is the block's own; sums of disparities
// over a cell, which half floats cannot hold across a scene's depth range.
const DEPTH = "rg32float";
const CELLS = "rgba32float";
const EXPOSED = "depth32float";
const FILTERABLE = "float";
const UNFILTERABLE = "unfilterable-float";

type Pass = { pipeline: GpuPipeline; layout: object; uniforms: boolean };
type Pair = [GpuView, GpuView];
/** The scene and history textures Three owns, as the passes see them. */
type External = {
  color: GpuTexture;
  depth: GpuTexture;
  /** Takes the scene's depth without the margin, once something reads it. */
  exposed: GpuTexture | null;
  history: [GpuTexture, GpuTexture];
  encode: boolean;
};

/** A pass, its inputs, its colour targets and its depth target. */
type Step = [Pass, object, GpuView[], GpuView?];
type FilterPasses = {
  encode: Pass[];
  kernel: Pass[];
  top: Pass;
  groups: number;
};
type FilterLevel = { encoded: GpuView[]; hidden: GpuView[]; result: GpuView };

// The renderer's noise has 32 phases, so a still view's frames repeat after 32
// and their mean stops getting cleaner there. The noise lies over the pixels
// of the target, so the node draws the scene into a target with a margin, at
// another place in it for every 32 frames: the same image under another part
// of the noise field, and a still view keeps settling. Three sets no viewport
// that is the same as the canvas's, so no offset is zero.
const MARGIN = 3;
const VIEW_OFFSETS = [
  [2, 2],
  [1, 2],
  [2, 1],
  [3, 2],
  [2, 3],
  [1, 1],
  [3, 1],
  [1, 3],
  [3, 3],
];

/**
 * The denoiser's passes on Three's GPUDevice: pipelines built once, textures
 * per size. Three renders the scene and samples the finished image; what lies
 * between runs here, outside the node system. The view depth is kept per 2x2
 * block, the network runs on 4x4 blocks and reads the previous state
 * directly, and one pass per pixel reprojects, filters, updates, mixes and
 * stabilizes.
 */
class Passes {
  readonly uniforms = new Float32Array(NEURAL_DENOISE_UNIFORM_FLOATS);
  /** Half a unit in the last place where the GPU truncates half-float writes, else 0. */
  halfBias = 0;
  private readonly uniformBuffer: GpuBuffer;
  private readonly sampler: object;
  private textures: GpuTexture[] = [];
  private width = 0;
  private height = 0;
  private external: External | null = null;
  private frames: ((encoder: GpuCommandEncoder) => void)[] = [];

  private readonly lowLevel: number;
  private readonly filter: FilterPasses | null;
  private readonly passes: Record<
    | "cells"
    | "wider"
    | "depth"
    | "expose"
    | "frame"
    | "encode"
    | "downsample"
    | "features"
    | "stage"
    | "predict"
    | "resolve",
    Pass
  >;
  /** The network's hidden channels, in groups of four: render targets per layer. */
  private readonly groups: number;
  /** Motion measured from the images, still at half resolution. */
  private readonly follow: {
    motion: Pass;
    pool: Pass;
    solve: Pass;
    pools: number;
  } | null;

  constructor(
    private readonly device: GpuDevice,
    model: NeuralDenoiseModel,
  ) {
    this.uniformBuffer = device.createBuffer({
      size: this.uniforms.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const code = neuralDenoiseShaders(model);
    this.lowLevel = code.lowLevel;
    this.groups = code.groups;
    const F = FILTERABLE;
    const U = UNFILTERABLE;
    const shift = code.follow ? [F] : [];
    // One render target, and one input texture, per group of hidden channels.
    const sampled = Array<string>(code.groups).fill(F);
    const written = Array<string>(code.groups).fill(HALF);
    this.passes = {
      // What was drawn in cells of 8 pixels and, three times over, in cells
      // four times as wide: a block with no depth of its own takes one there.
      cells: this.pass("cells", code.cells, ["depth"], [CELLS]),
      wider: this.pass("wider", code.wider, [U], [CELLS], false),
      // The depth, and whether it is the block's own.
      depth: this.pass("depth", code.depth, ["depth", U, U, U, U], [DEPTH]),
      expose: this.pass("expose", code.expose, ["depth"], [], true, true),
      frame: this.pass("frame", code.frame, [F], [HALF]),
      encode: this.pass("encode", code.encode, [F], [HALF]),
      downsample: this.pass("downsample", code.downsample, [F], [HALF], false),
      features: this.pass(
        "features",
        code.features,
        [
          U,
          U,
          F,
          F,
          F,
          ...(code.filter ? [F] : [F, F]),
          F,
          F,
          F,
          F,
          F,
          ...shift,
        ],
        // The first layer, and the evidence with this frame in it.
        [...written, HALF],
      ),
      stage: this.pass("stage", code.stage, sampled, written),
      predict: this.pass(
        "predict",
        code.predict,
        [...sampled, U, ...shift],
        // Trust and filter strength.
        [HALF, "r16float"],
      ),
      resolve: this.pass(
        "resolve",
        code.resolve,
        [
          U,
          ...(code.filter ? [F] : [F, F]),
          F,
          F,
          F,
          F,
          F,
          F,
          F,
          // What a pixel without history falls back on, and the depth the
          // previous frame kept.
          F,
          U,
          ...shift,
        ],
        // Both history paths, their statistics, and the image shown.
        [HALF, HALF, HALF, HALF],
      ),
    };
    this.follow = code.follow && {
      motion: this.pass(
        "motion",
        code.follow.motion,
        [U, F, F, F, F],
        [HALF, HALF],
      ),
      pool: this.pass("pool", code.follow.pool, [F, F], [HALF, HALF], false),
      // The estimate and next frame's decision are state, written here
      // alongside the shift this frame's history reads.
      solve: this.pass(
        "solve",
        code.follow.solve,
        [U, F, F, F, F],
        [HALF, HALF],
      ),
      pools: code.follow.pools,
    };
    this.filter = code.filter ? this.filterPasses(code.filter) : null;
    this.measureRounding(code.rounding);
  }

  /** A full-screen pass: the uniform block, a linear sampler, then its textures. */
  private pass(
    name: string,
    code: string,
    inputs: string[],
    targets: string[],
    uniforms = true,
    depth = false,
  ): Pass {
    const { device } = this;
    const label = `NeuralDenoise.${name}`;
    const module = device.createShaderModule({ label, code });
    const visibility = GPUShaderStage.FRAGMENT;
    const entries: object[] = uniforms
      ? [{ binding: 0, visibility, buffer: { type: "uniform" } }]
      : [];
    entries.push({
      binding: entries.length,
      visibility,
      sampler: { type: "filtering" },
    });
    for (const sampleType of inputs)
      entries.push({
        binding: entries.length,
        visibility,
        texture: { sampleType },
      });
    const layout = device.createBindGroupLayout({ label, entries });
    const pipeline = device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "vertex" },
      fragment: {
        module,
        entryPoint: "fragment",
        targets: targets.map((format) => ({ format })),
      },
      primitive: { topology: "triangle-list" },
      ...(depth && {
        depthStencil: {
          format: EXPOSED,
          depthWriteEnabled: true,
          depthCompare: "always",
        },
      }),
    });
    return { pipeline, layout, uniforms };
  }

  /** The pipelines of a learned spatial filter, which either pipeline may run. */
  private filterPasses(
    filter: NonNullable<ReturnType<typeof neuralDenoiseShaders>["filter"]>,
  ): FilterPasses {
    const F = FILTERABLE;
    const read = Array<string>(filter.groups).fill(F);
    const wrote = Array<string>(filter.groups).fill(HALF);
    const last = filter.encode.length - 1;
    return {
      // The level, the finer one, and from the level below its result and
      // hidden channels.
      encode: filter.encode.map((shader, i) =>
        this.pass(
          `filterEncode${i}`,
          shader,
          i === last ? [F, F] : [F, F, F, ...read],
          wrote,
          false,
        ),
      ),
      kernel: filter.kernel.map((shader, i) =>
        this.pass(
          `filterKernel${i}`,
          shader,
          [...read, F, ...(i === last ? [] : [F])],
          [...wrote, HALF],
          false,
        ),
      ),
      top: this.pass("filterTop", filter.top, [F, ...read, F], [HALF]),
      groups: filter.groups,
    };
  }

  /**
   * The learned filter's steps for one frame, coarsest level first: they turn
   * the frame's image pyramid (`levels`, the frame first) into `filtered`.
   */
  private filterSteps(
    filter: FilterPasses,
    levels: GpuView[],
    filterLevels: FilterLevel[],
    filtered: GpuView,
  ): Step[] {
    const steps: Step[] = [];
    const color = levels[0];
    for (let i = filterLevels.length - 1; i >= 0; i--) {
      const { encoded, hidden, result } = filterLevels[i];
      const below = filterLevels[i + 1];
      steps.push(
        [
          filter.encode[i],
          this.bind(filter.encode[i], [
            levels[i + 1],
            levels[i],
            ...(below ? [below.result, ...below.hidden] : []),
          ]),
          encoded,
        ],
        [
          filter.kernel[i],
          this.bind(filter.kernel[i], [
            ...encoded,
            levels[i + 1],
            ...(below ? [below.result] : []),
          ]),
          [...hidden, result],
        ],
      );
    }
    steps.push([
      filter.top,
      this.bind(filter.top, [
        color,
        ...filterLevels[0].hidden,
        filterLevels[0].result,
      ]),
      [filtered],
    ]);
    return steps;
  }

  /** Draws a value between two halves and reads back which one the GPU stored. */
  private measureRounding(code: string) {
    const { device } = this;
    const module = device.createShaderModule({ code });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vertex" },
      fragment: { module, entryPoint: "fragment", targets: [{ format: HALF }] },
    });
    // A uniform, so the compiler cannot fold the conversion.
    const value = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(
      value,
      0,
      new Float32Array([1 + 0.75 / 1024, 0, 0, 1]),
    );
    const texture = device.createTexture({
      size: [1, 1],
      format: HALF,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const result = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: texture.createView(), loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: value } }],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: result, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    result.mapAsync(GPUMapMode.READ).then(
      () => {
        // 0x3c00 is 1.0: the write was truncated. 0x3c01 is the nearer half.
        const stored = new Uint16Array(result.getMappedRange())[0];
        this.halfBias = stored === 0x3c00 ? 0.5 : 0;
        result.unmap();
        result.destroy();
        texture.destroy();
        value.destroy();
      },
      // A lost device; the bias stays at zero.
      () => {},
    );
  }

  private texture(format: string, width: number, height: number) {
    const texture = this.device.createTexture({
      size: [width, height],
      format,
      // COPY_SRC lets a test read the state back.
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
    this.textures.push(texture);
    return texture.createView();
  }

  private bind(pass: Pass, views: GpuView[]) {
    const resources = [this.sampler, ...views];
    if (pass.uniforms) resources.unshift({ buffer: this.uniformBuffer });
    return this.device.createBindGroup({
      layout: pass.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }

  /**
   * Allocates for this size and these scene and history textures, and gives
   * the steps of a frame that reads the `previous` side of every state pair
   * and writes the other.
   */
  private layout(width: number, height: number, external: External) {
    const { passes, groups, lowLevel, follow, filter } = this;
    const full = (format = HALF) => this.texture(format, width, height);
    const pair = (format = HALF): Pair => [full(format), full(format)];
    const scaled = (divisor: number, format = HALF) =>
      this.texture(
        format,
        Math.max(1, Math.floor(width / divisor)),
        Math.max(1, Math.floor(height / divisor)),
      );
    const block = (format = HALF) => scaled(4, format);

    const sceneColor = external.color.createView();
    const sceneDepth = external.depth.createView({ aspect: "depth-only" });
    const exposed = external.exposed?.createView();
    const output: Pair = [
      external.history[0].createView(),
      external.history[1].createView(),
    ];
    // State kept from frame to frame. The view depth is per 2x2 block.
    const depth: Pair = [scaled(2, DEPTH), scaled(2, DEPTH)];
    const accumulated = pair();
    const denoised = pair();
    // Second moment of luma, the two history lengths, slow low-pass luma.
    const aux = pair();
    // The network runs on 4x4 blocks.
    const trust: Pair = [block(), block()];
    // Signed evidence, over a few frames, that a block's history lags.
    const evidence: Pair = [block(), block()];
    const flow: Pair | null = follow && [scaled(2), scaled(2)];
    // Scratch of one frame. What was drawn, in cells of 8, 32, 128 and 512
    // pixels.
    const cells = [8, 32, 128, 512].map((width) => scaled(width, CELLS));
    // The scene without its margin, encoded for a linear working colour
    // space. The network takes a block's colour from the second level of the
    // image pyramid.
    const color = full();
    const levels = [color];
    const filterLevels: FilterLevel[] = [];
    const levelCount = filter
      ? filter.encode.length
      : Math.max(lowLevel + 1, 2);
    for (let i = 1; i <= levelCount; i++) {
      const level = () => scaled(2 ** i);
      levels.push(level());
      if (filter)
        filterLevels.push({
          encoded: Array.from({ length: filter.groups }, level),
          hidden: Array.from({ length: filter.groups }, level),
          result: level(),
        });
    }
    const filtered = filter && full();
    // The fit's sums and the previous estimate, averaged over its window.
    const sums: GpuView[][] = [];
    const smooth: GpuView[] = [];
    if (follow)
      for (
        let w = Math.max(1, Math.floor(width / 2)),
          h = Math.max(1, Math.floor(height / 2)),
          i = 0;
        i <= follow.pools;
        i++
      ) {
        sums.push([this.texture(HALF, w, h), this.texture(HALF, w, h)]);
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
        if (i < follow.pools) smooth.push(this.texture(HALF, w, h));
      }
    const shift = follow && scaled(2);
    // The network's layers write one of two sets of targets and read the other.
    const layers = [0, 1].map(() =>
      Array.from({ length: groups }, () => block()),
    );
    const strength = block("r16float");

    return (previous: number) => {
      const next = 1 - previous;
      const steps: Step[] = [
        [passes.cells, this.bind(passes.cells, [sceneDepth]), [cells[0]]],
      ];
      for (let i = 1; i < cells.length; i++)
        steps.push([
          passes.wider,
          this.bind(passes.wider, [cells[i - 1]]),
          [cells[i]],
        ]);
      steps.push([
        passes.depth,
        this.bind(passes.depth, [sceneDepth, ...cells]),
        [depth[next]],
      ]);
      if (exposed)
        steps.push([
          passes.expose,
          this.bind(passes.expose, [sceneDepth]),
          [],
          exposed,
        ]);
      const frame = external.encode ? passes.encode : passes.frame;
      steps.push([frame, this.bind(frame, [sceneColor]), [color]]);
      for (let i = 1; i < levels.length; i++)
        steps.push([
          passes.downsample,
          this.bind(passes.downsample, [levels[i - 1]]),
          [levels[i]],
        ]);
      if (filter && filtered)
        steps.push(...this.filterSteps(filter, levels, filterLevels, filtered));
      const followed = shift ? [shift] : [];
      if (follow && flow && shift) {
        const smoothed = smooth[smooth.length - 1];
        for (let i = 0; i < smooth.length; i++)
          steps.push([
            passes.downsample,
            this.bind(passes.downsample, [
              i === 0 ? flow[previous] : smooth[i - 1],
            ]),
            [smooth[i]],
          ]);
        steps.push([
          follow.motion,
          this.bind(follow.motion, [
            depth[next],
            levels[1],
            output[previous],
            flow[previous],
            smoothed,
          ]),
          sums[0],
        ]);
        for (let i = 1; i < sums.length; i++)
          steps.push([
            follow.pool,
            this.bind(follow.pool, sums[i - 1]),
            sums[i],
          ]);
        steps.push([
          follow.solve,
          this.bind(follow.solve, [
            depth[next],
            ...sums[sums.length - 1],
            flow[previous],
            smoothed,
          ]),
          [flow[next], shift],
        ]);
      }
      steps.push(
        [
          passes.features,
          this.bind(passes.features, [
            depth[next],
            depth[previous],
            color,
            levels[1],
            levels[2],
            ...(filtered
              ? [filtered]
              : [levels[lowLevel], levels[lowLevel + 1]]),
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[previous],
            evidence[previous],
            ...followed,
          ]),
          [...layers[0], evidence[next]],
        ],
        [passes.stage, this.bind(passes.stage, layers[0]), layers[1]],
        [
          passes.predict,
          this.bind(passes.predict, [...layers[1], depth[next], ...followed]),
          [trust[next], strength],
        ],
        [
          passes.resolve,
          this.bind(passes.resolve, [
            depth[next],
            ...(filtered
              ? [filtered]
              : [levels[lowLevel], levels[lowLevel + 1]]),
            color,
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[next],
            strength,
            output[previous],
            // The learned filter's half-resolution result, or the frame's
            // mean over 4x4 pixels.
            filter ? filterLevels[0].result : levels[2],
            depth[previous],
            ...followed,
          ]),
          [accumulated[next], denoised[next], aux[next], output[next]],
        ],
      );
      return steps;
    };
  }

  private prepare(width: number, height: number, external: External) {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    this.width = width;
    this.height = height;
    this.external = external;
    const steps = this.layout(width, height, external);
    // The two frames that alternate.
    this.frames = [0, 1].map((previous) => {
      const frame = steps(previous);
      return (encoder: GpuCommandEncoder) => {
        for (const [pass, group, views, depth] of frame) {
          const draw = encoder.beginRenderPass({
            colorAttachments: views.map((view) => ({
              view,
              loadOp: "clear",
              storeOp: "store",
            })),
            ...(depth && {
              depthStencilAttachment: {
                view: depth,
                depthClearValue: 0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
              },
            }),
          });
          draw.setPipeline(pass.pipeline);
          draw.setBindGroup(0, group);
          draw.draw(3);
          draw.end();
        }
      };
    });
  }

  /**
   * Denoises the scene texture into `history[1 - previous]`, reading the
   * state the frame before left on the `previous` side.
   */
  render(width: number, height: number, external: External, previous: number) {
    const current = this.external;
    if (
      current === null ||
      width !== this.width ||
      height !== this.height ||
      current.color !== external.color ||
      current.depth !== external.depth ||
      current.exposed !== external.exposed ||
      current.history[0] !== external.history[0] ||
      current.history[1] !== external.history[1] ||
      current.encode !== external.encode
    )
      this.prepare(width, height, external);
    const { device } = this;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms);
    const encoder = device.createCommandEncoder();
    this.frames[previous](encoder);
    device.queue.submit([encoder.finish()]);
  }

  dispose() {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    this.frames = [];
    this.external = null;
    this.uniformBuffer.destroy();
  }
}

/**
 * Temporal neural denoiser for stochastic Splat rendering on native WebGPU,
 * used in place of TAANode. After Hu et al., "Ultra-fast Neural Inference for
 * Stochastic Gaussian Splatting Denoising" (arXiv 2609.25604), adapted to
 * scenes whose objects move.
 */
export class NeuralDenoiseNode extends Node<"vec4"> {
  static get type() {
    return "NeuralDenoiseNode";
  }

  /**
   * Blends the result with the previous image where the network trusts it.
   * Steadier; turn it off for the two history paths alone.
   */
  stabilize = true;

  private readonly source = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1, FloatType),
    samples: 0,
  }) as RenderTarget & { depthTexture: DepthTexture };
  // The displayed image, which is also what stabilization blends with.
  private readonly history = [0, 1].map(
    () =>
      new RenderTarget(1, 1, {
        type: HalfFloatType,
        depthBuffer: false,
        samples: 0,
      }),
  );
  private readonly textureNode = (
    N.passTexture as unknown as (
      pass: NeuralDenoiseNode,
      texture: Texture,
    ) => TextureNode
  )(this, this.history[0].texture);
  // The passes work on display-referred values; a linear working colour
  // space is encoded on the way in and decoded here.
  private readonly encoded = N.uniform(false);
  private readonly outputColor: Node<"vec4"> = N.Fn(() => {
    const color = this.textureNode.toVar();
    N.If(this.encoded, () => {
      // Premultiplied: the transfer applies to the colour itself.
      const alpha = color.a.max(1e-6).toVar();
      color.rgb.divAssign(alpha);
      color.rgb.assign(N.sRGBTransferEOTF(color.rgb));
      color.rgb.mulAssign(alpha);
    });
    return color;
  })();
  private readonly state = createTAAState<
    { value: number },
    { value: boolean },
    { value: Vector2 },
    { value: Vector3 },
    { value: Matrix4 }
  >(<T>(value: T) => ({ value }), [this.source, ...this.history], true, MARGIN);
  private passes: Passes | null = null;
  // The scene target's depth has the margin; this one has the image's size.
  private readonly depth = new DepthTexture(1, 1, FloatType);
  private depthRead = false;
  private readonly previousWorld = new Matrix4();
  private readonly previousProjection = new Matrix4();
  private readonly relative = new Matrix4();
  /** Frames drawn, for the scene's place in its target. */
  private frame = 0;
  private readonly toPreviousClip = new Matrix4();
  private readonly drawingSize = new Vector2();
  private workingColorSpace = ColorManagement.workingColorSpace;
  private readonly pipelineStates = new WeakSet<object>();
  private pipelineRendering = false;
  private capturePending = true;

  /**
   * @param quality  Which of the two trained models runs. `"balanced"` takes
   *   more GPU time and keeps more fine detail while the camera moves. Fixed
   *   for the node's lifetime.
   */
  constructor(
    public scene: Scene,
    public camera: PerspectiveCamera | OrthographicCamera,
    readonly quality: NeuralDenoiseQuality = "balanced",
  ) {
    super("vec4");
    this.updateBeforeType = NodeUpdateType.RENDER;
    this.source.texture.name = "NeuralDenoise.scene";
    this.history[0].texture.name = "NeuralDenoise.history0";
    this.history[1].texture.name = "NeuralDenoise.history1";
  }

  /** Scene depth of the current frame, kept from the first read on. */
  get depthTexture(): DepthTexture {
    this.depthRead = true;
    return this.depth;
  }

  /** The projection `depthTexture` was rendered with. */
  get projectionMatrix(): Matrix4 {
    return this.state.uniforms.projection.value;
  }

  /** The denoised image, for chaining effects. */
  getTextureNode(): Node<"vec4"> {
    return this.outputColor;
  }

  setSize(width: number, height: number) {
    this.state.setSize(width, height);
  }

  /** Discards earlier frames, as after a camera cut. */
  reset() {
    this.state.reset();
  }

  override updateBefore(frame: NodeFrame) {
    if (this.pipelineRendering && !this.capturePending) return;
    const renderer = frame.renderer as WebGPURenderer;
    if (!usesNativeWebGPU(renderer)) {
      throw new Error(
        "NeuralDenoiseNode requires native WebGPU; use TAANode on the WebGL2 fallback",
      );
    }
    if (this.workingColorSpace !== ColorManagement.workingColorSpace) {
      this.workingColorSpace = ColorManagement.workingColorSpace;
      this.reset();
    }
    const backend = renderer.backend as unknown as GpuBackend;
    if (this.passes === null) {
      const model = neuralDenoiseModels[this.quality];
      this.passes = new Passes(backend.device, model);
    }
    const { camera, state, passes } = this;
    const rendererState = RendererUtils.saveRendererState(renderer);
    const xrEnabled = renderer.xr.enabled;
    if (this.pipelineRendering) {
      this.setSize(this.drawingSize.x, this.drawingSize.y);
    } else if (rendererState.renderTarget) {
      this.setSize(
        rendererState.renderTarget.width,
        rendererState.renderTarget.height,
      );
    } else {
      renderer.getDrawingBufferSize(this.drawingSize);
      this.setSize(this.drawingSize.x, this.drawingSize.y);
    }
    // Float depth with stencil is an optional WebGPU feature.
    state.setStencil(
      renderer.stencil,
      renderer.stencil && !renderer.hasFeature("depth32float-stencil8")
        ? UnsignedInt248Type
        : FloatType,
    );
    try {
      renderer.xr.enabled = false;
      renderer.setMRT(null);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      const reversedDepth = camera.reversedDepth;
      const coordinateSystem = camera.coordinateSystem;
      const { x: width, y: height } = state.uniforms.renderSize.value;
      const [offsetX, offsetY] =
        VIEW_OFFSETS[Math.floor(this.frame / 32) % VIEW_OFFSETS.length];
      this.frame++;
      this.source.viewport.set(offsetX, offsetY, width, height);
      state.beginCapture(camera);
      try {
        renderer.setRenderTarget(this.source);
        renderer.render(this.scene, camera);
      } finally {
        state.endCapture(camera);
        // Three may initialize the camera's depth convention on its first draw.
        if (
          camera.reversedDepth !== reversedDepth ||
          camera.coordinateSystem !== coordinateSystem
        )
          camera.updateProjectionMatrix();
      }
      const valid = state.uniforms.valid.value;
      if (!valid)
        for (const target of this.history) renderer.initRenderTarget(target);

      // Camera relation to the previous frame, composed in double precision.
      const u = passes.uniforms;
      const jittered = state.uniforms.projection.value.elements;
      const logarithmic =
        renderer.logarithmicDepthBuffer &&
        "isPerspectiveCamera" in camera &&
        camera.isPerspectiveCamera;
      // Three.js clamps the near plane the same way.
      const near = Math.max(camera.near, 1e-6);
      this.relative
        .copy(this.previousWorld)
        .invert()
        .multiply(camera.matrixWorld);
      this.toPreviousClip.multiplyMatrices(
        this.previousProjection,
        this.relative,
      );
      const r = this.relative.elements;
      u.set(this.toPreviousClip.elements, 0);
      u.set(camera.projectionMatrix.elements, 16);
      u.set([r[2], r[6], r[10], r[14]], 32);
      u.set([jittered[0], jittered[5], jittered[8], jittered[9]], 36);
      u.set([jittered[12], jittered[13], jittered[11], jittered[15]], 40);
      u.set([jittered[10], jittered[11], jittered[14], jittered[15]], 44);
      u.set([width, height, 1 / width, 1 / height], 48);
      u.set(
        [
          camera.far,
          renderer.reversedDepthBuffer ? 0 : 1,
          valid ? 1 : 0,
          this.stabilize ? 1 : 0,
          passes.halfBias,
          logarithmic ? 1 : 0,
          near,
          Math.log2(camera.far / near),
        ],
        52,
      );
      // Where this frame's samples lie relative to pixel centres: the point
      // the jittered projection puts at the centre of the view, seen through
      // the unjittered one.
      const unjittered = camera.projectionMatrix.elements;
      const x = (jittered[8] - jittered[12]) / jittered[0];
      const y = (jittered[9] - jittered[13]) / jittered[5];
      const clip = (row: number) =>
        unjittered[row] * x +
        unjittered[row + 4] * y -
        unjittered[row + 8] +
        unjittered[row + 12];
      u.set(
        [
          (clip(0) / clip(3)) * 0.5 * width,
          (clip(1) / clip(3)) * -0.5 * height,
        ],
        60,
      );
      // How far the camera turned since the previous frame, whatever scale
      // its rig carries.
      const cosine =
        ((r[0] + r[5] + r[10]) / Math.cbrt(this.relative.determinant()) - 1) /
        2;
      u[62] = Math.acos(Math.min(1, Math.max(-1, cosine)));
      u.set([offsetX, offsetY], 64);

      const encode =
        ColorManagement.getTransfer(this.workingColorSpace) === LinearTransfer;
      this.encoded.value = encode;
      const gpu = (texture: Texture) => {
        const data = backend.get(texture).texture;
        if (!data) throw new Error("NeuralDenoiseNode: texture not allocated");
        return data;
      };
      if (this.depthRead) {
        const image = this.depth.image;
        if (image.width !== width || image.height !== height) {
          image.width = width;
          image.height = height;
          this.depth.needsUpdate = true;
        }
        renderer.initTexture(this.depth);
      }
      const previous = state.historyIndex;
      passes.render(
        width,
        height,
        {
          color: gpu(this.source.texture),
          depth: gpu(this.source.depthTexture),
          exposed: this.depthRead ? gpu(this.depth) : null,
          history: [gpu(this.history[0].texture), gpu(this.history[1].texture)],
          encode,
        },
        previous,
      );
      this.textureNode.value = this.history[1 - previous].texture;
      this.previousWorld.copy(camera.matrixWorld);
      this.previousProjection.copy(camera.projectionMatrix);
      state.advance(camera);
      this.capturePending = false;
    } finally {
      RendererUtils.restoreRendererState(renderer, rendererState);
      renderer.xr.enabled = xrEnabled;
    }
    return undefined;
  }

  override setup(builder: NodeBuilder) {
    const pipelineState = (builder.context as { renderPipelineState?: object })
      .renderPipelineState;
    if (pipelineState && !this.pipelineStates.has(pipelineState)) {
      this.pipelineStates.add(pipelineState);
      const begin = () => {
        this.pipelineRendering = true;
        this.capturePending = true;
        const renderer = builder.renderer;
        const target =
          renderer.getRenderTarget() ?? renderer.getOutputRenderTarget();
        if (target) this.drawingSize.set(target.width, target.height);
        else renderer.getDrawingBufferSize(this.drawingSize);
      };
      // The first pipeline render builds its callbacks after the before phase.
      begin();
      N.OnBeforeRenderPipeline(begin);
      N.OnAfterRenderPipeline(() => {
        this.pipelineRendering = false;
      });
    }
    return this.outputColor;
  }

  override dispose() {
    super.dispose();
    this.passes?.dispose();
    this.passes = null;
    this.source.dispose();
    this.depth.dispose();
    for (const target of this.history) target.dispose();
  }
}
