import os
import sys
import json
import time
import platform
import datetime
import re
# ★★ 审核整改：`collect_runtime_status()` 里用 `asyncio.to_thread()`
#   把「含同步阻塞 IO 的取数函数」丢到线程池，避免卡住事件循环。
import asyncio

# ★★ 1.7.7：本模块以前**没有导入 logger**，但下面有 10 处 `logger.xxx` 调用 ——
#   那些分支一旦执行就会 `NameError`（例如 外部监控服务 请求失败、
#   版本探测失败时会再抛一次异常，把真正的错误盖掉）。
from astrbot.api import logger
try:
    from .path_utils import read_disk_config as _read_disk_config_util
    _HAS_PATH_UTILS = True
except Exception:
    _HAS_PATH_UTILS = False

try:
    import psutil
    _HAS_PSUTIL = True
except Exception:
    _HAS_PSUTIL = False


class _StatsDict(dict):
    """
    ★★ 1.7.7：收发计数的 dict —— **自增时自动（节流）落盘**。

    为什么用子类而不是改调用点：
      全插件有 **450+ 处** `GLOBAL_STATS["send"] += 1` 散落在各功能里，
      逐个改成 `bump_stat("send")` 既容易漏、又会动到大量无关代码。
      让 dict 自己在 `__setitem__` 里顺手存一次，调用点一行都不用改。

    ★ 落盘有 5 秒节流 + 「值没变不写」，所以不会因为高频发送而卡磁盘。
    ★ 任何异常都吞掉 —— 统计绝不能影响发消息。
    """

    def __setitem__(self, key, value):
        dict.__setitem__(self, key, value)
        try:
            if key in ("recv", "send"):
                save_msg_stats()
        except Exception:
            pass

    def __delitem__(self, key):
        dict.__delitem__(self, key)


GLOBAL_STATS = _StatsDict({"recv": 0, "send": 0})

# ★★ 1.7.7：收发消息计数**落盘**，重载插件不再归零。
#   以前这两个数只活在内存里，插件一重载就回到 0，用户每次都看到
#   「收到消息数量：0 条」。
#   做法：内存里照旧是这两个 key；每次自增后**节流落盘**（默认 5 秒一次），
#   插件加载时调 `load_msg_stats()` 把上次的值读回来。
_MSG_STATS_PATH = ""
_MSG_STATS_TS = 0.0
_MSG_STATS_SAVE_GAP = 5.0     # 落盘节流（秒）
_MSG_STATS_LAST_SAVE = {"recv": -1, "send": -1}


def set_msg_stats_path(path: str) -> None:
    """由 main.py 注入计数文件的路径（插件数据目录下）"""
    global _MSG_STATS_PATH
    _MSG_STATS_PATH = str(path or "")


def load_msg_stats() -> dict:
    """
    从磁盘恢复收发计数。返回恢复后的 dict（失败则返回当前值）。

    ★ 只在插件加载时调一次；没文件就是全新开始（保持 0）。
    """
    try:
        if not _MSG_STATS_PATH or not os.path.isfile(_MSG_STATS_PATH):
            return GLOBAL_STATS
        with open(_MSG_STATS_PATH, "r", encoding="utf-8-sig") as f:
            d = json.load(f)
        for k in ("recv", "send"):
            try:
                GLOBAL_STATS[k] = max(0, int(d.get(k, 0) or 0))
            except Exception:
                pass
        _MSG_STATS_LAST_SAVE.update(GLOBAL_STATS)
        logger.info(
            f"[apix-meme] 恢复收发计数：收 {GLOBAL_STATS['recv']} / "
            f"发 {GLOBAL_STATS['send']}")
    except Exception:
        logger.exception("[apix-meme] 恢复收发计数失败")
    return GLOBAL_STATS


def save_msg_stats(force: bool = False) -> bool:
    """
    把收发计数写盘。**节流**：默认 5 秒最多写一次，
    避免每发一条消息就写一次磁盘。`force=True` 立即写（卸载/重载时用）。
    """
    global _MSG_STATS_TS
    try:
        if not _MSG_STATS_PATH:
            return False
        now = time.time()
        if not force:
            if now - _MSG_STATS_TS < _MSG_STATS_SAVE_GAP:
                return False
            # 值没变就不用写
            if (_MSG_STATS_LAST_SAVE.get("recv") == GLOBAL_STATS.get("recv")
                    and _MSG_STATS_LAST_SAVE.get("send")
                    == GLOBAL_STATS.get("send")):
                _MSG_STATS_TS = now
                return False
        d = os.path.dirname(_MSG_STATS_PATH)
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        tmp = _MSG_STATS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"recv": int(GLOBAL_STATS.get("recv", 0) or 0),
                       "send": int(GLOBAL_STATS.get("send", 0) or 0),
                       "ts": int(now)}, f, ensure_ascii=False)
        os.replace(tmp, _MSG_STATS_PATH)
        _MSG_STATS_TS = now
        _MSG_STATS_LAST_SAVE.update(GLOBAL_STATS)
        return True
    except Exception:
        logger.exception("[apix-meme] 保存收发计数失败")
        return False


def bump_stat(key: str, n: int = 1, save: bool = True) -> int:
    """
    ★★ 1.7.7：给计数加 n 并（按需）落盘。返回加完后的值。

    ★ 平时不用它也行 —— 老代码里到处是 `GLOBAL_STATS["send"] += 1`，
      那些照旧能用（值是同一个 dict）；落盘靠调用 `save_msg_stats()`
      （插件卸载 / 定时都会顺手存一次）。
    """
    try:
        GLOBAL_STATS[key] = int(GLOBAL_STATS.get(key, 0) or 0) + int(n)
    except Exception:
        GLOBAL_STATS[key] = 0
    if save:
        save_msg_stats()
    return GLOBAL_STATS[key]

# 机器人自身 ID（QQ）缓存：
#   定时推送 / 页面预览这类「无事件」场景拿不到事件，只能靠缓存。
#   首次从消息事件取到后同时写进插件配置（bot_self_id），重启也能读到。
_BOT_ID = ""
_BOT_ID_SAVED = False


def is_valid_bot_id(value) -> bool:
    """判断是不是可用的机器人 ID（排除空值、非数字、UUID 这类占位符）"""
    v = str(value or "").strip()
    if not v:
        return False
    if not v.isdigit():
        # 非数字平台（如部分适配器返回字母 ID）也允许，但要长一点、不像 UUID
        if len(v) < 5 or "-" in v:
            return False
    return 5 <= len(v) <= 15


def set_bot_id(value, save: bool = True) -> bool:
    """记录机器人 ID；save=True 时写入插件配置，供重启后使用"""
    global _BOT_ID, _BOT_ID_SAVED
    v = str(value or "").strip()
    if not is_valid_bot_id(v):
        return False
    changed = (v != _BOT_ID)
    _BOT_ID = v
    if save and not _BOT_ID_SAVED:
        try:
            from .path_utils import read_disk_config, write_disk_config
            cfg = read_disk_config() or {}
            if isinstance(cfg, dict) and str(cfg.get("bot_self_id", "")) != v:
                cfg["bot_self_id"] = v
                write_disk_config(cfg)
                _BOT_ID_SAVED = True
        except Exception:
            pass
    return changed


def get_cached_bot_id() -> str:
    """取缓存的机器人 ID；内存没有就读一次插件配置"""
    global _BOT_ID, _BOT_ID_SAVED
    if _BOT_ID:
        return _BOT_ID
    try:
        from .path_utils import read_disk_config
        cfg = read_disk_config() or {}
        v = str((cfg or {}).get("bot_self_id", "") or "").strip()
        if is_valid_bot_id(v):
            _BOT_ID = v
            _BOT_ID_SAVED = True
            return v
    except Exception:
        pass
    return ""


# 由 main.py 注入的插件版本
PLUGIN_VERSION = ""


def set_plugin_version(version: str):
    global PLUGIN_VERSION
    PLUGIN_VERSION = str(version or "").strip()


# ============================================================
# 路径工具
# ============================================================
_PLUGIN_ID = "astrbot_plugin_custom_entertainment"
_CONFIG_FILENAME = f"{_PLUGIN_ID}_config.json"


def _find_astrbot_root() -> str:
    try:
        import astrbot
        pkg_dir = os.path.dirname(os.path.abspath(astrbot.__file__))
        root = os.path.dirname(pkg_dir)
        if os.path.isdir(os.path.join(root, "data", "config")):
            return root
        root2 = os.path.dirname(root)
        if os.path.isdir(os.path.join(root2, "data", "config")):
            return root2
    except Exception:
        pass
    cur = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        candidate = os.path.join(cur, "data", "config")
        if os.path.isdir(candidate):
            return cur
        cur = os.path.dirname(cur)
    return os.getcwd()


def _config_path() -> str:
    root = _find_astrbot_root()
    cfg_dir = os.path.join(root, "data", "config")
    os.makedirs(cfg_dir, exist_ok=True)
    return os.path.join(cfg_dir, _CONFIG_FILENAME)


def _read_plugin_cfg() -> dict:
    if _HAS_PATH_UTILS:
        try:
            data = _read_disk_config_util()
            return data if isinstance(data, dict) else {}
        except Exception:
            pass
    try:
        path = _config_path()
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _cfg_str(cfg: dict, key: str, default: str = "") -> str:
    v = cfg.get(key, default)
    if v is None:
        return default
    return str(v)


# ============================================================
# 格式化工具
# ============================================================
def _cfg_bool(cfg: dict, key: str, default: bool = True) -> bool:
    v = cfg.get(key, default)
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on", "是", "开启")


def _cfg_text(cfg: dict, key: str, default: str = "") -> str:
    v = cfg.get(key, default)
    if v is None:
        return default
    return str(v)


def human_bytes(n: float) -> str:
    try:
        n = float(n)
    except Exception:
        return str(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024.0:
            return f"{n:.2f}{unit}"
        n /= 1024.0
    return f"{n:.2f}PB"


def human_seconds(sec: float) -> str:
    try:
        sec = int(sec)
    except Exception:
        return str(sec)
    d, sec = divmod(sec, 86400)
    h, sec = divmod(sec, 3600)
    m, s = divmod(sec, 60)
    parts = []
    if d:
        parts.append(f"{d}天")
    if h:
        parts.append(f"{h}时")
    if m:
        parts.append(f"{m}分")
    parts.append(f"{s}秒")
    return "".join(parts)


def get_astrbot_version() -> str:
    try:
        import astrbot
        v = getattr(astrbot, "__version__", None)
        if v:
            return str(v)
    except Exception:
        pass
    try:
        from astrbot.core.config import VERSION
        if VERSION:
            return str(VERSION)
    except Exception:
        pass
    return "未知"


def get_os_version() -> str:
    """
    操作系统版本。

    ★★ 1.7.6：**不再带括号明细** —— 以前是
      `Windows 10 (Build 10.0.19045)`、`Linux (内核 6.x)`，
      用户要求只显示简洁版本号（括号内容直接去掉）。
    """
    try:
        system = platform.system()
        release = platform.release()
        if system == "Windows":
            return f"Windows {release}"
        if system == "Linux":
            try:
                with open("/etc/os-release", "r", encoding="utf-8") as f:
                    data = {}
                    for line in f:
                        line = line.strip()
                        if "=" in line:
                            k, v = line.split("=", 1)
                            data[k] = v.strip('"')
                pretty = data.get("PRETTY_NAME") or data.get("NAME") or "Linux"
                return str(pretty)
            except Exception:
                return f"Linux {release}"
        if system == "Darwin":
            return f"macOS {release}"
        return f"{system} {release}"
    except Exception:
        return "未知"


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


def get_bot_id(event=None) -> str:
    """
    取机器人自身 ID（QQ）。
    顺序：事件里的 self_id -> 之前缓存 / 配置里存的 -> 未知。
    定时推送与页面预览没有事件，靠缓存兜底。
    """
    # 1) 事件里的 self_id
    if event is not None:
        for getter in ("get_self_id", "get_bot_id"):
            try:
                fn = getattr(event, getter, None)
                if callable(fn):
                    v = fn()
                    if is_valid_bot_id(v):
                        set_bot_id(v)
                        return str(v).strip()
            except Exception:
                pass
        # 2) 事件对象上的常见属性
        try:
            mo = getattr(event, "message_obj", None)
            for src in (mo, event):
                if src is None:
                    continue
                v = getattr(src, "self_id", "") or ""
                if is_valid_bot_id(v):
                    set_bot_id(v)
                    return str(v).strip()
        except Exception:
            pass
    # 3) 缓存 / 配置
    cached = get_cached_bot_id()
    if cached:
        return cached
    return "未知"


def get_sender_name(event) -> str:
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


def get_pc_uptime_seconds() -> float:
    if _HAS_PSUTIL:
        try:
            return time.time() - psutil.boot_time()
        except Exception:
            return 0.0
    return 0.0


# ============================================================
# ★★ 1.1：硬件数据源 = **psutil**（AstrBot 运行时可识别，无外部依赖）
# ------------------------------------------------------------
# 原版把 CPU/内存/网络/流量 等硬件数据交给一个外部的 外部监控服务
# WebServer 提供（本机或局域网另一台机器），带来三个问题：
#   · 要多跑一个服务才能用（不是开箱即用）
#   · 服务不可达时会 `同步取数` 阻塞事件循环（社区审核标记）
#   · 局域网地址、超时、缓存一堆额外配置
#
# 现在**全部改用 psutil**（AstrBot 环境本身就有）：
#   CPU 占用 / 频率 / 分核  -> psutil
#   内存占用                -> psutil.virtual_memory()
#   网络实时速率            -> psutil.net_io_counters() 差分
#   硬盘占用 / 开机时长     -> psutil
#
# ★ Windows 上 psutil 拿不到 **CPU 温度 / 功耗 / 电压 / 风扇**
#   （`sensors_temperatures()` 在 Windows 返回空），
#   这几项在本版本固定返回空 —— 后台对应开关打开时该项不显示，
#   不会输出 "获取失败" 之类的噪音。
# ============================================================







def get_memory_usage_str() -> str:
    """
    运行内存占用（**纯 psutil**，AstrBot 运行时可识别，无外部依赖）。

    ★★ 1.1：原版优先向 外部监控服务 服务取数，服务不可达时会等超时，
      还把电脑状态变成"需要额外服务才能用"。现在全部改用 psutil。
    """
    if not _HAS_PSUTIL:
        return "⚠️ 未安装 psutil"
    try:
        vm = psutil.virtual_memory()
        return (f"{vm.percent}% 已用 {human_bytes(vm.used)}"
                f" / 共 {human_bytes(vm.total)}")
    except Exception:
        return "获取失败"



_NET_LAST = {"ts": 0.0, "up": 0, "down": 0}


def get_net_speed_str() -> str:
    """
    网络实时速率（**纯 psutil**：用网卡累计字节做差分）。

    返回两行（与「硬盘占用」同一套排版）：
        上传 xxx/s
        下载 xxx/s

    ★★ 1.1：原来取 外部监控服务 的 NET.Up/NET.Down；现在自己算，
      不依赖任何外部服务。首次调用没有基线，返回空（下次就有了）。
    """
    if not _HAS_PSUTIL:
        return ""
    try:
        import time as _t
        io_c = psutil.net_io_counters()
        now = _t.time()
        up, down = int(io_c.bytes_sent), int(io_c.bytes_recv)
        last_ts = float(_NET_LAST.get("ts") or 0)
        last_up = int(_NET_LAST.get("up") or 0)
        last_down = int(_NET_LAST.get("down") or 0)
        _NET_LAST["ts"], _NET_LAST["up"], _NET_LAST["down"] = now, up, down
        if last_ts <= 0 or now <= last_ts:
            return ""                      # 首次：没基线，不给数
        dt = now - last_ts
        if dt <= 0:
            return ""
        ups = max(0.0, (up - last_up) / dt)
        downs = max(0.0, (down - last_down) / dt)
        return (f"上传 {human_bytes(ups)}/s\n下载 {human_bytes(downs)}/s")
    except Exception:
        return ""




def _cpu_core_count() -> int:
    """逻辑核心数（拿不到返回 0）"""
    try:
        return int(psutil.cpu_count(logical=True) or 0)
    except Exception:
        return 0



def get_cpu_usage_str() -> str:
    """
    CPU **占用率**（不含核心数 —— 核心数有自己的开关）。

    ★★ 1.1：改用纯 psutil（原来优先问 外部监控服务）。
    """
    if not _HAS_PSUTIL:
        return "⚠️ 未安装 psutil"
    try:
        cores = _cpu_core_count()
        try:
            percent = psutil.cpu_percent(interval=0.15)
        except Exception:
            percent = psutil.cpu_percent(interval=None)
        if percent is None:
            return "获取失败"
        percent = float(percent)
        if percent < 0:
            return "获取失败"
        # 部分平台会给出 >100（多核累加），归一化到 0-100
        if percent > 100.0:
            percent = min(100.0, percent / max(1, cores or 1))
        return f"{percent:.1f}%"
    except Exception:
        return "获取失败"


def get_cpu_cores_str() -> str:
    """CPU **核心数**（物理核 / 逻辑核）"""
    try:
        logical = int(psutil.cpu_count(logical=True) or 0)
    except Exception:
        logical = 0
    try:
        physical = int(psutil.cpu_count(logical=False) or 0)
    except Exception:
        physical = 0
    if not logical:
        return ""
    if physical and physical != logical:
        return f"{physical} 物理核 / {logical} 逻辑核"
    return f"{logical} 核心"


def get_cpu_clock_str() -> str:
    """
    CPU **频率**（纯 psutil）。

    ★★ 1.1：原来优先问 外部监控服务，现在只用 psutil（AstrBot 自带）。
    """
    if not _HAS_PSUTIL:
        return ""
    try:
        f = psutil.cpu_freq()
        if f and f.current:
            return f"{f.current / 1000:.2f}GHz"
    except Exception:
        pass
    return ""


def get_cpu_cores_load_str() -> str:
    """
    CPU **分核占用**（每个逻辑核一行，一行放 4 个）。

    ★★ 1.1：**已经没有任何「睡眠等待」**（社区审核点名的阻塞点）。

    psutil 的 `cpu_percent(interval=None)` 给的是「距上次调用」的平均值，
    所以需要两次采样。原实现用「睡 0.2 秒」硬等 —— 即使调用方
    已把它丢进线程池，那段等待仍是纯浪费。

    现在改成：拿「两次瞬时采样之间的真实时间差」来算，
    时间差不够就先返回空（下次调用自然会补上），**绝不等待**。
    因为模块里缓存了上次采样点，同一进程多次查状态时
    第二次起就有足够的时间差，数据正常。
    """
    if not _HAS_PSUTIL:
        return ""
    try:
        now = time.monotonic()
        last_ts = float(_CPU_LOAD_LAST.get("ts") or 0.0)
        # 两次采样间隔太短 -> 数据不准，这次先不给（下次就有了）
        if last_ts and (now - last_ts) < 0.15:
            vals = _CPU_LOAD_LAST.get("vals") or []
            if vals:
                return _fmt_cores(vals)
            return ""
        vals = psutil.cpu_percent(interval=None, percpu=True) or []
        _CPU_LOAD_LAST["ts"] = now
        _CPU_LOAD_LAST["vals"] = list(vals)
        if not vals:
            return ""
        return _fmt_cores(vals)
    except Exception:
        return ""


_CPU_LOAD_LAST = {"ts": 0.0, "vals": []}


def _fmt_cores(vals) -> str:
    """把每核百分比排成「一行 4 个」的文本"""
    out = [f"核{i} {float(v):.0f}%" for i, v in enumerate(vals, start=1)]
    lines = []
    for i in range(0, len(out), 4):
        lines.append("  ".join(out[i:i + 4]))
    return "\n".join(lines)


def get_cpu_load_str() -> str:
    """
    CPU **负载**（1 / 5 / 15 分钟平均负载）。

    ★ Windows 上 `os.getloadavg()` 不可用 -> 返回空串（该项自动不显示）。
    """
    try:
        la = os.getloadavg()
    except Exception:
        return ""
    try:
        return f"1分钟 {la[0]:.2f} / 5分钟 {la[1]:.2f} / 15分钟 {la[2]:.2f}"
    except Exception:
        return ""



def get_cpu_temp_str() -> str:
    """
    CPU 温度。

    ★★ 1.1：**本版本不提供**。
      psutil 在 Windows 上拿不到 CPU 温度（`sensors_temperatures()`
      在 Windows 为空），而这些数据原本来自 外部监控服务 外部服务。
      为了做到「无外部依赖」，这里返回空 —— 后台对应开关打开时
      该项不显示，不会污染输出。
    """
    return ""



def get_cpu_power_str() -> str:
    """
    CPU 功耗。

    ★★ 1.1：**本版本不提供**。
      psutil 在 Windows 上拿不到 CPU 功耗（`sensors_temperatures()`
      在 Windows 为空），而这些数据原本来自 外部监控服务 外部服务。
      为了做到「无外部依赖」，这里返回空 —— 后台对应开关打开时
      该项不显示，不会污染输出。
    """
    return ""



def get_cpu_voltage_str() -> str:
    """
    CPU 电压。

    ★★ 1.1：**本版本不提供**。
      psutil 在 Windows 上拿不到 CPU 电压（`sensors_temperatures()`
      在 Windows 为空），而这些数据原本来自 外部监控服务 外部服务。
      为了做到「无外部依赖」，这里返回空 —— 后台对应开关打开时
      该项不显示，不会污染输出。
    """
    return ""



def get_cpu_fan_str() -> str:
    """
    CPU 风扇。

    ★★ 1.1：**本版本不提供**。
      psutil 在 Windows 上拿不到 CPU 风扇（`sensors_temperatures()`
      在 Windows 为空），而这些数据原本来自 外部监控服务 外部服务。
      为了做到「无外部依赖」，这里返回空 —— 后台对应开关打开时
      该项不显示，不会污染输出。
    """
    return ""


def get_disk_usage_str() -> str:
    """
    各磁盘占用。

    ★★ 1.7.6：返回的每项是**两行** ——
        盘符
          占用明细
      以前盘符和明细挤一行（`C:\\：54.8% 已用 61.11GB / 共 111.48GB`），
      卡片自动折行会把 `GB` 断成 `G` / `B`，很难看（用户反馈）。
    """
    if not _HAS_PSUTIL:
        return "⚠️ 未安装 psutil"
    try:
        parts = psutil.disk_partitions(all=False)
    except Exception:
        return "获取失败"
    lines = []
    shown = 0
    for p in parts:
        if shown >= 8:
            break
        try:
            usage = psutil.disk_usage(p.mountpoint)
        except Exception:
            continue
        lines.append(str(p.device))
        lines.append(
            f"  {usage.percent}% 已用 {human_bytes(usage.used)} / 共 {human_bytes(usage.total)}"
        )
        shown += 1
    return "\n".join(lines) if lines else "获取失败"


# ============================================================
# 主入口：按配置输出指定项目
# ============================================================
# ============================================================
# 协议端版本（NapCat / PCQQ） 与 北京时间
# ============================================================
import time as _time
from .path_utils import title_bar, title_foot
from . import path_utils as _path_utils

_AGENT_CACHE = {"ts": 0.0, "napcat": "", "pcqq": "", "name": ""}
_AGENT_TTL = 3600          # 1 小时刷新一次


def _qq_ver_from_registry() -> str:
    """
    从注册表读 QQ 版本（`Uninstall\\QQ` 的 DisplayVersion）。

    ★★ 1.7.6 新增：用户把 QQ 装在**非默认盘**（如 `D:\\QQ\\NT`）时，
      原来只扫 `C:\\Program Files\\...\\versions` 的写法会漏掉，
      电脑状态里 PCQQ 版本一直显示「未知」。
      注册表这条与安装路径无关，最可靠。
    """
    try:
        import winreg
    except Exception:
        return ""
    keys = [
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\WOW6432Node\Microsoft\Windows"
         r"\CurrentVersion\Uninstall\QQ"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ"),
        (winreg.HKEY_CURRENT_USER,
         r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"SOFTWARE\WOW6432Node\Tencent\QQ"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Tencent\QQ"),
    ]
    for hive, path in keys:
        try:
            k = winreg.OpenKey(hive, path)
        except Exception:
            continue
        for val in ("DisplayVersion", "Version", "ver"):
            try:
                v = str(winreg.QueryValueEx(k, val)[0] or "").strip()
            except Exception:
                continue
            m = re.match(r"(\d+(?:\.\d+){1,3})", v)
            if m:
                return m.group(1)
    return ""


def _qq_ver_from_exe() -> str:
    """
    读 `QQ.exe` 的文件版本（Win32 版本 API，不依赖 PowerShell）。

    ★ 注册表拿不到时的兜底。会扫描常见的几处安装位置。
    """
    import glob as _glob
    pats = [
        r"C:\Program Files\Tencent\QQNT\QQ.exe",
        r"C:\Program Files (x86)\Tencent\QQNT\QQ.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs",
                     "Tencent", "QQNT", "QQ.exe"),
        os.path.join(os.environ.get("ProgramData", ""), "Tencent",
                     "QQNT", "QQ.exe"),
        # ★ 非默认盘（D/E/F…）也扫一遍 —— 用户常把 QQ 装在这里
        r"D:\QQ\NT\QQ.exe", r"E:\QQ\NT\QQ.exe", r"F:\QQ\NT\QQ.exe",
        r"D:\Tencent\QQNT\QQ.exe", r"E:\Tencent\QQNT\QQ.exe",
        r"D:\*\NT\QQ.exe", r"E:\*\NT\QQ.exe",
        r"D:\*\QQNT\QQ.exe", r"E:\*\QQNT\QQ.exe",
    ]
    for pat in pats:
        for p in _glob.glob(pat):
            if not os.path.isfile(p):
                continue
            v = _file_version(p)
            if v:
                return v
    return ""


def _file_version(path: str) -> str:
    """用 Win32 版本 API 读文件版本；失败返回空串"""
    try:
        import ctypes
        from ctypes import wintypes
        _ver = ctypes.WinDLL("version")
        _getsize = _ver.GetFileVersionInfoSizeW
        _getsize.argtypes = [wintypes.LPCWSTR,
                             ctypes.POINTER(wintypes.DWORD)]
        _getsize.restype = wintypes.DWORD
        _getinfo = _ver.GetFileVersionInfoW
        _getinfo.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                             wintypes.DWORD, wintypes.LPVOID]
        _getinfo.restype = wintypes.BOOL
        _query = _ver.VerQueryValueW
        _query.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR,
                           ctypes.POINTER(wintypes.LPVOID),
                           ctypes.POINTER(wintypes.UINT)]
        _query.restype = wintypes.BOOL

        dummy = wintypes.DWORD()
        size = _getsize(str(path), ctypes.byref(dummy))
        if not size:
            return ""
        buf = ctypes.create_string_buffer(size)
        if not _getinfo(str(path), 0, size, buf):
            return ""
        pv = wintypes.LPVOID()
        ln = wintypes.UINT()
        if not _query(buf, "\\VarFileInfo\\Translation",
                      ctypes.byref(pv), ctypes.byref(ln)):
            return ""
        tr = ctypes.cast(pv, ctypes.POINTER(wintypes.WORD))
        sub = "\\StringFileInfo\\%04x%04x\\FileVersion" % (tr[0], tr[1])
        if not _query(buf, sub, ctypes.byref(pv), ctypes.byref(ln)):
            return ""
        # ★ wstring_at 会把结尾的 \x00 也带出来，必须 strip
        s = ctypes.wstring_at(pv, ln.value).replace("\x00", "").strip()
        m = re.match(r"(\d+(?:\.\d+){1,3})", s)
        return m.group(1) if m else ""
    except Exception as e:
        logger.debug(f"[apix-meme] 读文件版本失败（{path}）: {e}")
        return ""


def _read_installed_qq_version() -> str:
    """
    已安装的 PCQQ 版本。按可靠性依次尝试：

      ① 注册表 `Uninstall\\QQ` 的 DisplayVersion —— 与安装盘无关，最可靠
      ② 读 `QQ.exe` 的文件版本（扫常见位置，含 D/E/F 盘）
      ③ QQNT 的 `versions\\<版本>` 目录名

    ★★ 1.7.6：原来只做 ③ 且**写死 C 盘路径**，用户把 QQ 装在
      `D:\\QQ\\NT` 时永远读不到 -> 电脑状态显示「未知」（用户反馈）。
    """
    # ① 注册表
    v = _qq_ver_from_registry()
    if v:
        return v
    # ② QQ.exe 文件版本
    v = _qq_ver_from_exe()
    if v:
        return v
    # ③ versions 目录（含非默认盘）
    import glob as _glob
    pats = [
        r"C:\Program Files\Tencent\QQNT\versions\*",
        r"C:\Program Files (x86)\Tencent\QQNT\versions\*",
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     "Programs", "Tencent", "QQNT", "versions", "*"),
        os.path.join(os.environ.get("ProgramData", ""),
                     "Tencent", "QQNT", "versions", "*"),
        r"D:\QQ\NT\versions\*", r"E:\QQ\NT\versions\*", r"F:\QQ\NT\versions\*",
        r"D:\*\NT\versions\*", r"E:\*\NT\versions\*",
        r"D:\Tencent\QQNT\versions\*", r"E:\Tencent\QQNT\versions\*",
        r"D:\*\QQNT\versions\*", r"E:\*\QQNT\versions\*",
    ]
    best = ""
    for pat in pats:
        try:
            for d in _glob.glob(pat):
                if not os.path.isdir(d):
                    continue
                m = re.match(r"(\d+(?:\.\d+){1,3})", os.path.basename(d))
                if m and m.group(1) > best:
                    best = m.group(1)
        except Exception as e:
            logger.debug(f"[apix-meme] 读 QQ 安装版本失败（{pat}）: {e}")
    return best


def get_napcat_version() -> str:
    """NapCat 版本（来自 OneBot get_version_info 的缓存）"""
    return _AGENT_CACHE.get("napcat", "") or "未知"


# ============================================================
# ★★ 1.7.6：本地「机器人框架」版本
# ------------------------------------------------------------
# 用户要求：把框架版本插在「NapCat版本」**上一行**，并算在版本显示里，
#   后台可单独开关。
#
# ★ 它是**本地已安装的框架**版本（读 exe 的文件版本），
#   和「NapCat版本」（协议端接口自报的内核版本）是两回事 ——
#   所以单独一行，不去改名 NapCat 那行。
#
# 按顺序探测，命中第一个就返回：
#   萌QNT      D:\萌Q\MQNT.exe                  （ProductName「萌QNT框架」）
#   NapCatQQ   D:\NapCatQQ Desktop\NapCatQQ-Desktop.exe
#   通用兜底    后台可自己填 exe 路径（cfg: framework_version_exe）
# ============================================================
FRAMEWORK_CANDIDATES = [
    ("萌QNT", [r"D:\萌Q\MQNT.exe", r"E:\萌Q\MQNT.exe", r"C:\萌Q\MQNT.exe",
               r"D:\*\MQNT.exe", r"E:\*\MQNT.exe"]),
    ("NapCatQQ Desktop", [
        r"D:\NapCatQQ Desktop\NapCatQQ-Desktop.exe",
        r"C:\NapCatQQ Desktop\NapCatQQ-Desktop.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs",
                     "NapCatQQ Desktop", "NapCatQQ-Desktop.exe"),
        r"D:\*\NapCatQQ Desktop\NapCatQQ-Desktop.exe"]),
]
_FW_CACHE = {"ts": 0.0, "name": "", "ver": ""}
_FW_TTL = 600           # 10 分钟（框架版本不会变，不用频繁读盘）


def get_framework_info(force: bool = False) -> tuple:
    """
    本地机器人框架的 (名称, 版本)。

    找不到返回 ("", "")。结果缓存 10 分钟。
    """
    now = _time.time()
    if (not force) and _FW_CACHE["ts"] and \
            (now - _FW_CACHE["ts"]) < _FW_TTL:
        return _FW_CACHE["name"], _FW_CACHE["ver"]
    name, ver = "", ""
    # ① 后台指定的 exe 优先
    try:
        _p = str(_read_plugin_cfg().get("framework_version_exe", "")
                 or "").strip()
    except Exception:
        _p = ""
    cands = []
    if _p:
        cands.append(("", [_p]))
    cands += FRAMEWORK_CANDIDATES
    import glob as _glob
    for _label, pats in cands:
        for pat in pats:
            try:
                hits = _glob.glob(pat)
            except Exception:
                continue
            for h in hits:
                if not os.path.isfile(h):
                    continue
                v = _file_version(h)
                if not v:
                    continue
                name = _label or _framework_name_of(h) or \
                    os.path.splitext(os.path.basename(h))[0]
                ver = v
                break
            if ver:
                break
        if ver:
            break
    _FW_CACHE["ts"] = now
    _FW_CACHE["name"] = name
    _FW_CACHE["ver"] = ver
    return name, ver


def _framework_name_of(path: str) -> str:
    """按 exe 路径猜框架名（找不到就用文件夹名）"""
    up = str(path or "").upper()
    if "MQNT" in up or "萌Q" in str(path or ""):
        return "萌QNT"
    if "NAPCATQQ DESKTOP" in up:
        return "NapCatQQ Desktop"
    try:
        return os.path.basename(os.path.dirname(path)) or ""
    except Exception:
        return ""


def get_framework_version_str() -> str:
    """
    框架版本显示文本。

    有名字就给 `萌QNT 7.6`，只有版本就给 `7.6`，都没有返回空串。

    ★★ 1.7.6：版本**只取前两段**（`7.6.0.0` -> `7.6`）——
      用户要求萌Q版本只显示 `7.6`，后面两段太啰嗦。
    """
    name, ver = get_framework_info()
    if not ver:
        return ""
    # 只保留前两段：7.6.0.0 -> 7.6 ；9.9.33.52230 -> 9.9
    try:
        _parts = [x for x in str(ver).split(".") if x != ""]
        if len(_parts) >= 2:
            ver = f"{_parts[0]}.{_parts[1]}"
        elif _parts:
            ver = _parts[0]
    except Exception:
        pass
    return f"{name} {ver}" if name else ver


def get_pcqq_version() -> str:
    """PCQQ（QQ 客户端）版本：先用 OneBot 缓存，再退回读安装目录"""
    v = _AGENT_CACHE.get("pcqq", "")
    return v or _read_installed_qq_version() or "未知"


def get_agent_name() -> str:
    """协议端名称（NapCat / LLOneBot / Lagrange …）"""
    return _AGENT_CACHE.get("name", "") or "未知"


def _client_from_plugin(plugin):
    """从插件 context 里挖出 aiocqhttp 的 CQHttp 客户端（拿不到返回 None）"""
    if plugin is None:
        return None
    ctx = getattr(plugin, "context", None)
    if ctx is None:
        return None
    for getter in ("get_platform", "get_platform_inst"):
        try:
            fn = getattr(ctx, getter, None)
            if fn is None:
                continue
            if getter == "get_platform":
                ad = fn("aiocqhttp")
            else:
                ad = fn("default")
            if ad is None:
                continue
            for attr in ("get_client", "bot", "_bot"):
                c = getattr(ad, attr, None)
                if callable(c):
                    c = c()
                if c is not None and hasattr(c, "call_action"):
                    return c
        except Exception:
            continue
    return None


async def refresh_agent_versions(event=None, force: bool = False,
                                 plugin=None) -> dict:
    """
    通过 OneBot 的 `get_version_info` 取协议端版本，缓存 1 小时。

    · event  有事件时直接用 event.bot
    · plugin 没事件时（定时推送 / 页面预览）用 plugin.context 找客户端
    · 都拿不到就保持旧缓存（PCQQ 版本会退回读 QQNT 安装目录）
    """
    now = _time.time()
    if (not force) and _AGENT_CACHE["ts"] and \
            (now - _AGENT_CACHE["ts"]) < _AGENT_TTL:
        return dict(_AGENT_CACHE)

    try:
        bot = getattr(event, "bot", None) if event is not None else None
    except Exception:
        bot = None
    if bot is None or not hasattr(bot, "call_action"):
        bot = _client_from_plugin(plugin)
    if bot is None or not hasattr(bot, "call_action"):
        return dict(_AGENT_CACHE)

    info = None
    for action in ("get_version_info", "get_status"):
        try:
            r = bot.call_action(action)
            if hasattr(r, "__await__"):
                r = await r
            if r:
                info = r
                break
        except Exception as e:
            logger.debug(f"[apix-meme] {action} 失败: {e}")
            continue
    if not isinstance(info, dict):
        return dict(_AGENT_CACHE)

    data = info.get("data") if isinstance(info.get("data"), dict) else info
    app_name = str(data.get("app_name") or data.get("appName")
                   or data.get("name") or "").strip()
    app_ver = str(data.get("app_version") or data.get("appVersion")
                  or data.get("version") or "").strip()

    qq_ver = ""
    for k in ("qq_version", "qqVersion", "client_version",
              "clientVersion", "qq_ver"):
        v = data.get(k)
        if v:
            qq_ver = str(v).strip()
            break
    if not qq_ver:
        proto = data.get("protocol")
        if isinstance(proto, dict):
            qq_ver = str(proto.get("version") or "").strip()
    if qq_ver:
        m = re.match(r"(\d+(?:\.\d+){1,3})", qq_ver)
        if m:
            qq_ver = m.group(1)

    _AGENT_CACHE["ts"] = now
    if app_name:
        _AGENT_CACHE["name"] = app_name
    if app_ver:
        _AGENT_CACHE["napcat"] = app_ver
    if qq_ver:
        _AGENT_CACHE["pcqq"] = qq_ver
    try:
        logger.info(
            "[apix-meme] 协议端版本：name=%r version=%r QQ=%r 原始字段=%r",
            app_name, app_ver, qq_ver,
            {k: str(v)[:40] for k, v in list(data.items())[:12]})
    except Exception:
        pass
    return dict(_AGENT_CACHE)


def get_beijing_time() -> str:
    """北京时间（YYYY-MM-DD HH:MM:SS 周X）"""
    try:
        import datetime as _dt
        try:
            from zoneinfo import ZoneInfo
            now = _dt.datetime.now(ZoneInfo("Asia/Shanghai"))
        except Exception:
            now = _dt.datetime.now()
        wd = "一二三四五六日"[now.weekday()]
        return now.strftime("%Y-%m-%d %H:%M:%S") + f" 周{wd}"
    except Exception:
        return "未知"


async def collect_runtime_status(event=None, group_id: str = None,
                                 cfg: dict = None,
                                 plugin=None) -> str:
    """
    生成机器人运行状态文本（async：需要向协议端问版本号）。

    event    : 触发事件；定时推送时可为 None（此时用 group_id 指定群号）
    group_id : 无事件场景（定时推送 / 页面预览）下手动指定的群号
    cfg      : 插件配置；传入则按 cmd_status_show_* 开关裁剪输出

    基础信息可分别开关（后台「电脑状态」页）：
        cmd_status_show_gid          当前群群号
        cmd_status_show_bot_qq       机器人QQ
        cmd_status_show_version      版本总开关
        cmd_status_show_ver_plugin   插件版本
        cmd_status_show_ver_astrbot  AstrBot 版本
        cmd_status_show_ver_napcat   NapCat 版本
        cmd_status_show_ver_pcqq     PCQQ 版本
        cmd_status_show_ver_os       系统版本
        cmd_status_show_msg_stats    消息统计
        cmd_status_show_time         北京时间（输出在**最下面**）

    顺序（从上到下）：
        标题 / 群号 / 机器人QQ / 各版本 / 消息统计
        / 开机时长 / CPU / 内存 / 硬盘 / 北京时间 / 末尾附加
    """
    cfg = cfg if isinstance(cfg, dict) else _read_plugin_cfg()

    # ★ 先问一次协议端版本（有 1 小时缓存，不会每次都问）
    try:
        await refresh_agent_versions(event, plugin=plugin)
    except Exception:
        logger.debug("[apix-meme] 刷新协议端版本失败", exc_info=True)

    # ★★ 1.7.6：电脑状态标题**不再单独配置**。
    #   前缀由「菜单指令 → 全局标题前缀」统一控制，
    #   这里只给标题正文（不写前缀），避免出现两处配置打架。
    #   （老的 cmd_status_title 若还填着，也照样归一，兼容老配置。）
    _raw_title = str(_cfg_text(cfg, "cmd_status_title", "") or "").strip()
    _t = _raw_title.strip("=＝·・-—─━ \t")
    # ★ 去掉可能残留的老前缀（用户以前在标题里写死的前缀）
    _pfx = getattr(_path_utils, "TITLE_PREFIX", "") or ""
    _OLDS = ("铁剑娘系统：", "自定义娱乐：", "鸡鸡娱乐系统：",
             "铁剑娘系统:", "自定义娱乐:", "鸡鸡娱乐系统:")
    for _p in ([_pfx] if _pfx else []) + list(_OLDS):
        if _p and _t.startswith(_p):
            _t = _t[len(_p):].strip()
            break
    title = title_bar(_t or "机器人运行状态")
    lines = [title]

    show_basic = _cfg_bool(cfg, "cmd_status_show_basic", True)
    show_gid = show_basic and _cfg_bool(cfg, "cmd_status_show_gid", True)
    show_qq = show_basic and _cfg_bool(cfg, "cmd_status_show_bot_qq", True)
    # 版本：总开关 + 每一项各自开关
    show_ver = show_basic and _cfg_bool(cfg, "cmd_status_show_version", True)
    show_ver_plugin = show_ver and _cfg_bool(
        cfg, "cmd_status_show_ver_plugin", True)
    show_ver_astrbot = show_ver and _cfg_bool(
        cfg, "cmd_status_show_ver_astrbot", True)
    show_ver_napcat = show_ver and _cfg_bool(
        cfg, "cmd_status_show_ver_napcat", True)
    # ★★ 1.7.6：本地框架版本（萌QNT / NapCatQQ Desktop），单独开关，
    #   算在「版本」这一组里（总开关关掉它也不显示）。
    show_ver_framework = show_ver and _cfg_bool(
        cfg, "cmd_status_show_ver_framework", True)
    show_ver_pcqq = show_ver and _cfg_bool(
        cfg, "cmd_status_show_ver_pcqq", True)
    show_ver_os = show_ver and _cfg_bool(cfg, "cmd_status_show_ver_os", True)
    show_msg = show_basic and _cfg_bool(cfg, "cmd_status_show_msg_stats", True)
    show_time = show_basic and _cfg_bool(cfg, "cmd_status_show_time", True)
    show_uptime = _cfg_bool(cfg, "cmd_status_show_uptime", True)
    show_mem = _cfg_bool(cfg, "cmd_status_show_mem", True)
    show_disk = _cfg_bool(cfg, "cmd_status_show_disk", True)
    # ★★ 1.7.6 新增（都来自 外部监控服务，可后台单独开关）
    show_net = _cfg_bool(cfg, "cmd_status_show_net", True)
    show_traffic = _cfg_bool(cfg, "cmd_status_show_traffic", True)
    show_gpu = _cfg_bool(cfg, "cmd_status_show_gpu", False)

    # ---- ① 群号 ----
    if show_gid:
        if group_id:
            gid = str(group_id).strip()
        else:
            gid = get_group_id(event) if event is not None else ""
        lines.append(f"当前群群号：{gid or '未知'}")

    # ---- ② 机器人 QQ ----
    if show_qq:
        lines.append(f"机器人QQ：{get_bot_id(event)}")

    # ---- ③ 版本（每一项可单独开关）----
    if show_ver_plugin:
        lines.append(f"插件版本：{PLUGIN_VERSION or '未知'}")
    if show_ver_astrbot:
        lines.append(f"AstrBot版本：{get_astrbot_version()}")
    # ★★ 1.7.6：框架版本插在「NapCat版本」**上一行**
    #   （本地已安装框架，如 萌QNT 7.6.0.0；读不到就整行不显示）
    if show_ver_framework:
        _fw = get_framework_version_str()
        if _fw:
            lines.append(f"框架版本：{_fw}")
    if show_ver_napcat:
        lines.append(f"NapCat版本：{get_napcat_version()}")
    if show_ver_pcqq:
        lines.append(f"PCQQ版本：{get_pcqq_version()}")
    if show_ver_os:
        lines.append(f"系统版本：{get_os_version()}")

    # ---- ④ 消息统计 ----
    if show_msg:
        lines.append(f"收到消息数量：{GLOBAL_STATS['recv']} 条")
        lines.append(f"发出消息数量：{GLOBAL_STATS['send']} 条")

    # ---- 开机时长 ----
    if show_uptime:
        uptime = get_pc_uptime_seconds()
        if uptime > 0:
            lines.append(f"电脑开机时间：{human_seconds(uptime)}")
        else:
            lines.append("电脑开机时间：⚠️ 未安装 psutil，无法获取")

    # ---- CPU（★ 1.7.6：**每一项各自独立开关**）----
    #   cpu 总开关关掉 -> 下面所有 CPU 细分项都不显示
    show_cpu = _cfg_bool(cfg, "cmd_status_show_cpu", True)
    _cpu_items = [
        ("cmd_status_show_cpu_load_rate", "CPU占用",
         get_cpu_usage_str, False),
        ("cmd_status_show_cpu_cores", "CPU核心数",
         get_cpu_cores_str, False),
        ("cmd_status_show_cpu_clock", "CPU频率",
         get_cpu_clock_str, False),
        ("cmd_status_show_cpu_cores_load", "CPU分核占用",
         get_cpu_cores_load_str, True),
        ("cmd_status_show_cpu_load", "CPU负载",
         get_cpu_load_str, False),
        ("cmd_status_show_cpu_temp", "CPU温度",
         get_cpu_temp_str, False),
        ("cmd_status_show_cpu_power", "CPU功耗",
         get_cpu_power_str, False),
        ("cmd_status_show_cpu_voltage", "CPU电压",
         get_cpu_voltage_str, False),
        ("cmd_status_show_cpu_fan", "CPU风扇",
         get_cpu_fan_str, False),
    ]
    if show_cpu:
        for _key, _label, _fn, _multi in _cpu_items:
            if not _cfg_bool(cfg, _key, True):
                continue
            try:
                # ★★ 审核整改：这些取数函数里有**同步阻塞 IO**
                #   （外部监控服务 的 同步网络取数、CPU 分核采样的
                #     睡眠等待），直接在事件循环里调会卡住整个机器人。
                #   统一丢到线程池执行。
                _val = str(await asyncio.to_thread(_fn) or "").strip()
            except Exception:
                logger.debug(f"[apix-meme] 取 {_label} 失败", exc_info=True)
                continue
            if not _val:
                continue          # 没数据就不显示（如 Windows 无负载）
            if _multi:
                lines.append(f"{_label}：")
                for _l in _val.splitlines():
                    lines.append(f"  {_l}")
            else:
                lines.append(f"{_label}：{_val}")

    # ---- 运行内存占用 ----
    # ★★ 1.7.6：和「硬盘占用」一套排版 —— 标签独占一行，
    #   明细缩进换行。以前 `运行内存占用：38.0% 已用 11.89GB / 共 31.30GB`
    #   挤在一行会被卡片自动折行，折在数字中间看着很乱（用户反馈）。
    if show_mem:
        lines.append("运行内存占用：")
        # ★ 审核整改：内含 外部监控服务 同步请求，丢线程池
        _mem = await asyncio.to_thread(get_memory_usage_str)
        for line in str(_mem or "").splitlines():
            lines.append(f"  {line}")

    # ---- 硬盘占用 ----
    # ★★ 1.7.6：明细里「盘符」在顶格、「占用」带 2 空格缩进；
    #   这里给每行统一再加 2 空格，得到「盘符缩进一层、明细再深一层」。
    if show_disk:
        lines.append("硬盘占用：")
        for line in get_disk_usage_str().splitlines():
            lines.append(f"  {line}" if line.strip() else line)

    # ---- 网络速率（★ 1.7.6 新增，在硬盘下面，同一套排版）----
    if show_net:
        # ★ 走线程池（psutil 取网卡计数是阻塞调用）
        _net = await asyncio.to_thread(get_net_speed_str)
        if _net:
            lines.append("网络速率：")
            for line in str(_net).splitlines():
                lines.append(f"  {line}")

    # ---- 流量统计 ----
    # ★★ 1.1：**已移除**（原来取 外部监控服务 的 DATA.DayUp/DayDown，
    #   本机 psutil 拿不到「今日流量」，所以这一项不再提供）
    _ = show_traffic

    # ---- ⑤ 北京时间（★ 固定放在最下面）----
    if show_time:
        lines.append(f"北京时间：{get_beijing_time()}")

    text = "\n".join(lines)

    tail = _cfg_text(cfg, "cmd_status_tail", "")
    if tail.strip():
        text = f"{text}\n{tail}"

    return text
