import type { Node } from "three/webgpu";
import type { GaussianSplatCompatibleRenderer } from "../rendererUtils.js";
import type {
  SplatEffectFrame,
  SplatEffectUniform,
  SplatShaderDefinition,
  SplatShaderEffect,
} from "./SplatShaderEffect.js";
export declare class EffectBinding {
  readonly definition: SplatShaderDefinition;
  readonly normals: boolean;
  readonly uniforms: Record<string, SplatEffectUniform>;
  readonly nodes: Record<string, Node>;
  constructor(
    effect: SplatShaderEffect,
    renderer: GaussianSplatCompatibleRenderer,
  );
  beforeRender(frame: SplatEffectFrame): void;
  dispose(): void;
}
