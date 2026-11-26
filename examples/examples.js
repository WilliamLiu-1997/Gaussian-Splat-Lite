import { examples } from "./catalog.js";

const list = document.querySelector("#example-list");
const stage = document.querySelector("#example-stage");
const sourceLink = document.querySelector("#example-source");
const toggle = document.querySelector("#sidebar-toggle");
const compact = window.matchMedia("(max-width: 640px)");
const sidebarKey = "gsl.examples.sidebarExpanded";
let preferredExpanded;

try {
  const stored = localStorage.getItem(sidebarKey);
  if (stored !== null) preferredExpanded = stored === "true";
} catch {
  // The gallery also works when browser storage is disabled.
}

function setExpanded(expanded) {
  document.body.classList.toggle("collapsed", !expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.title = expanded ? "Collapse sidebar" : "Expand sidebar";
  toggle.setAttribute("aria-label", toggle.title);
}

function restoreSidebar() {
  setExpanded(preferredExpanded ?? !compact.matches);
}

for (const { id, title, thumbnail } of examples) {
  const link = document.createElement("a");
  link.href = `#${id}`;
  link.title = title;
  link.setAttribute("aria-label", title);
  if (thumbnail) {
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = "";
    link.append(image);
  }
  const label = document.createElement("span");
  label.textContent = title;
  link.append(label);
  list.append(link);
}

function showExample() {
  const example =
    examples.find(({ id }) => id === location.hash.slice(1)) ?? examples[0];
  const hash = `#${example.id}`;
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
  for (const link of list.children) {
    if (link.hash === hash) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  document.title = `${example.title} · Examples · Gaussian Splat Lite`;
  const frame = document.createElement("iframe");
  frame.title = example.title;
  const directory = `examples/${example.id}`;
  frame.src = `./${directory}/`;
  sourceLink.href = `https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite/tree/main/examples/${directory}`;
  stage.replaceChildren(frame, sourceLink);
}

toggle.addEventListener("click", () => {
  preferredExpanded = toggle.getAttribute("aria-expanded") === "false";
  setExpanded(preferredExpanded);
  try {
    localStorage.setItem(sidebarKey, String(preferredExpanded));
  } catch {
    // Keep the choice in memory for this visit.
  }
});
list.addEventListener("click", (event) => {
  if (compact.matches && event.target.closest("a")) {
    setExpanded(false);
  }
});
compact.addEventListener("change", restoreSidebar);
window.addEventListener("hashchange", showExample);
restoreSidebar();
showExample();
