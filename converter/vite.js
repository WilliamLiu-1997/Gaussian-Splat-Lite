import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export function converterRuntime() {
  return {
    name: "gsl-browser-converter",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!id.startsWith("#gsl/")) return;
      const name = id.slice(5);
      if (name === "path")
        return this.resolve("@jspm/core/nodelibs/path", importer, {
          skipSelf: true,
        });
      return path.join(root, "runtime", `${name}.js`);
    },
  };
}

function isolateConverter(server) {
  server.middlewares.use((req, res, next) => {
    if (
      req.url?.includes("/converter/") ||
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
    configurePreviewServer: isolateConverter,
    configureServer(server) {
      isolateConverter(server);
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] === "/converter/preview.html")
          req.url = req.url.replace("/converter/preview.html", "/index.html");
        next();
      });
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        this.emitFile({
          type: "asset",
          fileName: "converter/isolate-sw.js",
          source: readFileSync(path.join(root, "isolate-sw.js"), "utf8"),
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
