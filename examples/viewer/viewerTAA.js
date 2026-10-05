import { TAANode, TAAPass } from "gaussian-splat-lite";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPipeline } from "three/webgpu";

// Frames to render after invalidation for temporal reprojection.
const TAA_SETTLE_FRAMES = 32;

/** Viewer-only temporal anti-aliasing integration. */
export function createViewerTAA(renderer, scene, camera) {
  const nodeRenderer = renderer.isWebGPURenderer;
  const taa = nodeRenderer
    ? new TAANode(scene, camera)
    : new TAAPass(scene, camera);
  const pipeline = nodeRenderer
    ? new RenderPipeline(renderer, taa)
    : new EffectComposer(renderer);
  const output = nodeRenderer ? null : new OutputPass();
  if (output) {
    pipeline.addPass(taa);
    pipeline.addPass(output);
  }
  let remainingFrames = TAA_SETTLE_FRAMES;
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
      remainingFrames = TAA_SETTLE_FRAMES;
    },
    reset() {
      taa.reset();
      remainingFrames = TAA_SETTLE_FRAMES;
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
