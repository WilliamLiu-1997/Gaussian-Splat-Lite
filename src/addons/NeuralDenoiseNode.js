import {
  Color,
  ColorManagement,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearTransfer,
  Matrix4,
  NoToneMapping,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from "three";
import * as N from "three/tsl";
import { Node, NodeUpdateType } from "three/webgpu";
import { applyThreeR186Patch } from "../patches/threeR186.js";
import { usesNativeWebGPU } from "../rendering/rendererUtils.js";
import { WebGLDenoisePasses } from "./neuralDenoiseGL.js";
import { WebGPUDenoisePasses } from "./neuralDenoisePasses.js";
import { neuralDenoiseModels } from "./neuralDenoiseWeights.js";
import { StochasticCoverage } from "./stochasticCoverage.js";
import { createTAAState } from "./taaShared.js";
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
 * Experimental temporal neural denoiser for stochastic Splat rendering on WebGPURenderer,
 * including its WebGL2 fallback,
 * used in place of TAANode. After Hu et al., "Ultra-fast Neural Inference for
 * Stochastic Gaussian Splatting Denoising" (arXiv 2609.25604), adapted to
 * scenes whose objects move.
 */
export class NeuralDenoiseNode extends Node {
  scene;
  camera;
  mode;
  msaa;
  coverage;
  static get type() {
    return "NeuralDenoiseNode";
  }
  /**
   * Blends the result with the previous image where the network trusts it.
   * Applies to both modes; turn it off for the two history paths alone.
   */
  stabilize = true;
  source = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1, FloatType),
    samples: 0,
  });
  // The displayed image, which is also what stabilization blends with.
  history = [0, 1].map(
    () =>
      new WebGLRenderTarget(1, 1, {
        type: HalfFloatType,
        depthBuffer: false,
        samples: 0,
      }),
  );
  textureNode = N.passTexture(this, this.history[0].texture);
  // The passes work on display-referred values; decode their output when
  // the renderer uses a linear working colour space.
  encoded = N.uniform(false);
  outputColor = N.Fn(() => {
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
  state = createTAAState(
    (value) => ({ value }),
    [this.source, ...this.history],
    true,
    MARGIN,
  );
  passes = null;
  // The scene target's depth has the margin; this one has the image's size.
  depth = new DepthTexture(1, 1, FloatType);
  depthRead = false;
  previousWorld = new Matrix4();
  previousProjection = new Matrix4();
  relative = new Matrix4();
  /** Frames drawn, for the scene's place in its target. */
  frame = 0;
  toPreviousClip = new Matrix4();
  drawingSize = new Vector2();
  workingColorSpace = ColorManagement.workingColorSpace;
  pipelineStates = new WeakSet();
  pipelineRendering = false;
  capturePending = true;
  /**
   * @param mode Fixed local filtering or learned multiscale quality (default).
   * @param msaa Enable 4× MSAA (default true).
   *   Fixed for the node's lifetime.
   */
  constructor(scene, camera, mode = "quality", msaa = true) {
    super("vec4");
    this.scene = scene;
    this.camera = camera;
    this.mode = mode;
    this.msaa = msaa;
    this.coverage = msaa ? new StochasticCoverage() : null;
    // Each coverage decision controls one of the target's four samples.
    this.source.samples = msaa ? 4 : 0;
    this.source.storeMultisampledColorBuffer = false;
    this.updateBeforeType = NodeUpdateType.RENDER;
    this.source.texture.name = "NeuralDenoise.scene";
    this.history[0].texture.name = "NeuralDenoise.history0";
    this.history[1].texture.name = "NeuralDenoise.history1";
  }
  /** Scene depth of the current frame, kept from the first read on. */
  get depthTexture() {
    this.depthRead = true;
    return this.depth;
  }
  /** The projection `depthTexture` was rendered with. */
  get projectionMatrix() {
    return this.state.uniforms.projection.value;
  }
  /** The denoised image, for chaining effects. */
  getTextureNode() {
    return this.outputColor;
  }
  setSize(width, height) {
    this.state.setSize(width, height);
  }
  /** Discards earlier frames, as after a camera cut. */
  reset() {
    this.state.reset();
  }
  updateBefore(frame) {
    if (this.pipelineRendering && !this.capturePending) return;
    const renderer = frame.renderer;
    const nodeRenderer = renderer.isWebGPURenderer === true;
    const native = usesNativeWebGPU(renderer);
    if (this.workingColorSpace !== ColorManagement.workingColorSpace) {
      this.workingColorSpace = ColorManagement.workingColorSpace;
      this.reset();
    }
    const backend = renderer.backend;
    if (this.passes === null) {
      const model = {
        ...neuralDenoiseModels[this.mode],
        stabilizeNoise: !this.msaa,
      };
      this.passes = native
        ? new WebGPUDenoisePasses(backend.device, model, this.coverage !== null)
        : new WebGLDenoisePasses(renderer, model);
    }
    const { camera, state, passes } = this;
    const rendererState = {
      renderTarget: renderer.getRenderTarget(),
      cubeFace: renderer.getActiveCubeFace(),
      mipLevel: renderer.getActiveMipmapLevel(),
      viewport: renderer.getViewport(new Vector4()),
      scissor: renderer.getScissor(new Vector4()),
      scissorTest: renderer.getScissorTest(),
      autoClear: renderer.autoClear,
      toneMapping: renderer.toneMapping,
      clearColor: renderer.getClearColor(new Color()),
      clearAlpha: renderer.getClearAlpha(),
      mrt: nodeRenderer ? renderer.getMRT() : null,
    };
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
    state.setStencil(
      nodeRenderer
        ? renderer.stencil
        : renderer.getContextAttributes()?.stencil === true,
    );
    try {
      renderer.xr.enabled = false;
      if (nodeRenderer) renderer.setMRT(null);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      renderer.toneMapping = NoToneMapping;
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
        if (this.coverage) this.coverage.render(renderer, this.scene, camera);
        else renderer.render(this.scene, camera);
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
      if (!valid && native)
        for (const target of this.history) renderer.initRenderTarget(target);
      // Camera relation to the previous frame, composed in double precision.
      const u = passes.uniforms;
      const jittered = state.uniforms.projection.value.elements;
      const logarithmic =
        (nodeRenderer
          ? renderer.logarithmicDepthBuffer
          : renderer.capabilities.logarithmicDepthBuffer) &&
        "isPerspectiveCamera" in camera &&
        camera.isPerspectiveCamera;
      // Three.js clamps the near plane the same way.
      const near = Math.max(camera.near, 1e-6);
      const reversed = nodeRenderer
        ? renderer.reversedDepthBuffer
        : renderer.capabilities.reversedDepthBuffer;
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
      if (!native && !reversed) {
        // WebGL's ordinary projection has NDC depth -1..1; texture depth is 0..1.
        u[44] = 0.5 * (jittered[10] + jittered[11]);
        u[46] = 0.5 * (jittered[14] + jittered[15]);
      }
      u.set([width, height, 1 / width, 1 / height], 48);
      u.set(
        [
          camera.far,
          reversed ? 0 : 1,
          valid ? 1 : 0,
          this.stabilize ? 1 : 0,
          passes.halfBias,
          logarithmic ? (nodeRenderer ? 1 : 2) : 0,
          near,
          Math.log2(nodeRenderer ? camera.far / near : camera.far + 1),
        ],
        52,
      );
      // How far the camera turned since the previous frame, whatever scale
      // its rig carries.
      const cosine =
        ((r[0] + r[5] + r[10]) / Math.cbrt(this.relative.determinant()) - 1) /
        2;
      u[60] = Math.acos(Math.min(1, Math.max(-1, cosine)));
      u[61] =
        this.previousWorld.equals(camera.matrixWorld) &&
        this.previousProjection.equals(camera.projectionMatrix)
          ? 1
          : 0;
      // Both node backends place viewports from the top; classic WebGL uses
      // the bottom. Shader coordinates are top-left on all three backends.
      u.set([offsetX, nodeRenderer ? offsetY : MARGIN - offsetY], 62);
      // Classic capture is already sRGB; node capture uses the working space.
      const encode =
        ColorManagement.getTransfer(
          this.source.texture.colorSpace || this.workingColorSpace,
        ) === LinearTransfer;
      u.set(encode ? [0, 0] : [u[62], u[63]], 64);
      this.encoded.value =
        ColorManagement.getTransfer(this.workingColorSpace) === LinearTransfer;
      const gpu = (texture) => {
        const data = backend.get(texture).texture;
        if (!data) throw new Error("NeuralDenoiseNode: texture not allocated");
        return data;
      };
      if (this.depthRead && native) {
        const image = this.depth.image;
        if (image.width !== width || image.height !== height) {
          image.width = width;
          image.height = height;
          this.depth.needsUpdate = true;
        }
        // A standalone DepthTexture inherits the current target's samples
        // when allocated. The public depth output must stay single-sampled.
        renderer.setRenderTarget(this.history[0]);
        renderer.initTexture(this.depth);
      }
      const previous = state.historyIndex;
      passes.render(
        width,
        height,
        {
          color: native ? gpu(this.source.texture) : this.source.texture,
          depth: native
            ? gpu(this.source.depthTexture)
            : this.source.depthTexture,
          exposed: this.depthRead
            ? native
              ? gpu(this.depth)
              : this.depth
            : null,
          history: native
            ? [gpu(this.history[0].texture), gpu(this.history[1].texture)]
            : null,
          encode,
        },
        previous,
      );
      this.textureNode.value = native
        ? this.history[1 - previous].texture
        : passes.result;
      this.previousWorld.copy(camera.matrixWorld);
      this.previousProjection.copy(camera.projectionMatrix);
      state.advance(camera);
      this.capturePending = false;
    } finally {
      renderer.setRenderTarget(
        rendererState.renderTarget,
        rendererState.cubeFace,
        rendererState.mipLevel,
      );
      renderer.setViewport(rendererState.viewport);
      renderer.setScissor(rendererState.scissor);
      renderer.setScissorTest(rendererState.scissorTest);
      renderer.setClearColor(
        rendererState.clearColor,
        rendererState.clearAlpha,
      );
      renderer.autoClear = rendererState.autoClear;
      renderer.toneMapping = rendererState.toneMapping;
      if (nodeRenderer) renderer.setMRT(rendererState.mrt);
      renderer.xr.enabled = xrEnabled;
    }
    return undefined;
  }
  setup(builder) {
    applyThreeR186Patch(builder.renderer);
    const pipelineState = builder.context.renderPipelineState;
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
  dispose() {
    super.dispose();
    this.passes?.dispose();
    this.passes = null;
    this.coverage?.dispose();
    this.source.dispose();
    this.depth.dispose();
    for (const target of this.history) target.dispose();
  }
}
