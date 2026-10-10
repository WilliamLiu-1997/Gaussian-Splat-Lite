import type { ComputeNode, StorageBufferNode } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
import type { ProjectionCache } from "./ProjectionCache.js";

/** Builds a projection graph from bindings owned by ProjectedSplats. */
export declare function createProjectionKernel({
  uniforms,
  eyeCount,
  keys,
  seeds,
  sortValues,
  counter,
  cache,
}: {
  uniforms: Uniforms;
  eyeCount: number;
  keys: StorageBufferNode<"uint">;
  seeds: StorageBufferNode<"uint">;
  sortValues: StorageBufferNode<"uint">;
  counter: StorageBufferNode<"uint">;
  cache: ProjectionCache;
}): ComputeNode;
