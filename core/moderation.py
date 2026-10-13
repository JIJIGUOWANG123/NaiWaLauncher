"""
群员管理 / 黑名单模块。

功能：
  - 平台管理员、群主、群管、插件专属管理员可远程踢出 / 禁言 / 拉黑群员
  - 拉黑时可指定该成员后续发言的处理方式：kick（踢出）/ mute（禁言）/ ignore（无视）
  - 所有操作前都会校验「机器人自己在群里是否是管理员或群主」，没有权限直接拒绝

黑名单配置格式（后台一行一条）：
    123456:kick      该成员再发言就踢出
    123456:mute      该成员再发言就禁言
    123456:ignore    无视该成员的所有指令（不响应，但也不处罚）
仅写 QQ 号不写动作时，按默认动作处理。
"""

from astrbot.api import logger

# 支持的处置动作
ACTION_KICK = "kick"
ACTION_MUTE = "mute"
ACTION_IGNORE = "ignore"
VALID_ACTIONS = (ACTION_KICK, ACTION_MUTE, ACTION_IGNORE)

# 动作的中文名（用于提示）
ACTION_LABEL = {
    ACTION_KICK: "踢出",
    ACTION_MUTE: "禁言",
    ACTION_IGNORE: "无视",
}


def parse_blacklist(raw) -> dict:
    """
    解析黑名单配置，返回 {user_id: action}。
    支持一行一条 "QQ号:动作"，也兼容旧的纯 QQ 号（用 default_action）。
    """
    result = {}
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line or "：" in line:
            sep = ":" if ":" in line else "："
            uid, _, act = line.partition(sep)
            uid = uid.strip()
            act = act.strip().lower()
        else:
            uid, act = line, ""
        if not uid.isdigit():
            continue
        if act not in VALID_ACTIONS:
            act = ""
        result[uid] = act
    return result


def get_action(blacklist: dict, user_id: str, default_action: str = ACTION_IGNORE) -> str:
    """取某成员被拉黑后的处置动作；未拉黑返回空串。"""
    uid = str(user_id or "").strip()
    if not uid or uid not in blacklist:
        return ""
    act = blacklist.get(uid) or ""
    if act not in VALID_ACTIONS:
        act = default_action if default_action in VALID_ACTIONS else ACTION_IGNORE
    return act


def format_blacklist_line(user_id: str, action: str) -> str:
    """生成一行黑名单配置。"""
    act = action if action in VALID_ACTIONS else ACTION_IGNORE
    return f"{str(user_id).strip()}:{act}"


def upsert_blacklist(raw, user_id: str, action: str) -> str:
    """在配置文本里新增/更新一条黑名单，返回新的配置文本。"""
    uid = str(user_id or "").strip()
    if not uid.isdigit():
        return str(raw or "")
    act = action if action in VALID_ACTIONS else ACTION_IGNORE
    lines = []
    replaced = False
    for line in str(raw or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if ":" in s or "：" in s:
            sep = ":" if ":" in s else "："
            head = s.partition(sep)[0].strip()
        else:
            head = s
        if head == uid:
            if not replaced:
                lines.append(format_blacklist_line(uid, act))
                replaced = True
            continue
        lines.append(s)
    if not replaced:
        lines.append(format_blacklist_line(uid, act))
    return "\n".join(lines)


def remove_blacklist(raw, user_id: str) -> tuple:
    """从配置文本里移除一条黑名单，返回 (新文本, 是否移除成功)。"""
    uid = str(user_id or "").strip()
    if not uid:
        return str(raw or ""), False
    lines = []
    removed = False
    for line in str(raw or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if ":" in s or "：" in s:
            sep = ":" if ":" in s else "："
            head = s.partition(sep)[0].strip()
        else:
            head = s
        if head == uid:
            removed = True
            continue
        lines.append(s)
    return "\n".join(lines), removed


class ModerationModule:
    """
    群员管理模块。
    依赖 GroupAdminModule 完成权限校验与实际 API 调用。
    """

    def __init__(self, group_admin_module=None):
        self.group_admin = group_admin_module

    # ============================================================
    # 机器人权限
    # ============================================================
    async def bot_can_moderate(self, event):
        """
        机器人是否有管理权限。
        返回 (can: bool, role: str)
        """
        if self.group_admin is None:
            return False, ""
        try:
            info = await self.group_admin.get_bot_role(event)
            return bool(info.get("can")), str(info.get("role", "") or "")
        except Exception:
            logger.exception("[moderation] 查询机器人权限失败")
            return False, ""

    def no_permission_tip(self, role: str = "") -> str:
        role_desc = {
            "owner": "群主",
            "admin": "管理员",
            "member": "普通成员",
        }.get(role, "未知")
        return (
            "⚠️ 机器人当前不是本群管理员，无法执行踢人/禁言\n"
            f"· 机器人身份：{role_desc}\n"
            "💡 请先把机器人设为群管理员，或让群主操作"
        )

    # ============================================================
    # 实际动作
    # ============================================================
    async def do_kick(self, event, user_id: str) -> bool:
        if self.group_admin is None:
            return False
        return await self.group_admin.kick_member(event, user_id)

    async def do_mute(self, event, user_id: str, duration: int = 600) -> bool:
        if self.group_admin is None:
            return False
        return await self.group_admin.mute_member(event, user_id, duration)

    async def do_unmute(self, event, user_id: str) -> bool:
        if self.group_admin is None:
            return False
        return await self.group_admin.unmute_member(event, user_id)

    async def apply_action(self, event, user_id: str, action: str,
                           mute_duration: int = 600) -> bool:
        """按动作执行处置（ignore 不调用 API，视为成功）。"""
        if action == ACTION_KICK:
            return await self.do_kick(event, user_id)
        if action == ACTION_MUTE:
            return await self.do_mute(event, user_id, mute_duration)
        if action == ACTION_IGNORE:
            return True
        return False

    @staticmethod
    def action_label(action: str) -> str:
        return ACTION_LABEL.get(action, action or "未知")
