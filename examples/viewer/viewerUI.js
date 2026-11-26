import { formatBytes, showFileMeta } from "../shared/fileMeta.js";
import { createPerformanceStats } from "../shared/performanceStats.js";

// Approximate overall progress; reserve completion for model initialization.
const LOADING_STAGE_RANGES = {
  download: [0, 0.7],
  postDecode: [0.7, 0.8],
  optimize: [0.8, 0.99],
  stream: [0, 1],
};

export function createViewerUI({
  document = globalThis.document,
  onCancelLoad,
  onResetView,
}) {
  const window = document.defaultView;
  const interfaceRoot = document.querySelector(".interface");
  const toolbarActions = document.querySelector(".toolbar-actions");
  const statusBar = document.querySelector(".statusbar");
  const modelControls = document.querySelector("#model-controls");
  const emptyState = document.querySelector("#empty-state");
  const sourcePanelBackdrop = document.querySelector("#source-panel-backdrop");
  const sourcePanelToggle = document.querySelector("#source-panel-toggle");
  const sourcePanelClose = document.querySelector("#source-panel-close");
  const sourceAction = emptyState.querySelector(
    "button:not(.source-panel-close)",
  );
  const resetViewButton = document.querySelector("#reset-view");
  const loadingBackdrop = document.querySelector("#loading-backdrop");
  const loadingPanel = document.querySelector("#loading-panel");
  const loadingCancelButton = document.querySelector("#loading-cancel");
  const loadingName = document.querySelector("#loading-name");
  const loadingProgress = document.querySelector("#loading-progress");
  const loadingProgressFill = document.querySelector("#loading-progress-fill");
  const loadingDetail = document.querySelector("#loading-detail");
  const statusText = document.querySelector("#status-text");
  const fileMeta = document.querySelector("#file-meta");
  const fileStats = document.querySelector("#file-stats");
  const dropOverlay = document.querySelector("#drop-overlay");
  const toast = document.querySelector("#toast");
  const renderOptionsToggle = document.querySelector("#render-options-toggle");
  const renderOptionsPanel = document.querySelector("#render-options");
  const renderOptionsClose = document.querySelector("#render-options-close");
  const performanceStats = document.querySelector("#performance-stats");
  const stats = createPerformanceStats(document);

  let hasModel = false;
  let loadingRatio = 0;
  let toastFrame;
  let toastTimer;
  let toastHideTimer;
  const events = new window.AbortController();
  const formatNumber = new Intl.NumberFormat();

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
    if (sourcePanelOpen || loading) stats.closeTooltip();
    toolbarActions.inert = sourcePanelOpen || loading;
    statusBar.inert = sourcePanelOpen || loading;
    modelControls.hidden = !hasModel;
    modelControls.inert = sourcePanelOpen || loading;
    emptyState.inert = loading;
    renderOptionsPanel.inert = loading;
  }

  function setSourcePanelOpen(open, { moveFocus = false } = {}) {
    const shouldOpen = !sourcePanelToggle?.hidden && (open || !hasModel);
    const restoreFocus =
      !shouldOpen && emptyState.contains(document.activeElement);

    if (shouldOpen && !renderOptionsPanel.hidden) {
      setRenderOptionsOpen(false);
    }

    emptyState.hidden = !shouldOpen;
    sourcePanelBackdrop.hidden = !shouldOpen;
    interfaceRoot.classList.toggle("is-source-panel-open", shouldOpen);
    syncBackgroundInteractivity();
    sourcePanelToggle?.setAttribute("aria-expanded", String(shouldOpen));
    if (sourcePanelClose) sourcePanelClose.hidden = !hasModel;

    if (moveFocus && shouldOpen) {
      sourceAction.focus();
    } else if (restoreFocus) {
      (sourcePanelToggle ?? resetViewButton).focus();
    }
  }

  function closeSourcePanel() {
    setSourcePanelOpen(false);
    (sourcePanelToggle ?? resetViewButton).focus();
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function clearToastTimers() {
    window.cancelAnimationFrame(toastFrame);
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
  }

  function showToast(message) {
    clearToastTimers();
    toast.textContent = message;
    toast.hidden = false;
    toastFrame = window.requestAnimationFrame(() =>
      toast.classList.add("is-visible"),
    );
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
      toastHideTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 180);
    }, 4200);
  }

  function showLoading(
    file,
    loaded = 0,
    total = file.size,
    stage = "download",
  ) {
    const wasHidden = loadingPanel.hidden;
    loadingBackdrop.hidden = false;
    loadingPanel.hidden = false;
    syncBackgroundInteractivity();
    loadingName.textContent = file.name;
    if (wasHidden) loadingCancelButton.focus();
    updateLoadingProgress(loaded, total, stage);
  }

  function updateLoadingProgress(loaded, total, stage) {
    if (stage === "download" && loaded === 0) loadingRatio = 0;
    if (total > 0 && loaded >= 0) {
      const ratio = Math.min(loaded / total, 1);
      const [start, end] = LOADING_STAGE_RANGES[stage];
      loadingRatio =
        stage === "stream"
          ? ratio
          : Math.max(loadingRatio, start + ratio * (end - start));
      const percent = Math.floor(loadingRatio * 100);
      loadingProgress.setAttribute("aria-valuemin", "0");
      loadingProgress.setAttribute("aria-valuemax", "100");
      loadingProgress.setAttribute("aria-valuenow", String(percent));
      if (stage === "download") {
        loadingDetail.textContent =
          ratio >= 1
            ? `File received · ${percent}%`
            : `${percent}% · ${formatBytes(loaded)} of ${formatBytes(total)}`;
      } else {
        const label =
          stage === "stream"
            ? "Loading current view"
            : stage === "postDecode"
              ? "Post-processing"
              : "Optimizing";
        loadingDetail.textContent = `${label} · ${percent}%`;
      }
    } else {
      loadingProgress.removeAttribute("aria-valuenow");
      loadingDetail.textContent =
        loaded > 0
          ? `Downloading… · ${formatBytes(loaded)} received`
          : "Starting download…";
    }
    loadingProgress.classList.toggle(
      "is-indeterminate",
      total <= 0 && loadingRatio === 0,
    );
    loadingProgressFill.style.transform = `scaleX(${loadingRatio})`;
  }

  function clearLoading() {
    loadingRatio = 0;
    loadingProgress.classList.remove("is-indeterminate");
    loadingBackdrop.hidden = true;
    loadingPanel.hidden = true;
    loadingProgressFill.style.transform = "scaleX(0)";
    syncBackgroundInteractivity();
  }

  function showModelInfo(file, { numSplats = 0, streamed = false } = {}) {
    hasModel = true;
    setSourcePanelOpen(false);
    resetViewButton.hidden = false;
    showFileMeta(fileMeta, file, numSplats, { streamed });
    setStatus(streamed ? "Streaming visible regions" : "Loaded and ready");
  }

  function clearModelInfo() {
    hasModel = false;
    resetViewButton.hidden = true;
    fileMeta.hidden = true;
    setSourcePanelOpen(true);
  }

  function requestCancelLoad() {
    if (loadingPanel.hidden) return;
    const sourcePanelOpen = !emptyState.hidden;
    onCancelLoad();
    clearLoading();
    setStatus("Loading canceled");
    if (sourcePanelOpen) sourceAction.focus();
    else (sourcePanelToggle ?? resetViewButton).focus();
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler, { signal: events.signal });
  }

  if (sourcePanelToggle)
    listen(sourcePanelToggle, "click", () =>
      setSourcePanelOpen(true, { moveFocus: true }),
    );
  if (sourcePanelClose) listen(sourcePanelClose, "click", closeSourcePanel);
  listen(sourcePanelBackdrop, "click", () => {
    if (hasModel) closeSourcePanel();
  });
  listen(loadingCancelButton, "click", requestCancelLoad);
  listen(resetViewButton, "click", onResetView);
  listen(renderOptionsToggle, "click", () =>
    setRenderOptionsOpen(renderOptionsPanel.hidden),
  );
  listen(renderOptionsClose, "click", closeRenderOptions);
  listen(window, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!loadingPanel.hidden) requestCancelLoad();
    else if (!renderOptionsPanel.hidden) closeRenderOptions();
    else if (!emptyState.hidden && hasModel) closeSourcePanel();
  });

  setSourcePanelOpen(true);

  return {
    showLoading,
    clearLoading,
    showModelInfo,
    clearModelInfo,
    setStatus,
    showToast,
    setSourcePanelOpen,
    setDropOverlayVisible(visible) {
      dropOverlay.hidden = !visible;
    },
    mountInspector(element) {
      if (element) performanceStats.before(element);
    },
    updateStats(time, rendered, stream) {
      if (!stats.update(time, rendered) || !stream) return;
      const streamStats = stream.stats;
      const percent = Math.floor(streamStats.loadProgress * 100);
      const progress =
        percent === 100
          ? "Current view ready"
          : `Loading current view ${percent}%`;
      fileStats.textContent = `${formatNumber.format(streamStats.visibleSplats)} visible splats · ${formatNumber.format(streamStats.visibleMeshes)} meshes · ${formatBytes(streamStats.residentCpuBytes)} CPU cached · ${formatBytes(streamStats.residentGpuBytes)} GPU cached · ${progress}`;
      if (!loadingPanel.hidden)
        updateLoadingProgress(streamStats.loadProgress, 1, "stream");
    },
    dispose() {
      stats.dispose();
      events.abort();
      clearToastTimers();
      toast.classList.remove("is-visible");
      toast.hidden = true;
    },
  };
}
