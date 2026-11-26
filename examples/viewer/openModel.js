import {
  filesFromDrop,
  modelFromEntries,
  modelFromLocalFiles,
  modelFromUrl,
} from "./modelSource.js";
import { activeLoad, cancelLoading, loadFile, ui } from "./viewer.js";

const fileInput = document.querySelector("#file-input");
const folderInput = document.querySelector("#folder-input");
const chooseFolderButton = document.querySelector("#choose-folder");
const urlForm = document.querySelector("#url-form");
const modelUrlInput = document.querySelector("#model-url");
const loadUrlButton = document.querySelector("#load-url");

// iOS Files can disable custom extensions such as .ply when accept is set.
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (isIOS) {
  fileInput.removeAttribute("accept");
}

let dragDepth = 0;

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function openFilePicker() {
  fileInput.value = "";
  fileInput.click();
}

function openFolderPicker() {
  folderInput.value = "";
  folderInput.click();
}

function clearDragState() {
  dragDepth = 0;
  ui.setDropOverlayVisible(false);
}

for (const button of document.querySelectorAll("[data-file-picker]")) {
  button.addEventListener("click", openFilePicker);
}

chooseFolderButton.addEventListener("click", openFolderPicker);

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const model = modelFromUrl(modelUrlInput.value.trim());
  if (!model) {
    ui.showToast(
      "Enter an HTTP(S) model URL (.ply, .spz, .sog, .rad, or a scene index).",
    );
    ui.setStatus("Enter a valid model URL");
    modelUrlInput.focus();
    return;
  }

  modelUrlInput.blur();
  void loadFile(model, { url: model.url.href, button: loadUrlButton });
});

async function loadLocalFiles(files) {
  // Some drag relays replace directories with empty, path-named files.
  if (
    files.length === 1 &&
    files[0].size === 0 &&
    files[0].name.startsWith("/")
  ) {
    ui.clearLoading();
    ui.setSourcePanelOpen(true);
    ui.setStatus("Choose the scene folder");
    ui.showToast(
      "Could not read the dropped folder. Use Choose folder to open the scene.",
    );
    chooseFolderButton.focus();
    return;
  }

  const archive = files.length === 1 && /\.zip$/i.test(files[0].name);
  if (archive) cancelLoading();
  const loadId = activeLoad;
  try {
    let model;
    if (archive) {
      const { filesInArchive } = await import("./zipFiles.js");
      const entries = filesInArchive(files[0], () => {
        if (loadId !== activeLoad)
          throw new DOMException("Model load cancelled", "AbortError");
      });
      model = await modelFromEntries(entries);
      if (loadId !== activeLoad) {
        model.dispose?.();
        return;
      }
    } else model = modelFromLocalFiles(files);
    const { file, ...source } = model;
    void loadFile(file, source);
  } catch (error) {
    if (loadId === activeLoad) ui.showToast(error.message);
  }
}

for (const input of [fileInput, folderInput]) {
  if (input.files.length) loadLocalFiles(Array.from(input.files));
  input.addEventListener("change", () => {
    const files = Array.from(input.files);
    if (files.length) loadLocalFiles(files);
  });
}

window.addEventListener("dragenter", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  ui.setDropOverlayVisible(true);
});

window.addEventListener("dragover", (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    clearDragState();
    return;
  }
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.setDropOverlayVisible(false);
});

window.addEventListener("drop", async (event) => {
  event.preventDefault();
  clearDragState();

  cancelLoading();
  const loadId = activeLoad;
  try {
    const files = await filesFromDrop(event.dataTransfer);
    if (loadId !== activeLoad) return;
    if (files.length) {
      loadLocalFiles(files);
    } else {
      ui.showToast(
        "Drop a model or a scene folder containing lod-meta.json or .lcc2 and its chunks.",
      );
      ui.setStatus("PLY, SPZ, SOG, RAD, and LCC2 files are supported");
    }
  } catch (error) {
    if (loadId !== activeLoad) return;
    ui.showToast(`Could not read dropped files: ${error.message}`);
    ui.setStatus("Could not read dropped files");
  }
});

window.addEventListener("blur", clearDragState);
