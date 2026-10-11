/** GLSL functions, inputs and outputs of one denoiser fragment pass. */
export declare function neuralDenoiseGLSL(wgsl: string): {
  code: string;
  textures: { name: string; depth: boolean }[];
  params: boolean;
  members: string[];
  depth: boolean;
};
