import * as THREE from "three";
import * as TSL from "three/tsl";
import { NodeMaterial } from "three/webgpu";

import type { GaussianSplatRenderer } from "./GaussianSplatRenderer";
import {
  type GaussianSplatCompatibleRenderer,
  assertSupportedRenderer,
  isWebGPURenderer,
  isXRRenderTarget,
  setRendererRenderTarget,
  setXRRenderTargetFlag,
} from "./renderer";
import {
  stochasticResolveMarker,
  stochasticResolveRequired,
} from "./stochasticResolveMarker";

// biome-ignore lint/suspicious/noExplicitAny: TSL nodes expose a dynamic fluent API.
type TSLNode = any;
const N = TSL as Record<string, TSLNode>;

const resolveVertexShader = /* glsl */ `
precision highp float;

void main() {
    gl_Position = vec4(position, 1.0);
}
`;

const resolveFragmentShader = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D sourceTexture;
uniform ivec2 sourceSize;
uniform bool resolveStochastic;
uniform bool perceptualResolve;
uniform bool sourceEncoded;

out vec4 fragColor;

vec4 loadSource(ivec2 coord) {
    return texelFetch(sourceTexture, clamp(coord, ivec2(0), sourceSize - 1), 0);
}

vec3 linearToPerceptual(vec3 color) {
    return pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
}

vec3 perceptualToLinear(vec3 color) {
    return pow(max(color, vec3(0.0)), vec3(2.2));
}

vec4 physicalSource(vec4 texel) {
    float alpha = texel.a > 1.0 ? 1.0 : clamp(texel.a, 0.0, 1.0);
    vec3 color = texel.rgb;
    if (sourceEncoded) {
        vec3 straight = alpha > 0.0 ? color / alpha : vec3(0.0);
        color = perceptualToLinear(straight) * alpha;
    }
    return vec4(color, alpha);
}

vec4 sourceToResolve(vec4 texel, float isSplat) {
    // Stochastic samples carry straight RGB while ordinary framebuffer pixels
    // are premultiplied.
    float alpha = mix(clamp(texel.a, 0.0, 1.0), 1.0, isSplat);
    vec3 straight = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    vec3 resolved = straight;
    if (perceptualResolve && !sourceEncoded) {
        resolved = linearToPerceptual(straight);
    } else if (!perceptualResolve && sourceEncoded) {
        resolved = perceptualToLinear(straight);
    }
    return vec4(resolved * alpha, alpha);
}

vec4 resolveToWorking(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 resolved = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    vec3 working = perceptualResolve ? perceptualToLinear(resolved) : resolved;
    return vec4(working * alpha, alpha);
}

vec4 resolveStochasticFrame(ivec2 source) {
    vec2 u = (vec2(source) - vec2(0.5)) * 0.5;
    vec2 quad = floor(u);
    vec2 fraction = u - quad;
    ivec2 base = ivec2(quad) * 2;

    vec2 nearWeights = (vec2(1.0) - fraction) * 0.5;
    vec2 farWeights = fraction * 0.5;

    float coverage = 0.0;
    vec3 splat = vec3(0.0);
    vec4 background = vec4(0.0);

    for (int y = 0; y < 4; ++y) {
        float weightY = y < 2 ? nearWeights.y : farWeights.y;
        for (int x = 0; x < 4; ++x) {
            float weightX = x < 2 ? nearWeights.x : farWeights.x;
            vec4 sourceTexel = loadSource(base + ivec2(x, y));
            float weight = weightX * weightY;
            float isSplat = float(sourceTexel.a > 1.0);
            vec4 texel = sourceToResolve(sourceTexel, isSplat);
            coverage += weight * isSplat;
            splat += weight * isSplat * texel.rgb;
            background += weight * (1.0 - isSplat) * texel;
        }
    }

    if (coverage <= 0.0) {
        return physicalSource(loadSource(source));
    }

    return resolveToWorking(
        vec4(splat + background.rgb, coverage + background.a)
    );
}

vec4 workingToOutput(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = alpha > 0.0 ? texel.rgb / alpha : vec3(0.0);
    #if defined(TONE_MAPPING)
        if (!sourceEncoded) color = toneMapping(color);
    #endif
    color = linearToOutputTexel(vec4(color, 1.0)).rgb;
    return vec4(color * alpha, alpha);
}

void main() {
    ivec2 source = ivec2(gl_FragCoord.xy);
    vec4 result = resolveStochastic
        ? resolveStochasticFrame(source)
        : physicalSource(loadSource(source));
    fragColor = workingToOutput(result);
}
`;

type ResolveState = {
  sourceTexture: { value: THREE.Texture };
  sourceSize: THREE.Vector2;
  resolve: { value: boolean };
  perceptual: { value: boolean };
  sourceEncoded: { value: boolean };
};

function createWebGPUResolveMaterial(state: ResolveState) {
  const source = N.textureLoad(state.sourceTexture.value).onObjectUpdate(
    () => state.sourceTexture.value,
  );
  const size = N.uniform(state.sourceSize, "ivec2").onObjectUpdate(
    () => state.sourceSize,
  );
  const resolve = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolve.value,
  );
  const perceptual = N.uniform(false, "bool").onObjectUpdate(
    () =>
      state.perceptual.value &&
      THREE.ColorManagement.workingColorSpace !== THREE.SRGBColorSpace,
  );

  const load = (coord: TSLNode) =>
    source.load(coord.clamp(N.ivec2(0), size.sub(1)));
  const linearToPerceptual = (color: TSLNode) => color.max(0).pow(1 / 2.2);
  const perceptualToLinear = (color: TSLNode) => color.max(0).pow(2.2);

  const physicalSource = (texel: TSLNode) => {
    const isSplat = texel.a.greaterThan(1);
    const alpha = N.select(isSplat, 1, texel.a.clamp(0, 1));
    return N.vec4(texel.rgb, alpha);
  };

  const sourceToResolve = (texel: TSLNode, isSplat: TSLNode) => {
    const alpha = N.select(isSplat, 1, texel.a.clamp(0, 1));
    const straight = N.select(
      alpha.greaterThan(0),
      texel.rgb.div(alpha),
      N.vec3(0),
    );
    const resolved = straight.toVar();
    N.If(perceptual, () => {
      resolved.assign(linearToPerceptual(straight));
    });
    return N.vec4(resolved.mul(alpha), alpha);
  };

  const resolveToWorking = (texel: TSLNode) => {
    const alpha = texel.a.clamp(0, 1);
    const resolved = N.select(
      alpha.greaterThan(0),
      texel.rgb.div(alpha),
      N.vec3(0),
    );
    const workingColor = resolved.toVar();
    N.If(perceptual, () => {
      workingColor.assign(perceptualToLinear(resolved));
    });
    return N.vec4(workingColor.mul(alpha), alpha);
  };

  const fragmentNode = N.Fn(() => {
    const sourceCoord = N.ivec2(N.screenCoordinate.xy);
    const result = N.vec4(0).toVar();
    const copySource = () => {
      result.assign(physicalSource(load(sourceCoord)));
    };

    N.If(resolve, () => {
      const u = N.vec2(sourceCoord).sub(0.5).mul(0.5);
      const quad = u.floor();
      const fraction = u.sub(quad);
      const base = N.ivec2(quad).mul(2);
      const nearWeights = N.vec2(1).sub(fraction).mul(0.5);
      const farWeights = fraction.mul(0.5);
      const coverage = N.float(0).toVar();
      const accumulated = N.vec4(0).toVar();

      for (let y = 0; y < 4; y += 1) {
        const weightY = y < 2 ? nearWeights.y : farWeights.y;
        for (let x = 0; x < 4; x += 1) {
          const weightX = x < 2 ? nearWeights.x : farWeights.x;
          const weight = weightX.mul(weightY);
          const sourceTexel = load(base.add(N.ivec2(x, y)));
          const splatSample = sourceTexel.a.greaterThan(1);
          const isSplat = N.select(splatSample, 1, 0);
          const texel = sourceToResolve(sourceTexel, splatSample);
          coverage.addAssign(weight.mul(isSplat));
          accumulated.addAssign(texel.mul(weight));
        }
      }

      N.If(coverage.greaterThan(0), () => {
        result.assign(resolveToWorking(accumulated));
      }).Else(copySource);
    }).Else(copySource);

    const alpha = result.a.clamp(0, 1);
    const straight = N.select(
      alpha.greaterThan(0),
      result.rgb.div(alpha),
      N.vec3(0),
    );
    return N.vec4(straight, alpha);
  })();

  const material = new NodeMaterial();
  material.colorNode = fragmentNode;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  material.premultipliedAlpha = true;
  material.toneMapped = true;
  return material;
}

/**
 * Optional stochastic spatial filter. It is structurally compatible with
 * Three.js EffectComposer and can also be called explicitly from a render graph.
 */
export class StochasticResolvePass {
  isPass = true;
  readonly isStochasticResolvePass = true;
  needsSwap = true;
  clear = false;
  renderToScreen = false;

  private _enabled = true;
  private disposed = false;
  private readonly splats = new Set<GaussianSplatRenderer>();
  private readonly sourceFallback = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  private readonly state: ResolveState;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly webGLMaterial: THREE.ShaderMaterial;
  private readonly webGPUMaterial: NodeMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly drawingBufferSize = new THREE.Vector2();
  private composeTarget: THREE.RenderTarget | null = null;

  constructor(splats: GaussianSplatRenderer | Iterable<GaussianSplatRenderer>) {
    this.sourceFallback.needsUpdate = true;
    this.state = {
      sourceTexture: { value: this.sourceFallback },
      sourceSize: new THREE.Vector2(1, 1),
      resolve: { value: false },
      perceptual: { value: false },
      sourceEncoded: { value: false },
    };

    this.webGLMaterial = new THREE.ShaderMaterial({
      name: "GaussianSplatStochasticResolve",
      glslVersion: THREE.GLSL3,
      vertexShader: resolveVertexShader,
      fragmentShader: resolveFragmentShader,
      uniforms: {
        sourceTexture: this.state.sourceTexture,
        sourceSize: { value: this.state.sourceSize },
        resolveStochastic: this.state.resolve,
        perceptualResolve: this.state.perceptual,
        sourceEncoded: this.state.sourceEncoded,
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      premultipliedAlpha: true,
      toneMapped: true,
    });
    this.webGPUMaterial = createWebGPUResolveMaterial(this.state);

    this.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
    );
    this.mesh = new THREE.Mesh(this.geometry, this.webGLMaterial);
    this.mesh.frustumCulled = false;

    if (Symbol.iterator in Object(splats)) {
      for (const splat of splats as Iterable<GaussianSplatRenderer>) {
        this.addSplatRenderer(splat);
      }
    } else {
      this.addSplatRenderer(splats as GaussianSplatRenderer);
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    const enabled = Boolean(value);
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    for (const splat of this.splats) {
      splat[stochasticResolveMarker](enabled);
    }
  }

  addSplatRenderer(splat: GaussianSplatRenderer) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    if (this.splats.has(splat)) return;
    this.splats.add(splat);
    if (this._enabled) splat[stochasticResolveMarker](true);
  }

  removeSplatRenderer(splat: GaussianSplatRenderer): boolean {
    if (!this.splats.delete(splat)) return false;
    if (this._enabled) splat[stochasticResolveMarker](false);
    return true;
  }

  setSize(_width: number, _height: number) {}

  private requiresResolve(
    camera: THREE.Camera,
    renderer: GaussianSplatCompatibleRenderer,
  ) {
    for (const splat of this.splats) {
      if (splat[stochasticResolveRequired](camera, renderer)) return true;
    }
    return false;
  }

  private hasActiveStochasticSplat() {
    for (const splat of this.splats) {
      if (splat.stochasticActive) return true;
    }
    return false;
  }

  /** Renders a complete scene, then resolves its marked Splat pixels. */
  compose(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    assertSupportedRenderer(renderer);
    if (renderer.getRenderTarget() !== null) {
      throw new Error(
        "StochasticResolvePass.compose() renders to the canvas; use resolve() inside a custom render graph",
      );
    }

    const previousAutoClear = renderer.autoClear;
    try {
      if (!this._enabled || renderer.xr.isPresenting) {
        renderer.render(scene, camera);
      } else {
        // A WebGL canvas blends the library's stored sRGB Splat colors in the
        // output domain, while a regular offscreen target blends in working
        // linear space. Avoid that visible color change on already-sorted
        // frames, where there is nothing for this pass to resolve.
        camera.updateWorldMatrix(true, false);
        if (!this.requiresResolve(camera, renderer)) {
          renderer.render(scene, camera);
          return;
        }

        renderer.getDrawingBufferSize(this.drawingBufferSize);
        const width = this.drawingBufferSize.x;
        const height = this.drawingBufferSize.y;
        if (!this.composeTarget) {
          this.composeTarget = new THREE.RenderTarget(width, height, {
            type: THREE.HalfFloatType,
            depthBuffer: true,
          });
          this.composeTarget.texture.name =
            "StochasticResolvePass.composeColor";
        } else {
          this.composeTarget.setSize(width, height);
        }

        // WebGL's canvas applies its sRGB conversion before fixed-function
        // blending. Marking this float target as an output target reproduces
        // that ordering, so transparent objects over Splats do not brighten.
        const sourceEncoded =
          !isWebGPURenderer(renderer) &&
          renderer.outputColorSpace === THREE.SRGBColorSpace;
        const composeTarget = this.composeTarget;
        setXRRenderTargetFlag(composeTarget, sourceEncoded);
        composeTarget.texture.colorSpace = sourceEncoded
          ? THREE.SRGBColorSpace
          : THREE.NoColorSpace;

        renderer.autoClear = false;
        setRendererRenderTarget(renderer, this.composeTarget);
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
        renderer.render(scene, camera);
        setRendererRenderTarget(renderer, null);
        this.resolve(renderer, this.composeTarget, null);
      }
    } finally {
      setRendererRenderTarget(renderer, null);
      renderer.autoClear = previousAutoClear;
    }
  }

  /** EffectComposer-compatible entry point. Add this before OutputPass. */
  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    _deltaTime?: number,
    _maskActive?: boolean,
  ) {
    this.resolve(
      renderer,
      readBuffer,
      this.renderToScreen ? null : writeBuffer,
    );
  }

  /** Explicit WebGL/WebGPU render-graph entry point. */
  resolve(
    renderer: GaussianSplatCompatibleRenderer,
    input: THREE.RenderTarget,
    destination: THREE.RenderTarget | null,
  ) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    assertSupportedRenderer(renderer);
    if (
      input.texture.type !== THREE.HalfFloatType &&
      input.texture.type !== THREE.FloatType
    ) {
      throw new Error(
        "StochasticResolvePass requires a HalfFloatType or FloatType input target",
      );
    }
    if (destination === input || destination?.texture === input.texture) {
      throw new Error(
        "StochasticResolvePass input and destination must differ",
      );
    }

    const width = input.width;
    const height = input.height;
    if (destination) {
      if (destination.width !== width || destination.height !== height) {
        throw new Error(
          "StochasticResolvePass input and destination sizes must match",
        );
      }
    } else {
      renderer.getDrawingBufferSize(this.drawingBufferSize);
      if (
        this.drawingBufferSize.x !== width ||
        this.drawingBufferSize.y !== height
      ) {
        throw new Error(
          "StochasticResolvePass input and drawing-buffer sizes must match",
        );
      }
    }

    this.state.sourceTexture.value = input.texture;
    this.state.sourceSize.set(width, height);
    this.state.resolve.value = this._enabled && this.hasActiveStochasticSplat();

    const webGPU = isWebGPURenderer(renderer);
    const sourceColorSpace =
      !webGPU && isXRRenderTarget(input)
        ? input.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
    const sourceIsPerceptual =
      THREE.ColorManagement.getTransfer(sourceColorSpace) ===
      THREE.SRGBTransfer;
    this.state.perceptual.value = sourceIsPerceptual;
    this.state.sourceEncoded.value = !webGPU && sourceIsPerceptual;

    const material = webGPU ? this.webGPUMaterial : this.webGLMaterial;
    this.mesh.material = material;

    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    try {
      setRendererRenderTarget(renderer, destination);
      if (this.clear) {
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
      }
      renderer.render(this.mesh, this.camera);
    } finally {
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
    }
  }

  dispose() {
    if (this.disposed) return;
    if (this._enabled) {
      for (const splat of this.splats) {
        splat[stochasticResolveMarker](false);
      }
    }
    this.splats.clear();
    this.webGLMaterial.dispose();
    this.webGPUMaterial.dispose();
    this.geometry.dispose();
    this.sourceFallback.dispose();
    this.composeTarget?.dispose();
    this.composeTarget = null;
    this.disposed = true;
  }
}
