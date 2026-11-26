import * as activity from "./activity.js";
import { convertFile } from "./convert-file.js";
import { saveZip } from "./export.js";
import { enableThreads } from "./isolation.js";
import { options, outputFormat } from "./options.js";
import { setupFolderPicker } from "./storage-picker.js";

const el = (id) => document.getElementById(id);
const previewArea = el("preview-area");
let supported = Boolean(
  window.showDirectoryPicker && navigator.locks && globalThis.Worker,
);
let files = [];
let scenes = [];
let active;
let result;
let workingFolder;
let saving = false;

function status(message, error = false) {
  el("status").textContent = message;
  el("status").classList.toggle("error", error);
}
function refresh() {
  el("convert").disabled =
    !supported || !files.length || !workingFolder || Boolean(active) || saving;
  el("settings").disabled = !supported || Boolean(active) || saving;
  el("cancel").hidden = !active;
  el("result").hidden = !result;
  el("result-picker").disabled = saving;
  el("zip").disabled = saving;
  el("preview").disabled = saving;
}
function setPreviewOpen(open) {
  const viewer = el("viewer");
  if (open && !viewer.hasAttribute("src")) {
    viewer.resultDirectory = result.result;
    viewer.src = "./preview.html?conversion";
  }
  previewArea.hidden = !open;
  el("preview").textContent = open ? "Hide preview" : "Preview";
}
function resetPreview() {
  setPreviewOpen(false);
  el("viewer").resultDirectory = undefined;
  el("viewer").removeAttribute("src");
}
function forget() {
  resetPreview();
  result = undefined;
  scenes = [];
  el("failures").textContent = "";
  el("result-picker").replaceChildren();
}
function select(selection) {
  if (active || saving || !selection.length) return;
  const chosen = Array.from(selection);
  if (chosen.some((file) => !/\.(spz|ply)$/i.test(file.name)))
    return status("Choose PLY or SPZ files.", true);
  forget();
  files = chosen;
  el("source-name").textContent =
    files.length === 1 ? files[0].name : `${files.length} source files`;
  el("source-detail").textContent =
    `${(files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(2)} MiB · Click to replace`;
  updateSetup();
}

function updateSetup() {
  if (!supported) return status(unavailable, true);
  status(
    !workingFolder
      ? "Choose or drop a working folder."
      : files.length
        ? "Ready to convert."
        : "Choose PLY or SPZ files.",
  );
  refresh();
}

setupFolderPicker((directory) => {
  if (active || saving) return;
  workingFolder = directory;
  el("folder-name").textContent = directory.name;
  el("folder-action").textContent = "Change folder ↗";
  updateSetup();
}, status);

function showResult(index) {
  result = scenes[index];
  if (!result) return;
  resetPreview();
  const { details } = result;
  el("zip").hidden = !details?.canPack;
  const stats = details
    ? `${details.count} ${details.count === 1 ? "file" : "files"} · ${(details.size / 1048576).toFixed(2)} MiB`
    : "File details unavailable";
  el("summary").textContent =
    `${result.stem} · ${result.format.toUpperCase()} · ${stats} · Saved to ${result.workingFolder.name}/${result.result.name}/`;
  refresh();
}
el("result-picker").onchange = () =>
  showResult(el("result-picker").selectedIndex);
el("file").onchange = (event) => select(event.target.files);
for (const type of ["dragover", "dragleave", "drop"])
  el("drop").addEventListener(type, (event) => {
    event.preventDefault();
    el("drop").classList.toggle("drag", type === "dragover");
    if (type === "drop") select(event.dataTransfer.files);
  });
el("budget").onchange = () => {
  const custom = el("budget").value === "custom";
  el("custom-label").hidden = !custom;
  el("custom").disabled = !custom;
};
el("preview").onclick = () => setPreviewOpen(previewArea.hidden);

const maximize = el("maximize");
maximize.onclick = async () => {
  try {
    if (document.fullscreenElement === previewArea)
      await document.exitFullscreen();
    else await previewArea.requestFullscreen();
  } catch (error) {
    status(error.message, true);
  }
};
previewArea.addEventListener("fullscreenchange", () => {
  maximize.title =
    document.fullscreenElement === previewArea
      ? "Exit fullscreen"
      : "Enter fullscreen";
});

el("form").onsubmit = async (event) => {
  event.preventDefault();
  if (el("convert").disabled) return;
  const gib = Number(
    el("budget").value === "custom" ? el("custom").value : el("budget").value,
  );
  if (!(gib >= 1 && Number.isSafeInteger(Math.floor(gib * 1024 ** 3))))
    return status("Enter a valid budget of at least 1 GiB.", true);
  const format = outputFormat();
  const values = options();
  forget();
  activity.start(files.length);
  activity.log(
    `${format.toUpperCase()} · ${gib} GiB · Working folder: ${workingFolder.name}`,
  );
  const controller = new AbortController();
  active = controller;
  activity.record(JSON.stringify(values));
  status("Opening temporary storage…");
  el("activity").scrollIntoView({ block: "nearest" });
  refresh();
  try {
    if (
      (await workingFolder.requestPermission({ mode: "readwrite" })) !==
      "granted"
    )
      throw new Error(
        `Write permission is required for ${workingFolder.name}. Choose a writable project folder.`,
      );
    const failures = [];
    for (const [index, file] of files.entries()) {
      if (controller.signal.aborted) break;
      activity.beginFile(index, file.name);
      status(`Converting ${file.name}…`);
      try {
        const scene = await convertFile(
          file,
          workingFolder,
          { format, gib, values },
          controller.signal,
          activity.update,
        );
        scenes.push(scene);
        el("result-picker").add(new Option(file.name));
        activity.log(`Saved ${workingFolder.name}/${scene.result.name}/`);
      } catch (error) {
        if (controller.signal.aborted) break;
        const message = `${file.name}: ${error.message}`;
        failures.push(message);
        activity.log(message, "error");
      }
      activity.endFile();
    }
    if (!scenes.length) {
      controller.signal.throwIfAborted();
      throw new Error(failures.join("\n"));
    }
    el("result-picker").hidden = scenes.length === 1;
    el("failures").textContent = failures.join("\n");
    showResult(0);
    const counts = [`${scenes.length} converted`];
    if (failures.length) counts.push(`${failures.length} failed`);
    const message = controller.signal.aborted
      ? `Cancelled. ${counts.join(", ")}.`
      : counts.length > 1
        ? `${counts.join(", ")}.`
        : "Conversion complete.";
    activity.finish(message);
    status(message);
    if (!controller.signal.aborted && result.details) {
      setPreviewOpen(true);
      previewArea.scrollIntoView({ block: "center" });
    }
  } catch (error) {
    const message = controller.signal.aborted
      ? "Conversion cancelled."
      : error.message;
    activity.finish(message);
    status(message, !controller.signal.aborted);
  } finally {
    active = undefined;
    refresh();
  }
};
el("cancel").onclick = () => active?.abort();
el("zip").onclick = async () => {
  saving = true;
  refresh();
  try {
    const message = await saveZip(result);
    activity.log(message);
    status(message);
  } catch (error) {
    status(
      error.name === "AbortError" ? "Export cancelled." : error.message,
      error.name !== "AbortError",
    );
  } finally {
    saving = false;
    refresh();
  }
};

const unavailable =
  "Conversion needs a browser that can write to a local folder. Use desktop Chrome or Edge on HTTPS or localhost.";
if (supported) {
  try {
    await enableThreads();
  } catch (error) {
    supported = false;
    status(error.message, true);
  }
} else status(unavailable, true);
refresh();
