import { LodTreeScheduler } from "../chunk-stream/LodTreeScheduler.js";

/** Streams LCC2 splat files while retaining complete parent/child coverage. */
export class Lcc2StreamScheduler extends LodTreeScheduler {
  constructor(options = {}) {
    super(options, "lcc2");
  }
}
