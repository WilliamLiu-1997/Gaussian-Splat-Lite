import { Loader } from "three";
import { Splats } from "../data/Splats";
import { linkedAbortController } from "../runtime/abort";
import { SplatMesh } from "../scene/SplatMesh";
import { type SplatDataLoadOptions, loadSplatData } from "./loadSplatData";
import type { SplatProgressEvent } from "./loadTypes";

type SplatLoadOptions = Omit<SplatDataLoadOptions, "onLoad"> & {
  splats?: Splats;
  onLoad?: (decoded: Splats) => void;
};

// SplatLoader implements the THREE.Loader interface for PLY, SPZ, SOG and RAD.
export class SplatLoader extends Loader {
  private readonly requests = new Set<AbortController>();

  override abort() {
    for (const request of this.requests)
      request.abort(new DOMException("Splat load aborted", "AbortError"));
    return this;
  }

  load(
    url: string,
    onLoad?: (decoded: Splats) => void,
    onProgress?: (event: SplatProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }

  loadAsync(
    url: string,
    onProgress?: (event: SplatProgressEvent) => void,
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
    onLoad,
    ...options
  }: SplatLoadOptions): Promise<Splats> {
    const request = linkedAbortController(options.signal);
    this.requests.add(request.controller);
    try {
      let result!: Splats;
      await loadSplatData(
        {
          ...options,
          signal: request.signal,
          onLoad: (decoded) => {
            result = splats ?? new Splats();
            result.initializeDecoded(decoded);
            onLoad?.(result);
          },
        },
        this,
      );
      return result;
    } finally {
      this.requests.delete(request.controller);
      request.cleanup();
    }
  }
}
