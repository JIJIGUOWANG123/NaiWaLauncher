import os
import json
from astrbot.api import logger


try:
    from .path_utils import title_bar as _title_bar
except Exception:  # pragma: no cover
    def _title_bar(t):
        return str(t)

FEATURE_ALIAS = {
    "运势": "fortune",
    "今日运势": "fortune",
    "fortune": "fortune",
    "老公": "husband",
    "今日老公": "husband",
    "husband": "husband",
    "人品": "luck",
    "今日人品": "luck",
    "luck": "luck",
    "词库": "word_reply",
    "word_reply": "word_reply",
    "表情": "meme",
    "表情包": "meme",
    "meme": "meme",
    "电脑状态": "status",
    "状态": "status",
    "status": "status",
    "早安": "greeting",
    "晚安": "greeting",
    "早安晚安": "greeting",
    "greeting": "greeting",
    "mc": "minecraft",
    "MC": "minecraft",
    "minecraft": "minecraft",
    "MC版本": "minecraft",
    "mc版本": "minecraft",
    "签到": "checkin",
    "checkin": "checkin",
    "神偷": "steal",
    "偷积分": "steal",
    "steal": "steal",
    "银行": "bank",
    "bank": "bank",
    "坐骑": "mount",
    "mount": "mount",
    "打工": "job",
    "job": "job",
    # 手动 / 自动 分开的功能
    "整点报时": "chime",
    "报时": "chime",
    "chime": "chime",
    "读报功能": "news",
    "手动读报": "news",
    "news": "news",
    "状态推送": "push",
    "定时状态推送": "push",
    "push": "push",
    "每日读报": "news_auto",
    "读报": "news_auto",
    "news_auto": "news_auto",
    # 1.7.2 新增
    "发言功能": "speak_rank",
    "发言排行": "speak_rank",
    "发言统计": "speak_rank",
    "活跃排行": "speak_rank",
    "上周排行": "speak_rank",
    "上月排行": "speak_rank",
    "speak_rank": "speak_rank",
    "宠物功能": "pet",
    "宠物": "pet",
    "pet": "pet",
    "积分调整": "score_admin",
    "加积分": "score_admin",
    "减积分": "score_admin",
    "作弊": "score_admin",
    "score_admin": "score_admin",
    "音乐功能": "music",
    "音乐": "music",
    # ★ 1.7.7：「点歌功能」不再是音乐菜单入口（让位给下级菜单「单曲点歌」），
    #   这里也去掉，免得「开启功能 点歌功能」还能改到音乐模块。
    "点歌": "music",
    "music": "music",
    # 1.7.4 新增（全群共享，用总开关控制，不参与群黑名单）
    "小鸟图鉴": "bird",
    "小鸟": "bird",
    "图鉴": "bird",
    "bird": "bird",
    # 1.7.5 新增
    "猜拳功能": "rps",
    "猜拳": "rps",
    "rps": "rps",
    # ★★ 1.7.7 新增：猜数游戏（娱乐功能）
    "猜数功能": "guess",
    "猜数游戏": "guess",
    "猜数": "guess",
    "猜数字": "guess",
    "guess": "guess",
    "名片功能": "card",
    "名片": "card",
    "card": "card",
    # 1.7.5 新增：查询功能
    "查询功能": "qqinfo",
    "查询": "qqinfo",
    "查QQ": "qqinfo",
    "qqinfo": "qqinfo",
    # 1.7.6 新增：抽奖功能（签到子功能，黑名单：填了群号 = 该群不触发）
    "抽奖功能": "lottery",
    "抽奖": "lottery",
    "lottery": "lottery",
    # 1.7.6 新增：抢银行（银行子功能，黑名单）
    "抢银行": "rob",
    "抢劫银行": "rob",
    "打劫银行": "rob",
    "rob": "rob",
    # 1.7.6 新增：奖池（抽奖子功能，黑名单）
    "奖池": "lottery_pool",
    "参与抽奖": "lottery_pool",
    "lottery_pool": "lottery_pool",
}

FEATURE_LABEL = {
    "bird": "小鸟图鉴",
    "fortune": "今日运势",
    "husband": "今日老公",
    "luck": "今日人品",
    "word_reply": "词库系统",
    "meme": "接口系统",
    "status": "电脑状态",
    "greeting": "打卡系统",
    "minecraft": "MC系统",
    "checkin": "签到系统",
    "steal": "神偷功能",
    "bank": "银行功能",
    "mount": "坐骑功能",
    "job": "打工功能",
    # 手动 / 自动 分开的功能
    "chime": "整点报时",
    "news": "读报功能",
    "push": "状态推送",
    "news_auto": "每日读报",
    # 1.7.2 新增
    "speak_rank": "发言功能",
    "pet": "宠物功能",
    "score_admin": "积分调整",
    "music": "音乐功能",
    # 1.7.5 新增
    "rps": "猜拳功能",
    # ★★ 1.7.7：猜数游戏
    "guess": "猜数功能",
    "card": "名片功能",
    "qqinfo": "查询功能",
    # 1.7.6 新增
    "lottery": "抽奖功能",
    "rob": "抢银行",
    "lottery_pool": "奖池",
}

# 这些是「每日签到」下的子功能：主签到开关关掉后，它们也会一并失效
CHECKIN_SUB_FEATURES = ("steal", "bank", "mount", "job", "lottery", "rob",
                        "lottery_pool")


class AdminCommands:
    def __init__(self, plugin):
        self.plugin = plugin

    @staticmethod
    def _sender_id(event) -> str:
        try:
            return str(event.get_sender_id() or "")
        except Exception:
            return ""

    async def check_admin(self, event) -> bool:
        p = self.plugin
        user_id = self._sender_id(event)
        if not user_id:
            return False
        try:
            if event.is_admin():
                return True
        except Exception:
            pass
        if user_id in p.plugin_admins:
            return True
        if p.group_admin_module is not None:
            try:
                return await p.group_admin_module.is_group_admin(event, user_id)
            except Exception:
                logger.exception("[apix-meme] 群管判定失败")
                return False
        return False

    def add_plugin_admin(self, qq: str) -> bool:
        p = self.plugin
        qq = str(qq).strip()
        if not qq:
            return False
        if qq not in p.plugin_admins:
            p.plugin_admins.append(qq)
            p.save_rules_to_config()
        return True

    def del_plugin_admin(self, qq: str) -> bool:
        p = self.plugin
        qq = str(qq).strip()
        if qq in p.plugin_admins:
            p.plugin_admins.remove(qq)
            p.save_rules_to_config()
            return True
        return False

    def list_plugin_admins(self) -> list:
        return list(self.plugin.plugin_admins)

    def is_feature_on(self, key: str) -> bool:
        return True

    # 功能 -> 后台「生效的群号」配置键（**白名单**：填了才生效）
    #   关闭功能 X  = 把本群号从该名单移除（不再生效）
    #   开启功能 X  = 把本群号加入该名单（恢复生效）
    #
    #   手动 / 自动 是两份独立名单：
    #     电脑状态    -> 手动查询用 status_groups
    #     状态推送    -> 自动推送用 daily_status_push_groups
    #     读报功能    -> 手动发读报用 daily_news_groups
    #     每日读报    -> 自动推送用 daily_news_auto_groups
    FEATURE_GROUP_KEY = {
        "fortune":    "fortune_groups",
        "husband":    "husband_groups",
        "luck":       "luck_groups",
        "word_reply": "word_reply_groups",
        "greeting":   "greeting_groups",
        "checkin":    "checkin_groups",
        "steal":      "steal_groups",
        "bank":       "bank_groups",
        "mount":      "mount_groups",
        "job":        "job_groups",
        "meme":       "meme_groups",
        "status":     "status_groups",
        "chime":      "hourly_chime_groups",
        "news":       "daily_news_groups",
        "push":       "daily_status_push_groups",
        "news_auto":  "daily_news_auto_groups",
        # 1.7.4：小鸟图鉴（黑名单：填了群号 = 该群不触发）
        "bird":       "bird_groups",
        # 1.7.2 新增（都是黑名单：留空 = 所有群都生效）
        "speak_rank": "speak_stats_groups",
        "pet":        "pet_groups",
        "score_admin": "score_admin_groups",
        "music":      "music_groups",
        # 1.7.5：猜拳功能（黑名单：填了群号 = 该群不触发）
        "rps":        "rps_groups",
        # ★★ 1.7.7：猜数游戏（黑名单：填了群号 = 该群不触发）
        "guess":      "guess_groups",
        # MC 系统也是黑名单（与 minecraft_auto_groups 自动检测白名单区分）
        "minecraft":  "minecraft_groups",
        # 名片功能（黑名单：填了群号 = 该群不生成名片）
        "card":       "card_groups",
        # 1.7.5：查询功能（黑名单：填了群号 = 该群不触发）
        "qqinfo":     "qqinfo_groups",
        # 1.7.6：抽奖功能（黑名单：填了群号 = 该群不触发）
        "lottery":    "lottery_groups",
        # 1.7.6：抢银行（黑名单：填了群号 = 该群不触发）
        "rob":        "rob_groups",
        # 1.7.6：奖池（黑名单：填了群号 = 该群不触发）
        "lottery_pool": "lottery_pool_groups",
    }

    # 这些功能的「名单」用的是白名单语义（填了才生效）；
    # 其余（运势/老公/人品/词库/打卡/签到/子功能/接口/电脑状态/读报功能）仍是黑名单。
    #   白名单：整点报时、每日读报（自动）、状态推送（自动）
    #   黑名单：电脑状态（手动查询）、读报功能（手动读报）—— 留空 = 所有群都能用
    WHITELIST_FEATURES = {"chime", "push", "news_auto"}

    @staticmethod
    def _parse_gids(raw) -> list:
        """把配置里的群号串解析成列表（支持逗号/换行/中文逗号等）"""
        import re as _re
        if not raw:
            return []
        out, seen = [], set()
        for piece in _re.split(r"[,，、;；\s]+", str(raw)):
            gid = piece.strip()
            if gid and gid.isdigit() and gid not in seen:
                seen.add(gid)
                out.append(gid)
        return out

    def _set_feature_group_block(self, feat: str, gid: str, enabled: bool) -> bool:
        """
        把某群加入/移出「该功能的群号名单」，并立即重载使配置生效。

        名单语义分两种（见 WHITELIST_FEATURES）：
          · 白名单（报时/读报/推送/电脑状态）：enabled=True 加入名单，False 移除
          · 黑名单（其余功能）              ：enabled=True 移除，False 加入
        返回是否真的改动了。
        """
        import os
        import json as _json
        p = self.plugin
        cfg_key = self.FEATURE_GROUP_KEY.get(feat)
        if not cfg_key:
            return False
        # 兼容两种加载方式：作为包内模块（.path_utils）或独立加载
        try:
            from .path_utils import config_path as _cp
        except Exception:
            try:
                from path_utils import config_path as _cp
            except Exception:
                logger.exception("[apix-meme] 定位配置文件失败")
                return False
        try:
            path = _cp()
        except Exception:
            logger.exception("[apix-meme] 获取配置路径失败")
            return False

        cfg = {}
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8-sig") as f:
                    cfg = _json.load(f) or {}
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}

        gids = self._parse_gids(cfg.get(cfg_key, ""))
        # 白名单：enabled=True 表示要出现在名单里；黑名单：enabled=True 表示从名单里移除
        want_in = bool(enabled) if feat in self.WHITELIST_FEATURES else (not enabled)
        changed = False
        if want_in:
            if gid not in gids:
                gids.append(gid)
                changed = True
        else:
            if gid in gids:
                gids.remove(gid)
                changed = True

        # 无论是否变了，都把最新值写回（首次写入时文件可能还不存在）
        new_text = ",".join(gids)
        if str(cfg.get(cfg_key, "") or "") != new_text:
            changed = True
        cfg[cfg_key] = new_text
        try:
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                _json.dump(cfg, f, ensure_ascii=False, indent=2)
            os.replace(path + ".tmp", path)
        except Exception:
            logger.exception("[apix-meme] 写入功能群号失败")
            return False

        # 立即重载，让新配置生效（同时同步各模块内存里的名单）
        try:
            p.reload_cfg()
        except Exception:
            logger.exception("[apix-meme] 关闭功能后重载配置失败")
        return changed

    def disable_feature(self, name: str, group_id: str = None, target_group: str = None) -> str:
        key = self._resolve_feature(name)
        if not key:
            return (f"⚠️未知功能：{name}\n"
                    f"可用：{' / '.join(FEATURE_LABEL.values())}\n"
                    f"💡 各功能自己配置的触发词也能用")
        p = self.plugin

        gid = None
        if target_group:
            gid = str(target_group).strip()
        elif group_id:
            gid = str(group_id).strip()

        if not gid:
            return "⚠️ 请在群聊中使用该指令，或指定群号：关闭功能 运势 群号"

        label = FEATURE_LABEL.get(key, key)
        if key not in self.FEATURE_GROUP_KEY:
            return (f"⚠️「{label}」暂不支持按群开关\n"
                    f"💡 请在后台直接配置该功能的群号")

        # ① 写入后台该功能的群号名单（并立即生效）
        self._set_feature_group_block(key, gid, False)
        # ② 旧机制（群功能开关）同步置为关闭，两层都拦住
        if gid not in p.group_feature_switches:
            p.group_feature_switches[gid] = {}
        p.group_feature_switches[gid][key] = False
        p.save_rules_to_config()

        scope = f"群【{gid}】" if target_group else "本群"
        note = ("已把本群号从后台生效名单移除，该功能所有指令都不再响应"
                if key in self.WHITELIST_FEATURES
                else "已把群号写入后台群号黑名单，该功能所有指令都不再响应")
        return (f"✅已关闭{scope}：{label}\n"
                f"💡 {note}")

    @staticmethod
    def _group_in_list(gids, target) -> bool:
        """群号黑名单是否命中 target（留空视为不排除任何群）。"""
        try:
            items = [str(x) for x in (gids or [])]
        except Exception:
            return False
        if not items:
            return False
        return str(target) in items

    def primary_labels(self) -> dict:
        """
        返回 {feature_key: 展示名}，展示名取「后台配置的第一个指令关键词」。
        没配到就回退到内置的 FEATURE_LABEL，保证任何情况下都有名字可显示。
        每次调用都重新读取，改了配置立刻生效。
        """
        p = self.plugin

        def first(*candidates):
            for words in candidates:
                for w in (words or []):
                    w = str(w).strip()
                    if w:
                        return w
            return ""

        def names(attr, mod_attr):
            mod = getattr(p, mod_attr, None)
            if mod is None:
                return []
            val = getattr(mod, attr, None)
            return [str(x) for x in val] if isinstance(val, (list, tuple)) else []

        def cmd_names(attr):
            raw = getattr(p, attr, "") or ""
            if isinstance(raw, (list, tuple)):
                return [str(x) for x in raw if str(x).strip()]
            return [x for x in str(raw).split(",") if x.strip()]

        got = {
            "fortune":    first(names("trigger_names", "fortune_module")),
            "husband":    first(names("trigger_names", "husband_module")),
            "luck":       first(names("trigger_names", "luck_module")),
            "word_reply": first(cmd_names("cmd_word_add_name"),
                                cmd_names("cmd_word_list_name")),
            # 打卡：早晚各取一个，合成「早安/晚安」更直观
            "greeting":   first(names("morning_names", "greeting_module")),
            "checkin":    first(names("trigger_names", "checkin_module")),
            "steal":      first(names("steal_trigger_names", "checkin_module")),
            "bank":       first(names("bank_trigger_names", "checkin_module")),
            "mount":      first(names("mount_trigger_names", "checkin_module")),
            "job":        first(names("job_trigger_names", "checkin_module")),
            "minecraft":  first(cmd_names("cmd_mc_menu_name")),
            "meme":       first(cmd_names("cmd_meme_image_name"),
                                cmd_names("cmd_meme_menu_name")),
            "status":     first(cmd_names("cmd_status_names")),
        }
        # 打卡把晚安的第一个词也带上
        night_first = first(names("night_names", "greeting_module"))
        if got.get("greeting") and night_first:
            got["greeting"] = f"{got['greeting']}/{night_first}"

        out = {}
        for key, label in FEATURE_LABEL.items():
            out[key] = got.get(key) or label
        return out

    def _runtime_alias(self) -> dict:
        """
        从各功能模块读取「实际配置的触发词」，动态并入别名表。
        这样把运势触发词配成「抽签」后，就能直接用「关闭功能 抽签」。
        每次调用都重新读取，改了配置立刻生效，不需要重载插件。
        """
        p = self.plugin
        alias = {}

        def add(key, words):
            for w in (words or []):
                w = str(w).strip()
                if w:
                    alias[w] = key

        def names(attr, mod_attr):
            """取模块的 trigger_names / *__trigger_names__"""
            mod = getattr(p, mod_attr, None)
            if mod is None:
                return []
            val = getattr(mod, attr, None)
            return list(val) if isinstance(val, (list, tuple)) else []

        # 命令名来自主程序属性（可能是逗号分隔字符串，也可能已经是 list）
        def cmd_names(attr):
            raw = getattr(p, attr, "") or ""
            if isinstance(raw, (list, tuple)):
                return [str(x).strip() for x in raw if str(x).strip()]
            return [x.strip() for x in str(raw).split(",") if x.strip()]

        add("fortune",    names("trigger_names", "fortune_module"))
        add("husband",    names("trigger_names", "husband_module"))
        add("luck",       names("trigger_names", "luck_module"))
        # 词库是按规则关键词匹配的，没有触发词列表，用它的管理指令名
        add("word_reply", cmd_names("cmd_word_add_name"))
        add("word_reply", cmd_names("cmd_word_del_name"))
        add("word_reply", cmd_names("cmd_word_list_name"))

        add("greeting",   names("morning_names", "greeting_module"))
        add("greeting",   names("night_names", "greeting_module"))
        add("greeting",   cmd_names("cmd_greeting_stats_name"))
        add("greeting",   cmd_names("cmd_greeting_rank_name"))

        add("checkin",    names("trigger_names", "checkin_module"))
        # ★ 1.7.6：旧「签到排行」指令已删除，不再登记其触发词
        add("checkin",    names("info_trigger_names", "checkin_module"))
        add("steal",      names("steal_trigger_names", "checkin_module"))
        add("bank",       names("bank_trigger_names", "checkin_module"))
        add("bank",       names("bank_deposit_names", "checkin_module"))
        add("bank",       names("bank_withdraw_names", "checkin_module"))
        add("mount",      names("mount_trigger_names", "checkin_module"))
        add("mount",      names("mount_list_trigger_names", "checkin_module"))
        add("mount",      names("mount_buy_trigger_names", "checkin_module"))
        # ★ 1.7.6：装备坐骑 / 坐骑查看（带坐骑名参数）
        add("mount",      names("mount_equip_names", "checkin_module"))
        add("mount",      names("mount_view_names", "checkin_module"))
        add("job",        names("job_trigger_names", "checkin_module"))
        add("job",        names("job_info_trigger_names", "checkin_module"))

        add("minecraft",  cmd_names("cmd_mc_menu_name"))
        add("meme",       cmd_names("cmd_meme_menu_name"))
        add("meme",       cmd_names("cmd_meme_image_name"))
        add("meme",       cmd_names("cmd_meme_video_name"))
        add("status",     cmd_names("cmd_status_names"))
        # ★ 小鸟图鉴：菜单入口 / 抽鸟 / 图鉴指令都能用来开关
        add("bird",       cmd_names("cmd_bird_menu"))
        add("bird",       cmd_names("cmd_bird"))
        add("bird",       cmd_names("cmd_gallery"))
        add("bird",       cmd_names("cmd_bird_list"))
        add("bird",       cmd_names("cmd_bird_view"))
        # ★ 功能状态里显示的名称也必须能解析（例如「词库系统」「打卡系统」「银行功能」）
        for _k, _label in FEATURE_LABEL.items():
            add(_k, [_label])
        return alias

    def _resolve_feature(self, name: str):
        """把用户输入的功能名解析成 feature key。"""
        text = str(name or "").strip()
        if not text:
            return None
        # ① 功能状态里显示的标准名称优先（避免歧义）
        for _k, _label in FEATURE_LABEL.items():
            if text == _label:
                return _k
        # ② 内置别名
        key = FEATURE_ALIAS.get(text)
        if key:
            return key
        # ② 再查各功能实际配置的触发词
        return self._runtime_alias().get(text)

    def enable_feature(self, name: str, group_id: str = None, target_group: str = None) -> str:
        key = self._resolve_feature(name)
        if not key:
            return (f"⚠️未知功能：{name}\n"
                    f"可用：{' / '.join(FEATURE_LABEL.values())}\n"
                    f"💡 各功能自己配置的触发词也能用")
        p = self.plugin

        gid = None
        if target_group:
            gid = str(target_group).strip()
        elif group_id:
            gid = str(group_id).strip()

        if not gid:
            return "⚠️ 请在群聊中使用该指令，或指定群号：开启功能 运势 群号"

        label = FEATURE_LABEL.get(key, key)
        if key not in self.FEATURE_GROUP_KEY:
            return (f"⚠️「{label}」暂不支持按群开关\n"
                    f"💡 请在后台直接配置该功能的群号")

        # ① 更新后台该功能的群号名单（并立即生效）
        self._set_feature_group_block(key, gid, True)
        # ② 旧机制（群功能开关）同步置为开启，两层都放行
        if gid not in p.group_feature_switches:
            p.group_feature_switches[gid] = {}
        p.group_feature_switches[gid][key] = True
        p.save_rules_to_config()

        scope = f"群【{gid}】" if target_group else "本群"
        note = ("已把本群号加入后台生效名单，该功能指令恢复响应"
                if key in self.WHITELIST_FEATURES
                else "已从后台群号黑名单中移除，该功能指令恢复响应")
        return (f"✅已开启{scope}：{label}\n"
                f"💡 {note}")

    def feature_status_text(self, group_id: str = None, target_group: str = None) -> str:
        """
        显示本群的功能状态。
        与后台配置保持一致：既显示「全局总开关 / 允许群号」，
        也显示「本群功能开关」，这样一眼能看出功能到底为什么开/关。
        """
        p = self.plugin

        show_gid = None
        if target_group:
            show_gid = str(target_group).strip()
        elif group_id:
            show_gid = str(group_id).strip()

        if not show_gid:
            return "⚠️ 请在群聊中使用该指令，或指定群号：功能状态 群号"

        gid = show_gid
        lines = [_title_bar(f"群 {gid} 功能开关状态")]

        # ---------- ① 全局群白名单 ----------
        def _glist(name):
            return [str(x) for x in (getattr(p, name, None) or [])]

        def _wl_state(name):
            """黑名单语义：留空 = 所有群都生效；命中 = 本群被排除"""
            gids = _glist(name)
            if not gids:
                return "未排除任何群", False
            return (f"已排除 {len(gids)} 个群", gid in gids)

        # 白名单语义（填了才生效）的功能，单独标注
        def _wl_state_white(name):
            gids = _glist(name)
            if not gids:
                return "未填写（不生效）", False
            return (f"已填 {len(gids)} 个群", gid in gids)

        wl_rows = []
        for label, name in (("全局", "allowed_groups"),
                            ("电脑状态·手动查询", "status_groups"),
                            ("读报功能·手动读报", "daily_news_groups"),
                            ("接口系统", "meme_groups")):
            desc, hit = _wl_state(name)
            # 读报手动名单存在模块里，从模块读更准确
            if name == "daily_news_groups":
                mod = getattr(p, "daily_news_module", None)
                gids = [str(x) for x in (getattr(mod, "manual_groups", None) or [])] if mod else []
                desc = "未排除任何群" if not gids else f"已排除 {len(gids)} 个群"
                hit = gid in gids
            wl_rows.append((label, desc, hit))
        if any(desc != "未排除任何群" for _l, desc, _o in wl_rows):
            lines.append("")
            lines.append("【群号黑名单】（填了的群不生效）")
            for label, desc, hit in wl_rows:
                if desc == "未排除任何群":
                    lines.append(f"· {label}：{desc}")
                else:
                    lines.append(f"· {label}：{desc} {'❌ 本群被排除' if hit else '✅ 本群正常'}")

        # ---------- ② 白名单式功能的群号（填了才生效） ----------
        white_rows = []
        for label, name, sub in (
            ("整点报时", "hourly_chime_groups", ""),
            ("状态推送", "daily_status_push_groups", "自动推送"),
            ("每日读报", "daily_news_auto_groups", "自动推送"),
        ):
            # 这些名单存在各模块里，从模块读更准确
            attr = {
                "hourly_chime_groups": ("hourly_chime_module", "enabled_groups"),
                "status_groups": (None, None),
                "daily_status_push_groups": ("status_push_module", "blocked_groups"),
                "daily_news_groups": ("daily_news_module", "manual_groups"),
                "daily_news_auto_groups": ("daily_news_module", "auto_groups"),
            }.get(name, (None, None))
            if attr[0]:
                mod = getattr(p, attr[0], None)
                gids = [str(x) for x in (getattr(mod, attr[1], None) or [])] if mod else []
            else:
                gids = _glist(name)
            if not gids:
                white_rows.append((label, sub, "未填写（不生效）", False))
            else:
                white_rows.append((label, sub, f"已填 {len(gids)} 个群", gid in gids))
        if white_rows:
            lines.append("")
            lines.append("【生效群号】（必须填写才生效）")
            for label, sub, desc, ok in white_rows:
                tag = f"{label}·{sub}" if sub else label
                mark = "✅ 本群已填" if ok else "❌ 本群未填"
                lines.append(f"· {tag}：{desc} {mark if desc != '未填写（不生效）' else ''}".rstrip())

        # ---------- ③ 各功能的「群号」配置 ----------
        #   与后台各功能页的群号黑名单一一对应，避免状态显示与实际配置脱节
        def _wl_of(getter):
            """getter() 返回群号列表；空列表视为不排除任何群"""
            try:
                gids = [str(x) for x in (getter() or [])]
            except Exception:
                return None
            return gids

        wl_specs = [
            ("fortune",    "今日运势", "fortune_module"),
            ("husband",    "今日老公", "husband_module"),
            ("luck",       "今日人品", "luck_module"),
            ("word_reply", "词库系统", "word_reply_module"),
            ("greeting",   "打卡系统", "greeting_module"),
            ("checkin",    "签到系统", "checkin_module"),
        ]
        wl_lines = []
        for key, label, mod_attr in wl_specs:
            mod = getattr(p, mod_attr, None)
            gids = _wl_of(lambda m=mod: getattr(m, "allowed_groups", None))
            if gids is None or not gids:
                continue          # 模块未加载或未排除任何群，无需显示
            mark = "❌ 本群被排除" if gid in gids else "✅ 本群正常"
            wl_lines.append(f"· {label}：{'、'.join(gids)} {mark}")
        if wl_lines:
            lines.append("")
            lines.append("【功能群号黑名单】（填了的群不生效）")
            lines.extend(wl_lines)

        # ---------- ③ 本群功能开关 ----------
        #   名称用固定功能名（不显示用户自定义的触发词），
        #   状态综合「后台功能开关 + 本群开关 + 群号白名单」三层判断
        lines.append("")
        lines.append("【本群功能开关】")
        group_cfg = p.group_feature_switches.get(gid, {})
        sub_feats = set(CHECKIN_SUB_FEATURES)

        # 各功能的「后台启用开关」（True/False）
        ck_mod = getattr(p, "checkin_module", None)

        def _ck_flag(attr):
            if ck_mod is None:
                return True
            return bool(getattr(ck_mod, attr, True))

        def _mod_flag(mod_attr):
            m = getattr(p, mod_attr, None)
            if m is None:
                return True
            return bool(getattr(m, "enable", True))

        feature_switches = {
            "fortune":    _mod_flag("fortune_module"),
            "husband":    _mod_flag("husband_module"),
            "luck":       _mod_flag("luck_module"),
            "word_reply": _mod_flag("word_reply_module"),
            "meme":       bool(getattr(p, "meme_enable", True)),
            "status":     bool(getattr(p, "status_enable", True)),
            "greeting":   _mod_flag("greeting_module"),
            "minecraft":  _mod_flag("minecraft_module"),
            "checkin":    _mod_flag("checkin_module"),
            "steal":      _ck_flag("steal_enable"),
            "bank":       _ck_flag("bank_enable"),
            "mount":      _ck_flag("mount_enable"),
            "job":        _ck_flag("job_enable"),
            "speak_rank": bool(getattr(
                getattr(p, "speak_stats_module", None), "enable", True)),
            "pet":        bool(getattr(
                getattr(p, "pet_module", None), "enable", True)),
            "score_admin": bool(getattr(p, "score_admin_enable", True)),
            "music":      bool(getattr(
                getattr(p, "music_module", None), "enable", True)),
            # ★ 小鸟图鉴：只看总开关，不受群黑名单影响
            "bird":       bool(getattr(p, "bird_enable", True)),
            # ★ 1.7.6：抽奖功能（签到子功能）
            "lottery":    _ck_flag("lottery_enable"),
            # ★ 1.7.6：抢银行（银行子功能）
            "rob":        _ck_flag("rob_enable"),
            # ★ 1.7.6：奖池（抽奖子功能）
            "lottery_pool": _ck_flag("lottery_pool_enable"),
        }
        # 各功能的群号名单判定：黑名单命中 / 白名单未填
        wl_blocks = {}
        white_ok = {}
        for key, _label, mod_attr in wl_specs:
            mod = getattr(p, mod_attr, None)
            gids = _wl_of(lambda m=mod: getattr(m, "allowed_groups", None))
            if gids:
                wl_blocks[key] = gid in gids
        wl_blocks["meme"] = self._group_in_list(getattr(p, "meme_groups", None), gid)

        # 白名单式功能：本群是否在名单里
        def _in_list(mod_attr, list_attr):
            mod = getattr(p, mod_attr, None)
            if mod is None:
                return False
            return gid in [str(x) for x in (getattr(mod, list_attr, None) or [])]

        white_ok["chime"] = _in_list("hourly_chime_module", "enabled_groups")
        white_ok["news_auto"] = _in_list("daily_news_module", "auto_groups")
        white_ok["push"] = _in_list("status_push_module", "blocked_groups")
        # 黑名单式：命中名单 = 本群不能用
        wl_blocks["status"] = self._group_in_list(getattr(p, "status_groups", None), gid)
        wl_blocks["news"] = self._group_in_list(
            getattr(getattr(p, "daily_news_module", None), "manual_groups", None), gid)
        wl_blocks["speak_rank"] = self._group_in_list(
            getattr(getattr(p, "speak_stats_module", None), "allowed_groups", None), gid)
        wl_blocks["pet"] = self._group_in_list(
            getattr(getattr(p, "pet_module", None), "allowed_groups", None), gid)
        wl_blocks["score_admin"] = self._group_in_list(
            getattr(p, "score_admin_groups", None), gid)
        wl_blocks["music"] = self._group_in_list(
            getattr(getattr(p, "music_module", None), "allowed_groups", None), gid)
        # ★ 小鸟图鉴：黑名单直接存在插件上（bird_groups）
        wl_blocks["bird"] = self._group_in_list(
            getattr(p, "bird_groups", None), gid)

        for key, label in FEATURE_LABEL.items():
            g_on = bool(group_cfg.get(key, True))
            f_on = feature_switches.get(key, True)
            blk = wl_blocks.get(key, False)   # True = 本群在群号黑名单里
            if key in self.WHITELIST_FEATURES:
                # 白名单功能：名单里没填本群 = 不生效
                if not white_ok.get(key, False):
                    mark = "❌ 本群未在名单"
                elif not g_on:
                    mark = "❌ 本群已关闭"
                else:
                    mark = "✅ 开启"
            elif not f_on:
                mark = "❌ 后台已停用"
            elif blk:
                mark = "❌ 本群已被排除"
            elif not g_on:
                mark = "❌ 本群已关闭"
            else:
                mark = "✅ 开启"
            # 子功能额外标注父开关，避免误解为完全独立
            suffix = ""
            if key in sub_feats:
                if not bool(group_cfg.get("checkin", True)):
                    suffix = "（签到主开关已关，随之失效）"
                else:
                    suffix = "（签到子功能）"
            lines.append(f"· {label}：{mark}{suffix}")

        # ---------- ⑤ 用「群号订阅」控制的功能 ----------
        #   整点报时 / 每日读报 / 定时状态推送 的每群开关存在各自的状态文件里，
        #   不在 group_feature_switches 中，这里单独列出，避免状态显示与后台脱节
        sub_specs = [
            ("整点报时", "hourly_chime_module"),
            ("每日读报", "daily_news_module"),
            ("定时状态推送", "status_push_module"),
        ]
        sub_lines = []
        for label, attr in sub_specs:
            m = getattr(p, attr, None)
            if m is None:
                continue
            try:
                on = bool(m.is_group_on(gid))
            except Exception:
                continue
            sub_lines.append(f"· {label}：{'✅ 本群已开启' if on else '❌ 本群未开启'}")
        if sub_lines:
            lines.append("")
            lines.append("【群号订阅类功能】")
            lines.extend(sub_lines)

        lines.append("")
        lines.append("💡 默认全部开启；用「开启功能 xxx」「关闭功能 xxx」调整本群状态")
        lines.append("💡 功能开关与群号白名单在后台配置中设置；单个群可用指令开关")
        lines.append("💡 群号订阅类功能在各自菜单里用指令开关（或在后台填群号）")
        return "\n".join(lines)

    def set_group_must_at_bot(self, group_id: str, enabled: bool) -> str:
        p = self.plugin
        gid = str(group_id).strip()
        if not gid:
            return "⚠️ 请指定群号"
        if not hasattr(p, "group_must_at_bot") or p.group_must_at_bot is None:
            p.group_must_at_bot = {}
        p.group_must_at_bot[gid] = bool(enabled)
        p.save_rules_to_config()
        state = "开启" if enabled else "关闭"
        return f"✅ 已{state}群【{gid}】的「必须艾特机器人」限制"

    def get_group_must_at_bot(self, group_id: str) -> bool:
        p = self.plugin
        gid = str(group_id).strip()
        if not gid:
            return bool(p.must_at_bot)
        if hasattr(p, "group_must_at_bot") and gid in p.group_must_at_bot:
            return bool(p.group_must_at_bot[gid])
        return bool(p.must_at_bot)

    def must_at_bot_status_text(self, group_id: str = None, target_group: str = None) -> str:
        p = self.plugin
        gid = None
        if target_group:
            gid = str(target_group).strip()
        elif group_id:
            gid = str(group_id).strip()
        if not gid:
            return "⚠️ 请在群聊中使用该指令，或指定群号：必须艾特状态 群号"
        enabled = self.get_group_must_at_bot(gid)
        global_default = bool(p.must_at_bot)
        is_override = hasattr(p, "group_must_at_bot") and gid in p.group_must_at_bot
        lines = [
            _title_bar(f"群 {gid} 必须艾特机器人状态"),
            f"当前状态：{'✅ 开启（必须 @机器人 才响应）' if enabled else '❌ 关闭（无需 @机器人）'}",
            f"来源：{'本群独立设置' if is_override else '跟随全局默认'}",
            f"全局默认：{'开启' if global_default else '关闭'}",
            "",
            "💡 用「必须艾特开 [群号]」「必须艾特关 [群号]」调整",
        ]
        return "\n".join(lines)

    def word_add(self, args: str) -> str:
        p = self.plugin
        if p.word_reply_module is None:
            # 内部状态异常：只记日志，不回复群（由调用方静默处理）
            logger.warning("[apix-meme] 词库模块未加载，忽略该指令")
            return ""
        if "|" not in args:
            return f"用法：{p.cmd_word_add_name} 关键词1,关键词2 | 回复内容"
        kw_part, reply_part = args.split("|", 1)
        kw_part = kw_part.strip()
        reply_part = reply_part.strip()
        if not kw_part or not reply_part:
            return "关键词和回复内容都不能为空"
        keywords = [k.strip() for k in kw_part.split(",") if k.strip()]
        if not keywords:
            return "关键词不能为空"
        p.word_reply_module.rules.append({
            "keywords": keywords,
            "reply": reply_part,
        })
        p.save_rules_to_config()
        return f"✅词库已添加\n关键词：{','.join(keywords)}\n回复：{reply_part}"

    def word_del(self, args: str) -> str:
        p = self.plugin
        if p.word_reply_module is None:
            # 内部状态异常：只记日志，不回复群（由调用方静默处理）
            logger.warning("[apix-meme] 词库模块未加载，忽略该指令")
            return ""
        if not args.isdigit():
            return f"用法：{p.cmd_word_del_name} 序号"
        idx = int(args) - 1
        if idx < 0 or idx >= len(p.word_reply_module.rules):
            return "⚠️序号不存在"
        removed = p.word_reply_module.rules.pop(idx)
        p.save_rules_to_config()
        return f"✅已删除词库：{'/'.join(removed['keywords'])}"

    def word_list_text(self) -> str:
        p = self.plugin
        if p.word_reply_module is None:
            # 内部状态异常：只记日志，不回复群（由调用方静默处理）
            logger.warning("[apix-meme] 词库模块未加载，忽略该指令")
            return ""
        rules = p.word_reply_module.rules
        if not rules:
            return "词库为空"
        lines = [_title_bar(f"词库列表（共 {len(rules)} 条）")]
        for i, rule in enumerate(rules, start=1):
            kw = " ☆ ".join(rule["keywords"])
            reply = rule["reply"].replace("\n", " ")
            if len(reply) > 20:
                reply = reply[:20] + "..."
            lines.append(f"{i}：{kw} → {reply}")
        return "\n".join(lines)

    def group_disable(self, group_id: str) -> str:
        p = self.plugin
        if not group_id:
            return "私聊无法关闭"
        if group_id in p.disabled_groups:
            return "本群已经处于关闭状态"
        p.disabled_groups.append(group_id)
        p.save_rules_to_config()
        return "✅本群娱乐系统已关闭"

    def group_enable(self, group_id: str) -> str:
        p = self.plugin
        if not group_id:
            return "私聊无法开启"
        if group_id in p.disabled_groups:
            p.disabled_groups.remove(group_id)
            p.save_rules_to_config()
        return "✅本群娱乐系统已开启"

    @staticmethod
    def _sync_rules(p):
        """
        改规则前先把 self.rules 与磁盘对齐。
        因为 reload_cfg() 每次都会按磁盘顺序重建 self.rules（未保存的修改会被
        挂到列表末尾），若直接用内存里的序号增删，用户看到列表和实际序号可能不一致。
        """
        try:
            if not getattr(p, "_dirty", False):
                p.reload_cfg()
        except Exception:
            logger.exception("[apix-meme] 同步规则列表失败")

    def meme_add(self, args: str) -> str:
        p = self.plugin
        if not args:
            return (
                f"用法1（单参数）：{p.cmd_add_name} 关键词1,关键词2,URL模板\n"
                f"用法2（多参数）：{p.cmd_add_name} 关键词1,关键词2 | URL模板 | 参数个数\n"
                f"用法3（指定返回类型）：{p.cmd_add_name} 关键词 | URL模板 | 参数个数 | video\n"
                f"用法4（接口返回 JSON）：{p.cmd_add_name} 关键词 | URL模板 | 参数个数 | video | data.video\n"
                f"　 （参数个数填 0 表示无参数接口）\n"
                f"　 （返回类型：image=图片 / video=视频 / text=文本，默认 image）\n"
                f"　 （text 文本接口支持纯文本、document.write(\"...\") 与 JSON 取字段）\n"
                f"　 （最后一段填 JSON 里媒体地址 / 文本内容的字段路径，留空则自动搜索）"
            )

        self._sync_rules(p)

        if "|" in args:
            parts = [x.strip() for x in args.split("|")]
            if len(parts) < 2 or len(parts) > 5:
                return "格式错误！多参数格式：关键词 | URL | 参数个数 | 返回类型 | JSON字段"
            kw_str = parts[0]
            url_template = parts[1]
            param_count = parts[2] if len(parts) >= 3 else "1"
            media_type = parts[3].lower() if len(parts) >= 4 else ""
            json_field = parts[4] if len(parts) >= 5 else ""
            keywords = [k.strip() for k in kw_str.split(",") if k.strip()]
            if not keywords or not url_template:
                return "关键词和 URL 不能为空"
            if not param_count.isdigit():
                param_count = "1"
            if media_type not in ("image", "video", "text"):
                media_type = "image"
            p.rules.append({
                "keywords": keywords,
                "url_template": url_template,
                "param_count": param_count,
                "media_type": media_type,
                "json_field": json_field,
                "meme": "",
            })
            p._dirty = True
            kind_label = {"video": "视频", "text": "文本"}.get(media_type, "图片")
            extra = f"，JSON字段 {json_field}" if json_field else ""
            return (
                f"✅添加成功（{param_count} 参数，{kind_label}{extra}）\n"
                f"执行 {p.cmd_save_name} 保存！"
            )

        parts = [x.strip() for x in args.rsplit(",", 1)]
        if len(parts) != 2 or not parts[0] or not parts[1]:
            return "格式错误！"
        kw_str, url_template = parts
        keywords = [k.strip() for k in kw_str.split(",") if k.strip()]
        if not keywords:
            return "关键词不能为空"
        p.rules.append({
            "keywords": keywords,
            "url_template": url_template,
            "param_count": "1",
            "media_type": "image",
            "json_field": "",
            "meme": "",
        })
        p._dirty = True
        return f"✅添加成功（1 参数，图片）\n执行 {p.cmd_save_name} 保存！"

    def meme_del(self, args: str) -> str:
        p = self.plugin
        if not args or not args.isdigit():
            return f"用法：{p.cmd_del_name} 序号"
        self._sync_rules(p)
        idx = int(args) - 1
        if idx < 0 or idx >= len(p.rules):
            return "⚠️序号不存在"
        p.rules.pop(idx)
        p._dirty = True
        return f"✅已删除，执行 {p.cmd_save_name} 保存！"

    def meme_save(self) -> str:
        p = self.plugin
        ok = p.save_rules_to_config()
        if ok:
            return "✅所有规则已保存到插件配置！"
        return "❌保存失败，请查看后台日志"