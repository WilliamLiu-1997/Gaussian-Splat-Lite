import { Matrix4, Vector2, WebGLCoordinateSystem } from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { TAARenderPass } from "three/addons/postprocessing/TAARenderPass.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import * as N from "three/tsl";
import { RenderPipeline } from "three/webgpu";

// Frames to render after invalidation for WebGPU / WebGL fallback TRAA.
const TAA_SETTLE_FRAMES = 32;

/** Viewer-only integration of Three.js's temporal anti-aliasing effects. */
export function createViewerTAA(renderer, scene, camera) {
  if (renderer.isWebGPURenderer) return createNodeTAA(renderer, scene, camera);

  const composer = new EffectComposer(renderer);
  const output = new OutputPass();
  let taa;
  const size = new Vector2();
  function resize() {
    renderer.getSize(size);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(size.x, size.y);
    // TAARenderPass does not resize its hold buffer; recreate it on resize.
    if (taa) {
      composer.removePass(taa);
      taa.dispose();
    }
    taa = new TAARenderPass(scene, camera);
    taa.accumulate = true;
    taa.sampleLevel = 0;
    composer.insertPass(taa, 0);
  }
  composer.addPass(output);
  resize();
  const restart = () => {
    taa.accumulateIndex = -1;
  };
  return {
    render: () => composer.render(),
    invalidate: restart,
    reset: restart,
    resize,
    get needsRender() {
      return taa.accumulateIndex < 32;
    },
    dispose() {
      taa.dispose();
      output.dispose();
      composer.dispose();
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
  const pipeline = new RenderPipeline(renderer, taa.before(scenePass));
  let remainingFrames = TAA_SETTLE_FRAMES;

  return {
    render() {
      pipeline.render();
      remainingFrames = Math.max(0, remainingFrames - 1);
    },
    invalidate() {
      remainingFrames = TAA_SETTLE_FRAMES;
    },
    reset() {
      taa.setSize(1, 1);
      remainingFrames = TAA_SETTLE_FRAMES;
    },
    resize() {
      remainingFrames = TAA_SETTLE_FRAMES;
    },
    get needsRender() {
      return remainingFrames > 0;
    },
    dispose() {
      pipeline.dispose();
      taa.dispose();
      scenePass.dispose();
    },
  };
}
