/** A shader definition, or a factory for resources owned by one renderer. */
export class SplatShaderEffect {
  constructor(definition) {
    this.definition = definition;
  }

  create(renderer) {
    return typeof this.definition === "function"
      ? this.definition({ renderer })
      : this.definition;
  }
}
