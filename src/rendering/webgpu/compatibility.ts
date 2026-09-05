import type * as THREE from "three";
import { IntType, UnsignedIntType } from "three";

import {
  type GaussianSplatCompatibleRenderer,
  isWebGPURenderer,
} from "../rendererUtils";

type WebGPURenderer = import("three/webgpu").WebGPURenderer;

const patchedRenderers = new WeakSet<object>();
const patchedBuilders = new WeakSet<object>();

type WebGPUNodeBuilder = {
  buildCode(): void;
  computeShader: string | null;
  generateTextureStore(
    texture: THREE.Texture,
    textureProperty: string,
    uvIndexSnippet: string,
    depthSnippet: string | null,
    valueSnippet: string,
  ): string;
  getUniforms(shaderStage: string): string;
  uniforms: Record<
    string,
    Array<{ name: string; node: { value?: THREE.Texture } }>
  >;
};

type NodeBuilderCreatedHook = (
  builder: WebGPUNodeBuilder,
  renderObject: unknown,
) => void;

function getIntegerComponentType(texture: THREE.Texture) {
  if (texture.type === UnsignedIntType) return "u32";
  if (texture.type === IntType) return "i32";
  return null;
}

type PatchableWebGPURenderer = WebGPURenderer & {
  debug: {
    onNodeBuilderCreated: NodeBuilderCreatedHook | null;
  };
};

function patchNodeBuilder(builder: WebGPUNodeBuilder) {
  if (patchedBuilders.has(builder)) return;
  patchedBuilders.add(builder);

  const buildCode = builder.buildCode;
  builder.buildCode = function () {
    buildCode.call(this);
    if (this.computeShader?.includes("gslRadix")) {
      this.computeShader = this.computeShader.replace(
        /(var<workgroup>\s+gslRadix(?:Histogram|DigitMasks)\s*:\s*array<)\s*u32\s*,/g,
        "$1 atomic<u32>,",
      );
    }
  };

  const getUniforms = builder.getUniforms;
  builder.getUniforms = function (shaderStage: string) {
    let source = getUniforms.call(this, shaderStage);
    for (const uniform of this.uniforms[shaderStage] ?? []) {
      const texture = uniform.node.value;
      if (!texture) continue;
      const componentType = getIntegerComponentType(texture);
      if (!componentType) continue;
      source = source.replace(
        `var ${uniform.name} : texture_2d_array<f32>;`,
        `var ${uniform.name} : texture_2d_array<${componentType}>;`,
      );
    }
    return source;
  };

  const generateTextureStore = builder.generateTextureStore;
  builder.generateTextureStore = function (texture, ...snippets) {
    const componentType = getIntegerComponentType(texture);
    if (componentType) {
      snippets[3] = snippets[3].replace(
        /^vec4<f32>\s*\(/,
        `vec4<${componentType}>(`,
      );
    }
    return generateTextureStore.call(this, texture, ...snippets);
  };
}

/** Scoped WGSL workarounds for integer textures and atomic workgroup arrays. */
export function installWebGPUCompatibilityPatches(
  renderer: GaussianSplatCompatibleRenderer,
) {
  if (!isWebGPURenderer(renderer)) return;

  const webGPURenderer = renderer as PatchableWebGPURenderer;
  if (patchedRenderers.has(webGPURenderer)) return;

  const previous = webGPURenderer.debug.onNodeBuilderCreated;
  webGPURenderer.debug.onNodeBuilderCreated = (builder, renderObject) => {
    previous?.(builder, renderObject);
    patchNodeBuilder(builder);
  };

  patchedRenderers.add(webGPURenderer);
}
