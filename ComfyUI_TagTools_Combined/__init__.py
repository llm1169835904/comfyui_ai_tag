import json
import os
import re
from pathlib import Path

try:
    from aiohttp import web
    from server import PromptServer
except Exception:
    web = None
    PromptServer = None


WEB_DIRECTORY = None
WEB_DIRECTORY_NAME = "comfyui_tag_tools_combined"

_ROOT = Path(__file__).resolve().parent
_TAG_SELECTOR_TAGS_PATH = _ROOT / "tags.json"
_DANBOORU_DICT_PATH = _ROOT / "danbooru_tags.json"
_SPLIT_RE = re.compile(r"[,\uFF0C\u3001]")
_WEIGHT_RE = re.compile(r"^\((.*):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$")
_TRANSLATION_CACHE = None


def _register_web_directory():
    try:
        import nodes as comfy_nodes

        web_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "web"))
        if os.path.isdir(web_dir):
            comfy_nodes.EXTENSION_WEB_DIRS[WEB_DIRECTORY_NAME] = web_dir
    except Exception:
        pass


def _read_text(path):
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _read_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(_read_text(path))
    except Exception:
        return default


def _read_tag_selector_tags():
    data = _read_json(_TAG_SELECTOR_TAGS_PATH, {})
    return data if isinstance(data, dict) else {}


def _normalize_key(value):
    value = str(value or "").strip().lower()
    value = value.replace(r"\(", "(").replace(r"\)", ")")
    value = value.replace("_", " ")
    return re.sub(r"\s+", " ", value)


def _normalize_tag_text(value):
    return str(value or "").replace(r"\(", "(").replace(r"\)", ")").strip()


def _load_translations():
    global _TRANSLATION_CACHE
    if _TRANSLATION_CACHE is not None:
        return _TRANSLATION_CACHE

    mapping = {}
    data = _read_json(_DANBOORU_DICT_PATH, {})
    if isinstance(data, dict):
        for key, value in data.items():
            normalized = _normalize_key(key)
            if normalized:
                mapping[normalized] = str(value)

    _TRANSLATION_CACHE = mapping
    return mapping


def _parse_state(state):
    if not state:
        return {"version": 2, "source": "", "overrides": {}}
    try:
        parsed = json.loads(state)
    except Exception:
        return {"version": 2, "source": "", "overrides": {}}
    if not isinstance(parsed, dict):
        return {"version": 2, "source": "", "overrides": {}}

    overrides = parsed.get("overrides", parsed)
    if not isinstance(overrides, dict):
        overrides = {}
    parsed["version"] = parsed.get("version", 2)
    parsed["source"] = str(parsed.get("source", ""))
    parsed["overrides"] = overrides
    return parsed


def _parse_tags(tags):
    result = []
    for raw_part in _SPLIT_RE.split(str(tags or "")):
        raw = raw_part.strip()
        if not raw:
            continue

        tag = raw
        weight = 1.0
        had_weight = False
        match = _WEIGHT_RE.match(raw)
        if match:
            tag = match.group(1).strip()
            try:
                weight = float(match.group(2))
                had_weight = True
            except ValueError:
                weight = 1.0

        tag = _normalize_tag_text(tag)
        if tag:
            result.append(
                {
                    "tag": tag,
                    "key": _normalize_key(tag),
                    "weight": weight,
                    "had_weight": had_weight,
                }
            )
    return result


def _clean_weight(value):
    try:
        weight = float(value)
    except (TypeError, ValueError):
        weight = 1.0
    if weight < 0:
        weight = 0.0
    if weight > 100:
        weight = 100.0
    return round(weight + 1e-8, 1)


def _format_weight(weight):
    text = f"{_clean_weight(weight):.1f}".rstrip("0").rstrip(".")
    return text or "1"


def _format_tag(tag, weight):
    weight = _clean_weight(weight)
    if abs(weight - 1.0) < 0.0005:
        return tag
    return f"({tag}:{_format_weight(weight)})"


def _override_selected(override):
    if not isinstance(override, dict):
        return True
    if "selected" in override:
        return bool(override.get("selected"))
    if "disabled" in override:
        return not bool(override.get("disabled"))
    return True


def _apply_state(items, state, source=""):
    parsed_state = _parse_state(state)
    overrides = parsed_state.get("overrides", {})
    if parsed_state.get("source", "") != str(source or ""):
        overrides = {}
    translations = _load_translations()
    visible = []

    for item in items:
        override = overrides.get(item["key"], {})
        if isinstance(override, dict) and override.get("deleted"):
            continue
        if not _override_selected(override):
            continue

        weight = item["weight"]
        if isinstance(override, dict) and "weight" in override:
            weight = override.get("weight")

        tag = item["tag"]
        visible.append(
            {
                "tag": tag,
                "translation": translations.get(item["key"], tag),
                "weight": _clean_weight(weight),
            }
        )
    return visible


def _ui_items(items, state, source=""):
    parsed_state = _parse_state(state)
    overrides = parsed_state.get("overrides", {})
    if parsed_state.get("source", "") != str(source or ""):
        overrides = {}
    translations = _load_translations()
    result = []

    for item in items:
        override = overrides.get(item["key"], {})
        weight = item["weight"]
        if isinstance(override, dict) and "weight" in override:
            weight = override.get("weight")

        result.append(
            {
                "key": item["key"],
                "tag": item["tag"],
                "translation": translations.get(item["key"], item["tag"]),
                "weight": _clean_weight(weight),
                "selected": _override_selected(override),
                "deleted": bool(isinstance(override, dict) and override.get("deleted")),
            }
        )
    return result


class ComfyUITagSelectorPrompts:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "[]",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                )
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompts",)
    FUNCTION = "build_prompts"
    CATEGORY = "prompt/tag"

    def build_prompts(self, prompt="[]", selected_tags=None):
        if not isinstance(prompt, str):
            prompt = "[]"
        try:
            tags = json.loads(selected_tags if selected_tags is not None else prompt or "[]")
        except Exception:
            tags = []

        prompts = []
        for item in tags:
            if not isinstance(item, dict) or not item.get("enabled", True):
                continue
            tag = str(item.get("tag", "")).strip()
            if not tag:
                continue
            tag = tag.lower()
            weight = item.get("weight", 1)
            try:
                weight = float(weight)
            except (TypeError, ValueError):
                weight = 1.0
            if abs(weight - 1.0) > 0.0001:
                tag = f"({tag}:{weight:.1f})"
            prompts.append(tag)

        return (", ".join(prompts),)


class DanbooruTagSyncTranslator:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tags": ("STRING", {"forceInput": True}),
                "state": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "translated")
    FUNCTION = "translate"
    CATEGORY = "utils/text"

    @classmethod
    def IS_CHANGED(cls, tags, state):
        return f"{tags}|{state}"

    def translate(self, tags, state=""):
        parsed = _parse_tags(tags)
        visible = _apply_state(parsed, state, tags)
        prompt = ", ".join(_format_tag(item["tag"], item["weight"]) for item in visible)
        translated = ", ".join(
            _format_tag(item["translation"], item["weight"]) for item in visible
        )
        return {
            "ui": {
                "source": [str(tags or "")],
                "items": [_ui_items(parsed, state, tags)],
            },
            "result": (prompt, translated),
        }


if PromptServer is not None and web is not None:

    @PromptServer.instance.routes.get("/tag_selector/tags")
    async def get_tag_selector_tags(_request):
        return web.json_response(_read_tag_selector_tags())

    @PromptServer.instance.routes.get("/tag_sync_translator/dictionary")
    async def tag_sync_translator_dictionary(_request):
        if not _DANBOORU_DICT_PATH.exists():
            return web.json_response({})
        body = _DANBOORU_DICT_PATH.read_bytes()
        return web.Response(body=body, content_type="application/json")


_register_web_directory()

NODE_CLASS_MAPPINGS = {
    "ComfyUITagSelectorPrompts": ComfyUITagSelectorPrompts,
    "DanbooruTagSyncTranslator": DanbooruTagSyncTranslator,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ComfyUITagSelectorPrompts": "Tag Selector",
    "DanbooruTagSyncTranslator": "Danbooru Tag Sync Translator",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "WEB_DIRECTORY_NAME",
]

