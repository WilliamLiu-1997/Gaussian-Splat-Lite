import {
  GaussianSplatRenderer,
  SplatFileType,
  SplatMesh,
} from "gaussian-splat-lite";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { CameraController } from "../../shared/cameraController.js";
import { frameBounds } from "../../shared/frameBounds.js";
import { createFrameGate } from "../../shared/frameGate.js";
import { ViewerInspector } from "../../shared/viewerInspector.js";
import { createExampleUI } from "./exampleUI.js";
import { renderOptionGroups } from "./renderOptions.js";
import { createRenderOptionsPanel } from "./renderOptionsPanel.js";
import { createViewerDenoise } from "./viewerDenoise.js";
import { createViewerHalfFloat } from "./viewerHalfFloat.js";

const file = {
  name: "JunkShop-SH3.sog",
  size: 16245327,
  url: new URL("../../JunkShop-SH3.sog", import.meta.url).href,
};

const viewport = document.querySelector("#viewport");
const renderOptionsContent = document.querySelector("#render-options-content");
const renderOptionsReset = document.querySelector("#render-options-reset");

const ui = createExampleUI({
  onCancelLoad: cancelLoading,
  onResetView: () => {
    if (activeSplat) frameSplat(activeSplat);
  },
});

const scene = new THREE.Scene();
const controlsOverlayScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
camera.position.set(0, 0, 3);

const rendererParameters = {
  alpha: true,
  powerPreference: "high-performance",
  reversedDepthBuffer: true,
};
THREE.ColorManagement.workingColorSpace = THREE.SRGBColorSpace;

function configureRenderer(value) {
  value.setClearColor(0x000000, 0);
  value.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

async function initializeWebGPURenderer(value, backend, onFailure) {
  await value.init();
  if (backend === "webgpu" && !value.backend.isWebGPUBackend) {
    // Inspect the initialized backend without replacing Three's fallback hook.
    onFailure(
      "Native WebGPU was not initialized. Check browser support to use WebGPU.",
    );
  }
}

async function createRendererState(backend, previous, onFailure = () => {}) {
  const state = {};
  try {
    if (backend === "webgl") {
      state.renderer = new THREE.WebGLRenderer(rendererParameters);
    } else {
      // Match Three's adapter options; leave failures to its WebGL fallback.
      const adapter =
        backend === "webgpu"
          ? await navigator.gpu
              ?.requestAdapter({
                powerPreference: rendererParameters.powerPreference,
                featureLevel: "compatibility",
                xrCompatible: false,
              })
              .catch(() => null)
          : null;
      state.renderer = new WebGPURenderer({
        ...rendererParameters,
        forceWebGL: backend === "webgl-fallback",
        requiredLimits: adapter
          ? {
              maxStorageBufferBindingSize:
                adapter.limits.maxStorageBufferBindingSize,
              maxBufferSize: adapter.limits.maxBufferSize,
            }
          : undefined,
      });
      await initializeWebGPURenderer(state.renderer, backend, (message) => {
        state.failureMessage = message;
        onFailure(message);
      });
      state.inspector = new ViewerInspector();
    }
    configureRenderer(state.renderer);

    state.splatRenderer = new GaussianSplatRenderer({
      renderer: state.renderer,
      onDirty: requestRender,
    });
    if (previous) {
      for (const group of renderOptionGroups) {
        for (const option of group.options) {
          if (!renderOptionActions[option.property]) {
            state.splatRenderer[option.property] =
              previous.splatRenderer[option.property];
          }
        }
      }
    }
    if (denoiseEnabled && state.splatRenderer.stochastic) {
      state.denoiser = createViewerDenoise(state.renderer, scene, camera, {
        mode: denoiserMode,
        msaa,
      });
    }
    state.controls = new CameraController(state.renderer, scene, camera, {
      worldUp: camera.up,
      damping: 0.1,
    });
    if (previous) state.controls.minDistance = previous.controls.minDistance;
    state.frameGate = createFrameGate(
      state.renderer,
      previous ? undefined : requestRender,
    );
    state.drawPendingFrame = () => {
      if (rendererState === state && !state.disposed) {
        drawFrame(performance.now());
      }
    };
    return state;
  } catch (error) {
    disposeRendererState(state);
    throw error;
  }
}

function disposeRendererState(state) {
  if (!state || state.disposed) return;
  state.disposed = true;
  state.renderer?.setAnimationLoop(null);
  state.frameGate?.dispose();
  state.controls?.removeEventListener("update", requestRender);
  state.controls?.dispose();
  state.denoiser?.dispose();
  state.halfFloat?.dispose();
  state.splatRenderer?.removeFromParent();
  state.splatRenderer?.dispose();
  // An attached Inspector is owned and disposed by the renderer.
  if (state.inspector && state.renderer.inspector !== state.inspector) {
    state.inspector.dispose();
  }
  state.renderer?.dispose();
  state.renderer?.domElement.remove();
}

function mountRendererState(state, attachInspector = true) {
  const { renderer, controls, splatRenderer, inspector } = state;
  const webGPU = usesNodeRenderer(renderer);
  THREE.ColorManagement.workingColorSpace = webGPU
    ? THREE.SRGBColorSpace
    : THREE.LinearSRGBColorSpace;
  // WebGL's output setter requires the linear working space to be set first.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  controlsOverlayScene.add(controls.indicator);
  controls.addEventListener("update", requestRender);
  scene.add(splatRenderer);
  if (renderer.domElement.parentNode !== viewport) {
    viewport.append(renderer.domElement);
  }
  if (attachInspector) {
    ui.mountInspector(inspector?.domElement);
    if (inspector && renderer.inspector !== inspector) {
      renderer.inspector = inspector;
    }
  }
  // Finalize the drawing buffer after the canvas is mounted.
  resizeRenderer();
}

let needsRender = true;
let denoiser = null;
let renderOnDemand = true;
let halfFloatBlending = true;
let denoiseEnabled = true;
let denoiserMode = "performance";
let msaa = false;
let rendererState = await createRendererState("webgpu");
let { renderer, controls, splatRenderer, frameGate } = rendererState;
mountRendererState(rendererState);

function requestRender() {
  needsRender = true;
  denoiser?.invalidate();
}

function renderFrame(time) {
  // Keep camera and LOD updates running while the GPU is busy.
  controls.update(time);
  drawFrame(time);
}

function drawFrame(time) {
  // Replay a blocked draw without waiting for another animation tick.
  if (
    !frameGate.isReady(rendererState.drawPendingFrame) ||
    (renderOnDemand && !needsRender && !denoiser?.needsRender)
  ) {
    ui.updateStats(time, false);
    return;
  }

  // Synchronous preparation is consumed by this draw; worker completion can
  // still request a later frame through onDirty.
  needsRender = false;
  if (denoiser) {
    denoiser.render();
    // WebGL backends draw stochastically until the sorted order is ready.
    if (!splatRenderer.stochastic && !splatRenderer.stochasticActive) {
      retireDenoiser();
    }
  } else if (halfFloatBlending) {
    // Each renderer builds its buffer on its first draw without denoising.
    rendererState.halfFloat ??= createViewerHalfFloat(renderer, scene, camera);
    rendererState.halfFloat.render();
  } else {
    renderer.render(scene, camera);
  }
  // Draw the anchor over the scene.
  // Its material disables depth testing/writes, so no depth clear is needed.
  if (controls.indicator.visible) {
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.render(controlsOverlayScene, camera);
    } finally {
      renderer.autoClear = previousAutoClear;
    }
  }
  frameGate.submitted();
  ui.updateStats(time, true);
}

const renderOptionActions = {
  rendererBackend: (backend) => {
    void switchRendererBackend(backend);
  },
  renderOnDemand: (value) => {
    renderOnDemand = value;
  },
  halfFloatBlending: (value) => {
    halfFloatBlending = value;
    if (!value) {
      rendererState.halfFloat?.dispose();
      rendererState.halfFloat = null;
    }
  },
  denoiseEnabled: (value) => {
    denoiseEnabled = value;
    replaceDenoiser();
  },
  denoiserQuality: (value) => {
    denoiserMode = value ? "quality" : "performance";
    replaceDenoiser();
  },
  msaa: (value) => {
    msaa = value;
    replaceDenoiser();
  },
};

// Apply denoising settings, starting any new filter without history.
function replaceDenoiser() {
  if (!denoiser && !splatRenderer.stochastic) return;
  denoiser?.dispose();
  denoiser = denoiseEnabled
    ? createViewerDenoise(renderer, scene, camera, {
        mode: denoiserMode,
        msaa,
      })
    : null;
  rendererState.denoiser = denoiser;
}

let rendererSwitchToken = 0;
let rendererSwitchTask = Promise.resolve();
let retiringRendererState = null;
let viewerDisposed = false;

function usesNodeRenderer(value) {
  return value.isWebGPURenderer === true;
}

function getRendererBackend() {
  if (!usesNodeRenderer(renderer)) return "webgl";
  return renderer.backend.isWebGPUBackend ? "webgpu" : "webgl-fallback";
}

function syncRendererOption(backend, disabled = false) {
  optionsPanel.setValue("rendererBackend", backend);
  optionsPanel.setDisabled("rendererBackend", disabled);
}

function switchRendererBackend(backend) {
  const switchToken = ++rendererSwitchToken;
  // Reset can request another backend while the selector is disabled.
  rendererSwitchTask = rendererSwitchTask
    .then(() => performRendererSwitch(backend, switchToken))
    .catch((error) => console.error("Renderer switch failed", error));
  return rendererSwitchTask;
}

function detachRendererState(state) {
  state.renderer.setAnimationLoop(null);
  state.controls.enabled = false;
  state.controls.removeEventListener("update", requestRender);
  state.controls.indicator.removeFromParent();
  state.splatRenderer.removeFromParent();
}

function activateRendererState(state, attachInspector = true) {
  rendererState = state;
  ({ renderer, controls, splatRenderer, frameGate } = state);
  denoiser = state.denoiser ?? null;
  mountRendererState(state, attachInspector);
}

async function performRendererSwitch(backend, switchToken) {
  if (viewerDisposed || switchToken !== rendererSwitchToken) return;
  if (backend === getRendererBackend()) {
    syncRendererOption(backend);
    return;
  }

  syncRendererOption(backend, true);
  const previous = rendererState;
  const previousCanvas = previous.renderer.domElement;
  const previousOpacity = previousCanvas.style.opacity;
  const previousControlsEnabled = previous.controls.enabled;
  let next;
  let activated = false;
  let committed = false;
  let webGPUFailureMessage;
  try {
    next = await createRendererState(backend, previous, (message) => {
      webGPUFailureMessage = message;
      if (switchToken === rendererSwitchToken) ui.showToast(message);
    });
    checkRendererSwitch(switchToken);
    // Prepare the replacement in the DOM while the old canvas stays visible.
    const canvas = next.renderer.domElement;
    canvas.style.opacity = "0";
    canvas.style.pointerEvents = "none";
    viewport.append(canvas);
    await waitForCanvasPaint(switchToken);

    retiringRendererState = previous;
    activated = true;
    detachRendererState(previous);
    // Attach the replacement Inspector after disposing the old console hook.
    activateRendererState(next, false);
    await next.splatRenderer.update({ scene, camera });
    checkRendererSwitch(switchToken);
    canvas.style.removeProperty("opacity");
    await waitForCanvasPaint(switchToken);

    previousCanvas.style.opacity = "0";
    requestRender();
    renderFrame(performance.now());
    while (!next.frameGate.isReady()) {
      await waitForCanvasPaint(switchToken);
    }
    await waitForCanvasPaint(switchToken);

    disposeRendererState(previous);
    retiringRendererState = null;
    committed = true;
    ui.mountInspector(next.inspector?.domElement);
    if (next.inspector) renderer.inspector = next.inspector;
    canvas.style.removeProperty("pointer-events");
    controls.enabled = previousControlsEnabled;
    renderer.setAnimationLoop(renderFrame);
    if (next.failureMessage) {
      ui.showToast(`${next.failureMessage} Using WebGL2.`);
    }
  } catch (error) {
    if (!viewerDisposed && activated && !committed) {
      previousCanvas.style.opacity = previousOpacity;
      detachRendererState(next);
      disposeRendererState(next);
      activateRendererState(previous);
      controls.enabled = previousControlsEnabled;
      renderer.setAnimationLoop(renderFrame);
      requestRender();
    }
    if (viewerDisposed || switchToken !== rendererSwitchToken) return;
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Could not switch renderer", error);
    const message = `Could not switch renderer: ${detail}`;
    ui.showToast(
      webGPUFailureMessage ? `${webGPUFailureMessage}\n${message}` : message,
    );
  } finally {
    if (!committed) disposeRendererState(next);
    if (retiringRendererState === previous) retiringRendererState = null;
    if (!viewerDisposed && switchToken === rendererSwitchToken) {
      syncRendererOption(getRendererBackend());
    }
  }
}

function checkRendererSwitch(switchToken) {
  if (viewerDisposed || switchToken !== rendererSwitchToken) {
    throw new DOMException("Renderer switch cancelled", "AbortError");
  }
}

async function waitForCanvasPaint(switchToken) {
  checkRendererSwitch(switchToken);
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  checkRendererSwitch(switchToken);
}

function applyRenderOption(property, value) {
  const apply = renderOptionActions[property];
  if (apply) {
    apply(value);
  } else {
    splatRenderer[property] = value;
    // Turning stochastic off keeps denoising until drawFrame sees it inactive.
    if (property === "stochastic" && value && !denoiser) {
      replaceDenoiser();
    }
    splatRenderer.setDirty();
  }
  requestRender();
}

function retireDenoiser() {
  denoiser.dispose();
  denoiser = null;
  rendererState.denoiser = null;
  // Redraw the sorted image without denoising history.
  requestRender();
}

let activeSplat = null;
let pendingSplat = null;
let loadId = 0;

const optionsPanel = createRenderOptionsPanel({
  container: renderOptionsContent,
  groups: renderOptionGroups,
  onChange: applyRenderOption,
});
syncRendererOption(getRendererBackend());
// Keep the initialized backend, including any automatic WebGL fallback.
optionsPanel.reset({ skip: ["rendererBackend"] });

function clearModel() {
  activeSplat?.removeFromParent();
  activeSplat?.dispose();
  activeSplat = null;
  denoiser?.reset();
  ui.clearModelInfo();
  requestRender();
}

function cancelLoading() {
  loadId++;
  pendingSplat?.dispose();
  pendingSplat = null;
}

function frameSplat(splat) {
  denoiser?.reset();
  const bounds = splat.getBoundingBox().applyMatrix4(splat.matrixWorld);
  frameBounds(bounds, camera, controls, { elevation: 20, maxDistance: 10 });
}

async function loadScene() {
  cancelLoading();
  const currentLoad = loadId;
  clearModel();
  ui.showLoading(file);
  ui.setStatus(`Loading ${file.name}`);
  try {
    const splat = new SplatMesh({
      url: file.url,
      fileName: file.name,
      fileType: SplatFileType.SOG,
      blindData: false,
      onProgress({ loaded, total, stage }) {
        if (currentLoad === loadId) {
          ui.showLoading(
            file,
            loaded,
            stage === "download" ? total || file.size : total,
            stage,
          );
        }
      },
    });
    pendingSplat = splat;
    await splat.initialized;
    if (currentLoad !== loadId) return;
    pendingSplat = null;
    activeSplat = splat;
    scene.add(splat);
    // The bundled scene uses Y-down coordinates.
    splat.rotation.x = Math.PI;
    splat.updateMatrixWorld(true);
    frameSplat(splat);
    ui.showModelInfo(file, splat.numSplats);
    requestRender();
  } catch (error) {
    if (currentLoad !== loadId) return;
    pendingSplat?.dispose();
    pendingSplat = null;
    clearModel();
    ui.showRetry();
    ui.setStatus(`Could not load ${file.name}`);
    ui.showToast(`Could not load ${file.name}: ${error.message}`);
    console.error(`Failed to load ${file.name}`, error);
  } finally {
    if (currentLoad === loadId) ui.clearLoading();
  }
}

function resizeRenderer() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  denoiser?.setSize(width, height);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  requestRender();
}

renderOptionsReset.addEventListener("click", () => {
  // Apply material defaults before the asynchronous backend switch copies them.
  optionsPanel.reset({ last: ["rendererBackend"] });
});

window.addEventListener("resize", resizeRenderer);
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  viewerDisposed = true;
  rendererSwitchToken += 1;
  renderer.setAnimationLoop(null);
  cancelLoading();
  clearModel();
  disposeRendererState(rendererState);
  disposeRendererState(retiringRendererState);
  ui.dispose();
});

resizeRenderer();
if (rendererState.failureMessage) {
  ui.showToast(`${rendererState.failureMessage} Using WebGL2.`);
}
renderer.setAnimationLoop(renderFrame);

document.querySelector("#load-scene").addEventListener("click", loadScene);
void loadScene();
