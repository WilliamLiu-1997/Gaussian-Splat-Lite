export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }

  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export function showFileMeta(
  element,
  file,
  numSplats,
  { streamed = false } = {},
) {
  const size = file.size > 0 ? ` · ${formatBytes(file.size)}` : "";
  element.querySelector("#file-name").textContent = file.name;
  element.querySelector("#file-stats").textContent = streamed
    ? "Loading visible regions…"
    : `${numSplats.toLocaleString()} splats${size}`;
  element.hidden = false;
}
