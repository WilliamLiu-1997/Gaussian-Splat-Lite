export function createViewerUI({
  document = globalThis.document,
  onCancelLoad,
  onResetView,
}) {
  const window = document.defaultView;
  const interfaceRoot = document.querySelector(".interface");
  const toolbarActions = document.querySelector(".toolbar-actions");
  const statusBar = document.querySelector(".statusbar");
  const sourceUpAxis = document.querySelector("#source-up-axis");
  const emptyState = document.querySelector("#empty-state");
  const sourcePanelBackdrop = document.querySelector("#source-panel-backdrop");
  const sourcePanelToggle = document.querySelector("#source-panel-toggle");
  const sourcePanelClose = document.querySelector("#source-panel-close");
  const chooseFileButton = document.querySelector("#choose-file");
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
  const fileName = document.querySelector("#file-name");
  const fileStats = document.querySelector("#file-stats");
  const modelCredit = document.querySelector("#model-credit");
  const modelCreditPrefix = document.querySelector("#model-credit-prefix");
  const modelCreditSeparator = document.querySelector(
    "#model-credit-separator",
  );
  const dropOverlay = document.querySelector("#drop-overlay");
  const toast = document.querySelector("#toast");
  const renderOptionsToggle = document.querySelector("#render-options-toggle");
  const renderOptionsPanel = document.querySelector("#render-options");
  const renderOptionsClose = document.querySelector("#render-options-close");
  const performanceStats = document.querySelector("#performance-stats");
  const performanceFps = document.querySelector("#performance-fps");
  const performanceHeap = document.querySelector("#performance-heap");

  let hasModel = false;
  let toastFrame;
  let toastTimer;
  let toastHideTimer;
  const events = new window.AbortController();
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

  function formatHeapSize(bytes) {
    const mebibytes = bytes / (1024 * 1024);
    if (mebibytes >= 1024) return `${(mebibytes / 1024).toFixed(1)} GB`;
    return `${mebibytes.toFixed(mebibytes >= 100 ? 0 : 1)} MB`;
  }

  function updateHeapStat(memory) {
    if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
      performanceHeap.value = "N/A";
      performanceStats.dataset.tooltip =
        "JS heap reporting is not available in this browser.";
      return;
    }

    performanceHeap.value = formatHeapSize(memory.usedJSHeapSize);
    performanceStats.dataset.tooltip = Number.isFinite(memory.jsHeapSizeLimit)
      ? `${formatHeapSize(memory.usedJSHeapSize)} used of ${formatHeapSize(memory.jsHeapSizeLimit)}`
      : `${formatHeapSize(memory.usedJSHeapSize)} used`;
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
    sourceUpAxis.hidden = !hasModel;
    sourceUpAxis.inert = sourcePanelOpen || loading;
    emptyState.inert = loading;
    renderOptionsPanel.inert = loading;
  }

  function setSourcePanelOpen(open, { moveFocus = false } = {}) {
    const shouldOpen = open || !hasModel;
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
    sourcePanelClose.hidden = !hasModel;

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

  function showLoading(file, loaded = 0, total = file.size) {
    const wasHidden = loadingPanel.hidden;
    loadingBackdrop.hidden = false;
    loadingPanel.hidden = false;
    syncBackgroundInteractivity();
    loadingName.textContent = file.name;
    loadingProgress.classList.toggle(
      "is-indeterminate",
      !(total > 0 && loaded >= 0),
    );

    if (wasHidden) loadingCancelButton.focus();

    if (total > 0 && loaded >= 0) {
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
      loadingDetail.textContent =
        loaded > 0
          ? `Downloading… · ${formatBytes(loaded)} received`
          : "Starting download…";
    }
  }

  function clearLoading() {
    loadingProgress.classList.remove("is-indeterminate");
    loadingBackdrop.hidden = true;
    loadingPanel.hidden = true;
    loadingProgressFill.style.transform = "scaleX(0)";
    syncBackgroundInteractivity();
  }

  function showModelInfo(
    file,
    { credit = "", numSplats = 0, streamed = false } = {},
  ) {
    hasModel = true;
    setSourcePanelOpen(false);
    resetViewButton.hidden = false;
    fileMeta.hidden = false;
    fileName.textContent = file.name;
    const sizeLabel = file.size > 0 ? ` · ${formatBytes(file.size)}` : "";
    fileStats.textContent = streamed
      ? "Loading visible regions…"
      : `${formatNumber.format(numSplats)} splats${sizeLabel}`;
    modelCredit.textContent = credit;
    modelCreditPrefix.hidden = !credit;
    modelCredit.hidden = !credit;
    modelCreditSeparator.hidden = !credit;
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
    if (sourcePanelOpen) chooseFileButton.focus();
    else sourcePanelToggle.focus();
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler, { signal: events.signal });
  }

  listen(sourcePanelToggle, "click", () =>
    setSourcePanelOpen(true, { moveFocus: true }),
  );
  listen(sourcePanelClose, "click", closeSourcePanel);
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
    if (event.key !== "Escape") return;
    if (!loadingPanel.hidden) requestCancelLoad();
    else if (!renderOptionsPanel.hidden) closeRenderOptions();
    else if (!emptyState.hidden && hasModel) closeSourcePanel();
  });

  setSourcePanelOpen(true);
  updateHeapStat(window.performance.memory);

  return {
    get isLoading() {
      return !loadingPanel.hidden;
    },
    showLoading,
    clearLoading,
    showModelInfo,
    clearModelInfo,
    setStatus,
    showToast,
    setLoadingDetail(message) {
      loadingDetail.textContent = message;
    },
    setDropOverlayVisible(visible) {
      dropOverlay.hidden = !visible;
    },
    mountInspector(element) {
      performanceStats.hidden = Boolean(element);
      // Mount before assigning renderer.inspector so auto-attach keeps this location.
      if (element) performanceStats.before(element);
    },
    updateStats({ fps, memory, streamStats }) {
      performanceFps.value = fps >= 10 ? Math.round(fps) : fps.toFixed(1);
      updateHeapStat(memory);
      if (streamStats) {
        fileStats.textContent = `${formatNumber.format(streamStats.visibleSplats)} visible splats · ${formatNumber.format(streamStats.visibleMeshes)} meshes · ${formatBytes(streamStats.residentBytes)} cached · ${streamStats.loadingChunks} loading`;
      }
    },
    dispose() {
      events.abort();
      clearToastTimers();
      toast.classList.remove("is-visible");
      toast.hidden = true;
    },
  };
}
