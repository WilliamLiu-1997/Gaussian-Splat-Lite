import {
  ColorManagement,
  Mesh,
  NoBlending,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  SRGBTransfer,
} from "three";
import * as N from "three/tsl";
import { NodeMaterial, NodeUpdateType, QuadMesh } from "three/webgpu";
import { GaussianSplatRenderer } from "../rendering/GaussianSplatRenderer.js";
import {
  assertSupportedRenderer,
  isWebGPURenderer,
  usesNativeWebGPU,
} from "../rendering/rendererUtils.js";
import { viewIndex } from "../rendering/tsl/viewUniforms.js";
import { NeuralDenoiseNode } from "./NeuralDenoiseNode.js";
import { NeuralDenoisePass } from "./NeuralDenoisePass.js";

// Stochastic noise has 32 patterns, and Splat renderers advance to the next
// one on every draw. Two eye draws a frame would leave each eye half of them;
// each eye instead takes the frame's pattern, the second one half a cycle on.
const EYE_PATTERN_OFFSET = 16;

/** Per-eye neural denoising and presentation during an active WebXR session. */
export class NeuralDenoiseXR {
  stabilize = true;
  views = [];
  output = null;
  constructor(renderer, scene, camera, mode = "quality", msaa = false) {
    assertSupportedRenderer(renderer);
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.mode = mode;
    this.msaa = msaa;
    this.nodeRenderer = isWebGPURenderer(renderer);
    this.onSessionEnd = () => this.disposeViews();
    renderer.xr.addEventListener("sessionend", this.onSessionEnd);
  }
  createViews(eyes) {
    this.disposeViews();
    this.views = eyes.map((eye) => {
      // A separate camera keeps jitter and target-local coordinates out of
      // Three's XR camera, and captures just this eye on every backend.
      const camera = new PerspectiveCamera();
      const pass = this.nodeRenderer
        ? new NeuralDenoiseNode(this.scene, camera, this.mode, this.msaa)
        : new NeuralDenoisePass(this.scene, camera, this.mode, this.msaa);
      const denoise = this.nodeRenderer ? pass : pass.denoise;
      // render() owns capture; sampling the output must not capture again.
      denoise.updateBeforeType = NodeUpdateType.NONE;
      return { eye, pass, denoise };
    });
    if (this.nodeRenderer) {
      const material = new NodeMaterial();
      material.name = "NeuralDenoiseXR.output";
      material.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
      const color = N.Fn((builder) => {
        const index = viewIndex(builder.camera);
        const color = N.vec4(0).toVar();
        this.views.forEach((view, i) => {
          N.If(index.equal(i), () => {
            color.assign(view.denoise.getTextureNode());
          });
        });
        return color;
      })();
      material.fragmentNode = N.renderOutput(
        color,
        this.renderer.toneMapping,
        this.renderer.outputColorSpace,
      );
      material.depthTest = false;
      material.depthWrite = false;
      material.blending = NoBlending;
      this.output = new QuadMesh(material);
    } else {
      this.output = new Mesh(new PlaneGeometry(2, 2), this.views[0].pass.copy);
      this.output.onBeforeRender = (renderer, scene, camera) => {
        const { denoise } = this.views.find((view) => view.eye === camera);
        const uniforms = this.output.material.uniforms;
        uniforms.image.value = denoise.textureNode.value;
        uniforms.encoded.value = denoise.encoded.value;
        uniforms.outputSRGB.value =
          ColorManagement.getTransfer(renderer.outputColorSpace) ===
          SRGBTransfer;
        // WebGLRenderer reuses this material for both eyes in one render call.
        this.output.material.uniformsNeedUpdate = true;
      };
    }
    this.output.frustumCulled = false;
    this.output.layers.enableAll();
  }
  render() {
    const { renderer } = this;
    const { xr } = renderer;
    if (!xr.enabled || !xr.isPresenting) {
      throw new Error(
        "NeuralDenoiseXR.render() requires an active WebXR session",
      );
    }
    if (xr.cameraAutoUpdate) {
      this.camera.updateWorldMatrix(true, false);
      xr.updateCamera(this.camera);
    }
    const eyes = xr.getCamera().cameras;
    // Tracking can be unavailable at the beginning of a session.
    if (eyes.length === 0) return;
    if (
      eyes.length !== this.views.length ||
      eyes.some((eye, i) => eye !== this.views[i].eye)
    )
      this.createViews(eyes);
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    const cameraAutoUpdate = xr.cameraAutoUpdate;
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    const outputColorSpace = renderer.outputColorSpace;
    const outputTarget = this.nodeRenderer
      ? renderer.getOutputRenderTarget()
      : null;
    const outputDepth = outputTarget?.depthBuffer;
    // Automatically advancing renderers and their base sample for this frame.
    const samples = new Map();
    this.scene.traverse((object) => {
      if (
        object instanceof GaussianSplatRenderer &&
        object.autoAdvanceStochasticSample
      )
        samples.set(object, (object.stochasticSample + 1) >>> 0);
    });
    try {
      // The output draw must reuse exactly the poses captured below.
      xr.cameraAutoUpdate = false;
      for (const splat of samples.keys())
        splat.autoAdvanceStochasticSample = false;
      for (const [index, { eye, denoise }] of this.views.entries()) {
        const { camera } = denoise;
        for (const [splat, sample] of samples)
          splat.stochasticSample = (sample + index * EYE_PATTERN_OFFSET) >>> 0;
        camera.copy(eye, false);
        camera.matrixAutoUpdate = false;
        camera.matrixWorldAutoUpdate = false;
        // XR supplies the off-axis projection. Mark its coordinate system so
        // Three does not replace it with a symmetric PerspectiveCamera lens.
        camera.coordinateSystem = renderer.coordinateSystem;
        const reversed = this.nodeRenderer
          ? renderer.reversedDepthBuffer
          : renderer.capabilities.reversedDepthBuffer;
        camera._reversedDepth = reversed;
        if (reversed) {
          const p = camera.projectionMatrix.elements;
          const scale = usesNativeWebGPU(renderer) ? 1 : 0.5;
          for (let i = 0; i < 16; i += 4)
            p[i + 2] = scale * (p[i + 3] - p[i + 2]);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        }
        denoise.scene = this.scene;
        denoise.stabilize = this.stabilize;
        denoise.setSize(eye.viewport.z, eye.viewport.w);
        // The existing capture takes its physical size from the bound target.
        renderer.setRenderTarget(denoise.history[0]);
        denoise.updateBefore({ renderer });
      }
      renderer.setRenderTarget(target, cubeFace, mipLevel);
      if (this.nodeRenderer) {
        const output = this.output.material.fragmentNode;
        if (
          output.getToneMapping() !== toneMapping ||
          output.outputColorSpace !== outputColorSpace
        ) {
          this.output.material.fragmentNode = N.renderOutput(
            output.colorNode,
            toneMapping,
            outputColorSpace,
          );
          this.output.material.needsUpdate = true;
        }
        // Present directly to XR, with output conversion in the same shader.
        // A mono RenderPipeline / renderer output quad cannot select eyes.
        renderer.toneMapping = NoToneMapping;
        renderer.outputColorSpace = ColorManagement.workingColorSpace;
        // Three selects native per-eye render passes through its array depth
        // attachment, even for color-only output. XR may have disabled it in
        // anticipation of the renderer's intermediate color-conversion pass.
        if (usesNativeWebGPU(renderer) && outputTarget?.useArrayDepthTexture)
          outputTarget.depthBuffer = true;
      }
      // Three selects the XR viewport / array layer; our shader selects its image.
      renderer.render(this.output, this.camera);
    } finally {
      for (const [splat, sample] of samples) {
        splat.stochasticSample = sample;
        splat.autoAdvanceStochasticSample = true;
      }
      xr.enabled = true;
      xr.cameraAutoUpdate = cameraAutoUpdate;
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      if (outputTarget) outputTarget.depthBuffer = outputDepth;
      renderer.setRenderTarget(target, cubeFace, mipLevel);
    }
  }
  /** Discards both eyes' history after a camera cut or scene replacement. */
  reset() {
    for (const { denoise } of this.views) denoise.reset();
  }
  disposeViews() {
    for (const { pass } of this.views) pass.dispose();
    this.views = [];
    if (this.output) {
      // QuadMesh owns shared geometry; the classic output geometry is ours.
      if (this.nodeRenderer) this.output.material.dispose();
      else this.output.geometry.dispose();
      this.output = null;
    }
  }
  dispose() {
    this.renderer.xr.removeEventListener("sessionend", this.onSessionEnd);
    this.disposeViews();
  }
}
