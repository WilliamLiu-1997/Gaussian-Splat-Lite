import {
  GaussianSplatRenderer,
  RadStreamScheduler,
  SogStreamScheduler,
  SplatFileType,
  SplatMesh,
  StochasticResolvePass,
} from "gaussian-splat-lite";
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { Line2 as WebGPULine2 } from "three/addons/lines/webgpu/Line2.js";
import { LineSegments2 as WebGPULineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { Fn, materialColor, materialOpacity, uv, vec2, vec4 } from "three/tsl";
import { Line2NodeMaterial, WebGPURenderer } from "three/webgpu";
import { CameraController } from "./cameraController.js";
import { createFrameGate } from "./frameGate.js";
import { getModelRotationX } from "./modelOrientation.js";

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
const referenceToggle = document.querySelector("#reference-toggle");
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
const performanceStats = document.querySelector("#performance-stats");
const performanceFps = document.querySelector("#performance-fps");
const performanceHeap = document.querySelector("#performance-heap");
const performanceHeapStat = performanceHeap.closest(".performance-stat");

const EXAMPLE_MODEL = {
  name: "multi-material-splats.v4.spz",
  size: 5914266,
  url: new URL("../multi-material-splats.v4.spz", import.meta.url),
  credit: "hybridherbst",
};

const scene = new THREE.Scene();
const controlsOverlayScene = new THREE.Scene();

// XZ reference at Y = 0; scaled to the loaded model in frameSplat.
const referenceBaseSize = 10;
function createReferenceMaterial(webGPU, color, linewidth, opacity) {
  const Material = webGPU ? Line2NodeMaterial : LineMaterial;
  const material = new Material({
    color,
    linewidth,
    worldUnits: false,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
    alphaToCoverage: false,
  });
  if (webGPU) {
    // Blend directly instead of sampling Line2NodeMaterial's viewport copy,
    // which is recreated on resize and differs between canvas/resolve targets.
    material.blending = THREE.NormalBlending;
    material.fragmentNode = Fn(() => {
      const lineUv = uv();
      const cap = vec2(lineUv.x, lineUv.y.abs().sub(1));
      // Keep the round endcaps of these solid, screen-space lines.
      lineUv.y.abs().greaterThan(1).and(cap.dot(cap).greaterThan(1)).discard();
      return vec4(materialColor.rgb, materialOpacity);
    })();
  }
  material.userData.referenceColor = color;
  return material;
}

function createGrid(webGPU) {
  const halfSize = referenceBaseSize / 2;
  const positions = [];
  // Ten ticks on each side; leave the center lines to the colored axes.
  for (let i = -10; i <= 10; i++) {
    if (i === 0) continue;
    const offset = (i * referenceBaseSize) / 20;
    positions.push(-halfSize, 0, offset, halfSize, 0, offset);
    positions.push(offset, 0, -halfSize, offset, 0, halfSize);
  }
  const geometry = new LineSegmentsGeometry().setPositions(positions);
  const Line = webGPU ? WebGPULineSegments2 : LineSegments2;
  const line = new Line(
    geometry,
    createReferenceMaterial(webGPU, 0x666666, 1, 0.5),
  );
  line.raycast = () => {};
  return line;
}

function createAxes(webGPU) {
  const group = new THREE.Group();
  const halfSize = referenceBaseSize / 2;
  const Line = webGPU ? WebGPULine2 : Line2;
  for (const [color, positions] of [
    [0xff0000, [-halfSize, 0, 0, halfSize, 0, 0]],
    [0x0000ff, [0, 0, -halfSize, 0, 0, halfSize]],
  ]) {
    const geometry = new LineGeometry().setPositions(positions);
    const material = createReferenceMaterial(webGPU, color, 1.5, 0.8);
    const line = new Line(geometry, material);
    line.raycast = () => {};
    group.add(line);
  }
  return group;
}

const gridHelper = new THREE.Group();
const webGLGrid = createGrid(false);
const webGPUGrid = createGrid(true);
webGPUGrid.visible = false;
gridHelper.add(webGLGrid, webGPUGrid);
const axesHelper = new THREE.Group();
const webGLAxes = createAxes(false);
const webGPUAxes = createAxes(true);
webGPUAxes.visible = false;
axesHelper.add(webGLAxes, webGPUAxes);
scene.add(gridHelper, axesHelper);

function syncReferenceColors() {
  // setHex converts the original sRGB color into the current working space.
  // Reapply it when switching spaces instead of reinterpreting old RGB values.
  for (const helper of [gridHelper, axesHelper]) {
    helper.traverse((object) => {
      const material = object.material;
      if (!material) return;
      material.color.setHex(
        material.userData.referenceColor,
        THREE.SRGBColorSpace,
      );
      material.needsUpdate = true;
    });
  }
}

const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 10000);
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
let frameGate = createFrameGate(renderer);
configureRenderer(renderer);
viewport.append(renderer.domElement);

let controls = new CameraController(renderer, scene, camera, {
  worldUp: camera.up,
});
controlsOverlayScene.add(controls.indicator);

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
  if (activeStream) {
    const stats = activeStream.stats;
    fileStats.textContent = `${formatNumber.format(stats.visibleSplats)} visible splats · ${formatNumber.format(stats.visibleMeshes)} meshes · ${formatBytes(stats.residentBytes)} cached · ${stats.loadingChunks} loading`;
  }
  statsSampleStart = time;
  statsRenderedFrames = 0;
}

updateHeapStat();

function requestRender() {
  needsRender = true;
}

function renderFrame(time) {
  controls.update(time);
  // Keep input current while the GPU is busy, retaining any redraw request.
  if (!frameGate.isReady()) {
    updateStats(time, false);
    return;
  }
  activeStream?.update(camera, {
    width: renderer.domElement.width,
    height: renderer.domElement.height,
  });
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

controls.addEventListener("update", requestRender);

let splatRenderer = new GaussianSplatRenderer({
  renderer,
  onDirty: requestRender,
  autoStochastic: true,
});
scene.add(splatRenderer);

const stochasticResolvePass = new StochasticResolvePass(splatRenderer);
stochasticResolvePass.enabled = true;

const renderOptionGroups = [
  {
    title: "Model orientation",
    description: "Align the model's vertical axis with the viewer.",
    options: [
      {
        property: "modelUpAxis",
        label: "Source up axis",
        description:
          "Default assumes Z up for streams and Y down for ordinary files. Choose the source axis if the model appears sideways or upside down.",
        defaultValue: "auto",
        choices: [
          ["auto", "Default"],
          ["y-up", "Y up"],
          ["y-down", "Y down"],
          ["z-up", "Z up"],
          ["z-down", "Z down"],
        ],
        apply: () => {
          if (!activeSplat) return;
          applyModelOrientation(
            activeSplat,
            activeStream instanceof SogStreamScheduler,
          );
          frameSplat(activeSplat);
        },
      },
    ],
  },
  {
    title: "Performance & diagnostics",
    description: "Frame scheduling and live metrics.",
    options: [
      {
        property: "rendererBackend",
        description:
          "Chooses the renderer; WebGPU falls back to WebGL2 when unavailable.",
        defaultValue: "webgpu",
        choices: [
          ["webgpu", "WebGPU"],
          ["webgl-fallback", "WebGPU · WebGL2"],
          ["webgl", "WebGL2"],
        ],
        apply: (backend) => {
          void switchRendererBackend(backend);
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
          if (usesNodeRenderer(renderer)) {
            THREE.ColorManagement.workingColorSpace = outputColorSpace;
          }
          syncReferenceColors();
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

function usesNodeRenderer(value) {
  return value.isWebGPURenderer === true;
}

function getRendererBackend() {
  if (!usesNodeRenderer(renderer)) return "webgl";
  return renderer.backend.isWebGPUBackend ? "webgpu" : "webgl-fallback";
}

function syncRendererOption(backend, disabled = false) {
  const entry = renderOptionInputs.get("rendererBackend");
  if (!entry) return;
  const { input } = entry;
  input.value = backend;
  input.disabled = disabled;
}

async function switchRendererBackend(backend) {
  const webGPU = backend !== "webgl";
  const switchToken = ++rendererSwitchToken;
  if (backend === getRendererBackend()) {
    syncRendererOption(backend);
    return;
  }

  syncRendererOption(backend, true);
  let nextRenderer;
  let nextControls;
  let nextSplatRenderer;
  let nextInspector;
  let webGPUFailureMessage;
  try {
    if (webGPU) {
      const { ViewerInspector } = await import("./viewerInspector.js");
      nextRenderer = new WebGPURenderer({
        ...rendererParameters,
        forceWebGL: backend === "webgl-fallback",
      });
      if (backend === "webgpu") {
        const getFallback = nextRenderer._getFallback;
        nextRenderer._getFallback = (error) => {
          // Three's fallback otherwise discards the native initialization error.
          webGPUFailureMessage = `Native WebGPU initialization failed: ${String(error)}`;
          console.error("Native WebGPU initialization failed", error);
          if (switchToken === rendererSwitchToken) {
            showToast(webGPUFailureMessage);
          }
          return getFallback.call(nextRenderer, error);
        };
      }
      await nextRenderer.init();
      configureRenderer(nextRenderer);
      nextInspector = new ViewerInspector();
      if (backend === "webgpu" && !nextRenderer.backend.isWebGPUBackend) {
        // Inspector's saved Force WebGL setting can bypass native init entirely.
        webGPUFailureMessage ??=
          "Native WebGPU was not initialized. Disable Force WebGL in Inspector Settings to use WebGPU.";
        nextInspector.console.addMessage("error", webGPUFailureMessage);
      }
      // Leave the built-in Parameters tab hidden: only FPS and Inspector.
      nextInspector.parameters.hide();
      nextInspector.domElement.classList.add("viewer-inspector");
      nextInspector.profiler.toggleButton.setAttribute(
        "aria-label",
        "Toggle Three.js Inspector",
      );
      nextInspector.profiler.toggleButton.title = "Three.js Inspector";
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
    controlsOverlayScene.add(nextControls.indicator);
    nextControls.minDistance = controls.minDistance;
  } catch (error) {
    nextInspector?.dispose();
    nextControls?.dispose();
    nextSplatRenderer?.dispose();
    nextRenderer?.dispose();
    if (switchToken !== rendererSwitchToken) return;
    syncRendererOption(getRendererBackend());
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Could not switch renderer", error);
    const message = `Could not switch renderer: ${detail}`;
    showToast(
      webGPUFailureMessage ? `${webGPUFailureMessage}\n${message}` : message,
    );
    return;
  }

  if (switchToken !== rendererSwitchToken) {
    nextInspector?.dispose();
    nextControls.dispose();
    nextSplatRenderer.dispose();
    nextRenderer.dispose();
    return;
  }

  const previousRenderer = renderer;
  const previousControls = controls;
  const previousSplatRenderer = splatRenderer;

  previousRenderer.setAnimationLoop(null);
  frameGate.dispose();
  previousControls.removeEventListener("update", requestRender);
  previousControls.dispose();
  scene.remove(previousSplatRenderer);

  renderer = nextRenderer;
  webGLGrid.visible = !webGPU;
  webGPUGrid.visible = webGPU;
  webGLAxes.visible = !webGPU;
  webGPUAxes.visible = webGPU;
  frameGate = createFrameGate(renderer);
  THREE.ColorManagement.workingColorSpace = webGPU
    ? outputColorSpace
    : THREE.LinearSRGBColorSpace;
  syncReferenceColors();
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
  performanceStats.hidden = webGPU;
  if (webGPU) {
    // Mount first so Inspector's auto-attach cannot move it into the viewport.
    performanceStats.before(nextInspector.domElement);
    renderer.inspector = nextInspector;
  }
  syncRendererOption(getRendererBackend());
  if (webGPUFailureMessage) {
    showToast(`${webGPUFailureMessage} Using WebGL2.`);
  }
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

function createElement(tag, className) {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function createRenderOptionRow(option) {
  const isToggle = typeof option.defaultValue === "boolean";
  const row = createElement("div", "option-row");
  const copy = createElement("div", "option-copy");
  const label = document.createElement("label");
  label.htmlFor = `render-option-${option.property}`;
  label.textContent = option.label ?? option.property;
  const description = document.createElement("p");
  description.textContent = option.description;
  copy.append(label, description);

  const control = createElement("div", "option-control");
  if (option.choices) {
    const input = createElement("select", "select-input");
    input.id = label.htmlFor;
    input.dataset.renderOption = option.property;
    for (const [value, text] of option.choices) {
      const choice = document.createElement("option");
      choice.value = value;
      choice.textContent = text;
      input.append(choice);
    }
    input.value = option.defaultValue;
    input.updateOption = () => applyRenderOption(option, input.value);
    input.addEventListener("change", input.updateOption);
    control.append(input);
    row.append(copy, control);
    renderOptionInputs.set(option.property, { input, option, row });
    input.updateOption();
    return row;
  }
  const input = createElement(
    "input",
    isToggle ? "toggle-input" : "range-input",
  );
  input.id = label.htmlFor;
  input.dataset.renderOption = option.property;
  const output = createElement(
    "output",
    isToggle ? "toggle-value" : "range-value",
  );
  output.setAttribute("for", input.id);

  const getValue = () => (isToggle ? input.checked : Number(input.value));
  const sync = (value = getValue()) => {
    output.value = isToggle
      ? value
        ? option.trueLabel
        : option.falseLabel
      : option.format(value);
    output.textContent = output.value;
  };
  const update = () => {
    const value = getValue();
    sync(value);
    applyRenderOption(option, value);
  };

  if (isToggle) {
    row.classList.add("option-row-toggle");
    input.type = "checkbox";
    input.checked = option.defaultValue;
    const toggle = createElement("label", "toggle-track");
    toggle.htmlFor = input.id;
    toggle.setAttribute("aria-hidden", "true");
    control.append(output, input, toggle);
    input.syncOption = sync;
  } else {
    input.type = "range";
    input.min = String(option.min);
    input.max = String(option.max);
    input.step = String(option.step);
    input.value = String(option.defaultValue);
    control.append(output, input);
  }

  input.addEventListener(isToggle ? "change" : "input", update);
  input.updateOption = update;
  renderOptionInputs.set(option.property, { input, option, row });
  input.updateOption();
  row.append(copy, control);
  return row;
}

function createRenderOptions() {
  for (const group of renderOptionGroups) {
    const section = createElement("section", "option-group");
    const heading = createElement("div", "option-group-heading");
    heading.innerHTML = `<h3>${group.title}</h3><p>${group.description}</p>`;
    section.append(heading);

    for (const option of group.options) {
      section.append(createRenderOptionRow(option));
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

function closeRenderOptions() {
  setRenderOptionsOpen(false);
  renderOptionsToggle.focus();
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

function closeSourcePanel() {
  setSourcePanelOpen(false);
  sourcePanelToggle.focus();
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

const frameSize = new THREE.Vector3();
const frameCenter = new THREE.Vector3();
let activeSplat = null;
let activeStream = null;
let cancelActiveLoad = null;
let activeLoad = 0;
let dragDepth = 0;
let toastTimer;
const remoteRequestByButton = new WeakMap();

const formatNumber = new Intl.NumberFormat();

createRenderOptions();

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
  if (name.endsWith(".sog") || name === "meta.json") return SplatFileType.SOG;
  if (name.endsWith(".rad")) return SplatFileType.RAD;
  return undefined;
}

async function detectFileType(file, url) {
  const fileType = fileTypeFor(file);
  if (fileType || url || !(file instanceof Blob)) return fileType;
  const prefix = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return String.fromCharCode(...prefix) === "RAD0"
    ? SplatFileType.RAD
    : undefined;
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

  return { name: name || "model", size: 0, url };
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

function clearActiveModel() {
  if (activeSplat) scene.remove(activeSplat);
  if (activeStream) activeStream.dispose();
  else activeSplat?.dispose();
  activeSplat = null;
  activeStream = null;
  resetViewButton.hidden = true;
  fileMeta.hidden = true;
  setSourcePanelOpen(true);
  requestRender();
}

function cancelLoading() {
  if (loadingPanel.hidden) return;

  const sourcePanelOpen = !emptyState.hidden;
  activeLoad += 1;
  cancelActiveLoad?.();
  cancelActiveLoad = null;
  clearLoading();
  setStatus("Loading canceled");

  if (sourcePanelOpen) {
    chooseFileButton.focus();
  } else {
    sourcePanelToggle.focus();
  }
}

function applyModelOrientation(splat, streamed) {
  const orientation = renderOptionInputs.get("modelUpAxis").input.value;
  // Transform the stream group so rendering and LOD culling share the same
  // rotation; the decoded splats and index bounds remain in source space.
  splat.rotation.set(getModelRotationX(orientation, streamed), 0, 0);
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
  gridHelper.scale.setScalar(referenceSize / referenceBaseSize);
  axesHelper.scale.setScalar(referenceSize / referenceBaseSize);
  gridHelper.position.copy(frameCenter);
  axesHelper.position.copy(frameCenter);
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
  camera.far = radius * 10;
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

async function initializeModel(model, file, { url, resolveFile }, loadId) {
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
        if (loadId !== activeLoad || loadingPanel.hidden) return;
        const detail = error instanceof Error ? error.message : String(error);
        loadingDetail.textContent = `${chunkUrl}: ${detail}`;
        setStatus("Waiting for a RAD page · retry pending", "error");
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
        setLoading(file, event.loaded, event.total || file.size);
      },
    });
  }
  await (model.stream ?? model.splat).initialized;
}

function showLoadedModel(file, credit) {
  setSourcePanelOpen(false);
  resetViewButton.hidden = false;
  fileMeta.hidden = false;
  fileName.textContent = file.name;
  const sizeLabel = file.size > 0 ? ` · ${formatBytes(file.size)}` : "";
  fileStats.textContent = activeStream
    ? "Loading visible regions…"
    : `${formatNumber.format(activeSplat.numSplats)} splats${sizeLabel}`;
  modelCredit.textContent = credit;
  modelCreditPrefix.hidden = !credit;
  modelCredit.hidden = !credit;
  modelCreditSeparator.hidden = !credit;
  setStatus(
    activeStream ? "Streaming visible regions" : "Loaded and ready",
    "success",
  );
}

async function loadFile(file, { credit = "", url, button, resolveFile } = {}) {
  const loadId = ++activeLoad;
  cancelActiveLoad?.();
  clearActiveModel();

  // Keep ownership available to cancellation while initialization is pending.
  const model = { splat: null, stream: null };
  const disposeModel = () => {
    if (model.splat && activeSplat === model.splat) clearActiveModel();
    else if (model.stream) model.stream.dispose();
    else model.splat?.dispose();
  };
  cancelActiveLoad = disposeModel;
  if (button) {
    remoteRequestByButton.set(button, loadId);
    button.disabled = true;
  }
  setLoading(file);
  setStatus(`Loading ${file.name}`, "loading");

  try {
    await initializeModel(model, file, { url, resolveFile }, loadId);

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
    showLoadedModel(file, credit);
    clearLoading();
    requestRender();
  } catch (error) {
    disposeModel();
    if (loadId !== activeLoad) return;

    clearLoading();
    setStatus(`Could not load ${file.name}`, "error");
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load ${file.name}`, error);
    showToast(`Could not load ${file.name}: ${detail}`);
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

sourcePanelClose.addEventListener("click", closeSourcePanel);

sourcePanelBackdrop.addEventListener("click", () => {
  if (!activeSplat) return;
  closeSourcePanel();
});

loadingCancelButton.addEventListener("click", cancelLoading);

loadExampleButton.addEventListener("click", () => {
  loadRemoteModel(EXAMPLE_MODEL, loadExampleButton);
});

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const model = modelFromUrl(modelUrlInput.value.trim());
  if (!model) {
    showToast(
      "Enter an HTTP(S) model URL (.ply, .spz, .sog, .rad, or a scene index).",
    );
    setStatus("Enter a valid model URL", "error");
    modelUrlInput.focus();
    return;
  }

  modelUrlInput.blur();
  loadRemoteModel(model, loadUrlButton);
});

function loadLocalFiles(files) {
  const models = files.filter((entry) => fileTypeFor(entry));
  if (models.length > 1) {
    showToast(
      "Choose one model or metadata file together with its companion files.",
    );
    return;
  }
  const file =
    models[0] ?? files.find((entry) => !/\.(radc|webp)$/i.test(entry.name));
  if (!file) {
    showToast(
      "Include meta.json with SOG images, or the .rad header with RAD chunks.",
    );
    return;
  }
  const normalize = (path) => {
    const parts = [];
    for (const part of path.replaceAll("\\", "/").split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  };
  const paths = new Map();
  const names = new Map();
  for (const entry of files) {
    for (const [map, key] of [
      [paths, normalize(entry.webkitRelativePath || entry.name)],
      [names, entry.name],
    ]) {
      const matches = map.get(key) ?? [];
      matches.push(entry);
      map.set(key, matches);
    }
  }
  const rootPath = normalize(file.webkitRelativePath || file.name);
  const directory = rootPath.slice(0, rootPath.lastIndexOf("/") + 1);
  const resolveFile = (filename, signal) => {
    signal.throwIfAborted();
    const relative = normalize(directory + filename);
    const exact = paths.get(relative) ?? paths.get(normalize(filename));
    const matches = exact ?? names.get(normalize(filename).split("/").at(-1));
    if (matches?.length === 1) return matches[0];
    if (matches?.length > 1)
      throw new Error(`Ambiguous companion filename: ${filename}`);
    throw new Error(`Select the companion file: ${filename}`);
  };
  void loadFile(file, { resolveFile });
}

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length) loadLocalFiles(files);
});

resetViewButton.addEventListener("click", () => {
  if (activeSplat) frameSplat(activeSplat);
});

referenceToggle.addEventListener("click", () => {
  const visible = !gridHelper.visible;
  gridHelper.visible = visible;
  axesHelper.visible = visible;
  referenceToggle.setAttribute("aria-pressed", String(visible));
  referenceToggle.title = visible ? "Hide grid and axes" : "Show grid and axes";
  requestRender();
});

renderOptionsToggle.addEventListener("click", () => {
  setRenderOptionsOpen(renderOptionsPanel.hidden);
});

renderOptionsClose.addEventListener("click", closeRenderOptions);

renderOptionsReset.addEventListener("click", resetRenderOptions);

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  if (!loadingPanel.hidden) {
    cancelLoading();
  } else if (!renderOptionsPanel.hidden) {
    closeRenderOptions();
  } else if (!emptyState.hidden && activeSplat) {
    closeSourcePanel();
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
  if (files.length) {
    loadLocalFiles(files);
  } else {
    showToast("Drop a model, or SOG meta.json together with its images.");
    setStatus("PLY, SPZ, SOG, and RAD files are supported", "error");
  }
});

window.addEventListener("blur", clearDragState);

window.addEventListener("resize", resizeRenderer);
window.addEventListener("beforeunload", () => {
  renderer.setAnimationLoop(null);
  frameGate.dispose();
  controls.removeEventListener("update", requestRender);
  controls.dispose();
  cancelActiveLoad?.();
  if (activeStream) activeStream.dispose();
  else activeSplat?.dispose();
  stochasticResolvePass.dispose();
  splatRenderer.dispose();
  renderer.dispose();
});

setSourcePanelOpen(true);
resizeRenderer();
renderer.setAnimationLoop(renderFrame);
