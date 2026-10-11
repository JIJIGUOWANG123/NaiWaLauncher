"""
每日读报模块（60s 读报）。

特性：
  - 手动指令（可后台自定义多个，英文逗号分隔）
  - 后台总开关 + 全局默认推送时间（HH:MM，支持整点与精确分钟）
  - 每个群可单独开关、单独指定推送时间
  - 支持远程开关 / 远程设置时间（带群号）
  - 每群记录 unified_msg_origin 用于主动推送
  - 按「日期」防重，同一天只推一次
  - 图片接口不可用时回退为文字播报

与 status_push 同样使用模块级全局锁 + 每次加锁前重载磁盘，
避免多实例并发覆盖状态文件。
"""

import os
import json
import time
import datetime
import threading
from astrbot.api import logger

from .path_utils import parse_gid_list as _parse_gid_list

# ★ 模块级全局锁，防止多实例并发覆盖
_GLOBAL_NEWS_LOCK = threading.Lock()

DEFAULT_TIME = "08:00"

# 读报接口
NEWS_API_IMAGE = "https://cyapi.top/API/60s.php?type=image"
NEWS_API_TEXT = "https://cyapi.top/API/60s.php?type=text"


# ============================================================
# 工具
# ============================================================
def now_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def parse_hhmm(raw) -> str:
    """把 8 / 8:5 / 08:00 / 8：00 等输入规范成 HH:MM；非法返回空串。"""
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text:
        return ""
    # 统一全角冒号与点号
    text = text.replace("：", ":").replace(".", ":").replace("。", ":")
    if ":" not in text:
        if text.isdigit():
            h = int(text)
            if 0 <= h <= 23:
                return f"{h:02d}:00"
        return ""
    parts = text.split(":")
    if len(parts) != 2:
        return ""
    hh, mm = parts[0].strip(), parts[1].strip()
    if not hh.isdigit() or not mm.isdigit():
        return ""
    h, m = int(hh), int(mm)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return ""
    return f"{h:02d}:{m:02d}"


class DailyNewsModule:
    """每日读报模块"""

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path

        # 全局配置（由 reload 注入）
        self.enable = False
        self.default_time = DEFAULT_TIME
        self.interval = 30

        # 每群状态：{group_id: {"on": bool, "time": "HH:MM"}}
        self.groups = {}
        # 已推送记录：{group_id: "YYYY-MM-DD"}
        self.last_push = {}
        # 主动推送用：{group_id: unified_msg_origin}
        self.umos = {}
        # 后台「手动读报名单」与「自动推送名单」（都是白名单）
        self.manual_groups = []
        self.auto_groups = []
        self.use_backend_groups = False
        # 由 main.py 注入：把「群号+是否生效」写回后台配置
        self._manual_cfg_write = None
        self._cfg_write = None

        self._load_state()

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}
        self.enable = bool(cfg.get("daily_news_enable", False))

        t = parse_hhmm(cfg.get("daily_news_time", DEFAULT_TIME))
        self.default_time = t or DEFAULT_TIME

        try:
            itv = int(str(cfg.get("daily_news_interval", "30")).strip() or "30")
        except Exception:
            itv = 30
        self.interval = max(10, itv)

        # ★ 两份名单完全独立（都是白名单：填了才生效）
        #   manual_groups = 手动读报（发指令立刻推）
        #   auto_groups   = 自动推送（到点自动推）
        self.manual_groups = _parse_gid_list(cfg.get("daily_news_groups", ""))
        self.auto_groups = _parse_gid_list(cfg.get("daily_news_auto_groups", ""))
        self.use_backend_groups = bool(self.auto_groups)
        self._sync_backend_groups()

    def _sync_backend_groups(self):
        """白名单语义：只有自动名单里的群才自动推送读报，其余群一律关闭。"""
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            changed = False
            for gid in self.auto_groups:
                cfg = self.groups.get(gid)
                if not isinstance(cfg, dict):
                    cfg = {"on": False, "time": ""}
                if not cfg.get("on"):
                    cfg["on"] = True
                    changed = True
                cfg.setdefault("time", "")
                self.groups[gid] = cfg
            for gid, cfg in list(self.groups.items()):
                if gid in self.auto_groups:
                    continue
                if isinstance(cfg, dict) and cfg.get("on"):
                    cfg["on"] = False
                    changed = True
            if changed:
                self._save_state()
            logger.info(
                f"[daily_news] 手动名单 {len(self.manual_groups)} 个群，"
                f"自动名单 {len(self.auto_groups)} 个群"
            )

    # ============================================================
    # 状态持久化（加锁由调用方保证）
    # ============================================================
    def _load_state(self):
        if not self.data_path or not os.path.exists(self.data_path):
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f) or {}
            self.groups = data.get("groups", {}) or {}
            self.last_push = data.get("last_push", {}) or {}
            self.umos = data.get("umos", {}) or {}
        except Exception:
            logger.exception("[daily_news] 读取状态失败")

    def _save_state(self):
        if not self.data_path:
            return
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "groups": self.groups,
                        "last_push": self.last_push,
                        "umos": self.umos,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[daily_news] 保存状态失败")

    # ============================================================
    # UMO 记录
    # ============================================================
    def record_context(self, group_id, umo: str = ""):
        gid = str(group_id or "").strip()
        umo = str(umo or "").strip()
        if not gid or not umo:
            return
        if self.umos.get(gid) == umo:
            return
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            if self.umos.get(gid) != umo:
                self.umos[gid] = umo
                self._save_state()

    def get_umo(self, group_id) -> str:
        return str(self.umos.get(str(group_id), "") or "")

    # ============================================================
    # 每群配置
    # ============================================================
    def _group_cfg(self, group_id) -> dict:
        gid = str(group_id)
        cfg = self.groups.get(gid)
        # 白名单语义：名单内的群默认开启
        if not isinstance(cfg, dict):
            cfg = {"on": True, "time": ""}
        return cfg

    def is_group_on(self, group_id) -> bool:
        """该群是否自动推送读报（白名单语义：自动名单里填了才推）。"""
        gid = str(group_id)
        if gid not in self.auto_groups:
            return False
        return bool(self._group_cfg(gid).get("on", True))

    def is_manual_allowed(self, group_id) -> bool:
        """
        该群是否允许手动发读报（**黑名单**语义）：
          · 留空        -> 所有群都能手动发
          · 填了群号    -> 这些群不能手动发
        """
        gid = str(group_id)
        if not self.manual_groups:
            return True
        return gid not in self.manual_groups

    def set_manual_group(self, group_id, allowed: bool) -> bool:
        """把某群加入/移出「手动读报黑名单」。返回是否有变化。"""
        gid = str(group_id)
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            changed = False
            # 黑名单：allowed=True 表示可用 -> 从名单移除；False 表示不可用 -> 加入名单
            if allowed:
                if gid in self.manual_groups:
                    self.manual_groups.remove(gid)
                    changed = True
            else:
                if gid not in self.manual_groups:
                    self.manual_groups.append(gid)
                    changed = True
            if changed:
                self._save_state()
        try:
            if self._manual_cfg_write:
                self._manual_cfg_write(gid, bool(allowed))
        except Exception:
            logger.exception("[daily_news] 同步手动读报名单失败")
        return changed

    def get_group_time(self, group_id) -> str:
        """该群生效的推送时间（群自定义优先，否则全局默认）"""
        raw = self._group_cfg(group_id).get("time", "")
        return parse_hhmm(raw) or self.default_time

    def get_group_raw_time(self, group_id) -> str:
        """该群显式设置的时间（未设置为空串）"""
        return parse_hhmm(self._group_cfg(group_id).get("time", ""))

    def set_group_on(self, group_id, on: bool):
        """开启/关闭某群的自动推送（白名单：开启则加入自动名单，关闭则移除）。"""
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            gid = str(group_id)
            cfg = self._group_cfg(gid)
            cfg["on"] = bool(on)
            cfg.setdefault("time", "")
            self.groups[gid] = cfg
            # 同步内存里的自动名单
            if on and gid not in self.auto_groups:
                self.auto_groups.append(gid)
            elif not on and gid in self.auto_groups:
                self.auto_groups.remove(gid)
            self._save_state()
        # ★ 同步写回后台配置，重启后依然生效
        try:
            if self._cfg_write:
                self._cfg_write(gid, bool(on))
        except Exception:
            logger.exception("[daily_news] 同步自动推送名单失败")

    def set_group_time(self, group_id, hhmm: str) -> bool:
        """设置群推送时间；传空串表示恢复使用全局默认时间。"""
        text = str(hhmm or "").strip()
        if text:
            parsed = parse_hhmm(text)
            if not parsed:
                return False
        else:
            parsed = ""
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            gid = str(group_id)
            cfg = self._group_cfg(gid)
            cfg["time"] = parsed
            cfg.setdefault("on", False)
            self.groups[gid] = cfg
            self._save_state()
        return True

    def get_all_group_ids(self) -> list:
        """需要遍历的群：只遍历自动名单里的群（白名单语义）。"""
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            return sorted(str(x) for x in self.auto_groups)

    def list_groups(self) -> list:
        out = []
        for gid, cfg in self.groups.items():
            if not isinstance(cfg, dict) or not cfg.get("on"):
                continue
            out.append({
                "group_id": gid,
                "time": self.get_group_time(gid),
                "custom": bool(self.get_group_raw_time(gid)),
            })
        return sorted(out, key=lambda x: x["group_id"])

    # ============================================================
    # 到点判定 + 防重（原子）
    # ============================================================
    def check_and_mark(self, group_id, hhmm: str) -> bool:
        """
        在全局锁内完成：重载磁盘 -> 校验开关 -> 校验时间是否到点 -> 标记今日已推。
        返回 True 表示本轮应当推送。
        """
        target = parse_hhmm(hhmm)
        if not target:
            return False
        with _GLOBAL_NEWS_LOCK:
            self._load_state()
            gid = str(group_id)
            if not self.is_group_on(gid):
                return False
            if self.get_group_time(gid) != target:
                return False
            today = today_str()
            if self.last_push.get(gid) == today:
                return False
            self.last_push[gid] = today
            # 清理过期记录，避免无限增长
            if len(self.last_push) > 500:
                stale = [k for k, v in self.last_push.items() if str(v) != today]
                for k in stale:
                    self.last_push.pop(k, None)
            self._save_state()
            return True

    def pending_groups(self, hhmm: str) -> list:
        """返回当前时间点应当推送的群号列表（无副作用，供测试/调试）。"""
        target = parse_hhmm(hhmm)
        if not target:
            return []
        out = []
        for gid in self.get_all_group_ids():
            if not self.is_group_on(gid):
                continue
            if self.get_group_time(gid) == target:
                out.append(gid)
        return sorted(out)
