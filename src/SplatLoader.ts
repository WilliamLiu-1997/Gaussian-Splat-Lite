import { Loader } from "three";
import { SplatMesh } from "./SplatMesh";
import { workerPool } from "./SplatWorker";
import { Splats, type SplatsOptions } from "./Splats";
import type { SplatFileType } from "./defines";
import {
  type SplatPostDecodeProgram,
  serializeSplatPostDecode,
} from "./postDecode";

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

  async loadAsync(
    url: string,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<Splats> {
    return new Promise((resolve, reject) => {
      this.load(url, resolve, onProgress, reject);
    });
  }

  parse(splats: Splats): SplatMesh {
    return new SplatMesh({ splats });
  }

  loadInternal({
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
  }: {
    splats?: Splats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    postDecode?: SplatPostDecodeProgram;
    onLoad?: (decoded: Splats) => void;
    onProgress?: (event: ProgressEvent) => void;
    onError?: (error: unknown) => void;
  }) {
    const byteArray =
      fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
    const resolvedURL = byteArray
      ? undefined
      : this.manager.resolveURL((this.path ?? "") + (url ?? ""));
    let streamReader = stream?.getReader();
    const cancelStreamReader = async (reason: unknown) => {
      const reader = streamReader;
      streamReader = undefined;
      if (!reader) return;
      try {
        await reader.cancel(reason);
      } catch {
        // Preserve the original error if stream cancellation fails.
      }
      reader.releaseLock();
    };

    this.manager.itemStart(resolvedURL ?? "");

    workerPool
      .withWorker(async (worker) => {
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
      })
      .catch(async (error) => {
        await cancelStreamReader(error);
        this.manager.itemError(resolvedURL ?? "");
        onError?.(error);
      })
      .finally(() => {
        this.manager.itemEnd(resolvedURL ?? "");
      });
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
    onProgress,
  }: {
    splats?: Splats;
    url?: string;
    fileBytes?: Uint8Array | ArrayBuffer;
    fileType?: SplatFileType;
    fileName?: string;
    stream?: ReadableStream;
    streamLength?: number;
    postDecode?: SplatPostDecodeProgram;
    onProgress?: (event: ProgressEvent) => void;
  }): Promise<Splats> {
    return new Promise((resolve, reject) => {
      this.loadInternal({
        splats,
        url,
        fileBytes,
        fileType,
        fileName,
        stream,
        streamLength,
        postDecode,
        onLoad: resolve,
        onProgress,
        onError: reject,
      });
    });
  }
}
