import { Loader } from 'three';
import { ExtSplats } from './ExtSplats';
import { PackedSplats } from './PackedSplats';
import { SplatMesh } from './SplatMesh';
import { SplatFileType } from './defines';
export declare class SplatLoader extends Loader {
    load(url: string, onLoad?: (decoded: PackedSplats | ExtSplats) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void;
    loadAsync(url: string, onProgress?: (event: ProgressEvent) => void): Promise<PackedSplats | ExtSplats>;
    parse(packedSplats: PackedSplats): SplatMesh;
    loadInternal({ packedSplats, extSplats, url, fileBytes, fileType, fileName, stream, streamLength, onLoad, onProgress, onError, }: {
        packedSplats?: PackedSplats;
        extSplats?: ExtSplats;
        url?: string;
        fileBytes?: Uint8Array | ArrayBuffer;
        fileType?: SplatFileType;
        fileName?: string;
        stream?: ReadableStream;
        streamLength?: number;
        onLoad?: (decoded: PackedSplats | ExtSplats) => void;
        onProgress?: (event: ProgressEvent) => void;
        onError?: (error: unknown) => void;
    }): void;
    loadInternalAsync({ packedSplats, extSplats, url, fileBytes, fileType, fileName, stream, streamLength, onProgress, }: {
        packedSplats?: PackedSplats;
        extSplats?: ExtSplats;
        url?: string;
        fileBytes?: Uint8Array | ArrayBuffer;
        fileType?: SplatFileType;
        fileName?: string;
        stream?: ReadableStream;
        streamLength?: number;
        onProgress?: (event: ProgressEvent) => void;
    }): Promise<PackedSplats | ExtSplats>;
}
