import type { StreamView } from "../streamView.js";
import type { LccNodeTable } from "./lccIndex.js";
export type LccBudgetMode = "target" | "limit";
export type LccSelectionRequest = {
  view: StreamView;
  budget: number;
  splatBudgetMode: LccBudgetMode;
  lodBaseDistance: number;
  lodMultiplier: number;
};
/** Data bounds of a loaded node: center min/max XYZ and Gaussian extent min/max XYZ. */
export type LccBoundsUpdate = {
  node: number;
  centers: number[];
  extent: number[];
};
/**
 * Worker-side LOD cuts. Every node is judged by its own bounds: the nearest
 * view that sees it sets its distance, and only visible nodes refine.
 */
export declare class LccSelection {
  private readonly table;
  private readonly frusta;
  private readonly box;
  private readonly seen;
  private readonly heap;
  private generation;
  private readonly measured;
  private readonly visible;
  private readonly distance;
  private readonly state;
  private readonly childSplats;
  private readonly chainBounds;
  constructor(table: LccNodeTable);
  /** Memory retained for the table and selection scratch arrays. */
  get byteLength(): number;
  private measure;
  /**
   * Choose the cut within the budget. Coarse coverage of every root comes
   * first, visible roots nearest first. Refinements then proceed by distance
   * relative to their level's band; one that does not fit is skipped, so a
   * dense node cannot hold back the rest of the scene.
   */
  select(request: LccSelectionRequest): Uint32Array;
  /**
   * Tighten bounds from loaded data. An LCC Unit's levels cover the same
   * region, so its whole chain shares the union of its loaded levels; LCC2
   * nodes keep their manifest bounds and widen culling to the data's extent.
   */
  setBounds(updates: LccBoundsUpdate[]): void;
}
