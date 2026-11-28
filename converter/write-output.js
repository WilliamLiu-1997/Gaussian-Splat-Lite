// Reserve a new entry before writing, including when two converter tabs export together.
export function reserveOutput(parent, name, { extension = "", signal } = {}) {
  return navigator.locks.request("gsl-output-name", { signal }, async () => {
    for (let n = 1; ; n++) {
      signal?.throwIfAborted();
      const candidate = `${n === 1 ? name : `${name}-${n}`}${extension}`;
      try {
        await parent.getDirectoryHandle(candidate);
      } catch (error) {
        if (error.name === "NotFoundError") {
          signal?.throwIfAborted();
          return extension
            ? parent.getFileHandle(candidate, { create: true })
            : parent.getDirectoryHandle(candidate, { create: true });
        }
        if (error.name !== "TypeMismatchError") throw error;
      }
    }
  });
}
