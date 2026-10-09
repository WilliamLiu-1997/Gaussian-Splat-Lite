import { DefaultLoadingManager } from "three";
import { workerPool } from "../runtime/SplatWorker.js";
import { abortable, linkedAbortController } from "../runtime/abort.js";
import { getAssetBaseUrl } from "./assetUrl.js";
import { serializeSplatPostDecode } from "./postDecode/program.js";
/** Loads packed data without constructing scene objects or GPU textures. */
export async function loadSplatData(
  {
    url,
    file,
    fileBytes,
    fileType,
    fileName,
    resolveFile,
    postDecode,
    signal,
    onLoad,
    onProgress,
    onError,
  },
  context = {
    manager: DefaultLoadingManager,
    path: "",
    requestHeader: {},
    withCredentials: false,
  },
) {
  let resolvedURL;
  let started = false;
  const request = linkedAbortController(signal);
  const { controller } = request;
  try {
    signal?.throwIfAborted();
    // Snapshot application attributes at the load call, before waiting for a worker.
    const serializedPostDecode = postDecode
      ? serializeSplatPostDecode(postDecode)
      : undefined;
    if (
      [url, file, fileBytes].filter((input) => input !== undefined).length !== 1
    ) {
      throw new Error("Provide exactly one of url, file, or fileBytes");
    }
    fileName ??= file?.name;
    const byteArray =
      fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const resourcePath = url === undefined ? undefined : context.path + url;
    resolvedURL =
      resourcePath === undefined
        ? undefined
        : context.manager.resolveURL(resourcePath);
    started = true;
    context.manager.itemStart(resolvedURL ?? "");
    const pathName = resolvedURL || fileName;
    const requestUrl = new URL(pathName || "", window.location.href).href;
    const resourceUrl = new URL(
      resourcePath || fileName || "",
      window.location.href,
    ).href;
    const memoryHeavy =
      fileType === "sog" ||
      (!fileType && !/\.(ply|spz)(?:[?#]|$)/i.test(pathName ?? ""));
    const decoded = await workerPool.withWorker(
      (worker) =>
        worker.call(
          "loadSplats",
          {
            url: resolvedURL ? requestUrl : undefined,
            requestHeader: context.requestHeader,
            withCredentials: context.withCredentials,
            file,
            fileBytes: byteArray?.slice(),
            fileType,
            pathName,
            hasFileResolver: resolveFile !== undefined,
            reportProcessingProgress: onProgress !== undefined,
            baseUrl: getAssetBaseUrl(requestUrl) ?? resourceUrl,
            postDecode: serializedPostDecode,
          },
          {
            signal: controller.signal,
            onStatus: async (data) => {
              const status = data;
              if ("assetRequest" in status) {
                return worker.call("resolveAsset", {
                  requestId: status.assetRequest,
                  url: new URL(
                    context.manager.resolveURL(status.url),
                    window.location.href,
                  ).href,
                });
              }
              if ("fileRequest" in status) {
                if (!resolveFile) throw new Error("No external file resolver");
                const input = await abortable(
                  Promise.resolve(
                    resolveFile(status.filename, controller.signal),
                  ),
                  controller.signal,
                );
                controller.signal.throwIfAborted();
                return worker.call("resolveFile", {
                  requestId: status.fileRequest,
                  input:
                    input instanceof Uint8Array
                      ? input.slice()
                      : input instanceof ArrayBuffer
                        ? input.slice(0)
                        : input,
                });
              }
              if (onProgress) {
                try {
                  onProgress(
                    Object.assign(
                      new ProgressEvent("progress", {
                        lengthComputable: status.total !== 0,
                        loaded: status.loaded,
                        total: status.total,
                      }),
                      { stage: status.stage ?? "download" },
                    ),
                  );
                } catch (error) {
                  console.error("Progress callback failed", error);
                }
              }
            },
          },
        ),
      memoryHeavy,
      controller.signal,
    );
    signal?.throwIfAborted();
    onLoad?.(decoded);
    return decoded;
  } catch (error) {
    if (started) context.manager.itemError(resolvedURL ?? "");
    onError?.(error);
    throw error;
  } finally {
    request.cleanup();
    controller.abort();
    if (started) context.manager.itemEnd(resolvedURL ?? "");
  }
}
