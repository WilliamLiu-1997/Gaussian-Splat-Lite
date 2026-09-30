import * as THREE from "three";
import type { DepthDescriptor } from "../LayeredOverdraw";

// Framebuffer blits require identical depth formats. Attachments of a given
// framebuffer object, and of the default framebuffer, do not change.
const formats = new WeakMap<object, DepthDescriptor | null | undefined>();
const verified = new WeakMap<WebGL2RenderingContext, Map<string, boolean>>();

/**
 * Depth texture format matching the bound draw framebuffer's depth: null
 * without depth, undefined when no Three.js depth texture matches it or its
 * copy failed.
 */
export function drawFramebufferDepth(
  gl: WebGL2RenderingContext,
): DepthDescriptor | null | undefined {
  const framebuffer = gl.getParameter(
    gl.DRAW_FRAMEBUFFER_BINDING,
  ) as WebGLFramebuffer | null;
  const key: object = framebuffer ?? gl;
  if (!formats.has(key)) formats.set(key, queryDepth(gl, framebuffer));
  const depth = formats.get(key);
  if (!depth) return depth;
  const failed = (candidate: DepthDescriptor) =>
    verified.get(gl)?.get(depthCopyKey(framebuffer, candidate)) === false;
  if (!failed(depth)) return depth;
  // Default framebuffers may pack stencil with depth even when none was
  // requested; blits then need the packed format.
  if (
    framebuffer === null &&
    depth.format === THREE.DepthFormat &&
    depth.type === THREE.UnsignedIntType
  ) {
    const packed = {
      format: THREE.DepthStencilFormat,
      type: THREE.UnsignedInt248Type,
    };
    if (!failed(packed)) return packed;
  }
  return undefined;
}

export function depthCopyKey(
  source: WebGLFramebuffer | null,
  depth: DepthDescriptor,
) {
  return `${source ? "target" : "canvas"}:${depth.format}:${depth.type}`;
}

function queryDepth(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer | null,
): DepthDescriptor | null | undefined {
  const target = gl.DRAW_FRAMEBUFFER;
  const depthAttachment = framebuffer ? gl.DEPTH_ATTACHMENT : gl.DEPTH;
  const stencilAttachment = framebuffer ? gl.STENCIL_ATTACHMENT : gl.STENCIL;
  const parameter = (attachment: number, name: number) =>
    gl.getFramebufferAttachmentParameter(target, attachment, name) as number;
  const objectType = gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE;
  if (parameter(depthAttachment, objectType) === gl.NONE) return null;
  const bits = parameter(depthAttachment, gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE);
  const float =
    parameter(depthAttachment, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) ===
    gl.FLOAT;
  const stencil =
    parameter(stencilAttachment, objectType) !== gl.NONE &&
    parameter(stencilAttachment, gl.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE) > 0;
  if (stencil) {
    if (bits === 24 && !float) {
      return {
        format: THREE.DepthStencilFormat,
        type: THREE.UnsignedInt248Type,
      };
    }
    if (bits === 32 && float) {
      return { format: THREE.DepthStencilFormat, type: THREE.FloatType };
    }
    return undefined;
  }
  if (bits === 16 && !float) {
    return { format: THREE.DepthFormat, type: THREE.UnsignedShortType };
  }
  if (bits === 24 && !float) {
    return { format: THREE.DepthFormat, type: THREE.UnsignedIntType };
  }
  if (bits === 32 && float) {
    return { format: THREE.DepthFormat, type: THREE.FloatType };
  }
  return undefined;
}

/**
 * Runs a depth copy, checking GL errors only on its first use for `key`.
 * Returns false once a copy with that key has failed.
 */
export function copyDepthChecked(
  gl: WebGL2RenderingContext,
  key: string,
  copy: () => void,
) {
  let results = verified.get(gl);
  if (!results) {
    results = new Map();
    verified.set(gl, results);
  }
  const known = results.get(key);
  if (known === false) return false;
  if (known === undefined) {
    // Clear unrelated pending errors before attributing one to the copy.
    for (let i = 0; i < 16 && gl.getError() !== gl.NO_ERROR; i++);
  }
  copy();
  if (known === undefined) {
    const ok = gl.getError() === gl.NO_ERROR;
    results.set(key, ok);
    return ok;
  }
  return true;
}

/**
 * Copies the depth of `source` into a depth texture with a matching format.
 * Binds framebuffers explicitly and restores the exact GL bindings after:
 * Three's caches may not match the READ framebuffer GL actually has bound.
 */
export function blitDepth(
  gl: WebGL2RenderingContext,
  source: WebGLFramebuffer | null,
  texture: WebGLTexture,
  stencil: boolean,
  width: number,
  height: number,
) {
  const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  const scissor = gl.isEnabled(gl.SCISSOR_TEST);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.DRAW_FRAMEBUFFER,
    stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT,
    gl.TEXTURE_2D,
    texture,
    0,
  );
  // Blits honor only the scissor among fragment operations.
  if (scissor) gl.disable(gl.SCISSOR_TEST);
  gl.blitFramebuffer(
    0,
    0,
    width,
    height,
    0,
    0,
    width,
    height,
    gl.DEPTH_BUFFER_BIT,
    gl.NEAREST,
  );
  if (scissor) gl.enable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
  gl.deleteFramebuffer(framebuffer);
}
