"""
更新日志解析（1.7.3）

数据源：**插件根目录 metadata.yaml 的 `version_history` 段落**。

  ★★ 1.0：原来从 README.md 的「## 📝 更新日志」章节解析；
    README 里那一段已删除，版本记录统一挪到 metadata.yaml ——
    也就是市场提交时读的那个文件，一处维护不会不一致。
    （仍然兼容旧格式：metadata 里读不到会自动回落 README 解析。）

采用**运行时解析**而不是硬编码，好处是：
  · 更新 metadata.yaml 就等于更新日志，不用改两处
  · 不会出现「指令显示的版本和 metadata 不一致」
解析失败时返回空列表，调用方回落提示，不影响其它功能。

输出原则：
  · 正文**完整保留**，不截断、不改写，只去掉 Markdown 标记
  · 指令默认**只显示最新一天**的更新（同一天的多条一起显示）
"""
import os
import re

from astrbot.api import logger
# 章节标题（标题里含「更新日志」即可，允许前后有空格）
_SECTION_RE = re.compile(r"^##\s*[^#\n]*更新日志\s*$", re.M)
# 单条：**v1.7.3（2026-10-03）** 正文（正文可以是多行，每行一项）
#   正文用「行首」锚定结束：遇到空行后的下一个 **vX.Y.Z（日期）** 或 ## 标题为止
_ENTRY_HEAD_RE = re.compile(
    r"^\*\*v([0-9][0-9.]*)[（(]([^）)]*)[）)]\*\*[ \t]*(.*)$", re.M
)
_README_NAME = "README.md"
# 显示条数硬上限（「全部」时避免刷屏）
_MAX_ALL = 30


def _readme_path() -> str:
    """插件根目录下的 README.md（本模块在 core/ 下）"""
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, _README_NAME)


def read_readme() -> str:
    """读 README 文本，失败返回空串"""
    try:
        p = _readme_path()
        if not os.path.isfile(p):
            logger.warning(f"[changelog] 未找到 {p}")
            return ""
        with open(p, "r", encoding="utf-8-sig") as f:
            return f.read()
    except Exception:
        logger.exception("[changelog] 读取 README 失败")
        return ""


def _clean_body(raw: str) -> str:
    """
    清理正文：去掉 Markdown 标记，**保留换行**（每行一项）。

    · 不截断内容
    · 去掉 `**加粗**`、`` `代码` ``（聊天窗口不渲染 Markdown）
    · 去掉行首的 `-`/`*` 列表符号 —— 群里看到「- 」很啰嗦
    """
    s = str(raw or "")
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)   # 加粗
    s = re.sub(r"`([^`]*)`", r"\1", s)        # 行内代码
    out_lines = []
    for ln in s.splitlines():
        ln = re.sub(r"[ \t\u3000]+", " ", ln).strip()
        ln = re.sub(r"^[-*\u2022]\s*", "", ln)   # 行首列表符号
        if ln:
            out_lines.append(ln)
    return "\n".join(out_lines)


def parse_entries() -> list:
    """
    解析更新日志，返回 [{version, date, body}, ...]（最新在前）。

    ★★ 1.0：数据源从 **README.md** 改到 **metadata.yaml** 的
      `version_history` 段落。原因：README 里的「更新日志」章节已移除，
      版本记录统一放到 metadata.yaml（也就是市场提交时读的那个文件），
      一处维护、不会出现两处不一致。

    metadata.yaml 里的写法：

        version: "1.0"
        version_history:
          - version: v1.0
            date: 2026-10-10
            desc: 测试结束了，正式版1.0已经发布了。
          - version: v1.1
            date: 2026-10-11
            desc: 新增群管系统。

    ★ 兼容：万一 metadata.yaml 里读不到，自动回落到旧的
      「README.md 更新日志章节」解析方式，不会因为改格式而丢日志。
    """
    items = _parse_metadata()
    if items:
        return items
    return _parse_readme()


def _parse_metadata() -> list:
    """从 metadata.yaml 的 version_history 读（新方式）"""
    try:
        import yaml
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        path = os.path.join(base, "metadata.yaml")
        if not os.path.isfile(path):
            return []
        with open(path, "r", encoding="utf-8-sig") as f:
            data = yaml.safe_load(f) or {}
        hist = data.get("version_history") or []
        if not isinstance(hist, list):
            return []
        out = []
        for it in hist:
            if not isinstance(it, dict):
                continue
            ver = str(it.get("version", "") or "").strip()
            ver = ver.lstrip("vV")          # v1.0 -> 1.0（显示时再加 v）
            if not ver:
                continue
            out.append({
                "version": ver,
                "date": str(it.get("date", "") or "").strip(),
                "body": _clean_body(str(it.get("desc", "") or "")),
            })
        return out
    except Exception:
        logger.exception("[changelog] 读取 metadata.yaml 的 version_history 失败")
        return []


def _parse_readme() -> list:
    """旧方式：README.md 的「## 📝 更新日志」章节（兼容保留）"""
    text = read_readme()
    if not text:
        return []
    # 只取「更新日志」章节
    m = _SECTION_RE.search(text)
    seg = text[m.end():] if m else text
    # 遇到下一个二级标题就停
    nxt = re.search(r"^##\s", seg, re.M)
    if nxt:
        seg = seg[:nxt.start()]

    out = []
    heads = list(_ENTRY_HEAD_RE.finditer(seg))
    for k, em in enumerate(heads):
        # 正文 = 本行剩余 + 直到下一条目之前的行
        end = heads[k + 1].start() if k + 1 < len(heads) else len(seg)
        first = em.group(3).strip()
        rest = seg[em.end():end]
        # 去掉与下一条之间的分隔空行
        rest = rest.rstrip()
        body = (first + "\n" + rest) if rest.strip() else first
        out.append({
            "version": em.group(1),
            "date": em.group(2).strip(),
            "body": _clean_body(body),
        })
    return out


def latest_day() -> list:
    """
    最新**一天**的所有条目。

    同一天可能发了多个版本（如 1.7.2 / 1.7.1 都是 10-02），
    这些一起返回，方便「今天更新了什么」一次看全。
    """
    items = parse_entries()
    if not items:
        return []
    d0 = items[0].get("date", "")
    if not d0:
        return items[:1]
    return [it for it in items if it.get("date", "") == d0]


def build_text(scope: str = "day", title: str = "本次更新") -> str:
    """
    拼成可直接发送的文本。

    scope:
      "day"  -> 只显示最新一天（默认）
      "all"  -> 显示全部（最多 _MAX_ALL 条）

    正文与 metadata.yaml 里写的一致（仅去掉 Markdown 标记）。
    """
    if str(scope).lower() in ("all", "全部"):
        items = parse_entries()[:_MAX_ALL]
    else:
        items = latest_day()

    if not items:
        return ("⚠️ 读不到更新日志\n"
                "💡 请确认插件根目录 metadata.yaml 里配置了 "
                "`version_history`（版本更新记录）")

    lines = []
    if title:
        lines.append(f"📝 {title}")     # 简洁一行标题
    for it in items:
        head = f"v{it['version']}"
        if it.get("date"):
            head += f"（{it['date']}）"
        lines.append("")
        lines.append(head)
        if it.get("body"):
            lines.append(it["body"])
    return "\n".join(lines).rstrip()
