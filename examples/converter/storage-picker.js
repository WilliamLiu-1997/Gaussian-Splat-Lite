async function droppedFolder(items) {
  const files = Array.from(items).filter((item) => item.kind === "file");
  if (files.length !== 1)
    throw new Error("Drop one folder here or click Choose folder.");
  const [item] = files;
  if (typeof item.getAsFileSystemHandle !== "function")
    throw new Error(
      "Folder handles are unavailable for drag and drop in this tab. Click Choose folder.",
    );
  const directory = await item.getAsFileSystemHandle();
  if (directory?.kind === "directory") return directory;
  if (directory?.kind === "file")
    throw new Error("Drop one folder here or click Choose folder.");
  throw new Error("Could not access the dropped folder. Click Choose folder.");
}

export function setupFolderPicker(update, status) {
  const zone = document.getElementById("folder-drop");
  const button = document.getElementById("choose-folder");
  const error = document.getElementById("folder-error");

  let selected;
  let pending;
  async function choose(request) {
    pending = request;
    error.hidden = true;
    update();
    try {
      const directory = await request;
      if (pending !== request) return;
      selected = directory;
      document.getElementById("folder-name").textContent = directory.name;
      document.getElementById("folder-action").textContent = "Change folder ↗";
    } catch (cause) {
      if (pending !== request) return;
      if (cause.name !== "AbortError") {
        error.textContent = cause.message;
        error.hidden = false;
      }
    }
    pending = undefined;
    update();
    if (!error.hidden) status(error.textContent, true);
  }
  button.onclick = () =>
    choose(window.showDirectoryPicker({ mode: "readwrite", id: "gsl-work" }));

  zone.ondragover = (event) => {
    event.preventDefault();
    const enabled = !button.matches(":disabled");
    event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    zone.classList.toggle("drag", enabled);
  };
  zone.ondragleave = (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove("drag");
  };
  zone.ondrop = (event) => {
    event.preventDefault();
    zone.classList.remove("drag");
    if (button.matches(":disabled")) return;
    choose(droppedFolder(event.dataTransfer.items));
  };
  return () => (pending ? undefined : selected);
}
