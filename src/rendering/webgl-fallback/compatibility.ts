import type * as THREE from "three";
import { IntType, UnsignedIntType } from "three";
import type { WebGPURenderer } from "three/webgpu";

type GLSLNodeBuilder = {
  getUniforms(stage: string): string;
  getBitcastMethod(type: string, inputType: string): string;
  getComponentType(type: string): string;
  uniforms: Record<
    string,
    Array<{ name: string; node: { value?: THREE.Texture } }>
  >;
};

type BuilderHook = (builder: GLSLNodeBuilder, renderObject: unknown) => void;
const patchedRenderers = new WeakSet<WebGPURenderer>();
const patchedBuilders = new WeakSet<GLSLNodeBuilder>();

/** Scoped fixes for the pinned Three.js build's integer arrays and bitcasts. */
export function installWebGLFallbackCompatibilityPatches(
  renderer: WebGPURenderer,
) {
  if (
    (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend !== true
  )
    return;
  if (patchedRenderers.has(renderer)) return;
  patchedRenderers.add(renderer);
  const debug = renderer.debug as unknown as {
    onNodeBuilderCreated: BuilderHook | null;
  };
  const previous = debug.onNodeBuilderCreated;
  debug.onNodeBuilderCreated = (builder, object) => {
    previous?.(builder, object);
    if (patchedBuilders.has(builder)) return;
    patchedBuilders.add(builder);

    const getUniforms = builder.getUniforms;
    builder.getUniforms = function (stage) {
      let source = getUniforms.call(this, stage);
      for (const { name, node } of this.uniforms[stage] ?? []) {
        const type = node.value?.type;
        const prefix =
          type === UnsignedIntType ? "u" : type === IntType ? "i" : "";
        if (prefix)
          source = source.replace(
            `uniform sampler2DArray ${name};`,
            `uniform ${prefix}sampler2DArray ${name};`,
          );
      }
      return source;
    };

    const getBitcastMethod = builder.getBitcastMethod;
    builder.getBitcastMethod = function (type, inputType) {
      return getBitcastMethod.call(
        this,
        this.getComponentType(type),
        this.getComponentType(inputType),
      );
    };
  };
}
