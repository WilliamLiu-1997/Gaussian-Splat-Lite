import { formatBytes, showFileMeta } from "../../shared/fileMeta.js";
import { createPerformanceStats } from "../../shared/performanceStats.js";

// Approximate overall progress; reserve completion for model initialization.
const LOADING_STAGE_RANGES = {
  download: [0, 0.7],
  postDecode: [0.7, 0.8],
  optimize: [0.8, 0.99],
};

export function createExampleUI({
  document = globalThis.document,
  onCancelLoad,
  onResetView,
}) {
  const window = document.defaultView;
  const interfaceRoot = document.querySelector(".interface");
  const toolbarActions = document.querySelector(".toolbar-actions");
  const emptyState = document.querySelector("#empty-state");
  const sourcePanelBackdrop = document.querySelector("#source-panel-backdrop");
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
    toolbarActions.inert = !hasModel || loading;
    emptyState.inert = loading;
    renderOptionsPanel.inert = loading;
  }

  function setStartPanelOpen(open) {
    emptyState.hidden = !open;
    sourcePanelBackdrop.hidden = !open;
    interfaceRoot.classList.toggle("is-source-panel-open", open);
    if (open && !renderOptionsPanel.hidden) setRenderOptionsOpen(false);
    syncBackgroundInteractivity();
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
    const starting = loadingPanel.hidden;
    loadingBackdrop.hidden = false;
    loadingPanel.hidden = false;
    syncBackgroundInteractivity();
    if (starting) loadingCancelButton.focus({ preventScroll: true });
    loadingName.textContent = file.name;
    updateLoadingProgress(loaded, total, stage);
  }

  function updateLoadingProgress(loaded, total, stage) {
    if (stage === "download" && loaded === 0) loadingRatio = 0;
    if (total > 0 && loaded >= 0) {
      const ratio = Math.min(loaded / total, 1);
      const [start, end] = LOADING_STAGE_RANGES[stage];
      loadingRatio = Math.max(loadingRatio, start + ratio * (end - start));
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
        const label = stage === "postDecode" ? "Post-processing" : "Optimizing";
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

  function showModelInfo(file, numSplats) {
    hasModel = true;
    setStartPanelOpen(false);
    resetViewButton.hidden = false;
    showFileMeta(fileMeta, file, numSplats);
    setStatus("Loaded and ready");
  }

  function clearModelInfo() {
    hasModel = false;
    resetViewButton.hidden = true;
    fileMeta.hidden = true;
    setStartPanelOpen(false);
  }

  function requestCancelLoad() {
    if (loadingPanel.hidden) return;
    onCancelLoad();
    clearLoading();
    setStartPanelOpen(true);
    setStatus("Loading canceled");
    document.querySelector("#load-scene").focus();
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler, { signal: events.signal });
  }

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
  });

  syncBackgroundInteractivity();

  return {
    showLoading,
    clearLoading,
    showModelInfo,
    showRetry() {
      setStartPanelOpen(true);
    },
    clearModelInfo,
    setStatus,
    showToast,
    mountInspector(element) {
      if (element) performanceStats.before(element);
    },
    updateStats: stats.update,
    dispose() {
      stats.dispose();
      events.abort();
      clearToastTimers();
      toast.classList.remove("is-visible");
      toast.hidden = true;
    },
  };
}
