export async function* filesIn(directory, prefix = "") {
  for await (const [name, handle] of directory.entries()) {
    const path = prefix + name;
    if (handle.kind === "directory") yield* filesIn(handle, `${path}/`);
    else yield { path, file: await handle.getFile() };
  }
}

export async function describeResult(directory, signal) {
  let size = 0;
  let count = 0;
  // ZIP32 includes the local header, descriptor and central record per entry.
  let overhead = 22;
  const utf8 = new TextEncoder();
  for await (const { path, file } of filesIn(directory)) {
    signal.throwIfAborted();
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
