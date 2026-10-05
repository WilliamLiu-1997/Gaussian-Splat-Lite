import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { pass } from "three/tsl";
import { RenderPipeline } from "three/webgpu";

/**
 * Viewer-only half-float blending. The scene blends in a half-float buffer
 * that reaches the canvas in one copy, so colors round to 8 bits once per
 * frame instead of after every Splat.
 */
export function createViewerHalfFloat(renderer, scene, camera) {
  if (renderer.isWebGPURenderer) {
    // The scene pass owns a half-float target that follows the canvas size.
    const scenePass = pass(scene, camera);
    const pipeline = new RenderPipeline(renderer, scenePass);
    return {
      render() {
        pipeline.render();
      },
      dispose() {
        pipeline.dispose();
        scenePass.dispose();
      },
    };
  }

  // Three uses this flag to honor the target's output color space for both
  // ordinary materials and splats, matching direct canvas blending.
  const target = Object.assign(
    new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    }),
    { isXRRenderTarget: true },
  );
  const copy = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { map: { value: target.texture } },
      vertexShader:
        "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader:
        "uniform sampler2D map; void main() { gl_FragColor = texelFetch(map, ivec2(gl_FragCoord.xy), 0); }",
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const size = new THREE.Vector2();
  return {
    render() {
      renderer.getDrawingBufferSize(size);
      // A hidden viewport has no pixels; keep the target allocatable.
      target.setSize(Math.max(size.x, 1), Math.max(size.y, 1));
      target.texture.colorSpace = renderer.outputColorSpace;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      copy.render(renderer);
    },
    dispose() {
      target.dispose();
      copy.material.dispose();
      copy.dispose();
    },
  };
}
