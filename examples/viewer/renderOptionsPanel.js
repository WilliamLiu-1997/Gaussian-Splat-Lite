export function createRenderOptionsPanel({ container, groups, onChange }) {
  const document = container.ownerDocument;
  const entries = new Map();

  function createElement(tag, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    return element;
  }

  function getValue(property) {
    return entries.get(property)?.getValue();
  }

  function setValue(property, value, { emit = false } = {}) {
    entries.get(property).setValue(value);
    if (emit) onChange(property, getValue(property));
    syncDependencies(property, emit);
  }

  function setHidden(property, hidden) {
    const entry = entries.get(property);
    if (entry) entry.row.hidden = hidden;
  }

  function syncDependencies(changedProperty, emit = false) {
    const autoStochastic = getValue("autoStochastic") === true;
    if (changedProperty === "autoStochastic" && autoStochastic) {
      for (const property of ["stochastic", "renderDepth"]) {
        if (getValue(property) === true) setValue(property, false, { emit });
      }
    }
    setHidden("stochastic", autoStochastic);
    setHidden("renderDepth", autoStochastic);
    setHidden("minSortIntervalMs", getValue("synchronousSort") === true);
  }

  function createRow(option) {
    const { property } = option;
    const isToggle = typeof option.defaultValue === "boolean";
    const isSelect = Boolean(option.choices);
    const row = createElement("div", "option-row");
    const copy = createElement("div", "option-copy");
    const label = createElement("label");
    label.htmlFor = `render-option-${property}`;
    label.textContent = option.label ?? property;
    const description = createElement("p");
    description.textContent = option.description;
    copy.append(label, description);

    const control = createElement("div", "option-control");
    const input = createElement(
      isSelect ? "select" : "input",
      isSelect ? "select-input" : isToggle ? "toggle-input" : "range-input",
    );
    input.id = label.htmlFor;
    input.dataset.renderOption = property;
    let output;

    if (isSelect) {
      for (const [value, text] of option.choices) {
        const choice = createElement("option");
        choice.value = value;
        choice.textContent = text;
        input.append(choice);
      }
      control.append(input);
    } else {
      output = createElement(
        "output",
        isToggle ? "toggle-value" : "range-value",
      );
      output.setAttribute("for", input.id);
      input.type = isToggle ? "checkbox" : "range";
      control.append(output, input);
      if (isToggle) {
        row.classList.add("option-row-toggle");
        const toggle = createElement("label", "toggle-track");
        toggle.htmlFor = input.id;
        toggle.setAttribute("aria-hidden", "true");
        control.append(toggle);
      } else {
        input.min = String(option.min);
        input.max = String(option.max);
        input.step = String(option.step);
      }
    }

    const readValue = () =>
      isToggle ? input.checked : isSelect ? input.value : Number(input.value);
    const writeValue = (value) => {
      if (isToggle) input.checked = value;
      else input.value = String(value);
      if (output) {
        const current = readValue();
        output.value = isToggle
          ? current
            ? option.trueLabel
            : option.falseLabel
          : option.format(current);
      }
    };
    writeValue(option.defaultValue);
    input.addEventListener(isSelect || isToggle ? "change" : "input", () => {
      setValue(property, readValue(), { emit: true });
    });
    entries.set(property, {
      input,
      option,
      row,
      getValue: readValue,
      setValue: writeValue,
    });
    row.append(copy, control);
    return row;
  }

  for (const group of groups) {
    const section = createElement("section", "option-group");
    const heading = createElement("div", "option-group-heading");
    const title = createElement("h3");
    title.textContent = group.title;
    const description = createElement("p");
    description.textContent = group.description;
    heading.append(title, description);
    section.append(heading);
    for (const option of group.options) section.append(createRow(option));
    container.append(section);
  }
  syncDependencies();

  return {
    getValue,
    // Programmatic synchronization is silent unless emit is requested.
    setValue,
    setDisabled(property, disabled) {
      entries.get(property).input.disabled = disabled;
    },
    reset({ skip = [], last = [] } = {}) {
      const properties = [...entries.keys()].filter(
        (property) => !skip.includes(property),
      );
      // Restore every input before emitting changes that may read other values.
      for (const property of properties) {
        const entry = entries.get(property);
        entry.setValue(entry.option.defaultValue);
      }
      const order = [
        ...properties.filter((property) => !last.includes(property)),
        ...last.filter((property) => properties.includes(property)),
      ];
      for (const property of order) {
        onChange(property, getValue(property));
        syncDependencies(property, true);
      }
    },
  };
}
