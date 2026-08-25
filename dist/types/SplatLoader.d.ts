import { Loader } from 'three';
import { SplatMesh } from './SplatMesh';
import { Splats } from './Splats';
import { SplatFileType } from './defines';
export declare class SplatLoader extends Loader {
    load(url: string, onLoad?: (decoded: Splats) => void, onProgress?: (event: ProgressEvent) => void, onError?: (error: unknown) => void): void;
    loadAsync(url: string, onProgress?: (event: ProgressEvent) => void): Promise<Splats>;
    parse(splats: Splats): SplatMesh;
    loadInternal({ splats, url, fileBytes, fileType, fileName, stream, streamLength, onLoad, onProgress, onError, }: {
        splats?: Splats;
        url?: string;
        fileBytes?: Uint8Array | ArrayBuffer;
        fileType?: SplatFileType;
        fileName?: string;
        stream?: ReadableStream;
        streamLength?: number;
        onLoad?: (decoded: Splats) => void;
        onProgress?: (event: ProgressEvent) => void;
        onError?: (error: unknown) => void;
    }): void;
    loadInternalAsync({ splats, url, fileBytes, fileType, fileName, stream, streamLength, onProgress, }: {
        splats?: Splats;
        url?: string;
        fileBytes?: Uint8Array | ArrayBuffer;
        fileType?: SplatFileType;
        fileName?: string;
        stream?: ReadableStream;
        streamLength?: number;
        onProgress?: (event: ProgressEvent) => void;
    }): Promise<Splats>;
}
