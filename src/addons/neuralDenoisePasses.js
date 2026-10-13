import {
  NEURAL_DENOISE_UNIFORM_FLOATS,
  neuralDenoiseShaders,
} from "./neuralDenoiseShaders.js";
const HALF = "rgba16float";
const DEPTH = "rg32float";
const CELLS = "rgba32float";
const EXPOSED = "depth32float";
const FILTERABLE = "float";
const UNFILTERABLE = "unfilterable-float";

// Shared pass order and state layout. Each backend supplies textures, bindings
// and draws; all backends use the same model and history.
export class NeuralDenoisePasses {
  uniforms = new Float32Array(NEURAL_DENOISE_UNIFORM_FLOATS);
  /** Half a unit in the last place where the GPU truncates half-float writes, else 0. */
  halfBias = 0;
  width = 0;
  height = 0;
  external = null;
  frames = [];
  filter;
  compact;
  passes;
  /** The network's hidden channels, in groups of four: render targets per layer. */
  groups;
  multisampled;
  initialize(model, multisampled) {
    this.compact = model.compact === true;
    this.multisampled = multisampled;
    const code = neuralDenoiseShaders(model, multisampled);
    this.groups = code.groups;
    const F = FILTERABLE;
    const U = UNFILTERABLE;
    // One render target, and one input texture, per group of hidden channels.
    const sampled = Array(code.groups).fill(F);
    const written = Array(code.groups).fill(HALF);
    this.passes = {
      // What was drawn in cells of 8 pixels and, three times over, in cells
      // four times as wide: a block with no depth of its own takes one there.
      cells: this.pass("cells", code.cells, ["depth"], [CELLS]),
      wider: this.pass("wider", code.wider, [U], [CELLS], false),
      // The block's depth, whether it is its own, and the first color level.
      depth: this.pass(
        "depth",
        code.depth,
        ["depth", U, U, U, U, F],
        [DEPTH, HALF],
      ),
      expose: this.pass("expose", code.expose, ["depth"], [], true, true),
      encode: this.pass("encode", code.encode, [F], [HALF]),
      downsample: this.pass("downsample", code.downsample, [F], [HALF], false),
      features: this.pass(
        "features",
        code.features,
        [U, U, F, F, ...(this.compact ? [] : [F]), F, F, F, F, F, F],
        // The first layer, and the evidence with this frame in it.
        [...written, HALF, ...(this.compact ? [HALF] : [])],
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
        [
          U,
          F,
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
          // The existing 4x4 frame mean for rejected learned-filter history.
          F,
        ],
        // Both history paths, their statistics, and the image shown.
        [HALF, HALF, HALF, HALF],
      ),
    };
    this.filter = this.compact ? null : this.filterPasses(code.filter);
    return code.rounding;
  }
  filterPasses(filter) {
    const F = FILTERABLE;
    const read = Array(filter.groups).fill(F);
    const wrote = Array(filter.groups).fill(HALF);
    const last = filter.encode.length - 1;
    return {
      // The level, the finer one, and from the level below its result and
      // hidden channels.
      encode: filter.encode.map((shader, i) =>
        this.pass(
          `filterEncode${i}`,
          shader,
          i === last ? [F] : [F, F, F, ...read],
          i === last ? [...wrote, HALF] : wrote,
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
  filterSteps(filter, levels, filterLevels, filtered) {
    const steps = [];
    const color = levels[0];
    for (let i = filterLevels.length - 1; i >= 0; i--) {
      const { encoded, hidden, result } = filterLevels[i];
      const below = filterLevels[i + 1];
      steps.push(
        [
          filter.encode[i],
          this.bind(filter.encode[i], [
            ...(below ? [levels[i + 1]] : []),
            levels[i],
            ...(below ? [below.result, ...below.hidden] : []),
          ]),
          below ? encoded : [...encoded, levels[i + 1]],
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
  layout(width, height, external) {
    const { passes, groups, filter } = this;
    const full = (format = HALF) => this.texture(format, width, height);
    const pair = (format = HALF) => [full(format), full(format)];
    const scaled = (divisor, format = HALF) =>
      this.texture(
        format,
        Math.max(1, Math.floor(width / divisor)),
        Math.max(1, Math.floor(height / divisor)),
      );
    const block = (format = HALF) => scaled(4, format);
    const sceneColor = this.view(external.color);
    const sceneDepth = this.view(external.depth, true);
    const exposed = external.exposed && this.view(external.exposed);
    const output = this.outputViews(external.history, width, height);
    // State kept from frame to frame. The view depth is per 2x2 block.
    const depth = [scaled(2, DEPTH), scaled(2, DEPTH)];
    const accumulated = pair();
    const denoised = pair();
    // Second moment of luma, the two history lengths, slow low-pass luma.
    const aux = pair();
    // The network runs on 4x4 blocks.
    const trust = [block(), block()];
    // Signed evidence, over a few frames, that a block's history lags.
    const evidence = [block(), block()];
    // Scratch of one frame. What was drawn, in cells of 8, 32, 128 and 512
    // pixels.
    const cells = [8, 32, 128, 512].map((width) => scaled(width, CELLS));
    // Reuse the captured colour, including an MSAA resolve. Only a linear
    // working colour space needs an encoded copy; frame sampling accounts
    // for the capture's margin. The network reads the second pyramid level.
    const color = external.encode ? full() : sceneColor;
    const levels = [color];
    const filterLevels = [];
    const levelCount = this.compact ? 2 : filter.encode.length;
    for (let i = 1; i <= levelCount; i++) {
      const level = () => scaled(2 ** i);
      levels.push(level());
      if (!this.compact)
        filterLevels.push({
          encoded: Array.from({ length: filter.groups }, level),
          hidden: Array.from({ length: filter.groups }, level),
          result: level(),
        });
    }
    const filtered = this.compact ? color : full();
    // The network's layers write one of two sets of targets and read the other.
    const layers = [0, 1].map(() =>
      Array.from({ length: groups }, () => block()),
    );
    const strength = block("r16float");
    return (previous) => {
      const next = 1 - previous;
      const steps = [
        [passes.cells, this.bind(passes.cells, [sceneDepth]), [cells[0]]],
      ];
      for (let i = 1; i < cells.length; i++)
        steps.push([
          passes.wider,
          this.bind(passes.wider, [cells[i - 1]]),
          [cells[i]],
        ]);
      if (exposed)
        steps.push([
          passes.expose,
          this.bind(passes.expose, [sceneDepth]),
          [],
          exposed,
        ]);
      if (external.encode)
        steps.push([
          passes.encode,
          this.bind(passes.encode, [sceneColor]),
          [color],
        ]);
      steps.push([
        passes.depth,
        this.bind(passes.depth, [sceneDepth, ...cells, color]),
        [depth[next], levels[1]],
      ]);
      for (let i = 2; i < levels.length - 1; i++) {
        steps.push([
          passes.downsample,
          this.bind(passes.downsample, [levels[i - 1]]),
          [levels[i]],
        ]);
      }
      if (!this.compact)
        steps.push(...this.filterSteps(filter, levels, filterLevels, filtered));
      steps.push(
        [
          passes.features,
          this.bind(passes.features, [
            depth[next],
            depth[previous],
            color,
            levels[1],
            ...(this.compact ? [] : [levels[2]]),
            filtered,
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[previous],
            evidence[previous],
          ]),
          [...layers[0], evidence[next], ...(this.compact ? [levels[2]] : [])],
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
            filtered,
            color,
            accumulated[previous],
            denoised[previous],
            aux[previous],
            trust[next],
            strength,
            output[previous],
            // Half-resolution fallback: the current mean or learned filter.
            this.compact ? levels[1] : filterLevels[0].result,
            depth[previous],
            levels[2],
          ]),
          [accumulated[next], denoised[next], aux[next], output[next]],
        ],
      );
      return steps;
    };
  }
}

export class WebGPUDenoisePasses extends NeuralDenoisePasses {
  textures = [];
  constructor(device, model, multisampled) {
    super();
    this.device = device;
    this.multisampled = multisampled;
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
    this.measureRounding(this.initialize(model, multisampled));
  }
  view(texture, depth = false) {
    return texture.createView(depth ? { aspect: "depth-only" } : {});
  }
  outputViews(history) {
    return history.map((texture) => this.view(texture));
  }
  pass(name, code, inputs, targets, uniforms = true, depth = false) {
    const { device } = this;
    const label = `NeuralDenoise.${name}`;
    const module = device.createShaderModule({ label, code });
    const visibility = GPUShaderStage.FRAGMENT;
    const entries = uniforms
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
        texture: {
          sampleType,
          multisampled: this.multisampled && sampleType === "depth",
        },
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
  measureRounding(code) {
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
  texture(format, width, height) {
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
  bind(pass, views) {
    const resources = [this.sampler, ...views];
    if (pass.uniforms) resources.unshift({ buffer: this.uniformBuffer });
    return this.device.createBindGroup({
      layout: pass.layout,
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
  }
  prepare(width, height, external) {
    for (const texture of this.textures) texture.destroy();
    this.textures = [];
    this.width = width;
    this.height = height;
    this.external = external;
    const steps = this.layout(width, height, external);
    // The two frames that alternate.
    this.frames = [0, 1].map((previous) => {
      const frame = steps(previous);
      return (encoder) => {
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
  render(width, height, external, previous) {
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
