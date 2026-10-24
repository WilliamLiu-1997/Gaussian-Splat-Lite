import { DefaultLoadingManager } from "three";
import {
  createLccDecodeContext,
  parseLccIndex,
  parseLccManifest,
} from "../../lcc/lccManifest.js";
import { readResponse, requestOptions } from "../../source.js";
import { MAX_INPUT_BYTES, checkSourceCount } from "../scene-stream/memory.js";
import { logicalUrl, readSceneBytes } from "../scene-stream/resources.js";

const DECODE_BLOCK_POINTS = 256 * 1024;

function chunkedRepresentation(representation, source, stride, node) {
  let ranges;
  return {
    ...representation,
    get ranges() {
      ranges ??= Array.from(
        { length: Math.ceil(source.count / DECODE_BLOCK_POINTS) },
        (_, index) => {
          const first = index * DECODE_BLOCK_POINTS;
          const count = Math.min(DECODE_BLOCK_POINTS, source.count - first);
          const byteLength = count * stride;
          const shByteLength =
            source.shByteLength === undefined ? undefined : count * 64;
          return {
            source: {
              ...source,
              key:
                source.count <= DECODE_BLOCK_POINTS
                  ? source.key
                  : `${source.key}:${first}`,
              offset: source.offset + first * stride,
              byteLength,
              shOffset:
                source.shOffset === undefined
                  ? undefined
                  : source.shOffset + first * 64,
              shByteLength,
              inputBytes: byteLength + (shByteLength ?? 0),
              sourceOffset: source.sourceOffset + first,
              count,
              maxPoints: count,
              wholeFile:
                source.wholeFile === true &&
                source.count <= DECODE_BLOCK_POINTS,
              context: { ...source.context, count, maxPoints: count },
            },
            start: 0,
            count,
            ...(node ? { node } : {}),
          };
        },
      );
      return ranges;
    },
  };
}

/** Only exact documented/lowercase names are candidates; resolver failures are never absence. */
async function resolveCompanion(name, options, signal, optional, maxBytes) {
  const base = logicalUrl(options.url);
  const override = options.companionPaths?.[name];
  if (override !== undefined && (typeof override !== "string" || !override))
    throw new Error(`LCC companionPaths.${name} must be a nonempty path`);
  const documented = `${name[0].toUpperCase()}${name.slice(1)}.bin`;
  const urls = (override ? [override] : [`${name}.bin`, documented]).map(
    (path) => new URL(path, base).href,
  );
  const sizes = urls.map((url) => options.manager?.getFileSize?.(url));
  for (const size of sizes)
    if (
      size !== undefined &&
      size !== null &&
      (!Number.isSafeInteger(size) || size < 0)
    )
      throw new Error(`LCC ${name} has an invalid byte length`);
  const present = sizes.flatMap((size, index) =>
    typeof size === "number" ? [index] : [],
  );
  if (present.length > 1)
    throw new Error(
      `LCC ambiguous ${name} companions; set companionPaths.${name}`,
    );
  if (present.length) {
    const index = present[0];
    return { url: urls[index], byteLength: sizes[index] };
  }
  for (let index = 0; index < urls.length; index++) {
    if (sizes[index] === null) continue;
    const url = urls[index];
    if (maxBytes !== undefined) {
      const bytes = await readSceneBytes(url, options, signal, maxBytes, true);
      if (bytes) return { url, byteLength: bytes.byteLength, bytes };
      continue;
    }
    // Keep empty-resource handling local; payload reads still use RadSource validation.
    const manager = options.manager ?? DefaultLoadingManager;
    const resolved = logicalUrl(manager.resolveURL(url));
    const request = requestOptions(options, resolved, base);
    request.headers.set("Range", "bytes=0-0");
    manager.itemStart(resolved);
    let response;
    try {
      signal.throwIfAborted();
      response = await fetch(resolved, { ...request, signal });
      signal.throwIfAborted();
      if (response.status === 404) continue;
      const contentRange = response.headers.get("Content-Range");
      if (optional && response.status === 416 && contentRange === "bytes */0")
        return { url, byteLength: 0 };
      if (response.status === 200)
        throw new Error(
          "RAD: server ignored Range; streaming requires byte-range support",
        );
      if (response.status !== 206)
        throw new Error(`RAD: HTTP ${response.status} loading ${resolved}`);
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding.toLowerCase() !== "identity")
        throw new Error(
          "RAD: byte-range resources must use identity Content-Encoding",
        );
      let total;
      if (contentRange !== null) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
        if (!range) throw new Error("RAD: invalid Content-Range header");
        const [start, end, size] = range.slice(1).map(Number);
        if (
          start !== 0 ||
          end !== 0 ||
          !Number.isSafeInteger(size) ||
          size <= 0
        )
          throw new Error(
            "RAD: Content-Range does not match the requested bytes",
          );
        total = size;
      }
      const { size } = await readResponse(
        response,
        1,
        (bytes) => options.onProgress?.(bytes),
        signal,
      );
      signal.throwIfAborted();
      if (size !== 1) throw new Error("RAD: truncated range response");
      const etag = response.headers.get("ETag");
      const modified = response.headers.get("Last-Modified");
      const validatorHeader =
        etag && !etag.startsWith("W/")
          ? "ETag"
          : modified
            ? "Last-Modified"
            : undefined;
      return {
        url,
        byteLength: total,
        state: {
          responseUrl: response.url || resolved,
          total,
          validatorHeader,
          validator: validatorHeader
            ? response.headers.get(validatorHeader)
            : undefined,
        },
      };
    } catch (error) {
      manager.itemError(resolved);
      throw error;
    } finally {
      await response?.body?.cancel().catch(() => {});
      manager.itemEnd(resolved);
    }
  }
  if (!optional)
    throw new Error(
      `LCC missing ${documented}; set companionPaths.${name} for another exact path`,
    );
}

export async function readLccScene(options, signal) {
  const cpuLimit = options.maxResidentCpuBytes ?? Number.POSITIVE_INFINITY;
  const metadataLimit = Math.floor(cpuLimit / 3);
  const url = logicalUrl(options.url);
  const bytes = await readSceneBytes(
    url,
    options,
    signal,
    Math.min(1024 * 1024, metadataLimit),
  );
  const manifest = parseLccManifest(bytes, { fileType: options.fileType });
  const indexLimit = Math.min(
    16 * 1024 * 1024,
    Math.max(0, metadataLimit - bytes.byteLength),
  );
  const indexFile = await resolveCompanion(
    "index",
    options,
    signal,
    false,
    indexLimit,
  );
  const index =
    indexFile.bytes ??
    (await readSceneBytes(indexFile.url, options, signal, indexLimit));
  const data = manifest.totalSplats
    ? await resolveCompanion("data", options, signal)
    : undefined;
  const sh =
    manifest.totalSplats && manifest.fileType === "Quality"
      ? await resolveCompanion("shcoef", options, signal)
      : undefined;
  const units = parseLccIndex(index, manifest, {
    dataByteLength: data?.byteLength,
    shByteLength: sh?.byteLength,
  })
    .map((unit) => ({
      id: String(unit.index),
      boundingBox: unit.boundingBox,
      representations: unit.representations
        .filter((rep) => rep.count > 0)
        .map((rep) => {
          checkSourceCount(rep.count);
          const source = {
            key: `lcc:${url}:${rep.offset}:${rep.count}`,
            codec: "lcc",
            url: data.url,
            resourceState: data.state,
            shUrl: sh?.url,
            shResourceState: sh?.state,
            offset: rep.offset,
            byteLength: rep.byteLength,
            shOffset: rep.shOffset,
            shByteLength: rep.shByteLength,
            inputBytes: rep.byteLength + (rep.shByteLength ?? 0),
            sourceOffset: rep.offset / 32,
            count: rep.count,
            shDegree: manifest.maxShDegree,
            context: createLccDecodeContext(manifest, rep.count, {
              maxPoints: checkSourceCount(rep.count),
            }),
          };
          if (source.sourceOffset + source.count > 2 ** 32)
            throw new Error("LCC source IDs exceed 32-bit addressing");
          if (source.inputBytes > MAX_INPUT_BYTES)
            throw new Error("LCC representation exceeds input byte limit");
          return chunkedRepresentation(
            {
              id: `${unit.index}:${rep.level}`,
              level: rep.level,
              count: rep.count,
            },
            source,
            32,
            unit,
          );
        })
        .sort((a, b) => b.level - a.level),
    }))
    .filter((unit) => unit.representations.length);

  const environmentFile = await resolveCompanion(
    "environment",
    options,
    signal,
    true,
  );
  const size = environmentFile?.byteLength;
  let environment;
  if (environmentFile && size !== 0) {
    if (size === undefined)
      throw new Error(
        "LCC Environment.bin needs an exposed Content-Range total or manager.getFileSize",
      );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_INPUT_BYTES ||
      size % manifest.environmentStride
    )
      throw new Error("LCC environment has an invalid byte length");
    const count = checkSourceCount(size / manifest.environmentStride);
    const source = {
      key: `lcc-env:${url}`,
      codec: "lcc",
      url: environmentFile.url,
      resourceState: environmentFile.state,
      offset: 0,
      byteLength: size,
      inputBytes: size,
      sourceOffset: 0,
      count,
      shDegree: manifest.maxShDegree,
      wholeFile: true,
      context: createLccDecodeContext(manifest, count, {
        environment: true,
        maxPoints: count,
      }),
    };
    environment = chunkedRepresentation(
      { id: "environment", count },
      source,
      manifest.environmentStride,
    );
  }
  return {
    units,
    environment,
    boundingBox: manifest.boundingBox,
    metadataBytes: bytes.byteLength + index.byteLength,
    coarseCount: units.reduce(
      (sum, unit) => sum + unit.representations[0].count,
      0,
    ),
  };
}

/** Exactly one alternative per Unit. A Unit must render coarse data before upgrading. */
export function selectLccUnits(
  units,
  budget,
  scores,
  shown = new Map(),
  options = {},
) {
  const { lodDistances, lodHysteresis = 0.15 } = options;
  if (
    lodDistances !== undefined &&
    (!Array.isArray(lodDistances) ||
      Array.from(lodDistances).some(
        (distance, index) =>
          typeof distance !== "number" ||
          !(distance >= 0) ||
          (index > 0 && distance > lodDistances[index - 1]),
      ))
  )
    throw new Error(
      "LCC lodDistances must be nonnegative, coarse-to-fine descending distances",
    );
  if (
    typeof lodHysteresis !== "number" ||
    !(lodHysteresis >= 0 && lodHysteresis < 1)
  )
    throw new Error("LCC lodHysteresis must be in [0, 1)");
  const visible = units
    .filter((unit) => scores.has(unit.id))
    .sort((a, b) => scores.get(a.id) - scores.get(b.id));
  const selected = new Map();
  let count = 0;
  for (const unit of visible) {
    const coarse = unit.representations[0];
    if (count + coarse.count > budget) continue;
    selected.set(unit.id, coarse);
    count += coarse.count;
  }
  for (const unit of visible) {
    if (!selected.has(unit.id) || !shown.has(unit.id)) continue;
    const currentIndex = unit.representations.findIndex(
      (rep) => rep.id === shown.get(unit.id)?.rep?.id,
    );
    for (let index = 1; index < unit.representations.length; index++) {
      if (lodDistances !== undefined && index > lodDistances.length) break;
      const distance = lodDistances?.[index - 1] ?? Number.POSITIVE_INFINITY;
      const threshold =
        distance *
        (1 + (currentIndex >= index ? lodHysteresis : -lodHysteresis));
      if (scores.get(unit.id) > threshold) break;
      const rep = unit.representations[index];
      const previous = selected.get(unit.id);
      if (count - previous.count + rep.count > budget) continue;
      count += rep.count - previous.count;
      selected.set(unit.id, rep);
    }
  }
  return selected;
}
