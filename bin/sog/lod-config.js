// Available memory and SH dimensions also limit the working block size.
export const MAX_BLOCK_SPLATS = 1024 * 256;
export const BLOCK_MEMORY_SHARE = 0.4;
export const REPRESENTATIVES_PER_GROUP = 24; // KD leaf count = max(1, floor(target / REPRESENTATIVES_PER_GROUP)).
export const KD_BINS_PER_AXIS = 256; // Bins per axis for KD splits, including output region splits.

// Multiply the mean input group size by this factor, then round up to a multiple of the batch size.
export const SEED_CANDIDATE_MULTIPLIER = 64;
export const SEED_CANDIDATE_BATCH = 8;

// Novelty = 1 - similarity^(1 / NOVELTY_ROOT). Use 2 for a square root or 3 for a cube root.
export const NOVELTY_ROOT = 1;
export const FEATURE_SIZE_SCALE = 2; // featureSize = FEATURE_SIZE_SCALE * maxScale * max(1, opacityWeight).
export const SEARCH_RADIUS_FEATURES = 4; // Initial search radius for selection and assignment, in units of featureSize.
export const DIRECT_SCAN_LIMIT = 16; // Scan up to this many new representatives directly. Use the KD tree above this limit.

// The aspect exponent affects the radius used to break ties.
export const RADIUS_ASPECT_EXPONENT = 0.5;
export const MIN_REP_WEIGHT = 1e-12;
export const SEED_TIE_EPSILON = 1e-12;

// Covariance regularization and similarity pruning. The variance bound and score margin must cover rounding error.
export const RELATIVE_VARIANCE_FLOOR = 1e-6;
export const VARIANCE_BOUND_FACTOR = 1.001;
export const SCORE_SLACK = 0.01;

// Relative phase costs measured at the reference block size.
export const LOD_PROGRESS_REFERENCE_ROWS = 65536;
export const LOD_PHASE_WORK = {
  core: 0.03,
  index: 0.38,
  seeds: 0.14,
  selection: 0.28,
  assignment: 0.11,
  merge: 0.06,
};
// Extra preparation work per input row, relative to simplifying one row.
export const LOD_SPLIT_WORK = 0.025;
export const LOD_REORDER_WORK = 0.012;
export const LOD_PROGRESS_INTERVAL_MS = 500;

// CLI defaults. Counts ending in _K use units of 1024 splats. Memory is in GiB.
export const DEFAULT_ROOT_SPLATS_K = 256;
export const DEFAULT_LOD_FACTOR = 2;
export const DEFAULT_REGION_SPLATS_K = 8;
export const DEFAULT_CHUNK_SPLATS_K = 256;
export const DEFAULT_MEMORY_GIB = 4;

// Worker heap limits in MiB, also used to estimate how many workers fit in memory.
export const SIMPLIFY_HEAP_MB = 32;
export const SPLIT_HEAP_MB = 32;

// KD partitioning memory share, target tasks per worker, and batch sizes in input rows.
export const SPLIT_MEMORY_SHARE = 0.5;
export const SPLIT_TASKS_PER_WORKER = 4;
export const POSITION_BATCH_ROWS = 16_384;
export const SPLIT_BUFFER_ROWS = 4096;
export const SPLIT_STRETCH_ROWS = 1 << 20;
export const SPLIT_SCAN_ROWS = 1 << 18;
