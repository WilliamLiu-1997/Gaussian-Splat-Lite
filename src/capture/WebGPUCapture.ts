import * as THREE from "three";
import { NodeMaterial, QuadMesh, type WebGPURenderer } from "three/webgpu";
import { usesNativeWebGPU } from "../rendering/rendererUtils";
import { N } from "../rendering/tsl/tslCompat";

/** Blend in working space, then convert to texture storage. */
export class WebGPUCapture {
  private readonly depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
  private readonly target = new THREE.RenderTarget(1, 1, {
    generateMipmaps: false,
    depthTexture: this.depthTexture,
  });
  private readonly material = new NodeMaterial();
  private readonly quad = new QuadMesh(this.material);
  private workingColorSpace = "";
  private outputColorSpace = "";
  private storageColorSpace = "";
  private toneMapping: THREE.ToneMapping | null = null;

  constructor(private readonly renderer: WebGPURenderer) {
    this.material.blending = THREE.NoBlending;
    this.material.toneMapped = false;
    this.material.depthNode = N.texture(this.depthTexture).load(
      N.ivec2(N.screenCoordinate.xy),
    ).r;
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const { renderer, target, material } = this;
    const output = renderer.getRenderTarget();
    if (!output) throw new Error("WebGPU capture requires a render target");
    const face = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    const workingColorSpace = THREE.ColorManagement.workingColorSpace;
    const native = usesNativeWebGPU(renderer);
    const depthFormat = output.stencilBuffer
      ? THREE.DepthStencilFormat
      : THREE.DepthFormat;
    let depthType: THREE.TextureDataType = THREE.FloatType;
    if (output.stencilBuffer) {
      const float = output.depthTexture
        ? output.depthTexture.type === THREE.FloatType
        : renderer.reversedDepthBuffer;
      // Float depth with stencil is an optional WebGPU feature.
      depthType =
        native && float && renderer.hasFeature("depth32float-stencil8")
          ? THREE.FloatType
          : THREE.UnsignedInt248Type;
    }
    // Keep float outputs unclamped; otherwise match the display's
    // intermediate precision when it needs an output pass.
    const type =
      output.texture.type === THREE.HalfFloatType ||
      output.texture.type === THREE.FloatType
        ? output.texture.type
        : renderer.outputColorSpace !== workingColorSpace ||
            renderer.toneMapping !== THREE.NoToneMapping
          ? renderer.getOutputBufferType()
          : THREE.UnsignedByteType;
    if (
      target.texture.type !== type ||
      target.depthBuffer !== output.depthBuffer ||
      target.stencilBuffer !== output.stencilBuffer ||
      this.depthTexture.type !== depthType ||
      this.depthTexture.format !== depthFormat ||
      target.samples !== output.samples
    ) {
      target.dispose();
      target.texture.type = type;
      this.depthTexture.type = depthType;
      this.depthTexture.format = depthFormat;
      target.depthBuffer = output.depthBuffer;
      target.stencilBuffer = output.stencilBuffer;
      target.depthTexture = output.depthBuffer ? this.depthTexture : null;
      // Antialias the scene here; the output only receives a full-screen quad.
      // Native WebGPU binds a multisampled depth texture as a different type.
      if (target.samples !== output.samples) material.needsUpdate = true;
      target.samples = output.samples;
    }
    target.setSize(output.width, output.height);

    // RGBA8 sRGB attachments encode linear fragment output in hardware.
    const storageColorSpace =
      output.texture.type === THREE.UnsignedByteType &&
      output.texture.colorSpace === THREE.SRGBColorSpace
        ? THREE.LinearSRGBColorSpace
        : output.texture.colorSpace || THREE.LinearSRGBColorSpace;
    if (
      this.workingColorSpace !== workingColorSpace ||
      this.outputColorSpace !== renderer.outputColorSpace ||
      this.storageColorSpace !== storageColorSpace ||
      this.toneMapping !== renderer.toneMapping
    ) {
      const color = N.texture(target.texture).load(
        N.ivec2(N.screenCoordinate.xy),
      );
      const outputColor = N.renderOutput(
        color,
        renderer.toneMapping,
        renderer.outputColorSpace,
      );
      material.fragmentNode = N.premultiplyAlpha(
        N.convertColorSpace(
          N.unpremultiplyAlpha(outputColor),
          renderer.outputColorSpace,
          storageColorSpace,
        ),
      );
      material.needsUpdate = true;
      this.workingColorSpace = workingColorSpace;
      this.outputColorSpace = renderer.outputColorSpace;
      this.storageColorSpace = storageColorSpace;
      this.toneMapping = renderer.toneMapping;
    }
    material.depthTest = output.depthBuffer;
    material.depthWrite = output.depthBuffer;
    material.depthFunc = renderer.reversedDepthBuffer
      ? THREE.NeverDepth
      : THREE.AlwaysDepth;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(output, face, mip);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(output, face, mip);
    }
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
