import { SplatResult } from './defines.cjs';
declare const rpcHandlers: {
    setSortCenterState: typeof setSortCenterState;
    sortCenters32: typeof sortCenters32;
    loadSplats: typeof loadSplats;
    nextChunk: typeof nextChunk;
};
export type RpcHandlers = typeof rpcHandlers;
declare function setSortCenterState({ updateRangeIndices, updateCenters, rangeMeshIds, rangeBases, rangeCounts, rangeOrigins, }: {
    updateRangeIndices: Uint32Array;
    updateCenters: Float32Array;
    rangeMeshIds: Uint32Array;
    rangeBases: Uint32Array;
    rangeCounts: Uint32Array;
    rangeOrigins: Float64Array;
}): void;
declare function sortCenters32({ numSplats, cameraPosition, direction, radial, ordering, }: {
    numSplats: number;
    cameraPosition: [number, number, number];
    direction: [number, number, number];
    radial: boolean;
    ordering: Uint32Array;
}): {
    activeSplats: number;
    ordering: Uint32Array<ArrayBufferLike>;
};
declare function loadSplats({ url, requestHeader, withCredentials, fileBytes, fileType, pathName, chunked, chunkedLength, }: {
    url?: string;
    requestHeader?: Record<string, string>;
    withCredentials?: boolean;
    fileBytes?: Uint8Array;
    fileType?: string;
    pathName?: string;
    chunked?: boolean;
    chunkedLength?: number;
}, { sendStatus }: {
    sendStatus: (data: unknown) => void;
}): Promise<SplatResult>;
declare function nextChunk({ chunk }: {
    chunk: Uint8Array;
}): Promise<void>;
export {};
