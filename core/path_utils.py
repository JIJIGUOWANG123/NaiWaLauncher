import os
import sys
import re
import json

PLUGIN_ID = "astrbot_plugin_custom_entertainment"
PLUGIN_CONFIG_FILENAME = f"{PLUGIN_ID}_config.json"
PLUGIN_FORTUNE_DATA_FILENAME = f"{PLUGIN_ID}_fortune.json"
PLUGIN_HUSBAND_DATA_FILENAME = f"{PLUGIN_ID}_husband.json"
PLUGIN_LUCK_DATA_FILENAME = f"{PLUGIN_ID}_luck.json"
PLUGIN_GREETING_DATA_FILENAME = f"{PLUGIN_ID}_greeting.json"
PLUGIN_MINECRAFT_DATA_FILENAME = f"{PLUGIN_ID}_minecraft.json"
PLUGIN_CHECKIN_DATA_FILENAME = f"{PLUGIN_ID}_checkin.json"
PLUGIN_HOURLY_CHIME_DATA_FILENAME = f"{PLUGIN_ID}_hourly_chime.json"
PLUGIN_STATUS_PUSH_DATA_FILENAME = f"{PLUGIN_ID}_status_push.json"
PLUGIN_DAILY_NEWS_DATA_FILENAME = f"{PLUGIN_ID}_daily_news.json"
PLUGIN_NICKNAME_DATA_FILENAME = f"{PLUGIN_ID}_nickname.json"
PLUGIN_SPEAK_STATS_DATA_FILENAME = f"{PLUGIN_ID}_speak_stats.json"
PLUGIN_PET_DATA_FILENAME = f"{PLUGIN_ID}_pet.json"
PLUGIN_BIRD_DATA_FILENAME = f"{PLUGIN_ID}_bird.json"
PLUGIN_DATA_STORE_FILENAME = f"{PLUGIN_ID}_data.json"
PLUGIN_RPS_DATA_FILENAME = f"{PLUGIN_ID}_rps.json"
# ★★ 1.7.7：猜数游戏数据文件
PLUGIN_GUESS_DATA_FILENAME = f"{PLUGIN_ID}_guess.json"
# ★★ 市场版 1.1：赛车数据文件
PLUGIN_RACING_DATA_FILENAME = f"{PLUGIN_ID}_racing.json"
# ★★ 1.7.7：收发消息计数（重载不归零）
PLUGIN_MSG_STATS_FILENAME = f"{PLUGIN_ID}_msg_stats.json"

# ============================================================
# 统一排版（1.7.6）
# ------------------------------------------------------------
# 所有**输出内容**的标题都跟菜单保持一致：
#     鸡鸡娱乐系统：{标题}
#     ━━━━━━━━━━━━━━━━━━━━
# 结尾用 _FOOT 收尾，和菜单一样。
#
# ★ 为什么放在这里：这里没有其它依赖，各 core 模块都能安全导入。
# ============================================================
# ★★ 1.7.6：「鸡鸡娱乐系统：」这个前缀**可以自定义**（后台 `title_prefix`）。
#   实现方式：模块级可变量 + `set_title_prefix()`。
#   这样 `title_bar()` 每次调用取当前值，**100 多个调用点一个都不用改**。
TITLE_PREFIX_DEFAULT = "铁剑娘系统："
TITLE_PREFIX = TITLE_PREFIX_DEFAULT
TITLE_SEP = "━" * 20        # 标题下面的分隔线
TITLE_FOOT = "━" * 36       # 收尾线


# ★ 用户表达「不要前缀」时可能填的值（避免误填出「关闭：」这种怪标题）
_TITLE_PREFIX_OFF = {
    "", "无", "没有", "不要", "关闭", "关", "取消", "空", "留空",
    "none", "null", "nil", "false", "off", "no", "0", "-",
}


def set_title_prefix(prefix) -> str:
    """
    设置统一标题前缀（后台「菜单指令 → 全局标题前缀」）。

    ★ **留空 = 不要前缀**（只留标题本身）。
    ★ 传 None（键不存在）-> 回落到默认值「铁剑娘系统：」。
    ★ 填「无 / 关闭 / none / false」也当「不要前缀」，防止误填出
      「关闭：机器人运行状态」这种怪标题。
    ★ 自动补上「：」，所以填 `我的机器人` 和 `我的机器人：` 等价。
    """
    global TITLE_PREFIX
    if prefix is None:
        TITLE_PREFIX = TITLE_PREFIX_DEFAULT
        return TITLE_PREFIX
    p = str(prefix).strip()
    # ★ 留空 / 或填了「不要前缀」的等价词 -> 彻底不要前缀
    if p.lower() in _TITLE_PREFIX_OFF:
        TITLE_PREFIX = ""
        return TITLE_PREFIX
    # 末尾统一成「：」，避免出现「我的机器人标题」这种粘连
    p = p.rstrip("：: 　\t")
    TITLE_PREFIX = (p + "：") if p else ""
    return TITLE_PREFIX


def title_bar(title: str, foot: bool = False) -> str:
    """
    统一标题：`{前缀}{标题}` + 分隔线（两行）。

    前缀默认「鸡鸡娱乐系统：」，可由后台 `title_prefix` 自定义，
    也可以设成空串来完全去掉前缀。

    foot=True 时额外在末尾加收尾线（一般不用，收尾线由调用方按需加）。
    """
    t = str(title or "").strip()
    if not t:
        return TITLE_SEP
    # ★ 用模块级变量（可被 set_title_prefix 改），不要用常量快照
    _pfx = TITLE_PREFIX
    if _pfx and not t.startswith(_pfx):
        t = f"{_pfx}{t}"
    out = t + "\n" + TITLE_SEP
    if foot:
        out += "\n" + TITLE_FOOT
    return out


def strip_md(text: str) -> str:
    """
    去掉 **Markdown 强调标记**（图片渲染不支持，会显示成字面量 `**`）。

    ★★ 1.7.6：菜单/输出里为了后台（网页）好看用了 `**加粗**`，
      但**图片模式**是本地渲染、不认 markdown，`**` 会原样画出来，
      而且让文字看起来被斜体化 —— 所以进渲染前统一去掉。

    处理：`**文字**` -> `文字`（保留文字，只去标记）；落单的也去掉。
    """
    s = str(text or "")
    if "**" not in s:
        return s
    import re as _re2
    s = _re2.sub(r"\*\*(.+?)\*\*", r"\1", s, flags=_re2.S)
    return s.replace("**", "")


_BAR_CHARS = "\u2500\u2501\u2504\u2508\u254c"


def _is_bar_line(s: str) -> bool:
    """整行都是横线字符（含前导空白）"""
    t = str(s or "").strip()
    return bool(t) and all(ch in _BAR_CHARS for ch in t)


def with_bottom_bar(text: str, bar: str = "") -> str:
    """
    保证输出**最后有一条底部横线**，尾巴才能挂到它下面。

    ★ 1.7.6：以前只有部分输出自带收尾线，其它（排行 / 查询 / 各种状态）
      底部没有横线，尾巴就跟正文挤在一起、位置忽上忽下。
      现在统一在出口补一条。

    规则：
      · 末尾（忽略空行）已经是横线 -> 原样返回
      · 否则在末尾追加一条横线

    `bar` 不传用默认收尾线 `TITLE_FOOT`（36 段 `━`）；
    渲染端会把横线按卡片宽度自适应，所以不用精确算长度。
    """
    s = str(text or "")
    if not s.strip():
        return s
    # ★ 先去掉**末尾空行**：不然「横线 + 空行」会把尾巴顶到横线下面去
    lines = s.rstrip("\n").split("\n")
    _tail_blank = []
    while lines and not lines[-1].strip():
        _tail_blank.append(lines.pop())
    if lines and _is_bar_line(lines[-1]):
        return "\n".join(lines)          # 已经有底部横线
    return "\n".join(lines) + "\n" + (bar or TITLE_FOOT)


def title_foot() -> str:
    """收尾横线（托住整段输出，和菜单一致）"""
    return TITLE_FOOT


# ============================================================
# 数字缩略显示（1.7.6）
# ------------------------------------------------------------
# 积分数一大，满屏都是「1234567」这种长数字，很不好读。
# 统一缩略：过万 -> `5.2万`，过亿 -> `1.2亿`。
# ============================================================
def fmt_num(v, unit_wan: str = "万", unit_yi: str = "亿") -> str:
    """
    把数字缩略成人话（保留 1 位小数，去掉多余的 .0）：

        999        -> "999"
        10000      -> "1万"
        52000      -> "5.2万"
        1234567    -> "123.5万"
        100000000  -> "1亿"
        123456789  -> "1.2亿"

    ★ 只影响**显示**，内部计算仍然用完整整数（别拿去参与运算）。
    ★ 非数字原样返回，避免把 None / 空串变成怪东西。
    """
    try:
        if v is None or (isinstance(v, str) and not v.strip()):
            return "0"
        f = float(v)
    except Exception:
        return str(v)
    neg = f < 0
    a = abs(f)
    if a >= 1e8:
        s = f"{a / 1e8:.1f}".rstrip("0").rstrip(".") + unit_yi
    elif a >= 1e4:
        # ★ 过千万（含四舍五入会变成 1000 万）直接用「亿」，
        #   否则会出现「1234.6万」这种不好读的数
        if a / 1e4 >= 999.95:
            s = f"{a / 1e8:.2f}".rstrip("0").rstrip(".") + unit_yi
        else:
            s = f"{a / 1e4:.1f}".rstrip("0").rstrip(".") + unit_wan
    else:
        # 小于一万：整数就不带小数点
        s = str(int(a)) if abs(a - int(a)) < 1e-9 else f"{a:g}"
    return ("-" if neg else "") + s


# ============================================================
# 坐骑图片素材（**已弃用**）
#   ★★ 市场版：坐骑图片功能已移除。
#   这里只保留常量与查找函数，保证历史代码路径调用时不报错；
#   默认目录为**空字符串**（不再指向任何本机路径）。
# ============================================================
MOUNT_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
DEFAULT_MOUNT_IMG_DIR = ""

# ============================================================
# ★★ 1.7.7：昵称显示的公共处理（**宽度自适应**）
# ------------------------------------------------------------
# 三件事：
#   ① 清掉**渲染不出来的字符**（零宽 / 方向控制 / 孤立代理对 /
#      私用区 / 增补平面非 emoji）—— 卡片画不出来，直接去掉。
#   ② 按**显示宽度**算长度：中文 / 全角 / emoji = 2 格，英文数字 = 1 格；
#      emoji 的变体选择符 / ZWJ 序列算**一个**字符。
#   ③ 只有**真的会换行**时才用省略号 —— 宽度装得下就完整显示。
# ============================================================
#
# 榜单一行能放下的**显示宽度预算**（格）。
#   ★ 以前是「字符数 ≤ 10」这种死限制：短名字也被砍，
#     中文和英文还按同一个标准算 —— 两头都不对。
#   ★ 现在给的是渲染宽度预算：20 格 ≈ 10 个汉字 ≈ 20 个英文字母。
NICK_WIDTH = 20
# 窄列场景（榜单名次列之类）用这个
NICK_WIDTH_NARROW = 14

# 零宽字符 / 方向控制 / 孤立代理对（这些要删）
#   ★★ 1.7.7 修正：**不能**把 U+200D（ZWJ）和 U+FE0E / U+FE0F
#     （变体选择符）算进来 —— 它们是 emoji 的**结构字符**：
#       · 删掉 U+FE0F -> `⚔️` 退化成单色 `⚔`
#       · 删掉 U+200D -> `👨‍👩‍👧‍👦` 散成 4 个独立 emoji
#     以前的范围 `\u200b-\u200f` 和 `\ufe00-\ufe0f` 把这两个都误伤了。
_ZW_RE = re.compile(
    "[\u200b\u200c\u200e\u200f"
    "\u202a-\u202e\u2060-\u2064\u206a-\u206f"
    "\ufeff\ufe00-\ufe0d\ud800-\udfff]")
# 要**保留**的符号（emoji / 常见符号），清理前先摘出来
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF"
    "\u2600-\u27bf\u2b00-\u2bff\u2190-\u21ff\u2300-\u23ff"
    "\u20e3]")
# ★★ 1.7.7：**本机字体链实测缺字形**、渲染时只会画成方框的范围。
#   私用区（U+E000-F8FF）是最常见的重灾区（截图工具/输入法会塞进来），
#   增补私用区 A/B 同理；增补平面里**非 emoji** 的（音乐符号、
#   数学字母等）微软雅黑/符号/emoji 三套字体都没有字形。
_BAD_RE = re.compile(
    "[\ue000-\uf8ff"
    "\U000F0000-\U000FFFFD"
    "\U00100000-\U0010FFFD"
    "]")

# ------------------------------------------------------------------
# ★★ 1.7.7：**缺字形字符缓存**（会渲染成方框的那些）
#   渲染服务有精确探测（比对豆腐框位图指纹），插件问一次就缓存下来。
#   `set_glyph_probe()` 由 main.py 启动时注入探测器（避免这里反向依赖
#   输出模式模块）；探测失败/没注入时 `_GLYPH_CACHE` 为空，行为不变。
# ------------------------------------------------------------------
_GLYPH_CACHE = set()
_GLYPH_PROBE = None


def set_glyph_probe(fn) -> None:
    """注入「取缺字形字符集合」的探测器（签名：fn() -> set[str]）"""
    global _GLYPH_PROBE
    _GLYPH_PROBE = fn if callable(fn) else None


def refresh_glyph_cache(chars=None) -> set:
    """
    刷新缺字形缓存。

    · 传 `chars`（文本）时只问这些字符，并把结果**并入**缓存；
    · 不传则交给探测器自己决定（一般返回它收集到的那批）。
    返回当前缓存（集合）。
    """
    global _GLYPH_CACHE
    if _GLYPH_PROBE is None:
        return _GLYPH_CACHE
    try:
        got = _GLYPH_PROBE(chars)
        if got:
            _GLYPH_CACHE = set(_GLYPH_CACHE) | {str(c) for c in got if c}
    except Exception:
        pass
    return _GLYPH_CACHE


def glyph_cache() -> set:
    """当前已确认缺字形的字符集合（只读）"""
    return set(_GLYPH_CACHE)


def _char_units(text: str) -> list:
    """
    把文本切成「显示单元」—— 基字符 + 紧随的变体选择符 / ZWJ 序列。

    ★ 为什么要切：`⚔️` 是 `U+2694` + `U+FE0F` 两个码位，但**只占 1 格**；
      逐码位算宽度会把它当 2 个字符，截断时还可能在两者之间切断，
      渲染成「⚔ + 空白」（用户反馈过）。
    """
    out, buf = [], ""
    for c in text:
        o = ord(c)
        if o in (0xFE0F, 0xFE0E, 0x200D, 0x20E3):
            buf += c
        elif 0x1F3FB <= o <= 0x1F3FF and buf:
            buf += c                      # 肤色修饰符，跟在基 emoji 后面
        else:
            if buf.endswith("\u200d"):
                buf += c                  # ZWJ 后面的字要接上
            elif buf:
                out.append(buf)
                buf = c
            else:
                buf = c
    if buf:
        out.append(buf)
    return out


def _unit_name(u: str) -> str:
    """
    取一个「显示单元」的**基准名**（用于判重 / 合并 ZWJ 序列）。

    `👨‍👩‍👧‍👦`（4 个人 + 3 个 ZWJ）应视作**一个** emoji，
    而不是 4 个 —— 否则宽度算成 8 格，明明只占 2 格。
    """
    return u.split("\u200d")[0].split("\ufe0f")[0].split("\ufe0e")[0]


def display_width(s) -> int:
    """
    估算**显示宽度**：中文 / 全角 / emoji 算 2 格，英文数字算 1 格。

    ★ 口径和渲染端一致：一个汉字占 2 个西文宽，所以
      「最长的电影」(5 字 = 10 格) 和「Abcdefghij」(10 字母 = 10 格)
      占的宽度相同 —— 这才是「会不会换行」的正确判据。

    ★ ZWJ 序列（家庭 / 情侣 emoji）只算**一个** emoji 的宽度。
    """
    import unicodedata as _ud
    t = str(s or "")
    w = 0
    for u in _char_units(t):
        # ★ ZWJ 序列整体按「一个 emoji」算
        if "\u200d" in u:
            w += 2
            continue
        ch = u[0]
        o = ord(ch)
        if o in (0xFE0F, 0xFE0E, 0x200D, 0x20E3):
            continue                      # 孤立的修饰符不占位
        if _ud.category(ch) in ("Mn", "Me", "Cf", "Cc"):
            continue                      # 组合记号 / 控制符不占位
        if (o >= 0x1F000 or 0x2600 <= o <= 0x27BF
                or 0x2B00 <= o <= 0x2BFF or 0x2190 <= o <= 0x21FF
                or 0x2300 <= o <= 0x23FF):
            w += 2                        # emoji / 装饰符号按全角
        elif _ud.east_asian_width(ch) in ("W", "F"):
            w += 2
        else:
            w += 1
    return w


def truncate_width(s, max_w: int = NICK_WIDTH, ellipsis: str = "…") -> str:
    """
    按**显示宽度**截断：装得下就原样返回，超出才加省略号。

    ★ 这就是「只有真的会换行才省略」的核心 —— 不再用「字符数 > N」
      这种死限制，而是算渲染宽度。
    ★ 截断点落在「显示单元」边界上，不会把 `⚔️` 拆成 `⚔` + `️`。
    """
    t = str(s or "")
    try:
        mw = int(max_w)
    except Exception:
        mw = NICK_WIDTH
    if mw <= 0:
        return t
    if display_width(t) <= mw:
        return t
    _ew = display_width(ellipsis) or 1
    out, w = "", 0
    for u in _char_units(t):
        uw = display_width(u)
        if w + uw + _ew > mw:
            break
        out += u
        w += uw
    return (out.rstrip() or t[:1]) + ellipsis


def nick_display(s, limit: int = 0) -> str:
    """
    昵称显示：**先清掉渲染不出来的字符**，宽度装不下再用省略号。

    ★★ 1.7.7 重写：
      · 以前 `limit` 是**字符数**上限（默认 10），中文英文一视同仁 ——
        结果「最长的电影最长的电影」被砍到 10 字，而「Abcdefghij」
        也被砍到 10 字母，两者视觉宽度差一倍。
      · 现在按**显示宽度（格）**算，预算 `NICK_WIDTH`（20 格）。
        **装得下就完整显示**，只有真会换行才加省略号。
      · `limit` 仍可传「字符数」上限（老调用点传了具体值继续有效），
        传 0 / None 就只用宽度预算。
    """
    t = clean_display(s)
    if not t:
        return ""
    try:
        _lim = int(limit or 0)
    except Exception:
        _lim = 0
    if _lim > 0 and len(t) > _lim:
        return truncate_width(t, NICK_WIDTH_NARROW)
    return truncate_width(t, NICK_WIDTH)


def nick_display_narrow(s) -> str:
    """窄列显示名（榜单名次列）—— 宽度预算更小"""
    return truncate_width(clean_display(s), NICK_WIDTH_NARROW)


# ============================================================
# ★★ 1.7.7：排行榜「名次前缀」统一生成
# ------------------------------------------------------------
# 两个要点（都是用户反馈的）：
#   ① 前三名一律用奖牌图标 🥇🥈🥉，第 4 名起用数字；
#   ② 名次后面用**两个空格**——渲染端把「至少 2 个空白」当作列分隔，
#      于是「🥇 名字」和「4.  名字」会被排成**同一列**，
#      奖牌和数字的**左边缘自动对齐**，名字也都从同一 x 开始。
#      （只用一个空格不会分列，数字就会顶到最左边，和奖牌错开。）
# ============================================================
RANK_MEDALS = ("🥇", "🥈", "🥉")
# 名次与正文之间的分隔：**一个空格**。
#   ★★ 1.7.7：曾经用「两个空格」触发渲染端的列分割，结果奖牌与名字
#     之间空出一大截（渲染端按图标列宽 + 列间距排）。现在改回一个空格，
#     渲染端用「统一标签墨迹宽 + 小间距」的算法对齐 —— 既紧又齐。
RANK_GAP = " "


def rank_tag(i: int, medals=None, gap: str = RANK_GAP) -> str:
    """
    第 `i` 名的名次前缀（1 起）：前三名奖牌，其余「N.」。

    返回**已带分隔符**的字符串，直接拼正文即可：
        rank_tag(1) + "小明"  ->  "🥇  小明"（渲染成两列，左边缘对齐）
    """
    try:
        n = int(i)
    except Exception:
        n = 0
    med = tuple(medals or RANK_MEDALS)
    if 1 <= n <= len(med):
        return f"{med[n - 1]}{gap}"
    return f"{n}.{gap}"


def clean_display(s) -> str:
    """
    清掉「渲染不出来的字符」，只保留能正常显示的。

    ★★ 1.7.6：群昵称里常混进从别处复制来的零宽字符、方向控制符、
      孤立代理对（半个 emoji）、私用区字符 —— 渲染成图片时要么变方框、
      要么把整行排版搞乱。这里**直接去掉**这些字符（不显示成问号）。

    实现（三步）：
      ① 要保留的符号（emoji 等）换成**可打印的唯一标记**
         `U+E000 + chr(0xE100+i) + U+E000`（私用区，正常字符不会撞上）；
      ② 逐字符过滤：正常可打印字符留下；标记**放行**；
         其它私用区杂字、零宽、方向控制全部删掉；
      ③ 标记换回原符号。

    ★★ 1.7.7：进过滤之前先 `_BAD_RE` 干掉「字体链肯定没字形」的范围
      （私用区 / 增补平面非 emoji）—— 这些 `isprintable()` 是 True，
      靠第 ② 步的通用过滤拦不住，会一路渲染成**方框**。

    ★★ 1.7.7：再查一遍**缺字形缓存**（`set_glyph_probe()` 注入的探测
      结果）—— 区间猜不到的「真没字形」字符也在这一步被去掉。
    """
    t = str(s or "")
    if not t:
        return ""
    # ★ 先干掉「字体链肯定画不出」的字符（方框重灾区）
    try:
        t = _BAD_RE.sub("", t)
    except Exception:
        pass
    # ★★ 缺字形字符（渲染服务精确探测过的那批）直接去掉
    if _GLYPH_CACHE and t:
        try:
            t = "".join(ch for ch in t
                        if ch not in _GLYPH_CACHE or ch == "\n")
        except Exception:
            pass
    _keep = []
    _PH = "\ue000"

    def _stash(m):
        _keep.append(m.group(0))
        return _PH + chr(0xE100 + len(_keep) - 1) + _PH

    try:
        # ① 保留符号 -> 标记
        t = _EMOJI_RE.sub(_stash, t)
        # ② 去零宽/方向控制
        t = _ZW_RE.sub("", t)
        # ③ 逐字符过滤：只放行「空格 / 可打印 / 我们的标记」
        #    标记是 U+E000 + U+E1xx + U+E000 三段，单看每段都在私用区；
        #    这里用「是否属于合法标记」来判断，而不是放行整个私用区。
        _valid = set()
        for _i in range(len(_keep)):
            _valid.add(_PH + chr(0xE100 + _i) + _PH)
        out = []
        i = 0
        while i < len(t):
            _hit = None
            for _v in _valid:
                if t.startswith(_v, i):
                    _hit = _v
                    break
            if _hit:
                out.append(_hit)
                i += len(_hit)
                continue
            ch = t[i]
            if ch == " " or ch.isprintable():
                out.append(ch)
            i += 1
        t = "".join(out)
        # ④ 标记换回原符号
        for _i, _v in enumerate(
                [_PH + chr(0xE100 + k) + _PH for k in range(len(_keep))]):
            t = t.replace(_v, _keep[_i])
    except Exception:
        # 清理失败就用原串（绝不因为昵称把整条输出搞挂）
        return re.sub(r"\s+", " ", str(s or "")).strip()
    # ★ 只压**空白**，不要用 `.split()` —— 它会把 emoji 序列按 ZWJ 拆开
    return re.sub(r"\s+", " ", t).strip()


def mount_image_path(name: str, base_dir: str = "") -> str:
    """
    按「坐骑名称」在素材目录里找同名图片（和小鸟图鉴同一套逻辑）。

    支持：
      · 纯名称      赤兔       -> 找 赤兔.png / 赤兔.jpg / ...
      · 带扩展名    赤兔.png
      · 绝对路径    D:\\MemeAPI\\car\\赤兔.png
    找不到返回 ""。
    """
    raw = str(name or "").strip().strip('"').strip("'")
    if not raw:
        return ""
    root = str(base_dir or "").strip() or DEFAULT_MOUNT_IMG_DIR
    # ① 绝对路径直接判存在
    if os.path.isabs(raw) and os.path.isfile(raw):
        return raw
    safe = os.path.basename(raw.replace("/", os.sep).replace("\\", os.sep))
    if not safe:
        return ""
    if not os.path.isdir(root):
        return ""
    # ② 带扩展名
    p = os.path.join(root, safe)
    if os.path.isfile(p):
        return p
    # ③ 只有名称：挨个扩展名试（大小写不敏感）
    stem = os.path.splitext(safe)[0]
    try:
        entries = os.listdir(root)
    except Exception:
        entries = []
    lower = {fn.lower(): fn for fn in entries}
    for ext in MOUNT_IMAGE_EXTS:
        hit = lower.get((stem + ext).lower())
        if hit:
            return os.path.join(root, hit)
    return ""


def render_greet(tpl: str, kv: dict) -> str:
    """
    渲染「登场提示」这类带占位符的文案。

    ★ 同时支持 `$名字` 和 `{名字}` 两种写法；未提供的占位符原样保留。
    """
    out = str(tpl or "")

    def _d(m):
        return str(kv.get(m.group(1), m.group(0)))

    out = re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", _d, out)

    def _b(m):
        return str(kv.get(m.group(1), m.group(0)))

    out = re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", _b, out)
    return out



def plugin_dir() -> str:
    """当前插件根目录"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ============================================================
# 指令「关键词 + 参数」解析（1.7.6）
# ------------------------------------------------------------
# ★ 空格可有可无：`坐骑查看 赤兔` 和 `坐骑查看赤兔` 都认。
#   所有带参数的指令都走这里，统一行为。
# ============================================================
# ============================================================
# ★★ 1.7.6：「紧挨着的参数」长度上限。
#   为什么是 64：长英文歌名（`six forty seven` 15 字、
#   `yesterday once more` 20 字）以前被 12 字上限挡掉，
#   导致 `点歌six forty seven` 匹配不上任何分支、静默无反应。
#   64 足够容纳正常歌名/名字，又能挡掉「整段话被误当参数」。
ARG_MAX_CHARS = 64

# ============================================================
# 全局「已知指令名」登记表（1.7.6）
# ------------------------------------------------------------
# ★ 用途：不带空格时判断「紧挨着的这段到底是不是参数」。
#   例：别名 `坐骑` + 输入 `坐骑查看赤兔`
#       -> 「查看赤兔」以已知指令 `坐骑查看` 开头，说明这不是参数，
#          于是 `坐骑` 这个别名不算命中，交给 `坐骑查看` 处理。
#   由 checkin 模块每次构造 / reload 时自动登记。
#
# ★ 为什么用 sys.modules 存：万一这个模块被加载成多份副本
#   （测试里 `spec_from_file_location` 会这样），登记表仍是
#   全进程唯一的一份，不会出现「这边登记了那边看不到」。
# ============================================================
_REG_KEY = "__apix_known_cmd_names__"

# ★★ 1.7.6：可组合的**音源前缀**（音乐指令专用）。
#   `QQ点歌` / `网易搜歌` 这类是「音源名 + 基础指令名」拼出来的，
#   逐个登记既啰嗦又容易漏（音源别名太多）。
#   这里登记前缀名，`_starts_with_known_cmd` 再按
#   「前缀 + 已登记指令名」组合识别。
_REG_SRC_KEY = "__apix_cmd_src_prefixes__"

_SRC_PREFIX_DEFAULT = ("qq", "netease", "qq音乐", "网易", "网易云", "wy",
                       "kugou", "kuwo", "migu", "qianqian",
                       "酷狗", "酷我", "咪咕", "千千", "千千音乐")


def _src_store() -> set:
    """拿到全进程唯一的「音源前缀」集合"""
    m = sys.modules.get(_REG_SRC_KEY)
    if m is None:
        m = type(sys)(_REG_SRC_KEY)
        m.names = set(_SRC_PREFIX_DEFAULT)
        sys.modules[_REG_SRC_KEY] = m
    return m.names


def _reg_store() -> set:
    """拿到全进程唯一的指令名集合"""
    m = sys.modules.get(_REG_KEY)
    if m is None:
        m = type(sys)(_REG_KEY)
        m.names = set()
        sys.modules[_REG_KEY] = m
    return m.names


def register_cmd_names(names) -> int:
    """登记一批已知指令名（可反复调用，只增不减）"""
    store = _reg_store()
    n = 0
    for x in (names or []):
        s = str(x or "").strip().lstrip("/")
        if s and s not in store:
            store.add(s)
            n += 1
    return n


def known_cmd_names():
    """当前已登记的指令名（拷贝）"""
    return set(_reg_store())


def _starts_with_known_cmd(rest: str) -> bool:
    """
    这段文字是不是「另一条已知指令」的残片。

    命中任一条就算：
      · 这段本身就是一条指令      `查看坐骑`
      · 这段**以某指令开头**      `查看坐骑赤兔` -> 以 `查看坐骑` 开头
      · 某指令**以这段结尾**      `商店`         -> `坐骑商店` 以 `商店` 结尾
      · 某指令**完整出现在这段里** `查看测试坐骑` -> 含 `查看坐骑`
        （「坐骑 + 查看XX坐骑」被拆开了）

    只要命中，就说明这不是参数，而是别人家的指令被截了。
    """
    s = str(rest or "").strip()
    if not s:
        return False
    store = _reg_store()
    if s in store:
        return True
    for nm in store:
        if not nm or nm == s:
            continue
        if s.startswith(nm) or nm.endswith(s):
            return True
    # ★ 嵌入判断放在最后，且要求命中的指令名够长，
    #   否则短名（如别名 `坐骑`）会把正常参数全挡掉。
    for nm in store:
        if len(nm) < 3 or nm == s:
            continue
        if nm in s:
            return True
    # ★★ 1.7.6：组合形式「音源前缀 + 指令名」
    #   （`QQ点歌` / `qq搜歌` …），前缀表是动态的。
    #   ★ 音源别名大小写不敏感（`QQ点歌` 和 `qq点歌` 都要认）。
    _s_low = s.lower()
    for _p in _src_store():
        _p = str(_p or "")
        if not _p or not _s_low.startswith(_p.lower()):
            continue
        _rest = s[len(_p):]
        if not _rest:
            return True
        if _rest in store:
            return True
        for nm in store:
            if nm and _rest.startswith(nm):
                return True
    return False


def _looks_like_arg(rest: str) -> bool:
    """
    紧挨着的这段文字「像不像参数」。

    ★ 为什么需要：不加空格后 `坐骑商店` 会被
      「我的坐骑」的别名 `坐骑` 当成参数 `商店` 吃掉；
      `坐骑查看赤兔` 也会被 `坐骑` 吃掉，导致「坐骑查看」失效。

    规则：
      1. 超长（> 上限）-> 不是参数（见下面的说明）
      2. 以**另一条已知指令**开头 -> 不是参数
         （`查看赤兔` / `商店` / `列表` -> 说明这是别人家的指令）
      3. 其余都当参数（数字、页码、@某人、中文名、歌名…）

    ★★ 1.7.6 修正：长度上限从 **12 提到 64**。
      原来 12 字上限把**长英文歌名**全挡掉了：
        `点歌six forty seven` -> 参数 `six forty seven`（15 字）被拒
        -> 整条指令**匹配不上任何分支** -> 用户发出去毫无反应。
      英文歌名动辄十几二十个字符，12 实在太小。
      提到 64 后 `点歌Shape of You`（12）/`点歌as it was`/长歌名都能用；
      而真正需要防的「分不清是哪条指令」由规则 2/3 兜底，
      它们只看「是不是以别的指令开头」，与长度无关。
    """
    s = str(rest or "").strip()
    if not s:
        return False
    if len(s) > ARG_MAX_CHARS:
        return False
    if _starts_with_known_cmd(s):
        return False
    # ★★ 1.7.6：以**音源前缀**开头（`QQ不要说话` / `网易…`）也不是参数 ——
    #   说明用户想打「QQ点歌 歌名」，只是把指令名打反了/漏了。
    _s_low = s.lower()
    for _p in _src_store():
        _p = str(_p or "")
        if _p and _s_low.startswith(_p.lower()):
            return False
    return True


def cmd_arg(text: str, names):
    """
    匹配「关键词 + 参数」，**空格可有可无**。

        names = ["坐骑查看", "查看坐骑"]
        "坐骑查看 赤兔"  -> "赤兔"
        "坐骑查看赤兔"    -> "赤兔"
        "坐骑查看"       -> ""      （只有关键词，没参数）
        "坐骑查看赤兔啊"  -> "赤兔啊"
        "别的东西"       -> None    （没命中）

    返回：参数（字符串，可能为空串）或 None。

    ★ 为什么要有这个：用户经常不敲空格，
      以前 `text.startswith(name + " ")` 只认带空格的写法。

    ★ 紧挨着的参数（没空格）会再问一次 `_looks_like_arg()`，
      避免 `坐骑商店` 被别名 `坐骑` 吃掉。

    ★ 带空格的写法**永远认**（用户明确打了空格，就是想要参数）。
    """
    if not text:
        return None
    t = str(text).strip()
    if not t:
        return None
    for raw in (names or []):
        name = str(raw or "").strip()
        if not name:
            continue
        for _p in (name, "/" + name):
            if not t.startswith(_p):
                continue
            rest = t[len(_p):]
            if not rest:
                return ""           # 只有关键词
            # 带空格的参数：`坐骑查看 赤兔` —— 参数就是空格后面那段
            if rest[0].isspace():
                _a = rest.strip()
                if not _a:
                    return ""       # 只有关键词 + 空格 -> 没参数
                # ★ 但「空格的另一边是别人家的指令」时不算命中：
                #   `坐骑 查看 测试坐骑` -> 「查看 测试坐骑」以 `坐骑查看`
                #   相关指令开头，说明这是「坐骑查看 测试坐骑」被拆开。
                #
                # ★★ 1.7.6 修正：这里改成**精确匹配**已知指令名才拒绝。
                #   原来用「以已知指令**开头**」判断，太激进：
                #   已注册指令里有 `工种`，于是
                #       `打工 工种1` -> 首段 `工种1` 以 `工种` 开头 -> 被拒
                #   结果**凡是以指令名开头的数据名都用不了**
                #   （工种/坐骑/宠物…名字里带「工种」两字就废）。
                #   真正的歧义只有一种：空格右边**整段就是一个指令名**，
                #   那才可能是「长指令被空格拆开」。精确比即可，
                #   上面那条 `坐骑 查看` 的修复依然有效。
                _known = known_cmd_names()
                if _a in _known:
                    continue
                _first = _a.split()[0] if _a.split() else ""
                if _first and _first in _known and _first != _a:
                    continue
                return _a
            # 紧挨着的参数：`坐骑查看赤兔`（要像参数）
            if _looks_like_arg(rest):
                return rest.strip()
            # 不像参数 -> 这个别名不算命中，试下一个
            continue
    return None


def _find_astrbot_root() -> str:
    """定位 AstrBot 根目录（仅用于确定 data/ 的父级，不用于直接写数据）"""
    try:
        import astrbot
        pkg_dir = os.path.dirname(os.path.abspath(astrbot.__file__))
        root = os.path.dirname(pkg_dir)
        if os.path.isdir(os.path.join(root, "data")):
            return root
        root2 = os.path.dirname(root)
        if os.path.isdir(os.path.join(root2, "data")):
            return root2
    except Exception:
        pass
    cur = plugin_dir()
    for _ in range(6):
        # 优先认 data/plugin_data（新规范），其次兼容老的 data/config
        if (os.path.isdir(os.path.join(cur, "data", "plugin_data"))
                or os.path.isdir(os.path.join(cur, "data", "config"))):
            return cur
        cur = os.path.dirname(cur)
    return os.getcwd()


# 旧版本的数据目录（data/config），仅用于一次性迁移
def _legacy_cfg_dir() -> str:
    return os.path.join(_find_astrbot_root(), "data", "config")


# ★ 规范要求：插件持久化数据统一放在 data/plugin_data/<插件名>/
def _plugin_data_dir() -> str:
    """
    返回本插件的数据目录，并确保存在。
    优先使用 AstrBot 提供的接口，取不到时按规范路径自行推导。
    """
    candidates = []

    # ① AstrBot 4.x 提供的接口
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path  # type: ignore
        p = get_astrbot_data_path()
        if p:
            candidates.append(os.path.join(str(p), "plugin_data", PLUGIN_ID))
    except Exception:
        pass
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path  # type: ignore
        p = get_astrbot_plugin_data_path()
        if p:
            candidates.append(str(p))
    except Exception:
        pass

    # ② 按规范路径推导
    candidates.append(
        os.path.join(_find_astrbot_root(), "data", "plugin_data", PLUGIN_ID)
    )

    for path in candidates:
        try:
            os.makedirs(path, exist_ok=True)
            return path
        except Exception:
            continue

    # ③ 兜底：插件目录下的 data/（极端情况下也不能丢数据）
    fallback = os.path.join(plugin_dir(), "data")
    os.makedirs(fallback, exist_ok=True)
    return fallback


# 迁移只跑一次的标记
_MIGRATED = [False]


def _migrate_legacy_data():
    """
    把旧位置（data/config 与 data/backups）里的本插件数据迁移到新目录。
    只在目标文件不存在时搬运，绝不覆盖已有数据；搬运成功后保留原文件不删除。
    """
    if _MIGRATED[0]:
        return
    _MIGRATED[0] = True
    try:
        target = _plugin_data_dir()
        legacy = _legacy_cfg_dir()
        if not os.path.isdir(legacy):
            return
        moved = 0
        for name in (
            PLUGIN_CONFIG_FILENAME,
            PLUGIN_FORTUNE_DATA_FILENAME,
            PLUGIN_HUSBAND_DATA_FILENAME,
            PLUGIN_LUCK_DATA_FILENAME,
            PLUGIN_GREETING_DATA_FILENAME,
            PLUGIN_MINECRAFT_DATA_FILENAME,
            PLUGIN_CHECKIN_DATA_FILENAME,
            PLUGIN_HOURLY_CHIME_DATA_FILENAME,
            PLUGIN_STATUS_PUSH_DATA_FILENAME,
            PLUGIN_DAILY_NEWS_DATA_FILENAME,
            PLUGIN_NICKNAME_DATA_FILENAME,
    PLUGIN_SPEAK_STATS_DATA_FILENAME,
    PLUGIN_PET_DATA_FILENAME,
    PLUGIN_DATA_STORE_FILENAME,
        ):
            src = os.path.join(legacy, name)
            dst = os.path.join(target, name)
            if not os.path.isfile(src) or os.path.exists(dst):
                continue
            try:
                with open(src, "rb") as f:
                    blob = f.read()
                tmp = dst + ".migrate.tmp"
                with open(tmp, "wb") as f:
                    f.write(blob)
                os.replace(tmp, dst)
                moved += 1
            except Exception:
                continue
        if moved:
            try:
                from astrbot.api import logger
                logger.info(
                    f"[{PLUGIN_ID}] 已把 {moved} 个数据文件迁移到 plugin_data 目录：{target}"
                )
            except Exception:
                pass
    except Exception:
        pass


def _cfg_dir() -> str:
    """本插件数据目录（data/plugin_data/<插件名>/）"""
    _migrate_legacy_data()
    return _plugin_data_dir()


def astrbot_panel_config_path() -> str:
    """
    AstrBot 面板配置路径（data/config/<插件名>_config.json）。

    ★ 和 plugin_data 那份是**两个文件**：面板注册的新配置项只写在面板那份里，
      插件侧要用就得直读这个文件兜底。
    """
    try:
        root = _find_astrbot_root()
        p = os.path.join(root, "data", "config", PLUGIN_CONFIG_FILENAME)
        return p if os.path.isfile(p) else ""
    except Exception:
        return ""


def read_astrbot_panel_config() -> dict:
    """直读 AstrBot 面板配置（读不到返回 {}）"""
    try:
        import json
        p = astrbot_panel_config_path()
        if not p:
            return {}
        with open(p, encoding="utf-8-sig") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def config_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_CONFIG_FILENAME)


def fortune_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_FORTUNE_DATA_FILENAME)


def husband_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_HUSBAND_DATA_FILENAME)


def luck_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_LUCK_DATA_FILENAME)


def greeting_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_GREETING_DATA_FILENAME)


def minecraft_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_MINECRAFT_DATA_FILENAME)


def checkin_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_CHECKIN_DATA_FILENAME)


def hourly_chime_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_HOURLY_CHIME_DATA_FILENAME)


def status_push_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_STATUS_PUSH_DATA_FILENAME)


def daily_news_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_DAILY_NEWS_DATA_FILENAME)


def nickname_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_NICKNAME_DATA_FILENAME)


def speak_stats_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_SPEAK_STATS_DATA_FILENAME)


def pet_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_PET_DATA_FILENAME)


def rps_data_path() -> str:
    """猜拳数据文件"""
    return os.path.join(_cfg_dir(), PLUGIN_RPS_DATA_FILENAME)


def guess_data_path() -> str:
    """★ 1.7.7：猜数游戏数据文件"""
    return os.path.join(_cfg_dir(), PLUGIN_GUESS_DATA_FILENAME)


def msg_stats_path() -> str:
    """★ 1.7.7：收发消息计数文件（落盘，重载插件不归零）"""
    return os.path.join(_cfg_dir(), PLUGIN_MSG_STATS_FILENAME)


def bird_data_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_BIRD_DATA_FILENAME)


def racing_data_path() -> str:
    """赛车数据文件路径（市场版 1.1 新增）"""
    return os.path.join(_cfg_dir(), PLUGIN_RACING_DATA_FILENAME)


BIRD_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")


def bird_image_path(name: str, base_dir: str = "") -> str:
    """
    按「小鸟昵称」在素材目录里找同名图片。

    支持：
      · 纯昵称      仓鸮      -> 找 仓鸮.png / 仓鸮.jpg / ...
      · 带扩展名    仓鸮.png
      · 绝对路径    D:\\MemeAPI\\bird\\仓鸮.png
    找不到返回 ""。
    """
    raw = str(name or "").strip().strip('"').strip("'")
    if not raw:
        return ""
    root = str(base_dir or "").strip()
    # ① 绝对路径直接判存在
    if os.path.isabs(raw) and os.path.isfile(raw):
        return raw
    safe = os.path.basename(raw.replace("/", os.sep).replace("\\", os.sep))
    if not safe:
        return ""
    dirs = [d for d in (root,) if d and os.path.isdir(d)]
    for d in dirs:
        # ② 带扩展名
        p = os.path.join(d, safe)
        if os.path.isfile(p):
            return p
        # ③ 只有昵称：挨个扩展名试（大小写不敏感）
        stem = os.path.splitext(safe)[0]
        try:
            entries = os.listdir(d)
        except Exception:
            entries = []
        lower = {fn.lower(): fn for fn in entries}
        for ext in BIRD_IMAGE_EXTS:
            hit = lower.get((stem + ext).lower())
            if hit:
                return os.path.join(d, hit)
    return ""


def data_store_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_DATA_STORE_FILENAME)


def read_plugin_version(star_obj=None) -> str:
    """读取插件版本号（优先 metadata → star 对象属性 → yaml）"""
    if star_obj is not None:
        for attr in ("metadata", "star_meta", "meta", "plugin_metadata"):
            try:
                meta = getattr(star_obj, attr, None)
                if meta is None:
                    continue
                v = (
                    getattr(meta, "version", None)
                    or getattr(meta, "plugin_version", None)
                    or getattr(meta, "ver", None)
                )
                if v:
                    return str(v).strip()
                if isinstance(meta, dict):
                    v = meta.get("version") or meta.get("plugin_version")
                    if v:
                        return str(v).strip()
            except Exception:
                pass

    try:
        import yaml
        path = os.path.join(plugin_dir(), "metadata.yaml")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8-sig") as f:
                data = yaml.safe_load(f) or {}
            v = data.get("version")
            if v:
                return str(v).strip()
    except Exception:
        pass

    return "未知"


def read_disk_config() -> dict:
    """读取插件磁盘配置，失败返回 {}"""
    path = config_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return {}


def parse_gid_list(raw) -> list:
    """
    解析后台填写的群号列表，返回去重后的字符串列表（保持填写顺序）。
    支持换行 / 英文逗号 / 中文逗号 / 空格 / 顿号分隔，忽略非数字内容。
    """
    if raw is None:
        return []
    text = str(raw)
    if not text.strip():
        return []
    out, seen = [], set()
    for part in re.split(r"[\s,，、;；]+", text):
        gid = part.strip()
        if not gid or not gid.isdigit():
            continue
        if gid in seen:
            continue
        seen.add(gid)
        out.append(gid)
    return out


def write_disk_config(data: dict) -> bool:
    """原子写入插件磁盘配置"""
    path = config_path()
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return True
    except Exception:
        return False