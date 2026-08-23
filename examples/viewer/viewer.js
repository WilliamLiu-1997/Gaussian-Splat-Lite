import {
  GaussianSplatRenderer,
  SplatFileType,
  SplatMesh,
} from "gaussian-splat-lite";
import * as THREE from "three";
import { CameraController } from "./cameraController.js";

const viewport = document.querySelector("#viewport");
const interfaceRoot = document.querySelector(".interface");
const toolbarActions = document.querySelector(".toolbar-actions");
const statusBar = document.querySelector(".statusbar");
const fileInput = document.querySelector("#file-input");
const emptyState = document.querySelector("#empty-state");
const sourcePanelBackdrop = document.querySelector("#source-panel-backdrop");
const sourcePanelToggle = document.querySelector("#source-panel-toggle");
const sourcePanelClose = document.querySelector("#source-panel-close");
const chooseFileButton = document.querySelector("#choose-file");
const resetViewButton = document.querySelector("#reset-view");
const loadExampleButton = document.querySelector("#load-example");
const urlForm = document.querySelector("#url-form");
const modelUrlInput = document.querySelector("#model-url");
const loadUrlButton = document.querySelector("#load-url");
const loadingBackdrop = document.querySelector("#loading-backdrop");
const loadingPanel = document.querySelector("#loading-panel");
const loadingCancelButton = document.querySelector("#loading-cancel");
const loadingName = document.querySelector("#loading-name");
const loadingProgress = document.querySelector("#loading-progress");
const loadingProgressFill = document.querySelector("#loading-progress-fill");
const loadingDetail = document.querySelector("#loading-detail");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const fileMeta = document.querySelector("#file-meta");
const fileName = document.querySelector("#file-name");
const fileStats = document.querySelector("#file-stats");
const modelCredit = document.querySelector("#model-credit");
const modelCreditPrefix = document.querySelector("#model-credit-prefix");
const modelCreditSeparator = document.querySelector("#model-credit-separator");
const dropOverlay = document.querySelector("#drop-overlay");
const toast = document.querySelector("#toast");
const renderOptionsToggle = document.querySelector("#render-options-toggle");
const renderOptionsPanel = document.querySelector("#render-options");
const renderOptionsClose = document.querySelector("#render-options-close");
const renderOptionsContent = document.querySelector("#render-options-content");
const renderOptionsReset = document.querySelector("#render-options-reset");
const performanceFps = document.querySelector("#performance-fps");
const performanceHeap = document.querySelector("#performance-heap");

const EXAMPLE_MODEL = {
  name: "lion.v3.spz",
  size: 4303196,
  url: new URL("../lion.v3.spz", import.meta.url),
  credit: "Renaud",
};

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

const controls = new CameraController(renderer, scene, camera, {
  worldUp: camera.up,
});

let needsRender = true;
let renderOnDemand = true;
const STATS_UPDATE_INTERVAL_MS = 500;
let statsSampleStart = performance.now();
let statsRenderedFrames = 0;

function formatHeapSize(bytes) {
  const mebibytes = bytes / (1024 * 1024);
  if (mebibytes >= 1024) return `${(mebibytes / 1024).toFixed(1)} GB`;
  return `${mebibytes.toFixed(mebibytes >= 100 ? 0 : 1)} MB`;
}

function updateHeapStat() {
  const memory = performance.memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
    performanceHeap.value = "N/A";
    performanceHeap.title =
      "JS heap reporting is not available in this browser.";
    return;
  }

  performanceHeap.value = formatHeapSize(memory.usedJSHeapSize);
  performanceHeap.title = Number.isFinite(memory.jsHeapSizeLimit)
    ? `${formatHeapSize(memory.usedJSHeapSize)} used of ${formatHeapSize(memory.jsHeapSizeLimit)}`
    : `${formatHeapSize(memory.usedJSHeapSize)} used`;
}

function updateStats(time, rendered) {
  if (rendered) statsRenderedFrames += 1;

  const elapsed = time - statsSampleStart;
  if (elapsed < STATS_UPDATE_INTERVAL_MS) return;

  const fps = (statsRenderedFrames * 1000) / elapsed;
  performanceFps.value = fps >= 10 ? Math.round(fps) : fps.toFixed(1);
  updateHeapStat();
  statsSampleStart = time;
  statsRenderedFrames = 0;
}

updateHeapStat();

function requestRender() {
  needsRender = true;
}

function renderFrame(time) {
  controls.update(time);
  const rendered = !renderOnDemand || needsRender;
  if (rendered) {
    needsRender = false;
    renderer.render(scene, camera);
  }
  updateStats(time, rendered);
}

controls.addEventListener("update", requestRender);

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  onDirty: requestRender,
});
scene.add(splatRenderer);

const renderOptionGroups = [
  {
    title: "Performance & diagnostics",
    description: "Frame scheduling and live metrics.",
    options: [
      {
        property: "renderOnDemand",
        description:
          "Skips unchanged frames. Disable it to render continuously for profiling.",
        defaultValue: true,
        falseLabel: "Continuous",
        trueLabel: "On demand",
        apply: (value) => {
          renderOnDemand = value;
        },
      },
    ],
  },
  {
    title: "Splat appearance",
    description:
      "Shape, filtering, screen-space size, and accumulator precision.",
    options: [
      {
        property: "accumPackedSplats",
        description:
          "Compresses intermediate splat buffers to save GPU memory at the cost of precision.",
        defaultValue: false,
        falseLabel: "Full precision",
        trueLabel: "Packed",
      },
      {
        property: "maxStdDev",
        description:
          "Draws more of each Gaussian tail. Higher is softer but costs more fill rate.",
        min: 1,
        max: 4,
        step: 0.05,
        defaultValue: Math.sqrt(8),
        format: (value) => value.toFixed(2),
      },
      {
        property: "minPixelRadius",
        description:
          "Hides splats whose two screen-space radii are below this pixel size.",
        min: 0,
        max: 4,
        step: 0.05,
        defaultValue: 1,
        format: (value) => `${value.toFixed(2)} px`,
      },
      {
        property: "maxPixelRadius",
        description: "Caps very large nearby splats to limit overdraw.",
        min: 16,
        max: 1024,
        step: 16,
        defaultValue: 512,
        format: (value) => `${Math.round(value)} px`,
      },
      {
        property: "minAlpha",
        description:
          "Discards faint splats and fragments. Raise it to reveal the cutoff boundary.",
        min: 0,
        max: 0.1,
        step: 0.5 / 255,
        defaultValue: 0.5 / 255,
        format: (value) => value.toFixed(4),
      },
      {
        property: "preBlurAmount",
        description: "Enlarges and brightens splats before opacity correction.",
        min: 0,
        max: 2,
        step: 0.01,
        defaultValue: 0,
        format: (value) => value.toFixed(2),
      },
      {
        property: "blurAmount",
        description:
          "Smooths small splats while correcting opacity to preserve their energy.",
        min: 0,
        max: 2,
        step: 0.01,
        defaultValue: 0.3,
        format: (value) => value.toFixed(2),
      },
      {
        property: "focalAdjustment",
        description:
          "Changes projected splat size. Higher values generally appear sharper.",
        min: 0.5,
        max: 4,
        step: 0.05,
        defaultValue: 2,
        format: (value) => `${value.toFixed(2)}×`,
      },
      {
        property: "enable2DGS",
        description:
          "Treats splats with one zero scale axis as oriented 2D Gaussians.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
    ],
  },
  {
    title: "Depth of field",
    description: "Focus is enabled when both controls are above zero.",
    options: [
      {
        property: "focalDistance",
        description:
          "Distance from the camera to the sharp focal plane, in scene units.",
        min: 0,
        max: 100,
        step: 0.1,
        defaultValue: 0,
        format: formatSceneUnits,
      },
      {
        property: "apertureAngle",
        description:
          "Widens the depth-of-field blur cone. Zero disables the effect.",
        min: 0,
        max: 0.35,
        step: 0.0025,
        defaultValue: 0,
        format: (value) => `${THREE.MathUtils.radToDeg(value).toFixed(1)}°`,
      },
    ],
  },
  {
    title: "Culling & sorting",
    description: "Trade image stability for rendering work.",
    options: [
      {
        property: "clipXY",
        description:
          "Keeps splat centers this far beyond the viewport before culling them.",
        min: 1,
        max: 3,
        step: 0.05,
        defaultValue: 1.25,
        format: (value) => `${value.toFixed(2)}×`,
      },
      {
        property: "minSortIntervalMs",
        description:
          "Limits how often depth sorting runs. Higher values save work but may lag while moving.",
        min: 0,
        max: 500,
        step: 10,
        defaultValue: 0,
        format: (value) => `${Math.round(value)} ms`,
      },
      {
        property: "sortRadial",
        description:
          "Radial is stable while orbiting; Z-depth can match trained scenes more accurately.",
        defaultValue: false,
        falseLabel: "Z-depth",
        trueLabel: "Radial",
      },
    ],
  },
  {
    title: "Material pipeline",
    description: "How splats blend with the Three.js scene.",
    options: [
      {
        property: "premultipliedAlpha",
        target: "material",
        description:
          "Uses RGB already multiplied by alpha for edge-correct blending.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
        needsMaterialUpdate: true,
      },
      {
        property: "depthTest",
        target: "material",
        description:
          "Lets opaque Three.js geometry occlude splats using the depth buffer.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "depthWrite",
        target: "material",
        description:
          "Writes splats to depth. This can create hard artifacts in transparent areas.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "transparent",
        target: "material",
        description:
          "Places splats in Three.js’s transparent pass instead of its opaque pass.",
        defaultValue: true,
        falseLabel: "Opaque",
        trueLabel: "Transparent",
        needsMaterialUpdate: true,
      },
    ],
  },
];

const renderOptionInputs = new Map();

function formatSceneUnits(value) {
  if (value === 0) return "Off";
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function optionTarget(option) {
  return option.target === "material" ? splatRenderer.material : splatRenderer;
}

function applyRenderOption(option, value) {
  if (option.apply) {
    option.apply(value);
  } else {
    optionTarget(option)[option.property] = value;
    if (option.needsMaterialUpdate) splatRenderer.material.needsUpdate = true;
    splatRenderer.setDirty();
  }
  requestRender();
}

function createRenderOptions() {
  for (const group of renderOptionGroups) {
    const section = document.createElement("section");
    section.className = "option-group";

    const heading = document.createElement("div");
    heading.className = "option-group-heading";
    heading.innerHTML = `<h3>${group.title}</h3><p>${group.description}</p>`;
    section.append(heading);

    for (const option of group.options) {
      const row = document.createElement("div");
      row.className = "option-row";

      const copy = document.createElement("div");
      copy.className = "option-copy";
      const label = document.createElement("label");
      label.htmlFor = `render-option-${option.property}`;
      label.textContent = option.property;
      const description = document.createElement("p");
      description.textContent = option.description;
      copy.append(label, description);

      const control = document.createElement("div");
      control.className = "option-control";
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.dataset.renderOption = option.property;

      if (typeof option.defaultValue === "boolean") {
        row.classList.add("option-row-toggle");
        input.type = "checkbox";
        input.className = "toggle-input";
        input.checked = option.defaultValue;
        const toggle = document.createElement("label");
        toggle.className = "toggle-track";
        toggle.htmlFor = input.id;
        toggle.setAttribute("aria-hidden", "true");
        const value = document.createElement("output");
        value.className = "toggle-value";
        value.setAttribute("for", input.id);
        const update = () => {
          value.value = input.checked ? option.trueLabel : option.falseLabel;
          value.textContent = value.value;
          applyRenderOption(option, input.checked);
        };
        input.addEventListener("change", update);
        control.append(value, input, toggle);
        input.updateOption = update;
      } else {
        input.type = "range";
        input.className = "range-input";
        input.min = String(option.min);
        input.max = String(option.max);
        input.step = String(option.step);
        input.value = String(option.defaultValue);
        const value = document.createElement("output");
        value.className = "range-value";
        value.setAttribute("for", input.id);
        const update = () => {
          const numericValue = Number(input.value);
          value.value = option.format(numericValue);
          value.textContent = value.value;
          applyRenderOption(option, numericValue);
        };
        input.addEventListener("input", update);
        control.append(value, input);
        input.updateOption = update;
      }

      renderOptionInputs.set(option.property, { input, option });
      input.updateOption();
      row.append(copy, control);
      section.append(row);
    }

    renderOptionsContent.append(section);
  }
}

function setRenderOptionsOpen(open) {
  renderOptionsPanel.hidden = !open;
  renderOptionsToggle.setAttribute("aria-expanded", String(open));
  if (open) renderOptionsClose.focus();
}

function syncBackgroundInteractivity() {
  const sourcePanelOpen = !emptyState.hidden;
  const loading = !loadingPanel.hidden;
  toolbarActions.inert = sourcePanelOpen || loading;
  statusBar.inert = sourcePanelOpen || loading;
  emptyState.inert = loading;
  renderOptionsPanel.inert = loading;
}

function setSourcePanelOpen(open, { moveFocus = false } = {}) {
  const shouldOpen = open || !activeSplat;
  const restoreFocus =
    !shouldOpen && emptyState.contains(document.activeElement);

  if (shouldOpen && !renderOptionsPanel.hidden) {
    setRenderOptionsOpen(false);
  }

  emptyState.hidden = !shouldOpen;
  sourcePanelBackdrop.hidden = !shouldOpen;
  interfaceRoot.classList.toggle("is-source-panel-open", shouldOpen);
  syncBackgroundInteractivity();
  sourcePanelToggle.setAttribute("aria-expanded", String(shouldOpen));
  sourcePanelClose.hidden = !activeSplat;

  if (moveFocus && shouldOpen) {
    chooseFileButton.focus();
  } else if (restoreFocus) {
    sourcePanelToggle.focus();
  }
}

function resetRenderOptions() {
  for (const { input, option } of renderOptionInputs.values()) {
    if (typeof option.defaultValue === "boolean") {
      input.checked = option.defaultValue;
    } else {
      input.value = String(option.defaultValue);
    }
    input.updateOption();
  }
}

function updateFocalDistanceRange(distance, radius) {
  const entry = renderOptionInputs.get("focalDistance");
  if (!entry) return;
  const max = Math.max(distance + radius * 2, 1);
  entry.input.max = String(max);
  entry.input.step = String(max / 500);
  entry.input.updateOption();
}

createRenderOptions();

const frameSize = new THREE.Vector3();
let activeSplat = null;
let activeLoad = 0;
let activeLoadController = null;
let dragDepth = 0;
let toastTimer;
const remoteRequestByButton = new WeakMap();

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

function modelFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const encodedName = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep the encoded path segment when it contains malformed escape sequences.
  }

  if (!fileTypeFor({ name })) return undefined;
  return { name, size: 0, url };
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

function clearProgressShimmer() {
  for (const animation of loadingProgress.getAnimations()) {
    animation.cancel();
  }
  loadingProgress.dataset.shimmer = "";
  loadingProgress.style.background = "";
  loadingProgress.style.backgroundSize = "";
  loadingProgress.style.backgroundPosition = "";
}

function startProgressShimmer() {
  if (loadingProgress.dataset.shimmer === "true") return;
  loadingProgress.dataset.shimmer = "true";
  loadingProgress.style.background =
    "linear-gradient(90deg, rgb(255 255 255 / 7%) 0%, rgb(120 150 255 / 18%) 35%, rgb(207 255 88 / 24%) 50%, rgb(120 150 255 / 18%) 65%, rgb(255 255 255 / 7%) 100%)";
  loadingProgress.style.backgroundSize = "220% 100%";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  loadingProgress.animate(
    [{ backgroundPosition: "120% 0" }, { backgroundPosition: "-120% 0" }],
    {
      duration: 1200,
      easing: "ease-in-out",
      iterations: Number.POSITIVE_INFINITY,
    },
  );
}

function setLoading(file, loaded = 0, total = file.size) {
  const wasHidden = loadingPanel.hidden;
  loadingBackdrop.hidden = false;
  loadingPanel.hidden = false;
  syncBackgroundInteractivity();
  loadingName.textContent = file.name;
  loadingProgress.classList.remove("is-indeterminate");

  if (wasHidden) loadingCancelButton.focus();

  if (total > 0 && loaded >= 0) {
    clearProgressShimmer();
    const ratio = Math.min(loaded / total, 1);
    const percent = Math.round(ratio * 100);
    loadingProgressFill.style.transform = `scaleX(${ratio})`;
    loadingProgress.setAttribute("aria-valuemin", "0");
    loadingProgress.setAttribute("aria-valuemax", "100");
    loadingProgress.setAttribute("aria-valuenow", String(percent));
    loadingDetail.textContent =
      ratio >= 1
        ? "File received · Finalizing…"
        : `${percent}% · ${formatBytes(loaded)} of ${formatBytes(total)}`;
  } else {
    loadingProgressFill.style.transform = "scaleX(0)";
    loadingProgress.removeAttribute("aria-valuenow");
    startProgressShimmer();
    loadingDetail.textContent =
      loaded > 0
        ? `Downloading… · ${formatBytes(loaded)} received`
        : "Starting download…";
  }
}

function clearLoading() {
  clearProgressShimmer();
  loadingBackdrop.hidden = true;
  loadingPanel.hidden = true;
  loadingProgressFill.style.transform = "scaleX(0)";
  syncBackgroundInteractivity();
}

function cancelLoading() {
  if (loadingPanel.hidden) return;

  const sourcePanelOpen = !emptyState.hidden;
  activeLoad += 1;
  const controller = activeLoadController;
  activeLoadController = null;
  controller?.abort();
  clearLoading();
  setStatus("Loading canceled");

  if (sourcePanelOpen) {
    chooseFileButton.focus();
  } else {
    sourcePanelToggle.focus();
  }
}

function frameSplat(splat) {
  const bounds = splat.getBoundingBox(true);
  const radius = bounds.isEmpty()
    ? 0.01
    : Math.max(bounds.getSize(frameSize).length() * 0.5, 0.01);
  const defaultCameraDistance = 10;
  const distance = Math.min(defaultCameraDistance, radius);
  updateFocalDistanceRange(distance, radius);

  camera.near = Math.max(radius / 1000, 0.0001);
  camera.far = Math.max(distance + radius * 20, 100);
  camera.updateProjectionMatrix();
  camera.position.set(0, 5, 5 * Math.sqrt(3)).setLength(distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  controls.minDistance = radius * 0.02;
  controls.setCamera(camera);
}

async function loadFile(
  file,
  { credit = "", remoteController = null, loadToken = null } = {},
) {
  const fileType = fileTypeFor(file);
  if (!fileType) {
    showToast("Unsupported file. Choose a .ply or .spz file.");
    setStatus("Only PLY and SPZ files are supported", "error");
    return;
  }

  const controller = remoteController ?? new AbortController();
  if (activeLoadController && activeLoadController !== controller) {
    activeLoadController.abort();
  }
  activeLoadController = controller;

  const loadId = loadToken ?? ++activeLoad;
  setLoading(file);
  setStatus(`Loading ${file.name}`, "loading");

  const stream = file
    .stream()
    .pipeThrough(new TransformStream(), { signal: controller.signal });
  const candidate = new SplatMesh({
    fileName: file.name,
    fileType,
    stream,
    streamLength: file.size || undefined,
    onProgress: (event) => {
      if (loadId !== activeLoad) return;
      setLoading(file, event.loaded, event.total || file.size);
    },
  });

  // Match the viewer convention: file-space +Y down / +Z forward
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

    setSourcePanelOpen(false);
    resetViewButton.hidden = false;
    fileMeta.hidden = false;
    fileName.textContent = file.name;
    const sizeLabel = file.size > 0 ? ` · ${formatBytes(file.size)}` : "";
    fileStats.textContent = `${formatNumber.format(activeSplat.numSplats)} splats${sizeLabel}`;
    modelCredit.textContent = credit;
    modelCreditPrefix.hidden = !credit;
    modelCredit.hidden = !credit;
    modelCreditSeparator.hidden = !credit;
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
  } finally {
    if (activeLoadController === controller) {
      activeLoadController = null;
    }
  }
}

async function loadRemoteModel(model, button) {
  activeLoadController?.abort();
  const controller = new AbortController();
  activeLoadController = controller;
  remoteRequestByButton.set(button, controller);

  const requestId = ++activeLoad;
  const pendingFile = { name: model.name, size: model.size };
  button.disabled = true;
  setLoading(pendingFile, -1, 0);
  setStatus(`Loading ${model.name}`, "loading");

  try {
    const response = await fetch(model.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    if (!response.body) {
      throw new Error("The response did not include a readable stream");
    }
    if (requestId !== activeLoad) return;

    const contentLength = Number(response.headers.get("content-length"));
    const file = {
      name: model.name,
      size: contentLength > 0 ? contentLength : model.size,
      stream: () => response.body,
    };
    await loadFile(file, {
      credit: model.credit,
      remoteController: controller,
      loadToken: requestId,
    });
  } catch (error) {
    if (requestId !== activeLoad || controller.signal.aborted) return;
    clearLoading();
    setStatus(`Could not load ${model.name}`, "error");
    const detail =
      error instanceof TypeError
        ? "Request failed. Check the URL and the server's CORS headers."
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Failed to load ${model.name}`, error);
    showToast(`Could not load ${model.name}: ${detail}`);
  } finally {
    if (activeLoadController === controller) {
      activeLoadController = null;
    }
    if (remoteRequestByButton.get(button) === controller) {
      remoteRequestByButton.delete(button);
      button.disabled = false;
    }
  }
}

function loadExample() {
  loadRemoteModel(EXAMPLE_MODEL, loadExampleButton);
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
  requestRender();
}

for (const button of document.querySelectorAll("[data-file-picker]")) {
  button.addEventListener("click", openFilePicker);
}

sourcePanelToggle.addEventListener("click", () => {
  setSourcePanelOpen(true, { moveFocus: true });
});

sourcePanelClose.addEventListener("click", () => {
  setSourcePanelOpen(false);
  sourcePanelToggle.focus();
});

sourcePanelBackdrop.addEventListener("click", () => {
  if (!activeSplat) return;
  setSourcePanelOpen(false);
  sourcePanelToggle.focus();
});

loadingCancelButton.addEventListener("click", cancelLoading);

loadExampleButton.addEventListener("click", loadExample);

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const model = modelFromUrl(modelUrlInput.value.trim());
  if (!model) {
    showToast("Enter a valid HTTP(S) URL ending in .ply or .spz.");
    setStatus("Enter a valid PLY or SPZ URL", "error");
    modelUrlInput.focus();
    return;
  }

  modelUrlInput.blur();
  loadRemoteModel(model, loadUrlButton);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});

resetViewButton.addEventListener("click", () => {
  if (activeSplat) frameSplat(activeSplat);
});

renderOptionsToggle.addEventListener("click", () => {
  setRenderOptionsOpen(renderOptionsPanel.hidden);
});

renderOptionsClose.addEventListener("click", () => {
  setRenderOptionsOpen(false);
  renderOptionsToggle.focus();
});

renderOptionsReset.addEventListener("click", resetRenderOptions);

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (!loadingPanel.hidden) {
    cancelLoading();
  } else if (!renderOptionsPanel.hidden) {
    setRenderOptionsOpen(false);
    renderOptionsToggle.focus();
  } else if (!emptyState.hidden && activeSplat) {
    setSourcePanelOpen(false);
    sourcePanelToggle.focus();
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
  activeLoadController?.abort();
  renderer.setAnimationLoop(null);
  controls.removeEventListener("update", requestRender);
  controls.dispose();
  activeSplat?.dispose();
  splatRenderer.dispose();
  renderer.dispose();
});

setSourcePanelOpen(true);
resizeRenderer();
renderer.setAnimationLoop(renderFrame);
