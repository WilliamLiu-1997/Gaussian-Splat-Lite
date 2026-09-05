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
uniform sampler2D sourceDepth;
uniform ivec4 sourceRect;
uniform ivec2 outputOrigin;
uniform bool copyDepth;
uniform bool resolveStochastic;
uniform bool sourceEncoded;

out vec4 fragColor;

vec4 loadSource(ivec2 coord) {
    return texelFetch(sourceTexture,
        sourceRect.xy + clamp(coord, ivec2(0), sourceRect.zw - 1), 0);
}

vec3 perceptualToLinear(vec3 color) {
    return pow(max(color, vec3(0.0)), vec3(2.2));
}

vec4 physicalSource(vec4 texel) {
    float alpha = clamp(texel.a, 0.0, 1.0);
    vec3 color = texel.rgb;
    if (sourceEncoded) {
        vec3 straight = alpha > 0.0 ? color / alpha : vec3(0.0);
        color = perceptualToLinear(straight) * alpha;
    }
    return vec4(color, alpha);
}

vec4 resolveStochasticFrame(ivec2 source) {
    vec2 u = (vec2(source) - vec2(0.5)) * 0.5;
    vec2 quad = floor(u);
    vec2 fraction = u - quad;
    ivec2 base = ivec2(quad) * 2;

    vec2 nearWeights = (vec2(1.0) - fraction) * 0.5;
    vec2 farWeights = fraction * 0.5;

    float coverage = 0.0;
    vec4 accumulated = vec4(0.0);

    for (int y = 0; y < 4; ++y) {
        float weightY = y < 2 ? nearWeights.y : farWeights.y;
        for (int x = 0; x < 4; ++x) {
            float weightX = x < 2 ? nearWeights.x : farWeights.x;
            vec4 sourceTexel = loadSource(base + ivec2(x, y));
            float weight = weightX * weightY;
            float isSplat = float(sourceTexel.a > 1.0);
            // Filter in the source's blend space. Alpha-2 marks an opaque sample.
            float alpha = clamp(sourceTexel.a, 0.0, 1.0);
            vec4 texel = vec4(alpha > 0.0 ? sourceTexel.rgb : vec3(0.0), alpha);
            coverage += weight * isSplat;
            accumulated += weight * texel;
        }
    }

    return physicalSource(coverage > 0.0 ? accumulated : loadSource(source));
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
    ivec2 source = ivec2(gl_FragCoord.xy) - outputOrigin;
    vec4 result = resolveStochastic
        ? resolveStochasticFrame(source)
        : physicalSource(loadSource(source));
    fragColor = workingToOutput(result);
    gl_FragDepth = copyDepth
        ? texelFetch(sourceDepth, sourceRect.xy + source, 0).r
        : gl_FragCoord.z;
}
`;

type ResolveState = {
  sourceTexture: { value: THREE.Texture };
  sourceDepth: { value: THREE.DepthTexture };
  sourceRect: THREE.Vector4;
  sourceViews: THREE.Vector4[];
  outputOrigins: THREE.Vector2[];
  outputOrigin: THREE.Vector2;
  copyDepth: { value: boolean };
  resolve: { value: boolean };
  sourceEncoded: { value: boolean };
};

function createWebGPUResolveMaterial(state: ResolveState) {
  const source = N.textureLoad(state.sourceTexture.value).onObjectUpdate(
    () => state.sourceTexture.value,
  );
  const resolve = N.uniform(false, "bool").onObjectUpdate(
    () => state.resolve.value,
  );
  const perceptual = N.uniform(false, "bool").onObjectUpdate(() => {
    const working = THREE.ColorManagement.workingColorSpace;
    return (
      working !== THREE.SRGBColorSpace &&
      THREE.ColorManagement.getTransfer(working) === THREE.SRGBTransfer
    );
  });

  const linearToPerceptual = (color: TSLNode) => color.max(0).pow(1 / 2.2);
  const perceptualToLinear = (color: TSLNode) => color.max(0).pow(2.2);

  const physicalSource = (texel: TSLNode) =>
    N.vec4(texel.rgb, texel.a.clamp(0, 1));

  const sourceToResolve = (texel: TSLNode) => {
    const alpha = texel.a.clamp(0, 1);
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

  const view = N.Fn(({ camera }: { camera: THREE.Camera }) => {
    if ((camera as THREE.ArrayCamera).isArrayCamera) {
      return N.uniformArray(state.sourceViews, "vec4").element(N.cameraIndex);
    }
    return N.uniform(state.sourceRect, "vec4");
  })();
  const origin = N.Fn(({ camera }: { camera: THREE.Camera }) =>
    (camera as THREE.ArrayCamera).isArrayCamera
      ? N.uniformArray(state.outputOrigins, "vec2").element(N.cameraIndex)
      : N.uniform(state.outputOrigin, "vec2"),
  )();
  const sourceCoord = N.ivec2(N.screenCoordinate.xy.sub(origin));
  const sourceRect = N.ivec4(view);
  const load = (coord: TSLNode) =>
    source.load(
      sourceRect.xy.add(coord.clamp(N.ivec2(0), sourceRect.zw.sub(1))),
    );
  const fragmentNode = N.Fn(() => {
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
          const texel = sourceToResolve(sourceTexel);
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
  material.vertexNode = N.vec4(N.positionLocal, 1);
  material.colorNode = fragmentNode;
  material.outputNode = N.renderOutput(
    N.output,
    THREE.NoToneMapping,
    THREE.NoColorSpace,
  );
  const depth = N.textureLoad(state.sourceDepth.value).onObjectUpdate(
    () => state.sourceDepth.value,
  );
  // NodeMaterial includes this node only when depthTest/depthWrite are enabled.
  material.depthNode = depth.load(sourceRect.xy.add(sourceCoord)).r;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.depthFunc = THREE.AlwaysDepth;
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
  private readonly depthFallback = new THREE.DepthTexture(1, 1);
  private readonly xrCamera = new THREE.ArrayCamera();
  private outputCamera: THREE.ArrayCamera | null = null;
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
      sourceDepth: { value: this.depthFallback },
      sourceRect: new THREE.Vector4(0, 0, 1, 1),
      sourceViews: [],
      outputOrigins: [],
      outputOrigin: new THREE.Vector2(),
      copyDepth: { value: false },
      resolve: { value: false },
      sourceEncoded: { value: false },
    };

    this.webGLMaterial = new THREE.ShaderMaterial({
      name: "GaussianSplatStochasticResolve",
      glslVersion: THREE.GLSL3,
      vertexShader: resolveVertexShader,
      fragmentShader: resolveFragmentShader,
      uniforms: {
        sourceTexture: this.state.sourceTexture,
        sourceDepth: this.state.sourceDepth,
        sourceRect: { value: this.state.sourceRect },
        outputOrigin: { value: this.state.outputOrigin },
        copyDepth: this.state.copyDepth,
        resolveStochastic: this.state.resolve,
        sourceEncoded: this.state.sourceEncoded,
      },
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      depthFunc: THREE.AlwaysDepth,
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
    this.mesh.layers.enableAll();
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      const index = this.outputCamera?.cameras.indexOf(
        camera as THREE.PerspectiveCamera,
      );
      const viewport = (camera as THREE.PerspectiveCamera).viewport;
      if (index !== undefined && index >= 0 && viewport) {
        this.state.sourceRect.copy(this.state.sourceViews[index]);
        this.state.outputOrigin.set(viewport.x, viewport.y);
        this.webGLMaterial.uniformsNeedUpdate = true;
      }
    };

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

  private xrTarget(
    renderer: GaussianSplatCompatibleRenderer,
    target = renderer.getRenderTarget(),
  ) {
    if (!renderer.xr.isPresenting) return null;
    return isWebGPURenderer(renderer)
      ? renderer.getOutputRenderTarget()
      : isXRRenderTarget(target)
        ? target
        : null;
  }

  /** Pack the eyes into one reusable 2D input, independent of XR layer layout. */
  private prepareXRViews(
    camera: THREE.ArrayCamera,
    renderCamera?: THREE.ArrayCamera,
  ) {
    if (renderCamera) {
      renderCamera.copy(camera, false);
      renderCamera.matrixWorldAutoUpdate = false;
      renderCamera.cameras.length = camera.cameras.length;
    }
    this.state.sourceViews.length = camera.cameras.length;
    this.state.outputOrigins.length = camera.cameras.length;
    let width = 0;
    let height = 0;
    camera.cameras.forEach((eye, i) => {
      const viewport = eye.viewport;
      if (!viewport) throw new Error("XR views must have a viewport");
      this.state.outputOrigins[i] ??= new THREE.Vector2();
      this.state.outputOrigins[i].set(viewport.x, viewport.y);
      this.state.sourceViews[i] ??= new THREE.Vector4();
      this.state.sourceViews[i].set(width, 0, viewport.z, viewport.w);
      if (renderCamera) {
        renderCamera.cameras[i] ??= new THREE.PerspectiveCamera();
        const copy = renderCamera.cameras[i];
        copy.copy(eye, false);
        copy.matrixWorldAutoUpdate = false;
        copy.viewport = this.state.sourceViews[i];
      }
      width += viewport.z;
      height = Math.max(height, viewport.w);
    });
    this.drawingBufferSize.set(width, height);
  }

  /** Renders a complete scene, then resolves its marked Splat pixels. */
  compose(
    renderer: GaussianSplatCompatibleRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    if (this.disposed) throw new Error("StochasticResolvePass is disposed");
    assertSupportedRenderer(renderer);
    const previousTarget = renderer.getRenderTarget();
    const xrTarget = this.xrTarget(renderer);
    if (previousTarget !== null && previousTarget !== xrTarget) {
      throw new Error(
        "StochasticResolvePass.compose() renders to the canvas; use resolve() inside a custom render graph",
      );
    }

    const previousAutoClear = renderer.autoClear;
    const previousXREnabled = renderer.xr.enabled;
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    try {
      if (!this._enabled) {
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

        let renderCamera = camera;
        if (xrTarget) {
          if (renderer.xr.cameraAutoUpdate)
            renderer.xr.updateCamera(camera as THREE.PerspectiveCamera);
          const xrCamera = renderer.xr.getCamera();
          if (xrCamera.cameras.length === 0) return;
          this.prepareXRViews(xrCamera, this.xrCamera);
          renderCamera = this.xrCamera;
          // Render the packed eyes without Three replacing them with the XR views.
          renderer.xr.enabled = false;
        } else {
          renderer.getDrawingBufferSize(this.drawingBufferSize);
        }
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
        if (xrTarget && !this.composeTarget.depthTexture) {
          this.composeTarget.depthTexture = new THREE.DepthTexture(
            width,
            height,
          );
          this.composeTarget.dispose();
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
        renderer.render(scene, renderCamera);
        this.resolve(renderer, this.composeTarget, xrTarget);
      }
    } finally {
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
      renderer.xr.enabled = previousXREnabled;
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
    const width = input.width;
    const height = input.height;
    const xrTarget = this.xrTarget(renderer, destination ?? undefined);
    const xrOutput =
      xrTarget !== null && (destination === null || destination === xrTarget);
    const outputCamera = xrOutput ? renderer.xr.getCamera() : null;
    const outputTarget = xrOutput ? xrTarget : destination;
    if (outputTarget === input || outputTarget?.texture === input.texture) {
      throw new Error(
        "StochasticResolvePass input and destination must differ",
      );
    }
    if (outputCamera) {
      if (outputCamera.cameras.length === 0) return;
      this.prepareXRViews(outputCamera);
      if (
        width !== this.drawingBufferSize.x ||
        height !== this.drawingBufferSize.y
      ) {
        throw new Error(
          "XR resolve input must pack the eye viewports horizontally",
        );
      }
    } else if (destination) {
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
    this.state.sourceRect.set(0, 0, width, height);
    this.state.outputOrigin.set(0, 0);
    this.state.sourceDepth.value = input.depthTexture ?? this.depthFallback;
    this.state.copyDepth.value =
      xrOutput && !!outputTarget?.depthBuffer && input.depthTexture !== null;
    this.state.resolve.value = this._enabled && this.hasActiveStochasticSplat();

    const webGPU = isWebGPURenderer(renderer);
    const sourceColorSpace =
      !webGPU && isXRRenderTarget(input)
        ? input.texture.colorSpace
        : THREE.ColorManagement.workingColorSpace;
    this.state.sourceEncoded.value =
      !webGPU &&
      THREE.ColorManagement.getTransfer(sourceColorSpace) ===
        THREE.SRGBTransfer;

    const material = webGPU ? this.webGPUMaterial : this.webGLMaterial;
    material.depthTest = this.state.copyDepth.value;
    material.depthWrite = this.state.copyDepth.value;
    this.mesh.material = material;

    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    const previousXREnabled = renderer.xr.enabled;
    const previousAutoClear = renderer.autoClear;
    const previousToneMapping = renderer.toneMapping;
    const previousColorSpace = renderer.outputColorSpace;
    try {
      this.outputCamera = outputCamera;
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      if (webGPU) {
        // Convert in the resolve shader so Three's output blit does not drop
        // the per-eye depth or allocate another full-resolution intermediate.
        const output = this.webGPUMaterial.outputNode as TSLNode;
        const toneMapping = xrOutput
          ? previousToneMapping
          : THREE.NoToneMapping;
        const colorSpace = xrOutput ? previousColorSpace : THREE.NoColorSpace;
        if (
          output.getToneMapping() !== toneMapping ||
          output.outputColorSpace !== colorSpace
        ) {
          output.setToneMapping(toneMapping);
          output.outputColorSpace = colorSpace;
          this.webGPUMaterial.needsUpdate = true;
        }
        if (xrOutput) {
          renderer.toneMapping = THREE.NoToneMapping;
          renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
        }
      }
      setRendererRenderTarget(renderer, outputTarget);
      if (this.clear) {
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
      }
      renderer.render(this.mesh, outputCamera ?? this.camera);
    } finally {
      setRendererRenderTarget(
        renderer,
        previousTarget,
        previousCubeFace,
        previousMipmapLevel,
      );
      this.outputCamera = null;
      renderer.xr.enabled = previousXREnabled;
      renderer.autoClear = previousAutoClear;
      renderer.toneMapping = previousToneMapping;
      renderer.outputColorSpace = previousColorSpace;
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
    this.depthFallback.dispose();
    this.composeTarget?.dispose();
    this.composeTarget = null;
    this.disposed = true;
  }
}
