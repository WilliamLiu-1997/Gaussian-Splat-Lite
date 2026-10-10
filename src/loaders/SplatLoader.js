import { Loader } from "three";
import { Splats } from "../data/Splats.js";
import { linkedAbortController } from "../runtime/abort.js";
import { SplatMesh } from "../scene/SplatMesh.js";
import { loadSplatData } from "./loadSplatData.js";
// SplatLoader implements the THREE.Loader interface for PLY, SPZ, SOG and RAD.
export class SplatLoader extends Loader {
  constructor(...args) {
    super(...args);
    this.requests = new Set();
  }
  abort() {
    for (const request of this.requests)
      request.abort(new DOMException("Splat load aborted", "AbortError"));
    return this;
  }
  load(url, onLoad, onProgress, onError) {
    return this.loadInternal({ url, onLoad, onProgress, onError });
  }
  loadAsync(url, onProgress, signal) {
    return this.loadInternalAsync({ url, onProgress, signal });
  }
  parse(splats) {
    return new SplatMesh({ splats });
  }
  loadInternal(options) {
    void this.loadInternalAsync(options).catch(() => {});
  }
  async loadInternalAsync({ splats, onLoad, ...options }) {
    const request = linkedAbortController(options.signal);
    this.requests.add(request.controller);
    try {
      let result;
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
