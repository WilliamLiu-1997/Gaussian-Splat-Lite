import * as THREE from "three";

/** Blend in output space like the canvas, then convert to texture storage. */
export class WebGLCapture {
  private readonly depthTexture = new THREE.DepthTexture(
    1,
    1,
    THREE.UnsignedIntType,
  );
  private readonly target = Object.assign(
    new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      internalFormat: "RGBA8",
      generateMipmaps: false,
      depthTexture: this.depthTexture,
    }),
    // Output/XR semantics enable per-material display conversion before blending.
    // Plain RGBA8 stores those output-space values without an sRGB attachment.
    { isXRRenderTarget: true },
  );
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material = new THREE.ShaderMaterial({
    uniforms: {
      colorBuffer: { value: this.target.texture },
      depthBuffer: { value: this.target.depthTexture },
      decodeSRGB: { value: true },
      encodeSRGB: { value: false },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D colorBuffer;
      uniform sampler2D depthBuffer;
      uniform bool decodeSRGB;
      uniform bool encodeSRGB;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(colorBuffer, vUv);
        color.rgb = color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
        if (decodeSRGB) color = sRGBTransferEOTF(color);
        if (encodeSRGB) color = sRGBTransferOETF(color);
        color.rgb *= color.a;
        gl_FragColor = color;
        gl_FragDepth = texture2D(depthBuffer, vUv).r;
      }
    `,
    blending: THREE.NoBlending,
    depthFunc: THREE.AlwaysDepth,
    toneMapped: false,
  });
  private readonly quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    this.material,
  );

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.quad.frustumCulled = false;
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const { renderer, target, material } = this;
    const output = renderer.getRenderTarget();
    if (!output) throw new Error("WebGL capture requires a render target");
    const face = renderer.getActiveCubeFace();
    const mip = renderer.getActiveMipmapLevel();
    // Keep float outputs unclamped; other types blend in 8 bits like the canvas.
    const type =
      output.texture.type === THREE.HalfFloatType ||
      output.texture.type === THREE.FloatType
        ? output.texture.type
        : THREE.UnsignedByteType;
    if (
      target.texture.type !== type ||
      target.depthBuffer !== output.depthBuffer ||
      target.stencilBuffer !== output.stencilBuffer ||
      target.samples !== output.samples
    ) {
      target.dispose();
      target.texture.type = type;
      // An sRGB 8-bit target would otherwise allocate as SRGB8_ALPHA8 and
      // blend in linear space.
      target.texture.internalFormat =
        type === THREE.UnsignedByteType ? "RGBA8" : null;
      target.depthBuffer = output.depthBuffer;
      target.stencilBuffer = output.stencilBuffer;
      this.depthTexture.format = output.stencilBuffer
        ? THREE.DepthStencilFormat
        : THREE.DepthFormat;
      this.depthTexture.type = output.stencilBuffer
        ? THREE.UnsignedInt248Type
        : THREE.UnsignedIntType;
      // Antialias the scene here; the output only receives a full-screen quad.
      target.samples = output.samples;
    }
    target.setSize(output.width, output.height);
    target.texture.colorSpace = renderer.outputColorSpace;
    material.uniforms.decodeSRGB.value =
      target.texture.colorSpace === THREE.SRGBColorSpace;
    material.uniforms.encodeSRGB.value =
      output.texture.colorSpace === THREE.SRGBColorSpace &&
      output.texture.type !== THREE.UnsignedByteType;
    material.depthTest = output.depthBuffer;
    material.depthWrite = output.depthBuffer;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(output, face, mip);
      // Three also reverses AlwaysDepth/NeverDepth when reversing depth. Read
      // its live state: resetState() clears it while the capability stays set.
      material.depthFunc = renderer.state.buffers.depth.getReversed()
        ? THREE.NeverDepth
        : THREE.AlwaysDepth;
      renderer.render(this.quad, this.camera);
    } finally {
      renderer.setRenderTarget(output, face, mip);
    }
  }

  dispose() {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}
