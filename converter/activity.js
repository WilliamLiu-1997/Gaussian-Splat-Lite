import { runTime } from "./runtime/clock.js";

const el = (id) => document.getElementById(id);
const lines = [];
const visibleLines = 250;
const steps = {
  read: 0,
  lod: 1,
  partition: 2,
  cluster: 2,
  encode: 3,
  preview: 4,
};
const phaseCount = 5;
let timer;
let total;
let file;
let phase;
let unit;
let peak;
let liveLine = null;

function duration() {
  const seconds = Math.floor(runTime() / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function record(message, level = "") {
  const line = `[${duration()}] ${level ? `${level.toUpperCase()}  ` : ""}${message}\n`;
  lines.push(line);
  el("download-log").disabled = false;
  return line;
}

export function log(message, level, progressDone) {
  const line = record(message, level);
  const output = el("log");
  const follow =
    output.scrollTop + output.clientHeight >= output.scrollHeight - 2;
  if (level === "error") liveLine = null;
  if (progressDone === undefined) {
    output.insertBefore(document.createTextNode(line), liveLine);
  } else {
    if (!liveLine) {
      liveLine = document.createTextNode("");
      output.append(liveLine);
    }
    liveLine.data = line;
    if (progressDone) liveLine = null;
  }
  if (output.childNodes.length > visibleLines) {
    output.firstChild.remove();
    const note = el("log-window");
    if (note.hidden) {
      note.textContent = `Showing the latest ${visibleLines} entries. Download the log for the full run.`;
      note.hidden = false;
    }
  }
  if (follow) output.scrollTop = output.scrollHeight;
}

function overall(percent) {
  const meter = el("overall");
  meter.value = Math.max(meter.value, Math.floor(percent));
  el("overall-value").textContent = `${meter.value}%`;
}

export function start(count) {
  total = count;
  peak = 0;
  lines.length = 0;
  liveLine = null;
  el("run-state").textContent = "Running";
  el("log-window").hidden = true;
  el("log").replaceChildren();
  el("stage-progress").value = 0;
  el("stage-value").textContent = "—";
  el("stage").textContent = "Opening temporary storage";
  el("current-file").textContent = "Starting";
  el("threads").textContent = "0";
  el("overall").value = 0;
  overall(0);
  el("file-count").textContent = `0 / ${total}`;
  el("elapsed").textContent = duration();
  timer = setInterval(() => {
    el("elapsed").textContent = duration();
  }, 500);
}

export function setPaused(paused) {
  el("elapsed").textContent = duration();
  el("run-state").textContent = paused ? "Paused" : "Running";
  log(paused ? "Conversion paused." : "Conversion resumed.");
}

export function beginFile(index, name) {
  file = index;
  phase = 0;
  unit = undefined;
  el("current-file").textContent = name;
  el("stage").textContent = "Starting converter";
  el("stage-progress").value = 0;
  el("stage-value").textContent = "0%";
  workers(1);
  overall((file / total) * 100);
  log(`File ${index + 1} of ${total} · ${name}`);
}

function workers(count) {
  peak = Math.max(count, peak);
  el("threads").textContent = String(count);
}

export function update(data) {
  if (data.threads) workers(data.threads);
  else if (data.phase) {
    phase = steps[data.phase.name];
    unit = data.phase.unit;
    overall(((file + phase / phaseCount) / total) * 100);
  } else if (data.progress) {
    const { label, percent, line } = data.progress;
    el("stage").textContent = label;
    el("stage-value").textContent = `${percent}%`;
    el("stage-progress").value = percent;
    const phasePercent =
      data.progress.phasePercent ?? (label === unit ? percent : undefined);
    if (phasePercent !== undefined)
      overall(
        Math.min(
          99,
          ((file + (phase + phasePercent / 100) / phaseCount) / total) * 100,
        ),
      );
    log(line, "", data.progress.done);
  } else if (data.log !== undefined)
    log(data.log, data.level === "warn" ? "warn" : "");
}

export function endFile() {
  liveLine = null;
  el("file-count").textContent = `${file + 1} / ${total}`;
  overall(((file + 1) / total) * 100);
}

export function finish(message) {
  liveLine = null;
  clearInterval(timer);
  el("elapsed").textContent = duration();
  el("threads").textContent = `0 · peak ${peak}`;
  el("run-state").textContent = message;
  log(message);
}

el("download-log").onclick = () => {
  const url = URL.createObjectURL(
    new Blob(lines, { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "gsl-conversion.log";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
