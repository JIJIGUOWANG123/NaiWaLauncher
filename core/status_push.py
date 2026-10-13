"""
定时状态推送模块（按分钟间隔推送）。

特性：
  - 后台总开关 + 全局默认推送间隔（分钟，例如 60 = 每 60 分钟推一次）
  - 每个群可单独开关、单独指定推送间隔
  - 每群记录 unified_msg_origin，用于主动推送
  - 按「上次推送时间 + 间隔」判定，到点才推，重启后不丢计时
  - 供远程指令查询/设置（支持指定群号）

推送节奏为「每 N 分钟一次」：
  · 群开启（或重启后首次检查）时开始计时，满 N 分钟后推第一次
  · 之后每个间隔推一次

与 hourly_chime 同样使用模块级全局锁 + 每次加锁前重载磁盘，
避免多实例并发覆盖状态文件。
"""

import os
import json
import time
import datetime
import threading
from astrbot.api import logger

try:
    from .path_utils import parse_gid_list
except Exception:  # pragma: no cover - 独立加载时的回退
    try:
        from path_utils import parse_gid_list
    except Exception:
        def parse_gid_list(raw):
            import re
            if not raw:
                return []
            out, seen = [], set()
            for p in re.split(r"[,，、;；\s]+", str(raw)):
                p = p.strip()
                if p and p.isdigit() and p not in seen:
                    seen.add(p)
                    out.append(p)
            return out

# ★ 模块级全局锁，防止多实例并发覆盖
_GLOBAL_PUSH_LOCK = threading.Lock()

# 默认推送间隔（分钟）
DEFAULT_INTERVAL_MIN = 60
# 最小推送间隔（分钟），防止配置成 0 导致刷屏
MIN_INTERVAL_MIN = 1


# ============================================================
# 工具
# ============================================================
def now_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def fmt_seconds(sec) -> str:
    """把秒数格式化成「N小时M分」，便于展示上次推送距今多久"""
    try:
        s = int(sec)
    except Exception:
        return "—"
    if s < 0:
        s = 0
    h, rem = divmod(s, 3600)
    m, _ = divmod(rem, 60)
    if h > 0:
        return f"{h}小时{m}分"
    return f"{m}分"


def parse_hhmm(raw) -> str:
    """
    把 `8` / `8:5` / `08:00` / `8：00` 等输入规范成 `HH:MM`；
    无法识别时返回空串。

    ★★ 市场版修正：main.py 里 `from .core.status_push import parse_hhmm`
      引用了**本模块并不存在**的函数（原来只在 daily_news.py 里定义过），
      导致「状态推送间隔」指令一调用就 ImportError。
      这里补上公共实现（与 daily_news.parse_hhmm 行为一致）。
    """
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
    if 0 <= h <= 23 and 0 <= m <= 59:
        return f"{h:02d}:{m:02d}"
    return ""


def parse_interval_min(raw, default: int = DEFAULT_INTERVAL_MIN) -> int:
    """
    解析推送间隔（分钟）。支持 60 / "60" / "60分钟" / "1小时"。
    非法或小于最小值时回退到 default。
    """
    if raw is None:
        return default
    text = str(raw).strip()
    if not text:
        return default
    # 支持「1小时」「2h」
    lower = text.lower()
    try:
        if "小时" in lower or lower.endswith("h"):
            num = lower.replace("小时", "").replace("h", "").strip()
            val = int(float(num) * 60)
        else:
            num = lower.replace("分钟", "").replace("min", "").replace("m", "").strip()
            val = int(float(num))
    except Exception:
        return default
    if val < MIN_INTERVAL_MIN:
        return default
    return val


def parse_group_specs(raw) -> dict:
    """
    解析后台「定时推送群」配置，返回 {group_id: {}}。

    规则：**一行一个群号**，只填群号，不写间隔
        （间隔统一由「推送间隔」决定，单个群可用指令单独改）
    非数字内容、空行、# 注释行一律忽略。
    """
    result = {}
    if raw is None:
        return result
    text = str(raw)
    if not text.strip():
        return result

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # 只取群号：兼容误写逗号/空格分隔的情况
        gid = line.split(",")[0].split("，")[0].split()[0].strip()
        if not gid.isdigit():
            continue
        result[gid] = {}
    return result


class StatusPushModule:
    """定时状态推送模块（按分钟间隔）"""

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path

        # 全局配置（由 reload 注入）
        self.enable = False
        self.default_interval = DEFAULT_INTERVAL_MIN

        # 每群状态：{group_id: {"on": bool, "interval": 分钟数(0=用全局默认)}}
        self.groups = {}
        # 上次推送记录：{group_id: {"ts": 时间戳, "at": "YYYY-MM-DD HH:MM:SS"}}
        self.last_push = {}
        # 主动推送用：{group_id: unified_msg_origin}
        self.umos = {}
        # 后台配置的推送群：{group_id: {}}
        self.group_specs = {}
        # 由 main.py 注入：把「群号+是否排除」写回后台配置
        self._cfg_write = None

        self._load_state()

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}
        # 总开关由「电脑状态功能总开关」统一控制（main.py 通过 set_enable 注入）。
        # 这里保留旧键兼容：只有显式配了 daily_status_push_enable 时才覆盖。
        self.enable = bool(cfg.get("daily_status_push_enable", self.enable))

        self.default_interval = parse_interval_min(
            cfg.get("daily_status_push_interval_min", DEFAULT_INTERVAL_MIN),
            DEFAULT_INTERVAL_MIN,
        )

        # ★ 两份名单（都是白名单：填了才生效）
        #   手动查询用 status_groups，自动推送用 daily_status_push_groups
        self.blocked_groups = parse_gid_list(cfg.get("daily_status_push_groups", ""))
        self.group_specs = {g: {} for g in self.blocked_groups}
        self.use_backend_groups = bool(self.blocked_groups)
        self._sync_backend_groups()

    def set_enable(self, on: bool):
        """
        设置总开关（由「电脑状态功能总开关」统一注入）。
        定时推送与电脑状态查询共用同一个开关。
        """
        self.enable = bool(on)

    def _disable_all_groups(self):
        """后台未配置推送群时，关闭所有群，确保不会误推送。"""
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            changed = False
            for gid, cfg in list(self.groups.items()):
                if isinstance(cfg, dict) and cfg.get("on"):
                    cfg["on"] = False
                    changed = True
            if changed:
                self._save_state()

    def _sync_backend_groups(self):
        """
        后台「自动推送名单」（白名单）语义：
          · 填了群号    -> 只有这些群自动推送
          · 留空        -> 不自动推送任何群
        """
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            changed = False
            for gid in self.blocked_groups:
                cfg = self.groups.get(gid)
                if not isinstance(cfg, dict):
                    cfg = {"on": True, "interval": 0}
                if not cfg.get("on"):
                    cfg["on"] = True
                    changed = True
                cfg.setdefault("interval", 0)
                self.groups[gid] = cfg
                # 首次纳入名单时开始计时，避免刚填完就立刻推一次
                if gid not in self.last_push:
                    self.last_push[gid] = {
                        "ts": time.time(),
                        "at": now_str(),
                        "init": True,
                    }
                    changed = True
            for gid, cfg in list(self.groups.items()):
                if gid in self.blocked_groups:
                    continue
                if isinstance(cfg, dict) and cfg.get("on"):
                    cfg["on"] = False
                    changed = True
            if changed:
                self._save_state()
            logger.info(
                f"[status_push] 自动推送名单：{len(self.blocked_groups)} 个群"
            )

    def set_group_blocked(self, group_id, blocked: bool) -> bool:
        """把某群加入/移出后台「不生效的群号」名单（仅改内存+落盘配置由回调处理）。"""
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            gid = str(group_id)
            changed = False
            if blocked:
                if gid not in self.blocked_groups:
                    self.blocked_groups.append(gid)
                    changed = True
            else:
                if gid in self.blocked_groups:
                    self.blocked_groups.remove(gid)
                    changed = True
            if changed:
                cfg = self._group_cfg(gid)
                cfg["on"] = not blocked
                cfg.setdefault("interval", 0)
                self.groups[gid] = cfg
                self._save_state()
            return changed

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
            raw_last = data.get("last_push", {}) or {}
            # 兼容旧格式（值是字符串 "YYYY-MM-DD HH:MM"）与新格式（值是 dict）
            converted = {}
            for gid, val in raw_last.items():
                if isinstance(val, dict):
                    converted[gid] = val
                elif isinstance(val, str) and val:
                    try:
                        ts = datetime.datetime.strptime(val, "%Y-%m-%d %H:%M").timestamp()
                    except Exception:
                        ts = 0
                    converted[gid] = {"ts": ts, "at": val}
            self.last_push = converted
            self.umos = data.get("umos", {}) or {}
        except Exception:
            logger.exception("[status_push] 读取状态失败")

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
            logger.exception("[status_push] 保存状态失败")

    # ============================================================
    # UMO 记录
    # ============================================================
    def record_context(self, group_id, umo: str = ""):
        """记录群最近一次可用的 UMO，供定时推送复用。"""
        gid = str(group_id or "").strip()
        umo = str(umo or "").strip()
        if not gid or not umo:
            return
        # 快速路径：内存中已是同一个 UMO，直接返回，避免频繁加锁和写盘
        if self.umos.get(gid) == umo:
            return
        with _GLOBAL_PUSH_LOCK:
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
        # 黑名单语义：未配置的群默认开启
        if not isinstance(cfg, dict):
            cfg = {"on": True, "interval": 0}
        return cfg

    def is_group_on(self, group_id) -> bool:
        """该群是否自动推送定时状态（白名单语义：自动名单里填了才推）。"""
        gid = str(group_id)
        if gid not in self.blocked_groups:
            return False
        return bool(self._group_cfg(gid).get("on", True))

    def get_group_interval(self, group_id) -> int:
        """该群生效的推送间隔（分钟）：群自定义优先，否则全局默认。"""
        cfg = self._group_cfg(group_id)
        try:
            iv = int(cfg.get("interval", 0) or 0)
        except Exception:
            iv = 0
        if iv < MIN_INTERVAL_MIN:
            iv = 0
        return iv or self.default_interval

    def get_group_raw_interval(self, group_id) -> int:
        """该群显式设置的间隔（未设置为 0）。"""
        cfg = self._group_cfg(group_id)
        try:
            iv = int(cfg.get("interval", 0) or 0)
        except Exception:
            iv = 0
        return iv if iv >= MIN_INTERVAL_MIN else 0

    def get_last_push(self, group_id) -> dict:
        val = self.last_push.get(str(group_id))
        if isinstance(val, dict):
            return val
        return {}

    def set_group_on(self, group_id, on: bool):
        """开启/关闭某群的自动推送（白名单：开启则加入名单，关闭则移除）。"""
        gid = str(group_id)
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            # 同步后台自动名单（内存）
            if on:
                if gid not in self.blocked_groups:
                    self.blocked_groups.append(gid)
            else:
                if gid in self.blocked_groups:
                    self.blocked_groups.remove(gid)
            cfg = self._group_cfg(gid)
            cfg["on"] = bool(on)
            cfg.setdefault("interval", 0)
            self.groups[gid] = cfg
            # 刚开启时开始计时，避免立刻推一次
            if on and gid not in self.last_push:
                self.last_push[gid] = {"ts": time.time(), "at": now_str(), "init": True}
            self._save_state()
        # ★ 同步写回后台配置，重启后依然生效
        try:
            if self._cfg_write:
                self._cfg_write(gid, bool(on))
        except Exception:
            logger.exception("[status_push] 同步自动推送名单失败")

    def set_group_interval(self, group_id, minutes) -> bool:
        """设置群推送间隔；传空/0 表示恢复使用全局默认间隔。"""
        text = str(minutes or "").strip()
        if text:
            iv = parse_interval_min(text, default=0)
            if iv < MIN_INTERVAL_MIN:
                return False
        else:
            iv = 0
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            gid = str(group_id)
            cfg = self._group_cfg(gid)
            cfg["interval"] = iv
            cfg.setdefault("on", False)
            self.groups[gid] = cfg
            self._save_state()
        return True

    def is_group_configurable(self, group_id) -> bool:
        """该群是否在后台「自动推送名单」里（不在则不能开启自动推送）。"""
        return str(group_id) in self.blocked_groups

    def get_all_group_ids(self) -> list:
        """需要遍历的群：只遍历自动推送名单里的群（白名单语义）。"""
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            return sorted(str(x) for x in self.blocked_groups)

    def list_groups(self) -> list:
        out = []
        for gid, cfg in self.groups.items():
            if not isinstance(cfg, dict) or not cfg.get("on"):
                continue
            out.append({
                "group_id": gid,
                "interval": self.get_group_interval(gid),
                "custom": bool(self.get_group_raw_interval(gid)),
            })
        return sorted(out, key=lambda x: x["group_id"])

    # ============================================================
    # 到点判定 + 防重（原子）
    # ============================================================
    def check_and_mark(self, group_id) -> bool:
        """
        在全局锁内完成：重载磁盘 -> 校验总开关 -> 校验群开关
        -> 校验是否已满一个间隔 -> 标记本次推送。
        返回 True 表示本轮应当推送。
        """
        with _GLOBAL_PUSH_LOCK:
            self._load_state()
            # 总开关（电脑状态功能总开关）关闭时一律不推
            if not self.enable:
                return False
            gid = str(group_id)
            # ★ 白名单语义：只有后台「生效的群号」里的群才推（is_group_on 已校验）
            if not self.is_group_on(gid):
                return False
            iv = self.get_group_interval(gid)
            if iv < MIN_INTERVAL_MIN:
                return False
            now_ts = time.time()
            last = self.get_last_push(gid)
            last_ts = float(last.get("ts", 0) or 0)
            if last_ts > 0 and (now_ts - last_ts) < iv * 60:
                return False
            self.last_push[gid] = {"ts": now_ts, "at": now_str()}
            self._save_state()
            return True

    def pending_groups(self) -> list:
        """返回当前应当推送的群号列表（无副作用，供测试/调试）。"""
        now_ts = time.time()
        out = []
        for gid in self.get_all_group_ids():
            if not self.is_group_on(gid):
                continue
            iv = self.get_group_interval(gid)
            if iv < MIN_INTERVAL_MIN:
                continue
            last = self.get_last_push(gid)
            last_ts = float(last.get("ts", 0) or 0)
            if last_ts <= 0 or (now_ts - last_ts) >= iv * 60:
                out.append(gid)
        return sorted(out)
