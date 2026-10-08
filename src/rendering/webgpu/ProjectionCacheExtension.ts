import type { Node } from "three/webgpu";
import type { SplatMesh } from "../../scene/SplatMesh";
import type { SplatMapping } from "../SplatAccumulator";
import type { ProjectionExtension } from "../tsl/ProjectionProgram";
import type { UniformType } from "../tsl/shaderUtils";
import type { Uniforms } from "../uniforms";

export type ProjectionUniformBinding = <Type extends UniformType>(
  name: string,
  type: Type,
) => Node<Type>;

/** Optional records stored alongside native projections, one uvec4 per slot and eye. */
export type ProjectionCacheExtension<Extra = unknown> = {
  slotUniforms(): Uniforms;
  kernel(uniform: ProjectionUniformBinding): {
    begin(): void;
    projection: ProjectionExtension<Extra>;
    write(index: Node<"uint">, extra: Extra): void;
  };
  read(index: Node<"uint">): Node<"uvec4">;
  fit(): void;
  setSlot(uniforms: Uniforms, mesh: SplatMesh): void;
  appendInputs(inputs: unknown[], mapping: readonly SplatMapping[]): void;
};
