import { Inspector } from "three/addons/inspector/Inspector.js";

export class ViewerInspector extends Inspector {
  constructor() {
    super();
    this.enabled = false;
    this.parameters.hide();
    this.domElement.classList.add("viewer-inspector");
    this.profiler.toggleButton.setAttribute(
      "aria-label",
      "Toggle Three.js Inspector",
    );
    this.profiler.toggleButton.title = "Three.js Inspector";
  }

  setRenderer(renderer) {
    super.setRenderer(renderer);
    if (renderer) this.syncRecording();
    return this;
  }

  syncRecording() {
    const { profiler } = this;
    const recording =
      profiler.panel.classList.contains("visible") ||
      profiler.miniPanel.classList.contains("visible") ||
      profiler.detachedWindows.some(
        ({ panel }) => panel.style.display !== "none",
      );
    if (recording && !this.enabled) {
      // Restart averages without including time spent with the panel closed.
      this.frames.length = 0;
      this.framesLib = {};
      this.lastFrame = null;
      this._lastFinishTime = 0;
      this.statsData.clear();
    }
    if (!recording && this._rAFId !== null) {
      // Cancel a queued resolve before disabling its GPU timestamp queries.
      cancelAnimationFrame(this._rAFId);
      this._rAFId = null;
      this._resolveTimestampPromise = null;
    }
    if (!recording && this.timeline.isRecording)
      this.timeline.toggleRecording();
    this.enabled = recording;
    this.getRenderer().backend.trackTimestamp = recording;
  }

  begin() {
    this.syncRecording();
    if (this.enabled) super.begin();
  }

  getFrame() {
    // Three's render/compute hooks run even when Inspector.enabled is false.
    return this.enabled ? super.getFrame() : null;
  }

  updateTabs() {
    if (this.enabled) super.updateTabs();
  }

  resolveFrame(frame) {
    // An already submitted timestamp query may finish after the panel closes.
    if (this.enabled) super.resolveFrame(frame);
  }

  _getFPS() {
    let renderedFrames = 0;
    let elapsed = 0;

    // Three.js records every animation tick, including on-demand/GPU waits.
    // Keep their elapsed time, but count a composed frame only once.
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i];
      if (frame.deltaTime > 0 && frame.renders.length > 0) renderedFrames++;
      elapsed += frame.deltaTime;
      if (elapsed >= 1000) break;
    }

    return elapsed > 0 ? (renderedFrames * 1000) / elapsed : 0;
  }

  finish() {
    super.finish();

    const frame = this.lastFrame;
    // Empty ticks have no GPU timestamps to resolve. Refresh the native
    // counters and graphs here so they also reach zero while idle.
    if (frame.renders.length === 0 && frame.computes.length === 0) {
      frame.resolvedRender = true;
      frame.resolvedCompute = true;
      this.resolveFrame(frame);
    }
  }
}
