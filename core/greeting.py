import os
import json
import time
import datetime
from astrbot.api import logger

from .path_utils import parse_gid_list as _parse_gid_list
from .path_utils import title_bar, title_foot
from .path_utils import fmt_num
# ★★ 1.7.7：昵称截断（长名字用省略号，别把榜单行撑宽）
from .path_utils import nick_display as _nick_display
# ★★ 1.7.7：榜单行用窄档（有「 1. 」前缀和「 — 5 天」后缀）
from .path_utils import nick_display_narrow as _nick_narrow
# ★★ 市场版 1.1：排行名次前缀（前三名奖牌，其余「N.」）
from .path_utils import rank_tag as _rank_tag

def _parse_names(raw: str) -> list:
    if not raw:
        return []
    text = str(raw)
    return [x.strip() for x in text.split(",") if x.strip()]

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

def format_duration(seconds: int, fmt: str = "hms") -> str:
    seconds = int(seconds)
    if seconds < 0:
        seconds = 0
    if fmt == "seconds":
        return f"{seconds} 秒"
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d}天")
    if h:
        parts.append(f"{h}小时")
    if m:
        parts.append(f"{m}分")
    parts.append(f"{s}秒")
    return "".join(parts)

def format_time_point(ts: float) -> str:
    if not ts:
        return "（未知）"
    try:
        dt = datetime.datetime.fromtimestamp(ts)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "（未知）"

def get_logic_day(ts: float, day_start_hour: int) -> str:
    dt = datetime.datetime.fromtimestamp(ts)
    if dt.hour < day_start_hour:
        dt = dt - datetime.timedelta(days=1)
    return dt.strftime("%Y-%m-%d")


DEFAULT_MORNING_MESSAGES = [
    (0, 5, "🌙 这么晚还没睡？还是刚起？注意身体啊~"),
    (5, 7, "🌅 早起的鸟儿有虫吃，早安！"),
    (7, 9, "☀️ 早上好！新的一天开始啦~"),
    (9, 11, "🌞 太阳晒屁股啦，早上好~"),
    (11, 13, "🍱 这是中午了吧，中午好~"),
    (13, 18, "😴 下午才起，昨晚干啥了？"),
    (18, 24, "🌆 晚上才起？作息有点乱哦~"),
]
DEFAULT_NIGHT_MESSAGES = [
    (0, 2, "🌙 熬夜伤身，晚安~"),
    (2, 5, "🌌 通宵修仙？快睡吧~"),
    (5, 8, "🌅 才睡？天都亮了..."),
    (8, 12, "😴 白天睡觉，作息颠倒啦~"),
    (12, 18, "☀️ 午休一下也不错，晚安~"),
    (18, 22, "🌆 这么早就睡？晚安~"),
    (22, 24, "🌙 正常作息，晚安好梦~"),
]

_RECORD_KEYS = (
    "morning_ts", "morning_logic_day", "night_ts", "night_logic_day",
    "morning_repeat", "night_repeat",
    # v1.6.9 新增字段，同样用于识别"这是一条用户记录"而不是按群嵌套结构
    "day_stats", "morning_days", "night_days",
)

def _looks_like_record(d) -> bool:
    if not isinstance(d, dict):
        return False
    for k in _RECORD_KEYS:
        if k in d:
            return True
    # 兜底：只有次数统计、没有逻辑日的老记录（正常打卡必然会写逻辑日，
    # 但为了兼容极端历史数据，这里也认一下）
    return "total_morning" in d or "total_night" in d


class GreetingModule:
    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.enable = True
        self.morning_names = ["早安", "早上好", "起床"]
        self.night_names = ["晚安", "睡觉", "睡了"]
        self.time_format = "hms"
        self.allowed_groups = []

        self.day_start_hour = 6
        self.morning_cutoff_hour = 12
        self.night_cutoff_hour = 23
        self.night_cutoff_minute = 59

        self.min_awake_seconds = 0
        self.max_repeat_remind = 0
        self.morning_messages = self._default_messages(DEFAULT_MORNING_MESSAGES)
        self.night_messages = self._default_messages(DEFAULT_NIGHT_MESSAGES)
        self.records = {}

        # ★ 由 main.py 注入的全局昵称缓存
        # ★★ 市场版 1.1：三条独立排行指令（天数 / 清醒 / 睡眠）
        self.rank_days_names = ["打卡天数排行", "天数排行"]
        self.rank_awake_names = ["清醒时长排行", "清醒排行"]
        self.rank_sleep_names = ["睡眠时长排行", "睡眠排行"]

        self.nickname_cache = {}

        self._load_records()

    @staticmethod
    def _default_messages(items):
        return [{"start": s, "end": e, "message": m} for s, e, m in items]

    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("greeting_enable", True))
        raw = str(cfg.get("cmd_greeting_morning", "早安,早上好,起床") or "").strip()
        names = _parse_names(raw)
        self.morning_names = names if names else ["早安"]
        raw = str(cfg.get("cmd_greeting_night", "晚安,睡觉,睡了") or "").strip()
        names = _parse_names(raw)
        self.night_names = names if names else ["晚安"]

        # ★★ 市场版 1.1：三条独立排行指令（后台可自定义）
        for _attr, _key, _dft in (
                ("rank_days_names", "greeting_rank_days_names",
                 "打卡天数排行,天数排行"),
                ("rank_awake_names", "greeting_rank_awake_names",
                 "清醒时长排行,清醒排行"),
                ("rank_sleep_names", "greeting_rank_sleep_names",
                 "睡眠时长排行,睡眠排行")):
            _raw = str(cfg.get(_key, "") or "").strip()
            _ns = _parse_names(_raw) if _raw else []
            setattr(self, _attr, _ns or _dft.split(","))

        fmt = str(cfg.get("greeting_time_format", "hms") or "hms").strip().lower()
        if fmt not in ("hms", "seconds"):
            fmt = "hms"
        self.time_format = fmt

        try:
            ds_h = int(str(cfg.get("greeting_day_start_hour", "6")).strip())
        except Exception:
            ds_h = 6
        if ds_h < 6:
            ds_h = 6
        self.day_start_hour = ds_h

        try:
            mc_h = int(str(cfg.get("greeting_morning_cutoff_hour", "12")).strip())
        except Exception:
            mc_h = 12
        self.morning_cutoff_hour = max(0, min(23, mc_h))

        try:
            cut_h = int(str(cfg.get("greeting_night_cutoff_hour", "23")).strip())
        except Exception:
            cut_h = 23
        try:
            cut_m = int(str(cfg.get("greeting_night_cutoff_minute", "59")).strip())
        except Exception:
            cut_m = 59
        self.night_cutoff_hour = max(0, min(23, cut_h))
        self.night_cutoff_minute = max(0, min(59, cut_m))

        try:
            min_sec = int(str(cfg.get("greeting_min_awake_seconds", "0")).strip() or "0")
        except Exception:
            min_sec = 0
        if min_sec < 0:
            min_sec = 0
        self.min_awake_seconds = min_sec

        try:
            max_rep = int(str(cfg.get("greeting_max_repeat_remind", "0")).strip() or "0")
        except Exception:
            max_rep = 0
        if max_rep < 0:
            max_rep = 0
        self.max_repeat_remind = max_rep

        # ★ 打卡系统群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效
        #   （早安与晚安共用一个开关，不分开控制）
        self.allowed_groups = _parse_gid_list(cfg.get("greeting_groups", ""))
        # 兼容旧的两个分开开关：新键为空时回退用它们
        if not self.allowed_groups:
            legacy = (_parse_gid_list(cfg.get("greeting_morning_groups", ""))
                      + _parse_gid_list(cfg.get("greeting_night_groups", "")))
            self.allowed_groups = sorted(set(legacy))

        # ★ 早安 / 晚安文案（1.7.2 起数据存在独立文件，由 main 注入 cfg）
        morning = self._parse_messages(cfg.get("greeting_morning_messages", []))
        if morning:
            self.morning_messages = morning
        night = self._parse_messages(cfg.get("greeting_night_messages", []))
        if night:
            self.night_messages = night

    def is_group_allowed(self, group_id, kind: str = "") -> bool:
        """
        判断某群是否允许打卡（早安与晚安共用一个开关）。
        黑名单语义：留空 = 所有群都生效；填了群号则这些群不生效。
        kind 参数保留兼容，不再区分早晚。
        """
        if not group_id:
            return True
        if not self.allowed_groups:
            return True
        return str(group_id) not in self.allowed_groups

    def _parse_messages(self, raw):
        out = []
        if not isinstance(raw, list):
            return out
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                sh = int(str(item.get("start_hour", "0")).strip() or "0")
                eh = int(str(item.get("end_hour", "24")).strip() or "24")
            except Exception:
                continue
            msg = str(item.get("message", "")).strip()
            if not msg:
                continue
            sh = max(0, min(23, sh))
            eh = max(0, min(24, eh))
            if eh <= sh:
                eh = sh + 1
            out.append({"start": sh, "end": eh, "message": msg})
        return out

    def _load_records(self):
        if not os.path.exists(self.data_path):
            self.records = {}
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                raw = json.load(f) or {}
        except Exception:
            self.records = {}
            return
        if not isinstance(raw, dict):
            self.records = {}
            return

        migrated = {}
        is_old_format = False
        for key, val in raw.items():
            if _looks_like_record(val):
                migrated[key] = dict(val)
            elif isinstance(val, dict):
                is_old_format = True
                for user_id, rec in val.items():
                    if not isinstance(rec, dict):
                        continue
                    exist = migrated.get(user_id)
                    if exist is None:
                        migrated[user_id] = dict(rec)
                    else:
                        if rec.get("morning_ts", 0) > exist.get("morning_ts", 0):
                            exist["morning_ts"] = rec.get("morning_ts", 0)
                            exist["morning_logic_day"] = rec.get("morning_logic_day", "")
                        if rec.get("night_ts", 0) > exist.get("night_ts", 0):
                            exist["night_ts"] = rec.get("night_ts", 0)
                            exist["night_logic_day"] = rec.get("night_logic_day", "")
        self.records = migrated
        changed = is_old_format
        if is_old_format:
            logger.info(
                f"[greeting] 检测到旧的按群存储格式，已迁移为全局统一记录，"
                f"共 {len(self.records)} 个用户"
            )
        # 再把旧记录升级到带 day_stats 的新格式
        if self._migrate_day_stats():
            changed = True
        if changed:
            self._save_records()

    def _migrate_day_stats(self) -> bool:
        """
        把旧打卡记录迁移到新格式（v1.6.9 新增）。

        旧记录只有最后一次的 morning_ts / night_ts，没有按天存档，
        因此历史每一天的时长无法还原。迁移时只补齐能从旧数据推出来的部分：
          · 用旧记录的作息样本补出"上一个完整逻辑日"，作为时长累计的起点
          · 把 morning_logic_day / night_logic_day 分别补进 morning_days / night_days，
            让「早晚都打卡才算一天」的判定对旧数据也能生效
          · 已有数据的字段原样保留，不会被覆盖
        完整打卡天数不依赖 day_stats，旧数据会自动回退用 min(早安, 晚安) 计算。

        返回是否有记录被改动（需要落盘）。
        """
        changed = False
        for uid, rec in self.records.items():
            if not isinstance(rec, dict):
                continue

            stats = rec.get("day_stats")
            if not isinstance(stats, dict):
                stats = {}

            # 1) 补历史作息样本（仅当该日还没有任何数据时）
            morning_ts = int(rec.get("morning_ts", 0) or 0)
            night_ts = int(rec.get("night_ts", 0) or 0)
            night_day = str(rec.get("night_logic_day", "") or "")
            morning_day = str(rec.get("morning_logic_day", "") or "")

            if morning_ts > 0 and night_ts > morning_ts and night_day:
                awake = night_ts - morning_ts
                if 0 < awake < 24 * 3600:
                    day = stats.get(night_day)
                    if not isinstance(day, dict):
                        day = {}
                    if not day.get("awake"):
                        day["awake"] = int(awake)
                        stats[night_day] = day
                        changed = True

            # 2) 迁移旧格式里的清醒/睡眠时长字段（兼容可能存在的历史字段名）
            for legacy_key, kind in (("last_awake_seconds", "awake"),
                                     ("last_sleep_seconds", "sleep")):
                sec = int(rec.get(legacy_key, 0) or 0)
                if sec <= 0:
                    continue
                day_key = night_day or morning_day
                if not day_key:
                    continue
                day = stats.get(day_key)
                if not isinstance(day, dict):
                    day = {}
                if not day.get(kind):
                    day[kind] = sec
                    stats[day_key] = day
                    changed = True

            if stats and rec.get("day_stats") != stats:
                rec["day_stats"] = stats
                changed = True

            # 3) 补 morning_days / night_days，让完整天数与连续天数判定对旧数据生效
            if not isinstance(rec.get("morning_days"), list) and morning_day:
                rec["morning_days"] = [morning_day]
                changed = True
            if not isinstance(rec.get("night_days"), list) and night_day:
                rec["night_days"] = [night_day]
                changed = True

        if changed:
            logger.info("[greeting] 旧打卡记录已迁移到新格式（day_stats / 早晚打卡日）")
        return changed

    def _save_records(self):
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.records, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[greeting] 保存记录失败")

    def match_morning(self, text: str) -> bool:
        if not self.enable:
            return False
        for name in self.morning_names:
            if not name:
                continue
            if text == name or text == f"/{name}":
                return True
        return False

    def match_night(self, text: str) -> bool:
        if not self.enable:
            return False
        for name in self.night_names:
            if not name:
                continue
            if text == name or text == f"/{name}":
                return True
        return False

    def _get_user_record(self, user_id: str) -> dict:
        return self.records.setdefault(user_id, {})

    def _pick_message(self, messages: list, hour: int) -> str:
        for item in messages:
            if item["start"] <= hour < item["end"]:
                return item["message"]
        return ""

    def _should_silent(self, repeat: int) -> bool:
        if self.max_repeat_remind <= 0:
            return False
        return repeat > self.max_repeat_remind

    # ============================================================
    # 早晚打卡日分别记录（用于判定「早晚都打卡」才算一天）
    # morning_days / night_days 均为逻辑日字符串列表
    # ============================================================
    def _mark_side_day(self, rec: dict, key: str, logic_day: str):
        """把逻辑日加入 morning_days 或 night_days"""
        if not logic_day:
            return
        days = rec.get(key)
        if not isinstance(days, list):
            days = []
        if logic_day not in days:
            days.append(logic_day)
        if len(days) > 400:
            days = sorted(days)[-400:]
        rec[key] = days

    @staticmethod
    def _complete_days(rec: dict):
        """
        返回「早晚都打过卡」的逻辑日集合（已排序）。
        优先用 morning_days ∩ night_days（新数据，最准确）；
        旧数据没有这两个字段时，回退用 day_stats 里同时有 awake 和 sleep 的天。
        """
        m = rec.get("morning_days")
        n = rec.get("night_days")
        if isinstance(m, list) and isinstance(n, list) and (m or n):
            return set(str(x) for x in m) & set(str(x) for x in n)

        stats = rec.get("day_stats")
        if isinstance(stats, dict) and stats:
            got = set()
            for day, item in stats.items():
                if isinstance(item, dict) and item.get("awake", 0) > 0 and item.get("sleep", 0) > 0:
                    got.add(str(day))
            if got:
                return got
        return set()

    @staticmethod
    def _streak_of(days) -> int:
        """从最近的完整日往回数，返回连续天数（要求每天早晚都不缺）。"""
        day_set = set(str(d) for d in (days or []))
        if not day_set:
            return 0
        try:
            cur = datetime.datetime.strptime(max(day_set), "%Y-%m-%d").date()
        except Exception:
            return 0
        streak = 0
        while cur.strftime("%Y-%m-%d") in day_set:
            streak += 1
            cur = cur - datetime.timedelta(days=1)
        return streak

    # ============================================================
    # ★ 新增：记录历史打卡逻辑日
    # ============================================================
    def _mark_greeting_day(self, rec: dict, logic_day: str):
        """把逻辑日加入已打卡集合，并清理过老数据，防止无限膨胀"""
        if not logic_day:
            return
        days = rec.get("greeting_days")
        if not isinstance(days, list):
            days = []
        if logic_day not in days:
            days.append(logic_day)
        if len(days) > 400:
            days = sorted(days)[-400:]
        rec["greeting_days"] = days

    # ============================================================
    # 每日时长记录（供打卡排行榜统计）
    # day_stats 结构：{逻辑日: {"awake": 清醒秒数, "sleep": 睡眠秒数}}
    # ============================================================
    def _mark_day_duration(self, rec: dict, logic_day: str, kind: str, seconds: int):
        """
        记录某个逻辑日的清醒/睡眠时长。
        kind: "awake"（早安→晚安，清醒时长） / "sleep"（晚安→次日早安，睡眠时长）
        """
        if not logic_day or not seconds or seconds <= 0:
            return
        stats = rec.get("day_stats")
        if not isinstance(stats, dict):
            stats = {}
        day = stats.get(logic_day)
        if not isinstance(day, dict):
            day = {}
        day[kind] = int(seconds)
        stats[logic_day] = day
        # 只保留最近 400 天，防止无限膨胀
        if len(stats) > 400:
            keep = sorted(stats.keys())[-400:]
            stats = {k: stats[k] for k in keep}
        rec["day_stats"] = stats

    @staticmethod
    def _days_with_both(rec: dict) -> int:
        """
        统计「早晚都打过卡」的天数。
        新数据看 day_stats 里同时有 awake/sleep 的天；
        旧数据回退用 total_morning / total_night 的较小值。
        """
        stats = rec.get("day_stats")
        if isinstance(stats, dict) and stats:
            n = 0
            for _day, item in stats.items():
                if isinstance(item, dict) and item.get("awake", 0) > 0 and item.get("sleep", 0) > 0:
                    n += 1
            if n > 0:
                return n
        tm = int(rec.get("total_morning", 0))
        tn = int(rec.get("total_night", 0))
        return min(tm, tn)


    # ============================================================
    # ★ 新增：对外提供打卡统计接口（供签到统计调用）
    # ============================================================
    def get_greeting_stats(self, user_id: str) -> dict:
        """
        返回该用户的打卡统计：
          {
            "total_morning": int,   # 早安累计次数
            "total_night": int,     # 晚安累计次数
            "total": int,           # 完整打卡天数（早晚都打卡才算一天）
            "streak": int,          # 连续完整打卡天数（每天早晚都不缺）
          }
        """
        empty = {"total_morning": 0, "total_night": 0, "total": 0, "streak": 0}
        if not user_id:
            return empty
        rec = self.records.get(str(user_id))
        if not isinstance(rec, dict):
            return empty

        total_morning = int(rec.get("total_morning", 0))
        total_night = int(rec.get("total_night", 0))

        # 完整打卡天数：早晚都打卡才算一天
        complete = self._complete_days(rec)
        if complete:
            total = len(complete)
        elif isinstance(rec.get("morning_days"), list) or isinstance(rec.get("night_days"), list):
            # 已有新字段但交集为空 -> 确实没有完整打过卡
            total = 0
        else:
            # 旧数据既无 morning_days/night_days 也无 day_stats：用 min(早安, 晚安) 估算
            total = min(total_morning, total_night)

        # 连续天数：从最近一个完整日往回数，不允许中断
        streak = self._streak_of(complete)

        return {
            "total_morning": total_morning,
            "total_night": total_night,
            "total": total,
            "streak": streak,
        }

    def handle_morning(self, event) -> str:
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        now = time.time()
        now_dt = datetime.datetime.now()
        logic_today = get_logic_day(now, self.day_start_hour)
        rec = self._get_user_record(user_id)
        rec["name"] = user_name
        current_hour = now_dt.hour
        current_minute = now_dt.minute
        msg = self._pick_message(self.morning_messages, current_hour)

        in_window = False
        if self.day_start_hour <= current_hour < self.morning_cutoff_hour:
            in_window = True
        elif 0 <= current_hour < self.day_start_hour:
            in_window = True
        if not in_window:
            return (
                f"⚠️ 现在不是早安打卡的有效时间哦~\n"
                f"⏰ 早安有效时间：每日 {self.day_start_hour:02d}:00 - {self.morning_cutoff_hour:02d}:00\n"
                f"💡 超过 {self.morning_cutoff_hour:02d}:00 打早安不算起床"
            )

        if rec.get("morning_logic_day") == logic_today:
            repeat = int(rec.get("morning_repeat", 0)) + 1
            rec["morning_repeat"] = repeat
            self._save_records()
            if self._should_silent(repeat):
                logger.info(
                    f"[greeting] 用户 {user_id} 逻辑日 {logic_today} 早安重复第 {repeat} 次，静默"
                )
                return ""
            last_ts = rec.get("morning_ts", 0)
            lines = [
                f"{title_bar('早安打卡')}",
                f"👤 {user_name}",
                "✅ 今天已经打过卡了",
                f"🕐 上次起床：{format_time_point(last_ts)}",
            ]
            if msg:
                lines.append("")
                lines.append(msg)
            return "\n".join(lines)

        last_night_ts = rec.get("night_ts", 0)
        last_night_logic_day = rec.get("night_logic_day", "")
        sleep_duration = ""
        sleep_seconds = 0
        if last_night_ts and last_night_logic_day:
            diff = int(now - last_night_ts)
            if 0 < diff < 24 * 3600:
                sleep_duration = format_duration(diff, self.time_format)
                sleep_seconds = diff

        rec["morning_ts"] = now
        rec["morning_logic_day"] = logic_today
        rec["morning_repeat"] = 0
        rec["total_morning"] = int(rec.get("total_morning", 0)) + 1
        # ★ 记下"早安打过"的日期（判定完整天用）
        self._mark_side_day(rec, "morning_days", logic_today)
        # ★ 睡眠时长记到「上一个逻辑日」名下（那晚的睡眠）
        if sleep_seconds:
            self._mark_day_duration(rec, last_night_logic_day, "sleep", sleep_seconds)
        # ★ 记录已打卡逻辑日
        self._mark_greeting_day(rec, logic_today)
        self._save_records()

        lines = [
            f"{title_bar('早安打卡')}",
            f"👤 {user_name}",
            f"🕐 起床时间：{format_time_point(now)}",
        ]
        if sleep_duration:
            lines.append(f"💤 睡眠时长：{sleep_duration}")
        if msg:
            lines.append("")
            lines.append(msg)
        return "\n".join(lines)

    def handle_night(self, event) -> str:
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        now = time.time()
        now_dt = datetime.datetime.now()
        logic_today = get_logic_day(now, self.day_start_hour)
        rec = self._get_user_record(user_id)
        rec["name"] = user_name
        current_hour = now_dt.hour
        current_minute = now_dt.minute
        msg = self._pick_message(self.night_messages, current_hour)

        cut_ok = False
        if current_hour < self.night_cutoff_hour:
            cut_ok = True
        elif current_hour == self.night_cutoff_hour and current_minute <= self.night_cutoff_minute:
            cut_ok = True
        if not cut_ok:
            return f"⚠️ 已过晚安打卡截止时间 {self.night_cutoff_hour:02d}:{self.night_cutoff_minute:02d}，请明天再打晚安。"

        if rec.get("night_logic_day") == logic_today:
            repeat = int(rec.get("night_repeat", 0)) + 1
            rec["night_repeat"] = repeat
            self._save_records()
            if self._should_silent(repeat):
                logger.info(
                    f"[greeting] 用户 {user_id} 逻辑日 {logic_today} 晚安重复第 {repeat} 次，静默"
                )
                return ""
            last_ts = rec.get("night_ts", 0)
            lines = [
                f"{title_bar('晚安打卡')}",
                f"👤 {user_name}",
                "✅ 今天已经打过卡了",
                f"🕐 上次睡觉：{format_time_point(last_ts)}",
            ]
            if msg:
                lines.append("")
                lines.append(msg)
            return "\n".join(lines)

        morning_ld = rec.get("morning_logic_day", "")
        if morning_ld != logic_today:
            return (
                "⚠️ 请先起床！\n"
                f"💡 先发「早安」打卡起床，才能打晚安哦~\n"
                f"(每日 {self.day_start_hour}:00 重置一天打卡周期)"
            )

        if self.min_awake_seconds > 0:
            morning_ts = rec.get("morning_ts", 0)
            if morning_ts:
                elapsed = int(now - morning_ts)
                if elapsed < self.min_awake_seconds:
                    remaining = self.min_awake_seconds - elapsed
                    return (
                        "⚠️ 清醒时间不足哦~\n"
                        f"☀️ 当前已清醒：{format_duration(elapsed, self.time_format)}\n"
                        f"⏰ 还需等待：{format_duration(remaining, self.time_format)}\n"
                        f"（后台要求最少清醒 {format_duration(self.min_awake_seconds, self.time_format)}）"
                    )

        last_morning_ts = rec.get("morning_ts", 0)
        awake_duration = ""
        awake_seconds = 0
        if last_morning_ts:
            diff = int(now - last_morning_ts)
            if 0 < diff < 24 * 3600:
                awake_duration = format_duration(diff, self.time_format)
                awake_seconds = diff

        rec["night_ts"] = now
        rec["night_logic_day"] = logic_today
        rec["night_repeat"] = 0
        rec["total_night"] = int(rec.get("total_night", 0)) + 1
        # ★ 记下"晚安打过"的日期（判定完整天用）
        self._mark_side_day(rec, "night_days", logic_today)
        # ★ 清醒时长记到当前逻辑日名下（今天从早安到晚安）
        if awake_seconds:
            self._mark_day_duration(rec, logic_today, "awake", awake_seconds)
        # ★ 记录已打卡逻辑日
        self._mark_greeting_day(rec, logic_today)
        self._save_records()

        lines = [
            f"{title_bar('晚安打卡')}",
            f"👤 {user_name}",
            f"🕐 睡觉时间：{format_time_point(now)}",
        ]
        if awake_duration:
            lines.append(f"☀️ 清醒时长：{awake_duration}")
        if msg:
            lines.append("")
            lines.append(msg)
        return "\n".join(lines)

    # ============================================================
    # 个人打卡统计
    # ============================================================
    def build_stats_text(self, user_id: str, user_name: str = "") -> str:
        """
        构建个人打卡统计文本。
        数据来自打卡记录（按用户 ID 跨群共享），与原签到统计里的打卡部分一致。
        """
        uid = str(user_id or "").strip()
        if not uid:
            return "⚠️ 未指定要查询的 QQ"

        stats = self.get_greeting_stats(uid)
        rec = self.records.get(uid) if isinstance(self.records, dict) else None
        rec = rec if isinstance(rec, dict) else {}

        name = str(user_name or "").strip()
        if not name:
            name = self.nickname_cache.get(uid, "") if self.nickname_cache else ""
        name = name or f"QQ{uid}"

        # ---- 清醒 / 睡眠时长统计（累计 + 当天）----
        day_stats = rec.get("day_stats")
        if not isinstance(day_stats, dict):
            day_stats = {}
        awake_total = 0
        sleep_total = 0
        for _d, item in day_stats.items():
            if not isinstance(item, dict):
                continue
            awake_total += int(item.get("awake", 0) or 0)
            sleep_total += int(item.get("sleep", 0) or 0)

        # 当天按「逻辑日」口径（与打卡一致，day_start_hour 之前算前一天）
        today_key = get_logic_day(time.time(), self.day_start_hour)
        today_item = day_stats.get(today_key)
        today_item = today_item if isinstance(today_item, dict) else {}
        awake_today = int(today_item.get("awake", 0) or 0)
        sleep_today = int(today_item.get("sleep", 0) or 0)

        def _fmt(sec: int) -> str:
            return format_duration(int(sec), self.time_format) if sec > 0 else "—"

        lines = [
            f"{title_bar('打卡统计')}",
            f"👤 {name}",
            f"💳 QQ：{uid}",
            "",
            f"☀️ 早安累计：{int(stats.get('total_morning', 0))} 次",
            f"🌙 晚安累计：{int(stats.get('total_night', 0))} 次",
            f"📅 完整打卡：{int(stats.get('total', 0))} 天",
            f"🔥 连续打卡：{int(stats.get('streak', 0))} 天",
            "",
            "【累计时长】",
            f"☀️ 清醒合计：{_fmt(awake_total)}",
            f"🌙 睡眠合计：{_fmt(sleep_total)}",
            "",
            f"【今日时长】（{today_key}）",
            f"☀️ 清醒时长：{_fmt(awake_today)}",
            f"🌙 睡眠时长：{_fmt(sleep_today)}",
        ]

        last_morning = rec.get("morning_logic_day", "") or ""
        last_night = rec.get("night_logic_day", "") or ""
        if last_morning or last_night:
            lines.append("")
            if last_morning:
                lines.append(f"🌅 最近早安：{last_morning}")
            if last_night:
                lines.append(f"🌙 最近晚安：{last_night}")

        lines.append("")
        lines.append("💡 打卡记录跨群共享，统计的是你在所有群的总打卡数据")
        lines.append("━" * 12)
        return "\n".join(lines)
    # ============================================================
    # 打卡查询（★ 三种榜单，各自一条指令，格式对齐「签到排行」）
    # ============================================================
    def _rank_items(self) -> list:
        """
        榜单公共数据源。

        返回 [{uid, days, awake_total, sleep_total}, ...]
        """
        out = []
        for user_id, rec in (self.records or {}).items():
            if not isinstance(rec, dict):
                continue
            days = self._days_with_both(rec)
            awake_total, sleep_total = 0, 0
            stats = rec.get("day_stats")
            if isinstance(stats, dict):
                for _d, item in stats.items():
                    if not isinstance(item, dict):
                        continue
                    awake_total += int(item.get("awake", 0) or 0)
                    sleep_total += int(item.get("sleep", 0) or 0)
            out.append({
                "uid": user_id,
                "days": days,
                "awake_total": awake_total,
                "sleep_total": sleep_total,
            })
        return out

    def _rank_nick(self, uid) -> str:
        """榜单里的名字（和签到排行一样过截断）"""
        try:
            if uid in self.nickname_cache:
                return _nick_narrow(self.nickname_cache[uid])
        except Exception:
            pass
        rec = (self.records or {}).get(uid, {})
        name = str(rec.get("name", "")).strip()
        if name and not name.startswith("QQ"):
            return _nick_narrow(name)
        uid_str = str(uid)
        if len(uid_str) > 5:
            return f"{uid_str[:3]}****{uid_str[-2:]}"
        return uid_str

    def _build_board(self, title: str, key: str, unit: str = "天",
                     is_dur: bool = False, note: str = "") -> str:
        """
        ★★ 1.6：出一个榜单（前十），格式**和「签到排行」完全一致**：

            打卡天数排行
            ━━━━━━━━━━━━━━━━━━━━

            🥇  小明 — 15 天
            🥈  小红 — 14 天
            ...
            10. 小刚 — 7 天

            💡 只统计所有群共享的打卡记录
        """
        lines = [f"{title_bar(title)}", ""]
        items = self._rank_items()
        if not items:
            lines.append("暂无打卡记录")
            return "\n".join(lines)
        rows = [x for x in items if int(x.get(key, 0) or 0) > 0]
        if not rows:
            lines.append("暂无数据")
            return "\n".join(lines)
        rows.sort(key=lambda x: (-int(x.get(key, 0) or 0), str(x["uid"])))
        for i, it in enumerate(rows[:10], start=1):
            _v = int(it.get(key, 0) or 0)
            _show = (format_duration(_v, self.time_format)
                     if is_dur else f"{_v} {unit}")
            lines.append(f"{_rank_tag(i)}{self._rank_nick(it['uid'])}"
                         f" — {_show}")
        lines += ["", note or "💡 只统计所有群共享的打卡记录"]
        return "\n".join(lines)

    def build_rank_by_days(self) -> str:
        """【排行 1】完整打卡天数排行（前十）"""
        return self._build_board(
            "打卡天数排行", "days", unit="天",
            note="💡 早晚都打卡才算一天；数据来自所有群共享")

    def build_rank_by_sleep(self) -> str:
        """【排行 2】累计睡眠时长排行（前十）"""
        return self._build_board(
            "睡眠时长排行", "sleep_total", is_dur=True,
            note="💡 晚安 → 次日早安的时长；数据来自所有群共享")

    def build_rank_by_awake(self) -> str:
        """【排行 3】累计清醒时长排行（前十）"""
        return self._build_board(
            "清醒时长排行", "awake_total", is_dur=True,
            note="💡 早安 → 当晚晚安的时长；数据来自所有群共享")

    def match_rank_kind(self, text: str, kind: str) -> bool:
        """
        ★★ 1.6：三条独立排行指令的匹配。

        kind: "days"（打卡天数）/ "sleep"（睡眠时长）/ "awake"（清醒时长）
        """
        names = {
            "days": getattr(self, "rank_days_names", None),
            "sleep": getattr(self, "rank_sleep_names", None),
            "awake": getattr(self, "rank_awake_names", None),
        }.get(kind) or []
        _t = str(text or "").strip()
        for name in names:
            name = str(name or "").strip()
            if name and _t in (name, "/" + name):
                return True
        return False

    def build_rank_text(self) -> str:
        """兼容旧调用：把三种榜单拼在一起（新流程已拆成三条指令）"""
        return "\n\n".join([
            self.build_rank_by_days(),
            self.build_rank_by_sleep(),
            self.build_rank_by_awake(),
        ])
