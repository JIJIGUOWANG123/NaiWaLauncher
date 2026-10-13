import aiohttp
import json
import os
import re
import time
import uuid
import tempfile
import urllib.parse
from astrbot.api import logger


def parse_params(raw: str) -> list:
    """把用户输入拆成参数列表（逗号、空格、顿号都作为分隔）"""
    if not raw:
        return []
    text = str(raw)
    for sep in ("，", "、", " ", "\t", "\n"):
        text = text.replace(sep, ",")
    return [x.strip() for x in text.split(",") if x.strip()]


def build_url(template: str, params: list) -> str:
    """
    替换 URL 模板里的占位符。
    支持：
      {qq} {qq1} {qq2} ...   → 参数（调用方负责校验类型）
      {text} {text1} {text2} → 文本参数
      {pic} {pic1} {pic2}    → 兼容旧配置（不校验类型）

    另外：参数值本身可以直接写成下面这些「引用」，调用方会先解析成具体值，
    这里再做一层兜底（万一调用方没解析，也不会把 {qq} 原样发出去）：
      {qq} {me} {at}  → 见 resolve_param_refs
    """
    if not template:
        return template

    url = template

    def _quote(v):
        return urllib.parse.quote(str(v), safe="")

    # 兜底：参数值若仍是 {qq}/{me}/{at} 之类的引用，按原样清掉花括号，
    # 避免把 "{qq}" 这种字面量发给接口（接口只会回 400）。
    params = [p for p in (params or [])]
    for _i, _p in enumerate(params):
        _t = str(_p or "").strip()
        if len(_t) >= 3 and _t.startswith("{") and _t.endswith("}"):
            _inner = _t[1:-1].strip().lower()
            if _inner in ("qq", "me", "at", "user", "sender"):
                params[_i] = ""

    if "{qq}" in url:
        val = params[0] if params else ""
        url = url.replace("{qq}", _quote(val))

    for i in range(1, 6):
        ph = f"{{qq{i}}}"
        if ph in url:
            idx = i - 1
            val = params[idx] if idx < len(params) else ""
            url = url.replace(ph, _quote(val))

    if "{text}" in url:
        val = params[0] if params else ""
        url = url.replace("{text}", _quote(val))

    for i in range(1, 6):
        ph = f"{{text{i}}}"
        if ph in url:
            idx = i - 1
            val = params[idx] if idx < len(params) else ""
            url = url.replace(ph, _quote(val))

    if "{pic}" in url:
        val = params[0] if params else ""
        url = url.replace("{pic}", _quote(val))

    for i in range(1, 6):
        ph = f"{{pic{i}}}"
        if ph in url:
            idx = i - 1
            val = params[idx] if idx < len(params) else ""
            url = url.replace(ph, _quote(val))

    return url


# @ 占位符：event_helpers.split_text_and_ats 用 \x00AT<n>\x00 标记被 @ 的人
_AT_TOKEN_CHARS = "\x00"


def validate_meme_params(text: str) -> str:
    """
    校验「关键词之外的内容」是否只由 参数 组成。

    规则：
      · 允许 **纯数字串**（连续的 0-9 = QQ号）
      · 允许 @占位符（\x00AT0\x00，最终会还原成 QQ号）
      · 允许逗号/顿号/空格等分隔符
      · **只要出现其它任何文字，就不算参数** -> 返回空串表示不触发

    返回归一化后的参数字符串（分隔符统一成空格）；不合法时返回 ""。
    """
    if not text:
        return ""
    raw = str(text)

    # 允许的分隔符：空白 / 逗号 / 顿号 / 字面 @
    # （用户在群里打「关键词@123456」时那个 @ 就是字面字符）
    _SEPS = ",,\uff0c\u3001@"
    _SEP_RE = r"[,\uff0c\u3001@\s]+"

    # 先把空白删掉，方便判断数字之间是否只由分隔符连接
    no_space = re.sub(r"\s+", "", raw)

    # ① 纯数字（含逗号/顿号/@ 分隔）
    if no_space:
        compact = no_space
        for sep in _SEPS:
            compact = compact.replace(sep, "")
        if compact.isdigit():
            return re.sub(_SEP_RE, " ", raw).strip()

    # ② 数字 + @占位符 混排（先去掉占位符，再看剩下的是不是纯数字/分隔符）
    if _AT_TOKEN_CHARS in raw:
        stripped = raw
        for m in re.finditer(r"\x00AT\d+\x00", raw):
            stripped = stripped.replace(m.group(0), "")
        stripped = re.sub(r"\s+", "", stripped)
        for sep in _SEPS:
            stripped = stripped.replace(sep, "")
        if stripped == "" or stripped.isdigit():
            return re.sub(_SEP_RE, " ", raw).strip()

    return ""


# 参数值里可用的「引用」，会替换成当前上下文的人
#   {qq} / {me} / {at}  → 发送者 QQ（若指令里 @ 了别人，restore_ats 已换成数字）
#   {bot}               → 机器人自身 QQ
PARAM_REF_RE = re.compile(r"\{\s*(qq|me|at|user|sender|bot)\s*\}", re.I)


def resolve_param_refs(text: str, sender_id: str = "", bot_id: str = "") -> str:
    """
    把参数值里的 {qq}/{me}/{at} 换成发送者 QQ，{bot} 换成机器人 QQ。

    这样后台接口模板可以写 `pic={qq}`，
    用户只需发「家人们谁懂啊」就会带上自己的 QQ；
    也可以发「家人们谁懂啊 @某人」把对方 QQ 带进去。
    """
    if not text:
        return text
    sender_id = str(sender_id or "").strip()
    bot_id = str(bot_id or "").strip()

    def _sub(m):
        key = m.group(1).lower()
        if key == "bot":
            return bot_id or sender_id
        return sender_id

    return PARAM_REF_RE.sub(_sub, str(text))


def detect_param_types(template: str, param_count: int) -> list:
    """
    根据 URL 模板里出现的占位符，推断每个参数的类型。
    返回列表，长度 = param_count，元素为 "qq" / "text" / "any"。

    优先级：qq > text > any
    """
    types = ["any"] * max(0, param_count)
    if not template:
        return types

    def _set(idx, t):
        if idx < 0 or idx >= len(types):
            return
        rank = {"qq": 3, "text": 2, "any": 1}
        if rank.get(t, 0) > rank.get(types[idx], 0):
            types[idx] = t

    if "{qq}" in template:
        _set(0, "qq")
    for i in range(1, 6):
        if f"{{qq{i}}}" in template:
            _set(i - 1, "qq")

    if "{text}" in template:
        _set(0, "text")
    for i in range(1, 6):
        if f"{{text{i}}}" in template:
            _set(i - 1, "text")

    if "{pic}" in template:
        _set(0, "any")
    for i in range(1, 6):
        if f"{{pic{i}}}" in template:
            _set(i - 1, "any")

    return types


# 各类媒体格式的后缀映射
_EXT_MAP = {
    "jpeg": "jpg", "jpg": "jpg", "png": "png", "gif": "gif", "webp": "webp",
    "bmp": "bmp", "svg": "svg", "avif": "avif", "heic": "heic",
    "mp4": "mp4", "webm": "webm", "quicktime": "mov", "x-matroska": "mkv",
    "x-msvideo": "avi", "mpeg": "mpeg", "3gpp": "3gp", "x-flv": "flv",
}


def _guess_media(content_type: str, url: str = "") -> tuple:
    """
    根据 content-type（必要时看 URL 后缀）判断媒体类型。
    返回 (kind, ext)，kind 为 "image" / "video" / "unknown"。
    """
    ct = (content_type or "").lower().split(";")[0].strip()
    ext = ""
    for key, val in _EXT_MAP.items():
        if key in ct:
            ext = val
            break

    if ct.startswith("video/") or ext in ("mp4", "webm", "mov", "mkv", "avi", "mpeg", "3gp", "flv"):
        return "video", ext or "mp4"
    if ct.startswith("image/") or ext in ("jpg", "png", "gif", "webp", "bmp", "svg", "avif", "heic"):
        return "image", ext or "png"

    # content-type 不认识时，退回看 URL 后缀
    lower_url = (url or "").lower().split("?")[0]
    for suffix, kind in (
        (".mp4", "video"), (".webm", "video"), (".mov", "video"), (".mkv", "video"),
        (".avi", "video"), (".flv", "video"), (".gif", "image"), (".jpg", "image"),
        (".jpeg", "image"), (".png", "image"), (".webp", "image"),
    ):
        if lower_url.endswith(suffix):
            return kind, suffix.lstrip(".")
    return "unknown", ext or "bin"


def get_content_ext(content_type: str) -> str:
    """兼容旧接口：仅按 content-type 推断后缀。
    历史上无法识别时统一回落 png，这里保持一致，避免影响既有调用方。"""
    _kind, ext = _guess_media(content_type)
    if not ext or ext == "bin":
        return "png"
    return ext


# JSON 里常见的媒体地址字段名，按优先级排序
_URL_FIELD_CANDIDATES = (
    "video", "video_url", "videourl", "mp4", "play", "play_url", "playurl",
    "url", "src", "image", "image_url", "imageurl", "img", "imgurl",
    "pic", "picture", "cover", "media", "file", "download",
)

# 值明显不是媒体直链的字段，避免误取
_URL_SKIP_VALUES = ("success", "ok", "true", "false", "null", "none", "")


def _looks_like_media_url(value: str) -> bool:
    """判断一个字符串是否像媒体地址（http/https 开头，或指向常见媒体后缀）。"""
    if not isinstance(value, str):
        return False
    v = value.strip()
    if not v or v.lower() in _URL_SKIP_VALUES:
        return False
    lower = v.lower().split("?")[0]
    if lower.startswith(("http://", "https://")):
        return True
    # 相对路径：必须带媒体后缀才认
    return any(lower.endswith(s) for s in (
        ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".m3u8",
        ".gif", ".jpg", ".jpeg", ".png", ".webp", ".bmp",
    ))


def _get_by_path(data, path: str):
    """按 "data.video" 这样的点号路径取值，取不到返回 None。"""
    cur = data
    for part in str(path or "").split("."):
        part = part.strip()
        if not part:
            continue
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list):
            if not part.isdigit() or int(part) >= len(cur):
                return None
            cur = cur[int(part)]
        else:
            return None
    return cur


def extract_media_url(payload, json_field: str = "") -> str:
    """
    从接口返回的 JSON 里提取媒体地址。

    提取顺序：
      1. 规则里显式配置的字段（json_field，支持 "data.video" 这种点号路径）
      2. 深度优先搜索常见字段名（video / url / mp4 ...）
      3. 递归扫描所有字符串值，找出像媒体直链的那个
    找不到返回空串。
    """
    if payload is None:
        return ""

    # 1) 显式配置优先
    if json_field:
        val = _get_by_path(payload, json_field)
        if isinstance(val, str) and _looks_like_media_url(val):
            return val.strip()
        # 显式字段存在但不像直链时继续兜底，不直接失败

    # 2) 按常见字段名搜索（同一层优先，再看嵌套）
    def _search_fields(node, depth=0):
        if depth > 6:
            return ""
        if isinstance(node, dict):
            for key in _URL_FIELD_CANDIDATES:
                if key in node:
                    val = node[key]
                    if isinstance(val, str) and _looks_like_media_url(val):
                        return val.strip()
                    # 字段值是嵌套对象时继续往里找
                    if isinstance(val, (dict, list)):
                        got = _search_fields(val, depth + 1)
                        if got:
                            return got
            for val in node.values():
                if isinstance(val, (dict, list)):
                    got = _search_fields(val, depth + 1)
                    if got:
                        return got
        elif isinstance(node, list):
            for item in node:
                got = _search_fields(item, depth + 1)
                if got:
                    return got
        return ""

    got = _search_fields(payload)
    if got:
        return got

    # 3) 全量扫描字符串
    def _scan(node, depth=0):
        if depth > 6:
            return ""
        if isinstance(node, str):
            return node.strip() if _looks_like_media_url(node) else ""
        if isinstance(node, dict):
            for val in node.values():
                got = _scan(val, depth + 1)
                if got:
                    return got
        elif isinstance(node, list):
            for item in node:
                got = _scan(item, depth + 1)
                if got:
                    return got
        return ""

    return _scan(payload)


def _json_error_message(payload) -> str:
    """从 JSON 里取出可读的错误信息，用于失败提示。"""
    if isinstance(payload, dict):
        for k in ("msg", "message", "error", "errmsg", "info"):
            v = payload.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        code = payload.get("code")
        if code not in (None, 0, "0", 200, "200"):
            return f"code={code}"
    return ""


async def download_media(
    url: str,
    timeout: int = 15,
    expect: str = "",
    json_field: str = "",
    _depth: int = 0,
    _seen=None,
) -> tuple:
    """
    下载接口返回的媒体（图片或视频）。
    返回 (file_path, kind)，kind 为 "image" / "video" / "unknown"。

    expect    : 规则里标注的期望类型（"image" / "video"）。
                当 content-type 和 URL 后缀都无法判断时用它兜底。
    json_field: 接口返回 JSON 时，媒体地址所在的字段（如 "data.video"）。
                留空则自动搜索常见字段名。
    """
    seen = _seen if _seen is not None else set()
    if _depth > 3:
        raise RuntimeError("接口返回的 JSON 嵌套层级过深，无法提取媒体地址")
    if url in seen:
        raise RuntimeError("接口返回的 JSON 指向了同一个地址，疑似循环")
    seen.add(url)

    logger.info(f"[meme-api] 请求 URL: {url}")
    t = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=t) as session:
        async with session.get(url) as resp:
            content_type = resp.headers.get("content-type", "").lower()
            if resp.status != 200:
                try:
                    body = await resp.text()
                except Exception:
                    body = ""
                logger.warning(
                    f"[meme-api] HTTP {resp.status}, body={body[:300]}"
                    f"\n           请求 URL: {url}"
                )
                # 占位符没被替换是最常见的 400 原因，单独点出来
                if "{" in str(url) and "}" in str(url):
                    logger.warning(
                        "[meme-api] ★ 请求 URL 里还残留 { } 占位符，"
                        "说明参数没传进来："
                        "可在关键词后补参数，或用 {qq} 表示发送者自己"
                    )
                raise RuntimeError(f"接口异常 HTTP {resp.status}")

            # ---- 接口返回 JSON：说明是「API 包装」，真正的媒体地址在 JSON 里 ----
            if "application/json" in content_type or "text/plain" in content_type:
                payload = None
                try:
                    payload = await resp.json(content_type=None)
                except Exception:
                    try:
                        payload = json.loads(await resp.text())
                    except Exception:
                        payload = None

                if payload is not None:
                    media_url = extract_media_url(payload, json_field)
                    if not media_url:
                        msg = _json_error_message(payload) or "未找到媒体地址"
                        logger.warning(f"[meme-api] JSON 中未找到媒体地址: {payload}")
                        raise RuntimeError(
                            f"接口返回的是 JSON，但没找到媒体地址：{msg}"
                            + ("（可在规则里配置「JSON字段」指定路径）" if not json_field else
                               f"（已按字段 {json_field} 查找）")
                        )

                    # 相对路径补全为绝对地址
                    if media_url.startswith("//"):
                        media_url = "https:" + media_url
                    elif media_url.startswith("/"):
                        parsed = urllib.parse.urlsplit(str(resp.url) if resp.url else url)
                        media_url = f"{parsed.scheme}://{parsed.netloc}{media_url}"

                    logger.info(
                        f"[meme-api] 从 JSON 提取到媒体地址"
                        f"{'（字段 ' + json_field + '）' if json_field else ''}: {media_url}"
                    )
                    # 递归下载真正的媒体文件
                    return await download_media(
                        media_url,
                        timeout=timeout,
                        expect=expect,
                        json_field=json_field,
                        _depth=_depth + 1,
                        _seen=seen,
                    )

            final_url = str(resp.url) if resp.url else url
            kind, ext = _guess_media(content_type, final_url)

            # content-type / 后缀都判断不出来时，按规则期望类型兜底
            want = str(expect or "").strip().lower()
            if kind == "unknown" and want in ("image", "video"):
                kind = want
                ext = "mp4" if want == "video" else "png"
                logger.info(
                    f"[meme-api] 无法从响应判断类型（content-type={content_type!r}），"
                    f"按规则标注当作 {want} 处理"
                )

            if kind == "unknown":
                logger.warning(
                    f"[meme-api] 无法识别的媒体类型: content-type={content_type!r}, url={final_url}"
                )
                raise RuntimeError(
                    f"接口返回了未知格式的内容（{content_type or '无 content-type'}），"
                    f"请在规则里把「返回类型」设为 image / video / text"
                )

            data = await resp.read()

    tmp_dir = os.path.join(tempfile.gettempdir(), "astrbot_meme")
    os.makedirs(tmp_dir, exist_ok=True)
    try:
        now = time.time()
        for fn in os.listdir(tmp_dir):
            fp = os.path.join(tmp_dir, fn)
            if os.path.isfile(fp) and now - os.path.getmtime(fp) > 3600:
                os.remove(fp)
    except Exception:
        pass

    fname = f"meme_{int(time.time())}_{uuid.uuid4().hex[:8]}.{ext}"
    fpath = os.path.join(tmp_dir, fname)
    with open(fpath, "wb") as f:
        f.write(data)
    logger.info(f"[meme-api] 已下载 {kind}（{len(data)} 字节）-> {fpath}")
    return fpath, kind


def extract_text_from_body(body: str, content_type: str = "",
                           json_field: str = "") -> str:
    """
    从接口响应里提取要发送的文本。支持三种常见形式：

      ① 纯文本        —— 直接返回正文
      ② document.write("...")  —— 只取括号里的文字
      ③ JSON          —— 按 json_field（默认 content）取字段，
                         取不到时依次尝试常见字段

    提取不到时返回空串。
    """
    text = str(body or "").strip()
    if not text:
        return ""

    ct = (content_type or "").lower()
    looks_json = "json" in ct or text.startswith("{") or text.startswith("[")

    # ③ JSON：按字段提取
    if looks_json:
        try:
            payload = json.loads(text)
        except Exception:
            payload = None
        if payload is not None:
            fields = []
            if json_field:
                fields.append(json_field)
            fields += ["content", "text", "msg", "message", "data.content",
                       "data.text", "data.msg", "data", "result"]
            for f in fields:
                val = _get_by_path(payload, f)
                if isinstance(val, (str, int, float)) and str(val).strip():
                    return str(val).strip()
                # data 是字符串时也算命中
                if isinstance(val, str) and val.strip():
                    return val.strip()
            return ""

    # ② document.write("...") / document.writeln('...')
    m = re.search(r"""document\.write(?:ln)?\(\s*(["'])(.*?)\1\s*\)""", text, re.S)
    if m:
        inner = m.group(2)
        return _unescape_js(inner).strip()

    # ① 纯文本
    return text


def _unescape_js(s: str) -> str:
    """还原 JS 字符串里常见的转义"""
    if not s:
        return ""
    out = s.replace("\\n", "\n").replace("\\t", "\t")
    out = out.replace('\\"', '"').replace("\\'", "'")
    out = out.replace("\\/", "/").replace("\\\\", "\\")
    return out


async def fetch_text(
    url: str,
    timeout: int = 15,
    json_field: str = "",
    _depth: int = 0,
    _seen=None,
) -> str:
    """
    请求接口并返回要发送的**文本**（文本接口用）。
    支持纯文本 / document.write(...) / JSON 字段提取。
    """
    import aiohttp

    _seen = _seen or set()
    if url in _seen:
        raise RuntimeError("接口重定向循环")
    if _depth > 3:
        raise RuntimeError("接口重定向次数过多")
    _seen.add(url)

    headers = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0 Safari/537.36"),
        "Accept": "text/plain,text/html,application/json,*/*",
    }
    client_timeout = aiohttp.ClientTimeout(total=timeout)
    async with aiohttp.ClientSession(timeout=client_timeout, headers=headers) as session:
        async with session.get(url) as resp:
            content_type = resp.headers.get("content-type", "") or ""
            body = await resp.text(errors="replace")
            if resp.status != 200:
                logger.warning(
                    f"[meme-api] 文本接口 HTTP {resp.status}, body={body[:300]}"
                    f"\n           请求 URL: {url}"
                )
                if "{" in str(url) and "}" in str(url):
                    logger.warning(
                        "[meme-api] ★ 请求 URL 里还残留 { } 占位符，"
                        "说明参数没传进来"
                    )
                raise RuntimeError(f"接口异常 HTTP {resp.status}")

    text = extract_text_from_body(body, content_type, json_field)
    if not text:
        logger.warning(f"[meme-api] 文本接口未提取到内容: {body[:300]}")
        raise RuntimeError(
            "接口没有返回可用的文本"
            + (f"（已按字段 {json_field} 查找）" if json_field else
               "（可在规则里配置「JSON字段」指定路径）")
        )
    logger.info(f"[meme-api] 文本接口提取成功（{len(text)} 字）")
    return text


async def download_image(url: str, timeout: int = 15) -> str:
    """兼容旧接口：只下载图片，返回本地路径。"""
    path, kind = await download_media(url, timeout=timeout)
    if kind != "image":
        raise RuntimeError("接口返回的不是图片")
    return path