import type { ByteSource as Source } from "../source.js";
type Entry = {
  name: string;
  nameLength: number;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
};
export declare function readZipDirectory(source: Source): Promise<{
  entries: Map<string, Entry>;
  read: (entry: Entry) => Promise<Uint8Array<ArrayBufferLike>[]>;
  storedOffset: (entry: Entry) => Promise<number>;
}>;
export declare function readZip(source: Source): Promise<{
  meta: Entry;
  read: (entry: Entry) => Promise<Uint8Array<ArrayBufferLike>[]>;
  entry(name: string): Entry | undefined;
}>;
export {};
