import { SparkRenderer, SplatFileType, SplatMesh } from "gaussian-splat-lite";
import * as THREE from "three";
import { CameraController } from "./cameraController.js";

const viewport = document.querySelector("#viewport");
const fileInput = document.querySelector("#file-input");
const emptyState = document.querySelector("#empty-state");
const resetViewButton = document.querySelector("#reset-view");
const loadingPanel = document.querySelector("#loading-panel");
const loadingName = document.querySelector("#loading-name");
const loadingProgress = document.querySelector("#loading-progress");
const loadingProgressFill = document.querySelector("#loading-progress-fill");
const loadingDetail = document.querySelector("#loading-detail");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const fileMeta = document.querySelector("#file-meta");
const fileName = document.querySelector("#file-name");
const fileStats = document.querySelector("#file-stats");
const dropOverlay = document.querySelector("#drop-overlay");
const toast = document.querySelector("#toast");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.001, 10000);
camera.position.set(0, 0, 3);

const renderer = new THREE.WebGLRenderer({
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.append(renderer.domElement);

const controls = new CameraController(renderer, scene, camera);

const splatRenderer = new SparkRenderer({ renderer });
scene.add(splatRenderer);

const frameSize = new THREE.Vector3();
const frameCenter = new THREE.Vector3();
const frameWorldCenter = new THREE.Vector3();
let activeSplat = null;
let activeLoad = 0;
let dragDepth = 0;
let toastTimer;

const formatNumber = new Intl.NumberFormat();

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }

  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

function fileTypeFor(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ply")) return SplatFileType.PLY;
  if (name.endsWith(".spz")) return SplatFileType.SPZ;
  return undefined;
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function setStatus(message, state = "ready") {
  statusText.textContent = message;
  statusDot.dataset.state = state;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
    window.setTimeout(() => {
      toast.hidden = true;
    }, 180);
  }, 4200);
}

function setLoading(file, loaded = 0, total = file.size) {
  loadingPanel.hidden = false;
  loadingName.textContent = file.name;

  if (total > 0 && loaded >= 0) {
    const ratio = Math.min(loaded / total, 1);
    const percent = Math.round(ratio * 100);
    loadingProgress.classList.remove("is-indeterminate");
    loadingProgressFill.style.transform = `scaleX(${ratio})`;
    loadingProgress.setAttribute("aria-valuemin", "0");
    loadingProgress.setAttribute("aria-valuemax", "100");
    loadingProgress.setAttribute("aria-valuenow", String(percent));
    loadingDetail.textContent =
      ratio >= 1
        ? "File received · Finalizing…"
        : `${percent}% · ${formatBytes(loaded)} of ${formatBytes(total)}`;
  } else {
    loadingProgress.classList.add("is-indeterminate");
    loadingProgress.removeAttribute("aria-valuenow");
    loadingDetail.textContent = "Decoding locally…";
  }
}

function clearLoading() {
  loadingPanel.hidden = true;
  loadingProgressFill.style.transform = "scaleX(0)";
}

function frameSplat(splat) {
  const bounds = splat.getBoundingBox(true);

  if (bounds.isEmpty()) {
    splat.position.set(0, 0, 0);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    controls.setCamera(camera);
    return;
  }

  bounds.getCenter(frameCenter);
  bounds.getSize(frameSize);
  frameWorldCenter
    .copy(frameCenter)
    .multiply(splat.scale)
    .applyQuaternion(splat.quaternion);
  splat.position.copy(frameWorldCenter).multiplyScalar(-1);
  splat.updateMatrixWorld(true);

  const radius = Math.max(frameSize.length() * 0.5, 0.01);
  const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const halfHorizontalFov = Math.atan(
    Math.tan(halfVerticalFov) * camera.aspect,
  );
  const limitingFov = Math.max(
    Math.min(halfVerticalFov, halfHorizontalFov),
    0.1,
  );
  const distance = (radius / Math.sin(limitingFov)) * 1.15;

  camera.near = Math.max(radius / 1000, 0.0001);
  camera.far = Math.max(distance + radius * 20, 100);
  camera.updateProjectionMatrix();
  camera.position.set(radius * 0.12, radius * 0.08, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  controls.minDistance = radius * 0.02;
  controls.setCamera(camera);
}

async function loadFile(file) {
  const fileType = fileTypeFor(file);
  if (!fileType) {
    showToast("Unsupported file. Choose a .ply or .spz file.");
    setStatus("Only PLY and SPZ files are supported", "error");
    return;
  }

  const loadId = ++activeLoad;
  setLoading(file);
  setStatus(`Loading ${file.name}`, "loading");

  const candidate = new SplatMesh({
    fileName: file.name,
    fileType,
    stream: file.stream(),
    streamLength: file.size,
    onProgress: (event) => {
      if (loadId !== activeLoad) return;
      setLoading(file, event.loaded, event.total || file.size);
    },
  });

  // Match Spark 2.1's viewer convention: file-space +Y down / +Z forward
  // becomes Three.js +Y up / -Z forward without changing decoded splat data.
  candidate.quaternion.set(1, 0, 0, 0);

  try {
    await candidate.initialized;

    if (loadId !== activeLoad) {
      candidate.dispose();
      return;
    }

    const previousSplat = activeSplat;
    activeSplat = candidate;
    scene.add(activeSplat);
    if (previousSplat) {
      scene.remove(previousSplat);
      previousSplat.dispose();
    }
    frameSplat(activeSplat);

    emptyState.hidden = true;
    resetViewButton.hidden = false;
    fileMeta.hidden = false;
    fileName.textContent = file.name;
    fileStats.textContent = `${formatNumber.format(activeSplat.numSplats)} splats · ${formatBytes(file.size)}`;
    setStatus("Loaded and ready", "success");
    clearLoading();
  } catch (error) {
    candidate.dispose();
    if (loadId !== activeLoad) return;

    clearLoading();
    setStatus(`Could not load ${file.name}`, "error");
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load ${file.name}`, error);
    showToast(`Could not load ${file.name}: ${detail}`);
  }
}

function openFilePicker() {
  fileInput.value = "";
  fileInput.click();
}

function clearDragState() {
  dragDepth = 0;
  dropOverlay.hidden = true;
}

function resizeRenderer() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();
}

for (const button of document.querySelectorAll("[data-file-picker]")) {
  button.addEventListener("click", openFilePicker);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});

resetViewButton.addEventListener("click", () => {
  if (activeSplat) frameSplat(activeSplat);
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;

  if (
    !isTyping &&
    event.key.toLowerCase() === "o" &&
    !event.metaKey &&
    !event.ctrlKey
  ) {
    event.preventDefault();
    openFilePicker();
  }
});

window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
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
  if (dragDepth === 0) dropOverlay.hidden = true;
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  clearDragState();

  const files = Array.from(event.dataTransfer?.files ?? []);
  const file = files.find((entry) => fileTypeFor(entry));
  if (file) {
    loadFile(file);
  } else {
    showToast("No supported file found. Drop a .ply or .spz file.");
    setStatus("Only PLY and SPZ files are supported", "error");
  }
});

window.addEventListener("blur", clearDragState);

window.addEventListener("resize", resizeRenderer);
window.addEventListener("beforeunload", () => {
  renderer.setAnimationLoop(null);
  controls.dispose();
  activeSplat?.dispose();
  splatRenderer.dispose();
  renderer.dispose();
});

resizeRenderer();
renderer.setAnimationLoop((time) => {
  controls.update(time);
  renderer.render(scene, camera);
});
