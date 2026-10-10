/**
 * A backend's draw materials: sorted and stochastic, each plain or shaded.
 * A shaded variant is built when the backend's shading first selects it.
 */
export class MaterialVariants {
  constructor(create) {
    this.create = create;
    this.materials = [create(false), create(true)];
  }
  select(stochastic, shading) {
    const index = Number(stochastic) + (shading ? 2 : 0);
    this.materials[index] ??= this.create(stochastic, shading);
    return this.materials[index];
  }
  dispose() {
    for (const material of this.materials) material?.dispose();
  }
}
