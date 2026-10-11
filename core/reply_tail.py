"""
全局回复尾巴（1.7.6）
============================================================

给**本插件发出的所有回复**自动追加一段尾巴：

    · 固定文字      —— 后台直接填一段话
    · 文本接口      —— 后台填 API 地址，每次取一段文本
      （默认 https://api.yviii.com/yiyan/yi.php，就是「每日一言」那个）
    · 两者可以一起用：固定文字在上，接口内容在下

用法（main.py）：

    @filter.on_decorating_result()
    async def _append_reply_tail(self, event):
        ...
        await reply_tail.apply(self, event)

设计要点
------------------------------------------------------------
· 走 `on_decorating_result`（**发送前**的钩子），所以能改内容；
  `after_message_sent` 是发送后，改不了。
· 只给**本插件自己发出的**回复加尾巴（靠输出里的统一标记识别），
  不会影响其他插件 / LLM 的回复。
· 同一条回复只加一次（event 上打标记，防多条结果重复追加）。
· 接口失败就跳过，绝不影响正常回复。
· 本插件的**主动推送**（整点报时等）不走这个管线，
  需要的话自己调 `await rt.tail_text(plugin)` 拼上去。
"""

import time

from astrbot.api import logger

# 本插件输出的「招牌」标记：标题行 + 分隔线
#   只有含这些的回复才认为是本插件发的（避免影响别的插件/LLM）
_BAR_MARK = "━━━━━━━━━━━━━━━━━━━━"


def _own_marks():
    """
    判断「这条回复是不是本插件发的」用的文字标记。

    ★ 1.7.6：标题前缀**可自定义**，所以这里动态取当前前缀，
      否则用户改了前缀（或留空）后，尾巴兜底就认不出自己的回复了。
    """
    try:
        from . import path_utils as _pu
        pfx = getattr(_pu, "TITLE_PREFIX", "") or ""
    except Exception:
        pfx = ""
    marks = [_BAR_MARK]
    if pfx:
        marks.insert(0, pfx)
    # ★ 常用前缀也留着，避免「改了前缀后旧回复认不出来」
    marks.extend(["铁剑娘系统：", "自定义娱乐：", "鸡鸡娱乐系统："])
    return tuple(dict.fromkeys(m for m in marks if m))


def _own_render_dir() -> str:
    """
    本插件「输出模式」的渲染缓存根目录。

    `OutputModeModule` 把所有渲染图放在
    `%TEMP%/astrbot_output_mode/v<版本>/` 下 —— 图片模式发出去的图
    都在这里，所以「图片文件路径在不在这下面」就能判断
    「这张图是不是本插件渲染的」。
    """
    import os
    import tempfile
    return os.path.join(tempfile.gettempdir(), "astrbot_output_mode")


def _comp_file_path(comp) -> str:
    """
    拿到图片组件指向的**本地文件路径**（拿不到返回空串）。

    ★ 注意 AstrBot 的 `Image.fromFileSystem()` 会把路径存成
      `file:///C:/...` 这种 URI，要转回本地路径才能比较。
    """
    import os
    import urllib.parse
    for attr in ("path", "file", "file_path", "url"):
        try:
            v = getattr(comp, attr, None)
            if not v:
                continue
            s = str(v).strip()
            if not s:
                continue
            if s.startswith(("http://", "https://")):
                continue        # 外链，不是我们渲染的
            if s.startswith("file://"):
                # file:///C:/x.jpg -> C:/x.jpg（并去掉多余的前导斜杠）
                s = urllib.parse.unquote(s[7:])
                if os.name == "nt" and s.startswith("/") and len(s) > 2 \
                        and s[2] == ":":
                    s = s[1:]
            if s:
                return s
        except Exception:
            pass
    return ""


def _is_own_image(comp) -> bool:
    """这张图是不是本插件渲染出来的（按缓存目录判断）"""
    import os
    p = _comp_file_path(comp)
    if not p:
        return False
    try:
        root = os.path.normcase(os.path.abspath(_own_render_dir()))
        ap = os.path.normcase(os.path.abspath(p))
        return ap.startswith(root + os.sep)
    except Exception:
        return False


def chain_has_own_image(result) -> bool:
    """
    这条回复里有没有**本插件渲染的图**。

    ★ 1.7.6：用来兜底判断「尾巴是不是已经画进图里了」。
      专用卡片（猜拳 / 查询 / 图鉴…）会把尾巴画进图片，
      这种情况钩子**绝不能再补一条文本**，否则图文重复。
      （比 event 上的标记更可靠：标记可能因为 yield 时机来不及设。）
    """
    try:
        for comp in (result.chain or []):
            if _is_own_image(comp):
                return True
    except Exception:
        pass
    return False


def _bool_cfg(cfg, key, default=True):
    """
    读布尔配置。

    ★ 必须自己判字符串：yaml/后台可能给 "false"/"0"/"否"，
      直接 bool("false") 会得到 True（历史踩过的坑）。
    """
    v = (cfg or {}).get(key, default)
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in ("false", "0", "no", "off", "否", "关闭", "关", ""):
        return False
    if s in ("true", "1", "yes", "on", "是", "开启", "开"):
        return True
    return default


def _int_cfg(cfg, key, default, lo, hi):
    try:
        v = int(str((cfg or {}).get(key, str(default))).strip() or default)
    except Exception:
        v = default
    return max(lo, min(hi, v))


def join_tail(text: str, tail: str, sep: str = "\n") -> str:
    """
    把尾巴拼到正文里 —— **拼在渲染之前**，这样图片模式只出现一次。

    插入位置（用户要求）：
      · 正文最后有一条**横线**（收尾线）-> 插到它**下面**，
        也就是「收尾线在上、尾巴在最底部」
      · 没有横线 -> 直接追加到末尾

    例：
        🐦今日小鸟
        ─────────────
        ─────────────       ← 收尾线
        💬 每日一言          ← 尾巴在最底部
    """
    body = str(text or "")
    tail = str(tail or "").strip()
    if not tail:
        return body
    _sep = str(sep if sep is not None else "\n")
    lines = body.split("\n")
    ins = -1
    for i in range(len(lines) - 1, -1, -1):
        st = lines[i].strip()
        if st and all(ch in "\u2500\u2501\u2504\u2508\u254c" for ch in st):
            ins = i
            break
    _tail_lines = tail.split("\n")
    if ins >= 0:
        # ★ 插在最后一条横线**下面**（`ins + 1`）
        return "\n".join(lines[:ins + 1] + _tail_lines + lines[ins + 1:])
    return body + _sep + tail


class ReplyTail:
    """回复尾巴：配置 + 取文本 + 拼接"""

    def __init__(self):
        self.enable = False
        self.mode = "api"          # text / api / both
        self.text = ""             # 固定文字
        self.api = ""              # 接口地址
        self.prefix = ""           # 接口内容前缀
        self.timeout = 6
        self.sep = "\n"            # 尾巴和正文的分隔
        self.only_group = True     # 只在群聊加
        self.max_len = 200         # 尾巴总长度上限
        # ★ 1.7.6：**每次输出都重新请求接口**（用户要求：每次都随机到新的一句）。
        #   所以不做时间缓存；只在「同一次回复内」复用，
        #   避免一条回复里取两次拿到不同内容。
        self._cache = {"ts": 0.0, "text": "", "token": None}
        self._cache_ttl = 0

    def reload(self, cfg):
        c = cfg or {}
        self.enable = _bool_cfg(c, "reply_tail_enable", False)
        self.mode = str(c.get("reply_tail_mode", "api")
                        or "api").strip().lower()
        if self.mode not in ("text", "api", "both"):
            self.mode = "api"
        self.text = str(c.get("reply_tail_text", "") or "")
        self.api = str(c.get("reply_tail_api", "") or "").strip()
        self.prefix = str(c.get("reply_tail_prefix", "") or "")
        self.timeout = _int_cfg(c, "reply_tail_timeout", 6, 3, 30)
        self.sep = str(c.get("reply_tail_sep", "\n") or "\n")
        self.only_group = _bool_cfg(c, "reply_tail_only_group", True)
        self.max_len = _int_cfg(c, "reply_tail_max_len", 200, 20, 1000)
        logger.info(
            f"[reply_tail] enable={self.enable} mode={self.mode} "
            f"api={self.api!r} text_len={len(self.text)}")

    # ------------------------------------------------------------
    # 取接口文本
    # ------------------------------------------------------------
    async def fetch_api_text(self) -> str:
        """
        取文本接口内容（失败返回空串）。

        ★ 1.7.6：**每次都重新请求** —— 用户要求每次输出都随机到新的一句。
          只在「同一次回复内」复用（`render_chain` 可能被调两次），
          靠调用方传入的 token 判断，见 `tail_text()`。
        """
        return await self._fetch(self.api)

    async def _fetch(self, api: str) -> str:
        if not api:
            return ""
        try:
            import aiohttp
        except Exception:
            return ""
        try:
            timeout = aiohttp.ClientTimeout(total=max(3, self.timeout))
            async with aiohttp.ClientSession(timeout=timeout) as sess:
                async with sess.get(api) as resp:
                    if resp.status != 200:
                        logger.warning(
                            f"[reply_tail] 接口 HTTP {resp.status}")
                        return ""
                    raw = await resp.read()
            text = raw.decode("utf-8", "ignore")
            text = " ".join(str(text or "").split()).strip()
            text = text.strip('"').strip("'").strip("“”").strip()
            text = text[:self.max_len]
            return text
        except Exception as e:
            logger.warning(f"[reply_tail] 取接口文本失败："
                           f"{type(e).__name__}: {str(e)[:80]}")
            return ""

    # ------------------------------------------------------------
    # 拼尾巴
    # ------------------------------------------------------------
    async def tail_text(self, token=None) -> str:
        """
        按配置拼出完整尾巴（可能为空）。

        ★ 1.7.6：**每次调用都重新请求接口**，所以每次输出都是新的随机一句。
          `token` 用来标记「同一次回复」—— 传相同的 token 会复用同一条，
          避免一条回复里取两次拿到不同内容；不传 token 则每次都重新取。
        """
        if not self.enable:
            return ""
        parts = []
        if self.mode in ("text", "both") and self.text.strip():
            parts.append(self.text.strip())
        if self.mode in ("api", "both"):
            api_text = ""
            if token is not None and self._cache.get("token") == token \
                    and self._cache.get("text"):
                api_text = self._cache["text"]
            else:
                api_text = await self.fetch_api_text()
                if token is not None:
                    self._cache = {"ts": time.time(), "text": api_text,
                                   "token": token}
            if api_text:
                parts.append(str(self.prefix or "") + api_text)
        if not parts:
            return ""
        out = self.sep.join(parts)
        return out[:self.max_len]

    # ------------------------------------------------------------
    # 判断这条回复是不是「本插件发的」
    # ------------------------------------------------------------
    @staticmethod
    def is_own_result(result) -> bool:
        """
        只给本插件的回复加尾巴。

        ★ 两种识别方式（任一命中即可）：

          ① **文字标记** —— 输出里有统一标题/分隔线
             （文本模式和卡片模式都带）

          ② **图片来自本插件的渲染缓存** ——
             图片模式渲染出的图存在 `%TEMP%/astrbot_output_mode/` 下。
             ★ 这条很关键：图片模式下消息链里**只有 Image 组件**，
               没有任何文字标记，光靠 ① 会全部漏掉。

        这样不会影响别的插件和 LLM 的回复。

        ★★ 1.7.6：链里有**视频 / 语音 / 文件**时**一律不加** ——
          用户要求「接口图片、纯图片、视频、音乐卡片都不用在意尾巴」。
          那些是自成一体的大附件，尾巴接上去只会碍事。
        """
        try:
            _chain = list(result.chain or [])
        except Exception:
            return False
        # 先扫一遍：有视频/语音/文件就直接判否
        for comp in _chain:
            _cn = type(comp).__name__.lower()
            if _cn in ("video", "record", "file", "music", "forward"):
                return False
        try:
            from astrbot.api.message_components import Plain
        except Exception:
            Plain = None
        try:
            for comp in _chain:
                # ① 文字标记
                if Plain is not None and isinstance(comp, Plain):
                    t = str(getattr(comp, "text", "") or "")
                    if any(m in t for m in _own_marks()):
                        return True
                    continue
                # ② 本插件渲染缓存里的图
                if _is_own_image(comp):
                    return True
        except Exception:
            pass
        return False
