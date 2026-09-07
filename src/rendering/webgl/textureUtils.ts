import * as THREE from "three";

// "Identity" vertex shader that just passes through the position.
export const IDENT_VERTEX_SHADER = `
precision highp float;

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Synchronous uploads share this CPU-only view; it has no GPU storage.
const uploadView = new THREE.DataTexture(
  null,
  1,
  1,
  THREE.RGBAIntegerFormat,
  THREE.UnsignedIntType,
);

export function uploadU32DataTextureRows(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  width: number,
  rows: number,
  data: Uint32Array,
) {
  if (rows <= 0) return;
  // Initialize before filling the shared view: onUpdate may trigger another upload.
  renderer.initTexture(texture);
  uploadView.image.data = data;
  uploadView.image.width = width;
  uploadView.image.height = rows;
  try {
    renderer.copyTextureToTexture(uploadView, texture);
  } finally {
    // Do not retain the sort buffer between uploads.
    uploadView.image.data = null;
  }
}
