export async function* filesIn(directory, prefix = "") {
  for await (const [name, handle] of directory.entries()) {
    const path = prefix + name;
    if (handle.kind === "directory") yield* filesIn(handle, `${path}/`);
    else yield { path, file: await handle.getFile() };
  }
}

export async function describeResult(directory, run) {
  let size = 0;
  let count = 0;
  // ZIP32 includes the local header, descriptor and central record per entry.
  let overhead = 22;
  const utf8 = new TextEncoder();
  for await (const { path, file } of filesIn(directory)) {
    if (run) {
      await run.waitWhilePaused();
      run.signal.throwIfAborted();
    }
    size += file.size;
    count++;
    overhead += 92 + 2 * utf8.encode(path).length;
  }
  return {
    size,
    count,
    canPack: count < 65535 && size + overhead < 0xffffffff,
  };
}

export async function previewResult(
  directory,
  workingFolder,
  file,
  format,
  run,
  update,
) {
  const stem = file.name.replace(/\.(ply|spz)$/i, "");
  const scene = { result: directory, workingFolder, format, stem };
  const { signal } = run;
  if (signal.aborted) return scene;
  const label = "Preparing preview files";
  update({ phase: { name: "preview", unit: label } });
  update({ progress: { label, percent: 0, line: label, done: false } });
  try {
    scene.details = await describeResult(directory, run);
  } catch (error) {
    if (signal.aborted) return scene;
    update({
      log: `Could not read output details: ${error.message}`,
      level: "warn",
    });
  }
  const summary = scene.details
    ? `Preview ready · ${scene.details.count} files`
    : "Scene saved · File details unavailable";
  update({
    progress: {
      label: scene.details ? label : "Scene saved",
      percent: 100,
      done: true,
      line: summary,
    },
  });
  return scene;
}
