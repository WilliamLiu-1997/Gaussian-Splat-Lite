import { SplatFileType, SplatMesh } from "gaussian-splat-lite";
import * as THREE from "three";
import { showFileMeta } from "../../shared/fileMeta.js";
import { frameBounds } from "../../shared/frameBounds.js";
import { createPerformanceStats } from "../../shared/performanceStats.js";
import { ViewerInspector } from "../../shared/viewerInspector.js";
import { createBlindObjectColors } from "./blindObjectColors.js";
import { createObjectInspection } from "./objectInspection.js";
import { createRenderer } from "./renderer.js";

const file = {
  name: "JunkShop-SH3.sog",
  size: 16245327,
  url: new URL("../../JunkShop-SH3.sog", import.meta.url).href,
};

const viewport = document.querySelector("#viewport");
const toolbar = document.querySelector(".toolbar-actions");
const controlsPanel = document.querySelector("#controls-panel");
const controlsToggle = document.querySelector("#controls-toggle");
const controlsClose = document.querySelector("#controls-close");
const controlsReset = document.querySelector("#controls-reset");
const backend = document.querySelector("#backend");
const message = document.querySelector("#backend-message");
const loading = document.querySelector("#loading");
const loadingLabel = document.querySelector("#loading-label");
const progress = loading.querySelector("progress");
const objectColors = document.querySelector("#object-colors");

const resetViewButton = document.querySelector("#reset-view");
const stats = createPerformanceStats(document);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45);

let active;
let model;
let inspection;
let colorEdit;
let disposed = false;
let dirty = true;

function requestRender() {
  dirty = true;
  inspection?.invalidate();
}

function render(time) {
  active.controls.update(time);
  inspection?.update(time);
  drawFrame(time);
}

function drawFrame(time = performance.now()) {
  if (!dirty || !active.frameGate.isReady(drawFrame)) {
    stats.update(time, false);
    return;
  }
  dirty = false;
  active.draw();
  active.frameGate.submitted();
  stats.update(time, true);
}

function resize() {
  const { clientWidth, clientHeight } = viewport;
  active.renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(1, clientHeight);
  camera.updateProjectionMatrix();
  requestRender();
}

async function setBackend(value) {
  controlsReset.disabled = true;
  backend.disabled = true;
  const next = await createRenderer(value, scene, camera, requestRender);
  if (disposed) {
    next.dispose();
    return;
  }
  if (active) next.controls.minDistance = active.controls.minDistance;
  const retired = active?.dispose();
  active = next;
  THREE.ColorManagement.workingColorSpace = active.renderer.isWebGPURenderer
    ? THREE.SRGBColorSpace
    : THREE.LinearSRGBColorSpace;
  active.renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.append(active.renderer.domElement);
  scene.add(active.splats);
  resize();
  // The previous Inspector releases its console hook during renderer disposal.
  await retired;
  if (disposed) return;
  if (active.renderer.isWebGPURenderer) {
    const inspector = new ViewerInspector();
    toolbar.prepend(inspector.domElement);
    active.renderer.inspector = inspector;
  }
  active.renderer.setAnimationLoop(render);
  backend.value = active.backend;
  backend.disabled = false;
  controlsReset.disabled = false;
  message.textContent = "WebGPU is unavailable. Using the WebGL2 fallback.";
  message.hidden = value === active.backend;
}

function resetView() {
  const bounds = model.getBoundingBox().applyMatrix4(model.matrixWorld);
  frameBounds(bounds, camera, active.controls, {
    elevation: 20,
    maxDistance: 10,
  });
  requestRender();
}

async function loadModel() {
  model = new SplatMesh({
    url: file.url,
    fileName: file.name,
    fileType: SplatFileType.SOG,
    blindData: true,
    onProgress({ loaded, total }) {
      if (total > 0) progress.value = loaded / total;
      else progress.removeAttribute("value");
    },
  });
  await model.initialized;
  if (disposed) return;

  model.rotation.x = Math.PI;
  model.updateMatrixWorld(true);
  resetView();

  colorEdit = createBlindObjectColors(model.splats.extra.labeling.objects);
  colorEdit.visible = objectColors.checked;
  model.add(colorEdit);
  objectColors.disabled = false;
  scene.add(model);
  inspection = createObjectInspection({
    model,
    camera,
    viewport,
    requestRender,
  });
  loading.hidden = true;
  resetViewButton.hidden = false;
  controlsToggle.disabled = false;
  showFileMeta(document.querySelector("#file-meta"), file, model.numSplats);
  requestRender();
}

function setControlsOpen(open) {
  controlsPanel.hidden = !open;
  controlsToggle.setAttribute("aria-expanded", String(open));
  if (open) controlsClose.focus();
  else controlsToggle.focus();
}

function setObjectColors(enabled) {
  objectColors.checked = enabled;
  colorEdit.visible = enabled;
  controlsPanel.querySelector(".toggle-value").value = enabled ? "On" : "Off";
  requestRender();
}

async function changeBackend(value) {
  try {
    await setBackend(value);
  } catch (error) {
    backend.value = active.backend;
    backend.disabled = false;
    controlsReset.disabled = false;
    message.textContent = error.message;
    message.hidden = false;
  }
}

resetViewButton.addEventListener("click", resetView);
controlsToggle.addEventListener("click", () =>
  setControlsOpen(controlsPanel.hidden),
);
controlsClose.addEventListener("click", () => setControlsOpen(false));
window.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !controlsPanel.hidden
  ) {
    setControlsOpen(false);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (
    !controlsPanel.hidden &&
    !controlsPanel.contains(event.target) &&
    !controlsToggle.contains(event.target)
  ) {
    setControlsOpen(false);
  }
});
controlsReset.addEventListener("click", () => {
  setObjectColors(false);
  if (active.backend !== "webgpu") void changeBackend("webgpu");
});
objectColors.addEventListener("change", () =>
  setObjectColors(objectColors.checked),
);
backend.addEventListener("change", () => void changeBackend(backend.value));
document
  .querySelector("#retry")
  .addEventListener("click", () => location.reload());
window.addEventListener("resize", () => {
  if (active) resize();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  disposed = true;
  stats.dispose();
  inspection?.dispose();
  active?.dispose();
  model?.dispose();
});

try {
  loadingLabel.textContent = `Loading ${file.name}`;
  await setBackend("webgpu");
  if (!disposed) await loadModel();
} catch (error) {
  loadingLabel.textContent = error.message;
  progress.hidden = true;
  document.querySelector("#retry").hidden = false;
}
