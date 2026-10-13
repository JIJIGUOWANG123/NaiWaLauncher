"""
插件自定义配置页面后端（AstrBot 4.27+ 桥接方案）。

策略：
  - 本模块只提供文件读写工具函数（read_schema / read_config / write_config）
    和 aiohttp 页面渲染工具函数（render_page_html）。
  - 所有路由注册统一在 main.py 中完成，避免重复注册覆盖。
"""

import os
import json
from astrbot.api import logger

try:
    from astrbot.api.web import json_response, error_response
    _HAS_ASTRBOT_WEB = True
except Exception:
    _HAS_ASTRBOT_WEB = False
    try:
        from aiohttp import web as _aiohttp_web
        def json_response(data, status_code=200):
            return _aiohttp_web.json_response(data, status=status_code)
        def error_response(msg, status_code=400):
            return _aiohttp_web.json_response({"ok": False, "msg": msg}, status=status_code)
    except Exception:
        def json_response(data, status_code=200): return data
        def error_response(msg, status_code=400): return {"ok": False, "msg": msg}


PLUGIN_ID = "astrbot_plugin_custom_entertainment"
PLUGIN_CONFIG_FILENAME = f"{PLUGIN_ID}_config.json"


# ============================================================
# 路径工具
# ============================================================
def _plugin_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_astrbot_root() -> str:
    try:
        import astrbot
        pkg_dir = os.path.dirname(os.path.abspath(astrbot.__file__))
        root = os.path.dirname(pkg_dir)
        if os.path.isdir(os.path.join(root, "data", "config")):
            return root
        root2 = os.path.dirname(root)
        if os.path.isdir(os.path.join(root2, "data", "config")):
            return root2
    except Exception:
        pass
    cur = _plugin_dir()
    for _ in range(6):
        candidate = os.path.join(cur, "data", "config")
        if os.path.isdir(candidate):
            return cur
        cur = os.path.dirname(cur)
    return os.getcwd()


def _cfg_dir() -> str:
    root = _find_astrbot_root()
    cfg_dir = os.path.join(root, "data", "config")
    os.makedirs(cfg_dir, exist_ok=True)
    return cfg_dir


def _config_path() -> str:
    return os.path.join(_cfg_dir(), PLUGIN_CONFIG_FILENAME)


def _schema_path() -> str:
    return os.path.join(_plugin_dir(), "_conf_schema.json")


# ============================================================
# 文件读写
# ============================================================
def read_schema() -> dict:
    try:
        p = _schema_path()
        if not os.path.exists(p):
            return {}
        with open(p, "r", encoding="utf-8-sig") as f:
            return json.load(f) or {}
    except Exception:
        logger.exception("[web_config] read_schema 失败")
        return {}


def read_config() -> dict:
    try:
        p = _config_path()
        if not os.path.exists(p):
            return {}
        with open(p, "r", encoding="utf-8-sig") as f:
            return json.load(f) or {}
    except Exception:
        logger.exception("[web_config] read_config 失败")
        return {}


def write_config(data: dict) -> bool:
    try:
        if not isinstance(data, dict):
            return False
        p = _config_path()
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
        logger.info(f"[web_config] 已写入 {p}，共 {len(data)} 项")
        return True
    except Exception:
        logger.exception("[web_config] write_config 失败")
        return False


# ============================================================
# 页面渲染
# ============================================================
def render_page_html() -> str:
    """读取 pages/dashboard/index.html 内容，找不到返回空串"""
    base = _plugin_dir()
    for sub in [
        ("pages", "dashboard", "index.html"),
        ("pages", "index.html"),
        ("page", "index.html"),
        ("index.html",),
    ]:
        p = os.path.join(base, *sub)
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                logger.exception(f"[web_config] 读取页面失败: {p}")
                return ""
    logger.warning(f"[web_config] 未找到 index.html，base={base}")
    return ""


# ============================================================
# 注册入口（空实现，由 main.py 统一注册路由）
# ============================================================
def register_web_apis(context) -> bool:
    logger.info("[web_config] register_web_apis 被调用（本模块不再注册路由，路由由 main.py 统一注册）")
    return True