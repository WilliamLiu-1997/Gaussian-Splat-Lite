import {
  Color,
  ColorManagement,
  DepthTexture,
  FloatType,
  GLSL3,
  HalfFloatType,
  type Matrix4,
  NoBlending,
  NoToneMapping,
  type OrthographicCamera,
  type PerspectiveCamera,
  SRGBTransfer,
  type Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";
import { createTAAState } from "./taaShared";

const vertexShader = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// TRAANode's resolve, with camera/depth reprojection in place of velocity.
const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D source;
uniform sampler2D sourceDepth;
uniform sampler2D history;
uniform sampler2D historyDepth;
uniform vec2 renderSize;
uniform mat4 projection;
uniform mat4 unjitteredProjection;
uniform mat4 previousProjection;
uniform mat4 viewToPreviousClip;
uniform mat4 previousViewToView;
uniform bool valid;
uniform bool reversed;
uniform bool logarithmic;
uniform vec2 logFar;
uniform float depthThreshold;
uniform float edgeDepthDiff;
uniform float maxMotionLength;
uniform bool useSubpixelCorrection;
uniform vec3 luminanceCoefficients;
in vec2 vUv;
out vec4 fragColor;

ivec2 bounded(ivec2 p) {
  return clamp(p, ivec2(0), ivec2(renderSize) - 1);
}

// Homogeneous view coordinates retain far-depth precision and avoid a
// world-space round trip.
vec4 viewPosition(vec2 uv, float depth, mat4 p, float logFarValue) {
  float z = reversed ? depth : depth * 2.0 - 1.0;
  float orientation = reversed ? -1.0 : 1.0;
  float viewZ = (p[3][2] - z * p[3][3]) * orientation;
  float viewW = (z * p[2][3] - p[2][2]) * orientation;
  if (logarithmic) {
    viewZ = 1.0 - exp2(depth * logFarValue);
    viewW = 1.0;
  }
  float clipW = p[2][3] * viewZ + p[3][3] * viewW;
  vec2 viewXY = ((uv * 2.0 - 1.0) * clipW - p[2].xy * viewZ
    - p[3].xy * viewW) / vec2(p[0][0], p[1][1]);
  return vec4(viewXY, viewZ, viewW);
}

float forwardDepth(vec4 positionView) {
  vec4 clip = projection * positionView;
  float depth = clip.z / clip.w;
  return reversed ? 1.0 - depth : depth * 0.5 + 0.5;
}

vec4 clipAABB(vec4 center, vec4 historyColor, vec4 extent) {
  vec4 delta = historyColor - center;
  vec3 unit = abs(delta.rgb / (extent.rgb + 1e-7));
  float maxUnit = max(unit.r, max(unit.g, unit.b));
  return maxUnit > 1.0 ? center + delta / maxUnit : historyColor;
}

vec4 flickerReduction(vec4 currentColor, vec4 historyColor, float currentWeight) {
  vec3 compressedCurrent = currentColor.rgb / (max(currentColor.r, max(currentColor.g, currentColor.b)) + 1.0);
  vec3 compressedHistory = historyColor.rgb / (max(historyColor.r, max(historyColor.g, historyColor.b)) + 1.0);
  float weightCurrent = currentWeight / (dot(compressedCurrent, luminanceCoefficients) + 1.0);
  float weightHistory = (1.0 - currentWeight) / (dot(compressedHistory, luminanceCoefficients) + 1.0);
  return (currentColor * weightCurrent + historyColor * weightHistory)
    / max(weightCurrent + weightHistory, 0.00001);
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 currentColor = texelFetch(source, pixel, 0);
  fragColor = currentColor;
  gl_FragDepth = texelFetch(sourceDepth, pixel, 0).r;
  if (!valid) return;

  float closestDepth = 2.0;
  float farthestDepth = -1.0;
  float closestRawDepth = gl_FragDepth;
  ivec2 closestPixel = pixel;
  vec4 moment1 = currentColor;
  vec4 moment2 = currentColor * currentColor;
  for (int x = -1; x <= 1; ++x) {
    for (int y = -1; y <= 1; ++y) {
      ivec2 p = bounded(pixel + ivec2(x, y));
      float rawDepth = texelFetch(sourceDepth, p, 0).r;
      float depth = reversed && !logarithmic ? 1.0 - rawDepth : rawDepth;
      if (depth < closestDepth) {
        closestDepth = depth;
        closestRawDepth = rawDepth;
        closestPixel = p;
      }
      farthestDepth = max(farthestDepth, depth);
      if (x != 0 || y != 0) {
        vec4 neighbor = max(texelFetch(source, p, 0), vec4(0.0));
        moment1 += neighbor;
        moment2 += neighbor * neighbor;
      }
    }
  }

  vec2 closestUV = (vec2(closestPixel) + 0.5) / renderSize;
  vec4 positionView = viewPosition(closestUV, closestRawDepth, projection, logFar.x);
  vec4 previousClip = viewToPreviousClip * positionView;
  if (previousClip.w <= 0.0) return;
  vec4 currentClip = unjitteredProjection * positionView;
  // Exclude projection jitter from camera motion.
  vec2 offsetUV = (currentClip.xy / currentClip.w - previousClip.xy / previousClip.w) * 0.5;
  vec2 historyUV = vUv - offsetUV;
  if (any(lessThan(historyUV, vec2(0.0))) || any(greaterThanEqual(historyUV, vec2(1.0)))) return;

  float oldDepth = texture(historyDepth, historyUV).r;
  vec4 previousView = viewPosition(historyUV, oldDepth, previousProjection, logFar.y);
  float previousDepth = forwardDepth(previousViewToView * previousView);
  if (logarithmic) {
    // Log depth is monotonic; convert only the extrema for depth thresholds.
    closestDepth = forwardDepth(positionView);
    float farthestZ = 1.0 - exp2(farthestDepth * logFar.x);
    farthestDepth = forwardDepth(vec4(0.0, 0.0, farthestZ, 1.0));
  }
  bool isEdge = farthestDepth - closestDepth > edgeDepthDiff;
  bool isDisocclusion = closestDepth - previousDepth > depthThreshold;
  if (!isEdge && isDisocclusion) return;

  float motionFactor = clamp(length(offsetUV * renderSize) / maxMotionLength, 0.0, 1.0);
  float currentWeight = 0.05;
  if (useSubpixelCorrection) {
    vec2 phase = fract(offsetUV * renderSize);
    vec2 weight = max(phase, 1.0 - phase);
    currentWeight += (1.0 - weight.x * weight.y) / 0.75 * 0.25;
  }
  currentWeight = clamp(currentWeight + motionFactor, 0.0, 1.0);
  float gamma = mix(0.5, 1.0, pow(1.0 - motionFactor, 2.0));
  vec4 mean = moment1 / 9.0;
  vec4 extent = sqrt(max(moment2 / 9.0 - mean * mean, vec4(0.0))) * gamma;
  vec4 historyColor = clipAABB(mean, texture(history, historyUV), extent);
  fragColor = flickerReduction(currentColor, historyColor, currentWeight);
}
`;

function makeTarget(name: string) {
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1, FloatType),
  });
  target.texture.name = name;
  return target;
}

/**
 * Temporal reprojection for WebGLRenderer, using depth and camera motion.
 * Object motion is not tracked; no velocity texture is required.
 * Owns scene capture, camera jitter, and history. It blends and accumulates
 * in the output color space, like direct canvas rendering, then hands the
 * composer a working-space result. Use EffectComposer with OutputPass for
 * output.
 */
export class TAAPass extends Pass {
  /** Depth difference above which non-edge history is rejected. */
  depthThreshold = 0.0005;
  /** Depth range within the 3x3 neighborhood that identifies an edge. */
  edgeDepthDiff = 0.001;
  /** Camera motion in pixels at which history loses all weight. */
  maxMotionLength = 128;
  /** Increase current-frame weight for subpixel camera motion. */
  useSubpixelCorrection = true;
  // Three uses this flag to honor the target's output color space for both
  // ordinary materials and splats, matching direct canvas blending.
  private readonly _source = Object.assign(makeTarget("TAAPass.scene"), {
    isXRRenderTarget: true,
  });
  private readonly _history = [
    makeTarget("TAAPass.history0"),
    makeTarget("TAAPass.history1"),
  ];
  private readonly _clearColor = new Color();
  private readonly _state = createTAAState(
    <T>(value: T) => ({ value }),
    [this._source, ...this._history],
  );
  private readonly _uniforms;
  private readonly _resolveMaterial: ShaderMaterial;
  private readonly _copyMaterial: ShaderMaterial;
  private readonly _quad: FullScreenQuad;

  constructor(
    public scene: Scene,
    public camera: PerspectiveCamera | OrthographicCamera,
  ) {
    super();

    this._uniforms = {
      source: { value: this._source.texture },
      sourceDepth: { value: this._source.depthTexture },
      history: { value: this._history[0].texture },
      historyDepth: { value: this._history[0].depthTexture },
      ...this._state.uniforms,
    };
    this._resolveMaterial = new ShaderMaterial({
      name: "TAAPass.resolve",
      uniforms: this._uniforms,
      vertexShader,
      fragmentShader,
      glslVersion: GLSL3,
      blending: NoBlending,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    this._copyMaterial = new ShaderMaterial({
      name: "TAAPass.copy",
      uniforms: { source: { value: null }, decode: { value: false } },
      vertexShader,
      // Inverts OutputPass's transfer, so the two round-trip at any alpha.
      fragmentShader: /* glsl */ `
        uniform sampler2D source;
        uniform bool decode;
        in vec2 vUv;
        out vec4 fragColor;
        void main() {
          fragColor = texture(source, vUv);
          if (decode) {
            vec4 color = vec4(max(fragColor.rgb, 0.0), 1.0);
            fragColor.rgb = sRGBTransferEOTF(color).rgb;
          }
        }
      `,
      glslVersion: GLSL3,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this._quad = new FullScreenQuad(this._resolveMaterial);
  }

  /** Current scene depth, before temporal accumulation. Owned by this pass. */
  get depthTexture(): DepthTexture {
    return this._source.depthTexture as DepthTexture;
  }

  /** Jittered projection used to capture depthTexture. Treat as read-only. */
  get projectionMatrix(): Matrix4 {
    return this._uniforms.projection.value;
  }

  /** Resize all internal targets in physical pixels; a size change clears history. */
  override setSize(width: number, height: number): void {
    this._state.setSize(width, height);
  }

  /** Discard history after a camera cut, scene replacement, or color-space change. */
  reset(): void {
    this._state.reset();
  }

  /** Render the scene and resolve TAA into the composer's working-space buffer. */
  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
  ): void {
    const { camera, _state: state, _uniforms: uniforms } = this;
    this.setSize(writeBuffer.width, writeBuffer.height);
    const colorSpace = renderer.outputColorSpace;
    if (this._source.texture.colorSpace !== colorSpace) {
      this._source.texture.colorSpace = colorSpace;
      this.reset();
    }
    // The attributes are null while the WebGL context is lost.
    state.setStencil(renderer.getContextAttributes()?.stencil === true);
    const previousTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const xrEnabled = renderer.xr.enabled;
    const toneMapping = renderer.toneMapping;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      // The output pass tone-maps the resolved image.
      renderer.toneMapping = NoToneMapping;
      const reversedDepth = camera.reversedDepth;
      state.beginCapture(camera);
      try {
        renderer.setRenderTarget(this._source);
        // Refresh the clear color in the capture target's color space.
        renderer.setClearColor(
          renderer.getClearColor(this._clearColor),
          renderer.getClearAlpha(),
        );
        renderer.clear();
        renderer.render(this.scene, camera);
      } finally {
        state.endCapture(camera);
        // Three may initialize reversed depth during the first draw. Keep its
        // new depth convention when restoring the unjittered projection.
        if (camera.reversedDepth !== reversedDepth)
          camera.updateProjectionMatrix();
      }

      const input = this._history[state.historyIndex];
      const output = this._history[1 - state.historyIndex];
      if (!uniforms.valid.value) {
        // Allocate depth attachments before either is bound as a sampler.
        for (const target of this._history) renderer.initRenderTarget(target);
      }
      uniforms.history.value = input.texture;
      uniforms.historyDepth.value = input.depthTexture;
      uniforms.reversed.value = renderer.capabilities.reversedDepthBuffer;
      uniforms.logarithmic.value =
        renderer.capabilities.logarithmicDepthBuffer &&
        "isPerspectiveCamera" in camera &&
        camera.isPerspectiveCamera;
      this._resolveMaterial.depthFunc = state.prepareResolve(camera, this);
      renderer.setRenderTarget(output);
      this._quad.material = this._resolveMaterial;
      this._quad.render(renderer);

      this._copyMaterial.uniforms.source.value = output.texture;
      // As the last pass, present the output-space image as it is.
      this._copyMaterial.uniforms.decode.value =
        !this.renderToScreen &&
        ColorManagement.getTransfer(colorSpace) === SRGBTransfer;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this._quad.material = this._copyMaterial;
      this._quad.render(renderer);

      state.advance(camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xrEnabled;
      renderer.toneMapping = toneMapping;
    }
  }

  override dispose(): void {
    this._source.dispose();
    for (const target of this._history) target.dispose();
    this._resolveMaterial.dispose();
    this._copyMaterial.dispose();
    this._quad.dispose();
  }
}
