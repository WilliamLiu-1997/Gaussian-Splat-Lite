import { GaussianSplatRenderer } from "gaussian-splat-lite";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";

import { CameraController } from "../../shared/cameraController.js";
import { createFrameGate } from "../../shared/frameGate.js";

export async function createRenderer(backend, scene, camera, onDirty) {
  const options = {
    powerPreference: "high-performance",
    reversedDepthBuffer: true,
  };
  let renderer;
  let activeBackend = backend;
  if (backend === "webgl") {
    renderer = new THREE.WebGLRenderer(options);
  } else {
    renderer = new WebGPURenderer({
      ...options,
      forceWebGL: backend === "webgl-fallback",
    });
    await renderer.init();
    activeBackend = renderer.backend.isWebGPUBackend
      ? "webgpu"
      : "webgl-fallback";
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const splats = new GaussianSplatRenderer({ renderer, onDirty });

  const controls = new CameraController(renderer, scene, camera, {
    worldUp: camera.up,
    damping: 0.1,
  });
  controls.addEventListener("update", onDirty);
  const overlay = new THREE.Scene();
  overlay.add(controls.indicator);

  const frameGate = createFrameGate(renderer, onDirty);
  return {
    frameGate,
    backend: activeBackend,
    renderer,
    splats,
    controls,
    draw() {
      renderer.render(scene, camera);
      if (controls.indicator.visible) {
        renderer.autoClear = false;
        try {
          renderer.render(overlay, camera);
        } finally {
          renderer.autoClear = true;
        }
      }
    },
    dispose() {
      renderer.setAnimationLoop(null);
      frameGate.dispose();
      controls.removeEventListener("update", onDirty);
      controls.dispose();
      splats.removeFromParent();
      splats.dispose();
      renderer.domElement.remove();
      return renderer.dispose();
    },
  };
}
