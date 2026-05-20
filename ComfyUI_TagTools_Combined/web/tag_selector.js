import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ComfyUITagSelectorPrompts";
const STATE_WIDGET = "prompt";
const LEGACY_STATE_WIDGET = "selected_tags";
const UI_STATE_PROPERTY = "tag_selector_ui";
const STEP = 0.1;
const DEFAULT_WIDGET_HEIGHT = 520;
const NODE_CHROME_HEIGHT = 70;
const DEFAULT_OUTPUT_HEIGHT = 76;
const MIN_OUTPUT_HEIGHT = 52;
const MAX_OUTPUT_HEIGHT = 320;

let tagTreePromise = null;

function ensureStylesheet() {
  const id = "comfy-tag-selector-styles";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = new URL("./tag_selector.css", import.meta.url).href;
  document.head.append(link);
}

function isNativeControl(target) {
  return Boolean(target?.closest?.("input, textarea"));
}

function stopComfyEvent(event) {
  if (!event) return;
  if (!isNativeControl(event.target)) event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

function loadTagTree() {
  if (!tagTreePromise) {
    tagTreePromise = api.fetchApi("/tag_selector/tags").then((response) => {
      if (!response.ok) {
        throw new Error(`Tag selector metadata request failed: ${response.status}`);
      }
      return response.json();
    });
  }
  return tagTreePromise;
}

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "");
}

function fuzzyIncludes(haystack, needle) {
  const text = normalizeSearch(haystack);
  const query = normalizeSearch(needle);
  if (!query) return true;
  return text.includes(query);
}

function isTagLeaf(value) {
  return typeof value === "string" || Array.isArray(value);
}

function toChinese(value) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return String(value ?? "");
}

function pathKey(path) {
  return path.join("\u0001");
}

function samePath(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function getNodeAtPath(tree, path) {
  let cursor = tree;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return {};
    cursor = cursor[key];
  }
  return cursor && typeof cursor === "object" && !Array.isArray(cursor) ? cursor : {};
}

function getFolderEntries(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  return Object.entries(node).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value));
}

function countVisible(node) {
  let folders = 0;
  let tags = 0;
  if (!node || typeof node !== "object" || Array.isArray(node)) return { folders, tags };

  for (const value of Object.values(node)) {
    if (isTagLeaf(value)) tags += 1;
    else if (value && typeof value === "object") folders += 1;
  }
  return { folders, tags };
}

function flattenTags(tree, path = [], output = []) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return output;

  for (const [key, value] of Object.entries(tree)) {
    if (isTagLeaf(value)) {
      const tag = String(key);
      const cn = toChinese(value);
      output.push({ tag, cn, path, searchText: `${tag} ${cn} ${path.join(" ")}` });
    } else if (value && typeof value === "object") {
      flattenTags(value, [...path, String(key)], output);
    }
  }
  return output;
}

function parseStateValue(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeState(widget, state) {
  if (widget) widget.value = JSON.stringify(state);
}

function formatWeight(weight) {
  const value = Number(weight);
  return Number.isFinite(value) ? value.toFixed(1) : "1.0";
}

function hasCustomWeight(weight) {
  const value = Number(weight ?? 1);
  return Number.isFinite(value) && Math.abs(value - 1) > 0.0001;
}

function buildPromptText(items) {
  return items
    .filter((item) => item.enabled !== false)
    .map((item) => {
      const tag = String(item.tag ?? "").trim().toLowerCase();
      if (!tag) return "";
      return hasCustomWeight(item.weight) ? `(${tag}:${formatWeight(item.weight)})` : tag;
    })
    .filter(Boolean)
    .join(", ");
}

function readUiState(node) {
  const state = node.properties?.[UI_STATE_PROPERTY];
  return state && typeof state === "object" && !Array.isArray(state) ? state : {};
}

function normalizePath(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function getNodeWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function readWidgetState(node, widget) {
  const candidates = [widget?.value];
  const index = node.widgets?.indexOf(widget) ?? -1;
  if (Array.isArray(node.widgets_values) && index >= 0) {
    candidates.push(node.widgets_values[index]);
  }

  const legacyWidget = getNodeWidget(node, LEGACY_STATE_WIDGET);
  const legacyIndex = node.widgets?.indexOf(legacyWidget) ?? -1;
  candidates.push(legacyWidget?.value);
  if (Array.isArray(node.widgets_values) && legacyIndex >= 0) {
    candidates.push(node.widgets_values[legacyIndex]);
  }

  let fallback = [];
  for (const candidate of candidates) {
    const parsed = parseStateValue(candidate);
    if (!parsed) continue;
    if (parsed.length) return parsed;
    fallback = parsed;
  }
  return fallback;
}

function hideWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  widget.type = "hidden";
  widget.serialize = true;
  widget.computeSize = () => [0, 0];
  widget.serializeValue = () => widget.value;
}

function ensureStateWidget(node) {
  let widget = getNodeWidget(node, STATE_WIDGET);
  const legacyWidget = getNodeWidget(node, LEGACY_STATE_WIDGET);
  if (widget && legacyWidget && (!widget.value || widget.value === "[]")) {
    widget.value = legacyWidget.value || "[]";
  }
  if (!widget && typeof node.addWidget === "function") {
    widget = node.addWidget("text", STATE_WIDGET, "[]", null, { serialize: true });
  }
  return widget;
}

function createTagSelector(node) {
  ensureStylesheet();
  node.serialize_widgets = true;

  const stateWidget = ensureStateWidget(node);
  for (const widget of node.widgets ?? []) hideWidget(widget);
  if (stateWidget) stateWidget.serializeValue = () => stateWidget.value;

  let tree = {};
  let flatTags = [];
  let currentPath = [];
  let query = "";
  let selected = readWidgetState(node, stateWidget);
  let outputHeight = DEFAULT_OUTPUT_HEIGHT;
  let selectorHeight = DEFAULT_WIDGET_HEIGHT;
  const expanded = new Set();

  const root = createElement("div", "cts-root");
  const outputHeader = createElement("div", "cts-output-header");
  const clearButton = createElement("button", "cts-clear", "");
  const outputShell = createElement("div", "cts-output-shell");
  const output = createElement("div", "cts-output");
  const outputHandle = createElement("button", "cts-output-resize", "");
  const search = createElement("input", "cts-search");
  const body = createElement("div", "cts-body");
  const treePanel = createElement("div", "cts-folders");
  const tagsPanel = createElement("div", "cts-tags");
  const status = createElement("div", "cts-status", "Loading tags...");

  search.type = "search";
  search.placeholder = "Search tags";
  clearButton.type = "button";
  clearButton.title = "Clear selected tags";
  outputHandle.type = "button";
  outputHandle.title = "Resize selected tags";

  outputHeader.append(outputShell, clearButton);
  outputShell.append(output, outputHandle);
  body.append(treePanel, tagsPanel);
  root.append(outputHeader, search, body, status);

  for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
    root.addEventListener(eventName, stopComfyEvent);
  }

  const widget = node.addDOMWidget("tag_selector_ui", "tag_selector_ui", root, {
    serialize: false,
    hideOnZoom: false,
  });

  widget.computeSize = (width) => [width || 560, selectorHeight];

  function saveUiState() {
    node.properties = node.properties || {};
    node.properties[UI_STATE_PROPERTY] = {
      currentPath: [...currentPath],
      expanded: [...expanded],
      outputHeight,
    };
    node.setDirtyCanvas(true, true);
  }

  function syncSelectorHeight(resizeNode = false) {
    const nextHeight = DEFAULT_WIDGET_HEIGHT + Math.max(0, outputHeight - DEFAULT_OUTPUT_HEIGHT);
    if (nextHeight === selectorHeight) return;
    selectorHeight = nextHeight;
    if (resizeNode && Array.isArray(node.size) && typeof node.setSize === "function") {
      const targetNodeHeight = selectorHeight + NODE_CHROME_HEIGHT;
      if (Math.abs(Number(node.size[1] ?? 0) - targetNodeHeight) > 1) {
        node.setSize([node.size[0], targetNodeHeight]);
      }
    }
  }

  function outputHeightLimit() {
    const expandedHeight = DEFAULT_WIDGET_HEIGHT + Math.max(0, MAX_OUTPUT_HEIGHT - DEFAULT_OUTPUT_HEIGHT);
    return Math.max(MIN_OUTPUT_HEIGHT, Math.min(MAX_OUTPUT_HEIGHT, expandedHeight - 190));
  }

  function applyOutputHeight(height, persist = false, resizeNode = false) {
    outputHeight = Math.max(MIN_OUTPUT_HEIGHT, Math.min(outputHeightLimit(), Math.round(height)));
    syncSelectorHeight(resizeNode);
    outputShell.style.setProperty("--cts-output-height", `${outputHeight}px`);
    if (persist) saveUiState();
    node.setDirtyCanvas(true, true);
  }

  applyOutputHeight(outputHeight);

  function commit() {
    const serialized = JSON.stringify(selected);
    serializeState(stateWidget, selected);
    node.properties = node.properties || {};
    node.properties.prompt = buildPromptText(selected);
    if (stateWidget) {
      stateWidget.value = serialized;
    }
    if (Array.isArray(node.widgets_values)) {
      const index = node.widgets?.indexOf(stateWidget) ?? -1;
      if (index >= 0) {
        node.widgets_values[index] = serialized;
      }
    } else if (stateWidget) {
      node.widgets_values = node.widgets?.map((widget) => widget.value) ?? [serialized];
    }
    node.setDirtyCanvas(true, true);
  }

  function syncRestoredState() {
    const serialized = JSON.stringify(selected);
    serializeState(stateWidget, selected);
    node.properties = node.properties || {};
    node.properties.prompt = buildPromptText(selected);
    if (Array.isArray(node.widgets_values)) {
      const index = node.widgets?.indexOf(stateWidget) ?? -1;
      if (index >= 0) {
        node.widgets_values[index] = serialized;
      }
    }
  }

  function restoreSavedState() {
    selected = readWidgetState(node, stateWidget);
    syncRestoredState();
    restoreUiState();
    renderOutput();
    renderFolders();
    renderTags();
  }

  node.__tagSelectorRestoreState = restoreSavedState;

  function findSelected(tag) {
    return selected.find((item) => item.tag === tag);
  }

  function visibleNode() {
    return getNodeAtPath(tree, currentPath);
  }

  function visibleTags() {
    return Object.entries(visibleNode())
      .filter(([, value]) => isTagLeaf(value))
      .map(([key, value]) => ({ tag: String(key), cn: toChinese(value), path: [...currentPath] }));
  }

  function searchableTags() {
    return flattenTags(visibleNode(), [...currentPath]);
  }

  function addTag(tagItem) {
    if (findSelected(tagItem.tag)) return;
    selected.push({
      tag: tagItem.tag,
      cn: tagItem.cn,
      path: tagItem.path,
      weight: 1,
      enabled: true,
    });
    commit();
    renderOutput();
    renderTags();
  }

  function removeTag(tag) {
    selected = selected.filter((item) => item.tag !== tag);
    commit();
    renderOutput();
    renderTags();
  }

  function clearSelectedTags() {
    if (!selected.length) return;
    selected = [];
    commit();
    renderOutput();
    renderTags();
  }

  function toggleEnabled(tag) {
    const item = findSelected(tag);
    if (!item) return;
    item.enabled = !item.enabled;
    commit();
    renderOutput();
    renderTags();
  }

  function changeWeight(tag, delta) {
    const item = findSelected(tag);
    if (!item) return;
    const next = Math.round((Number(item.weight ?? 1) + delta) * 10) / 10;
    item.weight = Math.max(-5, Math.min(5, next));
    commit();
    renderOutput();
    renderTags();
  }

  function renderOutput() {
    output.replaceChildren();
    if (!selected.length) {
      output.append(createElement("div", "cts-empty", "No tags selected"));
      return;
    }

    for (const item of selected) {
      const chip = createElement("span", `cts-chip ${item.enabled === false ? "is-disabled" : ""}`);
      const customWeight = hasCustomWeight(item.weight);
      if (customWeight) chip.classList.add("has-weight");
      chip.title = "Scroll to adjust weight";

      const main = createElement("button", "cts-chip-main");
      main.type = "button";
      main.title = item.enabled === false ? "Enable" : "Disable";
      main.append(createElement("span", "cts-chip-en", item.tag));
      main.append(createElement("span", "cts-chip-cn", item.cn || item.tag));

      const weight = createElement("span", "cts-weight", formatWeight(item.weight));
      weight.title = "Scroll to adjust weight";
      weight.hidden = !customWeight;

      const close = createElement("button", "cts-close", "");
      close.type = "button";
      close.title = "Remove";
      chip.append(main, weight, close);

      main.addEventListener("click", (event) => {
        stopComfyEvent(event);
        toggleEnabled(item.tag);
      });
      chip.addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          changeWeight(item.tag, event.deltaY < 0 ? STEP : -STEP);
        },
        { passive: false },
      );
      close.addEventListener("click", (event) => {
        stopComfyEvent(event);
        removeTag(item.tag);
      });
      output.append(chip);
    }
  }

  function setCurrentPath(path) {
    currentPath = [...path];
  }

  function pathExists(path) {
    if (!path.length) return true;
    let cursor = tree;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !(key in cursor)) return false;
      cursor = cursor[key];
    }
    return Boolean(cursor && typeof cursor === "object" && !Array.isArray(cursor));
  }

  function restoreUiState() {
    const restoredUiState = readUiState(node);
    const nextPath = normalizePath(restoredUiState.currentPath);
    if (nextPath.length && !Object.keys(tree).length) {
      applyOutputHeight(restoredUiState.outputHeight ?? outputHeight, false, true);
      return;
    }

    currentPath = pathExists(nextPath) ? nextPath : [];

    expanded.clear();
    for (const key of Array.isArray(restoredUiState.expanded) ? restoredUiState.expanded : []) {
      if (typeof key === "string") expanded.add(key);
    }
    if (currentPath.length && !expanded.size) {
      setExpandedBranch(currentPath, false);
    }

    applyOutputHeight(restoredUiState.outputHeight ?? outputHeight, false, true);
  }

  function setExpandedBranch(path, includeCurrent) {
    expanded.clear();
    const depth = includeCurrent ? path.length : path.length - 1;
    for (let index = 1; index <= depth; index += 1) {
      expanded.add(pathKey(path.slice(0, index)));
    }
  }

  function renderTreeBranch(node, path, depth, fragment) {
    for (const [name, child] of getFolderEntries(node)) {
      const nextPath = [...path, String(name)];
      const key = pathKey(nextPath);
      const isExpanded = expanded.has(key);
      const isActive = samePath(currentPath, nextPath);
      const childFolders = getFolderEntries(child);
      const hasChildren = childFolders.length > 0;
      const row = createElement("button", `cts-tree-row ${isActive ? "is-active" : ""}`);
      row.type = "button";
      row.style.setProperty("--depth", String(depth + 1));

      row.append(createElement("span", `cts-tree-caret ${hasChildren ? (isExpanded ? "is-open" : "") : "is-hidden"}`, ""));
      row.append(createElement("span", "cts-tree-label", String(name)));
      row.addEventListener("click", (event) => {
        stopComfyEvent(event);
        setCurrentPath(nextPath);
        if (hasChildren) {
          if (isExpanded) {
            setExpandedBranch(nextPath, false);
          } else {
            setExpandedBranch(nextPath, true);
          }
        } else {
          setExpandedBranch(nextPath, false);
        }
        saveUiState();
        render();
      });
      fragment.append(row);

      if (hasChildren && isExpanded) {
        renderTreeBranch(child, nextPath, depth + 1, fragment);
      }
    }
  }

  function renderFolders() {
    treePanel.replaceChildren();
    const allButton = createElement("button", `cts-tree-row cts-tree-root ${currentPath.length ? "" : "is-active"}`);
    allButton.type = "button";
    allButton.style.setProperty("--depth", "0");
    allButton.append(createElement("span", "cts-tree-caret is-hidden", ""));
    allButton.append(createElement("span", "cts-tree-label", "All"));
    allButton.addEventListener("click", (event) => {
      stopComfyEvent(event);
      expanded.clear();
      currentPath = [];
      saveUiState();
      render();
    });
    treePanel.append(allButton);

    const fragment = document.createDocumentFragment();
    renderTreeBranch(tree, [], 0, fragment);
    treePanel.append(fragment);
  }

  function renderTags() {
    tagsPanel.replaceChildren();

    const selectedCount = selected.filter((item) => item.enabled !== false).length;
    const totalCount = flatTags.length;
    let tags = [];
    if (query.trim()) {
      const terms = query.split(/\s+/).filter(Boolean);
      tags = searchableTags().filter((item) => terms.every((term) => fuzzyIncludes(item.searchText, term)));
      status.textContent = `${selectedCount} selected / ${tags.length} results`;
    } else {
      tags = visibleTags();
      status.textContent = `${selectedCount} selected / ${totalCount} tags`;
    }

    for (const item of tags) {
      const selectedItem = findSelected(item.tag);
      const row = createElement(
        "button",
        `cts-tag ${selectedItem && selectedItem.enabled !== false ? "is-selected" : ""} ${selectedItem?.enabled === false ? "is-disabled" : ""}`,
      );
      row.type = "button";

      const text = createElement("span", "cts-tag-text");
      text.append(createElement("span", "cts-tag-en", item.tag));
      text.append(createElement("span", "cts-tag-cn", item.cn || item.tag));
      row.append(text);

      if (selectedItem && hasCustomWeight(selectedItem.weight)) {
        row.append(createElement("span", "cts-tag-marker", formatWeight(selectedItem.weight)));
      } else if (!selectedItem) {
        row.append(createElement("span", "cts-tag-marker", "+"));
      }

      row.addEventListener("click", (event) => {
        stopComfyEvent(event);
        if (selectedItem) {
          removeTag(item.tag);
        } else {
          addTag(item);
        }
      });
      tagsPanel.append(row);
    }
  }

  function render() {
    renderOutput();
    renderFolders();
    renderTags();
  }

  search.addEventListener("input", () => {
    query = search.value;
    renderTags();
  });

  clearButton.addEventListener("click", (event) => {
    stopComfyEvent(event);
    clearSelectedTags();
  });

  outputHandle.addEventListener("pointerdown", (event) => {
    stopComfyEvent(event);
    outputHandle.setPointerCapture?.(event.pointerId);
    outputHandle.classList.add("is-resizing");
    const startY = event.clientY;
    const startHeight = outputHeight;

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      moveEvent.stopPropagation();
      applyOutputHeight(startHeight + moveEvent.clientY - startY, false, true);
    };

    const onDone = (doneEvent) => {
      doneEvent.preventDefault();
      doneEvent.stopPropagation();
      if (outputHandle.hasPointerCapture?.(doneEvent.pointerId)) {
        outputHandle.releasePointerCapture?.(doneEvent.pointerId);
      }
      outputHandle.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onDone, true);
      window.removeEventListener("pointercancel", onDone, true);
      outputHandle.removeEventListener("lostpointercapture", onDone);
      saveUiState();
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onDone, true);
    window.addEventListener("pointercancel", onDone, true);
    outputHandle.addEventListener("lostpointercapture", onDone);
  });

  loadTagTree()
    .then((data) => {
      tree = data || {};
      flatTags = flattenTags(tree);
      selected = readWidgetState(node, stateWidget);
      syncRestoredState();
      restoreUiState();
      render();
    })
    .catch((error) => {
      status.textContent = error.message;
    });
}

app.registerExtension({
  name: "comfy.tag.selector",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      createTagSelector(this);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      this.__tagSelectorRestoreState?.();
      return result;
    };
  },
});
