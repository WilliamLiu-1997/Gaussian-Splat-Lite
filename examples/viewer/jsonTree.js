export function createJsonTree(expandedRoots = []) {
  const element = document.createElement("div");
  element.className = "json-tree";
  const roots = new Map();
  const initialExpanded = expandedRoots.map((name) => JSON.stringify([name]));
  const expanded = new Set(initialExpanded);

  function createNode(name, value, path) {
    const label = document.createElement("span");
    label.className = "json-key";
    label.textContent = `${name}: `;

    if (value === null || typeof value !== "object") {
      const row = document.createElement("div");
      row.append(
        label,
        typeof value === "string" ? JSON.stringify(value) : String(value),
      );
      return row;
    }

    const node = document.createElement("details");
    const summary = document.createElement("summary");
    summary.append(
      label,
      Array.isArray(value)
        ? `Array(${value.length})`
        : `Object(${Object.keys(value).length})`,
    );
    const children = document.createElement("div");
    children.className = "json-children";
    const key = JSON.stringify(path);
    let populated = false;

    function populate() {
      if (populated) return;
      populated = true;
      for (const [childName, childValue] of Object.entries(value)) {
        children.append(
          createNode(childName, childValue, [...path, childName]),
        );
      }
    }

    node.open = expanded.has(key);
    if (node.open) populate();
    node.addEventListener("toggle", () => {
      if (node.open) {
        expanded.add(key);
        populate();
      } else {
        expanded.delete(key);
      }
    });
    node.append(summary, children);
    return node;
  }

  return {
    element,
    update(data) {
      const nodes = [];
      for (const [name, value] of Object.entries(data)) {
        if (value === undefined) {
          roots.delete(name);
          continue;
        }
        let root = roots.get(name);
        if (!root || root.value !== value) {
          root = { value, node: createNode(name, value, [name]) };
          roots.set(name, root);
        }
        nodes.push(root.node);
      }
      element.replaceChildren(...nodes);
    },
    clear() {
      roots.clear();
      expanded.clear();
      for (const key of initialExpanded) expanded.add(key);
      element.replaceChildren();
    },
  };
}
