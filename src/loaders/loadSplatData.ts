import { DefaultLoadingManager, type Loader } from "three";
import type { SplatFileType, SplatResult } from "../data/defines";
import { workerPool } from "../runtime/SplatWorker";
import { abortable } from "../runtime/abort";
import { getAssetBaseUrl } from "./assetUrl";
import type { SplatFileResolver, SplatLoadStatus } from "./loadTypes";
import {
  type SplatPostDecodeProgram,
  serializeSplatPostDecode,
} from "./postDecode/program";

export type SplatDataLoadOptions = {
  url?: string;
  file?: Blob;
  fileBytes?: Uint8Array | ArrayBuffer;
  fileType?: SplatFileType;
  fileName?: string;
  resolveFile?: SplatFileResolver;
  postDecode?: SplatPostDecodeProgram;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onLoad?: (decoded: SplatResult) => void;
  onError?: (error: unknown) => void;
};

type SplatLoadContext = Pick<
  Loader,
  "manager" | "path" | "requestHeader" | "withCredentials"
>;

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
  }: SplatDataLoadOptions,
  context: SplatLoadContext = {
    manager: DefaultLoadingManager,
    path: "",
    requestHeader: {},
    withCredentials: false,
  },
): Promise<SplatResult> {
  let resolvedURL: string | undefined;
  let started = false;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (
      [url, file, fileBytes].filter((input) => input !== undefined).length !== 1
    ) {
      throw new Error("Provide exactly one of url, file, or fileBytes");
    }
    fileName ??= (file as File | undefined)?.name;
    const byteArray =
      fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const resourcePath =
      url === undefined ? undefined : (context.path ?? "") + url;
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
            baseUrl: getAssetBaseUrl(requestUrl) ?? resourceUrl,
            postDecode: postDecode
              ? serializeSplatPostDecode(postDecode)
              : undefined,
          },
          {
            signal: controller.signal,
            onStatus: async (data) => {
              const status = data as SplatLoadStatus;
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
                    new ProgressEvent("progress", {
                      lengthComputable: status.total !== 0,
                      ...status,
                    }),
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
    signal?.removeEventListener("abort", abort);
    controller.abort();
    if (started) context.manager.itemEnd(resolvedURL ?? "");
  }
}
