# ============================================================
# 菜单渲染辅助
# 标题栏统一为 ━━━ 标题 ━━━（每侧 3 个 ━），页脚为等宽色条。
#
# 关于对齐：emoji 在 QQ 等客户端里通常按双宽渲染，因此下面用「emoji + 全角空格」
# 来对齐命令名。不同客户端字体对 emoji 宽度处理可能不同，若某处不齐属正常现象。
# ============================================================

# ★★ 市场版：音乐模块已移除。
#   但 core/music.py 已删除，所以这里改成**本地兜底实现**
#   （避免 import 失败，也避免 try 块变空导致语法错误）。
def source_label(code):
    """音源代码 -> 中文名（音乐功能已移除，这里只做原样返回）"""
    return str(code or "")


# ── 菜单排版参数（照参考图）──
BAR_N = 8              # 标题两侧横线段数
BAR_CH = "─"           # 标题横线（细）
FOOT_CH = "━"          # 收尾横线（粗）
FOOT_W = 36            # 收尾横线半角宽度


# ============================================================
# 图标与文字之间补一个空格（1.7.6）
# ------------------------------------------------------------
# 以前菜单写成 `🐦今日小鸟`，图标和文字挤在一起。
# 这里统一做一遍后处理，所有菜单（包括后台可自定义文案）都会生效，
# 不用去改几十处 f-string。
# ============================================================
def _icon_space_line(line: str) -> str:
    """行首图标后补一个半角空格（已经有空格 / 没有图标则原样返回）"""
    s = str(line or "")
    if not s:
        return s
    # 保留原来的前导空白
    _i = 0
    while _i < len(s) and s[_i] in " \t\u3000":
        _i += 1
    _lead = s[:_i]
    rest = s[_i:]
    if not rest:
        return s
    try:
        import unicodedata as _ud
    except Exception:
        return s
    # 吃掉行首的「图标 + 修饰符 + 已有空格」
    # ★★ 1.7.7 修正：以前只吃 So/Sk/Cf，**漏了变体选择符** ——
    #   `⚔️` = U+2694 (So) + U+FE0F (Mn)，`️` 不是 So/Sk/Cf 于是循环
    #   在它前面就停了，空格被插进 `⚔` 和 `️` 中间 ->
    #   渲染成「⚔ ️启用武器…」（用户看到的断字）。
    #   现在把变体选择符 / 零宽连接符 / 组合记号一起算作图标的一部分。
    _MOD = ("\ufe0e", "\ufe0f", "\u200d", "\u200b")
    _p = 0
    _saw = False
    while _p < len(rest):
        ch = rest[_p]
        if ch in " \t\u3000":
            # 图标后面已经有空格 -> 不用补
            return s
        if ch in _MOD or _ud.category(ch) in ("So", "Sk", "Cf", "Mn", "Me"):
            _saw = True
            _p += 1
            continue
        break
    if not _saw or _p >= len(rest):
        return s
    # ★ 结尾若落在修饰符上，说明图标还没接完（防「⚔ + 空格 + ️」）
    while _p < len(rest) and rest[_p - 1] in _MOD \
            and _ud.category(rest[_p]) in ("So", "Sk", "Mn", "Me"):
        _p += 1
    return _lead + rest[:_p] + " " + rest[_p:]


def _icon_space_rows(rows):
    """对一批行做「图标后补空格」"""
    return [_icon_space_line(x) for x in (rows or [])]


def _icon_space_text(text: str) -> str:
    """对整段多行文本做「图标后补空格」"""
    return "\n".join(_icon_space_line(x) for x in str(text or "").split("\n"))


def _sn(plugin) -> str:
    """积分显示名（后台可自定义，如「金币」）；默认「积分」"""
    for mod_name in ("checkin_module", "pet_module"):
        mod = getattr(plugin, mod_name, None)
        if mod is None:
            continue
        nm = str(getattr(mod, "score_name", "") or "").strip()
        if nm:
            return nm
    nm = str(getattr(plugin, "score_name", "") or "").strip()
    return nm or "积分"


# ★★ 1.7.6：标题前缀由后台「菜单指令 → 全局标题前缀」统一控制，
#   这里**动态取**（不要用模块级常量快照，否则改了前缀菜单不跟着变）。
try:
    from .path_utils import TITLE_PREFIX as _TITLE_PREFIX_FALLBACK
except Exception:
    try:
        from path_utils import TITLE_PREFIX as _TITLE_PREFIX_FALLBACK
    except Exception:
        _TITLE_PREFIX_FALLBACK = "铁剑娘系统："


def _current_title_prefix() -> str:
    """取**当前**统一标题前缀（后台可改；空串 = 不要前缀）"""
    try:
        from . import path_utils as _pu
    except Exception:
        try:
            import path_utils as _pu
        except Exception:
            return _TITLE_PREFIX_FALLBACK
    return getattr(_pu, "TITLE_PREFIX", _TITLE_PREFIX_FALLBACK)


# 兼容旧引用（已不再作为唯一来源，仅兜底）
BAR_PREFIX = _TITLE_PREFIX_FALLBACK


def _ck_score_min(plugin) -> int:
    """签到随机积分下限（后台 checkin_score_min）"""
    mod = getattr(plugin, "checkin_module", None)
    try:
        return max(1, int(getattr(mod, "score_min", 1)))
    except Exception:
        return 1


def _ck_score_max(plugin) -> int:
    """签到随机积分上限（后台 checkin_score_max）"""
    mod = getattr(plugin, "checkin_module", None)
    try:
        return max(1, int(getattr(mod, "score_max", 1000)))
    except Exception:
        return 1000


# ★★ 1.7.7：商店帮助每页多少条（用户要求分页）
SHOP_HELP_PAGE_SIZE = 10


def _pg(page) -> int:
    """把页码参数转成合法页码（非法值一律当第 1 页）"""
    try:
        return max(1, int(str(page).strip() or 1))
    except Exception:
        return 1


def _fmt(v) -> str:
    """数值显示：15.0 -> 15 ；7.5 -> 7.5（和坐骑加成一致的风格）"""
    try:
        f = float(v)
    except Exception:
        return str(v)
    return str(int(round(f))) if abs(f - round(f)) < 1e-9 else f"{f:g}"


def _bar(title: str) -> str:
    """
    菜单标题 —— **独立一行**，不带任何横线。

    输出**两行**：`{前缀}主菜单` + 一条分隔线

    ★以前是 `──────── 标题 ────────`，标题和横线在同一行，
      文字宽度和横线长度不匹配就会看起来「重合」。
      改成「标题独立成行 + 分隔线」后结构清晰：
          {前缀}主菜单
          ━━━━━━━━━━━━━━━━━━
          🎭功能A    ⛏️功能B
          ━━━━━━━━━━━━━━━━━━

    ★ 前缀**跟随全局配置**（后台「菜单指令 → 全局标题前缀」），
      所以这里动态取，不用模块级常量快照。
    """
    t = str(title or "").strip()
    # ★ 动态取当前前缀（后台可改；空串 = 不要前缀）
    _pfx = _current_title_prefix()
    if _pfx and not t.startswith(_pfx):
        t = f"{_pfx}{t}"
    # ★ 标题下面固定跟一条分隔线。
    #   以前分隔线由 _grid/_finish 另外加，导致直接用
    #   `"\n".join([_bar(...), 内容, _bar_plain()])` 的菜单漏了这条线。
    #   放进 _bar 里，所有菜单一次统一。
    return t + "\n" + FOOT_CH * 20


def _seg_bar(ch: str, n: int, seg: int = 4) -> str:
    """
    把长横线切成「每段 seg 个 + 1 空格」。

    ★渲染器按「最长单元格」算列宽：标题/收尾线若是一整条长横线，
      第一列会被撑到 400+px，第二列直接推到画布外（右列内容看不见）。
      切成短段后列宽由正常菜单项决定，就不会溢出。
    """
    parts = [ch * seg] * max(1, n // seg)
    if n % seg:
        parts.append(ch * (n % seg))
    return " ".join(parts)


def _bar_plain(total: int = 0) -> str:
    """收尾横线（统一宽度，托住整个菜单）"""
    return FOOT_CH * (total or FOOT_W)


_CJK_FONT = r"C:\Windows\Fonts\msyh.ttc"
_EMOJI_FONT = r"C:\Windows\Fonts\seguiemj.ttf"
_SYM_FONT = r"C:\Windows\Fonts\seguisym.ttf"
_FONT_CHAIN = (_CJK_FONT, _SYM_FONT, _EMOJI_FONT)
_EMOJI_CHAIN = (_EMOJI_FONT, _SYM_FONT, _CJK_FONT)
_TW_CACHE = {}


def _is_emoji(ch: str) -> bool:
    """
    是否按 emoji 处理。

    ★范围要卡准：制表符 / 框线（U+2500~U+257F）、几何图形（U+25A0~U+25FF）
      都不是 emoji，它们雅黑里有字形、宽度也只有半角。
      之前把 U+2500 段误判成 emoji，导致「━」被按字号 20 算（实际 12），
      收尾横线就跟着算短了。
    """
    if not ch:
        return False
    o = ord(ch)
    if o in (0xFE0F, 0xFE0E, 0x20E3):
        return True
    if 0x1F000 <= o <= 0x1FAFF:        # 主要 emoji 区
        return True
    if 0x2700 <= o <= 0x27BF:          # 装饰符号（✂✅等）
        return True
    if 0x2B00 <= o <= 0x2BFF:          # 箭头 / 星形
        return True
    if 0x1F1E6 <= o <= 0x1F1FF:        # 区域指示符（国旗）
        return True
    return False


def _font_for(ch: str, size: int):
    """按渲染端同一套字体链挑字体（先 emoji 再中文）"""
    from PIL import ImageFont
    chain = _EMOJI_CHAIN if _is_emoji(ch) else _FONT_CHAIN
    for path in chain:
        key = (path, size)
        f = _TW_CACHE.get(key)
        if f is None:
            try:
                f = ImageFont.truetype(path, size)
            except Exception:
                f = None
            _TW_CACHE[key] = f
        if f is None:
            continue
        try:
            if f.getmask(ch).getbbox() is not None:
                return f
        except Exception:
            return f
    try:
        return ImageFont.load_default()
    except Exception:
        return None


def _tw(text: str, size: int = 20) -> float:
    """
    文本渲染宽度（像素）—— 逐字符挑字体，和渲染端口径一致。

    emoji 走表情字体、汉字走雅黑，所以比「全角算 2」准得多。
    """
    key = (text, size)
    hit = _TW_CACHE.get(key)
    if hit is not None and isinstance(hit, float):
        return hit
    total = 0.0
    for ch in str(text or ""):
        w = None
        if _is_emoji(ch):
            # ★emoji 用表情字体直接量（渲染端也是这么画的）
            try:
                from PIL import ImageFont
                f = _TW_CACHE.get((_EMOJI_FONT, size))
                if f is None:
                    f = ImageFont.truetype(_EMOJI_FONT, size)
                    _TW_CACHE[(_EMOJI_FONT, size)] = f
                w = float(f.getlength(ch))
            except Exception:
                w = None
            # 表情字体量出来常常偏小，取「字号」作为下界更稳
            if not w or w < size * 0.9:
                w = float(size)
        if w is None:
            f = _font_for(ch, size)
            try:
                w = float(f.getlength(ch)) if f is not None else float(size)
            except Exception:
                w = float(size)
        total += w
    _TW_CACHE[key] = total
    return total


def _bar_plain_for(title: str) -> str:
    """与标题栏等宽的收尾横线"""
    return "━" * (len(str(title or "")) + 6)


def _foot_bar(lines) -> str:
    """
    收尾横线（固定合理长度）。

    ★精确对齐交给**渲染端**：`render_card` 会把「整行都是横线」的行
      按实际内容宽度重算长度，所以这里只要给个不离谱的数就行。
      之前想在插件侧估算内容像素宽，emoji / 全角标点一多就偏
      （实测差 -67 ~ +127px），反而不如交给渲染端。
    """
    return FOOT_CH * FOOT_W


def _sv(v, dflt: str = "") -> str:
    """
    把插件属性安全转成可显示的字符串。

    ★插件里有些属性在配置未加载时是空列表 `[]`，
      直接 f-string 插值会渲染成字面量 `[]`（用户看到的就是这个）。
      这里统一兜底：
        · list/tuple -> 取第一个非空元素（空则用默认值）
        · dict       -> 取第一个键（空则用默认值）
        · None       -> 默认值
        · 其它       -> str() 后 strip
    """
    if v is None:
        return dflt
    if isinstance(v, (list, tuple)):
        for x in v:
            s = str(x or "").strip()
            if s:
                return s
        return dflt
    if isinstance(v, dict):
        for k in v:
            s = str(k or "").strip()
            if s:
                return s
        return dflt
    s = str(v).strip()
    if s in ("[]", "{}", "None", "null"):
        return dflt
    return s or dflt


def _cw(s_) -> int:
    """
    半角宽度计数：emoji / 汉字算 2，其余算 1。

    ★对齐只用这个口径 —— emoji 的实际像素宽度随字体波动，
      但「占 2 个半角位」在等宽/双宽混排里是稳定的，
      按它补齐就能保证每一行左右两端都齐。
    """
    import unicodedata as _ud
    n = 0
    for c in str(s_ or ""):
        if _is_emoji(c) or _ud.east_asian_width(c) in ("W", "F", "A"):
            n += 2
        else:
            n += 1
    return n


def _finish(title: str, rows) -> list:
    """统一收尾：标题 + 内容行 + 收尾横线"""
    _rows = [_icon_space_line(str(r).rstrip())
             for r in (rows or []) if str(r).strip()]
    # ★短填充行参与列判定，横线单独一行（见 _grid 注释）
    _head = [_bar(title)]     # _bar 已含标题 + 分隔线
    # ★收尾横线与内容等宽（同 _grid）
    _foot = [_foot_bar(_head + _rows)]
    return _head + _rows + _foot





def _entry_name(plugin, menu_id: str, dflt: str) -> str:
    """
    ★★ 1.7.7：取**菜单入口名**（后台可自定义）。

    从插件实例的 `_menu_entry_names()` 读 —— 它由 `menu_*_names` 系列配置键
    驱动，改完**实时生效**（`_menu()` 出口会热刷新配置）。

    ★ 例外：坐骑入口走 `_mount_menu_names()`（它有独立的 `mount_menu_names`
      配置键，历史更久），保持单一来源。

    读不到就返回默认名，绝不让菜单因为配置异常而空掉。
    """
    try:
        if str(menu_id) == "checkin_mount":
            f2 = getattr(plugin, "_mount_menu_names", None)
            if callable(f2):
                n2 = [str(x).strip() for x in (f2() or []) if str(x).strip()]
                if n2:
                    return n2[0]
            return dflt
        f = getattr(plugin, "_menu_entry_names", None)
        if callable(f):
            n = f(menu_id)
            if n:
                return str(n[0]).strip() or dflt
        # ★ 表里没有的 id（例如坐骑）-> 再试坐骑专属读取
        f2 = getattr(plugin, "_mount_menu_names", None)
        if callable(f2):
            n2 = [str(x).strip() for x in (f2() or []) if str(x).strip()]
            if n2:
                return n2[0]
    except Exception:
        pass
    return dflt


def _shop_label(plugin) -> str:
    """
    ★★ 1.7.7：签到系统菜单里「签到商店」那个入口的显示名。

    它是一条**指令**（`shop_trigger_names`），不是菜单入口名，
    所以直接读签到模块的配置，改完实时生效。
    """
    try:
        ck = getattr(plugin, "checkin_module", None)
        v = getattr(ck, "shop_trigger_names", None) if ck else None
        if isinstance(v, (list, tuple)) and v:
            s = str(v[0]).strip()
            if s:
                return s
    except Exception:
        pass
    return "签到商店"


def _grid(rows, gap: int = 4, title: str = "") -> str:
    """
    菜单统一排版（照参考图）：

        ──────── 标题 ────────
        🖼️接口管理    📚词库管理
        ✅签到管理    🖥️状态管理
        ━━━━━━━━━━━━━━━━━━━━

    · 两列：右列按**左列最宽项**对齐
    """
    # ★ 1.7.6：图标后补空格要在**算列宽之前**做，
    #   否则补出来的空格会破坏列分隔/对不齐。
    _rows = [(_icon_space_line(str(_l or "").strip()),
              _icon_space_line(str(_r or "").strip()))
             for _l, _r in rows]
    # ★右列宽按「右列非空」的行算（右列为空的行不参与，避免被撑开）
    _left_max = max((_cw(_l) for _l, _r in _rows if _r), default=0)
    # ★渲染器的列判定：要求「多数行是多列」才按列排版。
    #   而列宽按**最长单元格**算 —— 标题/收尾线若是一整条长横线，
    #   第一列会被撑到 400+px，第二列直接推到画布外。
    #   解法：标题/收尾线用「短填充行」参与列判定，横线单独一行（宽但无分隔，
    #   渲染器会把它当单列行画出来，不影响列宽计算的关键项）。
    _lines = []
    if title:
        # ★标题独立一行，下面跟一条分隔线，再放内容
        _lines.append(_bar(title))      # 已含标题 + 分隔线
    _content = []
    for _l, _r in _rows:
        if not _l and not _r:
            continue
        # ★右列为空（单列行）也要画出来 —— 以前 `if not _r: continue`
        #   会把「🐾宠物功能」这类只有左列的行整行丢掉。
        if not _r:
            _content.append(_l)
            continue
        _content.append(_l + (" " * max(1, _left_max - _cw(_l) + gap)) + _r)
    _lines.extend(_content)

    # ★收尾横线**与内容等宽**（按像素对齐，见 _foot_bar）。
    #   固定长度会让内容窄的菜单被撑宽，线比内容长一截。
    _lines.append(_foot_bar(_lines))
    # ★ 1.7.6：图标后补空格（列内已处理过，这里只兜底单列行）
    return _icon_space_text("\n".join(_lines))


def build_main_menu(plugin) -> str:
    """
    主菜单（两列排布，收尾横线与标题等宽）。

    ★顺序：接口 / MC / 打卡 / 签到 / 每日 / 娱乐 / 管理 / 发言
    ★★ 市场版：原版最后一行是「音乐功能 + 小鸟图鉴」，
       这两个功能已整体移除，所以主菜单现在收在这一行。
    """
    title = "主菜单"
    ent = _sv(getattr(plugin, "cmd_entertain_menu_name", "")) or "娱乐功能"
    rows = [
        ("🎭接口系统", "⛏️MC系统"),
        ("📅打卡系统", "💰签到系统"),
        ("🎲每日系列", "🎈" + ent),
        ("🔧管理系统", "💬发言功能"),
    ]
    return _grid(rows, title=title)


def build_meme_menu(plugin) -> str:
    def _names(raw, fallback):
        return [x.strip() for x in str(raw or "").split(",") if x.strip()] or [fallback]

    imgs = _names(_sv(getattr(plugin, "cmd_meme_image_name", "")), "图片接口")
    vids = _names(_sv(getattr(plugin, "cmd_meme_video_name", "")), "视频接口")
    txts = _names(_sv(getattr(plugin, "cmd_meme_text_name", "")), "文本接口")

    lines = [_bar("接口系统")]
    lines.append(f"🖼️{imgs[0]}［页数］")
    if len(imgs) > 1:
        lines.append(f"　 别名：{' / '.join(imgs[1:])}")
    lines.append("　 只看图片类接口，没有页数默认第一页")
    lines.append(f"🎬{vids[0]}［页数］")
    if len(vids) > 1:
        lines.append(f"　 别名：{' / '.join(vids[1:])}")
    lines.append("　 只看视频类接口，没有页数默认第一页")
    lines.append(f"📝{txts[0]}［页数］")
    if len(txts) > 1:
        lines.append(f"　 别名：{' / '.join(txts[1:])}")
    lines.append("　 只看文本类接口，没有页数默认第一页")
    lines.append(_bar_plain())
    return "\n".join(lines)


def build_mc_menu(plugin) -> str:
    """
    MC系统：列出全部 MC 相关指令（版本查询 / 自动检测 / 测试推送）。

    ★ 以前这三个指令挂在 `build_mc_version_menu` 下，而那个 id 的匹配名
      是硬编码的「MC版本功能」（永远匹配不到），已删除；
      内容合并到这里，避免「MC系统」只剩一个空壳入口。
    """
    ver = _sv(getattr(plugin, "cmd_minecraft_name", "")) or "MC版本"
    auto = _sv(getattr(plugin, "cmd_mc_auto_name", "")) or "MC自动检测"
    test = _sv(getattr(plugin, "cmd_mc_test_name", "")) or "MC测试推送"
    return "\n".join([
        _bar("MC系统"),
        f"⛏️{ver}",
        "　 查询最新 Java 正式版 / 测试版",
        "",
        f"🔔{auto}",
        "　 开启/关闭本群自动检测推送",
        "",
        f"🚀{test}",
        "　 手动拉取最新版本并推送",
        "　 推送范围可在后台「MC测试推送指定群」里指定",
        _bar_plain(),
    ])


def build_greeting_menu(plugin) -> str:
    """打卡系统：只列**子菜单入口**，不列具体指令"""
    rows = [
        ("🌅早安打卡", "🌙晚安打卡"),
        ("🏆打卡排行", "📊打卡统计"),
    ]
    return _grid(rows, title="打卡系统")


def build_checkin_menu(plugin) -> str:
    """
    签到系统：只列**子菜单入口**（宠物功能也在这里给入口）。

    ★ 1.7.6：
      · 移除「🏆签到排行」入口（排行榜已挪到「查询指令」下级菜单）
      · 「抢银行」**不在这里列出** —— 它属于银行功能，
        入口和说明都放在「银行功能」菜单里（见 build_checkin_bank_menu）
    """
    # ★★ 1.7.7：入口名全部从配置读 —— 后台改了这里显示的名字也跟着变
    rows = [
        (f"✅{_entry_name(plugin,'checkin_signin','签到指令')}",
         f"📊{_entry_name(plugin,'checkin_query','查询指令')}"),
        (f"🏦{_entry_name(plugin,'checkin_bank','银行功能')}",
         f"🦸{_entry_name(plugin,'checkin_steal','神偷功能')}"),
        (f"🐴{_entry_name(plugin,'checkin_mount','坐骑功能')}",
         f"🔨{_entry_name(plugin,'checkin_job','打工功能')}"),
        (f"🐾{_entry_name(plugin,'pet','宠物功能')}",
         f"🎰{_entry_name(plugin,'checkin_lottery','抽奖功能')}"),
        # ★ 签到商店那条是**指令名**（shop_trigger_names），不是菜单入口名，
        #   所以走 `_shop_first_name` 而不是 `_entry_name`。
        (f"🧰{_shop_label(plugin)}",
         f"❓{_entry_name(plugin,'checkin_shop_help','商店帮助')}"),
    ]
    return _grid(rows, title="签到系统")


def build_daily_menu(plugin) -> str:
    """每日系列：四个子菜单入口"""
    rows = [
        ("🔮运势功能", "💑老公功能"),
        ("🍀人品功能", "📰读报功能"),
    ]
    return _grid(rows, title="每日系列")


def _daily_names(mod, attr="trigger_names", fallback="") -> str:
    """取模块的指令名（逗号/列表都兼容），失败回退"""
    try:
        v = getattr(mod, attr, None)
        if not v:
            return fallback
        if isinstance(v, (list, tuple)):
            return " / ".join(str(x) for x in v if str(x).strip())
        return " / ".join(x.strip() for x in str(v).replace("，", ",").split(",") if x.strip())
    except Exception:
        return fallback


def _daily_first(mod, attr="trigger_names", fallback="") -> str:
    """取模块的「主指令名」（第一个），用于用法示例"""
    try:
        v = getattr(mod, attr, None)
        if isinstance(v, (list, tuple)) and v:
            return str(v[0])
        if isinstance(v, str) and v.strip():
            return [x.strip() for x in v.replace("，", ",").split(",") if x.strip()][0]
    except Exception:
        pass
    return fallback


def build_fortune_menu(plugin) -> str:
    """运势功能子菜单"""
    mod = getattr(plugin, "fortune_module", None)
    names = _daily_names(mod, "trigger_names", "今日运势")
    main = _daily_first(mod, "trigger_names", "今日运势")
    return "\n".join([
        _bar("运势功能"),
        f"🔮{names}",
        "　 查看今日运势（宜 / 忌 / 幸运指数）",
        "",
        f"👤{main} @某人　/　{main} QQ号",
        "　 帮别人查今日运势",
        "",
        "💡结果按「输出模式」渲染（文本 / 图片）",
        _bar_plain(),
    ])


def build_husband_menu(plugin) -> str:
    """老公功能子菜单（含逼迫指令）"""
    hmod = getattr(plugin, "husband_module", None)
    names = _daily_names(hmod, "trigger_names", "今日老公")
    force = _daily_first(hmod, "force_trigger_names", "逼迫")
    return "\n".join([
        _bar("老公功能"),
        f"💑{names}",
        "　 随机抽出今日老公（可配排除名单 / 允许机器人）",
        "",
        f"💪{force} @某人",
        "　 强行指定今日老公（管理员配置后生效）",
        "",
        "🔧后台可调：指令名、强制指令名、抽取选项",
        "💡结果按「输出模式」渲染（文本 / 图片）",
        _bar_plain(),
    ])


def build_luck_menu(plugin) -> str:
    """人品功能子菜单"""
    mod = getattr(plugin, "luck_module", None)
    names = _daily_names(mod, "trigger_names", "今日人品")
    main = _daily_first(mod, "trigger_names", "今日人品")
    return "\n".join([
        _bar("人品功能"),
        f"🍀{names}",
        "　 查看今日人品值（含评语）",
        "",
        f"👤{main} @某人　/　{main} QQ号",
        "　 帮别人查今日人品",
        "",
        "💡结果按「输出模式」渲染（文本 / 图片）",
        _bar_plain(),
    ])


def build_news_menu(plugin) -> str:
    """读报功能子菜单"""
    raw = _sv(getattr(plugin, "cmd_daily_news_name", "")) or "每日读报"
    parts = [x.strip() for x in str(raw).replace("，", ",").split(",") if x.strip()]
    names = " / ".join(parts) or "每日读报"
    main = parts[0] if parts else "每日读报"
    return "\n".join([
        _bar("读报功能"),
        f"📰{names}",
        f"　 手动读一次今日新闻（{main}，60 秒内同一群去重）",
        "",
        "⏰定时推送由后台「推送时间 / 推送间隔」控制",
        "　 未到时间时可手动补一次（同样去重）",
        "",
        "🔧管理指令：读报推送开 / 关 / 时间 / 列表",
        "💡结果按「输出模式」渲染（文本 / 图片）",
        _bar_plain(),
    ])


def build_output_mode_menu(plugin) -> str:
    """输出模式说明（管理员可切换，按群生效）"""
    om = getattr(plugin, "output_mode_module", None)
    cmd = om.cmd_names[0] if om else "切换输出模式"
    try:
        cur = om.mode_of(_sv(getattr(plugin, "_menu_group_id", ""))) if om else "text"
        lbl = om.MODE_LABELS.get(cur, cur) if om else "文本模式"
    except Exception:
        lbl, cur = "文本模式", "text"
    return "\n".join([
        _bar("输出模式"),
        f"📌本群当前：{lbl}",
        "",
        f"📝{cmd} 文本　— 直接发文字",
        f"🖼️{cmd} 图片　— 渲染成图片",
        "",
        f"💡只发「{cmd}」查看当前模式",
        "💡只影响本群，其它群不受影响",
        "💡图片模式下内容与菜单都会转图；状态提示仍是文字",
        _bar_plain(),
    ])





def build_weather_menu(plugin) -> str:
    """
    天气查询：当天天气的用法说明。

    ★ 数据由 MemeAPI 的 /api/weather 提供（weather.com.cn），
      指令关键词在后台「接口系统 → 接口配置列表」里改。
    """
    t1 = _sv(getattr(plugin, "cmd_weather_text_name", "")) or "天气"
    t2 = _sv(getattr(plugin, "cmd_weather_forecast_name", "")) or "天气预报"
    t3 = _sv(getattr(plugin, "cmd_weather_check_name", "")) or "查天气"
    i1 = _sv(getattr(plugin, "cmd_weather_img_name", "")) or "天气图片"
    i2 = _sv(getattr(plugin, "cmd_weather_card_name", "")) or "天气卡片"
    title = "天气查询"
    lines = [
        "🌤️文字版",
        f"　 {t1} 城市名　{t2} 城市名",
        f"　 {t3} 城市名",
        "",
        "🖼️图片版",
        f"　 {i1} 城市名　{i2} 城市名",
        "",
        "💡支持国内外城市",
        "　 国内：北京 / 上海 / 香港 / 台北 …",
        "　 国际：东京 / 纽约 / 伦敦 / 巴黎 / 首尔 …",
        "　 也认城市码，例如：101010100（北京）",
        "　 城市名写错会提示「没找到城市」，不会乱返回",
        "",
        "📋返回内容（当天）",
        "　 当前温度 · 相对湿度 · 风向风级",
        "　 日出温度 · 日落温度 · 白天夜间天气",
        "　 图片版另有：分时段预报（3 小时一段，8 段）+ 未来 7 天",    ]
    return "\n".join(_finish(title, lines))




def build_entertain_menu(plugin) -> str:
    """
    娱乐功能：子功能入口（后续新功能都加在这里）。

    ★只放**本菜单自己的**功能（名片）。
      小鸟图鉴的指令归「图鉴系统」菜单，不要写到这里。
    """
    card = _sv(getattr(plugin, "cmd_card_menu_name", "")) or "名片功能"
    rps = _sv(getattr(plugin, "cmd_rps_menu", "")) or "猜拳功能"
    # ★★ 1.7.7：猜数游戏（娱乐功能新增）
    guess = _entry_name(plugin, "guess", "猜数功能")
    wea = _sv(getattr(plugin, "cmd_weather_menu_name", "")) or "天气查询"
    qq = _sv(getattr(plugin, "cmd_qqinfo_menu_name", "")) or "查询功能"
    title = "娱乐功能"
    return _grid([
        (f"🔢{guess}", f"☁️{wea}"),
        (f"🔍{qq}", ""),
    ], title=title)


def build_guess_menu(plugin) -> str:
    """
    ★★ 1.7.7 重写：猜数游戏菜单（娱乐功能下级）。

    ★ 开新局 / 参与 是**两条指令**：
        · 开始猜数   —— 开一局
        · 猜数 数字  —— 参与猜一次
    ★ 所有指令名与数值都动态读后台配置，改完立刻生效。
    """
    names = _names_of(getattr(plugin, "cmd_guess", None), ["猜数"])
    main = names[0]
    starts = _names_of(getattr(plugin, "cmd_guess_start", None), ["开始猜数"])
    start = starts[0]
    lo = getattr(plugin, "guess_min", 1)
    hi = getattr(plugin, "guess_max", 100)
    tries = max(1, int(getattr(plugin, "guess_max_tries", 3) or 3))
    pen = max(0, int(getattr(plugin, "guess_penalty", 1000) or 0))
    rmin = max(0, int(getattr(plugin, "guess_reward_min", 100) or 0))
    rmax = max(0, int(getattr(plugin, "guess_reward_max", 500) or 0))
    if rmax < rmin:
        rmin, rmax = rmax, rmin
    to = max(0, int(getattr(plugin, "guess_timeout_sec", 60) or 0))
    sn = _sn(plugin)
    if to <= 0:
        _to_txt = "不自动关闭"
    elif to % 60 == 0:
        _to_txt = f"{to // 60} 分钟内没人猜就关闭"
    else:
        _to_txt = f"{to} 秒内没人猜就关闭"
    rows = [
        # ★ 标题跟**菜单入口名**走，和「娱乐功能」里显示的保持一致
        _bar(_entry_name(plugin, "guess", "猜数功能")),
        f"🔢{start}",
        f"　 开一局：我想一个 {lo} ~ {hi} 之间的整数",
        "　 **所有人都能参与**",
        "",
        f"🔢{main} 数字",
        "　 参与猜一次，我会告诉你「太大了 / 太小了 / 猜对了」",
        f"　 例：{main} 50",
        "",
        "── 规则 ──",
        f"🙋 每人每局最多猜 **{tries}** 次",
        f"🎁 猜对奖励：**{rmin} ~ {rmax}** {sn}（随机）",
        f"💸 猜错扣：**{pen}** {sn}" if pen > 0 else "💸 猜错不扣分",
        f"⏰ {_to_txt}",
    ]
    if len(names) > 1:
        rows += ["", "　 参与也可以用：" + " / ".join(names[1:][:6])]
    if len(starts) > 1:
        rows += ["　 开局也可以用：" + " / ".join(starts[1:][:6])]
    rows += [
        "",
        f"💡 积分和签到是同一份；用「我的装备」看自己的加成",
        _bar_plain(),
    ]
    return "\n".join(rows)


def _names_of(v, dflt=None):
    """把指令配置统一成列表"""
    if isinstance(v, (list, tuple)):
        out = [str(x).strip() for x in v if str(x).strip()]
    else:
        out = [x.strip() for x in str(v or "").split(",") if x.strip()]
    return out or list(dflt or [])


def build_qqinfo_menu(plugin) -> str:
    """查询功能：用法说明（查 QQ 用户资料）。"""
    raw = _sv(getattr(plugin, "cmd_qqinfo", "")) or "查询"
    names = [x.strip() for x in str(raw).replace("，", ",").split(",")
             if x.strip()]
    main = names[0] if names else "查询"
    alts = names[1:]
    rows = []
    rows.append(f"🔍{main} @某人 / QQ号")
    rows.append("　 查询这个人的 QQ 资料")
    rows.append("")
    rows.append("⚠️必须带 @某人 或 QQ号")
    rows.append("　　光发指令不触发（避免误触）")
    rows.append("　　@机器人 后光发指令 = 查机器人自己")
    if alts:
        rows.append("")
        rows.append("　 也可以用：" + " / ".join(alts[:6]))
    rows.append("")
    rows.append("　 输出的内容：")
    rows.append("　　🖼 头像（图片模式）")
    rows.append("　　QQ昵称（太长省略号）/ QQ等级")
    rows.append("　　QID / QQ签名")
    rows.append("　　注册时间 / 注册天数（≈N年）")
    rows.append("　　会员等级 / 会员现状")
    rows.append("")
    rows.append("📄文本模式发文字　🖼图片模式发卡片")
    rows.append("　（跟随本群「输出模式」设置）")
    rows.append("")
    rows.append("💡资料由协议端（NapCat）提供")

    title = _sv(getattr(plugin, "cmd_qqinfo_menu_name", "")) or "查询功能"
    return "\n".join(_finish(title, rows))




def build_admin_menu(plugin) -> str:
    rows = [
        ("🖼️接口管理", "📚词库管理"),
        ("✅签到管理", "🖥️状态管理"),
        ("🔀开关管理", "🕐整点管理"),
        ("📣艾特设置", "👑超管设置"),
        ("📰读报管理", "🚫成员管理"),
        ("🎨输出模式", "🔔提示功能"),
    ]
    return _grid(rows, title="管理系统")


def build_notice_menu(plugin) -> str:
    """
    提示功能（1.7.6 新增）

    五类群事件提示，**默认全部关闭**，开关是**白名单**：
    每类在后台单独填写允许的群号，留空 = 该类关闭。
    数据来自 NapCat / OneBot 的 notice 事件推送（实时）。
    """
    nm = getattr(plugin, "notice_module", None)
    cmds = getattr(nm, "cmds", {}) or {}
    lines = [
        _bar("提示功能"),
        "🔔 群事件提示（**默认全部关闭**）",
        "",
    ]
    _desc = {
        "card":  "谁改了群昵称",
        "mute":  "谁被禁言 / 解禁",
        "leave": "谁退群 / 被踢出",
        "admin": "谁成为 / 取消管理员",
        "title": "谁获得 / 取消专属称号",
    }
    # 标签优先用模块里那份，取不到就退回内置表
    try:
        from .notice import NOTICE_LABEL as _LAB
    except Exception:
        try:
            from core.notice import NOTICE_LABEL as _LAB
        except Exception:
            _LAB = {}
    _fallback = {
        "card": "改群昵称", "mute": "禁言 / 解禁", "leave": "退群 / 被踢出",
        "admin": "管理员变动", "title": "专属称号变动",
    }
    for k in ("card", "mute", "leave", "admin", "title"):
        lab = _LAB.get(k) or _fallback[k]
        lines.append(f"· {lab}　→　{_desc.get(k, k)}")
    lines += [
        "",
        "🔧 开关方式：**白名单**（只能在后台改）",
        "　 每一类提示各自一份群号清单，填了就只在这些群提示",
        "　 **留空 = 该类全部关闭**（安装后默认就是空的）",
        "",
        "🔍 群里可以查本群情况：",
        "· 提示状态　→　本群在哪些白名单里",
        "",
        "⚠️ 数据由协议端（NapCat/OneBot）的事件推送提供",
    ]
    lines.append(_bar_plain())
    return "\n".join(lines)


def build_member_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("成员管理"),
        f"👢{_sv(plugin.cmd_kick_name)} @某人",
        f"🔇{_sv(plugin.cmd_mute_name)} @某人 ［秒数］",
        f"🔊{_sv(plugin.cmd_unmute_name)} @某人",
        "",
        f"🚫{_sv(plugin.cmd_blacklist_name)} @某人 ［kick|mute|ignore］",
        f"✅{_sv(plugin.cmd_unblacklist_name)} @某人",
        f"📋{_sv(plugin.cmd_blacklist_list_name)}",
        "",
        "💡需要机器人是群主或管理员才能踢人/禁言",
        _bar_plain(),
    ])


def build_news_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("读报管理"),
        f"🔔{_sv(plugin.cmd_daily_news_on_name)} ［群号］",
        f"🔕{_sv(plugin.cmd_daily_news_off_name)} ［群号］",
        f"🕐{_sv(plugin.cmd_daily_news_time_name)} ［群号］ 08:00",
        f"📋{_sv(plugin.cmd_daily_news_list_name)}",
        "",
        f"💡手动读报：{_sv(plugin.cmd_daily_news_name)}",
        _bar_plain(),
    ])


# ============================================================
# 接口系统 · 三级子菜单
# ============================================================
def build_meme_feature_menu(plugin) -> str:
    return "\n".join([
        _bar("接口功能"),
        f"📋{_sv(plugin.cmd_list_name)} ［页码］",
        "　 查看接口规则列表（支持分页）",
        "",
        "💡发送「关键词 + 参数」即可调用接口",
        "　 无参数接口直接发关键词即可",
        "　 例：上香@某人",
        "　 例：鞭打 QQ号 QQ号",
        "　 例：报悲 任意文本",
        "　 返回图片 / 视频 / 文本由接口配置决定",
        _bar_plain(),
    ])


# ============================================================
# MC系统 · 三级子菜单
# ============================================================
# ============================================================
# 打卡系统 · 三级子菜单
# ============================================================
def build_greeting_morning_menu(plugin) -> str:
    mn = " / ".join(plugin.greeting_module.morning_names) if plugin.greeting_module else "早安 / 早上好 / 起床"
    return "\n".join([
        _bar("早安打卡"),
        f"🌅指令：{mn}",
        "　 记录起床时间，并显示睡眠时长",
        "",
        "💡需在有效时间窗口内打早安",
        "💡逻辑日 6 点重置",
        _bar_plain(),
    ])


def build_greeting_night_menu(plugin) -> str:
    nn = " / ".join(plugin.greeting_module.night_names) if plugin.greeting_module else "晚安 / 睡觉 / 睡了"
    return "\n".join([
        _bar("晚安打卡"),
        f"🌙指令：{nn}",
        "　 记录睡觉时间，并显示清醒时长",
        "",
        "💡需先打早安，才能打晚安",
        "💡有截止时间限制",
        _bar_plain(),
    ])


def build_greeting_rank_menu(plugin) -> str:
    # ★★ 市场版 1.1：打卡排行拆成**三条独立指令**（各出一个前十榜），
    #   顺序按用户指定：天数 / 清醒 / 睡眠。
    _gm = getattr(plugin, "greeting_module", None)

    def _n(attr, dflt):
        v = getattr(_gm, attr, None) if _gm is not None else None
        if isinstance(v, (list, tuple)) and v:
            return " / ".join(str(x) for x in v if str(x).strip())
        return dflt

    return "\n".join([
        _bar("打卡查询"),
        f"🏆{_n('rank_days_names', '打卡天数排行 / 天数排行')}",
        "　 完整打卡天数榜 · 前十（早晚都打才算一天）",
        "",
        f"🥇{_n('rank_awake_names', '清醒时长排行 / 清醒排行')}",
        "　 累计清醒时长榜 · 前十",
        "",
        f"💤{_n('rank_sleep_names', '睡眠时长排行 / 睡眠排行')}",
        "　 累计睡眠时长榜 · 前十",
        "",
        "💡 数据来自**所有群共享**的打卡记录",
        _bar_plain(),
    ])

def build_racing_menu(plugin, page=1) -> str:
    """
    ★★ 1.6：赛车功能菜单（娱乐功能下级）—— **分页**。

    ★ 分页原因：指令说明 + 一整套规则放一页太长（用户反馈「太长了」）。
      现在拆成 3 页：
        · 第 1 页：所有指令（怎么玩）
        · 第 2 页：比赛规则（人数/等待/场次/报名费/奖池/胜负）
        · 第 3 页：奖励与进阶（奖池分配、抽奖限定车、属性权重）
      翻页：`赛车功能 2` / `赛车功能 3`

    ★ 所有指令名与数值都**动态读后台配置**，改完立刻生效。
    """
    my = _names_of(getattr(plugin, "cmd_race_my", None), ["我的赛车"])[0]
    equip = _names_of(getattr(plugin, "cmd_race_equip", None),
                      ["装备赛车"])[0]
    view = _names_of(getattr(plugin, "cmd_race_view", None), ["赛车查看"])[0]
    shop = _names_of(getattr(plugin, "cmd_race_shop", None), ["赛车商店"])[0]
    buy = _names_of(getattr(plugin, "cmd_race_buy", None), ["购买赛车"])[0]
    lucky = _names_of(getattr(plugin, "cmd_race_lucky", None),
                      ["赛车抽奖"])[0]
    lucky_all = _names_of(getattr(plugin, "cmd_race_lucky_all", None),
                          ["赛车一键抽奖", "赛车全部抽奖"])[0]
    join = _names_of(getattr(plugin, "cmd_race_join", None), ["参与比赛"])[0]
    fast = _names_of(getattr(plugin, "cmd_race_fast", None), ["快速比赛"])[0]

    ppl = max(2, int(getattr(plugin, "race_players", 5) or 5))
    wait = max(0, int(getattr(plugin, "race_wait_sec", 3600) or 0))
    limit = max(0, int(getattr(plugin, "race_daily_limit", 10) or 0))
    fee = max(0, int(getattr(plugin, "race_entry_fee", 500) or 0))
    # ★★ 1.6：奖池上下限是**赛车自己的**（机制同抽奖，但奖池独立）
    blo = max(0, int(getattr(plugin, "race_pool_bonus_min", 1000) or 0))
    bhi = max(blo, int(getattr(plugin, "race_pool_bonus_max", 5000) or 0))
    npc_n = max(1, int(getattr(plugin, "race_fast_npc", 5) or 5))
    _rm = getattr(plugin, "racing_module", None)
    try:
        _npc_pct = int(float(getattr(plugin, "race_npc_power", 100) or 100))
    except Exception:
        _npc_pct = 100
    _npc_pct = max(10, min(300, _npc_pct))
    try:
        _npc_cars_n = len(getattr(_rm, "npc_cars", None) or [])
    except Exception:
        _npc_cars_n = 0
    sn = _sn(plugin)
    title = _entry_name(plugin, "racing", "赛车功能")

    if wait <= 0:
        wait_txt = "不自动补位（一直等人）"
    elif wait % 3600 == 0:
        wait_txt = f"{wait // 3600} 小时没满就补 NPC"
    elif wait % 60 == 0:
        wait_txt = f"{wait // 60} 分钟没满就补 NPC"
    else:
        wait_txt = f"{wait} 秒没满就补 NPC"

    def _pages_of(i: int) -> list:
        # ---------------- 第 1 页：所有指令 ----------------
        if i == 0:
            rows = [_bar(title), "── 所有指令 ──"]

            def _c(cmd: str, desc: str, extra: str = "") -> None:
                rows.append(cmd)
                rows.append(f"　 {desc}")
                if extra:
                    rows.append(f"　 {extra}")

            _c(f"🏁{join}", f"报名参赛（满 **{ppl}** 人开赛）",
               f"{wait_txt}开赛")
            _c(f"⚡{fast}", f"快速比赛：对手全是 NPC（{npc_n} 个）",
               "不用凑人，立刻开赛")
            _c(f"🏎️{my}", "看自己拥有的赛车 + 当前装备 + 战绩")
            _c(f"🔧{equip} 车名/序号", "装备一辆车（参赛用这辆）",
               f"例：「{equip} 2」或「{equip} 疾风 GT」")
            _c(f"🔍{view} 车名/序号", "看这辆车的属性",
               "序号按「我的赛车」/「赛车商店」里的编号")
            _c(f"🛒{shop} [页号]", "看商店在售的赛车（每页 5 辆）",
               f"翻页：「{shop} 2」")
            _c(f"💰{buy} 车名/序号", "买一辆车（用积分）",
               f"例：「{buy} 保时捷911」或「{buy} 3」")
            _c(f"🎰{lucky} 抽", "抽奖：有机会抽到**商店买不到**的限定车",
               f"抽到过的车不会重复抽中同一台；看说明用「{lucky}」")
            _c(f"⚡{lucky_all}", "一键抽奖：把**今天剩余次数一次抽完**",
               f"抽到几次就是几次，例：「{lucky_all}」")
            return rows

        # ---------------- 第 2 页：比赛规则 ----------------
        if i == 1:
            rows = [
                _bar(title),
                "── 比赛规则 ──",
                f"👥 开赛人数：**{ppl}** 人",
                "　 报名够了就立刻开赛；不够就等人",
                f"⏳ 等待上限：{wait_txt}" if wait > 0
                else "⏳ 不自动补位（一直等人）",
                f"📅 每人每天：**{limit}** 场" if limit > 0
                else "📅 每人每天：不限场次",
                f"💸 报名费：**{_fmt(fee)}** {sn}（**不退**）",
                "　 报名费全部进奖池",
                "",
                f"💰 系统加成：**{_fmt(blo)} ~ {_fmt(bhi)}** {sn}",
                "　 · **每天随机一次、当天固定**（同银行抽奖）",
                "　 · 跨天才重新随机，当天所有场次都用同一个数",
                "　 · 赛车**独立奖池**，和抽奖奖池互不影响",
                "",
                f"🏆 奖池 = 报名费总和 + 当天加成",
                "　 前三名按 **50% / 30% / 20%** 瓜分",
                "　 **4、5 名没有奖金**",
                "",
                "🤖 补位：人不够时由 NPC 车手补足",
                "　 NPC 不占奖金名额（只有前 3 名真人拿钱）",
                f"　 NPC 强度：**{_npc_pct}%**（100% = 后台原始属性）"
                + ("" if _npc_pct == 100
                   else f"，NPC 属性 ×{_npc_pct / 100:g}"),
            ]
            return rows

        # ---------------- 第 3 页：胜负与进阶 ----------------
        rows = [
            _bar(title),
            "── 怎么才能赢 ──",
            "🎲 车越好**赢的概率越大**",
            "　 比赛按「用时模拟」算名次，不是纯抽签 ——",
            "　 结果可解释，群里能看到每辆车跑了多少秒",
            "",
            "📊 **属性权重**（车列表里填 1~100）：",
            "　 · 速度 / 加速 / 操控 → 用时更短（更容易赢）",
            "　 · 稳定 → 随机波动更小（越稳越少爆冷）",
            "　 · 幸运 → 小幅加成",
            "　 · 稳定低的车波动大 —— **冷门也可能夺冠**",
            "",
            "🏎️ **车从哪来**：",
            f"　 · 「{buy}」用积分买（可买多辆）",
            f"　 · 「{lucky}」抽奖能抽到商店买不到的超稀有赛车",
            "　　 抽到直接进车库（原来没车就自动装备）",
            "　　 ★ 抽到过的车不会再抽中同一台",
            "",
            "",
            "🤖 **NPC 强度可自定义**：",
            f"　 · 当前 **{_npc_pct}%**（100% = 后台填的原始属性）",
            "　 · 后台「赛车功能 → NPC 强度」整体缩放",
            f"　 · NPC 用车 **{_npc_cars_n}** 辆，属性可逐个改",
            "　 · NPC 只补位，**不占奖金名额**",
            f"💡 看车库明细用「{my}」",
        ]
        return rows

    pages = 3
    p = max(1, min(_pg(page), pages))
    body = _pages_of(p - 1)
    body.append("")
    body.append(f"📄 第 {p} / {pages} 页")
    if p > 1:
        body.append(f"⬅️ 上一页：「{title} {p - 1}」")
    if p < pages:
        body.append(f"➡️ 下一页：「{title} {p + 1}」")
    body.append(_bar_plain())
    return "\n".join(body)

def build_checkin_signin_menu(plugin) -> str:
    ck = " / ".join(plugin.checkin_module.trigger_names) if plugin.checkin_module else "签到"
    return "\n".join([
        _bar("签到指令"),
        f"✅{ck}",
        f"　 每日签到，随机 {_ck_score_min(plugin)}-{_ck_score_max(plugin)} "
        f"{_sn(plugin)}",
        "　 ★ 底部会提示抽奖入口",
        _bar_plain(),
    ])


def build_checkin_query_menu(plugin) -> str:
    inf = " / ".join(plugin.checkin_module.info_trigger_names) if plugin.checkin_module else "签到统计"
    bc = getattr(plugin.checkin_module, "rank_count_names", None) or ["签到次数排行"]
    bw = getattr(plugin.checkin_module, "rank_wealth_names", None) or ["总财富排行"]
    bd = getattr(plugin.checkin_module, "rank_debt_names", None) or ["负债排行"]
    _ck = plugin.checkin_module

    def _n(attr, *fb):
        v = getattr(_ck, attr, None) if _ck is not None else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return " / ".join(out)
        return " / ".join(fb)

    # ★★ 1.7.6：保险箱 / 理财 的指令与提示也在这里列出来
    _sh = _n("shop_trigger_names", "签到商店")
    _sb = _n("shop_buy_trigger_names", "购买物品")
    _ss = _n("shop_save_trigger_names", "存入保险箱")
    _st = _n("shop_take_trigger_names", "取出保险箱")
    _fd = _n("fund_trigger_names", "理财")
    _fb = _n("fund_buy_names", "购买理财")
    _fs = _n("fund_sell_names", "取出理财")
    _shop_on = bool(getattr(_ck, "shop_enable", True))
    _fund_on = bool(getattr(_ck, "fund_enable", True))
    _vr = getattr(_ck, "vault_steal_reduce", 15.0)

    def _fnum(v):
        try:
            f = float(v)
        except Exception:
            return str(v)
        return str(int(round(f))) if abs(f - round(f)) < 1e-9 else f"{f:g}"

    _lines = [
        _bar("查询指令"),
        f"📊{inf}",
        "　 不跟参数 = 查自己",
        "",
        f"📊{inf} @某人",
        f"📊{inf} QQ号",
        "　 查询指定用户",
    ]
    # ★ 买了保险箱后，「签到统计」里会多一行保险箱余额
    if _shop_on:
        _lines += [
            f"　 🧰 买了保险箱的人，这里会多显示一行「保险箱：金额」",
        ]
    _lines += [
        "",
        "🏆三种排行榜（各自独立指令）",
        f"　 {' / '.join(bc)}",
        f"　 　 按【累计签到次数】排",
        f"　 {' / '.join(bw)}",
        f"　 　 按【总财富】排（钱包 + 银行 − 欠款，只显示总数）",
        f"　 {' / '.join(bd)}",
        f"　 　 按【欠款】排，欠得越多越靠前",
    ]
    # ---------- 🧰 保险箱 ----------
    # ★★ 1.7.6：**只留保险箱相关** ——
    #   商店的「查看商店 / 购买商品」属于**签到商店**那条线，
    #   已经挂在「签到系统 -> 商店帮助」菜单里，这里不再重复。
    if _shop_on:
        _lines += [
            "",
            "🧰保险箱",
            f"　 📥{_ss} 金额　把钱存进保险箱",
            "　 　 存进去的钱**别人偷不走**",
            f"　 　 （全存：{_ss}全部）",
            f"　 📤{_st} 金额　从保险箱取出",
            f"　 　 （全取：{_st}全部）",
            f"　 🛡 有保险箱：被偷概率 -{_fnum(_vr)}%",
            f"　 　 （保险箱在「{_sh}」里购买）",
        ]
    # ---------- 💼 银行理财 ----------
    # ★★ 1.7.6：**不在这里列** —— 理财属于**银行功能**，
    #   指令和说明都已经在「银行功能」菜单里了，这里重复会显得啰嗦。
    _lines.append(_bar_plain())
    return "\n".join(_lines)


def _bank_common(plugin):
    """银行相关菜单的**公共取值**（指令名 + 各类数值），拆成小工具避免重复。"""
    ck = getattr(plugin, "checkin_module", None)
    sn = _sn(plugin)

    def _n(attr, *fb):
        v = getattr(ck, attr, None) if ck is not None else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return " / ".join(out)
        return " / ".join(fb)

    def _fnum(v):
        try:
            f = float(v)
        except Exception:
            return str(v)
        return str(int(round(f))) if abs(f - round(f)) < 1e-9 else f"{f:g}"

    d = {
        "sn": sn,
        "bk": _n("bank_trigger_names", "我的银行") if ck is None
        else " / ".join(ck.bank_trigger_names or ["我的银行"]),
        "dp": _n("bank_deposit_names", "存钱"),
        "wd": _n("bank_withdraw_names", "取钱"),
        "ln": _n("loan_trigger_names", "借款"),
        "rp": _n("loan_repay_names", "还款"),
        "li": _n("loan_info_names", "借款信息"),
        "rb": _n("rob_trigger_names", "抢银行"),
        "fd": _n("fund_trigger_names", "理财"),
        "fb": _n("fund_buy_names", "购买理财"),
        "fs": _n("fund_sell_names", "取出理财"),
        "fnum": _fnum,
    }
    d["dp0"] = (d["dp"].split(" / ") or ["存钱"])[0]
    d["wd0"] = (d["wd"].split(" / ") or ["取钱"])[0]
    d["rp0"] = (d["rp"].split(" / ") or ["还款"])[0]
    return d


def build_checkin_bank_menu(plugin) -> str:
    """
    ★★ 1.7.6：银行功能**主菜单** —— 只留「账户 + 存取」，其余拆到下级菜单。

    为什么拆：以前这一个菜单 813 字 / 44 行（卡片 2162px 高），
    借款 / 抢银行 / 理财全挤在一起，翻半天找不到想要的那条。
    """
    c = _bank_common(plugin)
    ck = getattr(plugin, "checkin_module", None)
    sn = c["sn"]
    _rob_on = bool(getattr(ck, "rob_enable", True))
    _fund_on = bool(getattr(ck, "fund_enable", True))
    return "\n".join([
        _bar("银行功能"),
        f"🏦{c['bk']}",
        f"　 查看持有{sn} / 银行余额 / 欠款 / 净值 / 总资产",
        "",
        f"📥{c['dp']} 数量",
        f"　 把{sn}存入银行",
        "",
        f"📤{c['wd']} 数量",
        f"　 从银行取出{sn}",
        "",
        "── 下级菜单（发下面的名字即可打开）──",
        f"❓{_entry_name(plugin,'checkin_bank_save','存钱取钱')}",
        "　 存取相关的完整说明",
        f"❓{_entry_name(plugin,'checkin_bank_loan','借款还款')}",
        "　 借款 / 还款 / 借款信息（含逾期罚息规则）",
        (f"💼{_entry_name(plugin,'checkin_bank_fund','理财功能')}"
         if _fund_on
         else f"💼{_entry_name(plugin,'checkin_bank_fund','理财功能')}（已关闭）"),
        "　 买入理财 / 查看亏盈 / 取出",
        (f"🚨{_entry_name(plugin,'checkin_bank_rob','抢银行帮助')}"
         if _rob_on
         else f"🚨{_entry_name(plugin,'checkin_bank_rob','抢银行帮助')}（已关闭）"),
        "　 抢银行规则与成功率",
        _bar_plain(),
    ])


def build_checkin_bank_save_menu(plugin) -> str:
    """银行下级菜单：存钱 / 取钱"""
    c = _bank_common(plugin)
    sn = c["sn"]
    return "\n".join([
        _bar("存钱取钱"),
        f"📥{c['dp']} 数量",
        f"　 把{sn}存入银行（钱包 -> 银行）",
        f"　 也可以：{c['dp']} all（全存）",
        "",
        f"📤{c['wd']} 数量",
        f"　 从银行取出{sn}（银行 -> 钱包）",
        f"　 也可以：{c['wd']} all（全取）",
        "",
        f"💡 想看余额：「{c['bk'].split(' / ')[0]}」",
        "💡 银行里的钱**抢银行时会被抢走**，钱包里的不会",
        _bar_plain(),
    ])


def build_checkin_bank_loan_menu(plugin) -> str:
    """银行下级菜单：借款 / 还款 / 借款信息（含逾期规则）"""
    c = _bank_common(plugin)
    ck = getattr(plugin, "checkin_module", None)
    sn = c["sn"]
    _due_days = int(getattr(ck, "loan_due_days", 0) or 0)
    _od_rate = float(getattr(ck, "loan_overdue_rate", 0) or 0)
    _od_step = int(getattr(ck, "loan_overdue_step_hours", 24) or 24)
    _db_days = int(getattr(ck, "loan_deadbeat_days", 0) or 0)
    _db_tag = str(getattr(ck, "loan_deadbeat_tag", "") or "🐍 老赖")
    _lr = getattr(ck, "loan_interest_rate", 0.30) * 100
    _lmax = getattr(ck, "loan_max", 10000)
    _due_line = (f"　 还款期限：**{_due_days} 天**内（超过开始罚息）"
                 if _due_days > 0 else "　 还款期限：不限")
    _db_line = ""
    if _due_days > 0:
        _db_line = (f"　 逾期满 {_db_days} 天挂「{_db_tag}」标签"
                    if _db_days > 0 else f"　 一逾期就挂「{_db_tag}」标签")
    _od_hint = ""
    if _due_days > 0 and _od_rate > 0:
        _od_hint = (f"⚠️ 逾期：每 {_od_step} 小时加收本金 "
                    f"{_od_rate * 100:.1f}% 罚息，越拖越多")
    lines = [
        _bar("借款还款"),
        f"💸{c['ln']} 数量",
        f"　 向银行借款（单次上限 {_lmax}，利息 {_lr:.0f}%）",
        "　 不带数量 = 直接借满上限",
        _due_line,
        "",
        f"🧾{c['rp']} 数量",
        "　 归还欠款（钱不够就按手上有的还）",
        f"　 也可以：{c['rp0']} all（有多少还多少）",
        "",
        f"📉{c['li']}",
        "　 查看自己欠了多少、净值多少",
        _due_line,
        _db_line,
    ]
    if _od_hint:
        lines.append(_od_hint)
    lines += [
        "",
        f"💡 还清后「{_db_tag}」标签自动消失",
        _bar_plain(),
    ]
    return "\n".join(lines)


def build_checkin_bank_fund_menu(plugin) -> str:
    """银行下级菜单：**理财功能**（买入 / 查看 / 取出）"""
    c = _bank_common(plugin)
    ck = getattr(plugin, "checkin_module", None)
    sn = c["sn"]
    _on = bool(getattr(ck, "fund_enable", True))
    _fpmax = getattr(ck, "fund_profit_max", 8.0)
    _flmax = getattr(ck, "fund_loss_max", 6.0)
    lines = [
        _bar("理财功能"),
        f"📈{c['fd']}",
        "　 查看自己的理财亏盈，**并显示今天是亏还是盈**",
        "",
        f"📈{c['fb']} 金额",
        f"　 把钱买入理财（钱包里的{sn}）",
        f"　 也可以：{c['fb']} all（全买）",
        f"　 之后**每天随机盈亏**一次：盈利最多 +{c['fnum'](_fpmax)}%，"
        f"亏损最多 -{c['fnum'](_flmax)}%",
        "　 · 盈利：直接加到买入金额上",
        "　 · 亏损：从买入金额里扣；**不够扣就从你的资产（钱包→银行）补**",
        "",
        f"📤{c['fs']} [金额]",
        "　 随时取出（不带金额 = 全部取出）",
        "　 ⭐ 取出的钱进**银行账户**",
        "",
        "⚠️ 理财算**银行功能** —— 银行冻结时不能买入/取出",
    ]
    if not _on:
        lines.append("🚫 该功能当前已关闭")
    lines.append(_bar_plain())
    return "\n".join(lines)


def build_checkin_bank_rob_menu(plugin) -> str:
    """银行下级菜单：抢银行"""
    c = _bank_common(plugin)
    ck = getattr(plugin, "checkin_module", None)
    sn = c["sn"]
    _on = bool(getattr(ck, "rob_enable", True))
    _rate = getattr(ck, "rob_success_rate", 5)
    _lo = getattr(ck, "rob_min", 1)
    _hi = getattr(ck, "rob_max", 10000)
    _days = getattr(ck, "rob_freeze_days", 3)
    _pen = getattr(ck, "rob_fail_penalty_rate", 0.5)
    lines = [
        _bar("抢银行"),
        f"🚨{c['rb']}",
        "　 **没有参数**，每天只能抢一次",
        "",
        f"✅ 成功（{_rate}%）：抢 {_lo}-{_hi} {sn}（从全群银行里出）",
        f"❌ 失败：冻结银行 {_days} 天 + 没收一半财产"
        f"（钱包+银行 的 {_pen * 100:.0f}%）",
        "",
        "⚠️ 成功率很低，下手前想清楚",
        "⚠️ 冻结期间**存/取/借/还/理财全部不可用**",
    ]
    if not _on:
        lines.append("🚫 该功能当前已关闭")
    lines.append(_bar_plain())
    return "\n".join(lines)

def build_checkin_rob_hint(plugin) -> str:
    """
    抢银行（1.7.6）：银行子功能，**每天一次、没有参数**。

    ★ 保留本函数只作**兼容**（早期版本把它追加在签到菜单末尾）。
      现在抢银行的详细说明已直接写进「银行功能」菜单里那条指令下面，
      见 build_checkin_bank_menu 的 rob_block。
    """
    ck = plugin.checkin_module
    rb = " / ".join(getattr(ck, "rob_trigger_names", None) or ["抢银行"]) \
        if ck else "抢银行"
    _on = bool(getattr(ck, "rob_enable", True)) if ck else True
    _rate = getattr(ck, "rob_success_rate", 5)
    _lo = getattr(ck, "rob_min", 1)
    _hi = getattr(ck, "rob_max", 10000)
    _days = getattr(ck, "rob_freeze_days", 3)
    _pen = getattr(ck, "rob_fail_penalty_rate", 0.5)
    return "\n".join([
        f"🚨{rb}",
        f"　 **没有参数**，每天只能抢一次",
        f"　 成功（{_rate}%）：抢 {_lo}-{_hi} {_sn(plugin)}（从全群银行里出）",
        f"　 失败：冻结银行 {_days} 天 + 没收一半财产"
        f"（钱包+银行 的 {_pen * 100:.0f}%）",
        f"　 ⚠️ 成功率很低，下手前想清楚",
    ] + ([] if _on else ["　 🚫 该功能当前已关闭"]))


def build_checkin_lottery_menu(plugin) -> str:
    """
    抽奖功能（1.7.6）：**列出全部相关指令** ——
      普通抽奖 / 全部抽奖 / 奖池参与 / 奖池信息。

    ★ 所有指令名都**动态读后台配置**，后台改完立刻生效（含热刷新）。
    """
    ck = plugin.checkin_module
    lt = " / ".join(getattr(ck, "lottery_trigger_names", None) or ["开始抽奖"]) \
        if ck else "开始抽奖"
    # ★★ 1.7.6：「全部抽奖」—— 一个指令抽完当天剩余次数
    lat = " / ".join(getattr(ck, "lottery_all_trigger_names", None)
                     or ["全部抽奖"]) if ck else "全部抽奖"
    _on = bool(getattr(ck, "lottery_enable", True)) if ck else True
    _cost = getattr(ck, "lottery_cost", 100)
    _pmax = getattr(ck, "lottery_prize_max", 500)
    _rate = getattr(ck, "lottery_win_rate", 30)
    _lim = getattr(ck, "lottery_daily_limit", 0)
    # ★ 奖池信息（1.7.6）
    pq = " / ".join(getattr(ck, "pool_trigger_names", None) or ["参与抽奖"])
    pq_info = ((getattr(ck, "pool_info_names", None) or ["奖池"])[0])
    _pfee = getattr(ck, "pool_fee", 500)
    _pslots = getattr(ck, "pool_slots", 10)
    _pmin = getattr(ck, "pool_min", 1000)
    _pool_max = getattr(ck, "pool_max", 10000)
    _pen_on = bool(getattr(ck, "pool_enable", True))
    _ptimeout = getattr(ck, "pool_timeout_hours", 1)
    lines = [
        _bar("抽奖功能"),
        # ---------- ① 普通抽奖 ----------
        f"🎰{lt}",
        "　 **不带参数**，直接发就行",
        f"　 抽一次：花 {_cost} {_sn(plugin)}",
        f"　 中奖概率 {_rate}%，可得 0 ~ {_pmax}",
        "　 （**可能是 0，空手而归**）",
        (f"　 每天最多抽 {_lim} 次" if _lim > 0 else "　 每天次数不限"),
        "",
        # ---------- ② 全部抽奖 ----------
        f"⚡{lat}",
        "　 **不带参数**，一个指令把当天剩余次数**全抽完**",
        (f"　 一次最多抽 {_lim} 次（= 每天上限）" if _lim > 0
         else "　 ⚠️ 本群抽奖不限次数，这个指令会提示改用普通抽奖"),
        "",
        # ---------- ③ 奖池参与 ----------
        f"🎁{pq}",
        "　 **没有参数**，每天每人只能参与一次",
        f"　 入门费 {_pfee} {_sn(plugin)}（归系统，不退）",
        f"　 名额 {_pslots} 人，**满了立刻开奖**",
        (f"　 名额没满：**{_ptimeout:g} 小时**后自动开奖"
         if float(_ptimeout or 0) > 0 else "　 名额没满：不自动开奖（只能等人满）"),
        f"　 奖池 {_pmin} ~ {_pool_max} {_sn(plugin)}（每天随机）",
        "　 开奖时奖池**全额随机分完**，各自进钱包",
        "",
        # ---------- ④ 奖池信息 ----------
        f"💡 查看奖池进度：「{pq_info}」",
        "",
        # ---------- 通用提示 ----------
        "📌 每天签到后，消息末尾也会提示这个玩法",
        "📌 花掉的钱**先扣**，中奖再额外加奖励",
        f"⚠️ 扣成负数就是负债，可以去银行「"
        f"{(getattr(ck, 'loan_trigger_names', None) or ['借款'])[0]}」",
    ]
    if not _on:
        lines.append("🚫 普通抽奖当前已关闭")
    if not _pen_on:
        lines.append("🚫 奖池当前已关闭")
    lines.append(_bar_plain())
    return "\n".join(lines)


def build_checkin_steal_menu(plugin) -> str:

    st = " / ".join(plugin.checkin_module.steal_trigger_names) if plugin.checkin_module else "偷积分"
    return "\n".join([
        _bar("神偷功能"),
        f"🦸{st} @某人",
        f"🦸{st} QQ号",
        "",
        f"💡有概率失败，失败可能被对方反拿{_sn(plugin)}",
        f"💡银行里的{_sn(plugin)}不会被偷",
        _bar_plain(),
    ])


def _mount_common(plugin):
    """坐骑相关菜单的**公共取值**（指令名 + 状态），避免重复。"""
    ck = getattr(plugin, "checkin_module", None)

    def _names(attr, *fallback):
        v = getattr(ck, attr, None) if ck is not None else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return out
        v2 = getattr(plugin, attr, None)
        if isinstance(v2, (list, tuple)) and v2:
            out = [str(x).strip() for x in v2 if str(x).strip()]
            if out:
                return out
        return [str(x) for x in (fallback or ["坐骑"])]

    # 菜单入口（动态，走 mount_menu_names）
    try:
        mmenu = [str(x).strip() for x in plugin._mount_menu_names()
                 if str(x).strip()]
    except Exception:
        mmenu = ["坐骑功能"]
    d = {
        "mmenu": mmenu,
        "title": mmenu[0] if mmenu else "坐骑功能",
        "mt": " / ".join(_names("mount_trigger_names", "我的坐骑", "坐骑")),
        "mt0": _names("mount_trigger_names", "我的坐骑", "坐骑")[0],
        "ml": " / ".join(_names("mount_list_trigger_names", "坐骑列表")),
        "mb": " / ".join(_names("mount_buy_trigger_names", "购买坐骑")),
        "me": " / ".join(_names("mount_equip_names", "装备坐骑")),
        "me0": _names("mount_equip_names", "装备坐骑")[0],
        "mv": " / ".join(_names("mount_view_names", "坐骑查看")),
        "ma": " / ".join(_names("cmd_mount_add_names", "添加坐骑")),
        "md": " / ".join(_names("cmd_mount_del_names", "删除坐骑")),
        # ★★ 市场版：坐骑图片已移除
        "dir": "",
        "greet": bool(getattr(ck, "mount_greet_enable", True)),
        "sn": _sn(plugin),
    }
    return d


def build_checkin_mount_menu(plugin) -> str:
    """
    ★★ 1.7.7：坐骑功能**主菜单** —— 只留「我的坐骑 / 坐骑列表 / 购买坐骑」，
    装备/查看/翻页 与 管理员/图片 拆到两个下级菜单。

    指令名全部动态读后台配置，改完立刻生效。
    """
    c = _mount_common(plugin)
    return "\n".join([
        _bar(c["title"]),
        f"📋{' / '.join(c['mmenu'])}",
        "　 也就是本菜单（坐骑相关指令总览）",
        "",
        f"🐴{c['mt']} 页码",
        "　 查看已拥有坐骑和当前骑乘（每页 10 个）",
        f"　 例：「{c['mt0']} 2」看第 2 页",
        "",
        f"🛒{c['ml']} 页码",
        "　 浏览可购买坐骑（每页 10 个）",
        "",
        f"💰{c['mb']} 坐骑名 / 序号",
        f"　 消耗{c['sn']}购买坐骑",
        "",
        # ---------- 下级菜单入口 ----------
        "── 下级菜单（发下面的名字即可打开）──",
        f"🎽{_entry_name(plugin, 'mount_manage', '坐骑管理')}",
        f"　 装备坐骑 / {c['mv']}详情 / 翻页说明",
        f"🛠{_entry_name(plugin, 'mount_admin', '坐骑设置')}",
        "　 管理员指令 / 坐骑图片目录 / 登场提示",
        "",
        ("🌟 每天第一句话：有装备的人会「闪亮登场」"
         if c["greet"] else "🚫 每天登场提示已关闭"),
        _bar_plain(),
    ])


def build_checkin_mount_manage_menu(plugin) -> str:
    """坐骑下级菜单：坐骑管理（装备 / 查看 / 翻页）"""
    c = _mount_common(plugin)
    return "\n".join([
        _bar("坐骑管理"),
        f"🎽{c['me']} 坐骑名 / 序号",
        "　 装备坐骑（必须已购买）",
        "　 序号按「已拥有列表」的编号",
        f"　 例：「{c['me0']} 1」装备第 1 只",
        "",
        f"🖼{c['mv']} 坐骑名 / 序号",
        "　 查看坐骑详情（没买也能看图和价格）",
        "　 坐骑图在昵称下方、坐骑名上方",
        "　 ✨ 骑乘加成（偷积分 / 抢银行成功率）只在这里显示",
        "",
        "📄 翻页：指令后面加页码",
        "　 序号是绝对编号（第 2 页从 11 开始），购买/装备直接用",
        "　 「坐骑查看」的序号两套都认：商店序号 或 已拥有序号",
        "",
        f"🐴{c['mt']} 页码　查看已拥有",
        _bar_plain(),
    ])


def build_checkin_mount_admin_menu(plugin) -> str:
    """坐骑下级菜单：坐骑设置（管理员指令 / 图片 / 登场提示）"""
    c = _mount_common(plugin)
    return "\n".join([
        _bar("坐骑设置"),
        f"🛠 管理员指令",
        f"　 添加：{c['ma']} 名|价格|描述",
        f"　 删除：{c['md']} 名/序号",
        "　 ⚠️ 需要插件专属管理员权限",
        "",
        "📁 坐骑图片：按坐骑名从素材目录找同名图",
        f"　 {c['dir']}",
        "　 例：坐骑叫「赤兔」就放 赤兔.png",
        "　 支持 png / jpg / jpeg / webp / gif / bmp",
        "　 后台「坐骑功能」页可改目录、也能看每只的识别结果",
        "",
        ("🌟 每天第一句话：有装备的人会「闪亮登场」"
         if c["greet"] else "🚫 每天登场提示已关闭"),
        "　 后台 mount_greet_enable 可开关",
        _bar_plain(),
    ])


def build_checkin_shop_menu(plugin) -> str:
    """
    ★★ 1.7.7：**已弃用** —— 商店列表现在由 `checkin.do_shop_list()` 渲染
    （它是**指令**输出，支持分页、只显示商品）。

    这个函数保留只为兼容 `MENU_REGISTRY` 里 `checkin_shop` 那条历史记录
    （它没有菜单入口，不会被触发）。真正给用户看的说明在
    `build_checkin_shop_help_menu()`。
    """
    ck = getattr(plugin, "checkin_module", None)

    def _n(attr, *fb):
        v = getattr(ck, attr, None) if ck is not None else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return " / ".join(out)
        return " / ".join(fb)

    _shop = _n("shop_trigger_names", "签到商店")
    _buy = _n("shop_buy_trigger_names", "购买物品")
    _save = _n("shop_save_trigger_names", "存钱")
    _take = _n("shop_take_trigger_names", "取钱")
    # ★★ 1.7.7：启用武器 / 我的装备（后台可自定义）
    _eq = _n("shop_equip_trigger_names", "启用武器")
    _me = _n("my_equip_trigger_names", "我的装备")
    _base = getattr(ck, "steal_success_rate", 50)
    _vr = getattr(ck, "vault_steal_reduce", 15)
    _cap = getattr(ck, "shop_defense_cap", 60)
    # ★★ 1.7.7：武器破保险箱规则（没开就不显示那两行）
    _brate = float(getattr(ck, "vault_break_rate", 0.0) or 0.0)
    _bratio = float(getattr(ck, "vault_break_ratio", 1.0) or 1.0)
    _bdestroy = bool(getattr(ck, "vault_break_destroy", False))
    _sn_txt = _sn(plugin)      # ★ 别起名 _sn，会遮蔽模块里的 _sn() 函数

    def _fmt(v):
        """15.0 -> 15 ；7.5 -> 7.5（和坐骑加成一致的显示风格）"""
        try:
            f = float(v)
        except Exception:
            return str(v)
        return str(int(round(f))) if abs(f - round(f)) < 1e-9 else f"{f:g}"

    _n_items = len(getattr(ck, "shop_list", None) or [])
    return "\n".join([
        _bar("签到商店"),
        f"🛒{_shop}",
        "　 查看可买的东西（含价格与效果）",
        f"　 共 {_n_items} 件商品（后台可增删改）",
        "",
        f"💰{_buy} 名字 / 序号",
        f"　 花{_sn_txt}购买（每样只需买一次）",
        "",
        "🧰 保险箱（买一次，永久有效）",
        "　 · 「签到统计」里会多显示保险箱余额",
        "　 · 可以把钱**存进保险箱** —— 存进去的钱**别人偷不走**",
        f"　 · 被偷概率 **-{_fmt(_vr)}%**",
        f"　 存钱：「{_save} 金额」",
        f"　 取钱：「{_take} 金额」",
        "　 （想全存全取：金额写「全部」）",
        "",
        "⚔️ 武器（买一次，**需启用才加成**）",
        f"　 · 提高**你偷别人**的成功率（基础 {_base}%）",
        "　 · 部分武器还能降低**别人偷你**的成功率",
        f"　 · 防御加成最多叠加到 -{_fmt(_cap)}%",
        "　 · ⚠️ **买了不等于生效** —— 要用下面的「启用武器」选出在用的那把",
        f"　 启用：`{_eq} 名字 / 序号`",
        f"　 查看：`{_me}`（当前装备 + 全部加成明细）",
        "",
        "📌 偷积分成功率 = 基础 + 坐骑加成 + 武器加成 − 对方防御",
        "📌 只有**当前启用**的那把武器算加成，换掉后旧的就不生效了",
        "📌 偷到的钱按 **钱包 → 银行 → 保险箱** 依次拿",
        "",
        # ★★ 1.7.7：武器破保险箱（只有开了才有这行）
        *(["🔨 **武器破保险箱**：钱包和银行都掏空后，",
           f"　 带武器才有概率撬开对方保险箱（{_fmt(_brate)}%）"
           + ("，抢走箱内全部" if _bratio >= 1 else
              f"，抢走箱内 {int(_bratio * 100)}%")
           + ("，并砸毁保险箱" if _bdestroy else ""),
           "　 没带武器就偷不到保险箱里的钱"]
          if _brate > 0 else []),
        _bar_plain(),
    ])


def build_checkin_shop_help_menu(plugin, page=1) -> str:
    """
    ★★ 1.7.7：**商店帮助**菜单（分页）—— 讲清楚商店所有玩法与指令。

    ★ 分页原因：商店现在有 保险箱 / 武器 / 食物 三类 + 体力、加班、
      装备等一整套指令，一页放不下（用户要求分页，每页 10 条以内）。
    ★ 第 1 页 = 怎么买/怎么用（含所有指令），第 2 页 = 各类商品效果说明，
      第 3 页 = 体力与食物、加班。每页都不长。
    """
    ck = getattr(plugin, "checkin_module", None)
    page = _pg(page)

    def _n(attr, *fb):
        v = getattr(ck, attr, None) if ck is not None else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return out[0]
        return fb[0] if fb else ""

    _shop = _n("shop_trigger_names", "签到商店")
    _buy = _n("shop_buy_trigger_names", "购买商品")
    _save = _n("shop_save_trigger_names", "存入保险箱")
    _take = _n("shop_take_trigger_names", "取出保险箱")
    _eq = _n("shop_equip_trigger_names", "启用武器")
    _me = _n("my_equip_trigger_names", "我的装备")
    _eat = _n("food_eat_trigger_names", "吃食物")
    _st = _n("stamina_view_trigger_names", "我的体力")
    _ot = _n("stamina_refill_trigger_names", "加班")
    _jl = _n("job_info_trigger_names", "打工列表")
    _sn_txt = _sn(plugin)
    _base = getattr(ck, "steal_success_rate", 50)
    _vr = getattr(ck, "vault_steal_reduce", 15)
    _cap = getattr(ck, "shop_defense_cap", 60)
    _mx = getattr(ck, "stamina_max", 100)
    _slo = getattr(ck, "job_stamina_min", 1)
    _shi = getattr(ck, "job_stamina_max", 5)
    _food = getattr(ck, "stamina_food_restore", 30)
    _per = getattr(ck, "stamina_refill_per_hour", 10)
    _omin = getattr(ck, "stamina_refill_min", 5)
    _brate = float(getattr(ck, "vault_break_rate", 0.0) or 0.0)
    _bratio = float(getattr(ck, "vault_break_ratio", 1.0) or 1.0)
    _bdestroy = bool(getattr(ck, "vault_break_destroy", False))
    _title = _entry_name(plugin, "checkin_shop_help", "商店帮助")

    def _pages_of(p: int) -> list:
        if p == 0:
            # ★★ 1.7.7：**指令和说明分行** ——
            #   以前用全角空格把说明挤在同一行（「💰购买商品 名字 / 序号　　买东西…」），
            #   命令名一长就超出渲染宽度，断行位置乱七八糟（用户反馈「没换行」）。
            #   现在统一成「指令一行 + 说明缩进一行」，和其它菜单一致。
            rows = [
                _bar(_title),
                # ★★ 1.7.7：这里**不再显示「签到商店」指令** ——
                #   用户要求把它从商店帮助里移除（商品列表进「签到商店」
                #   菜单看就行，不必在帮助里再列一条）。
                "── 所有指令 ──",
            ]

            def _c(cmd: str, desc: str) -> None:
                rows.append(cmd)
                rows.append(f"　 {desc}")

            _c(f"💰{_buy} 名字 / 序号", "买东西（食物可重复买）")
            _c(f"🛒{_buy} 食物名 数量", "食物一次买多个，例：买 3 个面包")
            _c(f"⚔️{_eq} 名字 / 序号", "启用武器（**武器必须启用才加成**）")
            _c(f"🎽{_me}", "看当前装备 + 全部加成明细")
            _c(f"🍖{_eat} 名字 [数量]", "吃食物回体力（不带数量=吃 1 个）")
            _c(f"🔋{_st}", "看当前体力 + 背包食物")
            _c(f"🔥{_ot} [工种名 / 全部]", "花体力一键清打工冷却")
            _c(f"📋{_jl}", "看工种、收益、体力消耗")
            _c(f"🔨{_save} 金额", "把钱存进保险箱（偷不走）")
            _c(f"📤{_take} 金额", "从保险箱取回")
            # rows += [
            #     "",
            #     f"💡 用「{_shop} 2」可以翻到第 2 页商品",
            #     f"💡 翻本说明：「{_title} 2」",
            # ]
            return rows
        if p == 1:
            rows = [
                _bar(_title),
                "🧰 保险箱（买一次，永久有效）",
                "　 · 可以把钱**存进保险箱**",
                "　 · 存进去的钱**别人偷不走**",
                f"　 · 被偷概率 **-{_fmt(_vr)}%**",
                f"　 存钱：「{_save} 金额」",
                f"　 取钱：「{_take} 金额」",
                "　 （想全存全取：金额写「全部」）",
                "",
                "⚔️ 武器（买一次，**需启用才加成**）",
                f"　 · 提高**你偷别人**的成功率（基础 {_base}%）",
                "　 · 部分武器还能降低**别人偷你**的成功率",
                f"　 · 防御加成最多叠加到 -{_fmt(_cap)}%",
                "　 · ⚠️ **买了不等于生效**",
                f"　 要用「{_eq}」选出在用的那把",
                "",
                "🍖 食物（消耗品，可重复买）",
                "　 · 吃了解恢复体力",
                "　 （恢复量见商店里每种食物的标注）",
                f"　 · 用「{_eat} 名字 / 序号 / 全部」吃",
            ]
            if _brate > 0:
                rows += [
                    "",
                    "🔨 **武器破保险箱**",
                    "　 · 钱包和银行都掏空后，",
                    "　 带武器才有概率撬开对方保险箱",
                    f"　 · 概率 {_fmt(_brate)}%"
                    + ("，抢走箱内全部" if _bratio >= 1
                       else f"，抢走箱内 {int(_bratio * 100)}%")
                    + ("，并砸毁保险箱" if _bdestroy else ""),
                ]
            rows += [
                "",
                "📌 偷积分拿钱顺序",
                "　 钱包 → 银行 → 保险箱",
                "📌 偷失败要赔付对方",
                "　 钱包 → 银行（不动保险箱）",
            ]
            return rows
        # p == 2
        return [
            _bar(_title),
            "⚡ 体力系统",
            f"　 · 每人每天 **{_fmt(_mx)}** 点",
            "　 · **每天 0 点回满**",
            "　 · ⚠️ 不累积（昨天没用完的第二天清零）",
            f"　 · 打工消耗：每工种随机 **{_fmt(_slo)}~{_fmt(_shi)}** 体力",
            f"　 · 查看：「{_st}」",
            "",
            "🍖 食物恢复体力",
            f"　 · 在「{_shop}」里买（可重复买）",
            f"　 · 吃：「{_eat} 名字」",
            f"　 吃多个：「{_eat} 名字 3」",
            f"　 · 默认恢复 +{_fmt(_food)}",
            "　 （每种食物可单独设）",
            "",
            "🔥 加班（花体力一键清冷却）",
            f"　 「{_ot}」",
            "　 列出冷却中的工种 + 各需多少体力",
            f"　 「{_ot} 工种名」",
            "　 立刻清掉该工种冷却，马上接着做",
            f"　 「{_ot} 全部」",
            "　 把所有冷却中的一起清",
            "　 · 消耗 = 剩余小时 × "
            f"{_fmt(_per)}（最低 {_fmt(_omin)}）",
        ]

    pages = 3
    p = max(1, min(page, pages))
    body = _pages_of(p - 1)
    body.append("")
    body.append(f"📄 第 {p} / {pages} 页")
    if p > 1:
        body.append(f"⬅️ 上一页：「{_title} {p - 1}」")
    if p < pages:
        body.append(f"➡️ 下一页：「{_title} {p + 1}」")
    body.append(_bar_plain())
    return "\n".join(body)


def build_speak_menu(plugin) -> str:
    m = getattr(plugin, "speak_stats_module", None)

    def names(attr, dflt):
        v = getattr(m, attr, None) if m else None
        return " / ".join(v) if v else dflt

    return "\n".join([
        _bar("发言功能"),
        f"\U0001f4ac{names('rank_yesterday_names', '本群发言排行')}",
        "\u3000**昨日**的发言次数前十（隔日结算）",
        "",
        f"\U0001f525{names('rank_active_names', '本群活跃排行')}",
        "\u3000连续活跃天数前十（断一天重新计算）",
        "",
        f"\U0001f4c5{names('rank_week_names', '本群上周排行')}",
        "\u3000**前 7 日**发言次数前十",
        "",
        f"\U0001f4c6{names('rank_month_names', '本群上月排行')}",
        "\u3000**前 30 日**发言次数前十",
        "",
        f"\U0001f464{names('my_stat_names', '个人发言统计')}",
        "\u3000查看自己的累计发言与活跃天数",
        _bar_plain(),
    ])


def _pet_common(plugin):
    """宠物相关菜单的**公共取值**（指令名），拆成小工具避免重复。"""
    m = getattr(plugin, "pet_module", None)

    def names(attr, dflt):
        v = getattr(m, attr, None) if m else None
        if isinstance(v, (list, tuple)) and v:
            out = [str(x).strip() for x in v if str(x).strip()]
            if out:
                return " / ".join(out)
        return dflt

    def first(attr, dflt):
        s = names(attr, dflt)
        return (s.split(" / ") or [dflt])[0]

    d = {
        "sn": _sn(plugin),
        "shop": names("cmd_shop", "宠物商店"),
        "buy": names("cmd_buy", "购买宠物"),
        "mine": names("cmd_mine", "我的宠物"),
        "view": names("cmd_view", "宠物查看"),
        "sell": names("cmd_sell", "出售宠物"),
        "rel": names("cmd_release", "放生宠物"),
        "adv": names("cmd_adventure", "宠物冒险"),
        "rest": names("cmd_rest", "宠物休息"),
        "duel": names("cmd_duel", "宠物决斗"),
        "hispet": names("cmd_his_pet", "他的宠物"),
        "work": names("cmd_work", "宠物上班"),
        "ishop": names("cmd_item_shop", "物品商店"),
        "ibuy": names("cmd_item_buy", "购买物品"),
        "iuse": names("cmd_item_use", "使用物品"),
    }
    for k in ("shop", "buy", "mine", "view", "sell", "rel", "adv", "rest",
              "duel", "hispet", "work", "ishop", "ibuy", "iuse"):
        d[k + "0"] = (d[k].split(" / ") or [k])[0]
    return d


def build_pet_menu(plugin) -> str:
    """
    ★★ 1.7.6：宠物功能**主菜单** —— 只留「宠物商店 + 物品商店」，其余拆下级。

    为什么拆：以前这一个菜单 512 字 / 50 行，养宠、战斗、道具全挤在一起，
    卡片很高、翻半天找不到想要的那条。
    """
    d = _pet_common(plugin)
    sn = d["sn"]
    return "\n".join([
        _bar("宠物功能"),
        f"\U0001f6d2{d['shop']} [页码]",
        "\u3000浏览宠物商店（每页 20 种）",
        "",
        f"\U0001f9ea{d['ishop']}",
        "\u3000查看可购买的道具",
        "",
        "── 下级菜单（发下面的名字即可打开）──",
        f"❓{_entry_name(plugin,'pet_care','宠物养成')}",
        f"\u3000买 / 看 / 卖 / 放生宠物，我的宠物列表",
        f"❓{_entry_name(plugin,'pet_fight','宠物玩法')}",
        f"\u3000{d['adv0']} / {d['rest0']} / {d['work0']} / {d['duel0']}",
        f"❓{_entry_name(plugin,'pet_item','宠物道具')}",
        f"\u3000{sn}买道具、对宠物使用道具",
        _bar_plain(),
    ])


def build_pet_care_menu(plugin) -> str:
    """宠物下级菜单：养成操作（买/看/卖/放生/列表）"""
    d = _pet_common(plugin)
    sn = d["sn"]
    return "\n".join([
        _bar("宠物养成"),
        f"\U0001f4b0{d['buy']} 宠物名",
        f"\u3000消耗{sn}购买（每种每人都能买一只）",
        "",
        f"\U0001f43e{d['mine']}",
        "\u3000查看自己已拥有的宠物",
        "",
        f"\U0001f50d{d['view']} 宠物名",
        "\u3000查看等级 / 经验 / 属性 / 冷却",
        "",
        f"\U0001f4e4{d['sell']} 宠物名",
        "\u3000出售（返还市场价 75%）",
        "",
        f"\U0001f54a{d['rel']} 宠物名",
        "\u3000免费放生",
        "",
        f"\U0001f43e{d['hispet']} @某人",
        "\u3000查看对方的宠物列表",
        _bar_plain(),
    ])


def build_pet_fight_menu(plugin) -> str:
    """宠物下级菜单：对战玩法（冒险/休息/上班/决斗）"""
    d = _pet_common(plugin)
    sn = d["sn"]
    return "\n".join([
        _bar("宠物玩法"),
        f"\U0001f5fa{d['adv']} [宠物名]",
        "\u3000冒险获得经验（消耗体力血量，有概率直升一级）",
        "",
        f"\U0001f4a4{d['rest']} [宠物名]",
        "\u3000休息恢复体力与血量（不带名字则全部休息）",
        "",
        f"\U0001f4bc{d['work']} [宠物名]",
        f"\u3000随机事件获得经验与{sn}",
        "",
        f"\u2694\ufe0f{d['duel']} @某人",
        "\u3000**双方随机**各出一只（五行克制有加成）",
        f"\u2694\ufe0f影 {d['duel0']} @某人",
        "\u3000指定**自己的**宠物（对方随机）",
        f"\u2694\ufe0f影 {d['duel0']} @某人 雷龙",
        "\u3000**双方都指定**宠物",
        _bar_plain(),
    ])


def build_pet_item_menu(plugin) -> str:
    """宠物下级菜单：道具（商店/购买/使用）"""
    d = _pet_common(plugin)
    sn = d["sn"]
    return "\n".join([
        _bar("宠物道具"),
        f"\U0001f9ea{d['ishop']}",
        "\u3000查看可购买的道具",
        "",
        f"\U0001f6cd{d['ibuy']} 物品名 [数量]",
        f"\u3000消耗{sn}购买道具",
        "",
        f"\U0001fa79{d['iuse']} 物品名 [宠物名]",
        "\u3000对宠物使用道具",
        _bar_plain(),
    ])
















def build_checkin_job_menu(plugin) -> str:
    jl = " / ".join(plugin.checkin_module.job_info_trigger_names) if plugin.checkin_module else "打工列表"
    jw = " / ".join(plugin.checkin_module.job_trigger_names) if plugin.checkin_module else "打工"
    # ★★ 1.7.6：「全部打工」指令名（后台可自定义），菜单里要同步显示。
    #   新增功能**必须**补进对应菜单，否则用户看不到有这条指令。
    ja = " / ".join(
        getattr(plugin.checkin_module, "job_all_trigger_names", None)
        or ["全部打工"]) if plugin.checkin_module else "全部打工"
    return "\n".join([
        _bar("打工功能"),
        f"🔨{jw} 工种名",
        f"　 打工赚{_sn(plugin)}（各工种有独立冷却）",
        "",
        f"⚡{ja}",
        "　 一次把所有工种各打一遍（冷却中的自动跳过）",
        *([f"　 每个工种随机消耗 "
           f"{getattr(plugin.checkin_module, 'job_stamina_min', 1)}~"
           f"{getattr(plugin.checkin_module, 'job_stamina_max', 5)} 体力"]
          if getattr(plugin.checkin_module, "stamina_enable", False) else []),
        "",
        "── 下级菜单 ──",
        f"📋{_entry_name(plugin, 'job_list', '打工列表')}",
        "　 看工种 / 收益 / 体力消耗",
        f"🔥{_entry_name(plugin, 'job_refill', '加班')}",
        "　 花体力一键清冷却，马上接着干",
        _bar_plain(),
    ])


def build_stamina_menu(plugin) -> str:
    """
    ★★ 1.7.7：我的体力菜单（签到系统下级）。

    ★ 只讲「体力怎么来、怎么用、怎么补」，数值实时读后台配置。
    """
    _ck = getattr(plugin, "checkin_module", None)
    _mx = getattr(_ck, "stamina_max", 100) if _ck else 100
    _lo = getattr(_ck, "job_stamina_min", 1) if _ck else 1
    _hi = getattr(_ck, "job_stamina_max", 5) if _ck else 5
    _food = getattr(_ck, "stamina_food_restore", 30) if _ck else 30
    _vc = _entry_name(plugin, "stamina", "我的体力")
    return "\n".join([
        _bar(_vc),
        f"🔋{_vc}",
        "　 看当前体力 + 背包食物",
        "",
        "── 怎么获得 ──",
        f"📅 每人每天 {_mx} 点，**每天 0 点回满**",
        "　 ⚠️ 不累积：昨天没用完的不会留到今天",
        "🍖 吃食物可以**立刻**恢复体力（「吃食物 面包 3」一次吃 3 个）",
        f"　 默认 +{_food}（每种食物可单独设）",
        "",
        "── 怎么消耗 ──",
        f"🔨 打工：每个工种随机消耗 {_lo}~{_hi} 体力",
        "🔥 加班：花体力一键清掉工种冷却",
        "",
        "── 常用指令 ──",
        f"🔋{_vc}",
        f"🍖{_entry_name(plugin, 'stamina', '我的体力')} 名字 [数量] / 全部",
        f"🔥{_entry_name(plugin, 'job_refill', '加班')} 工种名",
        "",
        f"💡 食物在「{_entry_name(plugin, 'checkin_shop_help', '签到商店')}」里买",
        _bar_plain(),
    ])


def build_checkin_job_list_menu(plugin) -> str:
    """★ 1.7.7：打工列表 — 工种明细 + 怎么开始"""
    _ck = getattr(plugin, "checkin_module", None)
    jw = (" / ".join(_ck.job_trigger_names) if _ck else "打工")
    ja = (" / ".join(getattr(_ck, "job_all_trigger_names", None)
                     or ["全部打工"])) if _ck else "全部打工"
    _st_on = bool(getattr(_ck, "stamina_enable", True)) if _ck else False
    rows = [_bar(_entry_name(plugin, "job_list", "打工列表")), ""]
    jl = (getattr(_ck, "job_list", None) or []) if _ck else []
    if not jl:
        rows += ["暂无工种，请联系管理员添加", ""]
    else:
        rows.append(f"共 {len(jl)} 个工种：")
        for i, j in enumerate(jl[:12], start=1):
            rows.append(f"  {i}. {j.get('name')} —— 冷却 "
                        f"{j.get('duration_hours')} 小时"
                        f"（{j.get('reward_min')}~{j.get('reward_max')} "
                        f"{_sn(plugin)}）")
        if len(jl) > 12:
            rows.append(f"  …… 还有 {len(jl) - 12} 个")
        rows.append("")
    if _st_on and _ck is not None:
        rows.append(f"⚡ 每个工种消耗 "
                    f"{getattr(_ck, 'job_stamina_min', 1)}~"
                    f"{getattr(_ck, 'job_stamina_max', 5)} 体力")
        rows.append(f"　 💡 看体力：「"
                    f"{_entry_name(plugin, 'stamina', '我的体力')}」")
        rows.append("")
    rows.append(f"💡 开始打工：「{jw.split(' / ')[0]} 工种名」")
    rows.append(f"💡 一键全打：「{ja.split(' / ')[0]}」")
    rows.append(_bar_plain())
    return "\n".join(rows)


def build_checkin_job_refill_menu(plugin) -> str:
    """
    ★★ 1.7.7：加班**主菜单**（用户要求：输出下级菜单）。

      · 加班功能   -> 本页（下级菜单：加班状态 / 加班）
      · 加班状态   -> 只列「可加班 / 不可加班」工种
      · 加班 工种 / 全部加班 -> 真正扣体力清冷却
    """
    _ck = getattr(plugin, "checkin_module", None)
    # 三条指令名各自读配置（都可在后台改）
    #   ★ 主菜单入口名 = 「加班功能」；**执行指令名**是另一个键
    #     （默认「加班」），别混用 —— 以前拿入口名当指令名，菜单里会
    #     显示成「加班功能 工种名」（用户根本敲不出来）。
    _st_cmd = str(_entry_name(plugin, "job_refill_status", "加班状态")
                  ).split(" / ")[0]
    _cmd = ((getattr(_ck, "stamina_refill_trigger_names", None)
             or ["加班"])[0]) if _ck else "加班"
    _all_cmd = ((getattr(_ck, "stamina_refill_all_names", None)
                 or ["全部加班"])[0]) if _ck else "全部加班"
    per = getattr(_ck, "stamina_refill_per_hour", 10) if _ck else 10
    _min = getattr(_ck, "stamina_refill_min", 5) if _ck else 5
    return "\n".join([
        _bar(_entry_name(plugin, "job_refill", "加班功能")),
        "── 下级菜单 ──",
        f"📊{_st_cmd}",
        "　 看哪些工种可以加班、哪些不行",
        f"🔥{_cmd} 工种名",
        "　 单独加班**一个**工种（只清它的冷却）",
        f"🔥{_all_cmd}",
        "　 加班**所有**冷却中的工种",
        # ★ 用户要求：裸「加班」不输出内容，所以菜单里别把它列成一条
        f"　 💡 只打「{_cmd}」两个字没有反应，要带上工种名",
        "",
        "── 消耗规则 ──",
        f"⚡ 每 1 小时冷却 = {per} 体力",
        "　 不足 1 小时按 1 小时算",
        f"⚡ 最低消耗：{_min} 体力",
        "",
        "💡 体力每天 0 点回满，用食物可以立刻补",
        _bar_plain(),
    ])


def build_checkin_job_refill_status_menu(plugin) -> str:
    """
    ★★ 1.7.7：加班状态菜单（下级菜单入口）。

    ★ 这里只做**入口说明** —— 真正的「可加班 / 不可加班工种」列表
      是**按人、按时间**算出来的（要看你自己各工种的冷却），
      菜单是静态文案，所以发这条指令时走的是
      `CheckinModule.do_stamina_refill()` 的实时分支（见 main.py 分发）。
      菜单只是告诉用户这条指令干什么。
    """
    _ck = getattr(plugin, "checkin_module", None)
    _st_cmd = str(_entry_name(plugin, "job_refill_status", "加班状态")
                  ).split(" / ")[0]
    # ★ 这里同样是**执行指令名**（不是菜单入口名）
    _cmd = ((getattr(_ck, "stamina_refill_trigger_names", None)
             or ["加班"])[0]) if _ck else "加班"
    _all_cmd = ((getattr(_ck, "stamina_refill_all_names", None)
                 or ["全部加班"])[0]) if _ck else "全部加班"
    _mx = getattr(_ck, "stamina_max", 100) if _ck else 100
    return "\n".join([
        _bar(_st_cmd),
        f"📊{_st_cmd}",
        "　 列出**可加班**（正在冷却）和**不可加班**的工种",
        "　 可加班的会标出清掉冷却需要多少体力",
        "",
        "── 相关指令 ──",
        f"🔥{_all_cmd}",
        "　 把所有冷却中的工种一起清掉",
        f"🔥{_cmd} 工种名",
        "　 只清指定工种",
        "",
        f"⚡ 体力上限 {_mx}，每天 0 点回满",
        "💡 完整说明看「" + _cmd + "」",
        _bar_plain(),
    ])


# ============================================================
# 管理系统 · 二级子菜单
# ============================================================
def build_meme_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("接口管理"),
        f"➕{_sv(plugin.cmd_add_name)} 关键词1,关键词2 | URL模板 | 参数个数 | 返回类型",
        f"🗑{_sv(plugin.cmd_del_name)} 序号",
        f"💾{_sv(plugin.cmd_save_name)}",
        "",
        "💡返回类型填 image=图片 / video=视频 / text=文本；无参数接口参数个数填 0",
        _bar_plain(),
    ])


def build_word_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("词库管理"),
        f"➕{_sv(plugin.cmd_word_add_name)} 关键词 | 回复内容",
        f"🗑{_sv(plugin.cmd_word_del_name)} 序号",
        f"📋{_sv(plugin.cmd_word_list_name)}",
        _bar_plain(),
    ])


def build_checkin_admin_menu(plugin) -> str:
    """
    签到管理：签到系统的管理指令（工种 / 坐骑 / 积分调整）。

    ★ 加减积分属于签到系统的管理指令，放在这里。
      指令名读插件属性，读不到再用默认值。
    """
    # ★ 加减积分的指令名在**签到模块**里（score_add/sub_trigger_names），
    #   不在插件属性上，所以从 checkin_module 读。
    _ck = getattr(plugin, "checkin_module", None)
    _adds = getattr(_ck, "score_add_trigger_names", None) or ["加积分"]
    _subs = getattr(_ck, "score_sub_trigger_names", None) or ["减积分"]
    add = str(_adds[0]).strip() or "加积分"
    sub = str(_subs[0]).strip() or "减积分"
    # ★★ 1.7.7：清空财富（管理员，不可撤销）
    _wipes = getattr(_ck, "wipe_wealth_trigger_names", None) or ["清空财富"]
    wipe = str(_wipes[0]).strip() or "清空财富"
    # 工种 / 坐骑：配置里常写多个别名（逗号分隔），
    # 取主名显示，其余折成「别名：…」一行，避免标题被撑得又长又乱。
    def _split(v):
        return [x.strip() for x in str(v or "").replace("，", ",").split(",")
                if x.strip()]

    ja = _split(_sv(getattr(plugin, "cmd_job_add_name", ""))) or ["添加工种"]
    jd = _split(_sv(getattr(plugin, "cmd_job_del_name", ""))) or ["删除工种"]
    ma = _split(_sv(getattr(plugin, "cmd_mount_add_name", ""))) or ["添加坐骑"]
    md = _split(_sv(getattr(plugin, "cmd_mount_del_name", ""))) or ["删除坐骑"]

    lines = [
        _bar("签到管理"),
        f"➕{add} @某人 数量",
        f"　 给某人增加{_sn(plugin)}（也可写「QQ号 数量」）",
        f"➖{sub} @某人 数量",
        f"　 给某人减少{_sn(plugin)}（减到 0 为止）",
        f"🧹{wipe} @某人 / QQ号",
        "　 把某人**全部财富**清零（钱包/银行/保险箱/欠款/理财）",
        "　 ⚠️ 不可撤销；签到次数、坐骑、武器、食物都保留",
        "",
        f"🔨{ja[0]} 工种名 | 冷却小时 | 最少收益 | 最多收益",
        f"🗑{jd[0]} 工种名或序号",
        f"🐴{ma[0]} 坐骑名 | 价格 | 描述",
        f"🗑{md[0]} 坐骑名或序号",
    ]
    _alias = []
    for _tag, _ns in (("加积分", _adds[1:]), ("减积分", _subs[1:]),
                      ("添加工种", ja[1:]), ("删除工种", jd[1:]),
                      ("添加坐骑", ma[1:]), ("删除坐骑", md[1:])):
        if _ns:
            _alias.append(f"{_tag}={'/'.join(_ns)}")
    if _alias:
        lines.append("")
        lines.append("别名：" + "　".join(_alias))
    lines.append(_bar_plain())
    return "\n".join(lines)


def build_status_admin_menu(plugin) -> str:
    names = " / ".join(plugin.cmd_status_names)
    return "\n".join([
        _bar("状态管理"),
        f"🖥️电脑状态：{names}",
        f"🔔{_sv(plugin.cmd_daily_push_on_name)} ［群号］",
        f"🔕{_sv(plugin.cmd_daily_push_off_name)} ［群号］",
        f"🕐{_sv(plugin.cmd_daily_push_time_name)} ［群号］ 09:00",
        f"📋{_sv(plugin.cmd_daily_push_list_name)}",
        _bar_plain(),
    ])


def build_switch_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("开关管理"),
        f"🟢{_sv(plugin.cmd_enable_name)}",
        f"🔴{_sv(plugin.cmd_disable_name)}",
        f"🟢{_sv(plugin.cmd_enable_feature_name)} 运势 ［群号］",
        f"🔴{_sv(plugin.cmd_disable_feature_name)} 运势 ［群号］",
        f"📊{_sv(plugin.cmd_feature_status_name)} ［群号］",
        _bar_plain(),
    ])


def build_chime_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("整点管理"),
        f"🟢{_sv(plugin.cmd_chime_on_name)} ［群号］",
        f"🔴{_sv(plugin.cmd_chime_off_name)} ［群号］",
        f"📊{_sv(plugin.cmd_chime_status_name)} ［群号］",
        f"🕐{_sv(plugin.cmd_chime_hours_name)} 8,12,20",
        f"✏️{_sv(plugin.cmd_chime_text_name)} 自定义文案",
        f"📋{_sv(plugin.cmd_chime_list_name)}",
        f"🚀{_sv(plugin.cmd_chime_test_name)} ［群号］",
        _bar_plain(),
    ])


def build_must_at_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("艾特设置"),
        f"🟢{_sv(plugin.cmd_must_at_bot_on_name)} ［群号］",
        f"🔴{_sv(plugin.cmd_must_at_bot_off_name)} ［群号］",
        f"📊{_sv(plugin.cmd_must_at_bot_status_name)} ［群号］",
        _bar_plain(),
    ])


def build_super_admin_menu(plugin) -> str:
    return "\n".join([
        _bar("超管设置"),
        f"➕{_sv(plugin.cmd_add_admin_name)} QQ号",
        f"🗑{_sv(plugin.cmd_del_admin_name)} QQ号",
        f"📋{_sv(plugin.cmd_admin_list_name)}",
        f"👀{_sv(plugin.cmd_view_admin_name)}",
        f"🔄{_sv(plugin.cmd_refresh_admin_name)}",
        _bar_plain(),
    ])


# ============================================================
# 菜单输出内容：后台可自定义
# ============================================================
# 每个菜单的 id 与默认生成函数。默认值会在插件启动时写进后台数据，
# 之后后台改过的内容优先；改回空字符串即恢复默认。
MENU_REGISTRY = {
    "main":            ("主菜单",         "build_main_menu"),
    "meme":            ("接口系统",       "build_meme_menu"),
    "mc":              ("MC系统",         "build_mc_menu"),
    "greeting":        ("打卡系统",       "build_greeting_menu"),
    "checkin":         ("签到系统",       "build_checkin_menu"),
    "daily":           ("每日系列",       "build_daily_menu"),
    "entertain":       ("娱乐功能",       "build_entertain_menu"),
    "qqinfo":          ("查询功能",       "build_qqinfo_menu"),
    "weather":         ("天气查询",       "build_weather_menu"),
    "admin":           ("管理系统",       "build_admin_menu"),
    "fortune":         ("运势功能",       "build_fortune_menu"),
    "husband":         ("老公功能",       "build_husband_menu"),
    "luck":            ("人品功能",       "build_luck_menu"),
    "news":            ("读报功能",       "build_news_menu"),
    "output_mode":     ("输出模式",       "build_output_mode_menu"),
    "meme_feature":    ("接口功能",       "build_meme_feature_menu"),
    "greeting_morning": ("早安打卡",      "build_greeting_morning_menu"),
    "greeting_night":  ("晚安打卡",       "build_greeting_night_menu"),
    "greeting_rank":   ("打卡排行",       "build_greeting_rank_menu"),
    # ★★ 市场版 1.1：赛车功能菜单（分页）
    "racing":         ("赛车功能",      "build_racing_menu"),
    "checkin_signin":  ("签到指令",       "build_checkin_signin_menu"),
    "checkin_query":   ("查询指令",       "build_checkin_query_menu"),
    "checkin_bank":    ("银行功能",       "build_checkin_bank_menu"),
    # ★★ 1.7.6：银行拆成 4 个下级菜单（主菜单只留「账户 + 存取」）
    "checkin_bank_save": ("存钱取钱",     "build_checkin_bank_save_menu"),
    "checkin_bank_loan": ("借款还款",     "build_checkin_bank_loan_menu"),
    "checkin_bank_fund": ("理财功能",     "build_checkin_bank_fund_menu"),
    "checkin_bank_rob":  ("抢银行帮助",    "build_checkin_bank_rob_menu"),
    "checkin_lottery": ("抽奖功能",       "build_checkin_lottery_menu"),
    "checkin_steal":   ("神偷功能",       "build_checkin_steal_menu"),
    "checkin_mount":   ("坐骑功能",       "build_checkin_mount_menu"),
    # ★★ 1.7.7：坐骑拆成两个下级菜单
    "mount_manage":    ("坐骑管理",       "build_checkin_mount_manage_menu"),
    "mount_admin":     ("坐骑设置",       "build_checkin_mount_admin_menu"),
    "checkin_job":     ("打工功能",       "build_checkin_job_menu"),
    # ★★ 1.7.7：打工下级菜单
    "job_list":        ("打工列表",       "build_checkin_job_list_menu"),
    # ★★ 1.7.7：加班主菜单（下级菜单：加班状态 / 加班）
    "job_refill":      ("加班功能",       "build_checkin_job_refill_menu"),
    # ★★ 1.7.7：加班状态（只列可加班 / 不可加班工种）
    "job_refill_status": ("加班状态",     "build_checkin_job_refill_status_menu"),
    # ★★ 1.7.7：体力
    "stamina":         ("我的体力",       "build_stamina_menu"),
    # ★★ 1.7.6 新增：签到商店
    "checkin_shop":    ("签到商店",       "build_checkin_shop_menu"),
    # ★★ 1.7.6：商店帮助 —— 和「签到商店」**输出完全一样**的说明菜单。
    #   分销：`签到商店` 这条**指令**输出商品列表（见 do_shop_list），
    #         `商店帮助` 这个**菜单入口**输出指令说明。
    "checkin_shop_help": ("商店帮助",     "build_checkin_shop_help_menu"),
    "speak":           ("发言功能",       "build_speak_menu"),
    "pet":             ("宠物功能",       "build_pet_menu"),
    # ★★ 1.7.6：宠物拆成 3 个下级菜单（主菜单只留「宠物商店 + 物品商店」）
    "pet_care":        ("宠物养成",       "build_pet_care_menu"),
    "pet_fight":       ("宠物玩法",       "build_pet_fight_menu"),
    "pet_item":        ("宠物道具",       "build_pet_item_menu"),
    # ★★ 1.7.7：猜数游戏（娱乐功能下级）
    "guess":           ("猜数功能",       "build_guess_menu"),
    # ★★ 1.7.7：音乐下级菜单（点歌 / 搜歌 各自独立 + 音源设置）
    "meme_admin":      ("接口管理",       "build_meme_admin_menu"),
    "word_admin":      ("词库管理",       "build_word_admin_menu"),
    "checkin_admin":   ("签到管理",       "build_checkin_admin_menu"),
    "status_admin":    ("状态管理",       "build_status_admin_menu"),
    "switch_admin":    ("开关管理",       "build_switch_admin_menu"),
    "chime_admin":     ("整点管理",       "build_chime_admin_menu"),
    "news_admin":      ("读报管理",       "build_news_admin_menu"),
    "member_admin":    ("成员管理",       "build_member_admin_menu"),
    "must_at_admin":   ("艾特设置",       "build_must_at_admin_menu"),
    "super_admin":     ("超管设置",       "build_super_admin_menu"),
    # ★ 1.7.6：提示功能（管理系统子菜单）
    "notice":          ("提示功能",       "build_notice_menu"),
}


def menu_default(plugin, menu_id: str) -> str:
    """生成某个菜单的**默认**内容（不读后台覆盖）"""
    mid = str(menu_id or "").strip()
    item = MENU_REGISTRY.get(mid)
    if not item:
        return ""
    fn = globals().get(item[1])
    if fn is None:
        return ""
    try:
        # ★ 图鉴菜单：写入后台的「默认文案」不带翻页行，
        #   翻页提示由 main._build_bird_menu 在渲染时按需补上。
        #   这样用户改文案不会残留硬提示，功能用法也不会丢。
        if mid == "bird":
            return str(fn(plugin, with_page_hint=False) or "")
        return str(fn(plugin) or "")
    except Exception:
        return ""


def all_menu_defaults(plugin) -> dict:
    """所有菜单的默认内容（给后台初始化用）"""
    return {k: menu_default(plugin, k) for k in MENU_REGISTRY}


def resolve_menu(plugin, menu_id: str, custom=None) -> str:
    """
    取菜单最终内容：**后台自定义优先**，没有就用默认。

    custom 可以是 dict（menu_id -> 文本）或 None。
    文本为空白则视为「未自定义」，回落到默认。
    """
    if isinstance(custom, dict):
        val = str(custom.get(menu_id) or "").strip()
        if val:
            return val
    return menu_default(plugin, menu_id)
