import * as THREE from "three";
import {
  type LayeredBackend,
  LayeredOverdraw,
  type LayeredPass,
  STOP_TRANSMITTANCE,
  planBatchRanges,
  useUnderBlending,
} from "../LayeredOverdraw";
import { SplatGeometry } from "../SplatGeometry";
import type { Uniforms } from "../uniforms";
import {
  blitDepth,
  copyDepthChecked,
  depthCopyKey,
  drawFramebufferDepth,
} from "./LayeredDepth";
import { createWebGLSplatMaterial } from "./SplatMaterial";

type TextureProperties = { __webglTexture?: WebGLTexture };

/**
 * The framebuffer drawing the Splats. GL runs nested renders in call order,
 * so the pass needs no split; closing restores the eye's viewport and scissor.
 */
function currentWebGLPass(renderer: THREE.WebGLRenderer): LayeredPass | null {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const target = renderer.getRenderTarget() as
    | (THREE.WebGLRenderTarget & {
        isWebGL3DRenderTarget?: boolean;
        isWebGLArrayRenderTarget?: boolean;
      })
    | null;
  if (
    // XR output uses multiview or opaque framebuffers. Passes that render
    // eyes into their own targets remain supported.
    (renderer.xr.isPresenting && renderer.xr.enabled) ||
    renderer.getActiveMipmapLevel() !== 0 ||
    target?.isWebGL3DRenderTarget === true ||
    target?.isWebGLArrayRenderTarget === true ||
    // A per-pixel composite would blend across MSAA samples.
    (gl.getParameter(gl.SAMPLES) as number) > 0
  ) {
    return null;
  }
  const depth = drawFramebufferDepth(gl);
  if (depth === undefined) return null;
  const source = gl.getParameter(
    gl.DRAW_FRAMEBUFFER_BINDING,
  ) as WebGLFramebuffer | null;
  const width = target ? target.width : gl.drawingBufferWidth;
  const height = target ? target.height : gl.drawingBufferHeight;
  const viewport = renderer.getCurrentViewport(new THREE.Vector4());
  const scissorTest = gl.isEnabled(gl.SCISSOR_TEST);
  const scissor = new THREE.Vector4().fromArray(
    gl.getParameter(gl.SCISSOR_BOX) as Int32Array,
  );
  const { state } = renderer;
  return {
    width,
    height,
    viewport,
    scissor,
    depth,
    scaledViewports: false,
    open(depthTexture) {
      if (!depthTexture || !depth) return true;
      const texture = (
        renderer.properties.get(depthTexture) as TextureProperties
      ).__webglTexture;
      if (!texture) return false;
      return copyDepthChecked(gl, depthCopyKey(source, depth), () =>
        blitDepth(
          gl,
          source,
          texture,
          depth.format === THREE.DepthStencilFormat,
          width,
          height,
        ),
      );
    },
    close() {
      // Restoring the render target resets its full viewport; ArrayCamera
      // eyes draw into their own.
      state.viewport(viewport);
      state.scissor(scissor);
      state.setScissorTest(scissorTest);
    },
  };
}

function createStopMaterial(renderer: THREE.WebGLRenderer, uniforms: Uniforms) {
  const reversed = renderer.capabilities.reversedDepthBuffer;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { layers: uniforms.layers },
    vertexShader: /* glsl */ `
      void main() {
        // A constant clip depth keeps the write rasterized.
        gl_Position = vec4(position.xy, ${reversed ? "1.0" : "-1.0"}, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform highp sampler2D layers;
      out vec4 fragColor;
      void main() {
        if (texelFetch(layers, ivec2(gl_FragCoord.xy), 0).a > ${STOP_TRANSMITTANCE}) {
          discard;
        }
        fragColor = vec4(0.0);
      }`,
    blending: THREE.NoBlending,
    colorWrite: false,
    // GL writes depth only while testing it; Three inverts Always under
    // reversed depth.
    depthTest: true,
    depthFunc: reversed ? THREE.NeverDepth : THREE.AlwaysDepth,
    depthWrite: true,
  });
}

/** WebGL batches: CPU-sorted ranges read in reverse from the ordering texture. */
export function createWebGLLayers(
  renderer: THREE.WebGLRenderer,
  uniforms: Uniforms,
) {
  const { extensions } = renderer;
  const supported = extensions.has("EXT_color_buffer_float");
  // Float32 keeps the front-to-back tail that half floats round away.
  const colorType = extensions.has("EXT_float_blend")
    ? THREE.FloatType
    : THREE.HalfFloatType;
  const batchUniforms: Uniforms = {
    ...uniforms,
    batchFirst: { value: 0 },
    batchCount: { value: 0 },
  };
  const batchMaterial = createWebGLSplatMaterial(batchUniforms, {
    premultipliedAlpha: true,
    transparent: false,
    depthTest: true,
    depthWrite: false,
  });
  batchMaterial.defines.GSL_SORTED_FRAGMENT = 1;
  batchMaterial.defines.GSL_LAYERED_BATCH = 1;
  useUnderBlending(batchMaterial);
  const geometry = new SplatGeometry();
  const batchMesh = new THREE.Mesh(geometry, batchMaterial);
  batchMesh.frustumCulled = false;
  batchMesh.matrixAutoUpdate = false;
  // The Splat renderer's own draw already passed the layer test.
  batchMesh.layers.enableAll();
  const stopMaterial = createStopMaterial(renderer, uniforms);
  let ranges: [number, number][] = [];

  const backend: LayeredBackend = {
    colorType,
    batchMesh,
    stopMaterial,
    currentPass: () => (supported ? currentWebGLPass(renderer) : null),
    planBatches(_camera, count) {
      ranges = planBatchRanges(uniforms.splatCount.value as number, count);
      return ranges.flatMap(([, size], index) => (size > 0 ? [index] : []));
    },
    prepareBatch(index) {
      const [first, size] = ranges[index];
      batchUniforms.batchFirst.value = first;
      batchUniforms.batchCount.value = size;
      geometry.setSplatCount(size);
    },
    bindLayers(texture) {
      uniforms.layers.value = texture;
    },
  };
  const overdraw = new LayeredOverdraw(renderer, backend);
  return {
    overdraw,
    dispose() {
      overdraw.dispose();
      batchMaterial.dispose();
      stopMaterial.dispose();
      geometry.dispose();
    },
  };
}
