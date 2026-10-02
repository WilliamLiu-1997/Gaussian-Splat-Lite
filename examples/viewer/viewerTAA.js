import { TAANode, TAAPass } from "gaussian-splat-lite";
import { RenderPipeline } from "three/webgpu";

// Frames to render after invalidation for temporal reprojection.
const TAA_SETTLE_FRAMES = 32;

/** Viewer-only temporal anti-aliasing integration. */
export function createViewerTAA(renderer, scene, camera) {
  const taa = renderer.isWebGPURenderer
    ? createNodeTAA(renderer, scene, camera)
    : new TAAPass(scene, camera);
  let remainingFrames = TAA_SETTLE_FRAMES;
  return {
    render() {
      taa.render(renderer);
      remainingFrames = Math.max(0, remainingFrames - 1);
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
      taa.dispose();
    },
  };
}

function createNodeTAA(renderer, scene, camera) {
  const taa = new TAANode(scene, camera);
  const pipeline = new RenderPipeline(renderer, taa);
  return {
    render() {
      pipeline.render();
    },
    reset() {
      taa.reset();
    },
    dispose() {
      pipeline.dispose();
      taa.dispose();
    },
  };
}
