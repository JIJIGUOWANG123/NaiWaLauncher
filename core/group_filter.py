def parse_line_list(raw) -> list:
    result = []
    if not raw:
        return result
    if isinstance(raw, list):
        lines = []
        for item in raw:
            if isinstance(item, str):
                lines.extend(item.splitlines())
    else:
        lines = str(raw).splitlines()
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line not in result:
            result.append(line)
    return result


def parse_group_block_keywords(raw) -> dict:
    result = {}
    if not raw:
        return result
    if isinstance(raw, list):
        lines = []
        for item in raw:
            if isinstance(item, str):
                lines.extend(item.splitlines())
    else:
        lines = str(raw).splitlines()

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line and "：" not in line:
            continue
        parts = line.replace("：", ":").split(":", 1)
        group_id = parts[0].strip()
        kw_str = parts[1].strip()
        if not group_id:
            continue
        kws = [k.strip() for k in kw_str.split(",") if k.strip()]
        result.setdefault(group_id, [])
        for k in kws:
            if k not in result[group_id]:
                result[group_id].append(k)
    return result


def parse_gid_whitelist(raw) -> list:
    """
    解析「允许使用的群号」配置，返回去重后的字符串列表。
    统一支持换行 / 英文逗号 / 中文逗号 / 顿号 / 分号 / 空格分隔
    （规范：每个群用英文逗号隔开，这里同时兼容其他写法）。
    忽略空内容、非数字内容与 # 注释。
    """
    import re as _re
    if raw is None:
        return []
    if isinstance(raw, list):
        chunks = [str(x) for x in raw if isinstance(x, str)]
    else:
        chunks = [str(raw)]
    out, seen = [], set()
    for chunk in chunks:
        for line in chunk.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            for piece in _re.split(r"[,，、;；\s]+", line):
                gid = piece.strip()
                if not gid or not gid.isdigit():
                    continue
                if gid in seen:
                    continue
                seen.add(gid)
                out.append(gid)
    return out


def group_allowed(group_id: str, blocked: list) -> bool:
    """
    统一的群号过滤（**黑名单语义**）：
      · 留空        -> 不限制群聊，所有群都生效
      · 填了群号    -> 这些群**被排除**，不生效
    所有功能（运势/老公/人品/词库/打卡/签到/接口系统/电脑状态等）都走这一条规则。
    """
    if not group_id:
        return True
    if not blocked:
        return True
    return str(group_id) not in [str(x) for x in blocked]


def is_group_allowed(group_id: str, mode: str, whitelist: list, blacklist: list) -> bool:
    """旧接口，保留兼容（mode/whitelist/blacklist 形式）"""
    if not group_id:
        return True
    mode = (mode or "off").strip().lower()
    if mode == "whitelist":
        return group_id in whitelist
    if mode == "blacklist":
        return group_id not in blacklist
    return True


def is_keyword_blocked(group_id: str, keyword: str, group_block_map: dict) -> bool:
    if not group_id or not group_block_map:
        return False
    blocked = group_block_map.get(group_id, [])
    if not blocked:
        return False
    for b in blocked:
        if b and b in keyword:
            return True
    return False