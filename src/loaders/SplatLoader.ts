import { Loader } from "three";
import { Splats, type SplatsOptions } from "../data/Splats";
import { workerPool } from "../runtime/SplatWorker";
import { SplatMesh } from "../scene/SplatMesh";
import { serializeSplatPostDecode } from "./postDecode";

type SplatLoadOptions = Pick<
  SplatsOptions,
  | "url"
  | "fileBytes"
  | "fileType"
  | "fileName"
  | "stream"
  | "streamLength"
  | "postDecode"
  | "onProgress"
> & {
  splats?: Splats;
  onLoad?: (decoded: Splats) => void;
  onError?: (error: unknown) => void;
};

// SplatLoader implements the THREE.Loader interface for PLY and SPZ files.
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
  ): Promise<Splats> {
    return this.loadInternalAsync({ url, onProgress });
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
    fileBytes,
    fileType,
    fileName,
    stream,
    streamLength,
    postDecode,
    onLoad,
    onProgress,
    onError,
  }: SplatLoadOptions): Promise<Splats> {
    let resolvedURL: string | undefined;
    let streamReader: ReadableStreamDefaultReader | undefined;
    let started = false;
    try {
      const byteArray =
        fileBytes instanceof ArrayBuffer
          ? new Uint8Array(fileBytes)
          : fileBytes;
      resolvedURL = byteArray
        ? undefined
        : this.manager.resolveURL((this.path ?? "") + (url ?? ""));
      streamReader = stream?.getReader();
      started = true;
      this.manager.itemStart(resolvedURL ?? "");

      return await workerPool.withWorker(async (worker) => {
        const readStreamChunk = async () => {
          const reader = streamReader;
          if (!reader) return new Uint8Array(0);

          try {
            const { done, value } = await reader.read();
            if (!done) return value;

            reader.releaseLock();
            streamReader = undefined;
            return new Uint8Array(0);
          } catch (error) {
            await worker.call("nextChunk", { chunk: new Uint8Array(0) });
            throw error;
          }
        };

        const onStatus = async (data: unknown) => {
          const { loaded, total } = data as {
            loaded?: number;
            total?: number;
          };
          if (loaded !== undefined && onProgress) {
            try {
              onProgress(
                new ProgressEvent("progress", {
                  lengthComputable: total !== 0,
                  loaded,
                  total: total ?? 0,
                }),
              );
            } catch (error) {
              console.error("Progress callback failed", error);
            }
          }

          if ((data as { nextChunk?: boolean }).nextChunk) {
            const chunk = await readStreamChunk();
            await worker.call("nextChunk", { chunk });
          }
        };

        const basedUrl = resolvedURL
          ? new URL(resolvedURL, window.location.href).toString()
          : undefined;
        const decoded = await worker.call(
          "loadSplats",
          {
            url: basedUrl,
            requestHeader: this.requestHeader,
            withCredentials: this.withCredentials,
            fileBytes: byteArray?.slice(),
            fileType,
            pathName: resolvedURL || fileName,
            chunked: stream !== undefined,
            chunkedLength: streamLength,
            postDecode: postDecode
              ? serializeSplatPostDecode(postDecode)
              : undefined,
          },
          { onStatus },
        );

        const result = splats ?? new Splats();
        result.initialize(decoded as SplatsOptions);
        onLoad?.(result);
        return result;
      });
    } catch (error) {
      try {
        await streamReader?.cancel(error);
      } catch {
        // Preserve the original error if stream cancellation fails.
      }
      streamReader?.releaseLock();
      if (started) this.manager.itemError(resolvedURL ?? "");
      onError?.(error);
      throw error;
    } finally {
      if (started) this.manager.itemEnd(resolvedURL ?? "");
    }
  }
}
