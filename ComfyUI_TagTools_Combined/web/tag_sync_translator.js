import { app } from "/scripts/app.js";

const EXTENSION_NAME = "Comfy.DanbooruTagSyncTranslator";
const STYLE_ID = "danbooru-tag-sync-translator-style";
const MIN_PANEL_HEIGHT = 40;
const DEFAULT_PANEL_HEIGHT = 80;
const PANEL_BOTTOM_PADDING = 6;
const WIDGET_BOTTOM_RESERVE = 8;
const MIN_NODE_WIDTH = 340;
const NODE_NAMES = new Set(["DanbooruTagSyncTranslator", "Danbooru Tag Sync Translator"]);

console.info("[DanbooruTagSyncTranslator] extension loaded");

let dictionaryPromise = null;

function installStyle() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .danbooru-tag-sync-panel {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            overflow: hidden;
            padding: 3px;
            border-radius: 6px;
            background: rgba(18, 22, 26, 0.62);
            border: 1px solid var(--border-color);
            color: var(--fg-color);
            font-family: Arial, "Microsoft YaHei", sans-serif;
        }
        .danbooru-tag-sync-list {
            display: flex;
            flex-wrap: wrap;
            gap: 3px;
            align-items: flex-start;
            align-content: flex-start;
            flex: 1 1 auto;
            min-height: 0;
            overflow-x: hidden;
            overflow-y: auto;
            scrollbar-width: thin;
        }
        .danbooru-tag-sync-empty {
            padding: 6px;
            color: #94a3b8;
            font-size: 12px;
        }
        .danbooru-tag-sync-item {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            max-width: 168px;
            min-height: 24px;
            padding: 2px 3px 2px 5px;
            overflow: hidden;
            color: #f4f7fb;
            background: #23527f;
            border: 1px solid #6ba4d8;
            border-radius: 5px;
            cursor: pointer;
        }
        .danbooru-tag-sync-item.is-muted {
            color: #aeb6c2;
            background: #33383f;
            border-color: #5a626d;
            opacity: 0.72;
        }
        .danbooru-tag-sync-main {
            flex: 0 1 auto;
            min-width: 0;
            max-width: 132px;
            padding: 0;
            border: 0;
            background: transparent;
            color: inherit;
            cursor: pointer;
            text-align: left;
            font: inherit;
        }
        .danbooru-tag-sync-item.has-weight .danbooru-tag-sync-main {
            max-width: 112px;
        }
        .danbooru-tag-sync-tag,
        .danbooru-tag-sync-translation {
            display: block;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .danbooru-tag-sync-tag {
            color: inherit;
            font-size: 10px;
            font-weight: 700;
            line-height: 11px;
        }
        .danbooru-tag-sync-translation {
            color: rgba(255, 255, 255, 0.78);
            font-size: 8px;
            line-height: 9px;
        }
        .danbooru-tag-sync-weight {
            flex: 0 0 auto;
            min-width: 20px;
            padding: 1px 3px;
            color: #dceeff;
            background: rgba(0, 0, 0, 0.24);
            border-radius: 3px;
            font-size: 9px;
            line-height: 10px;
            text-align: center;
            font-variant-numeric: tabular-nums;
            cursor: default;
        }
        .danbooru-tag-sync-remove {
            flex: 0 0 auto;
            position: relative;
            width: 14px;
            height: 14px;
            border: 0;
            border-radius: 3px;
            background: transparent;
            cursor: pointer;
            font-size: 0;
        }
        .danbooru-tag-sync-remove::before,
        .danbooru-tag-sync-remove::after {
            position: absolute;
            top: 6px;
            left: 3px;
            width: 8px;
            height: 1px;
            background: rgba(255, 255, 255, 0.82);
            content: "";
        }
        .danbooru-tag-sync-remove::before {
            transform: rotate(45deg);
        }
        .danbooru-tag-sync-remove::after {
            transform: rotate(-45deg);
        }
        .danbooru-tag-sync-remove:hover {
            background: rgba(0, 0, 0, 0.22);
        }
    `;
    document.head.appendChild(style);
}

function loadDictionary() {
    if (!dictionaryPromise) {
        dictionaryPromise = fetch("/tag_sync_translator/dictionary")
            .then((response) => response.ok ? response.json() : {})
            .then((data) => {
                const map = new Map();
                for (const [key, value] of Object.entries(data || {})) {
                    const normalized = normalizeKey(key);
                    if (normalized) {
                        map.set(normalized, String(value));
                    }
                }
                return map;
            })
            .catch(() => new Map());
    }
    return dictionaryPromise;
}

function normalizeKey(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replaceAll("\\(", "(")
        .replaceAll("\\)", ")")
        .replaceAll("_", " ")
        .replace(/\s+/g, " ");
}

function normalizeTagText(value) {
    return String(value || "")
        .replaceAll("\\(", "(")
        .replaceAll("\\)", ")")
        .trim();
}

function parseState(value) {
    if (!value) {
        return { version: 2, source: "", overrides: {} };
    }

    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
            const legacyOverrides = { ...parsed };
            delete legacyOverrides.version;
            delete legacyOverrides.source;
            delete legacyOverrides.overrides;

            parsed.version = parsed.version || 2;
            parsed.source = String(parsed.source || "");
            parsed.overrides = parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : legacyOverrides;
            return parsed;
        }
    } catch {
        // Invalid serialized state is ignored and rebuilt from upstream text.
    }

    return { version: 2, source: "", overrides: {} };
}

function isSelected(override) {
    if (!override || typeof override !== "object") {
        return true;
    }
    if ("selected" in override) {
        return !!override.selected;
    }
    if ("disabled" in override) {
        return !override.disabled;
    }
    return true;
}

function formatWeight(value) {
    const number = Number.isFinite(value) ? value : 1;
    return Number(number.toFixed(1)).toString();
}

function hasCustomWeight(value) {
    const number = Number(value ?? 1);
    return Number.isFinite(number) && Math.abs(number - 1) >= 0.0005;
}

function parseTags(source, dictionary) {
    return String(source || "")
        .split(/[,，、]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((raw) => {
            let tag = raw;
            let weight = 1;
            const weighted = raw.match(/^\((.*):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$/);
            if (weighted) {
                tag = weighted[1].trim();
                weight = Number(weighted[2]);
            }

            tag = normalizeTagText(tag);
            const key = normalizeKey(tag);
            return {
                key,
                tag,
                weight: Number.isFinite(weight) ? weight : 1,
                translation: dictionary.get(key) || tag,
            };
        })
        .filter((item) => item.tag);
}

function hideWidget(widget) {
    if (!widget) {
        return;
    }

    widget.hidden = true;
    widget.computeSize = () => [0, 0];
    widget.serializeValue = () => widget.value || "";
    widget.type = "hidden";
}

function commitWidgetValue(node, widget) {
    if (!widget) {
        return;
    }

    if (Array.isArray(node.widgets_values)) {
        const index = node.widgets?.indexOf(widget) ?? -1;
        if (index >= 0) {
            node.widgets_values[index] = widget.value || "";
        }
    } else {
        node.widgets_values = node.widgets?.map((item) => item.value) ?? [];
    }
}

function readStringWidget(node) {
    const widgets = node?.widgets || [];
    const preferred = widgets.find((widget) => {
        const value = widget.value;
        const name = String(widget.name || "").toLowerCase();
        return typeof value === "string" && (name.includes("text") || name.includes("tag") || name.includes("prompt"));
    });

    if (preferred) {
        return preferred.value || "";
    }

    const fallback = widgets.find((widget) => typeof widget.value === "string");
    return fallback ? fallback.value || "" : "";
}

function readLinkedText(node) {
    normalizeInputs(node);
    const input = node.inputs?.find((item) => item.name === "tags");
    if (!input?.link || !app.graph?.links) {
        return readStringWidget(node);
    }

    const link = app.graph.links[input.link];
    const origin = link ? app.graph.getNodeById(link.origin_id) : null;
    return readStringWidget(origin);
}

function removeInputLink(node, input, index) {
    const linkId = input?.link;
    if (linkId == null) {
        return;
    }

    if (typeof node?.disconnectInput === "function" && Number.isInteger(index) && index >= 0) {
        node.disconnectInput(index);
        return;
    }

    app.graph?.removeLink?.(linkId);
    input.link = null;
}

function isCanonicalTagInput(input) {
    return input && input.name === "tags";
}

function isRemovableTagSyncInput(input) {
    const name = String(input?.name || "");
    return name === "" || name === "state" || name === "tag_buttons" || name === "danbooru_tag_buttons";
}

function normalizeInputs(node) {
    const inputs = node?.inputs;
    if (!Array.isArray(inputs)) {
        return;
    }

    const tagInputs = inputs.filter(isCanonicalTagInput);
    if (!tagInputs.length) {
        return;
    }

    const keeper = tagInputs[tagInputs.length - 1];
    const transferredLink =
        keeper.link ??
        tagInputs.find((input) => input.link != null)?.link ??
        inputs.find((input) => isRemovableTagSyncInput(input) && input?.link != null)?.link ??
        null;
    const nextInputs = [];

    for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        if (input === keeper) {
            nextInputs.push(input);
            continue;
        }

        if (!isCanonicalTagInput(input) && !isRemovableTagSyncInput(input)) {
            nextInputs.push(input);
            continue;
        }

        if (input?.link != null && input.link !== transferredLink) {
            removeInputLink(node, input, index);
        }
    }

    keeper.name = "tags";
    keeper.type = keeper.type || "STRING";
    keeper.link = transferredLink;
    if (keeper.label == null || keeper.label === "") {
        delete keeper.label;
    }

    if (!nextInputs.includes(keeper)) {
        nextInputs.push(keeper);
    }

    node.inputs = nextInputs;

    const targetSlot = node.inputs.indexOf(keeper);
    if (keeper.link != null && app.graph?.links?.[keeper.link]) {
        app.graph.links[keeper.link].target_slot = targetSlot;
    }
}

function getTagPanelTop(widget) {
    const widgetTop = Number(widget?.last_y);
    return Number.isFinite(widgetTop) && widgetTop > 0 ? widgetTop : 88;
}

function getTagPanelHeightFromContent(panel) {
    const list = panel?.querySelector?.(".danbooru-tag-sync-list");
    if (!list) {
        return DEFAULT_PANEL_HEIGHT;
    }

    const style = window.getComputedStyle(panel);
    const verticalChrome =
        Number.parseFloat(style.paddingTop || "0") +
        Number.parseFloat(style.paddingBottom || "0") +
        Number.parseFloat(style.borderTopWidth || "0") +
        Number.parseFloat(style.borderBottomWidth || "0");

    return clampTagPanelHeight(list.scrollHeight + verticalChrome);
}

function clampTagPanelHeight(height) {
    const value = Number(height);
    if (!Number.isFinite(value)) {
        return DEFAULT_PANEL_HEIGHT;
    }
    return Math.max(MIN_PANEL_HEIGHT, Math.round(value));
}

function getNodeDrivenTagPanelHeight(node, panel, widget) {
    const nodeHeight = Number(node?.size?.[1]);
    if (!Number.isFinite(nodeHeight) || nodeHeight <= 0) {
        return getTagPanelHeightFromContent(panel);
    }

    return clampTagPanelHeight(
        nodeHeight - getTagPanelTop(widget) - WIDGET_BOTTOM_RESERVE - PANEL_BOTTOM_PADDING
    );
}

function updatePanelLayout(node, panel, widget) {
    const height = getNodeDrivenTagPanelHeight(node, panel, widget);
    panel.style.height = `${height}px`;
    widget.computeSize = (width) => [width, MIN_PANEL_HEIGHT + WIDGET_BOTTOM_RESERVE];
}

function getRequiredNodeHeight(widget) {
    return getTagPanelTop(widget) + MIN_PANEL_HEIGHT + WIDGET_BOTTOM_RESERVE + PANEL_BOTTOM_PADDING;
}

function resizeNode(node, panel, widget) {
    requestAnimationFrame(() => {
        normalizeInputs(node);
        updatePanelLayout(node, panel, widget);
        if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
            const currentWidth = Number(node.size?.[0]) || MIN_NODE_WIDTH;
            const currentHeight = Number(node.size?.[1]) || 0;
            node.setSize([
                Math.max(currentWidth, MIN_NODE_WIDTH),
                Math.max(currentHeight, getRequiredNodeHeight(widget)),
            ]);
        }
        app.graph.setDirtyCanvas(true, true);
    });
}

function createPanel(node, stateWidget) {
    const panel = document.createElement("div");
    panel.className = "danbooru-tag-sync-panel";

    const list = document.createElement("div");
    list.className = "danbooru-tag-sync-list";
    panel.appendChild(list);

    const domWidget = node.addDOMWidget("tag_buttons", "danbooru_tag_buttons", panel, {
        serialize: false,
        hideOnZoom: false,
    });
    updatePanelLayout(node, panel, domWidget, true);

    let dictionary = new Map();
    let lastSource = null;
    let items = [];
    let timerId = null;

    function saveState() {
        const current = parseState(stateWidget.value);
        current.version = 2;
        current.source = lastSource || "";
        current.overrides = {};

        for (const item of items) {
            const override = current.overrides[item.key] || {};
            override.weight = Number(item.weight.toFixed(3));
            override.selected = !!item.selected;
            override.deleted = !!item.deleted;
            delete override.disabled;
            current.overrides[item.key] = override;
        }

        stateWidget.value = JSON.stringify(current);
        commitWidgetValue(node, stateWidget);
        stateWidget.callback?.(stateWidget.value);
        app.graph.setDirtyCanvas(true, true);
    }

    function render() {
        const previousScrollTop = list.scrollTop;
        list.replaceChildren();

        const visibleItems = items.filter((item) => !item.deleted);
        if (!visibleItems.length) {
            const empty = document.createElement("div");
            empty.className = "danbooru-tag-sync-empty";
            empty.textContent = "等待上游 tags";
            list.appendChild(empty);
            resizeNode(node, panel, domWidget);
            return;
        }

        for (const item of visibleItems) {
            const row = document.createElement("span");
            row.className = "danbooru-tag-sync-item";
            row.classList.toggle("has-weight", hasCustomWeight(item.weight));
            if (!item.selected) {
                row.classList.add("is-muted");
            }
            row.title = item.selected ? "点击取消选中" : "点击选中输出";
            row.addEventListener("click", (event) => {
                if (event.target.closest(".danbooru-tag-sync-main, .danbooru-tag-sync-remove, .danbooru-tag-sync-weight")) {
                    return;
                }
                event.preventDefault();
                item.selected = !item.selected;
                saveState();
                render();
            });

            const main = document.createElement("button");
            main.className = "danbooru-tag-sync-main";
            main.type = "button";
            main.title = item.selected ? "点击取消选中" : "点击选中输出";

            const tagLine = document.createElement("span");
            tagLine.className = "danbooru-tag-sync-tag";
            tagLine.textContent = item.tag;

            const translationLine = document.createElement("span");
            translationLine.className = "danbooru-tag-sync-translation";
            translationLine.textContent = item.translation;

            main.append(tagLine, translationLine);
            main.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                item.selected = !item.selected;
                saveState();
                render();
            });

            const weight = document.createElement("span");
            weight.className = "danbooru-tag-sync-weight";
            weight.title = "权重";
            weight.textContent = formatWeight(item.weight);
            weight.hidden = !hasCustomWeight(item.weight);

            const remove = document.createElement("button");
            remove.className = "danbooru-tag-sync-remove";
            remove.type = "button";
            remove.title = "删除";
            remove.textContent = "×";
            remove.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                item.deleted = true;
                saveState();
                render();
            });

            row.append(main, weight, remove);
            list.appendChild(row);
        }

        list.scrollTop = previousScrollTop;
        requestAnimationFrame(() => {
            list.scrollTop = previousScrollTop;
        });
        resizeNode(node, panel, domWidget);
    }

    function syncFromSource(source) {
        const current = parseState(stateWidget.value);
        const sourceMatches = current.source === String(source || "");
        const overrides = sourceMatches ? (current.overrides || {}) : {};
        items = parseTags(source, dictionary).map((item) => {
            const override = overrides[item.key] || {};
            return {
                ...item,
                weight: Number.isFinite(Number(override.weight)) ? Number(override.weight) : item.weight,
                selected: sourceMatches ? isSelected(override) : true,
                deleted: sourceMatches ? !!override.deleted : false,
            };
        });
        lastSource = source || "";
        current.source = lastSource;
        current.overrides = {};
        stateWidget.value = JSON.stringify(current);
        commitWidgetValue(node, stateWidget);
        stateWidget.callback?.(stateWidget.value);
        saveState();
        render();
    }

    function syncFromExecuted(executedItems, source) {
        if (!Array.isArray(executedItems)) {
            return;
        }

        items = executedItems
            .filter((item) => item && typeof item === "object" && item.tag)
            .map((item) => ({
                key: item.key || normalizeKey(item.tag),
                tag: normalizeTagText(item.tag),
                translation: String(item.translation || item.tag || ""),
                weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 1,
                selected: item.selected !== false,
                deleted: !!item.deleted,
        }));
        lastSource = source || lastSource || "";
        stateWidget.value = JSON.stringify({
            version: 2,
            source: lastSource,
            overrides: {},
        });
        commitWidgetValue(node, stateWidget);
        stateWidget.callback?.(stateWidget.value);
        saveState();
        render();
    }

    function tick() {
        const source = readLinkedText(node);
        if (source !== lastSource) {
            syncFromSource(source);
        }
    }

    loadDictionary().then((loaded) => {
        dictionary = loaded;
        syncFromSource(readLinkedText(node));
        timerId = window.setInterval(tick, 250);
    });

    const originalOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        if (timerId !== null) {
            window.clearInterval(timerId);
        }
        return originalOnRemoved?.apply(this, arguments);
    };

    const originalOnResize = node.onResize;
    node.onResize = function () {
        const result = originalOnResize?.apply(this, arguments);
        updatePanelLayout(node, panel, domWidget);
        return result;
    };

    node.__danbooruTagSyncSetItems = syncFromExecuted;
    node.__danbooruTagSyncSyncSource = syncFromSource;

    render();
}

function ensurePanel(node, attempt = 0) {
    if (!node || !NODE_NAMES.has(node.comfyClass) && !NODE_NAMES.has(node.type) && !NODE_NAMES.has(node.title)) {
        return;
    }

    installStyle();
    normalizeInputs(node);

    const stateWidget = node.widgets?.find((widget) => widget.name === "state");
    if (!stateWidget) {
        if (attempt < 12) {
            window.requestAnimationFrame(() => ensurePanel(node, attempt + 1));
        }
        return;
    }

    hideWidget(stateWidget);

    if (stateWidget && node.addDOMWidget && !node.__danbooruTagSyncPanel) {
        createPanel(node, stateWidget);
        node.__danbooruTagSyncPanel = true;
        console.info("[DanbooruTagSyncTranslator] panel attached", node.id);
    }
    if (node.size[0] < MIN_NODE_WIDTH) {
        node.setSize([MIN_NODE_WIDTH, node.size[1]]);
    }
}

app.registerExtension({
    name: EXTENSION_NAME,
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name) && !NODE_NAMES.has(nodeData.display_name)) {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = originalOnNodeCreated?.apply(this, arguments);
            ensurePanel(this);
            return result;
        };

        const originalOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const result = originalOnExecuted?.apply(this, arguments);
            normalizeInputs(this);
            const items = Array.isArray(message?.items?.[0]) ? message.items[0] : message?.items;
            const source = Array.isArray(message?.source) ? message.source[0] : message?.source;
            this.__danbooruTagSyncSetItems?.(items, source);
            return result;
        };
    },
    nodeCreated(node) {
        ensurePanel(node);
    },
});

