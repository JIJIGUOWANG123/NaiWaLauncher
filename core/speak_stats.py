"""
发言统计模块（每个群独立统计）

记录每位群员在**本群**的发言情况，提供 5 类排行榜：

  · 本群发言排行   —— **昨日** 前十
  · 本群活跃排行   —— 连续活跃天数（不可断一天）前十
  · 本群上周排行   —— **前 7 日**发言次数 前十
  · 本群上月排行   —— **前 30 日**发言次数 前十
  · 个人发言统计   —— 自己：累计 / 活跃天数 / 一周内 / 一个月内

数据结构（data/plugin_data/<插件>/..._speak_stats.json）：
{
  "groups": {
    "<群号>": {
      "<用户号>": {
        "days": {"2026-10-01": 12, ...},   # 每天发言次数
        "total": 123,                       # 累计发言
        "streak": 5,                        # 当前连续活跃天数
        "best_streak": 9,                   # 历史最长
        "last": "2026-10-01",               # 最后一次发言日期
        "name": "昵称"
      }
    }
  }
}
"""
import datetime
import json
import os
import re as _re
import threading
from .path_utils import title_bar, title_foot
# ★★ 1.7.7：昵称截断（长名字用省略号，别把榜单行撑宽）
from .path_utils import nick_display as _nick_display
# ★★ 1.7.7：榜单行带「🥇 」前缀和「 — 90 条」后缀，
#   可用宽度比整行少，所以用**窄档**预算。
from .path_utils import nick_display_narrow as _nick_narrow
# ★★ 1.7.7：榜单名次前缀（前三名奖牌 + 两空格列分隔）
from .path_utils import rank_tag as _rank_tag

from astrbot.api import logger
_LOCK = threading.RLock()

# 保留天数（比最长统计窗口 30 天多留一些余量）
KEEP_DAYS = 45


def _parse_names(raw) -> list:
    """解析后台配置的指令名（英文逗号分隔，支持多个）"""
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        out = []
        for it in raw:
            out.extend(_parse_names(it))
        return out
    return [x.strip() for x in _re.split(r"[,，]", str(raw)) if x.strip()]


def _today() -> datetime.date:
    return datetime.datetime.now().date()


def _dstr(d: datetime.date) -> str:
    return d.strftime("%Y-%m-%d")


class SpeakStatsModule:
    """每个群独立的发言统计"""

    DEFAULT_GROUP = "__default__"

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path

        self.enable = True
        # 每个指令都支持后台自定义多个名字
        self.rank_yesterday_names = ["本群发言排行", "发言排行", "群里发言排行"]
        self.rank_active_names = ["本群活跃排行", "活跃排行"]
        self.rank_week_names = ["本群上周排行", "上周排行"]
        self.rank_month_names = ["本群上月排行", "上月排行"]
        self.my_stat_names = ["个人发言统计", "我的发言统计", "发言统计"]

        # 群号黑名单（留空 = 所有群都生效）
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []

        # 后台总开关（由「启用发言统计」注入）
        self.feature_enable = True

        self.groups = {}
        self._load()

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}
        self.enable = bool(cfg.get("speak_stats_enable", True))

        def _names(key, default):
            got = _parse_names(cfg.get(key, ""))
            return got if got else list(default)

        self.rank_yesterday_names = _names(
            "cmd_speak_rank_names", ["本群发言排行", "发言排行"])
        self.rank_active_names = _names(
            "cmd_active_rank_names", ["本群活跃排行", "活跃排行"])
        self.rank_week_names = _names(
            "cmd_week_rank_names", ["本群上周排行", "上周排行"])
        self.rank_month_names = _names(
            "cmd_month_rank_names", ["本群上月排行", "上月排行"])
        self.my_stat_names = _names(
            "cmd_my_speak_names", ["个人发言统计", "我的发言统计", "发言统计"])

        from .group_filter import parse_gid_whitelist
        self.allowed_groups = parse_gid_whitelist(cfg.get("speak_stats_groups", ""))
        self.group_mode = str(cfg.get("speak_stats_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = self._lines(cfg.get("speak_stats_group_whitelist", ""))
        self.group_blacklist = self._lines(cfg.get("speak_stats_group_blacklist", ""))

    @staticmethod
    def _lines(raw) -> list:
        if not raw:
            return []
        if isinstance(raw, (list, tuple)):
            out = []
            for it in raw:
                out.extend(str(it).splitlines())
        else:
            out = str(raw).splitlines()
        return [x.strip() for x in out if x.strip() and not x.strip().startswith("#")]

    def set_enable(self, on: bool):
        self.enable = bool(on)

    def is_group_allowed(self, group_id) -> bool:
        """群号黑名单：留空 = 所有群都生效；填了群号则这些群不生效"""
        from .group_filter import group_allowed, is_group_allowed
        if self.allowed_groups:
            return group_allowed(group_id, self.allowed_groups)
        return is_group_allowed(
            group_id, self.group_mode, self.group_whitelist, self.group_blacklist
        )

    # ============================================================
    # 指令匹配
    # ============================================================
    @staticmethod
    def _hit(text: str, names) -> bool:
        for n in (names or []):
            if n and (text == n or text == f"/{n}"):
                return True
        return False

    def match_rank_yesterday(self, text: str) -> bool:
        return self._hit(text, self.rank_yesterday_names)

    def match_rank_active(self, text: str) -> bool:
        return self._hit(text, self.rank_active_names)

    def match_rank_week(self, text: str) -> bool:
        return self._hit(text, self.rank_week_names)

    def match_rank_month(self, text: str) -> bool:
        return self._hit(text, self.rank_month_names)

    def match_my_stat(self, text: str) -> bool:
        return self._hit(text, self.my_stat_names)

    # ============================================================
    # 数据层
    # ============================================================
    @staticmethod
    def _gid(group_id) -> str:
        g = str(group_id or "").strip()
        return g if g else SpeakStatsModule.DEFAULT_GROUP

    def _load(self):
        if not self.data_path or not os.path.exists(self.data_path):
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f) or {}
            groups = data.get("groups", {})
            self.groups = groups if isinstance(groups, dict) else {}
        except Exception:
            logger.exception("[speak_stats] 读取失败")

    def _save(self):
        if not self.data_path:
            return
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"groups": self.groups}, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[speak_stats] 保存失败")

    def _gmap(self, group_id) -> dict:
        """取某群的用户统计表（引用）"""
        gid = self._gid(group_id)
        bucket = self.groups.get(gid)
        if not isinstance(bucket, dict):
            bucket = {}
            self.groups[gid] = bucket
        return bucket

    def _rec(self, group_id, user_id) -> dict:
        """取某群某人的记录；不存在返回空 dict"""
        u = self._gmap(group_id).get(str(user_id))
        return u if isinstance(u, dict) else {}

    def _rec_new(self, group_id, user_id, name: str = "") -> dict:
        bucket = self._gmap(group_id)
        uid = str(user_id)
        u = bucket.get(uid)
        if not isinstance(u, dict):
            u = {"days": {}, "total": 0, "streak": 0, "best_streak": 0,
                 "last": "", "name": ""}
            bucket[uid] = u
        # 历史最长不低于当前连续，避免外部写入 streak 后数据不一致
        if int(u.get("streak", 0)) > int(u.get("best_streak", 0)):
            u["best_streak"] = int(u["streak"])
        if name:
            u["name"] = str(name)
        return u

    # ============================================================
    # 记录发言（每次消息调用）
    # ============================================================
    def record(self, group_id, user_id, name: str = ""):
        if not self.enable or not user_id:
            return
        with _LOCK:
            today = _dstr(_today())
            u = self._rec_new(group_id, user_id, name)
            days = u.get("days")
            if not isinstance(days, dict):
                days = {}
                u["days"] = days
            days[today] = int(days.get(today, 0)) + 1
            u["total"] = int(u.get("total", 0)) + 1
            self._touch_streak(u, today)
            self._prune(days)
            self._save()

    @staticmethod
    def _touch_streak(u: dict, today: str):
        """更新连续活跃天数（断一天就归 1）"""
        last = str(u.get("last", "") or "")
        if last == today:
            return                      # 今天已经记过，连续天数不变
        streak = int(u.get("streak", 0))
        if last:
            try:
                d_last = datetime.datetime.strptime(last, "%Y-%m-%d").date()
                d_today = datetime.datetime.strptime(today, "%Y-%m-%d").date()
                gap = (d_today - d_last).days
            except Exception:
                gap = 99
            streak = streak + 1 if gap == 1 else 1
        else:
            streak = 1
        u["streak"] = streak
        u["best_streak"] = max(int(u.get("best_streak", 0)), streak)
        u["last"] = today

    @staticmethod
    def _prune(days: dict):
        """只保留最近 KEEP_DAYS 天，避免文件无限增长"""
        if len(days) <= KEEP_DAYS:
            return
        for k in sorted(days.keys())[:-KEEP_DAYS]:
            days.pop(k, None)

    # ============================================================
    # 统计辅助
    # ============================================================
    @staticmethod
    def _sum_range(days: dict, start: datetime.date, end: datetime.date) -> int:
        """[start, end] 闭区间内的发言总数"""
        total = 0
        for k, v in (days or {}).items():
            try:
                d = datetime.datetime.strptime(str(k), "%Y-%m-%d").date()
            except Exception:
                continue
            if start <= d <= end:
                total += int(v or 0)
        return total

    @staticmethod
    def _active_days(days: dict, start: datetime.date, end: datetime.date) -> int:
        """[start, end] 内有发言的天数"""
        n = 0
        for k in (days or {}):
            try:
                d = datetime.datetime.strptime(str(k), "%Y-%m-%d").date()
            except Exception:
                continue
            if start <= d <= end:
                n += 1
        return n

    def _cur_streak(self, u: dict) -> int:
        """当前连续活跃天数（断了就算 0）"""
        last = str(u.get("last", "") or "")
        if not last:
            return 0
        try:
            d_last = datetime.datetime.strptime(last, "%Y-%m-%d").date()
        except Exception:
            return 0
        gap = (_today() - d_last).days
        if gap <= 1:
            return int(u.get("streak", 0))
        return 0

    def _nick(self, group_id, uid, u: dict) -> str:
        """
        ★★ 1.7.7：榜单里的显示名。

        ★ 必须走 `nick_display()` 做**宽度自适应截断**（装得下就不截）——
          以前这里直接返回原始昵称，长名字会把榜单行撑得很宽，
          图片模式下看起来像「换行/串行」（用户反馈）。
        """
        name = str((u or {}).get("name", "")).strip()
        if name and not name.startswith("QQ"):
            return _nick_narrow(name)
        s = str(uid)
        if len(s) > 5:
            return f"{s[:3]}****{s[-2:]}"
        return s

    def _board(self, group_id, keyfunc, title: str, unit: str, topn: int = 10) -> str:
        """通用榜单渲染"""
        lines = [f"{title_bar(f'{title}')}", ""]
        rows = []
        for uid, u in self._gmap(group_id).items():
            if not isinstance(u, dict):
                continue
            val = keyfunc(u)
            if val <= 0:
                continue
            rows.append((uid, u, val))
        rows.sort(key=lambda x: (-x[2], str(x[0])))
        if not rows:
            lines.append("（暂无数据）")
            return "\n".join(lines)
        for i, (uid, u, val) in enumerate(rows[:topn], start=1):
            # ★★ 1.7.7：名次前缀统一走 `rank_tag` ——
            #   前三名奖牌 + **两个空格**做列分隔，渲染端会把
            #   「🥇 名字」和「4.  名字」排成同一列，左边缘自动对齐。
            lines.append(f"{_rank_tag(i)}{self._nick(group_id, uid, u)}"
                         f" — {val} {unit}")
        lines.append("")
        lines.append("💡 只统计本群数据")
        return "\n".join(lines)

    # ============================================================
    # 五个排行榜
    # ============================================================
    def rank_yesterday_text(self, group_id) -> str:
        """
        ★★ 1.7.7：**昨日**发言前十（隔日结算）。

        ★ 标题不再带具体日期（以前是「本群发言排行（2026-10-07）」）——
          用户要求简化成「（昨日）」，因为这条排行**恒为昨天**，
          写出日期反而显得像可以配置。
        """
        y = _today() - datetime.timedelta(days=1)
        title = "本群发言排行（昨日）"
        return self._board(
            group_id,
            lambda u: int((u.get("days") or {}).get(_dstr(y), 0) or 0),
            title, "条",
        )

    def rank_active_text(self, group_id) -> str:
        """连续活跃天数前十"""
        return self._board(group_id, self._cur_streak, "本群活跃排行", "天")

    def rank_week_text(self, group_id) -> str:
        """
        ★★ 1.7.7：**前 7 日**发言前十（不含今天）。

        ★ 标题括号里不再写日期区间（以前是「（2026-10-01 ~ 2026-10-07）」）——
          和「发言排行（昨日）」保持一致的写法：**只写窗口名**。
        """
        end = _today() - datetime.timedelta(days=1)
        start = end - datetime.timedelta(days=6)
        title = "本群上周排行（前 7 日）"
        return self._board(
            group_id,
            lambda u: self._sum_range(u.get("days") or {}, start, end),
            title, "条",
        )

    def rank_month_text(self, group_id) -> str:
        """
        ★★ 1.7.7：**前 30 日**发言前十（不含今天）。

        ★ 同上周排行：标题只写窗口名，不写日期区间。
        """
        end = _today() - datetime.timedelta(days=1)
        start = end - datetime.timedelta(days=29)
        title = "本群上月排行（前 30 日）"
        return self._board(
            group_id,
            lambda u: self._sum_range(u.get("days") or {}, start, end),
            title, "条",
        )

    def my_stat_text(self, group_id, user_id, name: str = "") -> str:
        """个人发言统计"""
        u = self._rec(group_id, user_id)
        days = u.get("days") if isinstance(u, dict) else {}
        days = days if isinstance(days, dict) else {}
        today = _today()
        w_start = today - datetime.timedelta(days=6)      # 近 7 天（含今天）
        m_start = today - datetime.timedelta(days=29)     # 近 30 天（含今天）

        total = int(u.get("total", 0)) if isinstance(u, dict) else 0
        best = int(u.get("best_streak", 0)) if isinstance(u, dict) else 0
        cur = self._cur_streak(u) if isinstance(u, dict) else 0
        week = self._sum_range(days, w_start, today)
        month = self._sum_range(days, m_start, today)
        # ★★ 1.7.7：用户要求去掉「近 7 天 / 近 30 天」后面的
        #   「（活跃 N 天）」括号内容，所以这里不再算活跃天数
        #   （`_active_days` 仍保留，供别处/以后使用）。
        today_cnt = int(days.get(_dstr(today), 0) or 0)

        shown = name or self._nick(group_id, user_id, u)
        return "\n".join([
            f"{title_bar('个人发言统计')}",
            f"👤 {shown}",
            "",
            f"💬 累计发言：{total} 条",
            f"🔥 当前连续活跃：{cur} 天",
            f"🏆 最长连续活跃：{best} 天",
            "",
            f"📅 近 7 天：{week} 条",
            f"📅 近 30 天：{month} 条",
            f"📌 今日发言：{today_cnt} 条",
            "",
            "💡 只统计本群数据；断一天连续活跃会重新计算",
        ])

