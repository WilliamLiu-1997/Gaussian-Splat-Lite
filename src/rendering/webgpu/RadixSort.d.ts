import type { ComputeNode, Node, StorageBufferAttribute } from "three/webgpu";
/**
 * Key layout of one sort: full 32-bit or fast 24-bit back-to-front keys, or
 * 16-bit front-to-back keys for stochastic ordering.
 */
export type RadixSortMode = "full" | "fast" | "front";
/** Values of the GPU mode uniform. */
export declare const RADIX_SORT_MODE_IDS: {
  readonly full: 0;
  readonly fast: 1;
  readonly front: 2;
};
/**
 * Input key of an absent record. The first pass drops these records and
 * compacts the rest in input order, so the output order is deterministic.
 */
export declare const INVALID_SORT_KEY = 4294967295;
type BufferRef = {
  value: StorageBufferAttribute;
};
type WebGPURadixSortOptions = {
  /** GPU count of input keys other than INVALID_SORT_KEY. */
  count: Node<"uint">;
  /** RADIX_SORT_MODE_IDS value matching the input key encoding. */
  mode: Node<"uint">;
  maxComputeWorkgroupsPerDimension: number;
  maxStorageBufferBindingSize: number;
};
/**
 * Stable 16-, 24- or 32-bit radix sort. The first pass compacts records whose
 * key is not INVALID_SORT_KEY, with the values the caller wrote to
 * `inputValues`. Borrows and overwrites input keys; their owner manages storage.
 */
export declare class WebGPURadixSort {
  capacity: number;
  readonly maxCapacity: number;
  readonly nodes: ComputeNode[];
  private readonly elementCount;
  private readonly keys;
  private readonly values;
  private readonly blockSums;
  private readonly counts;
  private readonly sortDispatch;
  private readonly prefixLevels;
  private mode;
  private readonly maxWorkgroups;
  private readonly dispatchNodes;
  constructor(
    capacity: number,
    inputKeys: BufferRef,
    options: WebGPURadixSortOptions,
  );
  /** Values the caller writes for valid input records; sorting overwrites them. */
  get inputValues(): StorageBufferAttribute;
  get ordering(): StorageBufferAttribute;
  private validateCapacity;
  private paddedWorkgroups;
  private makeSetupTask;
  private replaceBuffer;
  private createPrefixLevels;
  resize(capacity: number, shrinkResources?: boolean): void;
  /**
   * Prepare the persistent graph for this many input records. The GPU count
   * of valid records is clamped to it.
   */
  prepare(elementCount: number, mode: RadixSortMode): ComputeNode[];
  dispose(): void;
}
