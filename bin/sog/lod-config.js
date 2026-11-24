// CLI defaults. Counts ending in _K use units of 1024 splats. Memory is in GiB.
export const DEFAULT_ROOT_SPLATS_K = 256;
export const DEFAULT_LOD_FACTOR = 2;
export const DEFAULT_LOD_DENSITY = 1 / 3;
export const DEFAULT_REGION_SPLATS_K = 8;
export const DEFAULT_CHUNK_SPLATS_K = 256;
export const DEFAULT_MEMORY_GIB = 4;

// Heap limit per region partitioning worker, in MiB.
export const SPLIT_HEAP_MB = 32;

// Region partitioning and scan sizes in input rows.
export const KD_BINS_PER_AXIS = 256;
export const SPLIT_MEMORY_SHARE = 0.5;
export const SPLIT_TASKS_PER_WORKER = 4;
export const POSITION_BATCH_ROWS = 16_384;
export const SPLIT_BUFFER_ROWS = 4096;
export const SPLIT_STRETCH_ROWS = 1 << 20;
export const SPLIT_SCAN_ROWS = 1 << 18;
