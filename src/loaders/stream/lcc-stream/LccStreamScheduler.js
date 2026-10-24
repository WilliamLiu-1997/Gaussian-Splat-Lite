import { SceneStreamScheduler } from "../scene-stream/SceneStreamScheduler.js";
import { readLccScene, selectLccUnits } from "./lccScene.js";
/** Native LCC Unit streaming. The group preserves the source coordinate basis. */
export class LccStreamScheduler extends SceneStreamScheduler {
  constructor(options) {
    super(options, {
      name: "lcc-stream",
      read: readLccScene,
      select: (units, budget, scores, shown) =>
        selectLccUnits(units, budget, scores, shown, options),
    });
  }
}
