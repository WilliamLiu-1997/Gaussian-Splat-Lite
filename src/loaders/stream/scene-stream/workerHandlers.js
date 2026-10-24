import * as wasm from "gaussian-splat-rs";
import { abortable } from "../../../runtime/abort.js";
import { wasmCall, wasmFree } from "../../../runtime/wasmCall.js";
import { RadSource } from "../../rad/RadSource.js";
import { joinBytes, readResponse, requestOptions } from "../../source.js";
import { createSogStreamHandlers } from "../sog-stream/workerHandlers.js";
import { MAX_INPUT_BYTES, checkSourceCount, sourceLimits } from "./limits.js";

import {
  preflightScenePayload,
  validateSceneDecodedSource,
} from "./preflight.js";

export function createSceneStreamHandlers(decodeSplats, decodeLcc) {
  const cache = createSogStreamHandlers(decodeSplats);
  const loads = new Map();
  const admissions = new Map();
  const resourceChecks = new Map();
  function acceptSceneResource({ id }) {
    resourceChecks.get(id)?.();
  }
  function admitSceneSource({ id, limits }) {
    admissions.get(id)?.(limits);
  }
  const transports = new Map();
  const rangeSource = (url, resolved, args, state) => {
    let transport = transports.get(url);
    if (!transport) {
      transport = new RadSource({
        url,
        requestHeader: args.requestHeader,
        withCredentials: args.withCredentials,
        resolveAsset: async () => resolved,
      });
      if (state) Object.assign(transport.remote(url), state, { resolved });
      transports.set(url, transport);
    }
    transport.remote(url).resolved = resolved;
    return transport;
  };
  async function loadSceneSource(
    { id, source, limits: reservedLimits, admissionEnabled, ...args },
    rpc,
  ) {
    const controller = new AbortController();
    loads.set(id, controller);
    const signal = controller.signal;
    let raw;
    try {
      checkSourceCount(source.count);
      let limits = reservedLimits ?? sourceLimits(source);
      const readmit = async (update) => {
        if (!admissionEnabled)
          throw new Error(
            "Source requires a larger CPU admission before decoding",
          );
        const approved = new Promise((resolve) => admissions.set(id, resolve));
        try {
          rpc.sendStatus({ admission: update });
          limits = await abortable(approved, signal);
        } finally {
          admissions.delete(id);
        }
      };
      const checkResource = async (resource) => {
        if (!args.validateResources) return;
        const approved = new Promise((resolve) =>
          resourceChecks.set(id, resolve),
        );
        try {
          rpc.sendStatus({ resource });
          // The session owner must reconcile independently fetched versions before decode.
          await abortable(approved, signal);
        } finally {
          resourceChecks.delete(id);
        }
      };
      let data;
      let expectedCount = source.count;
      if (source.codec === "lcc") {
        if (
          decodeLcc === Reflect.get(wasm, "decodeLcc") &&
          !Reflect.get(wasm, "decoder_budget_supported")?.()
        )
          throw new Error("WASM LCC decoder lacks budget guards; rebuild WASM");
        if (
          source.inputBytes > limits.maxInputBytes ||
          source.context.count !== source.count
        )
          throw new Error("Invalid LCC decode admission");
        const transport = rangeSource(
          source.url,
          args.url,
          args,
          source.resourceState,
        );
        const base = await transport.read(
          source.url,
          source.offset,
          source.byteLength,
          signal,
          source.wholeFile ?? false,
        );
        await checkResource({
          url: source.url,
          state: transport.resourceState(transport.remote(source.url)),
        });
        const shTransport = source.shByteLength
          ? rangeSource(
              source.shUrl,
              args.shUrl,
              {
                requestHeader: args.shRequestHeader,
                withCredentials: args.shWithCredentials,
              },
              source.shResourceState,
            )
          : undefined;
        const sh = shTransport
          ? await shTransport.read(
              source.shUrl,
              source.shOffset,
              source.shByteLength,
              signal,
            )
          : new Uint8Array(0);
        if (shTransport)
          await checkResource({
            url: source.shUrl,
            state: shTransport.resourceState(shTransport.remote(source.shUrl)),
          });
        signal.throwIfAborted();
        // Configure the primitive limit before wasm-bindgen copies the context string.
        wasmCall(() =>
          Reflect.get(wasm, "set_decoder_memory_limit")?.(limits.maxWasmBytes),
        );
        raw = wasmCall(() =>
          decodeLcc(
            base,
            sh,
            JSON.stringify({
              ...source.context,
              maxPoints: limits.maxPoints,
              maxDecoderBytes: limits.maxDecoderBytes,
              maxWasmBytes: limits.maxWasmBytes,
            }),
          ),
        );
        data = {
          numSplats: raw.numSplats,
          splatArrays: [raw.splat0, raw.splat1],
          sortCenters: raw.sortCenters,
          sourceIds: raw.sourceIds,
          extra: Object.fromEntries(
            Array.from({ length: 6 }, (_, index) => [
              `shBlock${index}`,
              raw[`shBlock${index}`],
            ]),
          ),
        };
        rpc.sendStatus({ loaded: base.byteLength + sh.byteLength });
      } else {
        const response = await fetch(args.url, {
          ...requestOptions(args, args.url, source.url),
          signal,
        });
        const announced = Number(response.headers.get("Content-Length"));
        if (
          response.ok &&
          Number.isSafeInteger(announced) &&
          announced > limits.maxInputBytes &&
          announced <= MAX_INPUT_BYTES
        ) {
          try {
            await readmit({ maxInputBytes: announced });
          } catch (error) {
            await response.body?.cancel().catch(() => {});
            throw error;
          }
        }
        const { chunks, size } = await readResponse(
          response,
          limits.maxInputBytes,
          () => {},
          signal,
        );
        const fileBytes = joinBytes(chunks, size);
        rpc.sendStatus({ loaded: size });
        await checkResource({
          url: source.url,
          headers: [...response.headers],
          size,
          responseUrl: response.url,
        });
        let decodedCount;
        try {
          decodedCount = await preflightScenePayload(
            fileBytes,
            source.codec,
            source.count,
            signal,
            {
              ...limits,
              maxPoints:
                admissionEnabled && source.maxPoints === undefined
                  ? undefined
                  : limits.maxPoints,
            },
          );
        } catch (error) {
          signal.throwIfAborted();
          throw new Error(
            `Scene ${source.codec} preflight failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (decodedCount > limits.maxPoints) {
          await readmit({ maxPoints: decodedCount });
          if (limits.maxPoints < decodedCount)
            throw new Error("Insufficient source header admission");
        }
        expectedCount = decodedCount;
        signal.throwIfAborted();
        data = await decodeSplats(
          {
            ...args,
            fileBytes,
            decoderLimits: limits,
            fileType: source.codec,
            baseUrl: source.url,
            expectedSogCount: source.codec === "sog" ? decodedCount : undefined,
            signal,
          },
          rpc,
        );
      }
      signal.throwIfAborted();
      validateSceneDecodedSource(data, expectedCount);
      return cache.cacheSogChunk({ id, data });
    } catch (error) {
      if (
        source.codec === "lcc" &&
        Reflect.get(wasm, "wasm_budget_exceeded")?.()
      )
        throw new Error(
          `LCC decoder exceeded admitted WASM capacity of ${(reservedLimits ?? sourceLimits(source)).maxWasmBytes} bytes`,
        );
      throw error;
    } finally {
      if (typeof raw?.free === "function") wasmFree(raw);
      loads.delete(id);
    }
  }
  function releaseSceneSource({ id }) {
    loads.get(id)?.abort();
    cache.releaseSogChunk({ id });
  }
  async function extractSceneRanges({ id, ranges, sourceOffset = 0 }) {
    const data = cache.extractSogRegions({ id, ranges });
    if (sourceOffset)
      for (const range of data)
        for (let i = 0; i < range.numSplats; i++)
          range.sourceIds[i] += sourceOffset;
    return data;
  }
  return {
    loadSceneSource,
    releaseSceneSource,
    extractSceneRanges,
    admitSceneSource,
    acceptSceneResource,
  };
}
