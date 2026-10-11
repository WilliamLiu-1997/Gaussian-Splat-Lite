import type { Camera, Scene } from "three";
import type { Renderer } from "three/webgpu";
/** Four coverage decisions in one fragment, resolved by 4x MSAA. */
export declare class StochasticCoverage {
  private readonly materials;
  private readonly coverage;
  constructor();
  private material;
  render(renderer: Renderer, scene: Scene, camera: Camera): void;
  dispose(): void;
}
