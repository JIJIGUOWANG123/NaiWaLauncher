# -*- coding: utf-8 -*-
r"""
QQ 用户信息查询（查询功能）。

数据来源（全部走 OneBot action，由协议端 NapCat 提供）：
    get_stranger_info   详细信息：昵称 / QID / 等级 / 签名 / 年龄 /
                        注册时间 / 会员等级 / 会员经验 / 大会员 …
    get_group_member_info  群内信息：群等级 / 活跃天数 / 入群时间 …

输出示例：
    查询昵称：归途
    查询等级：LV61级
    查询QID：wayhomeGG
    查询能量：828
    ...
"""
import datetime
import re

from astrbot.api import logger

# ★ @某人 内联形式：@昵称(123456789) / @昵称（123456789）
_AT_RE = re.compile(r"@[^\s()\u3000]*[\(（](\d{5,12})[\)）]")
# 裸 QQ 号
_QQ_RE = re.compile(r"\d{5,12}")


def parse_target(arg: str) -> str:
    """
    从指令参数里解析出目标 QQ。

    支持：@某人(123456789) / @某人（123456789） / 123456789 / 空格分隔
    返回 QQ 号字符串；解析不到返回空串。
    """
    s = str(arg or "").strip()
    if not s:
        return ""
    m = _AT_RE.search(s)
    if m:
        return m.group(1)
    m2 = _QQ_RE.search(s)
    return m2.group(0) if m2 else ""


# ============================================================
# 调用 OneBot action 的小工具
# ============================================================
async def _call(event, action: str, **params):
    """调 OneBot action；拿不到客户端/失败都返回 None。"""
    if event is None:
        return None
    bot = getattr(event, "bot", None)
    if bot is None or not hasattr(bot, "call_action"):
        return None
    try:
        r = bot.call_action(action, **params)
        if hasattr(r, "__await__"):
            r = await r
        return r
    except Exception as e:
        logger.debug(f"[qqinfo] {action} 失败: {e}")
        return None


def _dig(d, *keys, default=None):
    """按路径取值，任一层缺失就返回 default。"""
    cur = d
    for k in keys:
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur if cur is not None else default


def _s(v) -> str:
    if v is None or v is False:
        return ""
    # ★ 0 也当作「没有值」：很多字段缺失时协议端回 0
    if isinstance(v, (int, float)) and v == 0:
        return ""
    if isinstance(v, (dict, list, tuple, set)):
        return ""
    s = str(v).strip()
    # 字符串形式的假值也算空
    if s.lower() in ("none", "null", "false"):
        return ""
    return s


def _ts(v) -> str:
    """时间戳（秒）-> 'YYYY-MM-DD HH:MM:SS'；已是字符串就原样返回。"""
    if v is None or v == "" or v == 0:
        return ""
    if isinstance(v, str):
        s = v.strip()
        if re.match(r"\d{4}-\d{2}-\d{2}", s):
            return s
        if s.isdigit():
            v = int(s)
        else:
            return s
    try:
        n = int(v)
    except Exception:
        return str(v)
    if n <= 0:
        return ""
    # 毫秒时间戳自动降级
    if n > 10_000_000_000:
        n //= 1000
    try:
        return datetime.datetime.fromtimestamp(n).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def _days_between(ts_str: str) -> int:
    """从 'YYYY-MM-DD...' 到今天的天数。"""
    if not ts_str:
        return 0
    try:
        d = datetime.datetime.strptime(ts_str[:10], "%Y-%m-%d")
        return max(0, (datetime.datetime.now() - d).days)
    except Exception:
        return 0


# ============================================================
# 解析：把 NapCat 的响应摊平成统一结构
# ============================================================
def _walk_keys(node, depth=0, max_depth=8, prefix=""):
    """
    递归收集 { 小写键名: [(值, 完整路径), ...] }。

    ★ 为什么这么做：NapCat 的响应嵌套层级 / 字段名在不同版本里会变，
      靠写死路径（detail.simpleInfo.baseInfo.qid）很容易漏。
      改成递归按键名找，兼容性最好。
    """
    found = {}
    stack = [(node, prefix, depth)]
    seen = set()
    while stack:
        cur, path, d = stack.pop()
        if d > max_depth:
            continue
        if id(cur) in seen:
            continue
        seen.add(id(cur))
        if isinstance(cur, dict):
            for k, v in cur.items():
                key = str(k).lower()
                found.setdefault(key, []).append((v, f"{path}{k}"))
                if isinstance(v, (dict, list)):
                    stack.append((v, f"{path}{k}.", d + 1))
        elif isinstance(cur, list):
            for n, v in enumerate(cur[:20]):
                if isinstance(v, (dict, list)):
                    stack.append((v, f"{path}[{n}].", d + 1))
    return found


def _first(found, keys, pred=None):
    """
    从 _walk_keys 的结果里取第一个满足 pred 的值。

    keys 支持多个候选名（小写）；pred 用来排除无效值。
    """
    for k in keys:
        for v, _path in found.get(k.lower(), []):
            if pred is None:
                # ★ 注意：False 是**有效值**（表示「明确未开通」），
                #   不能跳过 —— 否则区分不了「假」和「字段不存在」。
                #   只跳过 None / 空串 / 容器。
                if v is None or v == "":
                    continue
                if isinstance(v, (dict, list, tuple, set)):
                    continue
                return v
            else:
                if pred(v):
                    return v
    return None


def _best(found, keys, score):
    """
    从多个候选里挑「得分最高」的一个。

    score(v, key) -> 分数；返回 None 表示不要这个候选。
    用于区分「昵称」和「长签名」这种同名不同用途的字段。
    """
    best_v, best_s = None, None
    for k in keys:
        for v, _path in found.get(k.lower(), []):
            if v is None or v is False or isinstance(v, (dict, list, tuple, set)):
                continue
            s = _s(v)
            if not s:
                continue
            sc = score(s, k)
            if sc is None:
                continue
            if best_s is None or sc > best_s:
                best_v, best_s = v, sc
    return best_v


def _one_line(s: str, limit: int = 0) -> str:
    """压成单行；limit>0 时超长会截断加省略号。"""
    s = " ".join(str(s or "").split())
    if limit and len(s) > limit:
        s = s[: limit - 1] + "…"
    return s


def parse_user_info(raw, member=None) -> dict:
    """
    把 get_stranger_info / get_group_member_info 的原始响应
    整理成统一 dict（键固定，取不到就是空串）。

    ★ 用**递归按键名搜索**，不依赖具体嵌套路径，
      所以 NapCat 换版本、字段换层级也能捞到。
    """
    out = {}
    if isinstance(raw, dict) and isinstance(raw.get("data"), dict):
        raw = raw["data"]
    if not isinstance(raw, dict):
        raw = {}
    mem = member
    if isinstance(mem, dict) and isinstance(mem.get("data"), dict):
        mem = mem["data"]
    if not isinstance(mem, dict):
        mem = {}

    f_raw = _walk_keys(raw)
    f_mem = _walk_keys(mem)

    def _num_str(v):
        """数字类字段 -> 字符串（去掉 .0）"""
        s = _s(v)
        if s.endswith(".0") and s[:-2].isdigit():
            s = s[:-2]
        return s

    # ---------------- 基础 ----------------
    # ★ 昵称：优先「单行且短」的候选。
    #   NapCat 里 longNick 可能是「带换行的长签名」（如每日鸡汤），
    #   直接取会把整段签名当昵称，所以按分数挑最像昵称的。
    def _nick_score(s, key):
        has_nl = ("\n" in s) or ("\r" in s)
        n = len(s)
        if has_nl:
            return None if n > 40 else 1        # 多行的基本是签名，弃用
        if n > 36:
            return 2                            # 太长，不太像昵称
        # 越短越像昵称；nickname/nick 这类键名额外加权
        base = 100 - n
        if key.lower() in ("nickname", "nick", "nickname2", "cardname",
                           "long_nick"):
            base += 30
        return base

    _nk = _best(f_raw, ("nickname", "nick", "nickname2", "cardname",
                        "long_nick", "longnick"), _nick_score)
    if _nk is None:
        _nk = _first(f_mem, ("nickname", "card", "nick"))
    # 兜底：实在只有长签名，就取它的第一行
    if _nk is None:
        _raw_nl = _first(f_raw, ("longnick", "long_nick", "nickname"))
        if _raw_nl is not None:
            _nk = str(_raw_nl).splitlines()[0] if str(_raw_nl).strip() else ""
    out["nick"] = _one_line(_s(_nk), 40)
    out["qid"] = _s(_first(f_raw, ("qid", "uid", "userid", "uin_qid"))
                    or _first(f_mem, ("qid",)))
    # ★ 签名：优先长的（多行的鸡汤那种就是签名，不是昵称）
    out["sign"] = _s(_best(
        f_raw, ("sign", "signature", "personalsign", "longnick", "long_nick"),
        lambda s, k: len(s)))
    out["age"] = _num_str(_first(f_raw, ("age",)) or _first(f_mem, ("age",)))
    out["sex"] = _s(_first(f_raw, ("sex", "gender")) or _first(f_mem, ("sex",)))

    # ---------------- 等级 ----------------
    #   优先 QQ 等级（qqLevel），再退群等级（memberLevel / level）
    out["qq_level"] = _num_str(
        _first(f_raw, ("qqlevel", "qq_level", "level", "memberlevel",
                       "member_level"))
        or _first(f_mem, ("memberlevel", "member_level", "level")))

    # ---------------- 能量 / 活跃 / 达人 ----------------
    out["energy"] = _num_str(_first(f_raw, (
        "energy", "qqenergy", "qq_energy", "power", "energyvalue")))
    out["active_day"] = _num_str(_first(f_raw, (
        "activeday", "active_day", "activedays", "activetime",
        "memberlevelinfoactiveday")))
    out["care_days"] = _num_str(_first(f_raw, (
        "caredays", "care_days", "caredays", "frienddays", "careday",
        "memberlevelinfocaredays")))

    # ---------------- 注册 ----------------
    reg = _first(f_raw, ("regtime", "reg_time", "registertime",
                         "register_time", "createtime", "create_time"))
    out["reg_time"] = _ts(reg) or _s(reg)
    out["reg_days"] = _num_str(_first(f_raw, (
        "regdays", "reg_days", "registerdays", "register_days")))
    if not out["reg_days"] and out["reg_time"]:
        d = _days_between(out["reg_time"])
        out["reg_days"] = str(d) if d else ""

    # ---------------- 头像修改 ----------------
    out["avatar_time"] = _ts(_first(f_raw, (
        "avatartime", "avatar_time", "avatarupdatetime", "avatar_update",
        "avatarmodifytime", "headimgupdatetime")))

    # ---------------- 会员 ----------------
    out["vip_level"] = _num_str(_first(f_raw, (
        "viplevel", "vip_level", "sviplevel", "svip_level")))
    out["vip_exp"] = _num_str(_first(f_raw, (
        "vipexp", "vip_exp", "vipscore", "vip_score", "vippoint")))
    out["vip_growth"] = _s(_first(f_raw, (
        "vipgrowth", "vip_growth", "growthspeed", "growth")))
    out["is_vip"] = _first(f_raw, ("isvip", "is_vip", "svipflag"),
                           pred=lambda v: v is not None and v != "")
    # ★ 键名必须是 is_years_vip（format_user_info 读的是这个）
    out["is_years_vip"] = _first(f_raw, (
        "isyearvip", "is_years_vip", "isyearvip", "yearvipflag"),
        pred=lambda v: v is not None and v != "")
    out["vip_open"] = _ts(_first(f_raw, ("vipopen", "vip_open", "vipexpire",
                                         "vipendtime")))
    out["svip_open"] = _ts(_first(f_raw, ("svipopen", "svip_open",
                                          "svipendtime")))
    out["year_vip_open"] = _ts(_first(f_raw, (
        "yearvipopen", "year_vip_open", "yearvipendtime")))
    out["big_month"] = _first(f_raw, (
        "bigmonth", "big_month", "monthvipflag", "ismonthvip",
        "ismonthbigvip"), pred=lambda v: v is not None and v != "")
    out["big_year"] = _first(f_raw, (
        "bigyear", "big_year", "yearbigvipflag", "isyearbigvip",
        "isyearvip"), pred=lambda v: v is not None and v != "")

    # ---------------- 群内 ----------------
    out["member_level"] = _num_str(_first(f_mem, (
        "memberlevel", "member_level", "level")))
    out["member_title"] = _s(_first(f_mem, ("title",)))
    out["join_time"] = _ts(_first(f_mem, ("jointime", "join_time")))
    out["last_sent"] = _ts(_first(f_mem, ("lastsenttime", "last_sent_time")))

    # 兜底：群内信息补空
    if not out["nick"]:
        out["nick"] = _s(_first(f_mem, ("nickname", "card")))
    if not out["sex"]:
        out["sex"] = _s(_first(f_mem, ("sex",)))
    if not out["age"]:
        out["age"] = _num_str(_first(f_mem, ("age",)))
    if not out["qid"]:
        out["qid"] = _s(_first(f_mem, ("qid",)))

    for k in ("member_level", "member_title", "join_time", "last_sent"):
        out.setdefault(k, "")

    # ★ 记下见过哪些键，便于排查「字段没解析出来」
    try:
        logger.info("[qqinfo] stranger 响应里所有键：%s",
                    sorted(f_raw.keys()))
        if f_mem:
            logger.info("[qqinfo] member 响应里所有键：%s",
                        sorted(f_mem.keys()))
    except Exception:
        pass
    return out

# ============================================================
# 拉取
# ============================================================
async def fetch_user_info(event, user_id: str, group_id: str = "") -> dict:
    """
    查一个 QQ 的详细资料。

    返回 (info_dict, raw_stranger, raw_member) 里的 info_dict；
    原始响应会顺便打日志，便于确认真实字段名。
    """
    uid = _s(user_id)
    if not uid:
        return {}
    # ① 详细资料（昵称/QID/等级/签名/注册时间/会员…）
    raw = await _call(event, "get_stranger_info",
                      user_id=int(uid) if uid.isdigit() else uid,
                      no_cache=False)
    member = None
    # ② 群内资料（群等级 / 活跃天数 / 入群时间）
    if group_id and str(group_id).isdigit():
        member = await _call(event, "get_group_member_info",
                             group_id=int(group_id), user_id=int(uid),
                             no_cache=False)
    try:
        logger.info(f"[qqinfo] get_stranger_info({uid}) 原始响应：{raw}")
        if member is not None:
            logger.info(f"[qqinfo] get_group_member_info({uid}) 原始响应：{member}")
    except Exception:
        pass
    return parse_user_info(raw, member)


# ============================================================
# 格式化输出
# ============================================================
def _lv_text(v: str) -> str:
    """等级统一成 'LV61级'"""
    s = _s(v)
    if not s:
        return ""
    m = re.search(r"\d+", s)
    return f"LV{m.group(0)}级" if m else s


def _yes_no(v) -> str:
    """
    开通状态 -> '已开通' / '未开通'。

    ★ False / 0 / "0" 要明确返回「未开通」，不能返回空 ——
      否则「月大会员：未开通」这一行会被省略掉，与用户要的格式不符。
    """
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return "已开通" if v else "未开通"
    if isinstance(v, (int, float)):
        return "已开通" if v else "未开通"
    s = _s(v)
    if not s:
        return ""
    if s.lower() in ("0", "false", "no", "off"):
        return "未开通"
    if s.lower() in ("1", "true", "yes", "on"):
        return "已开通"
    return s


def _days_with_years(n: str) -> str:
    """'1737' -> '1737天(≈4.8年)'"""
    s = _s(n)
    if not s or not s.isdigit():
        return s
    d = int(s)
    if d <= 0:
        return s
    return f"{d}天(≈{d / 365:.1f}年)"


# ★★ 1.7.7：昵称显示**统一走 path_utils 的公共实现** ——
#   以前这里自带一份「字符数 > 12 就砍」的版本：
#     · 中文英文按同一标准算，视觉宽度差一倍；
#     · 不清零宽 / 私用区字符，图片模式下会出方框。
try:
    from .path_utils import nick_display as _shared_nick
except Exception:               # 兜底：独立运行时
    try:
        from path_utils import nick_display as _shared_nick
    except Exception:
        _shared_nick = None


def _nick_display(s: str, limit: int = 0) -> str:
    """
    昵称显示：清掉渲染不出来的字符 + **按显示宽度**自适应省略。

    ★ `limit` 传 0（默认）就只用宽度预算；传具体值则额外收字符数上限。
    """
    if _shared_nick is not None:
        return _shared_nick(s, limit)
    return " ".join(str(s or "").split())


def _reg_date(s: str) -> str:
    """注册时间只留日期：'2007-01-01 12:34:56' -> '2007-01-01'"""
    s = _s(s)
    if not s:
        return ""
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else s


def _days_plain(n: str) -> str:
    """'7000' -> '7000天（≈19年）'"""
    s = _s(n)
    if not s or not s.isdigit():
        return s
    d = int(s)
    if d <= 0:
        return s
    return f"{d}天（≈{d / 365:.0f}年）"


def format_user_info(info: dict, user_id: str = "") -> str:
    """
    查询功能的输出（**精简 9 行**，文本模式与图片模式共用）：

        头像（仅图片模式，画在最顶部）
        QQ昵称：某某某（）太长省略号…
        QQ等级：100级
        QID：xxxxx
        QQ签名：签名
        注册时间：2007-01-01
        注册天数：7000天（≈19年）
        会员等级：6
        会员现状：未开通
    """
    if not info:
        return f"⚠️ 查不到 QQ {user_id} 的资料（可能隐私设置或协议端不支持）"

    lines = []

    def add(label, val, limit=0):
        # ★ 值里的换行压成空格，保证「一行一项」
        s = _s(val).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
        s = " ".join(s.split())
        if limit and len(s) > limit:
            s = s[:limit] + "…"
        if s:
            lines.append(f"{label}：{s}")

    # ① QQ昵称（太长省略号）
    add("QQ昵称", _nick_display(info.get("nick")))

    # ② QQ等级
    _lv = _s(info.get("qq_level"))
    if _lv:
        m = re.search(r"\d+", _lv)
        lines.append(f"QQ等级：{m.group(0)}级" if m else f"QQ等级：{_lv}")

    # ③ QID
    add("QID", info.get("qid"))

    # ④ QQ签名（太长也截断，避免卡片变太宽）
    add("QQ签名", info.get("sign") or "这个人很懒，什么都没写", limit=40)

    # ⑤ 注册时间（只留日期）
    add("注册时间", _reg_date(info.get("reg_time")))

    # ⑥ 注册天数（≈N年）
    add("注册天数", _days_plain(info.get("reg_days")))

    # ⑦ 会员等级（★ 0 也显示为「0级」，别整行消失）
    _vl = _s(info.get("vip_level"))
    _has_vip = bool(_vl) or any(
        info.get(k) is not None and info.get(k) != ""
        for k in ("vip_open", "svip_open", "is_vip", "is_years_vip"))
    if _has_vip:
        _vln = re.search(r"\d+", _vl)
        lines.append(f"会员等级：{_vln.group(0)}级" if _vln
                     else f"会员等级：{_vl or '0'}级")

    # ⑧ 会员现状：普通会员 / 超级会员 / 大会员 / 未开通
    #   优先级：年费大会员 > 大会员 > 超级会员 > 普通会员 > 未开通
    def _on(v):
        s = _yes_no(v)
        return s == "已开通"

    # ★★ 判定只看**真正的开通标志**：
    #   big_year / big_month      -> 大会员
    #   is_vip / is_years_vip     -> 超级会员
    #   ⚠️ vip_level **不是**开通状态！它是「QQ会员成长等级」
    #      （跟 QQ 等级类似，没开会员的人也有值），
    #      拿它判断会把没开会员的显示成已开通 —— 之前就是这么错的。
    _st = "未开通"
    if _on(info.get("big_year")) or _on(info.get("big_month")):
        _st = "大会员"
    elif _on(info.get("is_vip")) or _on(info.get("is_years_vip")):
        _st = "超级会员"
    lines.append(f"会员现状：{_st}")

    if len(lines) <= 2:
        return (f"⚠️ QQ {user_id} 的资料基本都是空的（可能隐私设置）\n"
                + "\n".join(lines))
    return "\n".join(lines)
