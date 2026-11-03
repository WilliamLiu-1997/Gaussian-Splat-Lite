// Keep one GPU frame in flight and only the latest waiting draw.
export function createFrameGate(renderer, onFirstFrameComplete) {
  const gl = renderer.isWebGPURenderer
    ? (renderer.backend.gl ?? null)
    : renderer.getContext();
  let fence = null;
  let pending = false;
  let pendingFrame;
  let polling = false;
  let pollId = 0;
  let notifyFirstFrameComplete = onFirstFrameComplete;

  // MessageChannel avoids the minimum delay of nested setTimeout(0) calls.
  const channel = gl ? new MessageChannel() : null;
  if (channel) {
    channel.port1.onmessage = ({ data }) => {
      // Ignore polls cancelled or superseded since they were posted.
      if (!polling || data !== pollId) return;
      polling = false;
      const draw = pendingFrame;
      if (gate.isReady(draw)) draw?.();
    };
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
        // A RAF draw supersedes the pending poll and callback.
        polling = false;
        pendingFrame = undefined;
      } else if (onReady) {
        // Replace the waiting draw; readiness-only checks leave it intact.
        pendingFrame = onReady;
        // WebGL has no completion promise. Poll only while a draw is waiting.
        if (gl && !polling) {
          polling = true;
          channel.port2.postMessage(++pollId);
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
      polling = false;
      pendingFrame = undefined;
      notifyFirstFrameComplete = undefined;
      channel?.port1.close();
      channel?.port2.close();
      if (fence !== null) gl.deleteSync(fence);
      fence = null;
    },
  };
  return gate;
}
