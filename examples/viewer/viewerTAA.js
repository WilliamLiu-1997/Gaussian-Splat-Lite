import { TAAPass } from "gaussian-splat-lite";
import { Matrix4, WebGLCoordinateSystem } from "three";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import * as N from "three/tsl";
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
  const scenePass = N.pass(scene, camera, { samples: 0 });
  scenePass.setMRT(N.mrt({ output: N.output, velocity: N.velocity }));
  const taa = traa(
    scenePass.getTextureNode(),
    scenePass.getTextureNode("depth"),
    scenePass.getTextureNode("velocity"),
    camera,
  );
  if (
    renderer.coordinateSystem === WebGLCoordinateSystem &&
    renderer.reversedDepthBuffer
  ) {
    // Three r186 TAAUtils maps WebGL depth to [-1, 1], but reversed-depth
    // projections expect [0, 1]. Adapt only the inverse saved for next frame's
    // history reconstruction, after TRAA has finished using this frame's data.
    const depthRange = new Matrix4()
      .makeScale(1, 1, 0.5)
      .setPosition(0, 0, 0.5);
    const updateBefore = taa.updateBefore;
    taa.updateBefore = function (frame) {
      updateBefore.call(this, frame);
      this._cameraProjectionMatrixInverse.value.multiply(depthRange);
    };
  }
  // TRAA reads the input size and seeds history before rendering its resolve.
  // Render the scene first, including on the first frame and after a resize.
  // RenderPipeline applies tone mapping and output conversion after TRAA.
  const pipeline = new RenderPipeline(renderer, taa.before(scenePass));
  return {
    render() {
      pipeline.render();
    },
    reset() {
      taa.setSize(1, 1);
    },
    dispose() {
      pipeline.dispose();
      taa.dispose();
      scenePass.dispose();
    },
  };
}
