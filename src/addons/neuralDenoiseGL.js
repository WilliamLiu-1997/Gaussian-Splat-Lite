import {
  AlwaysDepth,
  FloatType,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  NeverDepth,
  NoBlending,
  RGBAFormat,
  RGFormat,
  RawShaderMaterial,
  RedFormat,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import * as N from "three/tsl";
import { NodeMaterial, QuadMesh, RenderTarget } from "three/webgpu";
import { neuralDenoiseGLSL } from "./neuralDenoiseGLSL.js";
import { NeuralDenoisePasses } from "./neuralDenoisePasses.js";

const vertexShader = /* glsl */ `
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const parameterTypes = ["mat4", "mat4", ...Array(9).fill("vec4")];
const parameterNames = parameterTypes.map((_, i) => `ndUniform${i}`);
const parameters = parameterTypes.map(
  (type, i) => `${type} ${parameterNames[i]}`,
);
const prepareParams = /* glsl */ `
P.toPrevClip = ndUniform0; P.toClip = ndUniform1;
P.toPrevViewZ = ndUniform2; P.unprojectA = ndUniform3;
P.unprojectB = ndUniform4; P.depth = ndUniform5;
P.size = ndUniform6.xy; P.invSize = ndUniform6.zw;
P.far = ndUniform7.x; P.clearDepth = ndUniform7.y;
P.historyValid = ndUniform7.z; P.stabilize = ndUniform7.w;
P.halfBias = ndUniform8.x; P.logDepth = ndUniform8.y;
P.logNear = ndUniform8.z; P.logFar = ndUniform8.w;
P.turn = ndUniform9.x; P.cameraStill = ndUniform9.y; P.offset = ndUniform9.zw;
P.colorOffset = ndUniform10.xy;
`;

/** Executes the shared denoiser on either Three.js WebGL2 renderer. */
export class WebGLDenoisePasses extends NeuralDenoisePasses {
  constructor(renderer, model) {
    super();
    this.renderer = renderer;
    this.nodeRenderer = renderer.isWebGPURenderer === true;
    if (!renderer.getContext().getExtension("EXT_color_buffer_float"))
      throw new Error("Neural denoising requires EXT_color_buffer_float");
    this.Target = this.nodeRenderer ? RenderTarget : WebGLRenderTarget;
    this.quad = this.nodeRenderer ? new QuadMesh() : new FullScreenQuad();
    this.targets = [];
    this.materials = new Map();
    this.values = [
      new Matrix4(),
      new Matrix4(),
      ...Array.from({ length: 9 }, () => new Vector4()),
    ];
    this.initialize(model, false);
    this.roundingMeasured = false;
  }
  pass(name, wgsl) {
    return { name, shader: neuralDenoiseGLSL(wgsl) };
  }
  texture(format, width, height) {
    return { id: this.nextTexture++, format, width, height, texture: null };
  }
  view(texture) {
    return { texture };
  }
  outputViews(history, width, height) {
    this.output = [0, 1].map(() => this.texture("rgba16float", width, height));
    return this.output;
  }
  bind(pass, views) {
    return views;
  }
  measureRounding() {
    this.roundingMeasured = true;
    const value = new Vector4(1 + 0.75 / 1024, 0, 0, 1);
    const target = new this.Target(1, 1, {
      type: HalfFloatType,
      depthBuffer: false,
    });
    const material = this.nodeRenderer
      ? new NodeMaterial()
      : new RawShaderMaterial({
          glslVersion: GLSL3,
          vertexShader,
          fragmentShader:
            "precision highp float; uniform vec4 value; out vec4 color; void main() { color = value; }",
          uniforms: { value: { value } },
        });
    if (this.nodeRenderer) material.fragmentNode = N.uniform(value);
    material.depthTest = material.depthWrite = false;
    material.blending = NoBlending;
    this.renderer.setRenderTarget(target);
    this.quad.material = material;
    this.quad.render(this.renderer);
    const read = this.nodeRenderer
      ? this.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1)
      : this.renderer.readRenderTargetPixelsAsync(
          target,
          0,
          0,
          1,
          1,
          new Uint16Array(4),
        );
    this.rounding = read
      .then(
        (pixels) => {
          this.halfBias = pixels[0] === 0x3c00 ? 0.5 : 0;
        },
        () => {},
      )
      .finally(() => {
        target.dispose();
        material.dispose();
      });
  }
  allocate(views, depth) {
    const target = new this.Target(
      views[0]?.width ?? this.width,
      views[0]?.height ?? this.height,
      {
        count: Math.max(1, views.length),
        type: HalfFloatType,
        depthBuffer: !!depth,
        ...(depth && { depthTexture: depth.texture }),
      },
    );
    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const texture = target.textures[i];
      texture.type = view.format.includes("32float")
        ? FloatType
        : HalfFloatType;
      texture.format = view.format.startsWith("rgba")
        ? RGBAFormat
        : view.format.startsWith("rg")
          ? RGFormat
          : RedFormat;
      texture.minFilter = texture.magFilter =
        texture.type === FloatType ? NearestFilter : LinearFilter;
      texture.name = "NeuralDenoise.state";
      view.texture = texture;
    }
    this.targets.push(target);
    return target;
  }
  material(pass) {
    const { shader } = pass;
    const count = Math.max(1, shader.members.length);
    const declarations = [];
    const uniforms = {};
    for (const { name } of shader.textures) {
      declarations.push(`uniform sampler2D ${name};`);
      uniforms[name] = this.nodeRenderer
        ? N.texture().setName(name)
        : { value: null };
      if (this.nodeRenderer) uniforms[name].mergeable = false;
    }
    for (let i = 0; i < parameters.length; i++) {
      declarations.push(`uniform ${parameters[i]};`);
      uniforms[parameterNames[i]] = this.nodeRenderer
        ? N.uniform(this.values[i])
        : { value: this.values[i] };
    }
    uniforms.ndTargetSize = this.nodeRenderer
      ? N.uniform(new Vector2())
      : { value: new Vector2() };
    const result = shader.members.length
      ? `Output result = ndFragment(position);\n${shader.members.map((name, i) => `ndOut${i} = result.${name};`).join("\n")}`
      : "ndOut0 = ndFragment(position);";
    const outputs = Array.from(
      { length: count },
      (_, i) => `${shader.depth ? "float" : "vec4"} ndOut${i}`,
    );
    const body = `${shader.params ? prepareParams : ""}\nvec4 position = vec4(gl_FragCoord.x, ndTargetSize.y - gl_FragCoord.y, 0.0, 1.0);\n${result}`;
    let material;
    if (this.nodeRenderer) {
      // glslFn uses TSL's `texture` input type for a texture reference. Limit
      // its GLSL spelling to this function, without changing Three's shaders.
      const textureArgs = shader.textures.map(
        ({ name }) => `texture nd_${name}`,
      );
      const fn = N.glslFn(
        `${shader.code}\n#define texture sampler2D\n#pragma main\n${shader.depth ? "float" : "vec4"} ndRun(${[...textureArgs, ...parameters, "vec2 ndTargetSize", ...outputs.slice(1).map((o) => `out ${o}`)].join(", ")}) {\n${outputs[0]};\n${body}\nreturn ndOut0;\n}\n#undef texture`,
      );
      material = new NodeMaterial();
      const values = Array.from({ length: count }, () =>
        N.property(shader.depth ? "float" : "vec4"),
      );
      const execute = N.Fn(() => {
        const args = [];
        for (const { name } of shader.textures) args.push(uniforms[name]);
        for (const name of parameterNames) args.push(uniforms[name]);
        args.push(uniforms.ndTargetSize);
        values[0].assign(fn(...args, ...values.slice(1)));
        return values[0];
      })();
      if (shader.depth) {
        material.depthNode = execute;
        material.fragmentNode = N.vec4(0);
      } else {
        material.fragmentNode =
          count === 1 ? execute : N.outputStruct(execute, ...values.slice(1));
      }
    } else {
      material = new RawShaderMaterial({
        glslVersion: GLSL3,
        uniforms,
        vertexShader,
        fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n${declarations.join("\n")}\nuniform vec2 ndTargetSize;\n${shader.code}\n${shader.depth ? "layout(location=0) out vec4 ndColor;" : outputs.map((o, i) => `layout(location=${i}) out ${o};`).join("\n")}\nvoid main() {\n${shader.depth ? "float ndOut0;" : ""}\n${body}\n${shader.depth ? "gl_FragDepth = ndOut0; ndColor = vec4(0.0);" : ""}\n}`,
      });
    }
    material.name = `NeuralDenoise.${pass.name}`;
    material.blending = NoBlending;
    material.depthWrite = material.depthTest = shader.depth;
    material.toneMapped = false;
    return { material, uniforms };
  }
  prepare(width, height, external) {
    for (const target of this.targets) target.dispose();
    this.targets = [];
    this.width = width;
    this.height = height;
    this.external = external;
    this.nextTexture = 0;
    const steps = this.layout(width, height, external);
    const frames = [steps(0), steps(1)];
    const targets = new Map();
    for (const frame of frames) {
      for (const step of frame) {
        // A scratch attachment accompanies a different history attachment on
        // each side. Cache the whole set and bind its textures when drawing.
        const key = step[2].map((view) => view.id).join(",");
        if (!targets.has(key))
          targets.set(key, this.allocate(step[2], step[3]));
        step[4] = targets.get(key);
      }
    }
    this.frames = frames;
  }
  render(width, height, external, previous) {
    if (!this.roundingMeasured) this.measureRounding();
    const current = this.external;
    if (
      !current ||
      this.width !== width ||
      this.height !== height ||
      current.color !== external.color ||
      current.depth !== external.depth ||
      current.exposed !== external.exposed ||
      current.encode !== external.encode
    )
      this.prepare(width, height, external);
    this.values[0].fromArray(this.uniforms, 0);
    this.values[1].fromArray(this.uniforms, 16);
    for (let i = 0; i < 9; i++)
      this.values[i + 2].fromArray(this.uniforms, 32 + i * 4);
    const renderer = this.renderer;
    for (const [pass, inputs, outputs, , target] of this.frames[previous]) {
      outputs.forEach((view, i) => {
        view.texture = target.textures[i];
      });
      let draw = this.materials.get(pass);
      if (!draw) {
        draw = this.material(pass);
        this.materials.set(pass, draw);
      }
      pass.shader.textures.forEach(({ name }, i) => {
        draw.uniforms[name].value = inputs[i].texture;
      });
      draw.uniforms.ndTargetSize.value.set(target.width, target.height);
      draw.material.depthFunc = (
        this.nodeRenderer
          ? renderer.reversedDepthBuffer
          : renderer.capabilities.reversedDepthBuffer
      )
        ? NeverDepth
        : AlwaysDepth;
      renderer.setRenderTarget(target);
      this.quad.material = draw.material;
      this.quad.render(renderer);
    }
    this.result = this.output[1 - previous].texture;
  }
  dispose() {
    for (const target of this.targets) target.dispose();
    for (const { material } of this.materials.values()) material.dispose();
    this.quad.dispose?.();
    this.targets = [];
    this.materials.clear();
    this.frames = [];
    this.external = null;
  }
}
