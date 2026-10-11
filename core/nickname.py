import os
import json

from astrbot.api import logger

from .path_utils import nickname_data_path


class NicknameCache:
    """
    全局 QQ 昵称缓存（跨群共享）。
    结构：{qq: nickname}
    """

    def __init__(self):
        self._data = {}
        self._dirty = False
        self._load()

    def _load(self):
        path = nickname_data_path()
        if not os.path.exists(path):
            self._data = {}
            return
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                self._data = json.load(f) or {}
            logger.info(f"[apix-meme] 已加载 {len(self._data)} 条昵称缓存")
        except Exception:
            logger.exception("[apix-meme] 读取昵称缓存失败")
            self._data = {}

    def _save(self):
        if not self._dirty:
            return
        try:
            path = nickname_data_path()
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
            self._dirty = False
        except Exception:
            logger.exception("[apix-meme] 保存昵称缓存失败")

    # ============================================================
    # 对外接口
    # ============================================================
    def update(self, user_id: str, user_name: str):
        if not user_id or not user_name:
            return
        uid = str(user_id)
        name = str(user_name).strip()
        if not name or name.startswith("QQ"):
            return
        if self._data.get(uid) != name:
            self._data[uid] = name
            self._dirty = True
            self._save()

    def get(self, user_id: str) -> str:
        return self._data.get(str(user_id), "")

    def as_dict(self) -> dict:
        """返回内部字典的引用（给 checkin / greeting 模块共享）"""
        return self._data