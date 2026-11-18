import {
  MIN_REP_WEIGHT,
  REPRESENTATIVES_PER_GROUP,
  SEED_CANDIDATE_BATCH,
  SEED_CANDIDATE_MULTIPLIER,
} from "../lod-config.js";
import { assignRemainingRows } from "./assignment.js";
import { buildCoverageIndex } from "./coverage-index.js";
import { prepareBhattacharyyaTerms } from "./metrics.js";
import { selectByNovelty } from "./novelty.js";

export function planRepresentatives(cloud, target, check, phase) {
  check();
  const n = cloud.length;
  const groupCount = Math.max(
    1,
    Math.floor(target / REPRESENTATIVES_PER_GROUP),
  );
  const { groupOffsets, groupIndices, groupsFor, nodes } = buildCoverageIndex(
    cloud,
    groupCount,
    check,
    phase?.("index"),
  );
  const candidateLimit =
    Math.ceil(
      ((n / groupCount) * SEED_CANDIDATE_MULTIPLIER) / SEED_CANDIDATE_BATCH,
    ) * SEED_CANDIDATE_BATCH;
  const weights = cloud.weight;
  for (let i = 0; i < n; i++) {
    const weight = weights[i];
    weights[i] = Number.isFinite(weight)
      ? Math.max(weight, MIN_REP_WEIGHT)
      : MIN_REP_WEIGHT;
  }
  const covarianceTerms = prepareBhattacharyyaTerms(cloud.covariance, n);
  const plan = selectByNovelty(
    cloud,
    target,
    covarianceTerms,
    groupsFor,
    groupOffsets,
    groupIndices,
    candidateLimit,
    check,
    phase?.("seeds", groupCount),
    phase?.("selection", Math.max(1, target - groupCount)),
  );
  assignRemainingRows(
    cloud,
    plan,
    covarianceTerms,
    groupsFor,
    nodes,
    groupOffsets,
    groupIndices,
    check,
    phase?.("assignment"),
  );
  return { selected: plan.selected, assignment: plan.assignment };
}
