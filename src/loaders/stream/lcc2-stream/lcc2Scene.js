import { parseLcc2Bytes } from "../../lcc2/lcc2Manifest.js";
import { checkSourceCount } from "../scene-stream/memory.js";
import { logicalUrl, readSceneBytes } from "../scene-stream/resources.js";

export async function readLcc2Scene(options, signal) {
  if (
    options.refinement !== undefined &&
    options.refinement !== "replace" &&
    options.refinement !== "leaves"
  )
    throw new Error("LCC2 refinement must be 'replace' or 'leaves'");
  const url = logicalUrl(options.url);
  const bytes = await readSceneBytes(
    url,
    options,
    signal,
    Math.min(
      16 * 1024 * 1024,
      Math.floor((options.maxResidentCpuBytes ?? Number.POSITIVE_INFINITY) / 3),
    ),
  );
  const manifest = parseLcc2Bytes(bytes, url);
  if (manifest.nodes.some((node) => Array.isArray(node.data)))
    throw new Error(
      "LCC2 array-valued data has ambiguous refinement semantics",
    );
  const hasSplats =
    manifest.references.some((ref) => ref.kind === "3dgs" && ref.count > 0) ||
    (manifest.environment?.count ?? 0) > 0;
  const sources = new Map();
  const sourceFor = (fileId) => {
    const file = manifest.files[fileId];
    let source = sources.get(file.url);
    if (!source) {
      if (file.kind !== "3dgs")
        throw new Error("LCC2 environment must reference a splat file");
      source = {
        key: file.url,
        url: file.url,
        codec: file.codec,
        count: 0,
        shDegree: 4,
        sourceOffset: 0,
      };
      sources.set(file.url, source);
    }
    return source;
  };
  // Account for every declared record interval, including unused interior payloads.
  for (const ref of manifest.references) {
    if (ref.kind !== "3dgs" || ref.count === 0) continue;
    const source = sourceFor(ref.file);
    source.count = Math.max(source.count, ref.start + ref.count);
  }
  let environment;
  const env = manifest.environment;
  if (env?.reference && env.count !== 0) {
    const count = checkSourceCount(env.count);
    const source = sourceFor(env.reference.file);
    source.count = Math.max(source.count, count);
    environment = {
      id: "environment",
      count,
      ranges: [{ source, start: 0, count }],
    };
  } else if (env?.count) {
    throw new Error(
      "LCC2 environment metadata has no explicit root.data.env reference",
    );
  }
  const tree = refinementTree(manifest.tree, sourceFor);
  let units;
  if (options.refinement === "leaves") {
    units = manifest.nodes
      .filter((node) => node.children.length === 0)
      .map((node) => refinementTree(node, sourceFor))
      .filter((node) => node.payload?.count > 0)
      .map((node) => coverageUnit(node));
  } else {
    validateReplacementProfile(manifest, tree);
    const branches = tree.payload ? [tree] : tree.children;
    units = branches.map((node) => coverageUnit(node));
    if (units.some((unit) => !unit)) {
      if (
        manifest.references.some((ref) => ref.kind === "3dgs" && ref.count > 0)
      )
        throw new Error(
          "LCC2 has no complete coarse frontier; use refinement: 'leaves' for leaf-only streaming",
        );
      units = [];
    }
    units = units.filter((unit) => unit.representations[0].count > 0);
  }
  for (const source of sources.values()) checkSourceCount(source.count);
  if (!units.length && !environment && (manifest.totalSplats > 0 || hasSplats))
    throw new Error("LCC2 scene has no supported splat payloads");
  return {
    units,
    environment,
    boundingBox: manifest.tree.boundingBox,
    metadataBytes: bytes.byteLength,
    coarseCount:
      options.refinement === "leaves"
        ? undefined
        : units.reduce((sum, unit) => sum + unit.representations[0].count, 0),
  };
}

function refinementTree(node, sourceFor, payloadLevel = 0) {
  const refs = node.references.filter((ref) => ref.kind === "3dgs");
  const ranges = refs
    .filter((ref) => ref.count > 0)
    .map((ref) => ({
      source: sourceFor(ref.file),
      node: { id: node.id },
      start: ref.start,
      count: checkSourceCount(ref.count),
    }));
  const payload = refs.length
    ? {
        count: ranges.reduce((sum, range) => sum + range.count, 0),
        ranges,
      }
    : undefined;
  const children = node.children.map((child) =>
    refinementTree(child, sourceFor, payloadLevel + Number(!!payload)),
  );
  const childFrontier =
    children.length && children.every((child) => child.frontier !== undefined)
      ? children.flatMap((child) => child.frontier)
      : undefined;
  const result = {
    id: node.id,
    boundingBox: node.boundingBox,
    payloadLevel,
    payload,
    children,
    childFrontier,
  };
  result.frontier =
    payload?.count > 0
      ? [result]
      : children.length
        ? childFrontier
        : payload
          ? []
          : undefined;
  return result;
}

function validateReplacementProfile(manifest, tree) {
  const counts = [];
  const visit = (node) => {
    if (node.payload)
      counts[node.payloadLevel] =
        (counts[node.payloadLevel] ?? 0) + node.payload.count;
    for (const child of node.children) visit(child);
  };
  visit(tree);
  // 0.0.3 stores finest-first totals; only payload-bearing parents advance the level.
  const declared = [...manifest.lodSplats].reverse();
  if (
    counts.length > declared.length ||
    declared.some((count, level) => count !== (counts[level] ?? 0))
  )
    throw new Error(
      "LCC2 replacement profile payload-level totals do not match reversed lodSplats; use refinement: 'leaves' for leaf-only streaming",
    );
}

function cutRepresentation(cut) {
  const nodeIds = cut.map((node) => node.id);
  const ranges = cut.flatMap((node) => node.payload.ranges);
  return {
    id: `lcc2-cut:${JSON.stringify(nodeIds)}`,
    nodeIds,
    level: cut.reduce((level, node) => Math.max(level, node.payloadLevel), 0),
    count: ranges.reduce((sum, range) => sum + range.count, 0),
    ranges,
  };
}

function coverageUnit(node) {
  if (!node.frontier) return undefined;
  return {
    id: `lcc2:${node.id}`,
    boundingBox: node.boundingBox,
    representations: [cutRepresentation(node.frontier)],
    refinementRoot: node,
  };
}

export function selectLcc2Units(
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
      "LCC2 lodDistances must be nonnegative, coarse-to-fine descending distances",
    );
  if (
    typeof lodHysteresis !== "number" ||
    !(lodHysteresis >= 0 && lodHysteresis < 1)
  )
    throw new Error("LCC2 lodHysteresis must be in [0, 1)");
  const selected = new Map();
  let count = 0;
  const visible = units
    .filter((unit) => scores.has(unit.id))
    .sort((a, b) => scores.get(a.id) - scores.get(b.id));
  // Admit coarse coverage for every visible branch before spending on detail.
  for (const unit of visible) {
    const rep = unit.representations[0];
    if (count + rep.count > budget) continue;
    count += rep.count;
    selected.set(unit.id, rep);
  }
  for (const unit of visible) {
    if (!selected.has(unit.id) || !unit.refinementRoot || !shown.has(unit.id))
      continue;
    const current = shown.get(unit.id).rep;
    const retained = new Set();
    const currentIds = new Set(current?.nodeIds ?? []);
    const markRefined = (node) => {
      const descendantShown = node.children.map(markRefined).some(Boolean);
      if (descendantShown) retained.add(node.id);
      return currentIds.has(node.id) || descendantShown;
    };
    markRefined(unit.refinementRoot);
    const cut = [...unit.refinementRoot.frontier];
    for (let index = 0; index < cut.length; index++) {
      const node = cut[index];
      const children = node.childFrontier;
      if (!children?.length) continue;
      if (
        lodDistances !== undefined &&
        node.payloadLevel >= lodDistances.length
      )
        continue;
      const distance =
        lodDistances?.[node.payloadLevel] ?? Number.POSITIVE_INFINITY;
      const threshold =
        distance *
        (1 + (retained.has(node.id) ? lodHysteresis : -lodHysteresis));
      if (scores.get(unit.id) > threshold) continue;
      const replacementCount = children.reduce(
        (sum, child) => sum + child.payload.count,
        0,
      );
      const delta = replacementCount - node.payload.count;
      if (count + delta > budget) continue;
      count += delta;
      cut.splice(index, 1, ...children);
      index--;
    }
    selected.set(unit.id, cutRepresentation(cut));
  }
  return selected;
}
