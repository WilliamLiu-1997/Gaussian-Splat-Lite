// Static hosts can enable shared memory for the converter without changing
// headers on the viewer or other pages outside this service worker's scope.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const response = await fetch(request);
      if (!response.status) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })(),
  );
});
