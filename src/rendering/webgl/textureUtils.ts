import type * as THREE from "three";

// "Identity" vertex shader that just passes through the position.
export const IDENT_VERTEX_SHADER = `
precision highp float;

in vec3 position;

void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function uploadU32DataTextureRows(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
  width: number,
  rows: number,
  data: Uint32Array,
) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const props = renderer.properties.get(texture) as {
    __webglTexture: WebGLTexture;
  };
  const glTexture = props?.__webglTexture;
  if (!glTexture) {
    throw new Error("texture not found");
  }

  // renderer.state.pixelStorei is only available in newer Three.js releases,
  // so preserve these WebGL flags explicitly across the direct texture upload.
  const currentFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const currentPremultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  renderer.state.activeTexture(gl.TEXTURE0);
  renderer.state.bindTexture(gl.TEXTURE_2D, glTexture);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    rows,
    gl.RGBA_INTEGER,
    gl.UNSIGNED_INT,
    data,
  );
  renderer.state.unbindTexture();
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, currentFlipY);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, currentPremultiply);
}
