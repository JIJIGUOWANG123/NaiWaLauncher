from astrbot.api.message_components import At


def to_str(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="ignore")
        except Exception:
            return value.decode("latin-1", errors="ignore")
    return str(value)


def get_group_id_from_event(event) -> str:
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


def get_ats_from_msg(event) -> list:
    """从消息链里提取所有 @ 的 QQ 号"""
    at_list = []
    try:
        for comp in event.message_obj.message:
            if not isinstance(comp, At):
                continue
            qq = (
                getattr(comp, "qq", None)
                or getattr(comp, "user_id", None)
                or getattr(comp, "target", None)
            )
            if qq is not None:
                at_list.append(to_str(qq))
    except Exception:
        pass
    return at_list


def split_text_and_ats(event):
    """
    把消息链拆成 (纯文本, at占位符映射)。
    at 会被替换成 \x00AT0\x00 之类的占位符，方便关键词匹配。
    """
    parts = []
    at_map = {}
    idx = 0
    try:
        for comp in event.message_obj.message:
            if isinstance(comp, At):
                qq = (
                    getattr(comp, "qq", None)
                    or getattr(comp, "user_id", None)
                    or getattr(comp, "target", None)
                )
                ph = f"\x00AT{idx}\x00"
                at_map[ph] = to_str(qq) if qq is not None else ""
                parts.append(f" {ph} ")
                idx += 1
            else:
                text = getattr(comp, "text", None)
                if text:
                    parts.append(str(text))
                else:
                    t2 = getattr(comp, "content", None)
                    if t2:
                        parts.append(str(t2))
    except Exception:
        pass
    return "".join(parts), at_map


def restore_ats(text: str, at_map: dict) -> str:
    """把占位符还原回真实 QQ 号"""
    if not text:
        return ""
    out = text
    for ph, qq in at_map.items():
        out = out.replace(ph, qq)
    return out


def has_at_bot(event, bot_id: str) -> bool:
    """判断消息里有没有 @ 到指定 bot"""
    if not bot_id:
        return False
    try:
        return bot_id in get_ats_from_msg(event)
    except Exception:
        return False


def _get_sender_name_raw(event) -> str:
    """尽最大努力获取发送者的**显示名**。

    ★ 1.7.6 修正：**群名片优先于个人昵称**。

    为什么：群里显示的是群名片（群昵称），个人昵称只是兜底。
    AstrBot 的 aiocqhttp 适配器把两者分别放在
      · `sender.card`      —— 群名片（本群昵称）
      · `sender.nickname`  —— 个人昵称（跨群一致）
    以前的顺序是「昵称 -> 群名片」，结果抽奖/签到里显示个人昵称，
    和群里看到的群昵称不一致。

    现在的顺序：
      ① event.sender.card / nickname（适配器把对象挂 event 上时）
      ② event 上的 sender_name / sender_nickname / card
      ③ message_obj.sender.card（群名片）
      ④ message_obj.sender.nickname
         （aiocqhttp 的 MessageMember.nickname 就是 `card or nickname`）
      ⑤ message_obj / event 上的 nickname 兜底
    """
    # ① 事件上直接挂的 sender 对象 -> 先看群名片
    try:
        _s = getattr(event, "sender", None)
        if _s is not None:
            for attr in ("card", "nickname"):
                v = getattr(_s, attr, None)
                if v:
                    return to_str(v)
    except Exception:
        pass
    # ② 事件上的字符串字段（card 放在 nickname 前面）
    for attr in ("sender_name", "sender_nickname", "card", "nickname",
                 "nick"):
        try:
            v = getattr(event, attr, None)
            if v:
                return to_str(v)
        except Exception:
            pass
    # ③ message_obj 里的 sender
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            sender = getattr(mo, "sender", None)
            if sender is not None:
                for attr in ("card", "nickname", "name"):
                    v = getattr(sender, attr, None)
                    if v:
                        return to_str(v)
            for attr in ("sender_name", "sender_nickname", "nickname"):
                v = getattr(mo, attr, None)
                if v:
                    return to_str(v)
    except Exception:
        pass
    return ""


def get_sender_name(event) -> str:
    """
    ★★ 1.7.7：**对外统一出口** —— 清洗 + 超长截断。

    为什么要有这一层：`_get_sender_name_raw` 有多个 return 分支，
    每个都直接返回原始昵称。很多地方（签到统计 / 榜单 / 抽奖 /
    猜数发起人）把它直接拼进一行，**长昵称会把卡片撑到换行**
    （用户反馈「名字太长会换行」）。在这里收口一次，所有调用点
    自动都拿到截断后的名字。
    """
    try:
        from .path_utils import nick_display as _nd
        return _nd(_get_sender_name_raw(event))
    except Exception:
        try:
            return str(_get_sender_name_raw(event) or "")
        except Exception:
            return ""
