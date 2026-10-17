import type { EffectBinding } from "./EffectBinding.js";
export declare function effectGLSL(effect?: EffectBinding | null): {
  vertexPars: string;
  vertex: string;
  fragmentPars: string;
  opacity: string;
  fragment: string;
};
