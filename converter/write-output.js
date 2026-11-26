// Reserve a new entry before writing, including when two converter tabs export together.
export function reserveOutput(parent, name, extension = "") {
  return navigator.locks.request("gsl-output-name", async () => {
    for (let n = 1; ; n++) {
      const candidate = `${n === 1 ? name : `${name}-${n}`}${extension}`;
      try {
        await parent.getDirectoryHandle(candidate);
      } catch (error) {
        if (error.name === "NotFoundError")
          return extension
            ? parent.getFileHandle(candidate, { create: true })
            : parent.getDirectoryHandle(candidate, { create: true });
        if (error.name !== "TypeMismatchError") throw error;
      }
    }
  });
}
