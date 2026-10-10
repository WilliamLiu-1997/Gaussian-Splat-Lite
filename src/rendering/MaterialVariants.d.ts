import type * as THREE from "three";
/**
 * A backend's draw materials: sorted and stochastic, each plain or shaded.
 * A shaded variant is built when the backend's shading first selects it.
 */
export declare class MaterialVariants<
  Material extends THREE.Material,
  Shading,
> {
  private readonly create;
  private readonly materials;
  constructor(create: (stochastic: boolean, shading?: Shading) => Material);
  select(stochastic: boolean, shading?: Shading | null): Material;
  dispose(): void;
}
