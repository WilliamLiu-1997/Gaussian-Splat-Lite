import { Object3D } from "three";
import { SplatEdit } from "./SplatEdit.js";

/** An ordered RGBA operation evaluated over Blind field selections. */
export class SplatEditBlind extends Object3D {
  constructor(options = {}) {
    super();
    this.rgbaBlendMode = options.rgbaBlendMode ?? "multiply_rgba";
    this.softEdge = options.softEdge ?? 0;
    this.invert = options.invert ?? false;
    this.fields = options.fields ?? null;
    this.ordering = SplatEdit.nextOrdering++;
    this.name = options.name ?? `Blind edit ${this.ordering}`;
  }

  addField(field) {
    this.fields ??= [];
    if (!this.fields.includes(field)) this.fields.push(field);
  }

  removeField(field) {
    if (this.fields) {
      this.fields = this.fields.filter((candidate) => candidate !== field);
    }
  }
}
