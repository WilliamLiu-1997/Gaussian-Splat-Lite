export async function runWorker(args, callerSignal, update) {
  // Keep cancellation observable even if a caller stops its own abort event.
  const signal =
    callerSignal && AbortSignal.any
      ? AbortSignal.any([callerSignal])
      : callerSignal;
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  const children = new Map();
  let cancel;
  try {
    await new Promise((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onerror = (event) =>
        reject(
          new Error(event.message || "Could not start the conversion worker."),
        );
      worker.onmessage = ({ data }) => {
        try {
          if (data.spawn !== undefined) {
            // Own child workers here so cancellation can terminate a blocked coordinator.
            const task = data.data;
            const role = task.control
              ? "LOD"
              : task.encoder
                ? "SOG"
                : task.format
                  ? "RAD"
                  : task.codebook
                    ? "SH"
                    : "regions";
            const child = new Worker(new URL("./task.js", import.meta.url), {
              type: "module",
              name: `GSL ${role}`,
            });
            children.set(data.spawn, child);
            child.onerror = (event) =>
              reject(
                new Error(
                  event.message || `Could not start the ${role} worker.`,
                ),
              );
            child.postMessage(
              { init: { ...task, cancelled: args.cancelled }, port: data.port },
              [data.port],
            );
          } else if (data.stop !== undefined) {
            children.get(data.stop)?.terminate();
            children.delete(data.stop);
          } else if (data.error !== undefined) reject(new Error(data.error));
          else if (data.done) resolve();
          else {
            const pending = update?.(data);
            if (typeof pending?.then === "function")
              Promise.resolve(pending).catch(reject);
          }
        } catch (error) {
          reject(error);
        }
      };
      worker.postMessage(args);
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    for (const child of children.values()) child.terminate();
    worker.terminate();
  }
}
