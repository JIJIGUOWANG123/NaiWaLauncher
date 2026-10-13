"""
数据备份模块。

把插件的全部数据文件导出到一个备份目录，便于用户自行存档。

设计说明：
  · 备份为「目录 + 原始 json 文件 + manifest.json」，不打包压缩，
    这样用户可以直接查看、对比、手动还原，也不需要额外依赖。
  · 默认备份根目录为 AstrBot 的 data/backups 下（随 data 一起被用户备份），
    也允许指定任意绝对路径。
  · 同名文件/目录一律不覆盖，自动追加时间戳后缀，避免误删既有备份。
"""

import os
import json
import time
import datetime

from astrbot.api import logger

from .path_utils import (
    config_path,
    fortune_data_path,
    husband_data_path,
    luck_data_path,
    greeting_data_path,
    minecraft_data_path,
    checkin_data_path,
    hourly_chime_data_path,
    status_push_data_path,
    daily_news_data_path,
    nickname_data_path,
    speak_stats_data_path,
    pet_data_path,
    data_store_path,
)

PLUGIN_ID = "astrbot_plugin_custom_entertainment"


def all_data_files() -> list:
    """返回 [(展示名, 绝对路径)] 的全部数据文件清单。"""
    return [
        ("插件配置", config_path()),
        ("每日运势", fortune_data_path()),
        ("今日老公", husband_data_path()),
        ("今日人品", luck_data_path()),
        ("打卡记录", greeting_data_path()),
        ("MC 版本检测", minecraft_data_path()),
        ("签到数据", checkin_data_path()),
        ("整点报时", hourly_chime_data_path()),
        ("状态推送", status_push_data_path()),
        ("每日读报", daily_news_data_path()),
        ("昵称缓存", nickname_data_path()),
        ("发言统计", speak_stats_data_path()),
        ("宠物数据", pet_data_path()),
        ("数据集合", data_store_path()),
    ]


def default_backup_dir() -> str:
    """
    默认备份根目录：本插件数据目录下的 backups/
    （即 data/plugin_data/<插件名>/backups/，符合数据落盘规范）
    """
    return os.path.join(os.path.dirname(os.path.abspath(config_path())), "backups")


def _unique_dir(base: str, name: str) -> str:
    """
    在 base 下取一个不冲突的目录名，冲突则追加时间戳/序号后缀。

    ★★ 1.1：**已经不再用「睡眠等待」来避开撞名** ——
      原来同名冲突时靠 sleeps 让时间戳变化，既慢又不可靠
      （同一秒内多次冲突仍会撞）。现在直接用递增序号，
      **零等待**且一定唯一。
    """
    target = os.path.join(base, name)
    if not os.path.exists(target):
        return target
    suffix = datetime.datetime.now().strftime("%H%M%S")
    for i in range(10):
        candidate = os.path.join(base, f"{name}_{suffix}")
        if not os.path.exists(candidate):
            return candidate
        candidate = os.path.join(base, f"{name}_{suffix}_{i + 1}")
        if not os.path.exists(candidate):
            return candidate
    return os.path.join(base, f"{name}_{int(time.time())}")


def create_backup(target_dir: str = "") -> dict:
    """
    创建一次备份。

    target_dir: 目标目录（绝对路径）。留空或指向目录时，会在其下自动创建
                以时间戳命名的子目录；填成不存在的路径则直接创建该目录。
    返回 {"ok": bool, "path": str, "files": [...], "manifest": {...}, "msg": str}
    """
    try:
        now = datetime.datetime.now()
        stamp = now.strftime("%Y%m%d_%H%M%S")

        user_dir = str(target_dir or "").strip().strip('"').strip("'")
        if user_dir:
            user_dir = os.path.abspath(os.path.expanduser(user_dir))
        else:
            user_dir = default_backup_dir()

        # 若指定路径本身已存在或是已存在的目录，则在其下建子目录；否则直接用它
        if os.path.exists(user_dir) and os.path.isdir(user_dir):
            backup_dir = _unique_dir(user_dir, f"{PLUGIN_ID}_{stamp}")
        else:
            backup_dir = user_dir
            if os.path.exists(backup_dir):
                backup_dir = _unique_dir(os.path.dirname(backup_dir),
                                         os.path.basename(backup_dir))

        os.makedirs(backup_dir, exist_ok=True)

        exported = []
        skipped = []
        total_bytes = 0
        for label, src in all_data_files():
            if not src or not os.path.isfile(src):
                skipped.append({"label": label, "path": src, "reason": "文件不存在"})
                continue
            try:
                with open(src, "rb") as f:
                    blob = f.read()
                dst = os.path.join(backup_dir, os.path.basename(src))
                with open(dst, "wb") as f:
                    f.write(blob)
                exported.append({
                    "label": label,
                    "file": os.path.basename(src),
                    "size": len(blob),
                })
                total_bytes += len(blob)
            except Exception as e:
                skipped.append({"label": label, "path": src, "reason": str(e)})

        manifest = {
            "plugin": PLUGIN_ID,
            "backup_time": now.strftime("%Y-%m-%d %H:%M:%S"),
            "source_dir": os.path.dirname(os.path.abspath(config_path())),
            "backup_dir": backup_dir,
            "file_count": len(exported),
            "total_bytes": total_bytes,
            "files": exported,
            "skipped": skipped,
        }
        try:
            with open(os.path.join(backup_dir, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
        except Exception:
            logger.exception("[backup] 写入 manifest.json 失败")

        logger.info(
            f"[backup] 已备份 {len(exported)} 个数据文件到 {backup_dir}"
            f"（{total_bytes} 字节）"
        )
        return {
            "ok": True,
            "path": backup_dir,
            "files": exported,
            "skipped": skipped,
            "manifest": manifest,
            "msg": f"已备份 {len(exported)} 个文件",
        }

    except PermissionError as e:
        logger.warning(f"[backup] 无写入权限: {e}")
        return {
            "ok": False, "path": "", "files": [], "skipped": [], "manifest": {},
            "msg": f"无写入权限：{target_dir or default_backup_dir()}。"
                   f"请换一个可写目录，或确认 AstrBot 进程有权限。",
        }
    except Exception as e:
        logger.exception("[backup] 备份失败")
        return {
            "ok": False, "path": "", "files": [], "skipped": [], "manifest": {},
            "msg": f"备份失败：{e}",
        }


def build_bundle() -> dict:
    """
    把全部数据文件读成一个大 JSON，供「下载到浏览器」使用。
    返回 {"ok": bool, "bundle": {...}, "msg": str}
    """
    try:
        files = {}
        for label, src in all_data_files():
            if not src or not os.path.isfile(src):
                continue
            try:
                with open(src, "r", encoding="utf-8-sig") as f:
                    files[os.path.basename(src)] = {
                        "label": label,
                        "content": json.load(f),
                    }
            except Exception:
                # 非 json 或损坏的文件跳过，不让整个导出失败
                logger.warning(f"[backup] 跳过无法解析的文件: {src}")

        bundle = {
            "plugin": PLUGIN_ID,
            "backup_time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source_dir": os.path.dirname(os.path.abspath(config_path())),
            "file_count": len(files),
            "files": files,
        }
        return {"ok": True, "bundle": bundle, "msg": f"共 {len(files)} 个文件"}
    except Exception as e:
        logger.exception("[backup] 生成下载包失败")
        return {"ok": False, "bundle": {}, "msg": f"生成失败：{e}"}


# ============================================================
# 导入 / 还原
# ============================================================
# 数据文件名 -> 展示名（导入时只认这些文件，其余一律忽略）
_DATA_NAME_TO_LABEL = {}


def _known_files() -> dict:
    """返回 {文件名: 展示名}"""
    if not _DATA_NAME_TO_LABEL:
        for label, path in all_data_files():
            _DATA_NAME_TO_LABEL[os.path.basename(path)] = label
    return _DATA_NAME_TO_LABEL


def _resolve_source(source: str) -> tuple:
    """
    解析导入来源，返回 (类型, 路径或数据)。
    类型为 "dir" / "file"。
    """
    src = str(source or "").strip().strip('"').strip("'")
    if not src:
        return "", None
    src = os.path.abspath(os.path.expanduser(src))
    if os.path.isdir(src):
        return "dir", src
    if os.path.isfile(src):
        return "file", src
    return "", None


def preview_import(source: str) -> dict:
    """
    预检导入来源，**不写入任何文件**。
    返回 {"ok", "source", "kind", "files":[{file,label,size,valid,reason}], "msg"}
    """
    try:
        kind, path = _resolve_source(source)
        if not kind:
            return {
                "ok": False, "source": source, "kind": "", "files": [], "total": 0,
                "msg": "路径不存在或无法访问，请检查后重试",
            }

        known = _known_files()
        found = []

        if kind == "file":
            # 单个文件：要么是导出包（含 files 字典），要么是某个数据文件本身
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    raw = json.load(f)
            except Exception as e:
                return {
                    "ok": False, "source": path, "kind": kind, "files": [], "total": 0,
                    "msg": f"文件不是合法 JSON：{e}",
                }
            base = os.path.basename(path)
            if isinstance(raw, dict) and isinstance(raw.get("files"), dict):
                # 导出包格式
                for name, item in raw["files"].items():
                    if name not in known:
                        continue
                    content = item.get("content") if isinstance(item, dict) else item
                    found.append({
                        "file": name,
                        "label": known.get(name, ""),
                        "size": len(json.dumps(content, ensure_ascii=False)),
                        "valid": isinstance(content, (dict, list)),
                        "reason": "" if isinstance(content, (dict, list)) else "内容格式异常",
                    })
            elif base in known:
                found.append({
                    "file": base, "label": known.get(base, ""),
                    "size": os.path.getsize(path),
                    "valid": isinstance(raw, (dict, list)),
                    "reason": "" if isinstance(raw, (dict, list)) else "内容格式异常",
                })
            else:
                return {
                    "ok": False, "source": path, "kind": kind, "files": [], "total": 0,
                    "msg": f"不认识这个文件：{base}。请选择导出的备份包，或备份目录。",
                }
        else:
            # 目录：逐个人名匹配的数据文件
            for name, label in known.items():
                p = os.path.join(path, name)
                if not os.path.isfile(p):
                    continue
                valid, reason = True, ""
                try:
                    with open(p, "r", encoding="utf-8-sig") as f:
                        json.load(f)
                except Exception as e:
                    valid, reason = False, f"JSON 解析失败：{e}"
                found.append({
                    "file": name, "label": label,
                    "size": os.path.getsize(p),
                    "valid": valid, "reason": reason,
                })

        if not found:
            return {
                "ok": False, "source": path, "kind": kind, "files": [], "total": 0,
                "msg": "该位置没有找到本插件的数据文件",
            }

        valid_n = len([x for x in found if x["valid"]])
        return {
            "ok": True,
            "source": path,
            "kind": kind,
            "files": found,
            "total": len(found),
            "valid_count": valid_n,
            "msg": f"找到 {len(found)} 个数据文件，其中 {valid_n} 个可用",
        }
    except Exception as e:
        logger.exception("[backup] 预检导入失败")
        return {"ok": False, "source": source, "kind": "", "files": [], "total": 0,
                "msg": f"预检失败：{e}"}


def import_data(source: str, mode: str = "replace") -> dict:
    """
    从备份目录或备份包还原数据。

    安全措施：
      1) 导入前自动把当前数据备份一份（到 restore 子目录），可随时回退
      2) 只写入本插件名下的数据文件，其余文件一律忽略
      3) 跳过解析失败的文件，不做部分破坏性写入
      4) 逐个文件「先写临时文件再 os.replace」，避免写一半损坏原文件

    mode: "replace" 覆盖导入（默认） / "merge_skip" 仅补充缺失的文件
    返回 {"ok","imported":[...],"skipped":[...],"backup_dir","msg"}
    """
    try:
        pre = preview_import(source)
        if not pre.get("ok"):
            return {"ok": False, "imported": [], "skipped": [], "backup_dir": "",
                    "msg": pre.get("msg", "预检失败")}

        kind = pre["kind"]
        src_path = pre["source"]
        usable = [x for x in pre["files"] if x["valid"]]
        if not usable:
            return {"ok": False, "imported": [], "skipped": pre["files"], "backup_dir": "",
                    "msg": "没有可导入的有效数据文件"}

        # ① 先备份当前数据
        safety = create_backup(os.path.join(default_backup_dir(), "before_restore"))
        backup_dir = safety.get("path", "") if safety.get("ok") else ""

        # ② 读取来源内容
        payload = {}
        if kind == "file":
            with open(src_path, "r", encoding="utf-8-sig") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and isinstance(raw.get("files"), dict):
                for name, item in raw["files"].items():
                    content = item.get("content") if isinstance(item, dict) else item
                    payload[name] = content
            else:
                payload[os.path.basename(src_path)] = raw
        else:
            for x in usable:
                p = os.path.join(src_path, x["file"])
                try:
                    with open(p, "r", encoding="utf-8-sig") as f:
                        payload[x["file"]] = json.load(f)
                except Exception:
                    continue

        known = _known_files()
        target_dir = os.path.dirname(os.path.abspath(config_path()))
        os.makedirs(target_dir, exist_ok=True)

        imported, skipped = [], []
        # 预检阶段就判定不可用的文件，一并计入跳过报告，便于用户定位
        for x in pre["files"]:
            if not x.get("valid"):
                skipped.append({
                    "file": x.get("file", ""),
                    "label": x.get("label", ""),
                    "reason": x.get("reason") or "预检未通过",
                })

        for name, content in payload.items():
            if name not in known:
                continue
            dst = os.path.join(target_dir, name)

            if mode == "merge_skip" and os.path.isfile(dst):
                skipped.append({"file": name, "label": known.get(name, ""),
                                "reason": "已存在（仅补充模式）"})
                continue
            if not isinstance(content, (dict, list)):
                skipped.append({"file": name, "label": known.get(name, ""),
                                "reason": "内容格式异常"})
                continue

            try:
                tmp = dst + ".import.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(content, f, ensure_ascii=False, indent=2)
                os.replace(tmp, dst)
                imported.append({"file": name, "label": known.get(name, "")})
            except Exception as e:
                skipped.append({"file": name, "label": known.get(name, ""),
                                "reason": str(e)})
                try:
                    if os.path.isfile(dst + ".import.tmp"):
                        os.remove(dst + ".import.tmp")
                except Exception:
                    pass

        if not imported:
            return {"ok": False, "imported": [], "skipped": skipped, "backup_dir": backup_dir,
                    "msg": "没有文件被导入"}

        logger.info(
            f"[backup] 已从 {src_path} 导入 {len(imported)} 个数据文件"
            f"（导入前备份：{backup_dir or '无'}）"
        )
        msg = f"已导入 {len(imported)} 个文件"
        if skipped:
            msg += f"，跳过 {len(skipped)} 个"
        if backup_dir:
            msg += "。导入前的数据已自动备份，可随时回退"
        return {
            "ok": True, "imported": imported, "skipped": skipped,
            "backup_dir": backup_dir, "msg": msg,
        }
    except Exception as e:
        logger.exception("[backup] 导入失败")
        return {"ok": False, "imported": [], "skipped": [], "backup_dir": "",
                "msg": f"导入失败：{e}"}

