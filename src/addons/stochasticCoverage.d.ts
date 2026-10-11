import type { Camera, Scene, WebGLRenderer } from "three";
import type { Renderer } from "three/webgpu";
/** Four coverage decisions in one fragment, resolved by 4x MSAA. */
export declare class StochasticCoverage {
  private readonly materials;
  constructor();
  private material;
  render(
    renderer: Renderer | WebGLRenderer,
    scene: Scene,
    camera: Camera,
  ): void;
  dispose(): void;
}
