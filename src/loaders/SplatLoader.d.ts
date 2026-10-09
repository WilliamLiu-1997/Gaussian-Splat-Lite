import { Loader } from "three";
import type { Splats } from "../data/Splats.js";
import type { SplatMesh } from "../scene/SplatMesh.js";
import type { SplatDataLoadOptions } from "./loadSplatData.js";
import type { SplatProgressEvent } from "./loadTypes.js";
type SplatLoadOptions = Omit<SplatDataLoadOptions, "onLoad"> & {
  splats?: Splats;
  onLoad?: (decoded: Splats) => void;
};
export declare class SplatLoader extends Loader {
  private readonly requests;
  abort(): this;
  load(
    url: string,
    onLoad?: (decoded: Splats) => void,
    onProgress?: (event: SplatProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): void;
  loadAsync(
    url: string,
    onProgress?: (event: SplatProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<Splats>;
  parse(splats: Splats): SplatMesh;
  loadInternal(options: SplatLoadOptions): void;
  loadInternalAsync({
    splats,
    onLoad,
    ...options
  }: SplatLoadOptions): Promise<Splats>;
}
export {};
