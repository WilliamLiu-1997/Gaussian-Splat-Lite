import type { Node } from "three/webgpu";
import type { SplatEffectContext } from "../../rendering/shader/SplatShaderEffect.js";
import type { LightData } from "./LightData.js";
export declare function createRelightShader(
  data: LightData,
): (context: SplatEffectContext) => Node<"vec3">;
