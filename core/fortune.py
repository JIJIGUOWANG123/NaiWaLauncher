from .group_filter import (parse_gid_whitelist, group_allowed, is_group_allowed, parse_line_list as _parse_lines)
import os
import json
import time
import random
import hashlib
import datetime
from .path_utils import title_bar, title_foot


def _today_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


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


def get_user_id(event) -> str:
    try:
        uid = event.get_sender_id() or ""
        if uid:
            return str(uid)
    except Exception:
        pass
    try:
        uid = getattr(event, "user_id", "") or ""
        if uid:
            return str(uid)
    except Exception:
        pass
    return "unknown"


def pick_fortune_for_user(fortunes: list, seed: int):
    if not fortunes:
        return None
    rnd = random.Random(seed)
    return rnd.choice(fortunes)


class FortuneModule:
    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.fortunes = []
        self.trigger_names = ["今日运势", "运势", "抽签"]
        self.enable = True
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []
        self.user_records = {}
        self._load_records()

    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("fortune_enable", True))
        raw = str(cfg.get("fortune_trigger_names", "今日运势,运势,抽签") or "").strip()
        names = _parse_names(raw)
        self.trigger_names = names if names else ["今日运势"]

        # ★ 群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效
        self.allowed_groups = parse_gid_whitelist(cfg.get("fortune_groups", ""))
        # 兼容旧的黑/白名单配置（未填新白名单时仍按旧逻辑生效）
        self.group_mode = str(cfg.get("fortune_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = _parse_lines(cfg.get("fortune_group_whitelist", ""))
        self.group_blacklist = _parse_lines(cfg.get("fortune_group_blacklist", ""))

        fortune_list = cfg.get("fortune_list", [])
        fortunes_from_cfg = []
        if isinstance(fortune_list, list):
            for item in fortune_list:
                if not isinstance(item, dict):
                    continue
                f = {
                    "运势": str(item.get("fortune", "")).strip(),
                    "星级": str(item.get("stars", "")).strip(),
                    "签文": str(item.get("title", "")).strip(),
                    "解签": str(item.get("desc", "")).strip(),
                }
                if f["运势"] and f["签文"]:
                    fortunes_from_cfg.append(f)
        self.fortunes = fortunes_from_cfg

    def _load_records(self):
        if not os.path.exists(self.data_path):
            self.user_records = {}
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                self.user_records = json.load(f) or {}
        except Exception:
            self.user_records = {}

    def _save_records(self):
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.user_records, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
        except Exception:
            pass

    def _is_group_allowed(self, group_id) -> bool:
        """群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效"""
        if self.allowed_groups:
            return group_allowed(group_id, self.allowed_groups)
        # 未填新白名单：回退到旧的黑/白名单逻辑
        return is_group_allowed(
            group_id, self.group_mode, self.group_whitelist, self.group_blacklist
        )
    def match_trigger(self, text: str) -> bool:
        if not self.enable:
            return False
        for name in self.trigger_names:
            if not name:
                continue
            if text == name or text == f"/{name}":
                return True
        return False

    def _get_today_fortune(self, user_id: str):
        if not self.fortunes:
            return None
        today = _today_str()
        key = f"{user_id}|{today}"

        rec = self.user_records.get(key)
        if rec is not None:
            idx = rec.get("idx", 0)
            if 0 <= idx < len(self.fortunes):
                return self.fortunes[idx]

        seed_str = f"{user_id}-{today}"
        seed = int(hashlib.md5(seed_str.encode("utf-8")).hexdigest(), 16)
        fortune = pick_fortune_for_user(self.fortunes, seed)
        if fortune is None:
            fortune = random.choice(self.fortunes)

        try:
            idx = self.fortunes.index(fortune)
        except ValueError:
            idx = 0

        self.user_records[key] = {"idx": idx, "ts": int(time.time())}
        self._save_records()
        return fortune

    def get_today_text(self, event) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id):
            return ""
        if not self.fortunes:
            return "⚠️ 运势数据为空，请在 WebUI 的 fortune_list 里添加"

        user_id = get_user_id(event)
        fortune = self._get_today_fortune(user_id)
        if not fortune:
            return "⚠️ 运势抽取失败，请稍后再试"

        return "\n".join([
            f"{title_bar('今日运势')}",
            f"运势：{fortune.get('运势', '')}",
            f"星级：{fortune.get('星级', '')}",
            f"签文：{fortune.get('签文', '')}",
            f"解签：{fortune.get('解签', '')}",
            "",
            "💡 每人每天一次，明天再来抽新的吧"
        ])