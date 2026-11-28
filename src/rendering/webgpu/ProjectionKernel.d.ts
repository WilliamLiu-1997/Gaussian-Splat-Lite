import type { ComputeNode, StorageBufferNode } from "three/webgpu";
import type { SplatModifier } from "../SplatModifier.js";
import type { Uniforms } from "../uniforms.js";
import type { ProjectionCache } from "./ProjectionCache.js";

/** Builds a projection graph from bindings owned by ProjectedSplats. */
export declare function createProjectionKernel({
  uniforms,
  eyeCount,
  workModifier,
  renderModifier,
  keys,
  seeds,
  sortValues,
  counter,
  cache,
}: {
  uniforms: Uniforms;
  eyeCount: number;
  workModifier?: SplatModifier | null;
  renderModifier?: SplatModifier | null;
  keys: StorageBufferNode<"uint">;
  seeds: StorageBufferNode<"uint">;
  sortValues: StorageBufferNode<"uint">;
  counter: StorageBufferNode<"uint">;
  cache: ProjectionCache;
}): ComputeNode;
