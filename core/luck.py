from .group_filter import (parse_gid_whitelist, group_allowed, is_group_allowed, parse_line_list as _parse_lines)
import os
import json
import time
import random
import hashlib
import datetime

from astrbot.api import logger
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


def get_user_name(event) -> str:
    for attr in ("sender_name", "sender_nickname", "nickname", "nick"):
        try:
            v = getattr(event, attr, None)
            if v:
                return str(v)
        except Exception:
            pass
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            for attr in ("sender_name", "sender_nickname", "nickname"):
                v = getattr(mo, attr, None)
                if v:
                    return str(v)
            sender = getattr(mo, "sender", None)
            if sender is not None:
                for attr in ("nickname", "card", "name"):
                    v = getattr(sender, attr, None)
                    if v:
                        return str(v)
    except Exception:
        pass
    return ""


# 0-100 区间对应评价（从高到低）
LUCK_LEVELS = [
    (95, "🌟 天选之子", "人品爆表，今天做什么都顺！"),
    (85, "✨ 大吉大利", "运气极佳，抓住机会！"),
    (75, "😄 好运连连", "今天运气不错，做点开心的事吧~"),
    (65, "🙂 小吉", "运气还不错，保持好心情。"),
    (55, "😐 平平无奇", "普普通通的一天，无惊无喜。"),
    (45, "😕 略有不顺", "今天可能会遇到小挫折，注意心态。"),
    (35, "😟 运气欠佳", "出门小心，低调行事。"),
    (25, "😨 霉运缠身", "今天不宜做重要决定，多休息。"),
    (10, "💀 大凶", "诸事不宜，能躺就躺。"),
    (0,  "☠️ 天弃之子", "今天什么都别做，睡觉吧。"),
]


def luck_level(score: int):
    for threshold, level, desc in LUCK_LEVELS:
        if score >= threshold:
            return level, desc
    return LUCK_LEVELS[-1][1], LUCK_LEVELS[-1][2]


class LuckModule:
    """
    今日人品模块：每人每天抽一次，0-100 分，当天固定。
    """

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.trigger_names = ["今日人品"]
        self.enable = True
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []
        self.user_records = {}
        self._load_records()

    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("luck_enable", True))
        raw = str(cfg.get("luck_trigger_names", "今日人品") or "").strip()
        names = _parse_names(raw)
        self.trigger_names = names if names else ["今日人品"]

        # ★ 群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效
        self.allowed_groups = parse_gid_whitelist(cfg.get("luck_groups", ""))
        # 兼容旧的黑/白名单配置（未填新白名单时仍按旧逻辑生效）
        self.group_mode = str(cfg.get("luck_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = _parse_lines(cfg.get("luck_group_whitelist", ""))
        self.group_blacklist = _parse_lines(cfg.get("luck_group_blacklist", ""))

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

    def _get_today_score(self, group_id: str, user_id: str) -> int:
        today = _today_str()
        key = f"{today}|{group_id}|{user_id}"
        rec = self.user_records.get(key)
        if rec is not None:
            return int(rec.get("score", 0))

        seed_str = f"luck-{group_id}-{user_id}-{today}"
        seed = int(hashlib.md5(seed_str.encode("utf-8")).hexdigest(), 16)
        rnd = random.Random(seed)
        score = rnd.randint(0, 100)

        self.user_records[key] = {"score": score, "ts": int(time.time())}
        self._save_records()
        return score

    def get_today_text(self, event) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id):
            return ""

        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        score = self._get_today_score(group_id or "private", user_id)

        level, desc = luck_level(score)

        # 进度条
        bar_len = 20
        filled = int(score / 100 * bar_len)
        bar = "█" * filled + "░" * (bar_len - filled)

        lines = [
            f"{title_bar('今日人品')}",
            f"👤 {user_name}",
            f"🎲 {score}/100",
            f"📊 {bar}",
            f"🏷️ {level}",
            f"💬 {desc}",
            "",
            "💡 每人每天一次，明天再刷新"
        ]
        return "\n".join(lines)