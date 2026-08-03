import { RpcHandlers } from './worker';
type PromiseRecord = {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    onStatus?: (data: unknown) => void;
};
export declare class SplatWorker {
    worker: Worker;
    messages: Record<number, PromiseRecord>;
    static currentId: number;
    constructor();
    onMessage(event: MessageEvent): void;
    call<Name extends keyof RpcHandlers>(name: Name, args: Parameters<RpcHandlers[Name]>[0], options?: {
        onStatus?: (data: unknown) => void;
    }): Promise<Awaited<ReturnType<RpcHandlers[Name]>>>;
    dispose(): void;
}
export declare class SplatWorkerPool {
    maxWorkers: number;
    numWorkers: number;
    freelist: SplatWorker[];
    queue: ((worker: SplatWorker) => void)[];
    constructor(maxWorkers?: number);
    withWorker<T>(callback: (worker: SplatWorker) => Promise<T>): Promise<T>;
    allocWorker(): Promise<SplatWorker>;
    freeWorker(worker: SplatWorker): void;
}
export declare const workerPool: SplatWorkerPool;
export {};
