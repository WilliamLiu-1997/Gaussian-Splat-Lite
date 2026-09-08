import {
  GaussianSplatRenderer,
  RadStreamScheduler,
  SogStreamScheduler,
  SplatFileType,
  SplatMesh,
  StochasticResolvePass,
} from "gaussian-splat-lite";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { CameraController } from "./cameraController.js";
import { createFrameGate } from "./frameGate.js";
import { getModelRotationX } from "./modelOrientation.js";
import {
  detectFileType,
  filesFromDrop,
  modelFromLocalFiles,
  modelFromUrl,
} from "./modelSource.js";
import { createReferenceHelpers } from "./referenceHelpers.js";
import { renderOptionGroups } from "./renderOptions.js";
import { createRenderOptionsPanel } from "./renderOptionsPanel.js";
import { ViewerInspector } from "./viewerInspector.js";
import { createViewerUI } from "./viewerUI.js";

const viewport = document.querySelector("#viewport");
const fileInput = document.querySelector("#file-input");
const referenceToggle = document.querySelector("#reference-toggle");
const loadExampleButton = document.querySelector("#load-example");
const urlForm = document.querySelector("#url-form");
const modelUrlInput = document.querySelector("#model-url");
const loadUrlButton = document.querySelector("#load-url");
const renderOptionsContent = document.querySelector("#render-options-content");
const renderOptionsReset = document.querySelector("#render-options-reset");
const sourceUpAxis = document.querySelector("#source-up-axis");

const ui = createViewerUI({
  onCancelLoad: cancelLoading,
  onResetView: () => {
    if (activeSplat) frameSplat(activeSplat);
  },
});

const EXAMPLE_MODEL = {
  name: "multi-material-splats.v4.spz",
  size: 5914266,
  url: new URL("../multi-material-splats.v4.spz", import.meta.url),
  credit: "hybridherbst",
};

const scene = new THREE.Scene();
const controlsOverlayScene = new THREE.Scene();

const referenceHelpers = createReferenceHelpers();
scene.add(referenceHelpers.group);

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
camera.position.set(0, 0, 3);

const rendererParameters = {
  alpha: true,
  powerPreference: "high-performance",
  reversedDepthBuffer: true,
};
let outputColorSpace = THREE.SRGBColorSpace;
THREE.ColorManagement.workingColorSpace = outputColorSpace;

function configureRenderer(value) {
  value.setClearColor(0x000000, 0);
  value.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  value.outputColorSpace = outputColorSpace;
}

async function initializeWebGPURenderer(value, backend, onFailure) {
  let failureMessage;
  if (backend === "webgpu") {
    const getFallback = value._getFallback;
    value._getFallback = (error) => {
      // Three's fallback otherwise discards the native initialization error.
      failureMessage = `Native WebGPU initialization failed: ${String(error)}`;
      console.error("Native WebGPU initialization failed", error);
      onFailure(failureMessage);
      return getFallback.call(value, error);
    };
  }
  await value.init();
  if (backend === "webgpu" && !value.backend.isWebGPUBackend) {
    // Inspector's saved Force WebGL setting can bypass native init entirely.
    onFailure(
      failureMessage ??
        "Native WebGPU was not initialized. Disable Force WebGL in Inspector Settings to use WebGPU.",
    );
  }
}

function createViewerInspector(failureMessage) {
  const inspector = new ViewerInspector();
  if (failureMessage) inspector.console.addMessage("error", failureMessage);
  // Leave the built-in Parameters tab hidden: only FPS and Inspector.
  inspector.parameters.hide();
  inspector.domElement.classList.add("viewer-inspector");
  inspector.profiler.toggleButton.setAttribute(
    "aria-label",
    "Toggle Three.js Inspector",
  );
  inspector.profiler.toggleButton.title = "Three.js Inspector";
  return inspector;
}

async function createRendererState(backend, previous, onFailure = () => {}) {
  const state = {};
  const webGPU = backend !== "webgl";
  try {
    if (webGPU) {
      state.renderer = new WebGPURenderer({
        ...rendererParameters,
        forceWebGL: backend === "webgl-fallback",
      });
      await initializeWebGPURenderer(state.renderer, backend, (message) => {
        state.failureMessage = message;
        onFailure(message);
      });
      configureRenderer(state.renderer);
      state.inspector = createViewerInspector(state.failureMessage);
    } else {
      // WebGL texture setup requires linear working space. Keep the active
      // renderer's space intact until the replacement is ready to mount.
      const workingColorSpace = THREE.ColorManagement.workingColorSpace;
      try {
        THREE.ColorManagement.workingColorSpace = THREE.LinearSRGBColorSpace;
        state.renderer = new THREE.WebGLRenderer(rendererParameters);
        configureRenderer(state.renderer);
      } finally {
        THREE.ColorManagement.workingColorSpace = workingColorSpace;
      }
    }

    state.splatRenderer = new GaussianSplatRenderer({
      renderer: state.renderer,
      onDirty: requestRender,
      autoStochastic: true,
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
    state.controls = new CameraController(state.renderer, scene, camera, {
      worldUp: camera.up,
    });
    if (previous) state.controls.minDistance = previous.controls.minDistance;
    state.frameGate = createFrameGate(
      state.renderer,
      previous ? undefined : requestRender,
    );
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
    ? outputColorSpace
    : THREE.LinearSRGBColorSpace;
  referenceHelpers.syncColors();
  renderer.outputColorSpace = outputColorSpace;
  referenceHelpers.setBackend(webGPU);
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
  // Finalize the drawing buffer after the canvas and Inspector are mounted.
  resizeRenderer();
}

let needsRender = true;
let renderOnDemand = true;
let rendererState = await createRendererState("webgpu");
let { renderer, controls, splatRenderer, frameGate } = rendererState;
mountRendererState(rendererState);

const STATS_UPDATE_INTERVAL_MS = 500;
let statsSampleStart = performance.now();
let statsRenderedFrames = 0;

function updateStats(time, rendered) {
  if (rendered) statsRenderedFrames += 1;

  const elapsed = time - statsSampleStart;
  if (elapsed < STATS_UPDATE_INTERVAL_MS) return;

  ui.updateStats({
    fps: (statsRenderedFrames * 1000) / elapsed,
    memory: performance.memory,
    streamStats: activeStream?.stats,
  });
  statsSampleStart = time;
  statsRenderedFrames = 0;
}

function requestRender() {
  needsRender = true;
}

function renderFrame(time) {
  controls.update(time);
  activeStream?.update(camera, {
    width: renderer.domElement.width,
    height: renderer.domElement.height,
  });
  // Keep LOD requests current while GPU draws wait, retaining pending redraws.
  if (!frameGate.isReady()) {
    updateStats(time, false);
    return;
  }
  if (renderOnDemand && !needsRender) {
    updateStats(time, false);
    return;
  }

  // Synchronous preparation is consumed by this draw; worker completion can
  // still request a later frame through onDirty.
  needsRender = false;
  stochasticResolvePass.compose(renderer, scene, camera);
  // Draw the anchor after resolve so stochastic filtering cannot blur it.
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
  updateStats(time, true);
}

const stochasticResolvePass = new StochasticResolvePass(splatRenderer);
stochasticResolvePass.enabled = true;

const renderOptionActions = {
  rendererBackend: (backend) => {
    void switchRendererBackend(backend);
  },
  outputColorSpace: (enabled) => {
    outputColorSpace = enabled
      ? THREE.SRGBColorSpace
      : THREE.LinearSRGBColorSpace;
    renderer.outputColorSpace = outputColorSpace;
    if (usesNodeRenderer(renderer)) {
      THREE.ColorManagement.workingColorSpace = outputColorSpace;
    }
    referenceHelpers.syncColors();
  },
  renderOnDemand: (value) => {
    renderOnDemand = value;
  },
};

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
  stochasticResolvePass.removeSplatRenderer(state.splatRenderer);
}

function activateRendererState(state, attachInspector = true) {
  rendererState = state;
  ({ renderer, controls, splatRenderer, frameGate } = state);
  stochasticResolvePass.addSplatRenderer(splatRenderer);
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
    // Finalize the drawing buffer before waiting for visibility. Keep the old
    // Inspector attached until disposal, then attach the replacement once.
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
    splatRenderer.setDirty();
  }
  requestRender();
}

const frameSize = new THREE.Vector3();
const frameCenter = new THREE.Vector3();
let activeSplat = null;
let modelUpAxis = "auto";
let activeStream = null;
let disposeActiveSource = null;
let cancelActiveLoad = null;
let activeLoad = 0;
let dragDepth = 0;
const remoteRequestByButton = new WeakMap();

const optionsPanel = createRenderOptionsPanel({
  container: renderOptionsContent,
  groups: renderOptionGroups,
  onChange: applyRenderOption,
});
syncRendererOption(getRendererBackend());
// Keep the initialized backend, including any automatic WebGL fallback.
optionsPanel.reset({ skip: ["rendererBackend"] });

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clearActiveModel() {
  if (activeSplat) scene.remove(activeSplat);
  if (activeStream) activeStream.dispose();
  else activeSplat?.dispose();
  disposeActiveSource?.();
  disposeActiveSource = null;
  activeSplat = null;
  activeStream = null;
  ui.clearModelInfo();
  requestRender();
}

function cancelLoading() {
  activeLoad += 1;
  cancelActiveLoad?.();
  cancelActiveLoad = null;
}

function applyModelOrientation(splat, streamed) {
  // Transform the stream group so rendering and LOD culling share the same
  // rotation; the decoded splats and index bounds remain in source space.
  splat.rotation.set(getModelRotationX(modelUpAxis, streamed), 0, 0);
  splat.updateMatrixWorld(true);
}

function frameSplat(splat) {
  const streamed = activeStream?.group === splat;
  const bounds = streamed
    ? activeStream.getBoundingBox()
    : splat.getBoundingBox(true);
  splat.updateWorldMatrix(true, false);
  bounds.applyMatrix4(splat.matrixWorld);
  bounds.getSize(frameSize);
  if (streamed && !bounds.isEmpty()) bounds.getCenter(frameCenter);
  else frameCenter.set(0, 0, 0);
  const referenceSize =
    Math.max(frameSize.x, frameSize.y, frameSize.z, 0.01) * 1.5;
  referenceHelpers.setFrame(frameCenter, referenceSize);
  const radius = bounds.isEmpty()
    ? 0.01
    : Math.max(frameSize.length() * 0.5, 0.01);
  const defaultCameraDistance = 10;
  const verticalHalfFov =
    THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2;
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * camera.aspect,
  );
  const distance = streamed
    ? (radius * 1.15) / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))
    : Math.min(defaultCameraDistance, radius);

  camera.near = radius * 0.001;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  camera.position
    .set(0, 5, 5 * Math.sqrt(3))
    .setLength(distance)
    .add(frameCenter);
  camera.lookAt(frameCenter);
  camera.updateMatrixWorld(true);
  controls.minDistance = 0;
  controls.setCamera(camera);
}

async function initializeModel(
  model,
  file,
  { url, resolveFile, manager },
  loadId,
) {
  const fileType = await detectFileType(file, url);
  if (loadId !== activeLoad) return;
  const sogStream = url && file.name.toLowerCase() === "lod-meta.json";
  if (!fileType && !sogStream && !url)
    throw new Error("Choose a .ply, .spz, .sog, .rad, or SOG meta.json file.");

  const source = {
    url,
    file: url === undefined ? file : undefined,
    resolveFile,
  };
  if (fileType === SplatFileType.RAD) {
    model.stream = new RadStreamScheduler({
      ...source,
      onChange: requestRender,
      onError: (error, chunkUrl) => {
        console.error("RAD chunk failed", chunkUrl, error);
        if (loadId !== activeLoad || !ui.isLoading) return;
        const detail = error instanceof Error ? error.message : String(error);
        ui.setLoadingDetail(`${chunkUrl}: ${detail}`);
        ui.setStatus("Waiting for a RAD page · retry pending", "error");
      },
    });
    try {
      await model.stream.initialized;
      model.splat = model.stream.group;
      return;
    } catch (error) {
      model.stream.dispose();
      model.stream = null;
      if (loadId !== activeLoad) return;
      if (error.name !== "RadLodRequiredError") throw error;
    }
  }

  if (sogStream) {
    model.stream = new SogStreamScheduler({
      url,
      manager,
      onChange: requestRender,
      onError: (error, chunkUrl) =>
        console.error("Streaming chunk failed", chunkUrl, error),
    });
    model.splat = model.stream.group;
  } else {
    model.splat = new SplatMesh({
      ...source,
      fileName: file.name,
      fileType,
      onProgress: (event) => {
        if (loadId !== activeLoad) return;
        ui.showLoading(file, event.loaded, event.total || file.size);
      },
    });
  }
  await (model.stream ?? model.splat).initialized;
}

async function loadFile(
  file,
  { credit = "", url, button, resolveFile, manager, dispose } = {},
) {
  const loadId = ++activeLoad;
  cancelActiveLoad?.();
  clearActiveModel();

  // Keep ownership available to cancellation while initialization is pending.
  const model = { splat: null, stream: null };
  const disposeModel = () => {
    if (model.splat && activeSplat === model.splat) clearActiveModel();
    else if (model.stream) model.stream.dispose();
    else model.splat?.dispose();
    dispose?.();
  };
  cancelActiveLoad = disposeModel;
  if (button) {
    remoteRequestByButton.set(button, loadId);
    button.disabled = true;
  }
  ui.showLoading(file);
  ui.setStatus(`Loading ${file.name}`, "loading");

  try {
    await initializeModel(model, file, { url, resolveFile, manager }, loadId);

    if (loadId !== activeLoad) {
      disposeModel();
      return;
    }

    applyModelOrientation(
      model.splat,
      model.stream instanceof SogStreamScheduler,
    );
    activeSplat = model.splat;
    activeStream = model.stream;
    disposeActiveSource = dispose;
    scene.add(activeSplat);
    requestRender();
    if (model.stream instanceof RadStreamScheduler) {
      // The active stream advances loading until RAD bounds can frame the view.
      await model.stream.firstRenderable;
      if (loadId !== activeLoad) {
        disposeModel();
        return;
      }
    }
    frameSplat(activeSplat);
    ui.showModelInfo(file, {
      credit,
      numSplats: activeSplat.numSplats,
      streamed: Boolean(activeStream),
    });
    ui.clearLoading();
    requestRender();
  } catch (error) {
    disposeModel();
    if (loadId !== activeLoad) return;

    ui.clearLoading();
    ui.setStatus(`Could not load ${file.name}`, "error");
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load ${file.name}`, error);
    ui.showToast(`Could not load ${file.name}: ${detail}`);
  } finally {
    if (cancelActiveLoad === disposeModel) cancelActiveLoad = null;
    if (button && remoteRequestByButton.get(button) === loadId) {
      remoteRequestByButton.delete(button);
      button.disabled = false;
    }
  }
}

function loadRemoteModel(model, button) {
  return loadFile(model, {
    url: model.url.toString(),
    credit: model.credit,
    button,
  });
}

function openFilePicker() {
  fileInput.value = "";
  fileInput.click();
}

function clearDragState() {
  dragDepth = 0;
  ui.setDropOverlayVisible(false);
}

function resizeRenderer() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
  requestRender();
}

for (const button of document.querySelectorAll("[data-file-picker]")) {
  button.addEventListener("click", openFilePicker);
}

loadExampleButton.addEventListener("click", () => {
  loadRemoteModel(EXAMPLE_MODEL, loadExampleButton);
});

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const model = modelFromUrl(modelUrlInput.value.trim());
  if (!model) {
    ui.showToast(
      "Enter an HTTP(S) model URL (.ply, .spz, .sog, .rad, or a scene index).",
    );
    ui.setStatus("Enter a valid model URL", "error");
    modelUrlInput.focus();
    return;
  }

  modelUrlInput.blur();
  loadRemoteModel(model, loadUrlButton);
});

function loadLocalFiles(files) {
  try {
    const { file, ...source } = modelFromLocalFiles(files);
    void loadFile(file, source);
  } catch (error) {
    ui.showToast(error.message);
  }
}

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length) loadLocalFiles(files);
});

referenceToggle.addEventListener("click", () => {
  const visible = !referenceHelpers.visible;
  referenceHelpers.setVisible(visible);
  referenceToggle.setAttribute("aria-pressed", String(visible));
  referenceToggle.title = visible ? "Hide grid and axes" : "Show grid and axes";
  requestRender();
});

sourceUpAxis.addEventListener("change", (event) => {
  modelUpAxis = event.target.value;
  if (!activeSplat) return;
  applyModelOrientation(
    activeSplat,
    activeStream instanceof SogStreamScheduler,
  );
  requestRender();
});

renderOptionsReset.addEventListener("click", () => {
  // Apply material defaults before the asynchronous backend switch copies them.
  optionsPanel.reset({ last: ["rendererBackend"] });
});

window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  ui.setDropOverlayVisible(true);
});

window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    clearDragState();
    return;
  }
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.setDropOverlayVisible(false);
});

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  clearDragState();

  cancelLoading();
  const loadId = activeLoad;
  try {
    const files = await filesFromDrop(event.dataTransfer);
    if (loadId !== activeLoad) return;
    if (files.length) {
      loadLocalFiles(files);
    } else {
      ui.showToast(
        "Drop a model or a SOG folder containing lod-meta.json and its chunks.",
      );
      ui.setStatus("PLY, SPZ, SOG, and RAD files are supported", "error");
    }
  } catch (error) {
    if (loadId !== activeLoad) return;
    ui.showToast(`Could not read dropped files: ${error.message}`);
    ui.setStatus("Could not read dropped files", "error");
  }
});

window.addEventListener("blur", clearDragState);

window.addEventListener("resize", resizeRenderer);
window.addEventListener("beforeunload", () => {
  viewerDisposed = true;
  rendererSwitchToken += 1;
  renderer.setAnimationLoop(null);
  cancelActiveLoad?.();
  clearActiveModel();
  stochasticResolvePass.dispose();
  referenceHelpers.dispose();
  disposeRendererState(rendererState);
  disposeRendererState(retiringRendererState);
  ui.dispose();
});

resizeRenderer();
if (rendererState.failureMessage) {
  ui.showToast(`${rendererState.failureMessage} Using WebGL2.`);
}
renderer.setAnimationLoop(renderFrame);
