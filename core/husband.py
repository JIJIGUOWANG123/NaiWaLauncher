from .group_filter import (parse_gid_whitelist, group_allowed, is_group_allowed, parse_line_list as _parse_lines)
import os
import json
import time
import uuid
import random
import hashlib
import tempfile
import datetime
import aiohttp

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


def get_avatar_url(qq: str) -> str:
    """QQ 头像 URL（640x640）"""
    if not qq:
        return ""
    return f"https://q1.qlogo.cn/g?b=qq&nk={qq}&s=640"


async def download_avatar(qq: str, timeout: int = 10) -> str:
    """下载 QQ 头像到临时文件，返回本地路径；失败返回空串"""
    if not qq:
        return ""
    url = get_avatar_url(qq)
    try:
        t = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=t) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    logger.warning(f"[husband] 头像 HTTP {resp.status}")
                    return ""
                img_bytes = await resp.read()
        if not img_bytes:
            return ""

        tmp_dir = os.path.join(tempfile.gettempdir(), "astrbot_meme")
        os.makedirs(tmp_dir, exist_ok=True)
        fname = f"avatar_{qq}_{uuid.uuid4().hex[:6]}.jpg"
        fpath = os.path.join(tmp_dir, fname)
        with open(fpath, "wb") as f:
            f.write(img_bytes)
        return fpath
    except Exception:
        logger.exception("[husband] 下载头像失败")
        return ""


class HusbandModule:
    """
    今日老公模块：每个人每天各抽一次，结果互不相同。
    """

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.trigger_names = ["今日老公", "老公"]
        self.force_trigger_names = ["逼迫"]
        self.enable = True
        # ★ 随机抽取选项
        self.allow_bot = False      # 机器人是否参与随机
        self.exclude_ids = []       # 排除的 QQ 号（永不参与随机）
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []
        self.user_records = {}
        self._load_records()

    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("husband_enable", True))
        raw = str(cfg.get("husband_trigger_names", "今日老公,老公") or "").strip()
        names = _parse_names(raw)
        self.trigger_names = names if names else ["今日老公"]

        # ★ 逼迫指令：强行指定某人成为自己的老公（多个用英文逗号分隔）
        raw_force = str(cfg.get("husband_force_trigger_names", "逼迫") or "").strip()
        fnames = _parse_names(raw_force)
        self.force_trigger_names = fnames if fnames else ["逼迫"]

        # ★ 随机抽取选项：机器人是否参与 / 排除的 QQ 号
        self.allow_bot = bool(cfg.get("husband_allow_bot", False))
        self.exclude_ids = _parse_names(
            str(cfg.get("husband_exclude_ids", "") or "")
        )
        # 统一成字符串，便于比较
        self.exclude_ids = [str(x).strip() for x in self.exclude_ids if str(x).strip()]

        # ★ 群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效
        self.allowed_groups = parse_gid_whitelist(cfg.get("husband_groups", ""))
        # 兼容旧的黑/白名单配置（未填新白名单时仍按旧逻辑生效）
        self.group_mode = str(cfg.get("husband_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = _parse_lines(cfg.get("husband_group_whitelist", ""))
        self.group_blacklist = _parse_lines(cfg.get("husband_group_blacklist", ""))

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

    def match_force(self, text: str) -> bool:
        """是否触发「逼迫」指令（支持「逼迫 @某人」这种带参数的写法）"""
        if not self.enable:
            return False
        t = str(text or "").strip()
        if not t:
            return False
        for name in getattr(self, "force_trigger_names", []) or []:
            if not name:
                continue
            if t == name or t == f"/{name}":
                return True
            # 带参数：逼迫 @某人 / 逼迫 QQ号
            if t.startswith(name + " ") or t.startswith(f"/{name} "):
                return True
        return False

    def _today_key(self, event) -> tuple:
        group_id = get_group_id(event)
        user_id = get_user_id(event)
        return f"{_today_str()}|{group_id}|{user_id}", group_id, user_id

    async def _resolve_target(self, event, text: str, self_id: str) -> dict:
        """
        解析「逼迫」的目标：优先用 @ 的人，其次用文本里的 QQ 号，都没有则随机抽一个群成员。
        返回 {"user_id":..., "name":...}，失败返回 {}。
        """
        from .event_helpers import get_ats_from_msg
        target_id = ""
        try:
            ats = get_ats_from_msg(event) or []
            for a in ats:
                a = str(a)
                if a and a != str(self_id or ""):
                    target_id = a
                    break
        except Exception:
            pass

        # 文本里的纯数字（QQ号），排除机器人自己
        if not target_id:
            import re as _re
            for m in _re.finditer(r"\d{5,12}", str(text or "")):
                v = m.group(0)
                if v != str(self_id or ""):
                    target_id = v
                    break

        members = await self._get_group_members(event)
        members = members or []

        if target_id:
            for m in members:
                if str(m.get("user_id", "")) == target_id:
                    return {
                        "user_id": target_id,
                        "name": m.get("card") or m.get("nickname") or f"QQ{target_id}",
                    }
            return {"user_id": target_id, "name": f"QQ{target_id}"}

        # 随机抽一个：走与「今日老公」同一套过滤（机器人开关 + 排除列表），
        # 另外永远排除发起者自己
        me = str(get_user_id(event) or "")
        pool = [m for m in self.filter_candidates(members, event, self_id)
                if str(m.get("user_id", "")) != me]
        if not pool:
            return {}
        chosen = random.choice(pool)
        uid = str(chosen.get("user_id", ""))
        return {
            "user_id": uid,
            "name": chosen.get("card") or chosen.get("nickname") or f"QQ{uid}",
        }

    async def force_husband(self, event, text: str, self_id: str = ""):
        """
        强行指定老公。
        返回 (文本, 头像本地路径或 None)。
        今天已经有老公（无论随机抽的还是逼迫的）都会拒绝，避免冲突。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id):
            return "", None

        key, _gid, _uid = self._today_key(event)
        rec = self.user_records.get(key)
        if rec:
            name = rec.get("name", "")
            return ("\n".join([
                f"{title_bar('今日老公')}",
                f"👨 {name}",
                "",
                "⚠️ 你今天已经有老公了，明天再来吧",
            ]), None)

        target = await self._resolve_target(event, text, self_id)
        if not target:
            return "⚠️ 没找到可以逼迫的对象，试试「逼迫 @某人」", None

        qq = str(target.get("user_id", ""))
        name = str(target.get("name", "")) or f"QQ{qq}"
        rec = {"qq": qq, "name": name, "ts": int(time.time()), "by": "force"}
        self.user_records[key] = rec
        self._save_records()

        text_out = "\n".join([
            f"{title_bar('今日老公')}",
            f"👨 {name}",
            "",
            "😈 已被你强行拿下",
            "💡 每天一次，明天再刷新",
        ])
        avatar_path = await download_avatar(qq) if qq else ""
        return text_out, (avatar_path or None)

    async def _get_group_members(self, event):
        group_id = get_group_id(event)
        if not group_id:
            return None

        bot = getattr(event, "bot", None)
        if bot is None:
            for attr in ("api", "client", "onebot"):
                alt = getattr(event, attr, None)
                if alt is not None:
                    bot = alt
                    break
        if bot is None:
            return None

        if hasattr(bot, "get_group_member_list"):
            try:
                members = await bot.get_group_member_list(group_id=int(group_id))
                if members:
                    return members
            except Exception:
                pass

        if hasattr(bot, "call_action"):
            try:
                members = await bot.call_action("get_group_member_list", group_id=int(group_id))
                if members:
                    return members
            except Exception:
                pass

        api = getattr(bot, "api", None)
        if api is not None and hasattr(api, "call_action"):
            try:
                members = await api.call_action("get_group_member_list", group_id=int(group_id))
                if members:
                    return members
            except Exception:
                pass

        return None

    def get_bot_self_id(self, event=None) -> str:
        """取机器人自身 QQ；事件取不到时读状态模块的缓存，再兜底读配置"""
        try:
            from .system_status import get_bot_id as _get_bot_id
            v = _get_bot_id(event)
            if v and v != "未知":
                return str(v).strip()
        except Exception:
            pass
        try:
            from .system_status import get_cached_bot_id
            v = get_cached_bot_id()
            if v:
                return str(v)
        except Exception:
            pass
        return ""

    def filter_candidates(self, members, event=None, self_id: str = "") -> list:
        """
        过滤随机抽取的候选群成员：
          · 机器人自己：husband_allow_bot = False（默认）时排除
          · husband_exclude_ids 里列的 QQ 号：永远排除
        排除后没人可选时，返回空列表（调用方给提示）。
        """
        members = list(members or [])
        allow_bot = bool(getattr(self, "allow_bot", False))
        excluded = set(str(x).strip() for x in (getattr(self, "exclude_ids", []) or []))
        bot = str(self_id or "").strip() or self.get_bot_self_id(event)

        pool = []
        for m in members:
            uid = str(m.get("user_id", "")).strip()
            if not uid:
                continue
            if uid in excluded:
                continue
            if not allow_bot and bot and uid == bot:
                continue
            pool.append(m)
        return pool

    def pick_husband(self, members, event=None, self_id: str = "") -> dict:
        """
        随机抽一个老公（同一天同一人结果稳定）。
        候选先经过 filter_candidates；没有可用候选时返回 {}。
        """
        pool = self.filter_candidates(members, event, self_id)
        if not pool:
            return {}
        group_id = get_group_id(event)
        user_id = get_user_id(event)
        seed_str = f"husband-{group_id}-{user_id}-{_today_str()}"
        rnd = random.Random(seed_str)
        return rnd.choice(pool)

    def _member_to_rec(self, chosen: dict) -> dict:
        qq = str(chosen.get("user_id", ""))
        name = chosen.get("card") or chosen.get("nickname") or f"QQ{qq}"
        return {"qq": qq, "name": name, "ts": int(time.time())}

    async def get_today_text(self, event) -> str:
        """保留原有文本输出（备用）"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id):
            return ""

        user_id = get_user_id(event)
        today = _today_str()
        key = f"{today}|{group_id}|{user_id}"

        rec = self.user_records.get(key)
        if rec:
            return self._format(rec)

        members = await self._get_group_members(event)
        if not members:
            return "⚠️ 获取群成员失败，请稍后再试"

        chosen = self.pick_husband(members, event)
        if not chosen:
            return "⚠️ 没有可抽取的群成员了（可能都被排除了）"

        rec = self._member_to_rec(chosen)
        self.user_records[key] = rec
        self._save_records()
        return self._format(rec)

    async def get_today_result(self, event):
        """
        新接口：返回 (文本, 头像本地路径或 None)
        供 main.py 调用，可图文一起发。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id):
            return "", None

        user_id = get_user_id(event)
        today = _today_str()
        key = f"{today}|{group_id}|{user_id}"

        rec = self.user_records.get(key)
        if not rec:
            members = await self._get_group_members(event)
            if not members:
                return "⚠️ 获取群成员失败，请稍后再试", None

            chosen = self.pick_husband(members, event)
            if not chosen:
                return "⚠️ 没有可抽取的群成员了（可能都被排除了）", None

            rec = self._member_to_rec(chosen)
            self.user_records[key] = rec
            self._save_records()

        qq = rec.get("qq", "")
        name = rec.get("name", "")

        text = "\n".join([
            f"{title_bar('今日老公')}",
            f"👨 {name}",
            "",
            "💡 每天一次，明天再刷新"
        ])

        avatar_path = await download_avatar(qq) if qq else ""
        return text, avatar_path or None

    def _format(self, rec: dict) -> str:
        return "\n".join([
            f"{title_bar('今日老公')}",
            f"👨 {rec.get('name', '')}",
            "",
            "💡 每天一次，明天再刷新"
        ])