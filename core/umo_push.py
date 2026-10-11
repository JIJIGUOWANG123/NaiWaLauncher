import time
from astrbot.api import logger


def get_event_umo(event) -> str:
    """尽最大努力从事件里取出 unified_msg_origin"""
    try:
        umo = getattr(event, "unified_msg_origin", "") or ""
        if umo:
            return str(umo)
    except Exception:
        pass
    try:
        umo = getattr(event, "session_id", "") or ""
        if umo:
            return str(umo)
    except Exception:
        pass
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            umo = getattr(mo, "session_id", "") or ""
            if umo:
                return str(umo)
    except Exception:
        pass
    return ""


def get_platform_id(context) -> str:
    """扫描 AstrBot context，返回首个 aiocqhttp 平台实例 ID，兜底 default"""
    candidates = []

    try:
        for attr in ("platform_manager", "platform", "platforms", "pm"):
            pm = getattr(context, attr, None)
            if pm is None:
                continue
            for m in ("get_platforms", "list_platforms", "all_platforms", "get_all"):
                fn = getattr(pm, m, None)
                if not callable(fn):
                    continue
                try:
                    plats = fn()
                except Exception:
                    continue
                if not plats:
                    continue
                for p in plats:
                    pid = (
                        getattr(p, "id", None)
                        or getattr(p, "name", None)
                        or getattr(p, "platform_id", None)
                    )
                    ptype = (
                        getattr(p, "type", "")
                        or getattr(p, "platform", "")
                        or getattr(p, "adapter", "")
                    )
                    if pid:
                        candidates.append((str(pid), str(ptype)))
    except Exception:
        pass

    try:
        for attr in ("platforms", "platform_insts", "inst_map"):
            mp = getattr(context, attr, None)
            if isinstance(mp, dict):
                for k, v in mp.items():
                    ptype = str(getattr(v, "type", "") or getattr(v, "platform", ""))
                    candidates.append((str(k), ptype))
    except Exception:
        pass

    for pid, ptype in candidates:
        if "aiocqhttp" in ptype.lower():
            return pid
    if candidates:
        return candidates[0][0]
    return "default"


def is_umo_valid(context, umo: str) -> bool:
    """尝试判断 UMO 是否能被 AstrBot 识别到 platform；识别不到也默认放行"""
    if not umo:
        return False
    try:
        pm = None
        for attr in ("platform_manager", "platform", "platforms", "pm"):
            pm = getattr(context, attr, None)
            if pm is not None:
                break
        if pm is None:
            return True
        for m in ("get_platform_by_origin", "get_inst_by_origin", "get_by_origin"):
            fn = getattr(pm, m, None)
            if callable(fn):
                try:
                    r = fn(umo)
                    if r is not None:
                        return True
                except Exception:
                    pass
        return True
    except Exception:
        return True


def build_result(text: str, images=None):
    """
    构造带 .chain 属性的 result 对象。

    images: 可选的本地图片路径列表，会附在文字之后。
    """
    from astrbot.api.message_components import Plain as _Plain
    chain = []
    if text:
        chain.append(_Plain(text))
    for p in (images or []):
        try:
            from astrbot.api.message_components import Image as _Image
            chain.append(_Image.fromFileSystem(str(p)))
        except Exception:
            logger.warning(f"[push] 构造图片组件失败: {p}")
    if not chain:
        chain = [_Plain("")]
    try:
        from astrbot.api.event import MessageEventResult
        r = MessageEventResult()
        r.chain = chain
        return r
    except Exception:
        class _R:
            pass
        r = _R()
        r.chain = chain
        return r


async def push_message(context, group_id: str, text: str, umo: str = "",
                       hourly_chime_module=None, minecraft_module=None,
                       images=None) -> bool:
    """
    主动推送消息到指定群。
    优先使用原生 unified_msg_origin，失败时回退到拼接字符串。

    images: 可选，本地图片路径列表（图片模式下的渲染结果）。
    """
    try:
        umo_candidates = []
        if umo:
            umo_candidates.append(umo)
        if hourly_chime_module is not None:
            saved = hourly_chime_module.get_umo(group_id)
            if saved and saved not in umo_candidates:
                umo_candidates.append(saved)
        if minecraft_module is not None:
            saved2 = minecraft_module.get_umo(group_id)
            if saved2 and saved2 not in umo_candidates:
                umo_candidates.append(saved2)

        pid = get_platform_id(context)
        for cand in (
            f"{pid}:GroupMessage:{group_id}",
            f"default:GroupMessage:{group_id}",
            f"aiocqhttp:GroupMessage:{group_id}",
        ):
            if cand not in umo_candidates:
                umo_candidates.append(cand)

        logger.info(f"[push] 群 {group_id} 候选 UMO: {umo_candidates}")

        last_err = None
        for u in umo_candidates:
            try:
                result_obj = build_result(text, images)
                await context.send_message(u, result_obj)
                logger.info(f"[push] 已尝试推送群 {group_id}: {u}")
                if is_umo_valid(context, u):
                    return True
            except Exception as e:
                last_err = e
                logger.warning(f"[push] 推送失败 {u}: {e}")

        if last_err:
            logger.warning(f"[push] 主动推送群 {group_id} 全部失败: {last_err}")
        return False
    except Exception as e:
        logger.warning(f"[push] 主动推送异常: {e}")
        return False