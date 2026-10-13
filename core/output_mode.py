"""
输出模式（1.7.3）

支持三种输出方式，**按群独立**、可由管理员远程切换：

    text   纯文本（默认，原样输出）
    image  把文本渲染成图片（深色底 + 自适应宽度）

渲染由本地表情包服务 D:/MemeAPI 提供（Pillow 绘制），
调用失败时**自动回落纯文本**，不会因渲染问题丢消息。
"""
import asyncio
import io
import json
import os
import re
import sys
from .path_utils import title_bar, title_foot

from astrbot.api import logger
try:
    import aiohttp
    _HAS_AIOHTTP = True
except Exception:  # pragma: no cover
    _HAS_AIOHTTP = False

# ★★ 1.7.7：图片模式分成两种配色
#   · image      深色卡片（原来那套，白字）
#   · image_light **纯白底 + 黑字**（亮色环境 / 想打印时更清楚）
MODES = ("text", "image", "image_light")
DEFAULT_MODE = "text"
MODE_LABELS = {
    "text": "文本模式",
    "image": "图片模式（深色）",
    "image_light": "图片模式（白底黑字）",
}
# 模式触发词（用户/管理员可发这些来切）
MODE_ALIASES = {
    "文本": "text", "text": "text", "纯文本": "text", "文字": "text",
    "图片": "image", "image": "image", "图片模式": "image", "图": "image",
    # ★★ 1.7.7：白底黑字
    "白底": "image_light", "白底黑字": "image_light",
    "亮色": "image_light", "浅色": "image_light",
    "图片白底": "image_light", "image_light": "image_light",
    "light": "image_light", "白": "image_light",
    # 兼容旧写法：卡片 -> 图片（卡片模式已取消）
    "卡片": "image", "卡片模式": "image", "card": "image",
}

# 背景图
BG_ORIGINAL = "original"                  # 原来的深色底
# ★★ 1.7.7：**纯白底 + 黑字** —— 也作为一个「背景」选项暴露给后台，
#   这样除了「切换输出模式 白底」，在「图片背景图」下拉里也能直接选。
BG_WHITE = "white"
DEFAULT_BG = BG_ORIGINAL
# 内置可选的背景图（MemeAPI 目录下的文件）
BUILTIN_BACKGROUNDS = (
    "Background1.jpg", "Background2.png",
    "Background3.jpg", "Background4.jpg",
)
# 中文别名 -> 文件名
BG_ALIASES = {
    "默认": BG_ORIGINAL, "原来": BG_ORIGINAL, "原版": BG_ORIGINAL,
    "original": BG_ORIGINAL, "默认背景": BG_ORIGINAL,
    # ★★ 1.7.7：白底黑字
    "白底": BG_WHITE, "纯白": BG_WHITE, "白色": BG_WHITE,
    "白底黑字": BG_WHITE, "白色背景": BG_WHITE, "白背景": BG_WHITE,
    "white": BG_WHITE,
    "背景1": "Background1.jpg", "背景一": "Background1.jpg",
    "背景2": "Background2.png", "背景二": "Background2.png",
    "背景3": "Background3.jpg", "背景三": "Background3.jpg",
    "背景4": "Background4.jpg", "背景四": "Background4.jpg",
    "1": "Background1.jpg", "2": "Background2.png",
    "3": "Background3.jpg", "4": "Background4.jpg",
}

# 渲染缓存版本
#   ★ 只要渲染结果会变（改了字体逻辑 / 排版 / 配色等），就把它 +1，
#     旧缓存会自动失效，不会再发出历史版本的图。
#   ★★ 1.7.7：+1（新增白底黑字主题 + 图标列宽归一 + 分隔线识别修正）
CACHE_VERSION = 104

# 渲染服务地址（与表情包接口同一服务）
DEFAULT_RENDER_BASE = "http://127.0.0.1:5099"
RENDER_PATH = "/api/render"
HUSBAND_PATH = "/api/husband"        # 老公卡片（头像嵌入图中）
QUERY_PATH = "/api/query"            # 查询卡片（顶部 QQ 头像）
BIRD_PATH = "/api/bird"              # 抽鸟卡
BIRD_GALLERY_PATH = "/api/bird_gallery"  # 小鸟收集图鉴
BIRD_LIST_PATH = "/api/bird_list_page"   # 图鉴列表（编号 + 名称）
BIRD_DETAIL_PATH = "/api/bird_detail"    # 图鉴详情（每项一行）
# ★ 1.7.6：坐骑卡（图片在顶部，按坐骑名自动找 car 目录里的同名图）
MOUNT_PATH = "/api/mount"
# ★★ 1.7.7：缺字形探测（哪些字符会渲染成方框）
GLYPH_PATH = "/api/glyph_check"
# ★ 1.7.6：行内图片标记 [[img:名字]]（文本模式整行去掉，图片模式渲染进卡片）
INLINE_IMG_RE = re.compile(r"^[ \t]*\[\[\s*img\s*:[^\]]*\]\][ \t]*$",
                           re.MULTILINE)


def strip_inline_img(text: str) -> str:
    """文本模式用：去掉行内图片标记那一行，并压掉多余空行"""
    return _collapse_blank(INLINE_IMG_RE.sub("", str(text or ""))).strip()


def _collapse_blank(text: str) -> str:
    """把连续空行压成一个"""
    out = []
    _blank = False
    for ln in str(text or "").split("\n"):
        if not ln.strip():
            if _blank:
                continue
            _blank = True
        else:
            _blank = False
        out.append(ln)
    return "\n".join(out)


RENDER_TIMEOUT = 20
# ★★ 市场版：**不再内置任何本机服务目录**。
# ★★ 审核整改：以下「自动拉起渲染服务」相关的常量已**废弃删除**
#   （LOCAL_SERVICE_DIRS / START_COOLDOWN / START_WAIT）——
#   插件不再启动任何外部进程，渲染服务由用户自行启动。
# 渲染文本上限（超过就退回纯文本，避免超长卡片）
RENDER_MAX_CHARS = 3500


class OutputModeModule:
    """按群管理输出模式：text / card / image"""

    # 暴露给外部（main.py 会用 实例.MODE_LABELS / 实例.MODES）
    MODES = MODES
    MODE_LABELS = MODE_LABELS
    MODE_ALIASES = MODE_ALIASES
    DEFAULT_MODE = DEFAULT_MODE

    def __init__(self, plugin_dir: str = ""):
        self.plugin_dir = plugin_dir
        self.default_mode = DEFAULT_MODE
        self.groups = {}                 # {群号: 模式}
        self.render_base = DEFAULT_RENDER_BASE
        self.enable = True
        self.cmd_names = ["切换输出模式", "输出模式"]
        self.card_title = ""             # 卡片标题（留空则不显示）
        self._cache = {}                 # 渲染结果缓存 {key: path}
        # ★ 给个默认值：_load_cfg 还没跑（或中途异常）时也不会 AttributeError
        self.bg_image = ""

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}

        def _s(k, d=""):
            v = cfg.get(k, d)
            return str(v if v is not None else d).strip()

        def _b(k, d=True):
            v = cfg.get(k)
            if v is None:
                return d
            if isinstance(v, bool):
                return v
            return str(v).strip().lower() in ("1", "true", "yes", "on", "开")

        mode = _s("output_default_mode", DEFAULT_MODE).lower()
        if mode == "card":          # 旧配置兼容：卡片 -> 图片
            mode = "image"
        self.default_mode = mode if mode in MODES else DEFAULT_MODE

        self.enable = _b("output_mode_enable", True)
        self.render_base = (_s("output_render_base", DEFAULT_RENDER_BASE)
                            or DEFAULT_RENDER_BASE).rstrip("/")
        self.card_title = _s("output_card_title", "")
        # ★★ 审核整改：不再读取/使用「渲染服务目录」——
        #   插件不启动任何外部进程。

        # 背景图（不填则用原来的深色底）
        bg = _s("output_bg_image", DEFAULT_BG)
        self.bg_image = self.normalize_bg(bg)

        names = [x.strip() for x in
                 _s("cmd_output_mode", "切换输出模式,输出模式").replace("，", ",").split(",")]
        self.cmd_names = [x for x in names if x] or ["切换输出模式"]

        # 每群模式（存成 "群号:模式,群号:模式"）
        self.groups = {}
        raw = _s("output_group_modes", "")
        for part in raw.replace("，", ",").split(","):
            part = part.strip()
            if not part or ":" not in part:
                continue
            g, m = part.split(":", 1)
            g, m = g.strip(), m.strip().lower()
            if m == "card":          # 旧配置兼容
                m = "image"
            if g and m in MODES:
                self.groups[g] = m

    # ============================================================
    # 背景图
    # ============================================================
    @staticmethod
    def normalize_bg(raw) -> str:
        """
        把配置里的背景值规范成文件名。

        支持：文件名 / 中文别名（背景1）/ 空 -> original
        认不出的一律回落 original，避免渲染报错。
        """
        v = str(raw if raw is not None else "").strip()
        if not v:
            return BG_ORIGINAL
        if v in BG_ALIASES:
            return BG_ALIASES[v]
        low = v.lower()
        if low in (BG_ORIGINAL, "none", "default", "无"):
            return BG_ORIGINAL
        # ★ 含路径分隔符 / 上级目录的一律拒绝（防路径穿越）
        norm = v.replace("\\", "/")
        if "/" in norm or ".." in norm:
            return BG_ORIGINAL
        blo = v.lower()
        # 带后缀：先按内置名单做大小写不敏感匹配
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            if blo.endswith(ext):
                for fn in BUILTIN_BACKGROUNDS:
                    if fn.lower() == blo:
                        return fn
                # 自加的图：纯文件名也接受
                return v
        # 只写了数字或名字前缀
        for i, fn in enumerate(BUILTIN_BACKGROUNDS, start=1):
            if v == str(i) or v in fn:
                return fn
        return BG_ORIGINAL

    def bg_label(self) -> str:
        """背景的中文说明（给菜单/状态用）"""
        b = getattr(self, "bg_image", "") or BG_ORIGINAL
        if b == BG_ORIGINAL:
            return "原来的深色底"
        if b == BG_WHITE:
            return "纯白底（黑字）"
        return b

    # ============================================================
    # 模式读写
    # ============================================================
    def theme_of(self, group_id="") -> str:
        """
        ★★ 1.7.7：本群该用哪个渲染主题。

        两个入口任一命中就用白底黑字：
          · 模式选了 `image_light`（「切换输出模式 白底」）
          · 背景选了 `white`（后台「图片背景图」里的「纯白底（黑字）」）
        否则返回 ""（渲染端用默认深色）。
        """
        try:
            if str(self.mode_of(group_id) or "") == "image_light":
                return "white"
        except Exception:
            pass
        if str(getattr(self, "bg_image", "") or "") == BG_WHITE:
            return "white"
        return ""

    def mode_of(self, group_id) -> str:
        """取某群当前模式（没配就用默认）"""
        g = str(group_id or "").strip()
        if not g:
            return self.default_mode
        return self.groups.get(g, self.default_mode)

    def set_mode(self, group_id, mode: str) -> bool:
        """设置某群模式，返回是否变更成功"""
        g = str(group_id or "").strip()
        m = str(mode or "").strip().lower()
        if not g or m not in MODES:
            return False
        self.groups[g] = m
        return True

    def dump_groups(self) -> str:
        """序列化每群模式（写回配置用）"""
        return ",".join(f"{g}:{m}" for g, m in sorted(self.groups.items()))

    @staticmethod
    def parse_mode(text: str) -> str:
        """把用户输入解析成模式名（支持中文别名）"""
        t = str(text or "").strip().lower()
        if not t:
            return ""
        if t in MODE_ALIASES:
            return MODE_ALIASES[t]
        for k, v in MODE_ALIASES.items():
            if k in t:
                return v
        return ""

    def match_switch_cmd(self, text: str):
        """
        匹配切换指令。

        返回 (模式, 错误提示)：
          命中且模式合法 -> ("card", "")
          命中了指令但模式不认识 -> ("", "提示文本")
          没命中 -> (None, "")
        """
        t = str(text or "").strip()
        if not t:
            return None, ""
        for nm in sorted(self.cmd_names, key=len, reverse=True):
            if not nm:
                continue
            for prefix in (nm, f"/{nm}"):
                if not t.startswith(prefix):
                    continue
                rest = t[len(prefix):].strip(" ：:，,")
                if not rest:
                    # 只发了指令：返回空模式，由调用方提示当前状态
                    return "", ""
                m = self.parse_mode(rest)
                if m:
                    return m, ""
                return "", (f"⚠️ 不认识的模式「{rest}」\n"
                            f"💡 可用：文本 / 图片")
        return None, ""

    # ============================================================
    # 渲染
    # ============================================================
    # ============================================================
    # ★★ 1.7.7：**缺字形字符**（会渲染成方框）的精确探测
    # ------------------------------------------------------------
    # 插件侧只能按 Unicode 区间猜「哪些字符会变方框」，猜不准：
    #   · 私用区、增补平面能猜到（已按区间过滤）
    #   · 但「字体链里真没这个字形」的字符，区间猜不出来
    # 渲染服务有精确探测（`_has_glyph`：比对豆腐框位图指纹），
    # 于是这里问它一次，把结论**缓存**下来，之后同步过滤即可。
    # ============================================================
    async def fetch_missing_glyphs(self, text: str) -> set:
        """
        问渲染服务：这段文本里哪些字符**画不出来**（会变方框）。

        返回「缺字形字符」集合；服务不可用时返回空集合（不拦原有逻辑）。
        """
        t = str(text or "")
        if not t or not _HAS_AIOHTTP:
            return set()
        try:
            url = self._endpoint().replace(RENDER_PATH, GLYPH_PATH)
            params = {"text": t}
            blob, err = await self._get_with_retry(url, params)
            if err or not blob:
                logger.debug("[output] 字形探测失败：%s", err or "空响应")
                return set()
            data = json.loads(blob.decode("utf-8", "replace"))
            if not data.get("ok"):
                return set()
            miss = data.get("missing") or []
            out = {str(c) for c in miss if c}
            if out:
                logger.info("[output] 发现 %d 个缺字形字符：%s",
                            len(out), "".join(sorted(out))[:60])
            return out
        except Exception:
            logger.debug("[output] 字形探测异常", exc_info=True)
            return set()

    def missing_glyphs_sync(self, text: str, timeout: float = 3.0) -> set:
        """
        同步版：给 `clean_display()`（同步上下文）用。

        ★ 在**独立线程**里跑一次异步请求，最多等 `timeout` 秒；
          超时就返回空集合（绝不卡住出图，本来也只是「尽量别出方框」）。
        """
        t = str(text or "")
        if not t or not _HAS_AIOHTTP:
            return set()
        import threading
        box = {}

        def _worker():
            try:
                box["r"] = asyncio.run(self.fetch_missing_glyphs(t))
            except Exception:
                box["r"] = set()

        try:
            th = threading.Thread(target=_worker, daemon=True)
            th.start()
            th.join(timeout)
            if th.is_alive():
                return set()
            return box.get("r") or set()
        except Exception:
            return set()

    def _endpoint(self) -> str:
        return self.render_base + RENDER_PATH

    # ================================================================
    # ★★ 审核整改：**已移除**「渲染服务自动拉起」功能。
    #
    #   原实现会用 `外部进程调用` 去执行某个目录下的
    #   `start.bat` / `python app.py`，把一个本地渲染服务拉起来。
    #   社区规范对「插件自行拉起外部进程」比较敏感，所以整体删掉：
    #     · 渲染服务改为**完全由用户自己启动**（或指向任意可用的
    #       渲染地址）；插件只负责发 HTTP 请求
    #     · 服务不可达时**回落到纯文本输出**（本来就有的行为）
    # ================================================================

    async def _get_with_retry(self, url: str, params: dict):
        """
        GET 一次文本渲染接口。

        ★★ 审核整改：不再「连不上就拉起本地服务」——
          直接返回错误，由上层回落到纯文本输出。

        返回 (blob, None) 或 (None, 错误描述)
        """
        timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.get(url, params=params) as resp:
                    if resp.status != 200:
                        return None, f"HTTP {resp.status}"
                    return await resp.read(), None
        except Exception as e:
            return None, f"{type(e).__name__}: {str(e)[:70]}"

    async def render_to_path(self, text: str, style: str = "card",
                             img_dir: str = "", tail: str = "",
                             max_w: int = 0, theme: str = "") -> str:
        """
        调本地渲染服务，把文本变成图片文件。

        ★ 行内图片标记 `[[img:名字]]`（1.7.6）：
          · 图片模式 -> 把 img_dir 传给渲染服务，那一行变成一张图
          · 文本模式 -> 标记整行去掉（见 strip_inline_img）

        ★ 回复尾巴（1.7.6）：用 `tail` **单独传**，
          渲染端会把它画在收尾横线**下面**，且按卡片宽度换行
          （尾巴再长也不会把卡片撑宽）。别再拼进正文 ——
          那样渲染端只能靠猜，位置容易错。

        ★ max_w：卡片宽度上限（像素）。整点报时那种「两行短句」传大一点
          （如 720），一行放得下更好看；不给就用默认 540。

        返回保存后的文件路径；失败返回空串。
        """
        if not _HAS_AIOHTTP or not self.enable:
            return ""
        # ★★ 1.7.6：进渲染前去掉 markdown 强调标记（`**`）
        #   图片渲染不认 markdown，`**` 会原样画出来、还让文字显斜体。
        try:
            from .path_utils import strip_md as _smd
        except Exception:
            try:
                from core.path_utils import strip_md as _smd
            except Exception:
                _smd = None
        if _smd is not None:
            text = _smd(text)
            tail = _smd(tail)
        # ★ 尾巴要算进长度限制，否则「正文刚好满 + 尾巴」会被丢掉
        _all_len = len(str(text or "")) + len(str(tail or ""))
        body = INLINE_IMG_RE.sub("", str(text or "")).strip()
        # ★ 标记行留下的空行收拾一下（连续空行压成一个）
        body = _collapse_blank(body)
        if not body.strip() or _all_len > RENDER_MAX_CHARS:
            return ""
        params = {"text": str(text or ""), "style": style}
        if tail:
            params["tail"] = str(tail)
        if max_w:
            try:
                params["max_w"] = str(int(max_w))
            except Exception:
                pass
        if img_dir:
            params["img_dir"] = str(img_dir)
        # ★★ 1.7.7：图片模式分两种配色 —— white 主题走「纯白底 + 黑字」
        #   由调用方按当前 mode 传进来（image_light -> theme=white）
        if theme:
            params["theme"] = str(theme)
        if self.card_title:
            params["title"] = self.card_title
        # 背景图（original 时不传，用原来深色底）
        # ★★ 1.7.7：white 是「主题」不是背景图文件，别当 bg 传过去
        _bgv = str(getattr(self, "bg_image", "") or "")
        if _bgv and _bgv not in (BG_ORIGINAL, BG_WHITE):
            params["bg"] = self.bg_image
        blob, err = await self._get_with_retry(self._endpoint(), params)
        if err or not blob:
            logger.warning(f"[output] 渲染失败：{err or '空响应'}")
            return ""
        # ★ 缓存键要带上 max_w，否则「宽版」和「窄版」会互相顶掉
        return self._save_cache(blob, style,
                                str(text or "") + "\n" + str(tail or "")
                                + f"|w{int(max_w or 0)}|t{theme}")

    def _cache_dir(self) -> str:
        """当前版本的缓存目录（按版本隔离，避免旧图被复用）"""
        import tempfile
        return os.path.join(tempfile.gettempdir(), "astrbot_output_mode",
                            f"v{CACHE_VERSION}")

    def _clean_old_caches(self):
        """删掉旧版本的缓存目录（渲染逻辑变更后不再需要）"""
        import shutil
        import tempfile
        root = os.path.join(tempfile.gettempdir(), "astrbot_output_mode")
        keep = f"v{CACHE_VERSION}"
        try:
            if not os.path.isdir(root):
                return
            for name in os.listdir(root):
                if name == keep:
                    continue
                p = os.path.join(root, name)
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
                elif name.endswith(".jpg"):
                    # 更早的平铺缓存（没有版本目录时）
                    try:
                        os.remove(p)
                    except Exception:
                        pass
        except Exception:
            logger.exception("[output] 清理旧缓存失败")

    def _save_cache(self, blob: bytes, style: str, body: str,
                    extra: str = "") -> str:
        """把渲染结果写进临时目录（相同内容复用，避免重复渲染）"""
        import hashlib
        # ★ 背景图 + 缓存版本都要进 key，
        #   否则换背景 / 改渲染逻辑后仍会拿到旧图
        # ★ 用 getattr 兜底：bg_image 由 _load_cfg 赋值，
        #   若配置加载中途异常，这里会 AttributeError，
        #   导致**所有**渲染方法（名片/小鸟/猜拳…）静默返回空串。
        raw = (f"v{CACHE_VERSION}|" + style + "|"
               + (str(getattr(self, "bg_image", "") or "")
                                   + ":" + self.theme_of()) + "|"
               + extra + "|" + body)
        key = hashlib.md5(raw.encode("utf-8")).hexdigest()
        cached = self._cache.get(key)
        if cached and os.path.isfile(cached):
            return cached
        try:
            d = self._cache_dir()
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, f"{key}.jpg")
            if not os.path.isfile(path):
                with open(path, "wb") as f:
                    f.write(blob)
            self._cache[key] = path
            # 缓存别无限涨
            if len(self._cache) > 300:
                self._cache.clear()
                self._cache[key] = path
            return path
        except Exception:
            logger.exception("[output] 缓存渲染结果失败")
            return ""

    async def render_husband_card(self, text: str, avatar_path: str = "") -> str:
        """
        渲染「今日老公」卡片：头像**嵌入图中**（名称下方）。

        avatar_path: 本地头像文件路径（由插件下载好），
                     转成 base64 传给渲染服务，避免服务端再去拉 QQ。
        返回本地图片路径；失败返回空串。
        """
        if not _HAS_AIOHTTP or not self.enable:
            return ""
        body = str(text or "")
        if not body.strip():
            return ""
        import base64
        payload = {"text": body, "style": "plain"}
        _bgv2 = str(getattr(self, "bg_image", "") or "")
        if _bgv2 and _bgv2 not in (BG_ORIGINAL, BG_WHITE):
            payload["bg"] = self.bg_image
        # 头像转 base64
        if avatar_path:
            try:
                if os.path.isfile(avatar_path):
                    with open(avatar_path, "rb") as f:
                        payload["avatar_b64"] = base64.b64encode(
                            f.read()).decode("ascii")
            except Exception:
                logger.warning("[output] 读取头像失败，改用占位头像")
        try:
            timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT + 10)
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(self.render_base + HUSBAND_PATH,
                                     json=payload) as resp:
                    if resp.status != 200:
                        logger.warning(f"[output] 老公卡片渲染失败：HTTP {resp.status}")
                        return ""
                    blob = await resp.read()
            if not blob:
                return ""
            return self._save_cache(blob, "husband", body,
                                    extra=str(payload.get("avatar_b64", ""))[:64])
        except Exception as e:
            logger.warning(f"[output] 老公卡片渲染异常：{type(e).__name__}: {str(e)[:80]}")
            return ""

    async def render_query_card(self, text: str,
                                avatar_path: str = "",
                                tail: str = "") -> str:
        """
        渲染「查询结果」卡片：**最顶部居中 QQ 头像** + 资料文字。

        ★ 与群名片（/api/card）无关，走独立的 /api/query。

        text        正文（查询功能的输出）
        avatar_path 本地头像文件路径（由插件下载好；空则不留头像位）
        tail        ★ 回复尾巴（1.7.6）：渲染端画在卡片底部横条下方，
                    这样图文在**同一张图**里，不会再单独发一条文本。
        返回本地图片路径；失败返回空串。
        """
        if not _HAS_AIOHTTP:
            return ""
        body = str(text or "").strip()
        if not body:
            return ""
        import base64
        payload = {"text": body[:RENDER_MAX_CHARS]}
        if tail:
            payload["tail"] = str(tail)
        if avatar_path:
            try:
                if os.path.isfile(avatar_path):
                    with open(avatar_path, "rb") as f:
                        payload["avatar_b64"] = base64.b64encode(
                            f.read()).decode("ascii")
            except Exception:
                logger.warning("[output] 读取查询头像失败，改为纯文字卡")
        try:
            timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT + 10)
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(self.render_base + QUERY_PATH,
                                     json=payload) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[output] 查询卡片渲染失败：HTTP {resp.status}")
                        return ""
                    blob = await resp.read()
            if not blob:
                return ""
            return self._save_cache(
                blob, "query", body + "\n" + str(tail or ""),
                extra=str(payload.get("avatar_b64", ""))[:48])
        except Exception as e:
            logger.warning(
                f"[output] 查询卡片渲染异常：{type(e).__name__}: {str(e)[:80]}")
            return ""



    async def render_bird_card(self, title: str, name: str, desc: str = "",
                               img: str = "", bg: str = "",
                               lv: int = 0, count: int = 0,
                               is_new: bool = False) -> str:
        """
        渲染「抽鸟卡」（固定图片输出）。

        title 如「恭喜你抽到一只新小鸟！」/「又抽到了仓鸮」
        lv / count : 图片下方显示「Lv.N　抓到第 M 只」
        is_new     : 首次抽到（图片下方那行用暖色）
        返回本地图片路径；失败返回空串。
        """
        if not _HAS_AIOHTTP:
            return ""
        name = str(name or "").strip()
        if not name:
            return ""
        try:
            _lv = max(0, min(int(lv or 0), 100))
        except Exception:
            _lv = 0
        try:
            _cnt = max(0, int(count or 0))
        except Exception:
            _cnt = 0
        payload = {
            "title": str(title or "")[:60],
            "name": name[:30],
            "desc": str(desc or "")[:300],
            "img": str(img or "")[:120],
            "bg": str(bg or ""),
            "lv": _lv,
            "count": _cnt,
            "is_new": "1" if is_new else "0",
        }
        try:
            timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT + 10)
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(self.render_base + BIRD_PATH,
                                     json=payload) as resp:
                    if resp.status != 200:
                        logger.warning(f"[output] 抽鸟卡渲染失败：HTTP {resp.status}")
                        return ""
                    blob = await resp.read()
            if not blob:
                return ""
            # ★ 等级 / 第几只 必须进缓存键，否则升级后仍发旧图
            return self._save_cache(blob, "bird", name,
                                    extra="|".join([payload["title"],
                                                    payload["img"],
                                                    payload["bg"],
                                                    f"lv{_lv}",
                                                    f"c{_cnt}",
                                                    payload["is_new"]]))
        except Exception as e:
            logger.warning(
                f"[output] 抽鸟卡渲染异常：{type(e).__name__}: {str(e)[:80]}")
            return ""

    async def render_mount_card(self, title: str = "", name: str = "",
                                sub: str = "", img_name: str = "",
                                bg: str = "", img_dir: str = "") -> str:
        """
        渲染「坐骑卡」（图片在**顶部**）。

        ★ img_name 建议传图片的**绝对路径**（按坐骑名从 car 目录解析出来），
          也可以只传坐骑名 —— 服务端会自己去 car 目录找同名图。
        返回本地图片路径；失败返回空串。
        """
        if not _HAS_AIOHTTP:
            return ""
        name = str(name or "").strip()
        if not name:
            return ""
        payload = {
            "title": str(title or "")[:60],
            "name": name[:30],
            "sub": str(sub or "")[:120],
            "img": str(img_name or "")[:260],
            "bg": str(bg or ""),
            "img_dir": str(img_dir or "")[:260],
        }
        try:
            timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT + 10)
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(self.render_base + MOUNT_PATH,
                                     json=payload) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[output] 坐骑卡渲染失败：HTTP {resp.status}")
                        return ""
                    blob = await resp.read()
            if not blob:
                return ""
            return self._save_cache(blob, "mount", name,
                                    extra="|".join([payload["title"],
                                                    payload["sub"],
                                                    payload["img"],
                                                    payload["img_dir"],
                                                    payload["bg"]]))
        except Exception as e:
            logger.warning(
                f"[output] 坐骑卡渲染异常：{type(e).__name__}: {str(e)[:80]}")
            return ""

    async def render_bird_gallery(self, items: list, bg: str = "",
                                  page: int = 1, rank: int = 0,
                                  total_users: int = 0):
        """
        渲染「小鸟收集图鉴」（固定图片输出）—— **一次只渲染一页**。

        items: [{"name","img","level","owned"}, ...]
        page : 页码（从 1 开始；超范围由服务端回落第 1 页）
        rank : 自己的收集名次（全群共享，1 起；0/None = 不上榜，不显示）
        total_users : 有收集记录的总人数（显示成「第 n 名 / 共 N 人」）

        返回 (本地图片路径, 总页数)：
          · 成功 -> (路径, N)，N>=1
          · 失败 / 无数据 -> ("", 0)

        ★ 分页规则由本地渲染服务决定（每页 60 只 = 10 列 × 6 行），
          这里不再把多页拼成一张长图（那会出现多个标题，看着像两张图叠一起）。
        """
        if not _HAS_AIOHTTP:
            return "", 0
        items = list(items or [])
        if not items:
            return "", 0
        try:
            _p = int(page)
        except Exception:
            _p = 1
        if _p < 1:
            _p = 1
        # 与服务端 GAL_PAGE_SIZE / GAL_COLS 保持一致，仅用于算总页数
        _per = 60
        _pages = max(1, -(-len(items) // _per))
        if _p > _pages:
            _p = 1

        try:
            _rank = int(rank or 0)
        except Exception:
            _rank = 0
        if _rank < 0:
            _rank = 0
        try:
            _tu = int(total_users or 0)
        except Exception:
            _tu = 0

        payload = {"items": items[:200], "bg": str(bg or ""), "page": _p,
                   "rank": _rank, "total_users": _tu}
        # ★ 缓存键必须包含「**本页**每只鸟的名字/等级/拥有状态」+ **总数**。
        #   旧写法有两个坑（会导致一直发旧图）：
        #     ① 只取签名前 600 字符 -> 只覆盖**前 60 只**；之后新增的鸟
        #        （都在末尾且未拥有）不影响签名，于是缓存命中、永远发旧图
        #     ② 不含总数 -> 「已收集 x / y」里的 y 停在旧值
        #   现在对**该页切片**做完整签名，并显式带上总数。
        _slice = items[(_p - 1) * _per:_p * _per]
        import hashlib as _hl
        # ★ 两个签名一起进缓存键：
        #   all — **整个名单**的哈希（增删任意一只鸟都会变，包括删末页的）
        #   page — 本页每只鸟的名字/等级/拥有状态（收集进度变化会变）
        _all = _hl.md5("|".join(
            str(i.get("name", "")) for i in items).encode("utf-8")).hexdigest()
        _psig = _hl.md5(",".join(
            "%s:%s:%s" % (i.get("name", ""), i.get("level", ""),
                          1 if i.get("owned") else 0)
            for i in _slice).encode("utf-8")).hexdigest()
        extra = "|".join([f"n{len(items)}", _all[:16], _psig[:16],
                          str(payload["bg"]), f"p{_p}",
                          f"r{_rank}/{_tu}"])
        path = await self._post_image(BIRD_GALLERY_PATH, payload,
                                      "birdgal", "gallery", extra=extra)
        return path, (_pages if path else 0)

    def _cache_lookup(self, style: str, body: str, extra: str = "") -> str:
        """
        **只查缓存、不渲染**。命中返回本地图片路径，未命中返回空串。

        ★ 与 _save_cache 用同一套 key 算法，必须成对使用。
        """
        import hashlib
        raw = (f"v{CACHE_VERSION}|" + style + "|"
               + (str(getattr(self, "bg_image", "") or "")
                                   + ":" + self.theme_of()) + "|"
               + str(extra or "") + "|" + str(body or ""))
        key = hashlib.md5(raw.encode("utf-8")).hexdigest()
        cached = self._cache.get(key)
        if cached and os.path.isfile(cached):
            return cached
        # 进程内没记录，但磁盘上可能已有（重启后）
        try:
            p = os.path.join(self._cache_dir(), f"{key}.jpg")
            if os.path.isfile(p):
                self._cache[key] = p
                return p
        except Exception:
            pass
        return ""

    async def _post_image(self, path_const: str, payload: dict,
                          style: str, body: str,
                          extra: str = "") -> str:
        """
        给渲染服务发一个取图的 POST，成功返回本地缓存路径，失败返回空串。

        ★ **先查缓存**：命中就直接返回，不再请求渲染服务。
          （原来是先渲染再判缓存，等于缓存完全没省下渲染开销。）
        """
        if not _HAS_AIOHTTP:
            return ""
        # ---- ① 先查缓存 ----
        hit = self._cache_lookup(style, body, extra)
        if hit:
            return hit
        # ---- ② 未命中才真正渲染 ----
        try:
            timeout = aiohttp.ClientTimeout(total=RENDER_TIMEOUT + 20)
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.post(self.render_base + path_const,
                                     json=payload) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[output] {style} 渲染失败：HTTP {resp.status}")
                        return ""
                    blob = await resp.read()
            if not blob:
                return ""
            return self._save_cache(blob, style, body, extra=extra)
        except Exception as e:
            logger.warning(
                f"[output] {style} 渲染异常：{type(e).__name__}: {str(e)[:80]}")
            return ""

    async def render_bird_list_page(self, items: list, bg: str = "",
                                    page: int = 1, per_page: int = 10,
                                    title: str = "图鉴列表",
                                    page_cmd: str = ""):
        """
        渲染「图鉴列表」一页（编号 + 名称）。

        items: [{"no", "name", "cn", "owned"}, ...]
        page_cmd: 翻页指令名；给了就在**图片底部**画「第 n / N 页」+
                  「发「指令 n+1」看下一页」，避免再额外发一条文字。

        返回 (本地图片路径, 总页数)：
          · 成功 -> (路径, N)，N>=1
          · 失败 / 无数据 -> ("", 0)
        """
        items = list(items or [])
        if not items:
            return "", 0
        try:
            _p = max(1, int(page))
        except Exception:
            _p = 1
        try:
            _pp = max(1, int(per_page))
        except Exception:
            _pp = 10
        _pages = max(1, -(-len(items) // _pp))
        if _p > _pages:
            _p = 1
        payload = {
            "items": items[:200], "bg": str(bg or ""),
            "page": _p, "per_page": _pp,
            "title": str(title or "图鉴列表"),
            "page_cmd": str(page_cmd or ""),
        }
        # ★ 缓存键：本页切片 + 总数 + 页码 + 标题 + 翻页指令名
        #   （含总数，新增小鸟后立刻失效；含本页切片，页码之间不互相污染）
        import hashlib as _hl
        _slice = items[(_p - 1) * _pp:_p * _pp]
        _sig = _hl.md5(",".join(
            "%s:%s:%s" % (i.get("name", ""), i.get("cn", ""),
                          1 if i.get("owned") else 0)
            for i in _slice).encode("utf-8")).hexdigest()
        extra = "|".join([f"n{len(items)}", _sig, str(payload["bg"]),
                          f"p{_p}/{_pp}", str(payload["title"]),
                          str(payload["page_cmd"])])
        path = await self._post_image(BIRD_LIST_PATH, payload,
                                      "birdlist", f"list{_p}", extra=extra)
        return path, (_pages if path else 0)

    async def render_bird_detail(self, fields: list, bg: str = "",
                                 title: str = "图鉴详情",
                                 img_name: str = "") -> str:
        """
        渲染「图鉴详情」卡（每项一行）。

        fields: [{"label", "value", "color"}, ...]
        返回本地图片路径；失败返回空串。
        """
        fields = list(fields or [])
        if not fields:
            return ""
        payload = {
            "fields": fields[:20], "bg": str(bg or ""),
            "title": str(title or "图鉴详情"),
            "img": str(img_name or ""),
        }
        # ★ 缓存键：全部字段内容 + 标题 + 素材名（含冒号，避免字段串味）
        import hashlib as _hl
        _sig = _hl.md5("|".join(
            "%s=%s=%s" % (f.get("label", ""), f.get("value", ""),
                          f.get("color", ""))
            for f in payload["fields"]).encode("utf-8")).hexdigest()
        extra = "|".join([_sig, str(payload["title"]), str(payload["img"])])
        return await self._post_image(BIRD_DETAIL_PATH, payload,
                                      "birddetail", "detail", extra=extra)

    async def render_chain(self, text: str, group_id="", img_dir="",
                           tail: str = "", max_w: int = 0):
        """
        按当前群模式把文本转成可发送的组件列表。

        返回 (组件列表, 实际使用的模式)：
          · text  -> 空列表（调用方用 plain_result 发文本）
          · image -> [Image, ...]
          渲染失败时返回空列表（调用方回落文本）

        ★ img_dir：行内图片 `[[img:...]]` 的素材目录
        ★ tail：回复尾巴（渲染端画在收尾横线下面，不加宽卡片）
        ★ max_w：卡片宽度上限（整点报时传大一点）
        """
        from astrbot.api.message_components import Image as _Image

        mode = self.mode_of(group_id)
        if mode == "text":
            return [], "text"
        # ★★ 1.7.7：image_light -> 渲染服务用 white 主题（纯白底 + 黑字）
        _theme = self.theme_of(group_id)
        path = await self.render_to_path(text, "plain", img_dir=img_dir,
                                         tail=tail, max_w=max_w,
                                         theme=_theme)
        if not path:
            logger.info(f"[output] {MODE_LABELS.get(mode, mode)}渲染失败，回落纯文本")
            return [], "text"
        try:
            return [_Image.fromFileSystem(path)], mode
        except Exception:
            logger.exception("[output] 构造图片组件失败")
            return [], "text"

    def status_text(self, group_id) -> str:
        """当前模式说明（给管理员看）"""
        cur = self.mode_of(group_id)
        lines = [
            f"{title_bar('输出模式')}",
            "",
            f"📌 本群当前：{MODE_LABELS.get(cur, cur)}",
            f"🌐 全局默认：{MODE_LABELS.get(self.default_mode, self.default_mode)}",
            "",
            f"🎨 当前背景：{self.bg_label()}",
            "",
            "可切换：",
            "　文本模式　— 直接发文字",
            "　图片模式（深色）　— 渲染成图片",
            "　图片模式（白底黑字）— 纯白底 + 黑字，亮色环境更清楚",
            "",
            f"💡 用法：「{self.cmd_names[0]} 图片」",
        ]
        return "\n".join(lines)
