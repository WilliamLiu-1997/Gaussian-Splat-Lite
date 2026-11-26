export function createPerformanceStats(document) {
  const window = document.defaultView;
  const performanceStats = document.querySelector("#performance-stats");
  const performanceTooltip = document.querySelector("#performance-tooltip");
  const performanceFps = document.querySelector("#performance-fps");
  const performanceHeap = document.querySelector("#performance-heap");

  const events = new window.AbortController();
  let sampleStart = window.performance.now();
  let renderedFrames = 0;

  function formatHeapSize(bytes) {
    const mebibytes = bytes / (1024 * 1024);
    if (mebibytes >= 1024) return `${(mebibytes / 1024).toFixed(1)} GB`;
    return `${mebibytes.toFixed(mebibytes >= 100 ? 0 : 1)} MB`;
  }

  function updateHeapStat(memory) {
    if (!memory || !Number.isFinite(memory.usedJSHeapSize)) {
      performanceHeap.value = "N/A";
      performanceTooltip.textContent =
        "JS heap reporting is not available in this browser.";
      return;
    }

    performanceHeap.value = formatHeapSize(memory.usedJSHeapSize);
    performanceTooltip.textContent = Number.isFinite(memory.jsHeapSizeLimit)
      ? `${formatHeapSize(memory.usedJSHeapSize)} used of ${formatHeapSize(memory.jsHeapSizeLimit)}`
      : `${formatHeapSize(memory.usedJSHeapSize)} used`;
  }

  function setPerformanceTooltipOpen(open) {
    if (open === performanceTooltip.matches(":popover-open")) return;
    performanceStats.classList.toggle("is-tooltip-open", open);
    performanceStats.setAttribute("aria-expanded", String(open));
    if (open) {
      performanceTooltip.showPopover();
      const bounds = performanceStats.getBoundingClientRect();
      performanceTooltip.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - performanceTooltip.offsetWidth - 12))}px`;
      performanceTooltip.style.top = `${bounds.bottom + 6}px`;
    } else {
      performanceTooltip.hidePopover();
    }
  }

  function update(time, rendered) {
    if (rendered) renderedFrames++;
    const elapsed = time - sampleStart;
    if (elapsed < 500) return false;

    const fps = (renderedFrames * 1000) / elapsed;
    performanceFps.value = fps >= 10 ? Math.round(fps) : fps.toFixed(1);
    updateHeapStat(window.performance.memory);
    sampleStart = time;
    renderedFrames = 0;
    return true;
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler, { signal: events.signal });
  }

  listen(performanceStats, "pointerenter", (event) => {
    if (event.pointerType === "mouse") setPerformanceTooltipOpen(true);
  });
  listen(performanceStats, "pointerleave", (event) => {
    if (event.pointerType === "mouse") setPerformanceTooltipOpen(false);
  });
  listen(performanceStats, "focus", () => {
    if (performanceStats.matches(":focus-visible")) {
      setPerformanceTooltipOpen(true);
    }
  });
  listen(performanceStats, "blur", () => setPerformanceTooltipOpen(false));
  listen(window, "resize", () => setPerformanceTooltipOpen(false));
  listen(performanceStats, "click", () =>
    setPerformanceTooltipOpen(
      !performanceStats.classList.contains("is-tooltip-open"),
    ),
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!performanceStats.contains(event.target)) {
        setPerformanceTooltipOpen(false);
      }
    },
    { capture: true, signal: events.signal },
  );

  listen(window, "keydown", (event) => {
    if (event.key === "Escape" && performanceTooltip.matches(":popover-open")) {
      setPerformanceTooltipOpen(false);
      event.preventDefault();
    }
  });
  updateHeapStat(window.performance.memory);

  return {
    update,
    closeTooltip: () => setPerformanceTooltipOpen(false),
    dispose() {
      setPerformanceTooltipOpen(false);
      events.abort();
    },
  };
}
