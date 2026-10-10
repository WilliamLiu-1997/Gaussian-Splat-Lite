import type * as THREE from "three";
import type { Node } from "three/webgpu";
import type { Uniforms } from "../uniforms.js";
import type { ProjectionView } from "./ProjectionProgram.js";
/** Eye of the current WebXR draw; multiview draws both eyes at once. */
export declare function viewIndex(camera: THREE.Camera): Node<"uint">;
/** A per-layout projection array also supports changing WebXR eye counts. */
export declare function splatProjectionMatrix(
  camera: THREE.Camera,
): Node<"mat4">;
/** Viewport data for drawing splats that have already been projected. */
export declare function splatViewportUniforms(
  uniforms: Uniforms,
  camera: THREE.Camera,
): {
  renderSize: Node<"vec2">;
  viewportOrigin: Node<"vec2">;
};
export declare function splatViewUniforms(
  uniforms: Uniforms,
  camera: THREE.Camera,
): ProjectionView & {
  viewportOrigin: Node<"vec2">;
};
