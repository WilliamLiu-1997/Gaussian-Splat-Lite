import { ExtResult, PackedResult, SplatEncoding } from './defines';
declare const rpcHandlers: {
    sortSplats32: typeof sortSplats32;
    loadPackedSplats: typeof loadPackedSplats;
    loadExtSplats: typeof loadExtSplats;
    nextChunk: typeof nextChunk;
};
export type RpcHandlers = typeof rpcHandlers;
declare function sortSplats32({ numSplats, readback, ordering, }: {
    numSplats: number;
    readback: Uint32Array;
    ordering: Uint32Array;
}): {
    activeSplats: number;
    readback: Uint32Array<ArrayBufferLike>;
    ordering: Uint32Array<ArrayBufferLike>;
};
declare function loadPackedSplats({ url, requestHeader, withCredentials, fileBytes, fileType, pathName, chunked, chunkedLength, encoding, }: {
    url?: string;
    requestHeader?: Record<string, string>;
    withCredentials?: boolean;
    fileBytes?: Uint8Array;
    fileType?: string;
    pathName?: string;
    chunked?: boolean;
    chunkedLength?: number;
    encoding?: SplatEncoding;
}, { sendStatus }: {
    sendStatus: (data: unknown) => void;
}): Promise<PackedResult>;
declare function loadExtSplats({ url, requestHeader, withCredentials, fileBytes, fileType, pathName, chunked, chunkedLength, }: {
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
}): Promise<ExtResult>;
declare function nextChunk({ chunk }: {
    chunk: Uint8Array;
}): Promise<void>;
export {};
