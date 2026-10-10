import type * as THREE from "three";
export declare const IDENT_VERTEX_SHADER =
  "\nprecision highp float;\n\nin vec3 position;\n\nvoid main() {\n  gl_Position = vec4(position.xy, 0.0, 1.0);\n}\n";
export declare function uploadU32DataTextureRows(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  width: number,
  rows: number,
  data: Uint32Array,
): void;
