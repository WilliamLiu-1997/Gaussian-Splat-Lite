import { SplatMesh } from "gaussian-splat-lite";
import { Raycaster, Vector2 } from "three";
import { createBlindHighlight } from "./blindHighlight.js";
import { createJsonTree } from "./jsonTree.js";

const PICK_INTERVAL_MS = 100;
const CLICK_DISTANCE_SQ = 25;

export function createBlindHover({
  viewport,
  camera,
  getModel,
  isExample,
  requestRender,
}) {
  const panel = document.createElement("section");
  panel.className = "blind-panel";
  panel.setAttribute("aria-label", "Blind data");
  panel.hidden = true;
  const title = document.createElement("strong");
  title.textContent = "Blind data";
  const close = document.createElement("button");
  close.className = "icon-button";
  close.type = "button";
  close.setAttribute("aria-label", "Close data panel");
  close.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>';
  const header = document.createElement("div");
  header.className = "blind-panel-header";
  header.append(title, close);
  const fields = document.createElement("dl");
  const tree = createJsonTree(["blind"]);
  const raw = tree.element;
  raw.hidden = true;
  const content = document.createElement("div");
  content.className = "blind-panel-content";
  content.append(fields, raw);
  panel.append(header, content);
  document.body.append(panel);

  const raycaster = new Raycaster();
  const coords = new Vector2();
  const hoverHighlight = createBlindHighlight(0.12, requestRender);
  const selectedHighlight = createBlindHighlight(0.3, requestRender);
  let pointer = null;
  let pending = false;
  let lastPick = Number.NEGATIVE_INFINITY;
  let inspectedModel = null;
  let press = null;
  let pinned = false;
  let displayedObject = null;

  function stopHover() {
    pointer = null;
    pending = false;
    hoverHighlight.clear();
  }

  function hide() {
    stopHover();
    panel.hidden = true;
  }

  function clear() {
    hide();
    press = null;
    pinned = false;
    displayedObject = null;
    selectedHighlight.clear();
  }

  function pin() {
    if (panel.hidden) return;
    pinned = true;
    selectedHighlight.set(displayedObject);
    hoverHighlight.clear();
  }

  function pressPointer(event) {
    stopHover();
    if (!pinned) panel.hidden = true;
    press =
      event.button === 0 && event.isPrimary
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  }

  function move(event) {
    if (
      press &&
      (event.clientX - press.x) ** 2 + (event.clientY - press.y) ** 2 >
        CLICK_DISTANCE_SQ
    )
      press = null;
    if (event.pointerType === "touch" || event.buttons !== 0) {
      stopHover();
      if (!pinned) panel.hidden = true;
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    pending = true;
  }

  function releasePointer(event) {
    const clicked =
      press?.id === event.pointerId &&
      event.button === 0 &&
      (event.clientX - press.x) ** 2 + (event.clientY - press.y) ** 2 <=
        CLICK_DISTANCE_SQ;
    press = null;
    if (!clicked) {
      move(event);
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    pending = false;
    pick(true);
    pin();
  }

  function leave(event) {
    stopHover();
    if (!pinned && !panel.contains(event.relatedTarget)) panel.hidden = true;
  }

  function cancelPointer() {
    press = null;
    stopHover();
    if (!pinned) panel.hidden = true;
  }

  function pinPanel(event) {
    if (!close.contains(event.target)) pin();
  }

  viewport.addEventListener("pointermove", move);
  viewport.addEventListener("pointerup", releasePointer);
  viewport.addEventListener("pointerdown", pressPointer);
  viewport.addEventListener("pointerleave", leave);
  viewport.addEventListener("pointercancel", cancelPointer);
  panel.addEventListener("click", pinPanel);
  panel.addEventListener("pointerleave", cancelPointer);
  window.addEventListener("blur", cancelPointer);
  close.addEventListener("click", clear);

  function pick(select = false) {
    const model = getModel();
    if (model !== inspectedModel) {
      tree.clear();
      inspectedModel = model;
    }
    const example = isExample();
    const targets = [];
    model?.traverseVisible((object) => {
      if (
        object instanceof SplatMesh &&
        object.raycastable &&
        object.numSplats > 0 &&
        object.opacity > 0
      )
        targets.push(object);
    });
    if (
      !targets.some(
        ({ splats }) =>
          splats.blindFields.length > 0 ||
          (!example &&
            (splats.extra !== undefined || splats.sceneExtra !== undefined)),
      )
    ) {
      hoverHighlight.clear();
      panel.hidden = !pinned;
      return;
    }

    const rect = viewport.getBoundingClientRect();
    coords.set(
      ((pointer.x - rect.left) / rect.width) * 2 - 1,
      1 - ((pointer.y - rect.top) / rect.height) * 2,
    );
    camera.updateWorldMatrix(true, false);
    model.updateWorldMatrix(true, true);
    raycaster.setFromCamera(coords, camera);
    raycaster.near = camera.near;
    raycaster.far = camera.far;
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) {
      hoverHighlight.clear();
      panel.hidden = !pinned;
      return;
    }

    const splats = hit.object.splats;
    const { blind } = splats.getSplat(hit.index, false);
    const { extra, sceneExtra } = splats;
    const object = example
      ? { mesh: hit.object, value: blind.object_id }
      : null;
    const selected =
      pinned &&
      object?.mesh === displayedObject?.mesh &&
      object?.value === displayedObject?.value;
    hoverHighlight.set(select || selected ? null : object);
    if (pinned && !select) return;

    const entries = Object.entries(blind ?? {});
    const empty =
      entries.length === 0 &&
      (example || (extra === undefined && sceneExtra === undefined));
    if (empty) {
      panel.hidden = !pinned;
      return;
    }
    panel.hidden = false;
    displayedObject = object;

    title.textContent = example ? "Blind data" : "Splat data";
    panel.setAttribute("aria-label", title.textContent);
    fields.hidden = !example;
    raw.hidden = example;
    if (!example) {
      tree.update({ blind, extra, sceneExtra });
      return;
    }

    const labeling = extra?.labeling;
    const sceneLabeling = sceneExtra?.labeling;
    const names = {
      object_id: labeling?.objects ?? sceneLabeling?.objects,
      part_id: labeling?.parts ?? sceneLabeling?.parts,
    };
    fields.replaceChildren();
    for (const [name, value] of entries) {
      const label = document.createElement("dt");
      const data = document.createElement("dd");
      const records = names[name];
      const displayName = Array.isArray(records)
        ? records.find((record) => record?.[name] === value)?.name
        : undefined;
      label.textContent = name;
      data.textContent =
        typeof displayName === "string" && displayName
          ? `${displayName} (${value})`
          : String(value);
      fields.append(label, data);
    }
  }

  return {
    clear,
    invalidate() {
      pending = true;
    },
    update(time) {
      if (
        !pointer ||
        !pending ||
        time - lastPick < PICK_INTERVAL_MS ||
        (pinned && !isExample())
      )
        return;
      pending = false;
      lastPick = time;
      pick();
    },
    dispose() {
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", releasePointer);
      viewport.removeEventListener("pointerdown", pressPointer);
      viewport.removeEventListener("pointerleave", leave);
      viewport.removeEventListener("pointercancel", cancelPointer);
      panel.removeEventListener("click", pinPanel);
      panel.removeEventListener("pointerleave", cancelPointer);
      window.removeEventListener("blur", cancelPointer);
      close.removeEventListener("click", clear);
      hoverHighlight.clear();
      selectedHighlight.clear();
      tree.clear();
      panel.remove();
    },
  };
}
