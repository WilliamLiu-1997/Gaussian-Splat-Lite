import {
  NeuralDenoiseNode,
  NeuralDenoisePass,
  TAANode,
  TAAPass,
} from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPipeline } from "three/webgpu";

// Frames to render after invalidation for temporal reprojection.
const TAA_SETTLE_FRAMES = 32;
// The neural denoiser accumulates a still view over 128 frames.
const NEURAL_SETTLE_FRAMES = 128;

/**
 * Viewer-only smoothing of stochastic rendering: temporal anti-aliasing, or
 * the neural denoiser, on all three renderer backends.
 */
export function createViewerTAA(
  renderer,
  scene,
  camera,
  { neural = false, mode = "quality", msaa = true } = {},
) {
  const nodeRenderer = renderer.isWebGPURenderer;
  const taa = neural
    ? nodeRenderer
      ? new NeuralDenoiseNode(scene, camera, mode, msaa)
      : new NeuralDenoisePass(scene, camera, mode, msaa)
    : nodeRenderer
      ? new TAANode(scene, camera, msaa)
      : new TAAPass(scene, camera, msaa);
  const settleFrames = neural ? NEURAL_SETTLE_FRAMES : TAA_SETTLE_FRAMES;
  const pipeline = nodeRenderer
    ? new RenderPipeline(renderer, taa)
    : new EffectComposer(renderer);
  const output = nodeRenderer ? null : new OutputPass();
  if (output) {
    pipeline.addPass(taa);
    pipeline.addPass(output);
  }
  let remainingFrames = settleFrames;
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
      remainingFrames = settleFrames;
    },
    reset() {
      taa.reset();
      remainingFrames = settleFrames;
    },
    get needsRender() {
      return remainingFrames > 0;
    },
    dispose() {
      pipeline.dispose();
      output?.dispose();
      taa.dispose();
    },
  };
}
