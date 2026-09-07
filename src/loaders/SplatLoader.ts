import { Loader } from "three";
import { Splats, type SplatsOptions } from "../data/Splats";
import { workerPool } from "../runtime/SplatWorker";
import { SplatMesh } from "../scene/SplatMesh";
import { getAssetBaseUrl } from "./assetUrl";
import type { SplatLoadStatus } from "./loadTypes";
import { serializeSplatPostDecode } from "./postDecode";

type SplatLoadOptions = Pick<
  SplatsOptions,
  | "url"
  | "file"
  | "fileBytes"
  | "fileType"
  | "fileName"
  | "postDecode"
  | "onProgress"
> & {
  signal?: AbortSignal;
  splats?: Splats;
  onLoad?: (decoded: Splats) => void;
  onError?: (error: unknown) => void;
};

// SplatLoader implements the THREE.Loader interface for PLY, SPZ and SOG.
export class SplatLoader extends Loader {
  load(
    url: string,
    onLoad?: (decoded: Splats) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }

  loadAsync(
    url: string,
    onProgress?: (event: ProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<Splats> {
    return this.loadInternalAsync({ url, onProgress, signal });
  }

  parse(splats: Splats): SplatMesh {
    return new SplatMesh({ splats });
  }

  loadInternal(options: SplatLoadOptions) {
    void this.loadInternalAsync(options).catch(() => {});
  }

  async loadInternalAsync({
    splats,
    url,
    file,
    fileBytes,
    fileType,
    fileName,
    postDecode,
    signal,
    onLoad,
    onProgress,
    onError,
  }: SplatLoadOptions): Promise<Splats> {
    let resolvedURL: string | undefined;
    let started = false;
    try {
      signal?.throwIfAborted();
      if (
        [url, file, fileBytes].filter((input) => input !== undefined).length !==
        1
      ) {
        throw new Error("Provide exactly one of url, file, or fileBytes");
      }
      fileName ??= (file as File | undefined)?.name;
      const byteArray =
        fileBytes instanceof ArrayBuffer
          ? new Uint8Array(fileBytes)
          : fileBytes;
      const resourcePath =
        url === undefined ? undefined : (this.path ?? "") + url;
      resolvedURL =
        resourcePath === undefined
          ? undefined
          : this.manager.resolveURL(resourcePath);
      started = true;
      this.manager.itemStart(resolvedURL ?? "");

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
              requestHeader: this.requestHeader,
              withCredentials: this.withCredentials,
              file,
              fileBytes: byteArray?.slice(),
              fileType,
              pathName,
              baseUrl: getAssetBaseUrl(requestUrl) ?? resourceUrl,
              postDecode: postDecode
                ? serializeSplatPostDecode(postDecode)
                : undefined,
            },
            {
              signal,
              onStatus: (data) => {
                const status = data as SplatLoadStatus;
                if ("assetRequest" in status) {
                  return worker.call("resolveAsset", {
                    requestId: status.assetRequest,
                    url: new URL(
                      this.manager.resolveURL(status.url),
                      window.location.href,
                    ).href,
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
        signal,
      );
      signal?.throwIfAborted();
      const result = splats ?? new Splats();
      result.initialize(decoded as SplatsOptions);
      onLoad?.(result);
      return result;
    } catch (error) {
      if (started) this.manager.itemError(resolvedURL ?? "");
      onError?.(error);
      throw error;
    } finally {
      if (started) this.manager.itemEnd(resolvedURL ?? "");
    }
  }
}
