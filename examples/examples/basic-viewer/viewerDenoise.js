import { NeuralDenoiseNode, NeuralDenoisePass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPipeline } from "three/webgpu";

// The neural denoiser accumulates a still view over 128 frames.
const SETTLE_FRAMES = 128;

/** Viewer-only neural denoising of stochastic rendering on all three backends. */
export function createViewerDenoise(
  renderer,
  scene,
  camera,
  { mode = "quality", msaa = false } = {},
) {
  const nodeRenderer = renderer.isWebGPURenderer;
  const denoise = nodeRenderer
    ? new NeuralDenoiseNode(scene, camera, mode, msaa)
    : new NeuralDenoisePass(scene, camera, mode, msaa);
  const pipeline = nodeRenderer
    ? new RenderPipeline(renderer, denoise)
    : new EffectComposer(renderer);
  const output = nodeRenderer ? null : new OutputPass();
  if (output) {
    pipeline.addPass(denoise);
    pipeline.addPass(output);
  }
  let remainingFrames = SETTLE_FRAMES;
  return {
    render() {
      pipeline.render();
      remainingFrames = Math.max(0, remainingFrames - 1);
    },
    setSize(width, height) {
      // RenderPipeline follows the renderer's size by itself.
      if (!nodeRenderer) pipeline.setSize(width, height);
    },
    invalidate() {
      remainingFrames = SETTLE_FRAMES;
    },
    reset() {
      denoise.reset();
      remainingFrames = SETTLE_FRAMES;
    },
    get needsRender() {
      return remainingFrames > 0;
    },
    dispose() {
      pipeline.dispose();
      output?.dispose();
      denoise.dispose();
    },
  };
}
