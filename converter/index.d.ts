export type ConversionEvent =
  | { phase: { name: string; unit?: string } }
  | {
      progress: {
        label: string;
        line: string;
        percent: number;
        phasePercent?: number;
        done: boolean;
      };
    }
  | { threads: number }
  | { log: string; level: "log" | "warn" | "error" };

type CommonFlags = {
  "max-sh"?: number;
  "sh-codebook"?: number;
  "within-dist"?: string;
};

export class ConversionController extends AbortController {
  private readonly state: Int32Array;
  readonly paused: boolean;
  /** Elapsed time excluding pauses, frozen on abort. */
  readonly elapsedMilliseconds: number;
  pause(): void;
  resume(): void;
  /** Resolves when the controller resumes or aborts. */
  waitWhilePaused(): Promise<void>;
}

export type ConversionOptions = {
  workingDirectory: FileSystemDirectoryHandle;
  /** Memory target in GiB. Defaults to 4. */
  memoryBudget?: number;
  onProgress?: (event: ConversionEvent) => void;
  signal?: AbortSignal;
  controller?: ConversionController;
} & (
  | {
      format: "rad";
      flags?: CommonFlags & {
        "lod-base"?: number;
        "cluster-sh"?: number;
        "rad-chunked"?: boolean;
      };
    }
  | {
      format: "sog";
      flags?: CommonFlags & {
        "lod-chunk-count"?: number;
        "region-splats"?: number;
        "root-splats"?: number;
        "lod-factor"?: number;
        "lod-density"?: number;
        "sh-iterations"?: number;
        "sog-blind"?: string[];
      };
    }
);

export function convertFile(
  file: File,
  options: ConversionOptions,
): Promise<{
  directory: FileSystemDirectoryHandle;
  entryPath: string;
}>;
