import inspect
import time

from astrbot.api import logger


# 调用平台 API 失败时的哨兵值，用于区分「失败」和「成功但无返回值」
_API_FAILED = object()


async def _call_group_api(event, action: str, **params):
    """
    调用 OneBot 群管理类 API（踢人 / 禁言 / 查询成员等）。
    成功返回平台响应（可能是 None）；调用过程中抛异常时返回 _API_FAILED。
    """
    bot = getattr(event, "bot", None)
    if bot is None:
        for attr in ("api", "client", "onebot"):
            alt = getattr(event, attr, None)
            if alt is not None:
                bot = alt
                break
    if bot is None:
        return _API_FAILED

    last_err = None

    # 优先直接用同名方法
    if hasattr(bot, action):
        try:
            res = getattr(bot, action)(**params)
            if inspect.isawaitable(res):
                res = await res
            return res
        except Exception as e:
            last_err = e
            logger.warning(f"[moderation] 直接方法 {action} 调用失败: {e}")

    # 其次 call_action
    if hasattr(bot, "call_action"):
        try:
            res = bot.call_action(action, **params)
            if inspect.isawaitable(res):
                res = await res
            return res
        except Exception as e:
            last_err = e
            logger.warning(f"[moderation] call_action({action}) 失败: {e}")

    api = getattr(bot, "api", None)
    if api is not None and hasattr(api, "call_action"):
        try:
            res = api.call_action(action, **params)
            if inspect.isawaitable(res):
                res = await res
            return res
        except Exception as e:
            last_err = e
            logger.warning(f"[moderation] api.call_action({action}) 失败: {e}")

    if last_err is not None:
        logger.warning(f"[moderation] {action} 全部调用方式失败: {last_err}")
    return _API_FAILED


def get_group_id(event) -> str:
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            gid = getattr(mo, "group_id", "") or getattr(mo, "group", "") or ""
            if gid:
                return str(gid)
    except Exception:
        pass
    try:
        gid = getattr(event, "group_id", "") or ""
        if gid:
            return str(gid)
    except Exception:
        pass
    return ""


async def _get_member_list(event):
    """通过 aiocqhttp API 拉取群成员列表"""
    group_id = get_group_id(event)
    if not group_id:
        return None

    bot = getattr(event, "bot", None)
    if bot is None:
        for attr in ("api", "client", "onebot"):
            alt = getattr(event, attr, None)
            if alt is not None:
                bot = alt
                break
    if bot is None:
        return None

    if hasattr(bot, "get_group_member_list"):
        try:
            members = await bot.get_group_member_list(group_id=int(group_id))
            if members:
                return members
        except Exception:
            pass

    if hasattr(bot, "call_action"):
        try:
            members = await bot.call_action(
                "get_group_member_list", group_id=int(group_id)
            )
            if members:
                return members
        except Exception:
            pass

    api = getattr(bot, "api", None)
    if api is not None and hasattr(api, "call_action"):
        try:
            members = await api.call_action(
                "get_group_member_list", group_id=int(group_id)
            )
            if members:
                return members
        except Exception:
            pass

    return None


class GroupAdminModule:
    """
    群主/管理员识别模块（只在本插件内生效，不改 AstrBot 全局配置）。
    每个群缓存一份群主+管理员列表，超时自动重拉，也支持手动刷新。
    """

    def __init__(self):
        self.cache = {}
        self.cache_ttl = 600   # 默认 10 分钟

    def set_ttl(self, ttl_seconds):
        try:
            self.cache_ttl = max(0, int(ttl_seconds))
        except Exception:
            self.cache_ttl = 600

    async def get_group_admins(self, event, force=False):
        group_id = get_group_id(event)
        if not group_id:
            return {"owner": "", "admins": [], "ts": 0}

        now = time.time()
        cached = self.cache.get(group_id)

        if (not force) and cached and (now - cached["ts"] < self.cache_ttl):
            return cached

        members = await _get_member_list(event)
        if not members:
            if cached:
                return cached
            return {"owner": "", "admins": [], "ts": 0}

        owner = ""
        admins = []
        for m in members:
            role = str(m.get("role", "member"))
            uid = str(m.get("user_id", ""))
            if not uid:
                continue
            if role == "owner":
                owner = uid
            elif role == "admin":
                admins.append(uid)

        result = {"owner": owner, "admins": admins, "ts": now}
        self.cache[group_id] = result
        logger.info(
            f"[apix-meme] 群 {group_id} 群主={owner} 管理员数={len(admins)}"
        )
        return result

    async def is_group_admin(self, event, user_id: str) -> bool:
        if not user_id:
            return False
        info = await self.get_group_admins(event)
        if user_id == info.get("owner", ""):
            return True
        if user_id in info.get("admins", []):
            return True
        return False

    # ============================================================
    # ★ 机器人自身在群里的权限（踢人/禁言的前提）
    # ============================================================
    async def get_bot_role(self, event, force: bool = False):
        """
        返回机器人在当前群的权限：{"role": "owner"|"admin"|"member", "can": bool}
        can=True 表示可以踢人/禁言（群主或管理员）。
        """
        group_id = get_group_id(event)
        if not group_id:
            return {"role": "", "can": False}

        info = await self.get_group_admins(event, force=force)
        role = info.get("bot_role")

        # 缓存里没有机器人角色时，主动查一次成员信息
        if role is None:
            role = await self._query_bot_role(event, group_id)
            info["bot_role"] = role
            self.cache[group_id] = info

        role = str(role or "")
        return {"role": role, "can": role in ("owner", "admin")}

    async def _query_bot_role(self, event, group_id: str) -> str:
        """查询机器人自己的群成员角色。"""
        try:
            bot_id = str(event.get_self_id() or "")
        except Exception:
            bot_id = ""
        if not bot_id:
            return ""

        # 1) get_group_member_info
        try:
            res = await _call_group_api(
                event,
                "get_group_member_info",
                group_id=int(group_id),
                user_id=int(bot_id),
                no_cache=True,
            )
            if isinstance(res, dict):
                role = str(res.get("role", "") or "")
                if role:
                    return role
        except Exception:
            pass

        # 2) 退回成员列表里找自己
        members = await _get_member_list(event)
        if members:
            for m in members:
                if str(m.get("user_id", "")) == bot_id:
                    return str(m.get("role", "") or "")
        return ""

    async def kick_member(self, event, user_id: str, reject_add: bool = False) -> bool:
        """踢出群成员。返回是否成功。"""
        group_id = get_group_id(event)
        if not group_id or not user_id:
            return False
        res = await _call_group_api(
            event,
            "set_group_kick",
            group_id=int(group_id),
            user_id=int(str(user_id)),
            reject_add_request=bool(reject_add),
        )
        if res is _API_FAILED:
            logger.warning(f"[moderation] 踢出失败 群{group_id} 成员{user_id}")
            return False
        logger.info(f"[moderation] 已踢出 群{group_id} 成员{user_id}")
        return True

    async def mute_member(self, event, user_id: str, duration: int = 600) -> bool:
        """禁言群成员（duration 秒，最少 60；传 0 表示解除禁言）。返回是否成功。"""
        group_id = get_group_id(event)
        if not group_id or not user_id:
            return False
        try:
            dur = int(duration)
        except Exception:
            dur = 600
        # 0 是合法的「解除禁言」，其余不低于 60
        if dur != 0 and dur < 60:
            dur = 60
        res = await _call_group_api(
            event,
            "set_group_ban",
            group_id=int(group_id),
            user_id=int(str(user_id)),
            duration=dur,
        )
        if res is _API_FAILED:
            logger.warning(f"[moderation] 禁言失败 群{group_id} 成员{user_id}")
            return False
        if dur == 0:
            logger.info(f"[moderation] 已解除禁言 群{group_id} 成员{user_id}")
        else:
            logger.info(f"[moderation] 已禁言 群{group_id} 成员{user_id} {dur}秒")
        return True

    async def unmute_member(self, event, user_id: str) -> bool:
        """解除禁言。"""
        return await self.mute_member(event, user_id, 0)