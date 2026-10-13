import os
import json
import time
import asyncio
import datetime
import threading
import aiohttp
from astrbot.api import logger
from .path_utils import title_bar, title_foot

# ★ 新增：模块级全局锁
_GLOBAL_MC_LOCK = threading.Lock()

JAVA_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
BE_RELEASES_URL = "https://api.github.com/repos/Mojang/bedrock-samples/releases?per_page=30"


def _now_ts() -> int:
    return int(time.time())


def _fmt_time(ts) -> str:
    if not ts:
        return "（未知）"
    try:
        return datetime.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "（未知）"


def _parse_iso(iso: str) -> int:
    if not iso:
        return 0
    s = str(iso).strip()
    formats = [
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%S",
    ]
    for fmt in formats:
        try:
            dt = datetime.datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp())
        except Exception:
            continue
    return 0


async def _get_json(
    session: aiohttp.ClientSession,
    url: str,
    timeout: int = 15,
    token: str = "",
):
    t = aiohttp.ClientTimeout(total=timeout)
    headers = {
        "User-Agent": "AstrBot-MC-Version-Checker/1.0",
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # ★★ 1.7：不再接受 `ssl=` 覆盖 —— 一律用 aiohttp 默认的
    #   证书校验（系统受信任 CA），杜绝「为了绕开报错直接关校验」。
    kwargs = {"timeout": t, "headers": headers}
    async with session.get(url, **kwargs) as resp:
        if resp.status == 403:
            raise PermissionError("HTTP 403（GitHub 限速或网络受限）")
        if resp.status != 200:
            raise RuntimeError(f"HTTP {resp.status}")
        return await resp.json(content_type=None)


# ============================================================
# Java 版
# ============================================================
async def fetch_java() -> dict:
    async with aiohttp.ClientSession() as session:
        data = await _get_json(session, JAVA_MANIFEST_URL)
    if not isinstance(data, dict):
        raise RuntimeError("Java manifest 返回格式异常")
    latest = data.get("latest", {}) or {}
    release = str(latest.get("release", "")).strip()
    snapshot = str(latest.get("snapshot", "")).strip()
    release_time = 0
    snapshot_time = 0
    versions = data.get("versions", []) or []
    for v in versions:
        if not isinstance(v, dict):
            continue
        vid = str(v.get("id", "")).strip()
        vtype = str(v.get("type", "")).strip()
        rtime = _parse_iso(str(v.get("releaseTime", "")).strip())
        if vid == release and vtype == "release" and not release_time:
            release_time = rtime
        if vid == snapshot and vtype == "snapshot" and not snapshot_time:
            snapshot_time = rtime
        if release_time and snapshot_time:
            break
    return {
        "release": release,
        "release_time": release_time,
        "snapshot": snapshot,
        "snapshot_time": snapshot_time,
    }


# ============================================================
# BE 版（手动查询时调用；自动检测不调用）
# ============================================================
def _is_preview_tag(tag: str) -> bool:
    t = (tag or "").lower()
    return ("preview" in t) or ("-pre" in t) or ("beta" in t)


async def fetch_bedrock(token: str = "", retry: int = 2) -> dict:
    """
    拉取基岩版版本信息。
    只在手动查询 MC版本 时调用，自动检测不会再触发。
    保留重试机制应对偶发 403。
    """
    # ★★ 1.7：**这里原来关掉了证书校验**
    #   （`check_hostname = False` + `verify_mode = CERT_NONE`）。
    #   已恢复默认校验：`aiohttp` 不传 `ssl=` 参数时就会用系统的
    #   受信任 CA 库验证服务器证书，和 `fetch_java` 保持一致。
    last_err = None
    for attempt in range(retry + 1):
        try:
            async with aiohttp.ClientSession() as session:
                releases = await _get_json(
                    session, BE_RELEASES_URL, token=token
                )
            break
        except PermissionError as e:
            last_err = e
            if attempt < retry:
                wait = 3 * (attempt + 1)
                logger.warning(
                    f"[minecraft] BE 接口 403（第 {attempt + 1} 次），"
                    f"{wait}s 后重试。建议配置 GitHub Token。"
                )
                await asyncio.sleep(wait)
            else:
                raise
        except Exception as e:
            last_err = e
            if attempt < retry:
                await asyncio.sleep(2)
            else:
                raise
    else:
        if last_err:
            raise last_err

    if not isinstance(releases, list):
        raise RuntimeError("GitHub releases 返回格式异常")

    release_ver = ""
    release_time = 0
    preview_ver = ""
    preview_time = 0
    for r in releases:
        if not isinstance(r, dict):
            continue
        tag = str(r.get("tag_name", "")).strip()
        if not tag:
            continue
        ver = tag[1:] if tag.lower().startswith("v") else tag
        ts = _parse_iso(str(r.get("published_at", "")).strip())
        is_pre = bool(r.get("prerelease")) or _is_preview_tag(tag)
        if is_pre:
            if not preview_ver:
                preview_ver = ver
                preview_time = ts
        else:
            if not release_ver:
                release_ver = ver
                release_time = ts
        if release_ver and preview_ver:
            break

    return {
        "release": release_ver,
        "release_time": release_time,
        "preview": preview_ver,
        "preview_time": preview_time,
    }


# ============================================================
# 模块
# ============================================================
class MinecraftVersionModule:
    """
    Minecraft 版本检测：
      - Java 版最新正式版 / 测试版（自动检测 + 手动查询都用）
      - BE 版最新正式版 / 预览版（仅手动查询时拉取）
      - 自动检测：只比较 Java 版，不碰 GitHub，彻底避免 403
      - 手动查询：Java + BE 一起拉取，BE 失败不影响 Java
    """

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.enable = True
        self.interval = 3600
        self.github_token = ""
        self.last_result = {}
        self.last_check_ts = 0
        self.last_notified = {}
        self.auto_groups = []
        self.group_notified = {}
        self.umos = {}
        self._load_state()

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        self.enable = bool(cfg.get("minecraft_enable", True))
        try:
            itv = int(str(cfg.get("minecraft_check_interval", "3600")).strip() or "3600")
        except Exception:
            itv = 3600
        if itv < 0:
            itv = 0
        self.interval = itv
        self.github_token = str(cfg.get("minecraft_github_token", "") or "").strip()

    # ============================================================
    # 状态持久化
    # ============================================================
    def _load_state(self):
        if not os.path.exists(self.data_path):
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f) or {}
            self.last_result = data.get("last_result", {}) or {}
            self.last_check_ts = int(data.get("last_check_ts", 0) or 0)
            self.last_notified = data.get("last_notified", {}) or {}
            self.auto_groups = data.get("auto_groups", []) or []
            self.group_notified = data.get("group_notified", {}) or {}
            self.umos = data.get("umos", {}) or {}
        except Exception:
            logger.exception("[minecraft] 读取状态失败")

    def _save_state(self):
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "last_result": self.last_result,
                        "last_check_ts": self.last_check_ts,
                        "last_notified": self.last_notified,
                        "auto_groups": self.auto_groups,
                        "group_notified": self.group_notified,
                        "umos": self.umos,
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[minecraft] 保存状态失败")

    # ============================================================
    # UMO
    # ============================================================
    def record_umo(self, group_id, umo: str):
        if not group_id or not umo:
            return
        gid = str(group_id)
        if self.umos.get(gid) == umo:
            return
            
        with _GLOBAL_MC_LOCK:
            self._load_state()
            if self.umos.get(gid) != umo:
                self.umos[gid] = umo
                self._save_state()

    def get_umo(self, group_id) -> str:
        return self.umos.get(str(group_id), "")

    # ============================================================
    # 群级自动检测
    # ============================================================
    def is_group_auto(self, group_id) -> bool:
        return str(group_id) in [str(x) for x in self.auto_groups]

    def set_group_auto(self, group_id, enabled: bool):
        gid = str(group_id)
        with _GLOBAL_MC_LOCK:
            self._load_state()
            cur = [str(x) for x in self.auto_groups]
            if enabled:
                if gid not in cur:
                    self.auto_groups.append(gid)
            else:
                self.auto_groups = [x for x in self.auto_groups if str(x) != gid]
            self._save_state()

    # ============================================================
    # 检测（区分手动 / 自动）
    # ============================================================
    def _cache_valid(self) -> bool:
        if not self.last_check_ts:
            return False
        if not self.last_result:
            return False
        if self.interval <= 0:
            return True
        return (_now_ts() - self.last_check_ts) < self.interval

    async def check_all(self, force: bool = False, include_bedrock: bool = False) -> dict:
        """
        force=True 时立即拉取。
        include_bedrock=True 时才请求 GitHub 拉取 BE（手动查询用）；
        自动检测走 include_bedrock=False，永不触发 403。
        """
        if not force and self._cache_valid():
            return self.last_result

        now = _now_ts()
        new_result = {
            "ts": now,
            "java": {},
            "bedrock": {},
            "java_error": "",
            "bedrock_error": "",
        }

        # Java 始终拉取
        try:
            new_result["java"] = await fetch_java()
        except Exception as e:
            logger.warning(f"[minecraft] 获取 Java 版本失败: {e}")
            new_result["java_error"] = str(e)
            old_java = (self.last_result or {}).get("java") or {}
            if old_java:
                new_result["java"] = old_java

        # 只有手动查询才拉 BE
        if include_bedrock:
            try:
                new_result["bedrock"] = await fetch_bedrock(token=self.github_token)
            except PermissionError:
                logger.warning(
                    "[minecraft] 获取 BE 版本受限（403）。"
                    "建议在 WebUI 配置 minecraft_github_token 提升限额。"
                )
                new_result["bedrock_error"] = "403 限速（建议配置 GitHub Token）"
                old_be = (self.last_result or {}).get("bedrock") or {}
                if old_be:
                    new_result["bedrock"] = old_be
            except Exception as e:
                logger.warning(f"[minecraft] 获取 BE 版本失败: {e}")
                new_result["bedrock_error"] = str(e)
                old_be = (self.last_result or {}).get("bedrock") or {}
                if old_be:
                    new_result["bedrock"] = old_be
        else:
            # 自动检测：保留上一次的 BE 结果，方便手动查询时展示
            old_be = (self.last_result or {}).get("bedrock") or {}
            new_result["bedrock"] = old_be

        self.last_result = new_result
        self.last_check_ts = now
        self._save_state()
        return new_result

    # ============================================================
    # 新版本通知（只比较 Java）
    # ============================================================
    def check_new_versions(self, result: dict) -> list:
        with _GLOBAL_MC_LOCK:
            self._load_state()
            msgs = []
            java = (result or {}).get("java", {}) or {}
            if java.get("release"):
                key = f"java_release:{java['release']}"
                if key not in self.last_notified:
                    if self.last_notified.get("java_release"):
                        msgs.append(f"🎉 Java 版发布新正式版：{java['release']}")
                    self.last_notified["java_release"] = java["release"]
                    self.last_notified[key] = True
            if java.get("snapshot"):
                key = f"java_snapshot:{java['snapshot']}"
                if key not in self.last_notified:
                    if self.last_notified.get("java_snapshot"):
                        msgs.append(f"🧪 Java 版发布新测试版：{java['snapshot']}")
                    self.last_notified["java_snapshot"] = java["snapshot"]
                    self.last_notified[key] = True
            if msgs:
                self._save_state()
            return msgs

    def check_new_versions_for_group(self, group_id, result: dict) -> list:
        gid = str(group_id)
        with _GLOBAL_MC_LOCK:
            self._load_state()
            notified = self.group_notified.setdefault(gid, {})
            msgs = []
            java = (result or {}).get("java", {}) or {}
            checks = [
                ("java_release", java.get("release"), "Java 正式版"),
                ("java_snapshot", java.get("snapshot"), "Java 测试版"),
            ]
            changed = False
            for key, val, label in checks:
                if not val:
                    continue
                old = notified.get(key)
                if old and old != val:
                    msgs.append(f"🎉 {label} 更新：{val}")
                    changed = True
                if old != val:
                    notified[key] = val
                    changed = True
            if changed:
                self._save_state()
            return msgs

    # ============================================================
    # 格式化输出
    # ============================================================
    def format_text(self, result: dict = None, include_bedrock: bool = True) -> str:
        """
        include_bedrock=True：显示 Java + BE（手动查询用）
        include_bedrock=False：只显示 Java（自动推送用）
        """
        if result is None:
            result = self.last_result
        lines = [f"{title_bar('Minecraft 版本检测')}"]
        if not result:
            lines.append("")
            lines.append("暂无数据，请稍后重试")
            return "\n".join(lines)

        java = result.get("java", {}) or {}
        lines.append("")
        lines.append("☕ Java 版")
        if java.get("release"):
            lines.append(f"  ✅ 正式版：{java['release']}")
            if java.get("release_time"):
                lines.append(f"     发布：{_fmt_time(java['release_time'])}")
        else:
            lines.append("  正式版：获取失败")
        if java.get("snapshot"):
            lines.append(f"  🧪 测试版：{java['snapshot']}")
            if java.get("snapshot_time"):
                lines.append(f"     发布：{_fmt_time(java['snapshot_time'])}")
        else:
            lines.append("  测试版：获取失败")
        if not java.get("release") and not java.get("snapshot"):
            if result.get("java_error"):
                lines.append(f"  ⚠️ {result['java_error']}")

        if include_bedrock:
            be = result.get("bedrock", {}) or {}
            lines.append("")
            lines.append("🪨 基岩版（BE）")
            if be.get("release"):
                lines.append(f"  ✅ 正式版：{be['release']}")
                if be.get("release_time"):
                    lines.append(f"     发布：{_fmt_time(be['release_time'])}")
            else:
                lines.append("  正式版：获取失败")
            if be.get("preview"):
                lines.append(f"  🧪 预览版：{be['preview']}")
                if be.get("preview_time"):
                    lines.append(f"     发布：{_fmt_time(be['preview_time'])}")
            else:
                lines.append("  预览版：获取失败")
            if not be.get("release") and not be.get("preview"):
                if result.get("bedrock_error"):
                    lines.append(f"  ⚠️ {result['bedrock_error']}")

        ts = result.get("ts", 0)
        if ts:
            lines.append("")
            lines.append(f"🕐 检测时间：{_fmt_time(ts)}")
        return "\n".join(lines)