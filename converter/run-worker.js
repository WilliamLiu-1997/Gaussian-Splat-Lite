import taskUrl from "./task.js?worker&url";

export function runWorker(args, signal, update) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    const children = new Map();
    function finish(error) {
      for (const thread of children.values()) thread.terminate();
      children.clear();
      worker.terminate();
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    }
    const cancelled = new Int32Array(new SharedArrayBuffer(4));
    const cancel = () => {
      Atomics.store(cancelled, 0, 1);
      finish(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.spawn !== undefined) {
        // The coordinator can be blocked in Atomics.wait during worker
        // startup. The page owns the workers and their error/exit cleanup.
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
        const child = new Worker(taskUrl, {
          type: "module",
          name: `GSL ${role}`,
        });
        children.set(data.spawn, child);
        child.onerror = (event) =>
          finish(
            new Error(event.message || `Could not start the ${role} worker.`),
          );
        child.postMessage({ init: task, port: data.port }, [data.port]);
      } else if (data.stop !== undefined) {
        children.get(data.stop)?.terminate();
        children.delete(data.stop);
      } else if (data.done || data.error)
        finish(data.error && new Error(data.error));
      else update(data);
    };
    worker.onerror = (event) =>
      finish(
        new Error(event.message || "Could not start the conversion worker."),
      );
    worker.postMessage({ ...args, cancelled });
  });
}
