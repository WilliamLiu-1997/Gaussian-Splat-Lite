/** Exponential backoff for temporary streaming failures. */
export declare function retryDelay(failures: number): number;
/** Wake on-demand render loops at the next retry, without polling idle scenes. */
export declare class RetryTimer {
  private readonly wake;
  private timer?;
  private deadline;
  constructor(wake: () => void);
  update(deadlines: Iterable<number>): void;
  dispose(): void;
}
