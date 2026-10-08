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
  neuralDenoiseLeanShaders,
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
const FILTERABLE = "float";
const UNFILTERABLE = "unfilterable-float";

type Pass = { pipeline: GpuPipeline; layout: object; uniforms: boolean };
type Pair = [GpuView, GpuView];
/** The scene and history textures Three owns, as the passes see them. */
type External = {
  color: GpuTexture;
  depth: GpuTexture;
  history: [GpuTexture, GpuTexture];
  encode: boolean;
};

type Step = [Pass, object, GpuView[]];

/**
 * What the denoiser's two pipelines share on Three's GPUDevice: pipelines
 * built once, textures per size. Three renders the scene and samples the
 * finished image; what lies between runs here, outside the node system.
 */
abstract class Passes {
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

  constructor(protected readonly device: GpuDevice) {
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
  }

  /**
   * Allocates for this size and these scene and history textures, and gives
   * the steps of a frame that reads the `previous` side of every state pair
   * and writes the other.
   */
  protected abstract layout(
    width: number,
    height: number,
    external: External,
  ): (previous: number) => Step[];

  /** A full-screen pass: the uniform block, a linear sampler, then its textures. */
  protected pass(
    name: string,
    code: string,
    inputs: string[],
    targets: string[],
    uniforms = true,
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
    });
    return { pipeline, layout, uniforms };
  }

  /** Draws a value between two halves and reads back which one the GPU stored. */
  protected measureRounding(code: string) {
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

  protected texture(format: string, width: number, height: number) {
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

  protected bind(pass: Pass, views: GpuView[]) {
    const resources = [this.sampler, ...views];
    if (pass.uniforms) resources.unshift({ buffer: this.uniformBuffer });
    return this.device.createBindGroup({
      layout: pass.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
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
        for (const [pass, group, views] of frame) {
          const draw = encoder.beginRenderPass({
            colorAttachments: views.map((view) => ({
              view,
              loadOp: "clear",
              storeOp: "store",
            })),
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
 * The full pipeline: view depth per pixel, a pass that reprojects and one that
 * updates, the network on 2x2 blocks, and motion following where the model
 * has it.
 */
class FullPasses extends Passes {
  private readonly lowLevel: number;
  private readonly passes: Record<
    | "depth"
    | "encode"
    | "downsample"
    | "reproject"
    | "features"
    | "stage"
    | "predict"
    | "update"
    | "stabilize",
    Pass
  >;
  /** The network's extra residual blocks, one pass each. */
  private readonly blocks: Pass[];
  /** Motion measured from the images, for a model that follows it. */
  private readonly follow: {
    motion: Pass;
    pool: Pass;
    solve: Pass;
    pools: number;
  } | null;
  /**
   * A learned spatial filter, for a model that has one: two passes per level
   * of the frame's image pyramid, then one at full resolution.
   */
  private readonly filter: {
    encode: Pass[];
    kernel: Pass[];
    top: Pass;
    groups: number;
  } | null;
  /** The network's hidden channels, in groups of four: render targets per layer. */
  private readonly groups: number;

  constructor(device: GpuDevice, model: NeuralDenoiseModel) {
    super(device);
    const code = neuralDenoiseShaders(model);
    this.lowLevel = code.lowLevel;
    this.groups = code.groups;
    const F = FILTERABLE;
    const U = UNFILTERABLE;
    const full = [HALF, HALF, HALF, HALF];
    // One render target, and one input texture, per group of hidden channels.
    const sampled = Array<string>(code.groups).fill(F);
    const written = Array<string>(code.groups).fill(HALF);
    // A model that follows motion: every pass that reprojects also takes the
    // shift, and the pass that decides whether to follow the motion estimate.
    const shift = code.follow ? [F] : [];
    const estimate = code.follow ? [F, F] : [];
    this.passes = {
      depth: this.pass("depth", code.depth, ["depth"], ["r32float"]),
      encode: this.pass("encode", code.encode, [F], [HALF], false),
      downsample: this.pass("downsample", code.downsample, [F], [HALF], false),
      // The filtered frame is the learned filter's to write where there is one.
      reproject: this.pass(
        "reproject",
        code.reproject,
        [U, ...(code.filter ? [] : [F, F]), F, F, F, ...shift],
        code.filter ? [HALF, HALF, HALF] : full,
      ),
      features: this.pass(
        "features",
        code.features,
        [U, U, F, F, F, F, F, F, F, ...shift],
        written,
      ),
      stage: this.pass("stage", code.stage, sampled, written),
      predict: this.pass(
        "predict",
        code.predict,
        [...sampled, F, U, F, F, F, ...estimate],
        // Trust, filter strength, evidence, and the motion estimate if any.
        [HALF, "r16float", HALF, ...(code.follow ? [HALF] : [])],
      ),
      update: this.pass("update", code.update, [F, F, F, F, F, F, F], full),
      stabilize: this.pass(
        "stabilize",
        code.stabilize,
        [U, F, F, F, F, ...shift],
        [HALF],
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
      solve: this.pass(
        "solve",
        code.follow.solve,
        [U, F, F, F, F],
        [HALF, HALF],
      ),
      pools: code.follow.pools,
    };
    this.blocks = code.blocks.map((block, i) =>
      this.pass(`block${i}`, block, sampled, written),
    );
    const filter = code.filter;
    if (filter) {
      const read = Array<string>(filter.groups).fill(F);
      const wrote = Array<string>(filter.groups).fill(HALF);
      const last = filter.encode.length - 1;
      this.filter = {
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
    } else this.filter = null;
    this.measureRounding(code.rounding);
  }

  protected layout(width: number, height: number, external: External) {
    const { passes, blocks, groups, lowLevel, follow, filter } = this;
    const full = (format = HALF) => this.texture(format, width, height);
    const pair = (format = HALF): Pair => [full(format), full(format)];
    // The trust networks run on 2x2 blocks.
    const halfWidth = Math.max(1, Math.floor(width / 2));
    const halfHeight = Math.max(1, Math.floor(height / 2));
    const half = (format = HALF) => this.texture(format, halfWidth, halfHeight);

    const sceneColor = external.color.createView();
    const sceneDepth = external.depth.createView({ aspect: "depth-only" });
    const output: Pair = [
      external.history[0].createView(),
      external.history[1].createView(),
    ];
    // State kept from frame to frame.
    const depth = pair("r32float");
    const accumulated = pair();
    const denoised = pair();
    // Second moment of luma, the two history lengths, slow low-pass luma.
    const aux = pair();
    const trust: Pair = [half(), half()];
    // Signed evidence, over a few frames, that a block's history lags.
    const evidence: Pair = [half(), half()];
    // Motion following: the estimate (x, y), the share of the frame
    // difference it explains, and the probability that following it is right.
    const flow: Pair | null = follow && [half(), half()];
    // Scratch of one frame.
    const color = external.encode ? full() : sceneColor;
    const levels = [color];
    // A learned filter's scratch per level: the first layer's output, the
    // hidden channels and the filtered level.
    const filterLevels: {
      encoded: GpuView[];
      hidden: GpuView[];
      result: GpuView;
    }[] = [];
    const levelCount = filter ? filter.encode.length : lowLevel + 1;
    for (let w = width, h = height, i = 1; i <= levelCount; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      const level = () => this.texture(HALF, w, h);
      levels.push(level());
      if (filter)
        filterLevels.push({
          encoded: Array.from({ length: filter.groups }, level),
          hidden: Array.from({ length: filter.groups }, level),
          result: level(),
        });
    }
    const reprojected = { accumulated: full(), denoised: full(), aux: full() };
    const filtered = full();
    // The network's layers write one of two sets of targets and read the other.
    const layers = [0, 1].map(() =>
      Array.from({ length: groups }, () => half()),
    );
    // Motion following, one frame's scratch: the sums of the least-squares
    // fit and the last frame's estimate, both halved down to the fit's
    // window; the estimate with this frame in it; the shift history is read
    // at.
    const sums: GpuView[][] = [];
    const smooth: GpuView[] = [];
    if (follow)
      for (let w = halfWidth, h = halfHeight, i = 0; i <= follow.pools; i++) {
        sums.push([this.texture(HALF, w, h), this.texture(HALF, w, h)]);
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
        if (i < follow.pools) smooth.push(this.texture(HALF, w, h));
      }
    const estimate = follow && half();
    const shift = follow && half();
    const strength = half("r16float");
    const composite = full();

    return (previous: number) => {
      const next = 1 - previous;
      const steps: Step[] = [
        [passes.depth, this.bind(passes.depth, [sceneDepth]), [depth[next]]],
      ];
      if (external.encode)
        steps.push([
          passes.encode,
          this.bind(passes.encode, [sceneColor]),
          [color],
        ]);
      for (let i = 1; i < levels.length; i++)
        steps.push([
          passes.downsample,
          this.bind(passes.downsample, [levels[i - 1]]),
          [levels[i]],
        ]);
      if (filter) {
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
      }
      const followed = shift ? [shift] : [];
      const estimated = estimate && shift ? [estimate, shift] : [];
      if (follow && flow && estimate && shift) {
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
          [estimate, shift],
        ]);
      }
      steps.push(
        [
          passes.reproject,
          this.bind(passes.reproject, [
            depth[next],
            ...(filter ? [] : [levels[lowLevel], levels[lowLevel + 1]]),
            accumulated[previous],
            denoised[previous],
            aux[previous],
            ...followed,
          ]),
          [
            reprojected.accumulated,
            reprojected.denoised,
            reprojected.aux,
            ...(filter ? [] : [filtered]),
          ],
        ],
        [
          passes.features,
          this.bind(passes.features, [
            depth[next],
            depth[previous],
            color,
            reprojected.accumulated,
            reprojected.denoised,
            reprojected.aux,
            filtered,
            trust[previous],
            evidence[previous],
            ...followed,
          ]),
          layers[0],
        ],
        [passes.stage, this.bind(passes.stage, layers[0]), layers[1]],
        ...blocks.map((block, i): [Pass, object, GpuView[]] => [
          block,
          this.bind(block, layers[(i + 1) % 2]),
          layers[i % 2],
        ]),
        [
          passes.predict,
          this.bind(passes.predict, [
            ...layers[(blocks.length + 1) % 2],
            reprojected.aux,
            depth[next],
            filtered,
            trust[previous],
            evidence[previous],
            ...estimated,
          ]),
          [
            trust[next],
            strength,
            evidence[next],
            ...(flow ? [flow[next]] : []),
          ],
        ],
        [
          passes.update,
          this.bind(passes.update, [
            color,
            reprojected.accumulated,
            reprojected.denoised,
            reprojected.aux,
            filtered,
            trust[next],
            strength,
          ]),
          [accumulated[next], denoised[next], aux[next], composite],
        ],
        [
          passes.stabilize,
          this.bind(passes.stabilize, [
            depth[next],
            composite,
            reprojected.aux,
            trust[next],
            output[previous],
            ...followed,
          ]),
          [output[next]],
        ],
      );
      return steps;
    };
  }
}

/**
 * The lean pipeline of the fastest quality level: view depth per 2x2 block,
 * the network on 4x4 blocks reading the previous state directly, and one pass
 * per pixel that reprojects, filters, updates, mixes and stabilizes.
 */
class LeanPasses extends Passes {
  private readonly lowLevel: number;
  private readonly passes: Record<
    | "depth"
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

  constructor(device: GpuDevice, model: NeuralDenoiseModel) {
    super(device);
    const code = neuralDenoiseLeanShaders(model);
    this.lowLevel = code.lowLevel;
    this.groups = code.groups;
    const F = FILTERABLE;
    const U = UNFILTERABLE;
    // One render target, and one input texture, per group of hidden channels.
    const sampled = Array<string>(code.groups).fill(F);
    const written = Array<string>(code.groups).fill(HALF);
    this.passes = {
      depth: this.pass("depth", code.depth, ["depth"], ["r32float"]),
      encode: this.pass("encode", code.encode, [F], [HALF], false),
      downsample: this.pass("downsample", code.downsample, [F], [HALF], false),
      features: this.pass(
        "features",
        code.features,
        [U, U, F, F, F, F, F, F, F, F, F, F],
        // The first layer, and the evidence with this frame in it.
        [...written, HALF],
      ),
      stage: this.pass("stage", code.stage, sampled, written),
      predict: this.pass(
        "predict",
        code.predict,
        [...sampled, U],
        // Trust and filter strength.
        [HALF, "r16float"],
      ),
      resolve: this.pass(
        "resolve",
        code.resolve,
        [U, F, F, F, F, F, F, F, F, F],
        // Both history paths, their statistics, and the image shown.
        [HALF, HALF, HALF, HALF],
      ),
    };
    this.measureRounding(code.rounding);
  }

  protected layout(width: number, height: number, external: External) {
    const { passes, groups, lowLevel } = this;
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
    const output: Pair = [
      external.history[0].createView(),
      external.history[1].createView(),
    ];
    // State kept from frame to frame. The view depth is per 2x2 block.
    const depth: Pair = [scaled(2, "r32float"), scaled(2, "r32float")];
    const accumulated = pair();
    const denoised = pair();
    // Second moment of luma, the two history lengths, slow low-pass luma.
    const aux = pair();
    // The network runs on 4x4 blocks.
    const trust: Pair = [block(), block()];
    // Signed evidence, over a few frames, that a block's history lags.
    const evidence: Pair = [block(), block()];
    // Scratch of one frame. The network takes a block's colour from the
    // second level of the image pyramid.
    const color = external.encode ? full() : sceneColor;
    const levels = [color];
    for (let i = 1; i <= Math.max(lowLevel + 1, 2); i++)
      levels.push(scaled(2 ** i));
    // The network's layers write one of two sets of targets and read the other.
    const layers = [0, 1].map(() =>
      Array.from({ length: groups }, () => block()),
    );
    const strength = block("r16float");

    return (previous: number) => {
      const next = 1 - previous;
      const steps: Step[] = [
        [passes.depth, this.bind(passes.depth, [sceneDepth]), [depth[next]]],
      ];
      if (external.encode)
        steps.push([
          passes.encode,
          this.bind(passes.encode, [sceneColor]),
          [color],
        ]);
      for (let i = 1; i < levels.length; i++)
        steps.push([
          passes.downsample,
          this.bind(passes.downsample, [levels[i - 1]]),
          [levels[i]],
        ]);
      steps.push(
        [
          passes.features,
          this.bind(passes.features, [
            depth[next],
            depth[previous],
            color,
            levels[1],
            levels[2],
            levels[lowLevel],
            levels[lowLevel + 1],
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[previous],
            evidence[previous],
          ]),
          [...layers[0], evidence[next]],
        ],
        [passes.stage, this.bind(passes.stage, layers[0]), layers[1]],
        [
          passes.predict,
          this.bind(passes.predict, [...layers[1], depth[next]]),
          [trust[next], strength],
        ],
        [
          passes.resolve,
          this.bind(passes.resolve, [
            depth[next],
            levels[lowLevel],
            levels[lowLevel + 1],
            color,
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[next],
            strength,
            output[previous],
          ]),
          [accumulated[next], denoised[next], aux[next], output[next]],
        ],
      );
      return steps;
    };
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
  >(<T>(value: T) => ({ value }), [this.source, ...this.history], true);
  private passes: Passes | null = null;
  private readonly previousWorld = new Matrix4();
  private readonly previousProjection = new Matrix4();
  private readonly relative = new Matrix4();
  private readonly toPreviousClip = new Matrix4();
  private readonly drawingSize = new Vector2();
  private workingColorSpace = ColorManagement.workingColorSpace;
  private readonly pipelineStates = new WeakSet<object>();
  private pipelineRendering = false;
  private capturePending = true;

  /**
   * @param quality  Which of the three trained models runs: a larger one
   *   costs more GPU time for a steadier, cleaner image. Fixed for the node's
   *   lifetime.
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

  /** Scene depth of the current frame. */
  get depthTexture(): DepthTexture {
    return this.source.depthTexture;
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
      this.passes = model.lean
        ? new LeanPasses(backend.device, model)
        : new FullPasses(backend.device, model);
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
      const { x: width, y: height } = state.uniforms.renderSize.value;
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

      const encode =
        ColorManagement.getTransfer(this.workingColorSpace) === LinearTransfer;
      this.encoded.value = encode;
      const gpu = (texture: Texture) => {
        const data = backend.get(texture).texture;
        if (!data) throw new Error("NeuralDenoiseNode: texture not allocated");
        return data;
      };
      const previous = state.historyIndex;
      passes.render(
        width,
        height,
        {
          color: gpu(this.source.texture),
          depth: gpu(this.source.depthTexture),
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
    for (const target of this.history) target.dispose();
  }
}
