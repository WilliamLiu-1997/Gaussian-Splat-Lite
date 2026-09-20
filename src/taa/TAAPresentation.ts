import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
  setRendererRenderTarget,
} from "../rendering/rendererUtils";
import { N, load2D } from "../rendering/tsl/shaderUtils";

type TAAOutputView = {
  rect: THREE.Vector4;
  pipeline: { readonly color: THREE.Texture; depth: THREE.DepthTexture };
};

/** Write each view to its viewport/layer, including current scene depth. */
export function createTAAPresentation(
  renderer: GaussianSplatCompatibleRenderer,
  views: TAAOutputView[],
) {
  const webGPU = isWebGPURenderer(renderer);
  const uniforms = {
    color: { value: views[0].pipeline.color },
    depth: { value: views[0].pipeline.depth },
    origin: { value: new THREE.Vector2() },
  };
  const material = webGPU
    ? new NodeMaterial()
    : new THREE.ShaderMaterial({
        uniforms,
        glslVersion: THREE.GLSL3,
        vertexShader: "void main() { gl_Position = vec4(position, 1.0); }",
        fragmentShader: `
          precision highp float;
          uniform sampler2D color;
          uniform sampler2D depth;
          uniform vec2 origin;
          out vec4 fragColor;
          void main() {
            ivec2 pixel = ivec2(gl_FragCoord.xy - origin);
            fragColor = texelFetch(color, pixel, 0);
            gl_FragDepth = texelFetch(depth, pixel, 0).r;
          }`,
      });
  let configureOutput = (_tone: THREE.ToneMapping, _space: string) => {};
  if (material instanceof NodeMaterial) {
    const coord = N.ivec2(
      N.screenCoordinate.xy.sub(N.uniform(uniforms.origin.value)),
    );
    const color = N.textureLoad(uniforms.color.value).onObjectUpdate(
      () => uniforms.color.value,
    );
    const depth = N.textureLoad(uniforms.depth.value).onObjectUpdate(
      () => uniforms.depth.value,
    );
    material.fragmentNode = load2D(color, coord);
    material.depthNode = load2D(depth, coord).r;
    material.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
    const output = N.renderOutput(
      N.output,
      THREE.NoToneMapping,
      THREE.NoColorSpace,
    ) as ReturnType<typeof N.renderOutput> & {
      getToneMapping(): THREE.ToneMapping;
      setToneMapping(value: THREE.ToneMapping): void;
      outputColorSpace: string;
    };
    material.outputNode = output;
    configureOutput = (tone, space) => {
      if (
        output.getToneMapping() !== tone ||
        output.outputColorSpace !== space
      ) {
        output.setToneMapping(tone);
        output.outputColorSpace = space;
        material.needsUpdate = true;
      }
    };
  }
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  const reversed = webGPU
    ? renderer.reversedDepthBuffer
    : renderer.capabilities.reversedDepthBuffer;
  material.depthFunc = reversed ? THREE.NeverDepth : THREE.AlwaysDepth;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const viewport = new THREE.Vector4();
  const canvasViewport = new THREE.Vector4();
  return {
    render(target: THREE.RenderTarget | null, outputEncoded: boolean) {
      const copyDepth = !!target?.depthBuffer;
      if (material.depthWrite !== copyDepth) material.needsUpdate = true;
      material.depthWrite = material.depthTest = copyDepth;
      if (webGPU) {
        configureOutput(
          outputEncoded ? renderer.toneMapping : THREE.NoToneMapping,
          outputEncoded ? renderer.outputColorSpace : THREE.NoColorSpace,
        );
        if (outputEncoded) {
          renderer.toneMapping = THREE.NoToneMapping;
          renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
        }
      }
      if (target) viewport.copy(target.viewport);
      else renderer.getViewport(viewport);
      const layered = target !== null && target.depth > 1;
      renderer.autoClear = false;
      try {
        for (const [index, view] of views.entries()) {
          uniforms.color.value = view.pipeline.color;
          uniforms.depth.value = view.pipeline.depth;
          uniforms.origin.value.set(view.rect.x, view.rect.y);
          if (!webGPU)
            (material as THREE.ShaderMaterial).uniformsNeedUpdate = true;
          if (target) target.viewport.copy(view.rect);
          else
            renderer.setViewport(
              canvasViewport
                .copy(view.rect)
                .divideScalar(renderer.getPixelRatio()),
            );
          // A single-camera draw avoids Three's cached ArrayCamera depth-layer
          // descriptors surviving a swapchain resize or target replacement.
          setRendererRenderTarget(renderer, target, layered ? index : 0);
          renderer.render(mesh, camera);
        }
      } finally {
        if (target) target.viewport.copy(viewport);
        else renderer.setViewport(viewport);
      }
    },
    dispose() {
      material.dispose();
      geometry.dispose();
    },
  };
}
