import { SplatMesh } from "gaussian-splat-lite";
import { Raycaster, Vector2 } from "three";

const PICK_INTERVAL_MS = 100;
const CLICK_DISTANCE_SQ = 25;

export function createBlindHover({ viewport, camera, model, view }) {
  const panel = document.createElement("section");
  panel.className = "blind-panel";
  panel.setAttribute("aria-label", view.title);
  panel.hidden = true;
  const title = document.createElement("strong");
  title.textContent = view.title;
  const close = document.createElement("button");
  close.className = "icon-button";
  close.type = "button";
  close.setAttribute("aria-label", "Close data panel");
  close.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>';
  const header = document.createElement("div");
  header.className = "blind-panel-header";
  header.append(title, close);
  const content = document.createElement("div");
  content.className = "blind-panel-content";
  content.append(view.element);
  panel.append(header, content);
  document.body.append(panel);

  const raycaster = new Raycaster();
  const coords = new Vector2();
  let pointer = null;
  let pending = false;
  let lastPick = Number.NEGATIVE_INFINITY;
  let press = null;
  let pinned = false;

  function stopHover() {
    pointer = null;
    pending = false;
    view.hover?.(null);
  }

  function hide() {
    stopHover();
    panel.hidden = true;
  }

  function clear() {
    hide();
    press = null;
    pinned = false;
    view.clearSelection?.();
  }

  function pin() {
    if (panel.hidden) return;
    pinned = true;
    view.pin?.();
    view.hover?.(null);
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
    const targets = [];
    model.traverseVisible((object) => {
      if (
        object instanceof SplatMesh &&
        object.raycastable &&
        object.numSplats > 0 &&
        object.opacity > 0
      )
        targets.push(object);
    });
    if (!targets.some(({ splats }) => view.canInspect(splats))) {
      view.hover?.(null);
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
      view.hover?.(null);
      panel.hidden = !pinned;
      return;
    }

    const { blind } = hit.object.splats.getSplat(hit.index, false);
    view.hover?.(select ? null : hit.object, blind, pinned);
    if (pinned && !select) return;
    panel.hidden = !view.show(hit.object, blind) && !pinned;
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
        (pinned && !view.hover)
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
      clear();
      panel.remove();
    },
  };
}
