"""
猜数游戏（1.7.7 重写版）

玩法（群内多人抢猜）：
  · `开始猜数`        —— 开一局，机器人在 [min, max] 里想一个整数
  · `猜数 数字`       —— 参与猜一次（**所有人都能猜**）
  · 每人默认最多猜 3 次
  · **60 秒没人再猜就自动关闭**这一局
  · 谁先猜中就赢：奖励**随机金额**
  · 猜错的人**扣积分**（默认 1000）

设计要点：
  · 一局是**群级**的（不是单人），存 `groups[gid] = {round: {...}}`
  · 每次有人猜都刷新 `last_ts`，所以是「**60 秒无新猜测**才关闭」
  · 猜中用 `finished` 标记，避免同一局被开奖两次
  · 猜错立刻扣分；猜对不再扣、直接发奖
"""
import json
import os
import random
import time
from datetime import datetime

from astrbot.api import logger
def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


class GuessModule:
    """猜数数据层（群共享局 + 每人次数 + 历史战绩）"""

    def __init__(self, data_path: str):
        self.data_path = data_path
        self.groups = {}
        # 配置（由 main.py 注入）
        self.enable = True
        self.score_name = "积分"
        # ★ 参与指令名（默认「猜数」，可后台改）
        self.trigger_names = ["猜数"]
        # ★ 开新局指令名由 main.py 那边管（cmd_guess_start）
        self.guess_min = 1              # 题目下限
        self.guess_max = 100            # 题目上限
        self.max_tries = 3              # 每人每局最多猜几次
        self.timeout_sec = 60           # 多少秒没人猜就关闭（0 = 不自动关）
        self.reward_min = 100           # 猜对奖励下限
        self.reward_max = 500           # 猜对奖励上限
        self.penalty = 1000             # 猜错扣多少
        self.allow_negative = True      # 允许扣成负分
        # 兼容旧字段（旧版单机猜数用，保留避免 AttributeError）
        self.guess_cost = 0
        self.guess_reward = 100
        self.daily_limit = 0
        self._load()

    # ------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------
    def _load(self):
        try:
            if not os.path.isfile(self.data_path):
                return
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                d = json.load(f)
            g = d.get("groups")
            if isinstance(g, dict):
                self.groups = g
        except Exception:
            logger.exception("[guess] 读取猜数数据失败")

    def _save(self):
        try:
            d = os.path.dirname(self.data_path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 2, "groups": self.groups}, f,
                          ensure_ascii=False, indent=1)
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[guess] 保存猜数数据失败")

    # ------------------------------------------------------------
    # 访问
    # ------------------------------------------------------------
    @staticmethod
    def _gid(group_id) -> str:
        return str(group_id or "").strip()

    def _bucket(self, group_id) -> dict:
        gid = self._gid(group_id)
        b = self.groups.get(gid)
        if not isinstance(b, dict):
            b = {}
            self.groups[gid] = b
        return b

    # ------------------------------------------------------------
    # 当前局
    # ------------------------------------------------------------
    def current_round(self, group_id) -> dict:
        """取当前这一局（没有返回空 dict）"""
        r = self._bucket(group_id).get("round")
        return r if isinstance(r, dict) else {}

    def clear_round(self, group_id) -> None:
        self._bucket(group_id).pop("round", None)

    def start_round(self, group_id) -> dict:
        """
        开新一局，返回这一局的 dict。

        ★ 会覆盖掉上一局（未结束的也算作废）。
        """
        lo = int(getattr(self, "guess_min", 1) or 1)
        hi = int(getattr(self, "guess_max", 100) or 100)
        if hi < lo:
            lo, hi = hi, lo
        r = {
            "answer": random.randint(lo, hi),
            "lo": lo,
            "hi": hi,
            "start_ts": int(time.time()),
            "last_ts": int(time.time()),   # 最后一次猜测时间（用于超时）
            "tries": {},                   # {uid: 猜了几次}
            "guessed": [],                 # [[uid, num], ...] 便于回显
            "finished": False,             # 是否已结束（猜中/超时）
            "winner": "",
            "reward": 0,
            "closed_by": "",               # "win" / "timeout" / "restart"
        }
        self._bucket(group_id)["round"] = r
        self._bucket(group_id)["last_round"] = r
        self._save()
        return r

    def tries_of(self, round_: dict, uid) -> int:
        try:
            return int((round_.get("tries") or {}).get(str(uid), 0) or 0)
        except Exception:
            return 0

    def left_of(self, round_: dict, uid) -> int:
        """该用户这局还能猜几次"""
        _max = max(0, int(getattr(self, "max_tries", 3) or 0))
        return max(0, _max - self.tries_of(round_, uid))

    def record_try(self, group_id, uid) -> int:
        """记一次猜测（返回该用户累计次数）；同时刷新 last_ts"""
        r = self.current_round(group_id)
        if not r:
            return 0
        uid = str(uid)
        t = r.setdefault("tries", {})
        t[uid] = int(t.get(uid, 0) or 0) + 1
        r["last_ts"] = int(time.time())
        return t[uid]

    def note_guess(self, group_id, uid, num: int) -> None:
        """把「谁猜了什么」记下来（用于结果回显）"""
        r = self.current_round(group_id)
        if not r:
            return
        g = r.setdefault("guessed", [])
        g.append([str(uid), int(num)])
        if len(g) > 60:            # 防止无限增长
            del g[:-60]
        r["last_ts"] = int(time.time())

    def finish_round(self, group_id, winner_uid: str, reward: int,
                     closed_by: str = "win") -> None:
        r = self.current_round(group_id)
        if not r:
            return
        r["finished"] = True
        r["winner"] = str(winner_uid or "")
        r["reward"] = int(reward or 0)
        r["closed_by"] = closed_by
        # 战绩累计
        try:
            st = self._bucket(group_id).setdefault("stats", {})
            w = st.setdefault(str(winner_uid), {"win": 0, "lose": 0})
            w["win"] = int(w.get("win", 0) or 0) + 1
        except Exception:
            logger.debug("[guess] 累计战绩失败", exc_info=True)
        self._save()

    def note_lose(self, group_id, uid) -> None:
        """记一次猜错（用于战绩）"""
        try:
            st = self._bucket(group_id).setdefault("stats", {})
            w = st.setdefault(str(uid), {"win": 0, "lose": 0})
            w["lose"] = int(w.get("lose", 0) or 0) + 1
        except Exception:
            logger.debug("[guess] 累计败绩失败", exc_info=True)

    # ------------------------------------------------------------
    # 超时
    # ------------------------------------------------------------
    def idle_sec(self, group_id) -> int:
        """当前局已经多少秒没人猜（没有局返回 0）"""
        r = self.current_round(group_id)
        if not r:
            return 0
        try:
            return max(0, int(time.time()) - int(r.get("last_ts", 0) or 0))
        except Exception:
            return 0

    def _timeout_of(self) -> int:
        """超时秒数；**0 = 不自动关闭**"""
        try:
            return max(0, int(getattr(self, "timeout_sec", 60) or 0))
        except Exception:
            return 0

    def idle_left(self, group_id) -> int:
        """还差多少秒关闭（已超时返回 0；未启用返回 -1）"""
        t = self._timeout_of()
        if t <= 0:
            return -1
        return max(0, t - self.idle_sec(group_id))

    def is_idle_timeout(self, group_id) -> bool:
        """是否已「没人猜」超过 timeout_sec（且这局还没结束）"""
        r = self.current_round(group_id)
        if not r or r.get("finished"):
            return False
        t = self._timeout_of()
        if t <= 0:
            return False
        return self.idle_sec(group_id) >= t

    def timeout_enabled(self) -> bool:
        return self._timeout_of() > 0

    def timeout_sec_text(self) -> str:
        t = self._timeout_of()
        if t <= 0:
            return "不自动关闭"
        if t >= 60 and t % 60 == 0:
            return f"{t // 60} 分钟"
        return f"{t} 秒"

    # ------------------------------------------------------------
    # 随机奖励
    # ------------------------------------------------------------
    def roll_reward(self) -> int:
        """摇一个奖励金额（后台配区间）"""
        try:
            lo = max(0, int(getattr(self, "reward_min", 100) or 0))
            hi = max(0, int(getattr(self, "reward_max", 500) or 0))
        except Exception:
            lo, hi = 100, 500
        if hi < lo:
            lo, hi = hi, lo
        return random.randint(lo, hi) if hi > lo else lo

    # ------------------------------------------------------------
    # 战绩
    # ------------------------------------------------------------
    def stats_text(self, group_id, uid) -> str:
        st = (self._bucket(group_id).get("stats") or {})
        w = st.get(str(uid)) or {}
        win = int(w.get("win", 0) or 0)
        lose = int(w.get("lose", 0) or 0)
        return f"🏆 猜对 {win} 次　❌ 猜错 {lose} 次"
