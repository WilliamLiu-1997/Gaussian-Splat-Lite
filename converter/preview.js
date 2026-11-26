import { modelFromEntries } from "../examples/viewer/modelSource.js";
import { loadFile, ui } from "../examples/viewer/viewer.js";
import { filesIn } from "./results.js";

for (const type of ["dragover", "drop"])
  window.addEventListener(type, (event) => event.preventDefault());

try {
  const directory = window.frameElement?.resultDirectory;
  if (!directory) throw new Error("Open Preview from the converter.");
  // Clone into the viewer realm so the files are local Blob instances.
  const { file, ...source } = await modelFromEntries(
    filesIn(structuredClone(directory)),
  );
  await loadFile(file, source);
} catch (error) {
  ui.showToast(`Could not open the conversion preview: ${error.message}`);
}
