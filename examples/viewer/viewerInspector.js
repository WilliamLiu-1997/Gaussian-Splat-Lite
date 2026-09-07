import { Inspector } from "three/addons/inspector/Inspector.js";

export class ViewerInspector extends Inspector {
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
