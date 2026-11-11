import { LodTreeScheduler } from "../chunk-stream/LodTreeScheduler.js";

/** Streams SOG ranges through a hierarchy of coarse-to-fine LOD nodes. */
export class SogStreamScheduler extends LodTreeScheduler {
  constructor(options = {}) {
    super(options, "sog");
  }
}
