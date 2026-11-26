// Worker termination can return before the browser releases its file handles.
export async function removeTemporary(parent, name, recursive = false) {
  let failure;
  for (const delay of [0, 40, 120, 360, 1000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await parent.removeEntry(name, { recursive });
      return;
    } catch (error) {
      if (error.name === "NotFoundError") return;
      failure = error;
      if (error.name !== "NoModificationAllowedError") break;
    }
  }
  throw new Error(
    `Could not remove ${parent.name}/${name}: ${failure.message}`,
  );
}
