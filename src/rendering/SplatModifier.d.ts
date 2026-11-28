import type { Vector3 } from "three";
import type { Node } from "three/webgpu";
import type { Uniforms } from "./uniforms.js";

export type SplatModifierUniforms = Record<
  string,
  | { type: "worldPosition"; value: Vector3 }
  | {
      type:
        | "float"
        | "int"
        | "uint"
        | "bool"
        | "vec2"
        | "vec3"
        | "vec4"
        | "mat3"
        | "mat4";
      value: unknown;
    }
>;
export interface SplatModifierOptions<
  U extends SplatModifierUniforms = SplatModifierUniforms,
> {
  uniforms?: U;
  /** Request originalCenter and seed in a global modifier. Inferred for GLSL, enabled by default for TSL. */
  sourceData?: boolean;
  glsl?: string;
  wgsl?: string;
  tsl?: (
    splat: {
      center: Node<"vec3">;
      originalCenter: Node<"vec3">;
      centerHigh: Node<"vec3">;
      centerLow: Node<"vec3">;
      originalCenterHigh: Node<"vec3">;
      originalCenterLow: Node<"vec3">;
      scale: Node<"vec3">;
      rotation: Node<"vec4">;
      color: Node<"vec4">;
      seed: Node<"uint">;
    },
    uniforms: {
      [K in keyof U as U[K]["type"] extends "worldPosition"
        ? `${K & string}High` | `${K & string}Low`
        : K]: Node<
        U[K]["type"] extends "worldPosition"
          ? "vec3"
          : Exclude<U[K]["type"], "worldPosition">
      >;
    },
  ) => void;
}
export declare class SplatModifier {
  constructor(options: SplatModifierOptions, onChange: () => void);
  readonly version: number;
  /** @internal */ needsSourceData(nodeBackend: boolean): boolean;
  setUniform(name: string, value: unknown): void;
  /** @internal */ resource<T extends { dispose(): void }>(
    key: string,
    create: () => T,
  ): T;
  /** @internal */ dispose(): void;
}
export declare function glslModifier(
  shader: string,
  binding: SplatModifier | null,
  stage: string,
  uniforms: Uniforms,
): string;
export declare function nodeModifier(
  binding: SplatModifier | null,
  stage: string,
  language: "glsl" | "wgsl",
  uniforms: Uniforms,
):
  | ((
      record: {
        center: Node<"vec3">;
        lnScales: Node<"vec3">;
        quaternion: Node<"vec4">;
        rgba: Node<"vec4">;
      },
      originalCenter: Node<"vec3">,
      seed: Node<"uint">,
    ) => void)
  | null;
