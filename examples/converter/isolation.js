export async function enableThreads() {
  if (globalThis.crossOriginIsolated) return;
  if (!navigator.serviceWorker || window.top !== window.self)
    throw new Error(
      "Open the converter in its own HTTPS tab to enable parallel conversion.",
    );
  if (navigator.serviceWorker.controller)
    throw new Error(
      "Parallel conversion requires COOP same-origin and COEP require-corp on this host.",
    );
  await navigator.serviceWorker.register("./isolate-sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      }),
    );
  location.reload();
  // Keep the form disabled while the controlled document replaces this one.
  await new Promise(() => {});
}
