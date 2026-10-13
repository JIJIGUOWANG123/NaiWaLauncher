"""
群事件提示模块（1.7.6 新增）

★ 数据来源：**NapCat / OneBot v11 的 notice 事件推送**（实时，不轮询）

   AstrBot 的 aiocqhttp 适配器注册了 `@bot.on_notice()`，
   把 notice 事件转成 AstrBotMessage 分发下来（`raw_message` 保留原始 OneBot 数据）。
   本插件 `on_msg` 用的是 EventMessageType.ALL，所以能收到这些事件。

   支持的 notice_type（NapCat 字段）：
     notify / sub_type=title     群昵称变更（用户自己改名）
     notify / sub_type=title     专属称号变更（管理员设置/取消）
     group_ban                   禁言 / 解除禁言
     group_decrease              退群 / 被踢出
     group_admin                 成为 / 取消管理员

输出内容与开关指令都能在后台自定义，且**每个群独立开关**（默认全部关闭）。
"""

import time

from astrbot.api import logger
from .path_utils import title_bar, title_foot


# ============================================================
# 五类提示
# ============================================================
NOTICE_KINDS = ("card", "mute", "leave", "admin", "title")

NOTICE_LABEL = {
    "card":  "改群昵称",
    "mute":  "禁言 / 解禁",
    "leave": "退群 / 被踢出",
    "admin": "管理员变动",
    "title": "专属称号变动",
}

# 默认输出模板（后台可逐条自定义）
#   ★ 占位符用 $名字 写法，同时兼容 {名字} 写法
NOTICE_DEFAULT_TEXT = {
    "card": (
        "📝 群昵称变更\n"
        "👤 $old\n"
        "➡️ $new\n"
        "🕐 $time"
    ),
    "mute": (
        "🔇 禁言变更\n"
        "👤 $user\n"
        "⏱ $duration\n"
        "🛡 操作人：$operator\n"
        "🕐 $time"
    ),
    "leave": (
        "🚪 成员离开\n"
        "👤 $user\n"
        "📋 剩余人数：$count\n"
        "🕐 $time"
    ),
    "admin": (
        "🛡 管理员变动\n"
        "👤 $user\n"
        "🎖 $action\n"
        "🛡 操作人：$operator\n"
        "🕐 $time"
    ),
    "title": (
        "🏅 专属称号变动\n"
        "👤 $user\n"
        "➡️ $title\n"
        "🛡 操作人：$operator\n"
        "🕐 $time"
    ),
}

# 默认开关指令短名（完整指令 = 「开启提示」+ 短名）
NOTICE_DEFAULT_CMD = {
    "card":  "昵称",
    "mute":  "禁言",
    "leave": "退群",
    "admin": "管理员",
    "title": "称号",
}


def _fmt_dur(sec) -> str:
    """秒 -> 人话时长"""
    try:
        s = int(sec)
    except Exception:
        return "未知"
    if s <= 0:
        return "已解除"
    if s >= 86400:
        d, r = divmod(s, 86400)
        h = r // 3600
        return f"{d} 天" + (f" {h} 小时" if h else "")
    if s >= 3600:
        h, r = divmod(s, 3600)
        m = r // 60
        return f"{h} 小时" + (f" {m} 分钟" if m else "")
    if s >= 60:
        return f"{s // 60} 分钟"
    return f"{s} 秒"


def _render(tpl: str, kv: dict) -> str:
    """
    渲染模板。

    ★ 同时支持 `$名字` 和 `{名字}` 两种占位符，方便随便写。
      未提供的占位符保持原样（不报错），便于排查。
    """
    import re
    out = str(tpl or "")

    def _sub_dollar(m):
        return str(kv.get(m.group(1), m.group(0)))

    out = re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", _sub_dollar, out)

    def _sub_brace(m):
        return str(kv.get(m.group(1), m.group(0)))

    out = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", _sub_brace, out)
    return out


def _g(d, *names, default=""):
    """从 dict 里按多个候选键名取值（不同协议端字段名不一样）"""
    if not isinstance(d, dict):
        return default
    for n in names:
        v = d.get(n)
        if v not in (None, "", 0, "0"):
            return v
    return default


class NoticeModule:
    """
    群事件提示。

    数据（全部来自后台配置，不在数据文件里存状态）：
      每类一个白名单群号清单（notice_groups_<kind>），
      留空 = 该类关闭；五类都留空 = 提示功能完全关闭（默认就是这样）。
    昵称/人数缓存只在内存里。
    """

    def __init__(self, data_store=None):
        self.data_store = data_store
        # ★ 白名单语义：每类提示各自一份允许的群号清单。
        #   留空 = 该类谁都不提示（默认全部关闭）。
        self.whitelist = {k: set() for k in NOTICE_KINDS}
        self.cmds = dict(NOTICE_DEFAULT_CMD)
        self.texts = dict(NOTICE_DEFAULT_TEXT)
        # ★ 诊断模式：打开后**不按白名单过滤**，把收到的 Notice 原始数据发出来
        self.debug = False
        # 内存昵称缓存：{群号: {用户号: 显示名}}
        self._name_cache = {}
        # 内存群人数缓存：{群号: 人数}（notice 事件不带总人数，靠增减推算）
        self._count_cache = {}
        # 机器人自己的 QQ 与昵称（notice 的 operator_id 常是机器人自己，
        #   但事件里不带操作人昵称，所以靠普通消息顺手缓存）
        self.bot_id = ""
        self.bot_name = ""
        # ★ 改名去重表：{(群,人,旧,新): 上次发送时间}
        self._dedup = {}

    # ------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}

        def _b(key, default=False):
            v = cfg.get(key, default)
            if isinstance(v, bool):
                return v
            s = str(v).strip().lower()
            if s in ("false", "0", "no", "off", "n", "否", "关闭"):
                return False
            if s in ("true", "1", "yes", "on", "y", "是", "开启"):
                return True
            return bool(default)

        self.debug = _b("notice_debug", False)
        for k in NOTICE_KINDS:
            raw = str(cfg.get(f"notice_groups_{k}", "") or "")
            self.whitelist[k] = {
                x.strip() for x in raw.replace("，", ",").split(",")
                if x.strip()}
            c = str(cfg.get(f"notice_cmd_{k}", "") or "").strip()
            if c:
                self.cmds[k] = c
            t = str(cfg.get(f"notice_text_{k}", "") or "")
            if t.strip():
                self.texts[k] = t

    # ------------------------------------------------------------
    # 白名单
    # ------------------------------------------------------------
    @staticmethod
    def _norm(text) -> set:
        return {x.strip() for x in str(text or "").replace("，", ",")
                .split(",") if x.strip()}

    def group_allow(self, kind: str, group_id) -> bool:
        """某群是否在该类提示的白名单里（白名单为空 = 该类全关）"""
        if kind not in NOTICE_KINDS:
            return False
        wl = self.whitelist.get(kind) or set()
        if not wl:
            return False
        return str(group_id or "") in wl

    def is_on(self, group_id, kind: str) -> bool:
        """该类提示在某群是否生效（就是白名单判定）"""
        return self.group_allow(kind, group_id)

    def allow_any(self, group_id) -> bool:
        return any(self.group_allow(k, group_id) for k in NOTICE_KINDS)

    def whitelist_text(self, kind: str) -> str:
        """某一类白名单的可读内容（后台/自检用）"""
        return self.whitelist_state(kind)

    # ------------------------------------------------------------
    # 昵称缓存（notice 事件里不一定带全昵称，内存缓存一份兜底）
    # ------------------------------------------------------------
    def remember_name(self, group_id, uid, name: str):
        if not name:
            return
        g = str(group_id or "")
        if not g:
            return
        row = self._name_cache.setdefault(g, {})
        row[str(uid)] = str(name)
        if len(row) > 500:
            for k in list(row.keys())[:-500]:
                row.pop(k, None)

    def bump_count(self, group_id, delta: int, absolute=None):
        """
        维护「群人数」缓存（$count 用）。

        ★ notice 事件本身不带总人数，所以只能：
          · group_increase -> 人数 +1（delta=+1）
          · group_decrease -> 人数 -1（delta=-1）
        绝对人数（如果事件里带了 member_count）优先。
        """
        g = str(group_id or "")
        if not g:
            return
        try:
            if absolute is not None:
                self._count_cache[g] = max(0, int(absolute))
                return
            cur = self._count_cache.get(g)
            if cur is None:
                # 还没基线：只用增量记个大致值（首次会有偏差）
                self._count_cache[g] = max(0, int(delta))
            else:
                self._count_cache[g] = max(0, int(cur) + int(delta))
        except Exception:
            pass

    def count_of(self, group_id):
        """已知群人数；未知返回 None"""
        return self._count_cache.get(str(group_id or ""))

    def name_of(self, group_id, uid, fallback="") -> str:
        """
        显示名：优先本群缓存 -> 机器人自己（operator 常是机器人）-> QQ 号
        """
        g = str(group_id or "")
        nm = (self._name_cache.get(g) or {}).get(str(uid))
        if nm:
            return nm
        # ★ 事件里的 operator_id 常常就是机器人自己，
        #   但 notice 不带操作人昵称；这时用记下来的机器人昵称，
        #   否则会显示成一串 QQ 号。
        if self.bot_id and str(uid) == str(self.bot_id) and self.bot_name:
            return self.bot_name
        return fallback or f"QQ{uid}"

    def set_bot_identity(self, bot_id, bot_name: str = ""):
        """记录机器人自己的 QQ 与昵称（由主流程在收到消息时调用）"""
        try:
            bid = str(bot_id or "").strip()
            if bid:
                self.bot_id = bid
            nm = str(bot_name or "").strip()
            if nm and nm != self.bot_id:
                self.bot_name = nm
        except Exception:
            pass

    # ------------------------------------------------------------
    # 去重：同一次改名可能被同一事件重复投递，
    #       这里保证同一个 (群, 人, 旧→新) 只发一次。
    # ------------------------------------------------------------
    # ------------------------------------------------------------
    # 去重：同一次变化可能被「notice 事件」和「群名片比对」两条路各发现一次，
    #       这里做闸门，保证同一个 (群, 人, 旧→新) 只发一次。
    # ------------------------------------------------------------
    def _dedup_hit(self, group_id, uid, old, new,
                   window: float = 90.0) -> bool:
        """
        返回 True 表示「最近刚发过同样的变化」-> 这次不要再发。

        ★ key 里带上 old/new，所以「改了 A 又改成 B」不会被误吞，
          只有完全相同的同一次变化才会被拦。
        """
        import time as _t
        g = str(group_id or "")
        u = str(uid or "")
        now = _t.time()
        key = (g, u, str(old or ""), str(new or ""))
        last = self._dedup.get(key)
        # 顺手清掉过期项，避免无限增长
        if len(self._dedup) > 200:
            for k in [k for k, v in self._dedup.items()
                      if now - float(v) > window]:
                self._dedup.pop(k, None)
        if last is not None and (now - float(last)) < window:
            return True
        self._dedup[key] = now
        return False

    def config_card(self, group_id, uid, old, new, operator="（本人）") -> list:
        """
        ★ 唯一出口：改群昵称的提示都从这里出（两条检测路共用）。

        好处：
          · 统一模板（不会一条用 notice 模板、一条用默认模板）
          · 统一去重（同一次改名只发一次）
          · 统一白名单判断

        返回要发送的文本列表（没变化 / 没开 / 重复 -> 空列表）。
        """
        g = str(group_id or "")
        u = str(uid or "")
        old = str(old or "").strip()
        new = str(new or "").strip()
        if not g or not u or not new or old == new:
            return []
        if not self.group_allow("card", g):
            return []
        # 名字进缓存，供 $user / $operator 用
        self.remember_name(g, u, new)
        if self._dedup_hit(g, u, old, new):
            logger.debug("[notice] 同一次改名已提示过，跳过：%s %s->%s",
                         u, old, new)
            return []
        kv = {
            "user": new, "uid": u, "qq": u, "name": new,
            "old": old or "（未知）", "new": new,
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "group": g, "operator": operator,
        }
        tpl = self.texts.get("card") or NOTICE_DEFAULT_TEXT["card"]
        txt = _render(tpl, kv).strip()
        return [txt] if txt else []

    # ------------------------------------------------------------
    # 指令（只读查询）
    # ------------------------------------------------------------
    def kind_of(self, text: str):
        """
        把一个短名/别名解析成 kind（不认返回 None）。

        · 短名可后台自定义（notice_cmd_*）
        """
        t = str(text or "").strip()
        if not t:
            return None
        rev = {}
        for k in NOTICE_KINDS:
            rev[str(self.cmds.get(k) or NOTICE_DEFAULT_CMD[k])] = k
            rev[NOTICE_DEFAULT_CMD[k]] = k
            rev[NOTICE_LABEL[k]] = k
            rev[k] = k
        return rev.get(t)

    def match_cmd(self, text: str):
        """
        解析远程开关指令（**白名单增删**）。

        · 「开启提示昵称」-> 把本群加入「改群昵称」白名单
        · 「关闭提示昵称」-> 把本群移出白名单
        · 「开启提示」/「关闭提示」-> 五类一起
        · 支持一次多个：`开启提示昵称,退群`
        · 短名可后台自定义（notice_cmd_*）

        返回 (action, kinds) 或 None；action = "on" / "off"
        """
        t = str(text or "").strip().lstrip("/").strip()
        if not t:
            return None
        for prefix, action in (("开启提示", "on"), ("关闭提示", "off")):
            if not t.startswith(prefix):
                continue
            rest = t[len(prefix):].strip()
            if not rest:
                return (action, list(NOTICE_KINDS))
            parts = [x for x in rest.replace("，", ",").replace("、", ",")
                     .replace(" ", ",").split(",") if x.strip()]
            want = []
            for p in parts:
                k = self.kind_of(p.strip())
                if k and k not in want:
                    want.append(k)
            return (action, want) if want else None
        return None

    def edit_whitelist(self, kind: str, group_id, add: bool):
        """
        改写磁盘配置里某一类提示的白名单（远程指令用）。

        ★ 直接改 AstrBot 的插件配置文件（原子写），
          然后由调用方触发一次 reload_cfg 让它生效。
        返回 (是否成功, 说明文本)
        """
        if kind not in NOTICE_KINDS:
            return False, "未知的提示类型"
        g = str(group_id or "").strip()
        if not g or not g.isdigit():
            return False, "群号无效"
        key = f"notice_groups_{kind}"
        try:
            try:
                from .path_utils import read_disk_config, write_disk_config
            except Exception:
                from core.path_utils import read_disk_config, write_disk_config
        except Exception:
            return False, "配置读写模块不可用"

        cfg = read_disk_config() or {}
        cur = {x.strip() for x in str(cfg.get(key, "") or "")
               .replace("，", ",").split(",") if x.strip()}
        if add:
            if g in cur:
                return True, "already"
            cur.add(g)
            note = "added"
        else:
            if g not in cur:
                return True, "absent"
            cur.discard(g)
            note = "removed"
        # 保持稳定顺序：数字升序，方便后台看
        try:
            cfg[key] = ",".join(sorted(cur, key=lambda x: int(x)))
        except Exception:
            cfg[key] = ",".join(sorted(cur))
        if not write_disk_config(cfg):
            return False, "写入配置文件失败"
        # 立刻更新内存里的白名单，不用等重载
        self.whitelist[kind] = cur
        return True, note

    def whitelist_state(self, kind: str) -> str:
        """某一类白名单的当前内容（给回执用）"""
        wl = self.whitelist.get(kind) or set()
        return "、".join(sorted(wl, key=lambda x: int(x) if x.isdigit() else 0)) \
            or "（空 = 关闭）"

    def debug_text(self, group_id, raw) -> str:
        """诊断模式：把收到的 Notice 原始数据整理成可读文本"""
        import json as _json
        try:
            body = _json.dumps(raw, ensure_ascii=False, indent=2)
        except Exception:
            body = str(raw)
        if len(body) > 1500:
            body = body[:1500] + "\n…（已截断）"
        nm = NoticeModule.parse_notice(raw)
        lines = [
            "🔬【提示功能·诊断】收到一个 Notice",
            f"🏠 群号：{group_id}",
            f"✅ 识别为：{NOTICE_LABEL.get(nm.get('kind'), '未识别')}"
            if nm else "❌ 未能识别（本插件目前不处理这类事件）",
            f"🔔 本群是否开启该类："
            f"{'是' if nm and self.group_allow(nm.get('kind'), group_id) else '否'}",
            "",
            "原始数据：",
            f"```json\n{body}\n```",
        ]
        return "\n".join(lines)

    def status_text(self, group_id) -> str:
        """
        「提示状态」用：本群五类提示是否在白名单里 + 白名单参考。

        ★ 白名单只能在后台改，所以这里在群里是**只读**的。
        """
        g = str(group_id or "")
        lines = [f"{title_bar('提示功能状态')}", f"🏠 本群：{g}", ""]
        _any = False
        for k in NOTICE_KINDS:
            on = self.group_allow(k, g)
            if on:
                _any = True
            cmd = self.cmds.get(k) or NOTICE_DEFAULT_CMD[k]
            lines.append(f"{'✅' if on else '❌'} {NOTICE_LABEL[k]}"
                         f"（短名：{cmd}）")
        lines.append("")
        if _any:
            lines.append("🔔 本群已开启的提示会上面的 ✅ 显示")
        else:
            lines.append("🚫 本群**不在任何提示白名单**里（默认全部关闭）")
        lines.append("")
        lines.append("⚠️ 开关是**白名单**，只能在后台按提示分别填写群号：")
        for k in NOTICE_KINDS:
            lines.append(f"　 · {NOTICE_LABEL[k]}"
                         f"　→ 后台 `notice_groups_{k}`")
        return "\n".join(lines)

    def self_check_text(self, group_id) -> str:
        """后台排查用：本群在各白名单里的情况 + 白名单内容"""
        g = str(group_id or "")
        lines = [f"{title_bar('提示白名单自检')}", f"🏠 本群：{g}", ""]
        for k in NOTICE_KINDS:
            wl = self.whitelist.get(k) or set()
            hit = "✅ 命中" if g in wl else "❌ 未命中"
            lines.append(f"{NOTICE_LABEL[k]}：{hit}")
            lines.append(f"　 白名单：{self.whitelist_text(k)}")
        return "\n".join(lines)

    # ------------------------------------------------------------
    # notice 事件解析
    # ------------------------------------------------------------
    @staticmethod
    def parse_notice(raw) -> dict:
        """
        从原始 OneBot 事件里解析出「变化」。

        返回 {} 表示不是（或不是我们关心的）notice。
        否则返回：{kind, uid, ...} 供渲染用。
        """
        if not isinstance(raw, dict):
            return {}
        if str(raw.get("post_type") or "") != "notice":
            return {}
        nt = str(raw.get("notice_type") or "").strip()
        sub = str(raw.get("sub_type") or "").strip()
        uid = str(raw.get("user_id") or "")
        op = str(raw.get("operator_id") or "")
        gid = str(raw.get("group_id") or "")

        # ---- 群成员减少：退群 / 被踢 ----
        if nt == "group_decrease":
            return {
                "kind": "leave",
                "uid": uid,
                "operator": op,
                "action": "被踢出" if sub == "kick" else "主动退群",
                "raw": raw,
            }

        # ---- 群成员增加：只用来维护人数缓存，不单独提示 ----
        if nt == "group_increase":
            return {"kind": "_count", "uid": uid, "raw": raw}

        # ---- 禁言 / 解除禁言 ----
        if nt == "group_ban":
            dur = raw.get("duration")
            try:
                dur = int(dur or 0)
            except Exception:
                dur = 0
            return {
                "kind": "mute",
                "uid": uid,
                "operator": op,
                "duration": dur,
                "is_unmute": (sub == "lift_ban" or dur == 0),
                "raw": raw,
            }

        # ---- 管理员变动 ----
        if nt == "group_admin":
            return {
                "kind": "admin",
                "uid": uid,
                "operator": op,
                # sub_type: set = 成为管理员 / unset = 取消管理员
                "action": ("被取消管理员" if sub == "unset" else "成为管理员"),
                "raw": raw,
            }

        # ---- 改群名片 / 改群昵称（不同端/不同版本的 notice_type 不一样）----
        #   ★ 改昵称**保留 notice 路**（发言路已移除）。
        if nt in ("group_card", "group_card_change", "group_nickname",
                  "group_member_card"):
            new = _g(raw, "card_new", "card", "nickname_new", "nickname",
                     "new_card")
            old = _g(raw, "card_old", "old_card", "nickname_old")
            if new or old:
                return {
                    "kind": "card",
                    "uid": uid,
                    "operator": op,
                    "new": str(new or ""),
                    "old": str(old or ""),
                    "raw": raw,
                }
            return {}

        # ---- notify 家族：昵称 / 称号 / 戳一戳等 ----
        if nt == "notify":
            # 群昵称变更：NapCat 的 sub_type 常见为 "title"，
            #   靠「有没有 nickname_new」来区分是改名还是改称号
            new_nick = _g(raw, "nickname_new", "nickname", "card_new",
                          "card", "new_card")
            new_title = _g(raw, "title_new", "title", "special_title",
                           "new_title")
            if new_nick and sub in ("title", "nickname", "card", ""):
                if not new_title or sub in ("nickname", "card"):
                    return {
                        "kind": "card",
                        "uid": uid,
                        "operator": op,
                        "new": str(new_nick),
                        "raw": raw,
                    }
            if new_title:
                return {
                    "kind": "title",
                    "uid": uid,
                    "operator": op,
                    "title": str(new_title),
                    "raw": raw,
                }
            return {}
        return {}

    def build_message(self, group_id, info: dict) -> str:
        """把解析结果渲染成要发送的文本（未开启则返回空）"""
        kind = str(info.get("kind") or "")
        if kind not in NOTICE_KINDS:
            return ""
        uid = str(info.get("uid") or "")
        raw = info.get("raw") or {}
        # 昵称：优先用事件里带的，其次本地缓存，最后 QQ 号
        nm = str(_g(raw, "nickname_new", "card_new", "card", "nickname")
                 or "") or self.name_of(group_id, uid)
        op = str(info.get("operator") or "")
        # ★ 1.7.6：操作人昵称拿不到时**显示 QQ 号**，不要显示「（未知）」。
        #   以前的坑：notice 事件里 operator_id 常常是**机器人自己**，
        #   而事件不带它的昵称，于是操作人一栏全变成「（未知）」，
        #   看起来像「没识别出是谁操作的」。
        if op:
            _opn = self.name_of(group_id, op)
            # name_of 兜底是 "QQ<号>"；只有实在拿不到任何信息才算未知
            op_name = _opn if _opn and _opn != "（未知）" else f"QQ{op}"
        else:
            op_name = "（未知）"
        tm = time.strftime("%Y-%m-%d %H:%M:%S")

        kv = {
            "user": nm, "uid": uid, "qq": uid, "name": nm,
            "time": tm, "group": str(group_id or ""),
            "operator": op_name, "operator_id": op,
        }
        if kind == "card":
            # ★ 改群昵称走统一出口（含去重，避免两条检测路各报一次）。
            #   ★ 注意 config_card 返回的是**列表**，而 build_message 的
            #     契约是返回**字符串** —— 这里必须取 [0]，
            #     否则会把整个 list 的 repr 当成文本发出去
            #     （表现为「不换行 + 带 [' '] 括号」）。
            _old = str(info.get("old") or "")
            if not _old:
                _old = self.name_of(group_id, uid, "（未知）")
            _msgs = self.config_card(group_id, uid, _old,
                                     str(info.get("new") or nm),
                                     operator=op_name)
            return (_msgs[0] if _msgs else "")
        if kind == "mute":
            if info.get("is_unmute"):
                kv["duration"] = "已解除"
                kv["kind"] = "解禁"
            else:
                kv["duration"] = _fmt_dur(info.get("duration"))
                kv["kind"] = "禁言"
        elif kind == "leave":
            kv["action"] = str(info.get("action") or "离开")
            _c = self.count_of(group_id)
            kv["count"] = "未知" if _c is None else str(_c)
        elif kind == "admin":
            kv["action"] = str(info.get("action") or "管理员变动")
        elif kind == "title":
            kv["title"] = str(info.get("title") or "（已取消）")
            kv["old"] = ""
            kv["new"] = kv["title"]
        tpl = self.texts.get(kind) or NOTICE_DEFAULT_TEXT[kind]
        return _render(tpl, kv).strip()

    def remember_from_event(self, group_id, raw):
        """把 notice 里出现的昵称记进缓存，方便以后渲染"""
        if not isinstance(raw, dict):
            return
        uid = str(raw.get("user_id") or "")
        nm = _g(raw, "nickname_new", "card_new", "card", "nickname")
        if uid and nm:
            self.remember_name(group_id, uid, str(nm))
        op = str(raw.get("operator_id") or "")
        # ★ 操作人是机器人自己时，事件里没有它的昵称 —— 不知道就显示 QQ 号
        if op and str(op) == str(self.bot_id) and not self.bot_name:
            logger.debug("[notice] 操作人是机器人自己，但还没缓存到它的昵称")
        onm = _g(raw, "operator_nickname", "operator_name")
        if op and onm:
            self.remember_name(group_id, op, str(onm))
