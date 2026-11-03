// WebGPU allows two frames in flight, submitted only from RAF.
// WebGL keeps one frame in flight and replays only the latest waiting draw.
export function createFrameGate(renderer, onFirstFrameComplete) {
  const gl = renderer.isWebGPURenderer
    ? (renderer.backend.gl ?? null)
    : renderer.getContext();
  let fence = null;
  let pendingFrames = 0;
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
      const ready = pendingFrames < 2 && fence === null;
      if (ready) {
        // A RAF draw supersedes the pending timer and callback.
        clearTimeout(pollTimer);
        pollTimer = undefined;
        pendingFrame = undefined;
      } else if (gl && onReady) {
        // Replace the waiting draw; readiness-only checks leave it intact.
        pendingFrame = onReady;
        // WebGL has no completion promise. Poll only while a draw is waiting.
        if (pollTimer === undefined) {
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
        pendingFrames += 1;
        renderer.backend.device.queue.onSubmittedWorkDone().then(
          () => {
            // GPU completion is not presentation; draw on the next RAF.
            pendingFrames -= 1;
            // Give a newly attached WebGPU canvas another draw after its first
            // submission completes, before the viewer settles into idle mode.
            const notify = notifyFirstFrameComplete;
            notifyFirstFrameComplete = undefined;
            notify?.();
          },
          (error) => {
            pendingFrames -= 1;
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
