import { defaults } from "../bin/sog/options.js";

const fields = document.querySelector("#fields");
const form = document.querySelector("#form");
export const outputFormat = () => form.elements.namedItem("format").value;
const numeric = (flag, title, value, min, step = "1", max = undefined) => ({
  flag,
  title,
  value,
  min,
  step,
  max,
});
const crop = {
  flag: "within-dist",
  title: "Crop sphere (x, y, z, radius)",
  placeholder: "Entire scene",
};
const sogNumber = (flag, title, min, step, max) =>
  numeric(flag, title, defaults[flag], min, step, max);
const maxCountK = Math.floor(0xffffffff / 1024);
const settings = {
  sog: {
    "Level of detail": [
      sogNumber("lod-chunk-count", "Points per chunk (K)", 1, "1", maxCountK),
      sogNumber("region-splats", "Points per region (K)", 1, "1", maxCountK),
      sogNumber("root-splats", "Points in coarsest LOD (K)", 1, "1", maxCountK),
      sogNumber("lod-factor", "LOD reduction factor", 1, "0.1"),
      sogNumber("lod-density", "LOD density", 0, "0.05", 1),
    ],
    "Spherical harmonics": [
      sogNumber("max-sh", "Maximum SH degree", 0, "1", 4),
      numeric("sh-codebook", "SH codebook entries (K)", "", 1, "1", 256),
      sogNumber(
        "sh-iterations",
        "SH refinement iterations",
        0,
        "1",
        Number.MAX_SAFE_INTEGER,
      ),
    ],
    "Input attributes": [
      crop,
      {
        flag: "sog-blind",
        title: "Blind fields · one texture per line",
        multiline: true,
        placeholder: "temperature:f32",
      },
    ],
  },
  rad: {
    "Level of detail": [
      numeric("lod-base", "LOD spacing", 1.75, 1.1, "0.05", 16),
    ],
    "Spherical harmonics": [
      numeric("max-sh", "Maximum SH degree", 3, 0, "1", 3),
      numeric("sh-codebook", "SH codebook entries (K)", "", 0, "1", 256),
      numeric(
        "cluster-sh",
        "SH refinement iterations",
        10,
        0,
        "1",
        Number.MAX_SAFE_INTEGER,
      ),
    ],
    "Input attributes": [crop],
    "Chunk layout": [
      {
        flag: "rad-chunked",
        title: "Separate RAD chunk files",
        checkbox: true,
      },
    ],
  },
};
const saved = new Map();
let last;
export function options() {
  const values = {};
  for (const input of fields.querySelectorAll("[name]")) {
    const value =
      input.type === "checkbox" ? input.checked : input.value.trim();
    if (value)
      values[input.name] =
        input.name === "sog-blind"
          ? value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : value;
  }
  return values;
}

function setupDecimalInput(input) {
  const step = input.step;
  function update() {
    input.step = step;
    // A finer typed value needs a matching native step to pass form validation.
    if (input.validity.stepMismatch) {
      const [mantissa, exponent] = input.valueAsNumber
        .toExponential()
        .split("e");
      const decimals = mantissa.split(".")[1]?.length ?? 0;
      input.step = `1e${Number(exponent) - decimals}`;
    }
    if (input.name === "lod-factor")
      input.setCustomValidity(
        input.valueAsNumber === 1
          ? "LOD reduction factor must be greater than 1."
          : "",
      );
  }
  input.addEventListener("input", update);
  update();
}

function showOptions() {
  if (last) saved.set(last, options());
  last = outputFormat();
  document.querySelector("#settings-title").textContent =
    `${last.toUpperCase()} build settings`;
  document.querySelector("#convert").textContent =
    `Convert to ${last.toUpperCase()}`;
  fields.replaceChildren();
  for (const [title, groupFields] of Object.entries(settings[last])) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const group = document.createElement("div");
    group.className = "grid";
    fields.append(heading, group);
    for (const field of groupFields) {
      const label = document.createElement("label");
      const input = document.createElement(
        field.multiline ? "textarea" : "input",
      );
      input.name = field.flag;
      label.textContent = field.title;
      const value = saved.get(last)?.[field.flag] ?? field.value ?? "";
      if (field.checkbox) {
        input.type = "checkbox";
        input.checked = Boolean(value);
        label.className = "check";
        label.prepend(input);
      } else {
        if (field.min !== undefined) {
          input.type = "number";
          input.min = field.min;
          input.step = field.step;
          if (field.max !== undefined) input.max = field.max;
        }
        input.value = Array.isArray(value) ? value.join("\n") : value;
        if (field.step && Number(field.step) < 1) setupDecimalInput(input);
        input.placeholder = field.placeholder ?? "Automatic";
        label.append(input);
      }
      group.append(label);
    }
  }
}
document.querySelector("#format").addEventListener("change", showOptions);
showOptions();
