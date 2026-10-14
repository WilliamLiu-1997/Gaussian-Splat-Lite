import {
  ColorManagement,
  NoBlending,
  SRGBColorSpace,
  SRGBTransfer,
  ShaderMaterial,
} from "three";
import { FullScreenQuad, Pass } from "three/addons/postprocessing/Pass.js";
import { NeuralDenoiseNode } from "./NeuralDenoiseNode.js";

/** Experimental neural denoising for WebGLRenderer. Use with EffectComposer and OutputPass. */
export class NeuralDenoisePass extends Pass {
  constructor(scene, camera, mode = "quality", msaa = true) {
    super();
    // Capture, camera reprojection and reset are the same as on node renderers.
    this.denoise = new NeuralDenoiseNode(scene, camera, mode, msaa);
    // Like TAAPass, convert before blending/resolve. The network averages
    // display-referred samples, so MSAA must use that space too.
    Object.assign(this.denoise.source, { isXRRenderTarget: true });
    this.denoise.source.texture.colorSpace = SRGBColorSpace;
    this.copy = new ShaderMaterial({
      name: "NeuralDenoise.output",
      uniforms: {
        image: { value: null },
        encoded: { value: false },
        outputSRGB: { value: true },
      },
      vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`,
      fragmentShader: /* glsl */ `
uniform sampler2D image;
uniform bool encoded;
uniform bool outputSRGB;
varying vec2 vUv;
void main() {
  vec4 color = texture2D(image, vUv);
  if (encoded) {
    // OutputPass applies its transfer directly to premultiplied RGB. Invert
    // that transfer here, as TAAPass does, to round-trip transparent pixels.
    float scale = outputSRGB ? 1.0 : max(color.a, 1e-6);
    color.rgb = sRGBTransferEOTF(vec4(max(color.rgb / scale, 0.0), 1.0)).rgb * scale;
  }
  gl_FragColor = color;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.copy);
  }
  get scene() {
    return this.denoise.scene;
  }
  set scene(value) {
    this.denoise.scene = value;
  }
  get camera() {
    return this.denoise.camera;
  }
  set camera(value) {
    this.denoise.camera = value;
  }
  get mode() {
    return this.denoise.mode;
  }
  get msaa() {
    return this.denoise.msaa;
  }
  get stabilize() {
    return this.denoise.stabilize;
  }
  set stabilize(value) {
    this.denoise.stabilize = value;
  }
  get depthTexture() {
    return this.denoise.depthTexture;
  }
  get projectionMatrix() {
    return this.denoise.projectionMatrix;
  }
  setSize(width, height) {
    this.denoise.setSize(width, height);
  }
  reset() {
    this.denoise.reset();
  }
  render(renderer, writeBuffer) {
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    try {
      // The shared capture follows this physical size, even when the composer
      // has a different size from the canvas.
      renderer.setRenderTarget(writeBuffer);
      this.denoise.updateBefore({ renderer });
      this.copy.uniforms.image.value = this.denoise.textureNode.value;
      this.copy.uniforms.encoded.value = this.denoise.encoded.value;
      this.copy.uniforms.outputSRGB.value =
        ColorManagement.getTransfer(renderer.outputColorSpace) === SRGBTransfer;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(target, cubeFace, mipLevel);
    }
  }
  dispose() {
    this.denoise.dispose();
    this.copy.dispose();
    this.quad.dispose();
  }
}
