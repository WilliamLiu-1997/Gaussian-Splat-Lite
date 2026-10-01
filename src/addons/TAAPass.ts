import {
  AlwaysDepth,
  Color,
  ColorManagement,
  DepthTexture,
  FloatType,
  GLSL3,
  HalfFloatType,
  Matrix4,
  NeverDepth,
  NoBlending,
  type OrthographicCamera,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";

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
  // Exclude camera jitter from motion, just like TRAA's velocity attachment.
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

function halton(index: number, base: number) {
  let i = index;
  let fraction = 1;
  let result = 0;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

const jitterOffsets = Array.from({ length: 32 }, (_, i) => [
  halton(i + 1, 2) - 0.5,
  halton(i + 1, 3) - 0.5,
]);

/**
 * Temporal reprojection for WebGLRenderer, using depth and camera motion.
 * Object motion is not tracked; no velocity texture is required.
 * Owns scene capture, camera jitter, and history. By default it blends and
 * accumulates in the output color space, like direct canvas rendering, and
 * presents the result without OutputPass.
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
  /**
   * Capture and accumulate in the renderer's output color space, ready for
   * presentation. Set false to stay in the working color space for linear
   * effects, followed by OutputPass.
   */
  accumulateInOutputSpace = true;

  private readonly _source: WebGLRenderTarget & { isXRRenderTarget: boolean };
  private readonly _history: WebGLRenderTarget[];
  private readonly _size = new Vector2();
  private readonly _clearColor = new Color();
  private _historyIndex = 0;
  private _historyValid = false;
  private _jitterIndex = 0;
  private readonly _previousViewProjection = new Matrix4();
  private readonly _previousWorld = new Matrix4();
  private _view: PerspectiveCamera["view"] = null;
  private readonly _uniforms;
  private readonly _resolveMaterial: ShaderMaterial;
  private readonly _copyMaterial: ShaderMaterial;
  private readonly _quad: FullScreenQuad;

  constructor(
    public scene: Scene,
    public camera: PerspectiveCamera | OrthographicCamera,
  ) {
    super();

    const makeTarget = (name: string) => {
      const target = new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        depthTexture: new DepthTexture(1, 1, FloatType),
      });
      target.texture.name = name;
      return target;
    };
    // Three uses this flag to honor the target's output color space for both
    // ordinary materials and splats, matching direct canvas blending.
    this._source = Object.assign(makeTarget("TAAPass.scene"), {
      isXRRenderTarget: false,
    });
    this._history = [
      makeTarget("TAAPass.history0"),
      makeTarget("TAAPass.history1"),
    ];

    this._uniforms = {
      source: { value: this._source.texture },
      sourceDepth: { value: this._source.depthTexture },
      history: { value: this._history[0].texture },
      historyDepth: { value: this._history[0].depthTexture },
      renderSize: { value: new Vector2(1, 1) },
      projection: { value: new Matrix4() },
      unjitteredProjection: { value: new Matrix4() },
      previousProjection: { value: new Matrix4() },
      viewToPreviousClip: { value: new Matrix4() },
      previousViewToView: { value: new Matrix4() },
      valid: { value: false },
      reversed: { value: false },
      logarithmic: { value: false },
      logFar: { value: new Vector2() },
      depthThreshold: { value: this.depthThreshold },
      edgeDepthDiff: { value: this.edgeDepthDiff },
      maxMotionLength: { value: this.maxMotionLength },
      useSubpixelCorrection: { value: this.useSubpixelCorrection },
      luminanceCoefficients: { value: new Vector3() },
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
      uniforms: { source: { value: null } },
      vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D source;
        in vec2 vUv;
        out vec4 fragColor;
        void main() { fragColor = texture(source, vUv); }
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
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this._source.width === w && this._source.height === h) return;
    this._source.setSize(w, h);
    for (const target of this._history) target.setSize(w, h);
    this._uniforms.renderSize.value.set(w, h);
    this.reset();
  }

  /** Discard history after a camera cut, scene replacement, or color-space change. */
  reset(): void {
    this._historyValid = false;
    this._jitterIndex = 0;
  }

  /** Apply this frame's Halton jitter before rendering the input textures. */
  private setViewOffset(): void {
    const { camera } = this;
    const { x: width, y: height } = this._uniforms.renderSize.value;
    const view = camera.view;
    this._view = view;
    const jitter = jitterOffsets[this._jitterIndex];
    const viewWidth = view?.enabled ? view.width : width;
    const viewHeight = view?.enabled ? view.height : height;
    // setViewOffset() also changes PerspectiveCamera.aspect; preserve framing.
    camera.view = {
      enabled: true,
      fullWidth: view?.enabled ? view.fullWidth : width,
      fullHeight: view?.enabled ? view.fullHeight : height,
      offsetX:
        (view?.enabled ? view.offsetX : 0) + (jitter[0] * viewWidth) / width,
      offsetY:
        (view?.enabled ? view.offsetY : 0) + (jitter[1] * viewHeight) / height,
      width: viewWidth,
      height: viewHeight,
    };
    camera.updateProjectionMatrix();
  }

  /** Restore the camera after the input render and before resolving TAA. */
  private clearViewOffset(): void {
    // Capture the projection actually used, including Three's first-frame
    // reversed-depth setup, before restoring the unjittered camera.
    this._uniforms.projection.value.copy(this.camera.projectionMatrix);
    this.camera.view = this._view;
    this.camera.updateProjectionMatrix();
  }

  /** Render the scene and TAA to the canvas, a target, or the composer's buffer. */
  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget | null = null,
  ): void {
    const { camera, _uniforms: uniforms } = this;
    if (writeBuffer) {
      this.setSize(writeBuffer.width, writeBuffer.height);
    } else {
      renderer.getDrawingBufferSize(this._size);
      this.setSize(this._size.x, this._size.y);
    }
    const colorSpace = this.accumulateInOutputSpace
      ? renderer.outputColorSpace
      : ColorManagement.workingColorSpace;
    if (
      this._source.texture.colorSpace !== colorSpace ||
      this._source.isXRRenderTarget !== this.accumulateInOutputSpace
    ) {
      this._source.texture.colorSpace = colorSpace;
      this._source.isXRRenderTarget = this.accumulateInOutputSpace;
      this.reset();
    }
    const previousTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const xrEnabled = renderer.xr.enabled;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      this.setViewOffset();
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
        this.clearViewOffset();
      }

      const input = this._history[this._historyIndex];
      const output = this._history[1 - this._historyIndex];
      if (!this._historyValid) {
        // Allocate depth attachments before either is bound as a sampler.
        for (const target of this._history) renderer.initRenderTarget(target);
      }
      uniforms.history.value = input.texture;
      uniforms.historyDepth.value = input.depthTexture;
      uniforms.valid.value = this._historyValid;
      uniforms.reversed.value = renderer.capabilities.reversedDepthBuffer;
      uniforms.logarithmic.value =
        renderer.capabilities.logarithmicDepthBuffer &&
        "isPerspectiveCamera" in camera &&
        camera.isPerspectiveCamera;
      uniforms.logFar.value.x = Math.log2(camera.far + 1);
      uniforms.unjitteredProjection.value.copy(camera.projectionMatrix);
      uniforms.viewToPreviousClip.value.multiplyMatrices(
        this._previousViewProjection,
        camera.matrixWorld,
      );
      uniforms.previousViewToView.value.multiplyMatrices(
        camera.matrixWorldInverse,
        this._previousWorld,
      );
      uniforms.depthThreshold.value = this.depthThreshold;
      uniforms.edgeDepthDiff.value = this.edgeDepthDiff;
      uniforms.maxMotionLength.value = this.maxMotionLength;
      uniforms.useSubpixelCorrection.value = this.useSubpixelCorrection;
      ColorManagement.getLuminanceCoefficients(
        uniforms.luminanceCoefficients.value,
      );
      // Three r186 reverses NeverDepth to GL_ALWAYS for reversed depth.
      this._resolveMaterial.depthFunc = uniforms.reversed.value
        ? NeverDepth
        : AlwaysDepth;
      renderer.setRenderTarget(output);
      this._quad.material = this._resolveMaterial;
      this._quad.render(renderer);

      this._copyMaterial.uniforms.source.value = output.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this._quad.material = this._copyMaterial;
      this._quad.render(renderer);

      this._previousViewProjection.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      this._previousWorld.copy(camera.matrixWorld);
      uniforms.previousProjection.value.copy(uniforms.projection.value);
      uniforms.logFar.value.y = uniforms.logFar.value.x;
      this._historyIndex = 1 - this._historyIndex;
      this._historyValid = true;
      this._jitterIndex = (this._jitterIndex + 1) % jitterOffsets.length;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = autoClear;
      renderer.xr.enabled = xrEnabled;
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
