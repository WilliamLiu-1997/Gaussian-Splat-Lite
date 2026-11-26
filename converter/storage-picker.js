export function setupFolderPicker(select, status) {
  const zone = document.getElementById("folder-drop");
  const button = document.getElementById("choose-folder");
  const error = document.getElementById("folder-error");

  function report(message) {
    error.textContent = message;
    error.hidden = false;
    status(message, true);
  }

  function choose(directory) {
    error.hidden = true;
    select(directory);
  }

  button.onclick = async () => {
    try {
      choose(
        await window.showDirectoryPicker({ mode: "readwrite", id: "gsl-work" }),
      );
    } catch (cause) {
      if (cause.name !== "AbortError") report(cause.message);
    }
  };

  zone.ondragover = (event) => {
    event.preventDefault();
    const enabled = !button.matches(":disabled");
    event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    zone.classList.toggle("drag", enabled);
  };
  zone.ondragleave = (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove("drag");
  };
  zone.ondrop = async (event) => {
    event.preventDefault();
    zone.classList.remove("drag");
    if (button.matches(":disabled")) return;
    const files = Array.from(event.dataTransfer.items).filter(
      (item) => item.kind === "file",
    );
    if (files.length !== 1)
      return report("Drop one folder here or click Choose folder.");
    try {
      const [item] = files;
      if (typeof item.getAsFileSystemHandle !== "function")
        return report(
          "Folder handles are unavailable for drag and drop in this tab. Click Choose folder.",
        );
      const directory = await item.getAsFileSystemHandle();
      if (button.matches(":disabled")) return;
      if (directory?.kind === "directory") choose(directory);
      else if (directory?.kind === "file")
        report("Drop one folder here or click Choose folder.");
      else report("Could not access the dropped folder. Click Choose folder.");
    } catch (cause) {
      report(cause.message);
    }
  };
}
