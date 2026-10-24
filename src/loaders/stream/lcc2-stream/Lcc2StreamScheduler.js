import { SceneStreamScheduler } from "../scene-stream/SceneStreamScheduler.js";
import { readLcc2Scene, selectLcc2Units } from "./lcc2Scene.js";
/** LCC2 0.0.3 coarse-first, atomic branch-cut replacement streaming. */
export class Lcc2StreamScheduler extends SceneStreamScheduler {
  constructor(options) {
    super(options, {
      name: "lcc2-stream",
      read: readLcc2Scene,
      select: (units, budget, scores, shown) =>
        selectLcc2Units(units, budget, scores, shown, options),
    });
  }
}
