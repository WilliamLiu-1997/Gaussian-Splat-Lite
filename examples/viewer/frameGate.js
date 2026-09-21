// Keep one GPU frame in flight and only the latest waiting draw.
export function createFrameGate(renderer, onFirstFrameComplete) {
  const gl = renderer.isWebGPURenderer
    ? (renderer.backend.gl ?? null)
    : renderer.getContext();
  let fence = null;
  let pending = false;
  let pendingFrame;
  let pollTimer;
  let notifyFirstFrameComplete = onFirstFrameComplete;

  function pollFrame() {
    pollTimer = undefined;
    const draw = pendingFrame;
    if (gate.isReady(draw)) draw?.();
  }

  const gate = {
    isReady(onReady) {
      if (gl?.isContextLost()) return false;
      // A zero timeout checks completion without blocking the main thread.
      if (
        fence !== null &&
        gl.clientWaitSync(fence, 0, 0) !== gl.TIMEOUT_EXPIRED
      ) {
        gl.deleteSync(fence);
        fence = null;
      }
      const ready = !pending && fence === null;
      if (ready) {
        // A RAF draw supersedes the pending timer and callback.
        clearTimeout(pollTimer);
        pollTimer = undefined;
        pendingFrame = undefined;
      } else if (onReady) {
        // Replace the waiting draw; readiness-only checks leave it intact.
        pendingFrame = onReady;
        // WebGL has no completion promise. Poll only while a draw is waiting.
        if (gl && pollTimer === undefined) {
          pollTimer = setTimeout(pollFrame, 0);
        }
      }
      return ready;
    },

    submitted() {
      if (gl) {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      } else {
        pending = true;
        renderer.backend.device.queue.onSubmittedWorkDone().then(
          () => {
            // Release before replay: the callback may submit the next frame.
            pending = false;
            const draw = pendingFrame;
            pendingFrame = undefined;
            // Give a newly attached WebGPU canvas another draw after its first
            // submission completes, before the viewer settles into idle mode.
            const notify = notifyFirstFrameComplete;
            notifyFirstFrameComplete = undefined;
            notify?.();
            draw?.();
          },
          (error) => {
            pending = false;
            pendingFrame = undefined;
            console.error("GPU frame completion failed", error);
          },
        );
      }
    },

    dispose() {
      clearTimeout(pollTimer);
      pollTimer = undefined;
      pendingFrame = undefined;
      notifyFirstFrameComplete = undefined;
      if (fence !== null) gl.deleteSync(fence);
      fence = null;
    },
  };
  return gate;
}
