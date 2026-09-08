import { Loader } from "three";
import { Splats, type SplatsOptions } from "../data/Splats";
import { SplatMesh } from "../scene/SplatMesh";
import { type SplatDataLoadOptions, loadSplatData } from "./loadSplatData";

type SplatLoadOptions = Omit<SplatDataLoadOptions, "onLoad"> & {
  splats?: Splats;
  onLoad?: (decoded: Splats) => void;
};

// SplatLoader implements the THREE.Loader interface for PLY, SPZ, SOG and RAD.
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
    onLoad,
    ...options
  }: SplatLoadOptions): Promise<Splats> {
    let result!: Splats;
    await loadSplatData(
      {
        ...options,
        onLoad: (decoded) => {
          result = splats ?? new Splats();
          result.initialize(decoded as SplatsOptions);
          onLoad?.(result);
        },
      },
      this,
    );
    return result;
  }
}
