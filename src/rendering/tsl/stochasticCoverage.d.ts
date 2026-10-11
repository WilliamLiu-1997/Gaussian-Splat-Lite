import type { Node } from "three/webgpu";

/** Matches the four stratified coverage decisions in splatFragment.glsl. */
export declare function stochasticCoverage(
  alpha: Node<"float">,
  random: Node<"float">,
): void;
