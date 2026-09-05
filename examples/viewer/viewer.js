import {
  GaussianSplatRenderer,
  SplatFileType,
  SplatMesh,
  StochasticResolvePass,
} from "gaussian-splat-lite";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
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
const performanceHeapStat = performanceHeap.closest(".performance-stat");

const EXAMPLE_MODEL = {
  name: "galaxy-explorer.v3.spz",
  size: 12385826,
  url: new URL("../galaxy-explorer.v3.spz", import.meta.url),
  credit: "renderbricks",
  showExampleCube: true,
};

const scene = new THREE.Scene();
const exampleCube = new THREE.Mesh(
  new THREE.BoxGeometry(2, 1, 0.33),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  }),
);
exampleCube.position.set(0, 0.25, 0);
//exampleCube.rotation.x = -THREE.MathUtils.degToRad(30);

function setExampleCubeVisible(visible) {
  exampleCube.visible = visible;
  if (visible) {
    if (exampleCube.parent !== scene) scene.add(exampleCube);
  } else {
    exampleCube.removeFromParent();
  }
}

setExampleCubeVisible(false);

const camera = new THREE.PerspectiveCamera(52, 1, 0.001, 10000);
camera.position.set(0, 0, 3);

const rendererParameters = {
  alpha: true,
  powerPreference: "high-performance",
};
let outputColorSpace = THREE.SRGBColorSpace;
THREE.ColorManagement.workingColorSpace = THREE.LinearSRGBColorSpace;

function configureRenderer(value) {
  value.setClearColor(0x000000, 0);
  value.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  value.outputColorSpace = outputColorSpace;
}

let renderer = new THREE.WebGLRenderer(rendererParameters);
configureRenderer(renderer);
viewport.append(renderer.domElement);

let controls = new CameraController(renderer, scene, camera, {
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
    performanceHeapStat.dataset.tooltip =
      "JS heap reporting is not available in this browser.";
    return;
  }

  performanceHeap.value = formatHeapSize(memory.usedJSHeapSize);
  performanceHeapStat.dataset.tooltip = Number.isFinite(memory.jsHeapSizeLimit)
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
  const shouldRender = !renderOnDemand || needsRender;
  if (!shouldRender) {
    updateStats(time, false);
    return;
  }

  // void splatRenderer.update({ scene, camera });
  // Synchronous preparation is consumed by this draw; worker completion can
  // still request a later frame through onDirty.
  needsRender = false;
  stochasticResolvePass.compose(renderer, scene, camera);
  updateStats(time, true);
}

controls.addEventListener("update", requestRender);

let splatRenderer = new GaussianSplatRenderer({
  renderer,
  onDirty: requestRender,
  autoStochastic: true,
  // autoUpdate: false,
});
scene.add(splatRenderer);

const stochasticResolvePass = new StochasticResolvePass(splatRenderer);
stochasticResolvePass.enabled = true;

const renderOptionGroups = [
  {
    title: "Performance & diagnostics",
    description: "Frame scheduling and live metrics.",
    options: [
      {
        property: "rendererBackend",
        description: "Switches the scene between WebGL and native WebGPU.",
        defaultValue: false,
        falseLabel: "WebGL",
        trueLabel: "WebGPU",
        apply: (enabled) => {
          void switchRendererBackend(enabled);
        },
      },
      {
        property: "outputColorSpace",
        label: "Output color space",
        description:
          "Chooses whether the canvas presents linear RGB values directly or encodes them for an sRGB display.",
        defaultValue: true,
        falseLabel: "Linear",
        trueLabel: "sRGB",
        apply: (enabled) => {
          outputColorSpace = enabled
            ? THREE.SRGBColorSpace
            : THREE.LinearSRGBColorSpace;
          renderer.outputColorSpace = outputColorSpace;
          if (usesWebGPU(renderer)) {
            THREE.ColorManagement.workingColorSpace = outputColorSpace;
          }
        },
      },
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
    title: "Rendering",
    description: "Stochastic transparency and depth output.",
    options: [
      {
        property: "autoStochastic",
        label: "Automatic stochastic",
        description:
          "Uses sorting-free rendering while the camera moves and until a fresh sort is ready.",
        defaultValue: true,
        falseLabel: "Disabled",
        trueLabel: "Enabled",
      },
      {
        property: "stochastic",
        label: "Force stochastic",
        description:
          "Keeps the sorting-free stochastic path active independently of camera motion.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "renderDepth",
        label: "Force Splat depth",
        description:
          "Keeps the depth-only companion draw enabled when automatic stochastic is off.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
    ],
  },
  {
    title: "Culling & sorting",
    description: "Trade image stability for rendering work.",
    options: [
      {
        property: "synchronousSort",
        label: "Synchronous sorting",
        description:
          "Sorts before drawing and ignores the asynchronous sort interval.",
        defaultValue: false,
        falseLabel: "Async",
        trueLabel: "Sync",
      },
      {
        property: "sortRadial",
        description:
          "Radial is stable while orbiting; Z-depth can match trained scenes more accurately.",
        defaultValue: false,
        falseLabel: "Z-depth",
        trueLabel: "Radial",
      },
      {
        property: "minSortIntervalMs",
        description:
          "Limits asynchronous depth sorting. Higher values save work but may lag while moving.",
        min: 0,
        max: 500,
        step: 10,
        defaultValue: 0,
        format: (value) => `${Math.round(value)} ms`,
      },
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
    ],
  },
  {
    title: "Splat appearance",
    description: "Shape, filtering, and screen-space size.",
    options: [
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
    ],
  },
  {
    title: "Material pipeline",
    description: "How splats blend with the Three.js scene.",
    options: [
      {
        property: "premultipliedAlpha",
        description:
          "Uses RGB already multiplied by alpha for edge-correct blending.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "depthTest",
        description:
          "Lets opaque Three.js geometry occlude splats using the depth buffer.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "depthWrite",
        description:
          "Writes splats to depth. This can create hard artifacts in transparent areas.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "transparent",
        description:
          "Places splats in Three.js’s transparent pass instead of its opaque pass.",
        defaultValue: true,
        falseLabel: "Opaque",
        trueLabel: "Transparent",
      },
    ],
  },
];

const renderOptionInputs = new Map();
let rendererSwitchToken = 0;

function usesWebGPU(value) {
  return value.isWebGPURenderer === true;
}

function syncRendererOption(enabled, disabled = false) {
  const entry = renderOptionInputs.get("rendererBackend");
  if (!entry) return;
  const { input } = entry;
  input.checked = enabled;
  input.disabled = disabled;
  input.syncOption();
}

async function switchRendererBackend(webGPU) {
  const switchToken = ++rendererSwitchToken;
  if (webGPU === usesWebGPU(renderer)) {
    syncRendererOption(webGPU);
    return;
  }

  syncRendererOption(webGPU, true);
  let nextRenderer;
  let nextControls;
  let nextSplatRenderer;
  try {
    if (webGPU) {
      nextRenderer = new WebGPURenderer(rendererParameters);
      await nextRenderer.init();
      if (nextRenderer.backend?.isWebGPUBackend !== true) {
        throw new Error("WebGPU is not available in this browser");
      }
      configureRenderer(nextRenderer);
    } else {
      // WebGL requires a linear working space when it configures texture
      // unpacking. Preserve the active WebGPU setting until the final handoff.
      const activeWorkingColorSpace = THREE.ColorManagement.workingColorSpace;
      try {
        THREE.ColorManagement.workingColorSpace = THREE.LinearSRGBColorSpace;
        nextRenderer = new THREE.WebGLRenderer(rendererParameters);
        configureRenderer(nextRenderer);
      } finally {
        THREE.ColorManagement.workingColorSpace = activeWorkingColorSpace;
      }
    }

    nextSplatRenderer = new GaussianSplatRenderer({
      renderer: nextRenderer,
      onDirty: requestRender,
      // autoUpdate: false,
    });
    for (const group of renderOptionGroups) {
      for (const option of group.options) {
        if (!option.apply) {
          nextSplatRenderer[option.property] = splatRenderer[option.property];
        }
      }
    }
    nextRenderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
    await nextSplatRenderer.update({ scene, camera });

    nextControls = new CameraController(nextRenderer, scene, camera, {
      worldUp: camera.up,
    });
    nextControls.minDistance = controls.minDistance;
  } catch (error) {
    nextControls?.dispose();
    nextSplatRenderer?.dispose();
    nextRenderer?.dispose();
    if (switchToken !== rendererSwitchToken) return;
    syncRendererOption(usesWebGPU(renderer));
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Could not switch renderer", error);
    showToast(`Could not switch renderer: ${detail}`);
    return;
  }

  if (switchToken !== rendererSwitchToken) {
    nextControls.dispose();
    nextSplatRenderer.dispose();
    nextRenderer.dispose();
    return;
  }

  const previousRenderer = renderer;
  const previousControls = controls;
  const previousSplatRenderer = splatRenderer;

  previousRenderer.setAnimationLoop(null);
  previousControls.removeEventListener("update", requestRender);
  previousControls.dispose();
  scene.remove(previousSplatRenderer);

  renderer = nextRenderer;
  THREE.ColorManagement.workingColorSpace = webGPU
    ? outputColorSpace
    : THREE.LinearSRGBColorSpace;
  configureRenderer(renderer);
  controls = nextControls;
  controls.addEventListener("update", requestRender);
  splatRenderer = nextSplatRenderer;
  scene.add(splatRenderer);
  stochasticResolvePass.addSplatRenderer(splatRenderer);
  stochasticResolvePass.removeSplatRenderer(previousSplatRenderer);

  resizeRenderer();
  previousRenderer.domElement.replaceWith(renderer.domElement);

  previousSplatRenderer.dispose();
  previousRenderer.dispose();
  syncRendererOption(webGPU);
  renderer.setAnimationLoop(renderFrame);
  requestRender();
}

function setRenderOptionRowHidden(property, hidden) {
  const entry = renderOptionInputs.get(property);
  if (entry) entry.row.hidden = hidden;
}

function clearBooleanRenderOption(property) {
  const entry = renderOptionInputs.get(property);
  if (!entry?.input.checked) return;
  entry.input.checked = false;
  entry.input.updateOption();
}

function syncRenderOptionDependencies(changedProperty) {
  const autoStochastic =
    renderOptionInputs.get("autoStochastic")?.input.checked === true;

  if (changedProperty === "autoStochastic" && autoStochastic) {
    clearBooleanRenderOption("stochastic");
    clearBooleanRenderOption("renderDepth");
  }

  setRenderOptionRowHidden("stochastic", autoStochastic);
  setRenderOptionRowHidden("renderDepth", autoStochastic);

  const synchronousSort =
    renderOptionInputs.get("synchronousSort")?.input.checked === true;
  setRenderOptionRowHidden("minSortIntervalMs", synchronousSort);
}

function applyRenderOption(option, value) {
  if (option.apply) {
    option.apply(value);
  } else {
    splatRenderer[option.property] = value;
    splatRenderer.setDirty();
  }
  syncRenderOptionDependencies(option.property);
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
      label.textContent = option.label ?? option.property;
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
        const sync = () => {
          value.value = input.checked ? option.trueLabel : option.falseLabel;
          value.textContent = value.value;
        };
        const update = () => {
          sync();
          applyRenderOption(option, input.checked);
        };
        input.addEventListener("change", update);
        control.append(value, input, toggle);
        input.syncOption = sync;
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

      renderOptionInputs.set(option.property, { input, option, row });
      input.updateOption();
      row.append(copy, control);
      section.append(row);
    }

    renderOptionsContent.append(section);
  }

  syncRenderOptionDependencies();
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
  const entries = Array.from(renderOptionInputs.values());
  for (const { input, option } of entries) {
    if (typeof option.defaultValue === "boolean") {
      input.checked = option.defaultValue;
    } else {
      input.value = String(option.defaultValue);
    }
  }

  // Apply material properties before the asynchronous backend switch copies
  // them to its replacement renderer.
  for (const { input, option } of entries) {
    if (option.property === "rendererBackend") continue;
    input.updateOption();
  }
  renderOptionInputs.get("rendererBackend")?.input.updateOption();
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

  camera.near = Math.max(radius / 1000, 0.0001);
  camera.far = Math.max(distance + radius * 20, 100);
  camera.updateProjectionMatrix();
  camera.position.set(0, 5, 5 * Math.sqrt(3)).setLength(distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  controls.minDistance = 0;
  controls.setCamera(camera);
}

async function loadFile(
  file,
  {
    credit = "",
    remoteController = null,
    loadToken = null,
    showExampleCube = false,
  } = {},
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
    setExampleCubeVisible(showExampleCube);
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
      showExampleCube: model.showExampleCube,
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
  stochasticResolvePass.dispose();
  splatRenderer.dispose();
  renderer.dispose();
});

setSourcePanelOpen(true);
resizeRenderer();
renderer.setAnimationLoop(renderFrame);
