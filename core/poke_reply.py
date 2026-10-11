"""
★★ 1.7.8 新功能：**戳一戳回复**

谁戳了机器人（NapCat / OneBot v11 的 `notice_type=notify` + `sub_type=poke`），
就从词库里**随机抽一句**回过去。

要点：
  · **全局限频**：窗口内（默认 60 秒）最多回 N 次（默认 5 次），
    所有群**一起算** —— 用户要求的口径。
  · 超出限制**静默不回复**（不打扰群）。
  · 词库是**独立集合** `poke_reply_list`，和「关键词回复」互不影响。
    每条一个词；也可以一条里写多行（渲染时原样带上，按行随机抽）。
  · 词库为空时回落到内置的几句兜底文案（不至于戳了没反应）。

数据文件：复用 <插件>_data.json 的 collections.poke_reply_list
"""
import random
import threading
import time

from astrbot.api import logger
# 词库为空时的兜底文案（用户没填词也不会「戳了没反应」）
DEFAULT_WORDS = (
    "别戳啦，痒～",
    "在的在的，什么事？",
    "戳我干嘛，喵？",
    "再戳就生气啦！",
    "嗯？找我吗",
)


class PokeReplyModule:
    """戳一戳回复：词库 + 全局限频"""

    def __init__(self):
        self.enable = True
        # 限频：窗口秒数 / 窗口内最多回几次（所有群一起算）
        self.window_sec = 60
        self.max_per_window = 5
        # 词库 [{word: "..."}]
        self.words = []
        # 只在戳「机器人自己」时回复（关掉则任何人戳任何人都回）
        self.only_self = True
        # 群号黑名单（留空 = 所有群生效）
        self.groups = []
        # ---- 限频状态 ----
        self._lock = threading.RLock()
        self._hits = []              # 命中时间戳列表（滑动窗口）
        self._batch = 0              # 被限频吞掉了几次（给日志用）

    # ------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------
    def reload(self, cfg: dict, words=None):
        """从后台配置刷新（words 是数据集合的行，另行注入）"""
        cfg = cfg if isinstance(cfg, dict) else {}

        def _b(key, dflt):
            v = cfg.get(key, dflt)
            if isinstance(v, bool):
                return v
            return str(v).strip().lower() in ("1", "true", "yes", "on", "是")

        def _i(key, dflt, lo=0):
            try:
                return max(lo, int(str(cfg.get(key, dflt)).strip() or dflt))
            except Exception:
                return dflt

        self.enable = _b("poke_reply_enable", True)
        self.window_sec = _i("poke_reply_window_sec", 60, 1)
        self.max_per_window = _i("poke_reply_max_per_window", 5, 0)
        self.only_self = _b("poke_reply_only_self", True)
        try:
            self.groups = [str(g).strip() for g in
                           str(cfg.get("poke_reply_groups", "") or "")
                           .replace("，", ",").split(",") if str(g).strip()]
        except Exception:
            self.groups = []
        if words is not None:
            self.set_words(words)

    def set_words(self, rows):
        """词库行 -> 内部列表（一条一个词）"""
        out = []
        for r in (rows or []):
            if isinstance(r, dict):
                w = str(r.get("word") or "").strip()
            else:
                w = str(r or "").strip()
            if w:
                out.append({"word": w})
        self.words = out

    # ------------------------------------------------------------
    # 限频
    # ------------------------------------------------------------
    def _prune(self, now: float):
        """丢掉窗口外的时间戳"""
        cut = now - float(self.window_sec)
        self._hits = [t for t in self._hits if t > cut]

    def allow(self) -> bool:
        """
        现在能不能回？能则**记账**并返回 True。

        ★ 全局口径：不限群、不限人，整个机器人一起算。
        ★ max_per_window <= 0 表示不限频。
        """
        try:
            if self.max_per_window <= 0:
                return True
            now = time.time()
            with self._lock:
                self._prune(now)
                if len(self._hits) >= self.max_per_window:
                    self._batch += 1
                    return False
                self._hits.append(now)
                return True
        except Exception:
            logger.debug("[poke] 限频判断异常", exc_info=True)
            return True

    def stats(self) -> dict:
        """当前限频状态（给后台/日志看）"""
        with self._lock:
            now = time.time()
            self._prune(now)
            used = len(self._hits)
            left = max(0, self.max_per_window - used) \
                if self.max_per_window > 0 else -1
            return {"used": used, "left": left,
                    "window": self.window_sec,
                    "max": self.max_per_window,
                    "blocked": self._batch}

    def reset(self):
        """清空限频计数（管理员手动重置用）"""
        with self._lock:
            self._hits = []
            self._batch = 0

    # ------------------------------------------------------------
    # 取词
    # ------------------------------------------------------------
    def pick(self) -> str:
        """随机抽一句；没配词就用兜底"""
        pool = [w.get("word", "") for w in (self.words or [])]
        pool = [w for w in pool if str(w).strip()]
        if not pool:
            pool = list(DEFAULT_WORDS)
        try:
            return random.choice(pool)
        except Exception:
            return DEFAULT_WORDS[0]

    # ------------------------------------------------------------
    # 事件判断
    # ------------------------------------------------------------
    @staticmethod
    def is_poke(raw) -> bool:
        """
        是不是「戳一戳」通知。

        NapCat / OneBot v11 两种形态都认：
          · notice_type = notify, sub_type = poke          （标准）
          · notice_type = poke / group_poke                （部分实现）
        """
        if not isinstance(raw, dict):
            return False
        if str(raw.get("post_type") or "") != "notice":
            return False
        nt = str(raw.get("notice_type") or "").strip().lower()
        sub = str(raw.get("sub_type") or "").strip().lower()
        if nt == "notify" and sub in ("poke", "poke_self", "poken"):
            return True
        return nt in ("poke", "group_poke", "friend_poke")

    def match(self, raw, bot_id: str = "") -> dict:
        """
        是否该回复这次戳一戳。

        返回 {} 表示不回；否则返回 {group_id, sender, target, word}
        （`word` 已经抽好）。
        """
        if not self.enable:
            return {}
        if not self.is_poke(raw):
            return {}
        gid = str(raw.get("group_id") or "")
        sender = str(raw.get("user_id") or "")
        # ★ NapCat 的戳一戳字段：target_id = 被戳的人，
        #   有的实现用 user_id 表示被戳对象，所以两个都看。
        target = str(raw.get("target_id")
                     or raw.get("target")
                     or raw.get("user_id") or "")
        # 机器人被戳：target == bot
        if self.only_self:
            if not bot_id or target != str(bot_id):
                return {}
        # 群黑名单：填了就排除这些群
        if gid and self.groups and gid in self.groups:
            return {}
        if not self.allow():
            return {}
        return {"group_id": gid, "sender": sender, "target": target,
                "word": self.pick()}
