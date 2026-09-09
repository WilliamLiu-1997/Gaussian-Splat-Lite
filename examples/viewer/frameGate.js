// Keep at most one viewer frame in flight; animation ticks never queue draws.
export function createFrameGate(renderer, onFirstFrameComplete) {
  const gl = renderer.isWebGPURenderer
    ? (renderer.backend.gl ?? null)
    : renderer.getContext();
  let fence = null;
  let pending = false;
  let notifyFirstFrameComplete = onFirstFrameComplete;

  return {
    isReady() {
      if (pending || gl?.isContextLost()) return false;
      if (fence !== null) {
        // A zero timeout checks completion without blocking the main thread.
        if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) return false;
        gl.deleteSync(fence);
        fence = null;
      }
      return true;
    },

    submitted() {
      if (gl) {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
      } else {
        pending = true;
        renderer.backend.device.queue
          .onSubmittedWorkDone()
          .then(() => {
            // Give a newly attached WebGPU canvas another draw after its first
            // submission completes, before the viewer settles into idle mode.
            const notify = notifyFirstFrameComplete;
            notifyFirstFrameComplete = undefined;
            notify?.();
          })
          .catch((error) => console.error("GPU frame completion failed", error))
          .finally(() => {
            pending = false;
          });
      }
    },

    dispose() {
      notifyFirstFrameComplete = undefined;
      if (fence !== null) gl.deleteSync(fence);
      fence = null;
    },
  };
}
