import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";

const page = "examples/converter/index.html";
const sourcePage = fileURLToPath(new URL("./index.html", import.meta.url));
const publicPage = normalizePath(
  fileURLToPath(new URL("../../converter/index.html", import.meta.url)),
);
const devRoutes = new Map([
  ["converter/", page],
  ["converter/index.html", page],
  ["converter/preview.html", "index.html"],
  ["converter/isolate-sw.js", "examples/converter/isolate-sw.js"],
]);
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function isolateConverter(server) {
  server.middlewares.use((req, res, next) => {
    if (
      req.url?.split("?")[0].startsWith(`${server.config.base}converter/`) ||
      req.headers["sec-fetch-dest"] === "worker"
    )
      for (const [name, value] of Object.entries(isolationHeaders))
        res.setHeader(name, value);
    next();
  });
}

export function converterPages() {
  return {
    name: "gsl-converter-pages",
    // Build the example at its public URL so Vite computes relative asset paths there.
    resolveId(id) {
      if (id === "converter/index.html") return publicPage;
    },
    load(id) {
      if (id === publicPage) {
        this.addWatchFile(sourcePage);
        return readFileSync(sourcePage, "utf8");
      }
    },
    configurePreviewServer: isolateConverter,
    configureServer(server) {
      isolateConverter(server);
      server.middlewares.use((req, res, next) => {
        const { base } = server.config;
        if (!req.url.startsWith(base)) return next();
        const relative = req.url.slice(base.length);
        const path = relative.split("?")[0];
        const query = relative.slice(path.length);
        if (
          path === "converter" ||
          path === "examples/converter" ||
          path === "examples/converter/" ||
          path === page
        ) {
          res.writeHead(302, { Location: `${base}converter/${query}` });
          return res.end();
        }
        const source = devRoutes.get(path);
        if (source) req.url = base + source + query;
        next();
      });
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "converter/isolate-sw.js",
          source: readFileSync(
            new URL("./isolate-sw.js", import.meta.url),
            "utf8",
          ),
        });
        this.emitFile({
          type: "asset",
          fileName: "converter/preview.html",
          source: bundle["index.html"].source.replace(
            "<head>",
            '<head><base href="../">',
          ),
        });
      },
    },
  };
}
