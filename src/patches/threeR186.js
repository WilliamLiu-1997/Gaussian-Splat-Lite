import { FloatType, REVISION } from "three";
import { TextureNode } from "three/webgpu";
const patchedRenderers = new WeakSet();
let textureNodesPatched = false;
function patchTextureNodes() {
  if (textureNodesPatched) return;
  const prototype = TextureNode.prototype;
  Object.defineProperties(prototype, {
    _mergeable: { value: true, writable: true, configurable: true },
    mergeable: {
      configurable: true,
      get() {
        return this.referenceNode
          ? this.referenceNode.mergeable
          : this._mergeable;
      },
      set(value) {
        if (this.referenceNode) this.referenceNode.mergeable = value;
        else this._mergeable = value;
      },
    },
  });
  prototype.getUniformHash = function (builder) {
    if (this.referenceNode && !this.referenceNode.mergeable) {
      return this.referenceNode.getHash(builder);
    }
    return this._mergeable ? this.value.uuid : this.getHash(builder);
  };
  textureNodesPatched = true;
}
function patchAttributeDisposal(attributes) {
  const listeners = new WeakMap();
  const update = attributes.update;
  const remove = attributes.delete;
  attributes.update = function (attribute, type) {
    update.call(this, attribute, type);
    if (attribute.isBufferAttribute && !listeners.has(attribute)) {
      const dispose = () => this.delete(attribute);
      listeners.set(attribute, dispose);
      attribute.addEventListener("dispose", dispose);
    }
  };
  attributes.delete = function (attribute) {
    const dispose = listeners.get(attribute);
    if (dispose) {
      attribute.removeEventListener("dispose", dispose);
      listeners.delete(attribute);
    }
    return remove.call(this, attribute);
  };
}
function patchDepthViews(backend) {
  const utils = backend.bindingUtils;
  const createBindGroup = utils.createBindGroup;
  utils.createBindGroup = function (group, layout) {
    for (const binding of group.bindings) {
      if (!binding.isSampledTexture || !binding.texture.isDepthTexture)
        continue;
      const data = backend.get(binding.texture);
      const texture = data.texture;
      const mipLevelCount = binding.store ? 1 : texture.mipLevelCount;
      const baseMipLevel = binding.store ? binding.mipLevel : 0;
      let key = `view-${texture.width}-${texture.height}`;
      if (texture.depthOrArrayLayers > 1)
        key += `-${texture.depthOrArrayLayers}`;
      key += `-${mipLevelCount}-${baseMipLevel}`;
      if (data[key] === undefined) {
        const dimension = binding.isSampledCubeTexture
          ? "cube"
          : binding.texture.isArrayTexture ||
              binding.texture.isDataArrayTexture ||
              binding.texture.isCompressedArrayTexture
            ? "2d-array"
            : binding.isSampledTexture3D
              ? "3d"
              : "2d";
        // Populate r186's cache before it creates an all-aspects depth view.
        data[key] = texture.createView({
          aspect: "depth-only",
          dimension,
          mipLevelCount,
          baseMipLevel,
        });
      }
    }
    return createBindGroup.call(this, group, layout);
  };
}
function patchDefaultDepth(renderer, textures) {
  const updateTexture = textures.updateTexture;
  textures.updateTexture = function (texture, options) {
    const target = texture.renderTarget;
    if (
      renderer.reversedDepthBuffer &&
      texture.isDepthTexture &&
      target &&
      target.depthTexture !== texture &&
      texture.type !== FloatType
    ) {
      texture.type = FloatType;
      texture.needsUpdate = true;
    }
    return updateTexture.call(this, texture, options);
  };
}
function patchWebGL(renderer, backend) {
  const { gl, textureUtils, state } = backend;
  const getInternalFormat = textureUtils.getInternalFormat;
  textureUtils.getInternalFormat = function (...args) {
    const format = getInternalFormat.apply(this, args);
    return args[1] === gl.DEPTH_STENCIL &&
      args[2] === gl.FLOAT &&
      format === gl.DEPTH_STENCIL
      ? gl.DEPTH32F_STENCIL8
      : format;
  };
  textureUtils.setupRenderBufferStorage = function (
    renderbuffer,
    context,
    samples,
    useMultisampledRTT = false,
  ) {
    const { depthTexture, renderTarget } = context;
    const { depthBuffer, stencilBuffer, width, height } = renderTarget;
    const floatDepth = depthTexture?.type === FloatType;
    const format = stencilBuffer
      ? floatDepth
        ? gl.DEPTH32F_STENCIL8
        : gl.DEPTH24_STENCIL8
      : floatDepth
        ? gl.DEPTH_COMPONENT32F
        : gl.DEPTH_COMPONENT24;
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    if (depthBuffer) {
      if (useMultisampledRTT && !stencilBuffer) {
        this.extensions
          .get("WEBGL_multisampled_render_to_texture")
          .renderbufferStorageMultisampleEXT(
            gl.RENDERBUFFER,
            renderTarget.samples,
            format,
            width,
            height,
          );
      } else if (samples > 0) {
        gl.renderbufferStorageMultisample(
          gl.RENDERBUFFER,
          samples,
          format,
          width,
          height,
        );
      } else {
        gl.renderbufferStorage(gl.RENDERBUFFER, format, width, height);
      }
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        stencilBuffer ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        renderbuffer,
      );
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  };
  // New FBOs already draw to COLOR_ATTACHMENT0, including opaque XR FBOs.
  state.drawBuffers = function (context, framebuffer) {
    let buffers;
    let changed = false;
    if (context.textures !== null) {
      const cached = this.currentDrawbuffers.get(framebuffer);
      buffers = cached ?? [gl.COLOR_ATTACHMENT0];
      if (cached === undefined)
        this.currentDrawbuffers.set(framebuffer, buffers);
      const count = context.textures.length;
      if (buffers.length !== count) {
        for (let i = 0; i < count; i++) buffers[i] = gl.COLOR_ATTACHMENT0 + i;
        buffers.length = count;
        changed = true;
      }
    } else {
      buffers = [gl.BACK];
      changed = true;
    }
    if (changed) gl.drawBuffers(buffers);
  };
  // r186 chooses a 2D attachment when a layered render target has one layer.
  const layeredTextures = new WeakSet();
  const createTexture = textureUtils.createTexture;
  textureUtils.createTexture = function (texture, options) {
    createTexture.call(this, texture, options);
    const data = backend.get(texture);
    if (
      data.glTextureType === gl.TEXTURE_2D_ARRAY ||
      data.glTextureType === gl.TEXTURE_3D
    ) {
      layeredTextures.add(data.textureGPU);
    }
  };
  const framebufferTexture2D = gl.framebufferTexture2D;
  gl.framebufferTexture2D = (
    target,
    attachment,
    textureTarget,
    texture,
    level,
  ) => {
    if (
      textureTarget === gl.TEXTURE_2D &&
      texture !== null &&
      layeredTextures.has(texture)
    ) {
      gl.framebufferTextureLayer(
        target,
        attachment,
        texture,
        level,
        renderer._activeCubeFace,
      );
    } else {
      framebufferTexture2D.call(
        gl,
        target,
        attachment,
        textureTarget,
        texture,
        level,
      );
    }
  };
  const dispose = backend.dispose;
  backend.dispose = function () {
    gl.framebufferTexture2D = framebufferTexture2D;
    return dispose.call(this);
  };
}
function patchReadback(backend) {
  const utils = backend.textureUtils;
  const { GPUBufferUsage, GPUMapMode } = globalThis;
  utils.copyTextureToBuffer = async function (
    texture,
    x,
    y,
    width,
    height,
    faceIndex,
  ) {
    const { device } = backend;
    const data = backend.get(texture);
    const format = data.textureDescriptorGPU.format;
    const rowBytes = width * this._getBytesPerTexel(format);
    const stride = Math.ceil(rowBytes / 256) * 256;
    const buffer = device.createBuffer({
      size: height * stride,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: data.texture, origin: { x, y, z: faceIndex } },
        { buffer, bytesPerRow: stride },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = buffer.getMappedRange();
      let result;
      if (rowBytes === stride) {
        result = mapped.slice();
      } else {
        const padded = new Uint8Array(mapped);
        const packed = new Uint8Array(rowBytes * height);
        for (let row = 0; row < height; row++) {
          const offset = row * stride;
          packed.set(
            padded.subarray(offset, offset + rowBytes),
            row * rowBytes,
          );
        }
        result = packed.buffer;
      }
      const TypedArray = this._getTypedArrayType(format);
      return new TypedArray(result);
    } finally {
      buffer.destroy();
    }
  };
}
/** Apply r186 compatibility fixes to an initialized renderer once. */
export function applyThreeR186Patch(renderer) {
  if (REVISION !== "186" || patchedRenderers.has(renderer)) return;
  if (!renderer._attributes) {
    throw new Error(
      "Initialize the renderer before applying the Three.js r186 patch",
    );
  }
  patchTextureNodes();
  patchAttributeDisposal(renderer._attributes);
  patchDefaultDepth(renderer, renderer._textures);
  if (renderer.backend.isWebGLBackend) {
    patchWebGL(renderer, renderer.backend);
  } else {
    patchDepthViews(renderer.backend);
    patchReadback(renderer.backend);
  }
  patchedRenderers.add(renderer);
}
