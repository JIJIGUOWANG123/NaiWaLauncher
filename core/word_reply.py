from .group_filter import (parse_gid_whitelist, group_allowed, is_group_allowed, parse_line_list as _parse_lines)
import os
import json


def _parse_names(raw: str) -> list:
    if not raw:
        return []
    text = str(raw)
    return [x.strip() for x in text.split(",") if x.strip()]


def _parse_lines(raw) -> list:
    if not raw:
        return []
    if isinstance(raw, list):
        out = []
        for it in raw:
            if isinstance(it, str):
                out.extend(it.splitlines())
    else:
        out = str(raw).splitlines()
    return [x.strip() for x in out if x.strip() and not x.strip().startswith("#")]


def get_group_id(event) -> str:
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            gid = getattr(mo, "group_id", "") or getattr(mo, "group", "") or ""
            if gid:
                return str(gid)
    except Exception:
        pass
    try:
        gid = getattr(event, "group_id", "") or ""
        if gid:
            return str(gid)
    except Exception:
        pass
    return ""


class WordReplyModule:
    """
    自定义词库回复：关键词命中 → 回复预设文本。
    支持多关键词、每群独立屏蔽。
    """

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.enable = True
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []
        self.rules = []

    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("word_reply_enable", True))

        # ★ 群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效
        self.allowed_groups = parse_gid_whitelist(cfg.get("word_reply_groups", ""))
        # 兼容旧的黑/白名单配置
        self.group_mode = str(cfg.get("word_reply_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = _parse_lines(cfg.get("word_reply_group_whitelist", ""))
        self.group_blacklist = _parse_lines(cfg.get("word_reply_group_blacklist", ""))

        raw_list = cfg.get("word_reply_list", [])
        parsed = []
        if isinstance(raw_list, list):
            for item in raw_list:
                if not isinstance(item, dict):
                    continue
                kw_str = str(item.get("keywords", "")).strip()
                reply = str(item.get("reply", "")).strip()
                if not kw_str or not reply:
                    continue
                kws = [k.strip() for k in kw_str.split(",") if k.strip()]
                if not kws:
                    continue
                parsed.append({"keywords": kws, "reply": reply})
        self.rules = parsed

    def _is_group_allowed(self, group_id) -> bool:
        """群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效"""
        if self.allowed_groups:
            return group_allowed(group_id, self.allowed_groups)
        # 未填新白名单：回退到旧的黑/白名单逻辑
        return is_group_allowed(
            group_id, self.group_mode, self.group_whitelist, self.group_blacklist
        )
    def match(self, text: str, group_id: str = ""):
        if not self.enable:
            return None, ""
        if not self._is_group_allowed(group_id):
            return None, ""

        for rule in self.rules:
            for kw in rule["keywords"]:
                if not kw:
                    continue
                if text == kw:
                    return rule, kw
                if text.startswith(kw + " "):
                    return rule, kw
                if text.startswith(kw + "@"):
                    return rule, kw
        return None, ""

    def get_reply(self, rule: dict) -> str:
        if not rule:
            return ""
        return rule.get("reply", "")