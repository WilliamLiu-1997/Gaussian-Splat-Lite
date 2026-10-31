import type { Node } from "three/webgpu";
import type { SplatProjection } from "./ProjectionProgram.js";
import type { ProjectedVertexData } from "./SplatMaterial.js";
/** Shared 32-byte record: geometry followed by ready-to-draw fragment data. */
export declare function packProjection(
  projection: SplatProjection,
  ndc: Node<"vec2">,
  pixelScale: Node<"vec2">,
  centerRange: Node<"float">,
): { first: Node<"uvec4">; second: Node<"uvec4"> };
/** Decode a projected record and expand the current geometry corner. */
export declare function unpackProjection(
  first: Node<"uvec4">,
  second: Node<"uvec4">,
  pixelScale: Node<"vec2">,
  centerRange: Node<"float">,
  jitter: Node<"vec2">,
  matrix: Node<"mat4">,
): Omit<ProjectedVertexData, "viewportOrigin">;
