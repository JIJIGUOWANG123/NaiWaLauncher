import os
import re as _re

# ★ AstrBot 会把 @ 编译进 message_str，格式是「@昵称(QQ号)」，
#   例：加积分 @铁剑娘(1142479412) 100000000
#   以前的正则抓不到这种写法里的 QQ，
#   导致「@某人 数量」永远解析不出目标 -> 静默失败。
_AT_INLINE_RE = _re.compile(r"@[^\s()\u3000]*[\(（](\d{5,12})[\)）]")
import json
import time
import random
import datetime
from astrbot.api import logger

from .path_utils import parse_gid_list as _parse_gid_list
from .path_utils import title_bar, title_foot
from .path_utils import cmd_arg, register_cmd_names as _register_cmd_names_impl
from .path_utils import fmt_num
from .path_utils import nick_display as _nick_display
# ★★ 1.7.7：榜单行（带「 1. 」前缀 / 名次列）用**窄档**宽度预算
from .path_utils import nick_display_narrow as _nick_narrow
# ★★ 1.7.7：榜单名次前缀（前三名奖牌 + 两空格列分隔 -> 渲染端对齐）
from .path_utils import rank_tag as _rank_tag
# ★★ 1.7.7：取消息里的 @ 列表（「清空财富 @某人」用）
try:
    from .event_helpers import get_ats_from_msg as _get_ats_from_msg
except Exception:  # pragma: no cover
    def _get_ats_from_msg(event):
        return []


def _today_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d")


def _month_str() -> str:
    return datetime.datetime.now().strftime("%Y-%m")


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


def get_user_id(event) -> str:
    try:
        uid = event.get_sender_id() or ""
        if uid:
            return str(uid)
    except Exception:
        pass
    try:
        uid = getattr(event, "user_id", "") or ""
        if uid:
            return str(uid)
    except Exception:
        pass
    return "unknown"


def get_user_name(event) -> str:
    for attr in ("sender_name", "sender_nickname", "nickname", "nick"):
        try:
            v = getattr(event, attr, None)
            if v:
                return str(v)
        except Exception:
            pass
    try:
        mo = getattr(event, "message_obj", None)
        if mo is not None:
            for attr in ("sender_name", "sender_nickname", "nickname"):
                v = getattr(mo, attr, None)
                if v:
                    return str(v)
            sender = getattr(mo, "sender", None)
            if sender is not None:
                for attr in ("nickname", "card", "name"):
                    v = getattr(sender, attr, None)
                    if v:
                        return str(v)
    except Exception:
        pass
    return ""


def _fmt_time(ts: float) -> str:
    try:
        return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "（未知）"


class CheckinModule:
    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path
        self.enable = True
        self.trigger_names = ["签到"]
        # ★ 1.7.6：旧「签到排行」指令已删除（拆成三种排行），
        #   这里保留属性只为兼容旧配置，不再参与匹配。
        self.rank_trigger_names = ["签到排行"]
        # ★ 1.7.6：三种独立排行（次数 / 总财富 / 负债），指令后台可自定义
        self.rank_count_names = ["签到次数排行", "次数排行"]
        self.rank_wealth_names = ["总财富排行", "财富排行"]
        self.rank_debt_names = ["负债排行", "欠款排行"]
        self.info_trigger_names = ["签到统计", "我的签到", "查询签到"]

        # ★ 积分显示名称（后台可改，如「金币」）；默认「积分」
        self.score_name = "积分"
        self.score_min = 1        # 签到随机积分下限（后台可改）
        self.score_max = 1000     # 签到随机积分上限（后台可改）

        self.steal_enable = True
        self.steal_trigger_names = ["偷积分", "偷分"]
        # ★ 作弊指令（管理员专用）：加积分 / 减积分
        self.score_add_trigger_names = ["加积分", "增加积分"]
        self.score_sub_trigger_names = ["减积分", "减少积分"]
        # ★★ 1.7.7：清空某群员全部财富（管理员，不可撤销）
        self.wipe_wealth_trigger_names = ["清空财富", "清零财富"]
        self.steal_min = 1
        self.steal_max = 100
        self.steal_success_rate = 50
        self.steal_fail_punish_rate = 50
        self.steal_punish_min = 1
        self.steal_punish_max = 100

        self.bank_enable = True
        self.bank_trigger_names = ["银行", "我的银行"]
        self.bank_deposit_names = ["存钱", "存款"]
        self.bank_withdraw_names = ["取钱", "取款"]
        self.bank_interest_rate = 0.01
        self.bank_interest_hour = 0

        # ============ 银行借款（1.7.6 新增）============
        # ★ 借款产生的负债单独记在 u["loan"]（本金 + 已计利息），
        #   不动 u["total_score"]，这样历史消费/偷取记录不会被覆盖。
        #   净值 = total_score - loan；总资产 = total_score + bank - loan。
        self.loan_enable = True
        self.loan_trigger_names = ["借款", "贷款", "借钱"]
        self.loan_repay_names = ["还款", "还钱", "还债"]
        self.loan_max = 10000            # 单次借款上限（可负数？不允许）
        # ★ 还款利息：默认偏高，显得银行不是好人
        self.loan_interest_rate = 0.30
        # ★ 1.7.6：逾期利息（老赖）
        #   · loan_due_days           借款后多少天算逾期（0 = 不设期限）
        #   · loan_overdue_step_hours 每隔多少小时加一次逾期利息（默认 24）
        #   · loan_overdue_rate       每期加收多少（按**本金**算，默认 5%）
        #   · loan_deadbeat_days      逾期多少天开始挂「老赖」标签（0 = 一逾期就挂）
        self.loan_due_days = 7
        self.loan_overdue_step_hours = 24
        self.loan_overdue_rate = 0.05
        self.loan_deadbeat_days = 0
        self.loan_deadbeat_tag = "🐍 老赖"
        self.loan_overdue_notice = True
        self.loan_info_names = ["借款信息", "我的借款", "欠款"]
        # ★ 1.7.6：花钱时钱包不够，是否自动从银行扣（默认开）
        self.use_bank_pay = True

        # ============ 抢银行（1.7.6 新增，银行子功能）============
        # ★ 每天一次、**没有参数**：
        #   成功 -> 抢到别人的钱进自己钱包
        #   失败 -> 银行账户冻结若干天 + 扣掉一半财产（钱包+银行 的一半）
        self.rob_enable = True
        self.rob_trigger_names = ["抢银行", "抢劫银行", "打劫银行"]
        self.rob_success_rate = 5        # 成功概率（%），默认很低
        self.rob_min = 1                 # 抢到的钱下限
        self.rob_max = 10000             # 抢到的钱上限
        self.rob_freeze_days = 3         # 失败冻结天数
        self.rob_fail_penalty_rate = 0.5  # 失败扣一半财产

        # ============ 签到商店（1.7.6 新增）============
        # ★ 卖两类东西：
        #   ① 保险箱（kind=vault）：买了以后
        #      · 「签到统计」里会多显示保险箱余额
        #      · 可以把钱**存进保险箱**（存进去的钱**偷不走**）
        #      · 降低**别人偷你**的成功率
        #   ② 武器（kind=weapon，默认）：
        #      · 提高**你偷别人**的成功率
        #      · 部分还能降低**别人偷你**的成功率（防御）
        self.shop_enable = True
        self.shop_trigger_names = ["签到商店", "积分商店", "商店"]
        self.shop_buy_trigger_names = ["购买商品", "买商品"]
        # ★ 1.7.6：**不占用「存钱/取钱」** —— 那是银行功能的指令，
        #   用了会冲突。保险箱只用「存入保险箱 / 取出保险箱」。
        self.shop_save_trigger_names = ["存入保险箱"]
        self.shop_take_trigger_names = ["取出保险箱"]
        # ★★ 1.7.7：**武器必须装备才生效** —— 买了不等于生效。
        #   装备后的武器加成算在「偷积分 / 防御 / 抢银行」上；
        #   没装备的只是收藏（加成不生效）。
        #   ★ 指令名默认「启用武器」（用户定的），旧名「装备武器」仍认。
        self.shop_equip_trigger_names = ["启用武器", "装备武器"]
        # 武器「抢银行」加成上限（%）—— 和偷取加成一样，防止堆太高
        self.shop_rob_bonus_cap = 20.0
        # ★★ 1.7.7：「我的装备」查询指令
        self.my_equip_trigger_names = ["我的装备", "我的武器"]
        # ★ 保险箱能降低多少「被偷概率」—— 每 1 件减免的百分点，
        #   以及减免上限（防止堆到无人可偷）
        self.vault_steal_reduce = 15.0     # 有保险箱时被偷概率 -15%
        self.shop_defense_cap = 60.0       # 被偷概率最多降 60%
        # ★★ 1.7.7：武器**破保险箱**规则
        #   · vault_break_rate   —— 全局默认破箱概率（%），武器可单独覆盖
        #   · vault_break_ratio  —— 破箱后夺走保险箱里多少比例（1.0 = 全部）
        #   · vault_break_destroy—— 破箱时是否把保险箱**砸毁**（需重新购买）
        self.vault_break_rate = 0.0
        self.vault_break_ratio = 1.0
        self.vault_break_destroy = False
        self.shop_list = []                # 商店条目（独立数据文件里维护）

        # ============ 银行理财（1.7.6 新增，银行子功能）============
        # ★ 玩法：把钱**买入理财**，之后**每天随机盈亏**一次
        #   · 盈利：直接加到买入金额上
        #   · 亏损：从买入金额里扣；**不够扣就从自己资产（钱包+银行）补**
        #   · 可以**随时取出**，取出的钱回**银行账户**
        # ★ 盈亏在**每天第一次查看/操作理财时结算一次**
        self.fund_enable = True
        self.fund_trigger_names = ["理财", "我的理财"]
        self.fund_buy_names = ["购买理财", "买入理财", "买理财"]
        self.fund_sell_names = ["取出理财", "卖出理财", "赎回理财"]
        # ★ 每天随机盈亏幅度（%）；正负号决定方向
        self.fund_profit_max = 8.0      # 单日最多 +8%
        self.fund_loss_max = 6.0        # 单日最多 -6%

        # ============ 抽奖（1.7.6 新增，接在签到最后）============
        # ★ 指令**不带参数**：每次固定花 lottery_cost，奖品在 0~lottery_prize_max 之间随机。
        #   下限固定为 0（允许空手而归），后台只能调「每次花多少」和「上限多少」。
        self.lottery_enable = True
        self.lottery_trigger_names = ["开始抽奖", "抽奖"]
        # ★★ 1.7.6：「全部抽奖」—— 一个指令把当天剩余机会全抽完
        self.lottery_all_trigger_names = ["全部抽奖", "一键抽奖"]
        self.lottery_cost = 100          # 每次抽奖固定花多少
        self.lottery_prize_max = 500     # 奖品上限（下限固定 0）
        # ★ 1.7.6：每天最多抽几次（0 = 不限次数）
        self.lottery_daily_limit = 10

        # ============ 奖池（1.7.6 新增）============
        # ★ 入门费**归系统**；奖池的钱由后台配置的「每日随机区间」决定（系统出钱）。
        #   名额满 -> 立刻开奖：奖池金额**全额随机分给所有参与者**，
        #   随机额度直接进各自钱包。每人每天只能参与一次。
        self.pool_enable = True
        self.pool_trigger_names = ["参与抽奖", "参与奖池", "加入奖池"]
        self.pool_info_names = ["奖池", "今日奖池", "奖池信息"]
        self.pool_fee = 500              # 入门费（归系统）
        self.pool_slots = 10             # 参与名额
        self.pool_min = 1000             # 奖池每日随机下限
        self.pool_max = 10000            # 奖池每日随机上限
        # ★ 1.7.6：名额没满时，多久自动开奖（小时，0 = 不自动开）
        self.pool_timeout_hours = 1
        # ★ 1.7.6：每人每天最多参与几轮（0 = 不限）
        self.pool_per_day = 1

        # ============ 打工配置 ============
        self.job_enable = True
        self.job_trigger_names = ["打工", "干活"]
        self.job_info_trigger_names = ["打工列表", "工作列表", "工种"]
        # ★★ 1.7.6：「全部打工」触发词（后台可自定义）
        self.job_all_trigger_names = ["全部打工", "一键打工"]
        self.job_list = []  # [{"name": "", "duration_hours": 1, "reward_min": 10, "reward_max": 100}]
        self.cmd_job_add_names = ["添加工种", "新增工种"]
        self.cmd_job_del_names = ["删除工种", "删工种"]

        # ============ ★★ 1.7.7：体力系统 ============
        self.stamina_enable = True
        self.stamina_max = 100            # 每人每天体力上限
        # 每个工种随机消耗的体力区间（工种条目可用 stamina_min/max 覆盖）
        self.job_stamina_min = 1
        self.job_stamina_max = 5
        # 食物默认恢复多少体力（条目字段 stamina_restore 可覆盖）
        self.stamina_food_restore = 30
        # 加班：清 1 小时冷却要多少体力 + 最低消费
        self.stamina_refill_per_hour = 10
        self.stamina_refill_min = 5
        # 指令名（后台可自定义）
        self.stamina_view_trigger_names = ["我的体力", "体力"]
        self.food_eat_trigger_names = ["吃食物", "吃东西"]
        # ★★ 1.7.7：加班拆成「主菜单 / 状态 / 单个 / 全部」四件事，
        #   四个名字各自独立配置（**默认全部不重名**）：
        #     · 加班功能  -> 输出下级菜单
        #     · 加班      -> **不带参数时**输出加班状态
        #     · 加班 工种 -> 单独加班这一个工种
        #     · 全部加班  -> 加班所有工种
        #   ★ 曾经把菜单入口名和执行指令名共用一key，导致撞名、指令失效。
        self.stamina_refill_menu_names = ["加班功能"]
        self.stamina_refill_trigger_names = ["加班", "一键冷却"]
        self.stamina_refill_status_names = ["加班状态"]
        self.stamina_refill_all_names = ["全部加班", "加班全部",
                                         "一键全部冷却"]

        self.mount_enable = True
        self.mount_trigger_names = ["坐骑", "我的坐骑"]
        self.mount_list_trigger_names = ["坐骑列表", "坐骑商店"]
        self.mount_buy_trigger_names = ["购买坐骑", "买坐骑"]
        self.cmd_mount_add_names = ["添加坐骑", "新增坐骑"]
        self.cmd_mount_del_names = ["删除坐骑", "删坐骑"]
        # ★ 1.7.6：装备坐骑 / 坐骑查看（带参数）
        self.mount_equip_names = ["装备坐骑", "骑乘坐骑"]
        self.mount_view_names = ["坐骑查看", "查看坐骑"]
        # ★★ 市场版：坐骑图片素材目录已移除（不再插入坐骑图片）
        self.mount_img_dir = ""
        # ★ 1.7.6：每天群里第一句话的「闪亮登场」提示
        self.mount_greet_enable = True
        self.mount_greet_text = "🌟 $name 骑着「$mount」闪亮登场！"

        self.group_mode = "off"
        self.feature_groups = {}
        self.group_whitelist = []
        self.group_blacklist = []
        # 全局群白名单（不填 = 不限制群聊）
        self.allowed_groups = []

        self.users = {}
        self.daily = {}
        self.speaks = {}
        # ★ 1.7.6：抢银行的「每天一次」记录（与签到日限制分开算）
        self.robs = {}
        # ★ 1.7.6：抽奖的「每天次数」记录
        self.lotteries = {}
        # ★ 1.7.6：奖池记录（按天，开奖后保留供查询）
        self.pools = {}
        # ★ 1.7.6：坐骑「每天登场只提示一次」记录
        self.mount_greet = {}
        self.last_interest_date = ""
        self._need_save = False

        # ★ 由 main.py 注入的全局昵称缓存
        self.nickname_cache = {}

        self._load()
        self._register_cmd_names()

    def _register_cmd_names(self):
        """
        把所有指令名登记到全局表（1.7.6）。

        ★ 为什么：不带空格时 `坐骑查看赤兔` 会被别名 `坐骑` 当成参数
          `查看赤兔` 吃掉。登记后就能认出「这段以另一条指令开头」，
          于是不当参数处理，交给 `坐骑查看` 去匹配。

        登记范围：所有 `*_names` 属性里的字符串。

        ★ 为什么不用 `*_name`（单数）：那是 `score_name` = 「积分」
          这种**数据值**，不是指令。
        ★ `*_view_names` / `*_equip_names` 看着像数据，其实装的
          正是「坐骑查看 / 装备坐骑」这些**指令名**，所以要一起登记。
        """
        try:
            _all = []
            for _k, _v in vars(self).items():
                if not _k.endswith("_names"):
                    continue
                if isinstance(_v, str):
                    if _v.strip():
                        _all.append(_v.strip())
                elif isinstance(_v, (list, tuple, set)):
                    _all.extend(str(x).strip() for x in _v
                                if str(x).strip())
            return _register_cmd_names_impl(_all)
        except Exception:
            return 0

    def _load_mounts_from_store(self):
        """
        从独立数据文件读取坐骑列表（1.7.6）。

        ★ 为什么需要：后台配置里的 `mount_list` 只是**只读摘要**，
          真实数据在 `plugin_data/<id>_data.json` 的 collections.mount_list。
          早期版本会把摘要文本误写进配置，导致坐骑列表变空。
        """
        try:
            ds = getattr(self, "data_store", None)
            rows = ds.get("mount_list") if ds is not None else None
        except Exception:
            logger.exception("[checkin] 从数据文件读取坐骑失败")
            rows = None
        if not isinstance(rows, list):
            return
        out = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            try:
                price = int(str(item.get("price", "0")).strip() or "0")
            except Exception:
                price = 0
            _row = {
                "name": name,
                "price": max(0, price),
                "desc": str(item.get("desc", "")).strip(),
            }
            _img = str(item.get("img", "") or "").strip()
            if _img:
                _row["img"] = _img
            # ★★ 1.7.6：坐骑附加 BUFF 的**后台覆盖值**要保留，
            #   否则后台填了也会被这里丢掉（只剩按价格算的默认值）。
            for _bk in ("steal_bonus", "rob_bonus"):
                _bv = item.get(_bk)
                if _bv not in (None, ""):
                    _row[_bk] = _bv
            out.append(_row)
        self.mount_list = out

    def _load_shop_from_store(self):
        """
        从独立数据文件读取签到商店条目（1.7.6）。

        ★ 和坐骑列表同理：后台配置里的 `shop_list` 只是**只读摘要**，
          真实数据在 `plugin_data/<id>_data.json` 的 collections.shop_list。
        """
        try:
            ds = getattr(self, "data_store", None)
            rows = ds.get("shop_list") if ds is not None else None
        except Exception:
            logger.exception("[checkin] 从数据文件读取签到商店失败")
            rows = None
        if not isinstance(rows, list):
            return
        out = []
        for it in rows:
            if not isinstance(it, dict):
                continue
            nm = str(it.get("name", "")).strip()
            if not nm:
                continue
            try:
                _pr = int(str(it.get("price", "0")).strip() or "0")
            except Exception:
                _pr = 0
            _row = {
                "name": nm,
                "price": max(0, _pr),
                "desc": str(it.get("desc", "")).strip(),
                "kind": str(it.get("kind", "") or "weapon").strip()
                or "weapon",
            }
            # ★★ 白名单：这些字段要原样带过去，否则会被静默丢弃
            #   · steal_bonus / defense_bonus  —— 武器加成
            #   · vault_break_rate            —— 破保险箱概率（1.7.7）
            #   · stamina_restore             —— 食物恢复体力（1.7.7）
            for _bk in ("steal_bonus", "defense_bonus",
                        "vault_break_rate", "stamina_restore"):
                _bv = it.get(_bk)
                if _bv not in (None, ""):
                    _row[_bk] = _bv
            _img = str(it.get("img", "") or "").strip()
            if _img:
                _row["img"] = _img
            out.append(_row)
        self.shop_list = out

    def reload(self, cfg: dict):
        # ★ 统一布尔解析：后台/文本配置常把布尔写成字符串，
        #   bool("false") 会得到 True（非空字符串），开关就失效了。
        def _bool_cfg(key, default=True):
            v = cfg.get(key, default)
            if isinstance(v, bool):
                return v
            s = str(v).strip().lower()
            if s in ("false", "0", "no", "off", "n", "否", "关闭"):
                return False
            if s in ("true", "1", "yes", "on", "y", "是", "开启"):
                return True
            if s == "":
                return bool(default)
            return bool(default)
        self._bool_cfg = _bool_cfg

        self.enable = _bool_cfg("checkin_enable", True)

        # ★ 签到随机积分范围（后台可改；默认 1~1000 保持原行为）
        try:
            self.score_min = max(1, int(str(
                cfg.get("checkin_score_min", "1")).strip() or "1"))
        except Exception:
            self.score_min = 1
        try:
            self.score_max = max(
                self.score_min,
                int(str(cfg.get("checkin_score_max", "1000")).strip()
                    or "1000"))
        except Exception:
            self.score_max = max(self.score_min, 1000)

        raw = str(cfg.get("checkin_trigger_names", "签到") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.trigger_names = names if names else ["签到"]

        # ★ 1.7.6：旧「签到排行」指令已删除，不再读配置（保留属性兼容旧调用）
        self.rank_trigger_names = ["签到排行"]

        # ★ 1.7.6：三种独立排行指令（后台可自定义）
        for _attr, _key, _dft in (
                ("rank_count_names", "checkin_rank_count_names",
                 "签到次数排行,次数排行"),
                ("rank_wealth_names", "checkin_rank_wealth_names",
                 "总财富排行,财富排行"),
                ("rank_debt_names", "checkin_rank_debt_names",
                 "负债排行,欠款排行")):
            _raw = str(cfg.get(_key, _dft) or "").strip()
            _names = [x.strip() for x in _raw.split(",") if x.strip()]
            setattr(self, _attr, _names if _names else
                    [x.strip() for x in _dft.split(",")])

        raw = str(cfg.get("checkin_info_trigger_names", "签到统计,我的签到,查询签到") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.info_trigger_names = names if names else ["签到统计"]

        self.steal_enable = _bool_cfg("steal_enable", True)
        raw = str(cfg.get("steal_trigger_names", "偷积分,偷分") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.steal_trigger_names = names if names else ["偷积分"]

        # ★ 作弊指令：管理员加/减积分（多个用英文逗号分隔）
        raw = str(cfg.get("score_add_trigger_names", "加积分,增加积分") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.score_add_trigger_names = names if names else ["加积分"]

        raw = str(cfg.get("score_sub_trigger_names", "减积分,减少积分") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.score_sub_trigger_names = names if names else ["减积分"]

        raw = str(cfg.get("wipe_wealth_trigger_names",
                           "清空财富,清零财富") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.wipe_wealth_trigger_names = names if names else ["清空财富"]
        try:
            self.steal_min = max(1, int(str(cfg.get("steal_min", "1")).strip() or "1"))
        except Exception:
            self.steal_min = 1
        try:
            self.steal_max = max(self.steal_min, int(str(cfg.get("steal_max", "100")).strip() or "100"))
        except Exception:
            self.steal_max = 100
        try:
            self.steal_success_rate = max(0, min(100, int(str(cfg.get("steal_success_rate", "50")).strip() or "50")))
        except Exception:
            self.steal_success_rate = 50
        try:
            self.steal_fail_punish_rate = max(0, min(100, int(str(cfg.get("steal_fail_punish_rate", "50")).strip() or "50")))
        except Exception:
            self.steal_fail_punish_rate = 50
        try:
            self.steal_punish_min = max(1, int(str(cfg.get("steal_punish_min", "1")).strip() or "1"))
        except Exception:
            self.steal_punish_min = 1
        try:
            self.steal_punish_max = max(self.steal_punish_min, int(str(cfg.get("steal_punish_max", "100")).strip() or "100"))
        except Exception:
            self.steal_punish_max = 100

        self.bank_enable = _bool_cfg("bank_enable", True)
        raw = str(cfg.get("bank_trigger_names", "银行,我的银行") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.bank_trigger_names = names if names else ["银行"]
        raw = str(cfg.get("bank_deposit_names", "存钱,存款") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.bank_deposit_names = names if names else ["存钱"]
        raw = str(cfg.get("bank_withdraw_names", "取钱,取款") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.bank_withdraw_names = names if names else ["取钱"]
        try:
            self.bank_interest_rate = float(str(cfg.get("bank_interest_rate", "0.01")).strip() or "0.01")
        except Exception:
            self.bank_interest_rate = 0.01
        if self.bank_interest_rate < 0:
            self.bank_interest_rate = 0
        try:
            self.bank_interest_hour = max(0, min(23, int(str(cfg.get("bank_interest_hour", "0")).strip() or "0")))
        except Exception:
            self.bank_interest_hour = 0

        # ---------- 银行借款（1.7.6）----------
        self.loan_enable = _bool_cfg("loan_enable", True)
        raw = str(cfg.get("loan_trigger_names", "借款,贷款,借钱") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.loan_trigger_names = names if names else ["借款"]
        raw = str(cfg.get("loan_repay_names", "还款,还钱,还债") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.loan_repay_names = names if names else ["还款"]
        raw = str(cfg.get("loan_info_names", "借款信息,我的借款,欠款") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.loan_info_names = names if names else ["借款信息"]
        try:
            self.loan_max = max(1, int(str(cfg.get("loan_max", "10000")).strip()
                                    or "10000"))
        except Exception:
            self.loan_max = 10000
        # ★ 还款利息率：默认 0.30（三成，银行不是好人）
        try:
            self.loan_interest_rate = float(
                str(cfg.get("loan_interest_rate", "0.30")).strip() or "0.30")
        except Exception:
            self.loan_interest_rate = 0.30
        if self.loan_interest_rate < 0:
            self.loan_interest_rate = 0

        # ---------- 逾期利息 / 老赖（1.7.6）----------
        #   ★ 注意：_num_cfg 定义在下面，这里用等价的内联解析
        def _n(key, default, lo=None, cast=int):
            try:
                v = cast(str(cfg.get(key, str(default))).strip() or str(default))
            except Exception:
                v = default
            if lo is not None:
                v = max(lo, v)
            return v

        self.loan_due_days = _n("loan_due_days", 7, lo=0)
        self.loan_overdue_step_hours = _n("loan_overdue_step_hours", 24, lo=1)
        try:
            self.loan_overdue_rate = float(
                str(cfg.get("loan_overdue_rate", "0.05")).strip() or "0.05")
        except Exception:
            self.loan_overdue_rate = 0.05
        if self.loan_overdue_rate < 0:
            self.loan_overdue_rate = 0
        self.loan_deadbeat_days = _n("loan_deadbeat_days", 0, lo=0)
        _tag = str(cfg.get("loan_deadbeat_tag", "") or "").strip()
        self.loan_deadbeat_tag = _tag or "🐍 老赖"
        self.loan_overdue_notice = _bool_cfg("loan_overdue_notice", True)
        # ★ 1.7.6：钱包不够时自动从银行扣
        self.use_bank_pay = _bool_cfg("use_bank_pay", True)

        # ---------- 抢银行（1.7.6）----------
        self.rob_enable = _bool_cfg("rob_enable", True)
        raw = str(cfg.get("rob_trigger_names", "抢银行,抢劫银行,打劫银行")
                  or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.rob_trigger_names = names if names else ["抢银行"]

        def _num_cfg(key, default, lo=None, hi=None, cast=int):
            try:
                v = cast(str(cfg.get(key, str(default))).strip() or str(default))
            except Exception:
                v = default
            if lo is not None:
                v = max(lo, v)
            if hi is not None:
                v = min(hi, v)
            return v

        self.rob_min = _num_cfg("rob_min", 1, lo=0)
        self.rob_max = _num_cfg("rob_max", 10000, lo=self.rob_min)
        self.rob_success_rate = _num_cfg("rob_success_rate", 5, lo=0, hi=100)
        self.rob_freeze_days = _num_cfg("rob_freeze_days", 3, lo=0)
        self.rob_fail_penalty_rate = _num_cfg(
            "rob_fail_penalty_rate", 0.5, lo=0.0, hi=1.0, cast=float)

        # ---------- 签到商店（1.7.6）----------
        self.shop_enable = _bool_cfg("shop_enable", True)
        for _k, _dft in (("shop_trigger_names", "签到商店,积分商店,商店"),
                         ("shop_buy_trigger_names", "购买商品,买商品"),
                         ("shop_save_trigger_names", "存入保险箱"),
                         ("shop_take_trigger_names", "取出保险箱"),
                         # ★★ 1.7.7：武器必须装备才生效
                         ("shop_equip_trigger_names", "启用武器,装备武器"),
                         ("my_equip_trigger_names", "我的装备,我的武器")):
            _raw = str(cfg.get(_k, _dft) or "").strip()
            _nm = [x.strip() for x in _raw.split(",") if x.strip()]
            setattr(self, _k, _nm if _nm else _dft.split(",")[:1])
        self.vault_steal_reduce = _num_cfg(
            "vault_steal_reduce", 15.0, lo=0.0, hi=100.0, cast=float)
        self.shop_defense_cap = _num_cfg(
            "shop_defense_cap", 60.0, lo=0.0, hi=100.0, cast=float)
        # ★★ 1.7.7：武器破保险箱
        self.vault_break_rate = _num_cfg(
            "vault_break_rate", 0.0, lo=0.0, hi=100.0, cast=float)
        self.vault_break_ratio = _num_cfg(
            "vault_break_ratio", 1.0, lo=0.0, hi=1.0, cast=float)
        self.vault_break_destroy = _bool_cfg("vault_break_destroy", False)
        # ★ 商店条目：从独立数据文件读（配置里的同名键可能只是只读摘要）
        self.shop_list = []
        _shop_raw = cfg.get("shop_list", [])
        if isinstance(_shop_raw, list):
            for _it in _shop_raw:
                if not isinstance(_it, dict):
                    continue
                _nm = str(_it.get("name", "")).strip()
                if not _nm:
                    continue
                try:
                    _pr = int(str(_it.get("price", "0")).strip() or "0")
                except Exception:
                    _pr = 0
                _row = {
                    "name": _nm,
                    "price": max(0, _pr),
                    "desc": str(_it.get("desc", "")).strip(),
                    "kind": str(_it.get("kind", "") or "weapon").strip()
                    or "weapon",
                }
                # ★★ 白名单：这些字段要原样带过去，否则会被静默丢弃。
                #   ★ 这里和 `_load_shop_from_store()` 里的白名单**必须一致** ——
                #     生产环境 main.py 会把 collections 灌进 cfg，于是走的是
                #     **这一条**路径，漏了字段就会出现「数据文件里有、
                #     运行时不生效」的怪现象（vault_break_rate /
                #     stamina_restore 都踩过这个坑）。
                for _bk in ("steal_bonus", "defense_bonus",
                            "vault_break_rate", "stamina_restore"):
                    _bv = _it.get(_bk)
                    if _bv not in (None, ""):
                        _row[_bk] = _bv
                _img = str(_it.get("img", "") or "").strip()
                if _img:
                    _row["img"] = _img
                self.shop_list.append(_row)
        # ★ 配置里的 shop_list 通常只是只读摘要 -> 从独立数据文件读真实数据
        if not self.shop_list:
            self._load_shop_from_store()
        if self.shop_list:
            logger.info(f"[checkin] 签到商店已加载：{len(self.shop_list)} 件商品")

        # ---------- 银行理财（1.7.6）----------
        self.fund_enable = _bool_cfg("fund_enable", True)
        for _k, _dft in (("fund_trigger_names", "理财,我的理财"),
                         ("fund_buy_names", "购买理财,买入理财,买理财"),
                         ("fund_sell_names", "取出理财,卖出理财,赎回理财")):
            _raw = str(cfg.get(_k, _dft) or "").strip()
            _nm = [x.strip() for x in _raw.split(",") if x.strip()]
            setattr(self, _k, _nm if _nm else _dft.split(",")[:1])
        self.fund_profit_max = _num_cfg(
            "fund_profit_max", 8.0, lo=0.0, hi=100.0, cast=float)
        self.fund_loss_max = _num_cfg(
            "fund_loss_max", 6.0, lo=0.0, hi=100.0, cast=float)

        # ---------- 抽奖（1.7.6）----------
        self.lottery_enable = _bool_cfg("lottery_enable", True)
        raw = str(cfg.get("lottery_trigger_names", "开始抽奖,抽奖") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.lottery_trigger_names = names if names else ["开始抽奖"]
        # ★★ 1.7.6：「全部抽奖」触发词（后台可自定义）
        _alr = str(cfg.get("lottery_all_trigger_names",
                           "全部抽奖,一键抽奖") or "").strip()
        _aln = [x.strip() for x in _alr.split(",") if x.strip()]
        self.lottery_all_trigger_names = _aln if _aln else ["全部抽奖"]

        def _int_cfg(key, default, lo=None, hi=None):
            try:
                v = int(str(cfg.get(key, str(default))).strip() or str(default))
            except Exception:
                v = default
            if lo is not None:
                v = max(lo, v)
            if hi is not None:
                v = min(hi, v)
            return v

        # ★ 1.7.6：指令**不带参数**，每次固定花 lottery_cost，
        #   奖品 0 ~ lottery_prize_max（下限固定 0，后台不用填）
        self.lottery_cost = _int_cfg("lottery_cost", 100, lo=1)
        self.lottery_prize_max = _int_cfg("lottery_prize_max", 500, lo=0)
        self.lottery_win_rate = _int_cfg("lottery_win_rate", 30, lo=0, hi=100)
        self.lottery_prize_min = 0
        # ★ 每日次数上限（0 = 不限）
        self.lottery_daily_limit = _int_cfg("lottery_daily_limit", 10, lo=0)

        # ---------- 奖池（1.7.6）----------
        self.pool_enable = _bool_cfg("lottery_pool_enable", True)
        _pr = str(cfg.get("lottery_pool_trigger_names", "参与抽奖,参与奖池")
                  or "").strip()
        _pn = [x.strip() for x in _pr.split(",") if x.strip()]
        self.pool_trigger_names = _pn if _pn else ["参与抽奖"]
        # ★★ 1.7.6：「全部抽奖」—— 一个指令把当天剩余机会全抽完
        _al = str(cfg.get("lottery_all_trigger_names", "全部抽奖,一键抽奖")
                  or "").strip()
        _an = [x.strip() for x in _al.split(",") if x.strip()]
        self.lottery_all_trigger_names = _an if _an else ["全部抽奖"]
        _qi = str(cfg.get("lottery_pool_info_names", "奖池,今日奖池")
                  or "").strip()
        _qn = [x.strip() for x in _qi.split(",") if x.strip()]
        self.pool_info_names = _qn if _qn else ["奖池"]
        self.pool_fee = _int_cfg("lottery_pool_fee", 500, lo=0)
        self.pool_slots = _int_cfg("lottery_pool_slots", 10, lo=1)
        self.pool_min = _int_cfg("lottery_pool_min", 1000, lo=0)
        self.pool_max = _int_cfg("lottery_pool_max", 10000, lo=self.pool_min)
        self.pool_timeout_hours = _num_cfg("lottery_pool_timeout_hours", 1.0,
                                           lo=0.0, cast=float)
        # ★ 每人每天参与轮数（0 = 不限）
        self.pool_per_day = _int_cfg("lottery_pool_per_day", 1, lo=0)

        self.group_mode = str(cfg.get("checkin_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = self._parse_lines(cfg.get("checkin_group_whitelist", ""))
        self.group_blacklist = self._parse_lines(cfg.get("checkin_group_blacklist", ""))

        # ★ 签到系统的群号黑名单：留空 = 所有群都生效；填了则这些群不生效
        #   统一为一个名单（作用于整个签到系统）。旧的 checkin_global_groups
        #   仍兼容读取，两个键的值会合并，避免升级丢配置。
        self.allowed_groups = _parse_gid_list(cfg.get("checkin_groups", ""))
        legacy_global = _parse_gid_list(cfg.get("checkin_global_groups", ""))
        if legacy_global:
            merged = list(self.allowed_groups)
            for g in legacy_global:
                if g not in merged:
                    merged.append(g)
            self.allowed_groups = merged

        # 子功能「单独群开关」：填了群号则只有这些群能用该子功能；留空 = 不限群
        self.feature_groups = {}
        for feat, key in self._FEATURE_GROUP_KEYS.items():
            raw = cfg.get(key, "")
            self.feature_groups[feat] = _parse_gid_list(raw)

        # ============ 坐骑配置 ============
        self.mount_enable = _bool_cfg("mount_enable", True)

        raw = str(cfg.get("mount_trigger_names", "坐骑,我的坐骑") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.mount_trigger_names = names if names else ["坐骑"]

        raw = str(cfg.get("mount_list_trigger_names", "坐骑列表,坐骑商店") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.mount_list_trigger_names = names if names else ["坐骑列表"]

        raw = str(cfg.get("mount_buy_trigger_names", "购买坐骑,买坐骑") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.mount_buy_trigger_names = names if names else ["购买坐骑"]

        mount_list_raw = cfg.get("mount_list", [])
        self.mount_list = []
        # ★ 1.7.6：后台配置里的 `mount_list` 可能只是**只读摘要文本**
        #   （旧版本会把「共 28 个坐骑」写进这个同名键），
        #   所以：
        #     ① 配置里是真数组 -> 用配置
        #     ② 配置里不是数组 / 解析不出东西 -> 回落**独立数据文件**
        if isinstance(mount_list_raw, list):
            for item in mount_list_raw:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name", "")).strip()
                try:
                    price = int(str(item.get("price", "0")).strip() or "0")
                except Exception:
                    price = 0
                desc = str(item.get("desc", "")).strip()
                if name:
                    _row = {
                        "name": name,
                        "price": max(0, price),
                        "desc": desc,
                    }
                    _img = str(item.get("img", "") or "").strip()
                    if _img:
                        _row["img"] = _img
                    # ★★ 1.7.6：保留后台的坐骑 BUFF 覆盖值
                    for _bk in ("steal_bonus", "rob_bonus"):
                        _bv = item.get(_bk)
                        if _bv not in (None, ""):
                            _row[_bk] = _bv
                    self.mount_list.append(_row)
        if not self.mount_list:
            self._load_mounts_from_store()
        if self.mount_list:
            logger.info(f"[checkin] 坐骑列表已加载：{len(self.mount_list)} 个")
        else:
            logger.warning("[checkin] 坐骑列表为空（配置与数据文件里都没有）")

        # ============ 打工配置 ============
        self.job_enable = _bool_cfg("job_enable", True)

        raw = str(cfg.get("job_trigger_names", "打工,干活") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.job_trigger_names = names if names else ["打工"]

        raw = str(cfg.get("job_info_trigger_names", "打工列表,工作列表,工种") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.job_info_trigger_names = names if names else ["打工列表"]

        # ★★ 1.7.6：「全部打工」触发词（一次把所有工种都打了）
        raw = str(cfg.get("job_all_trigger_names", "全部打工,一键打工") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.job_all_trigger_names = names if names else ["全部打工"]

        job_list_raw = cfg.get("job_list", [])
        self.job_list = []
        if isinstance(job_list_raw, list):
            for item in job_list_raw:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("name", "")).strip()
                try:
                    dur = int(str(item.get("duration_hours", "1")).strip() or "1")
                except Exception:
                    dur = 1
                try:
                    rmin = int(str(item.get("reward_min", "10")).strip() or "10")
                except Exception:
                    rmin = 10
                try:
                    rmax = int(str(item.get("reward_max", "100")).strip() or "100")
                except Exception:
                    rmax = 100
                if dur < 1:
                    dur = 1
                if rmin < 0:
                    rmin = 0
                if rmax < rmin:
                    rmax = rmin
                if name:
                    # ★★ 1.7.7：工种可**单独覆盖**体力消耗（留空用全局）
                    _smin, _smax = None, None
                    for _k, _set in (("stamina_min", "min"),
                                     ("stamina_max", "max")):
                        _v = item.get(_k)
                        if _v is None or str(_v).strip() == "":
                            continue
                        try:
                            _n = max(0, int(float(str(_v).strip())))
                        except Exception:
                            continue
                        if _set == "min":
                            _smin = _n
                        else:
                            _smax = _n
                    _row = {
                        "name": name,
                        "duration_hours": dur,
                        "reward_min": rmin,
                        "reward_max": rmax,
                    }
                    if _smin is not None:
                        _row["stamina_min"] = _smin
                    if _smax is not None:
                        _row["stamina_max"] = _smax
                    self.job_list.append(_row)

        raw = str(cfg.get("cmd_job_add_names", "添加工种,新增工种") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.cmd_job_add_names = names if names else ["添加工种"]

        raw = str(cfg.get("cmd_job_del_names", "删除工种,删工种") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.cmd_job_del_names = names if names else ["删除工种"]

        # ============ ★★ 1.7.7：体力系统 ============
        self.stamina_enable = _bool_cfg("stamina_enable", True)
        self.stamina_max = max(0, int(_num_cfg(
            "stamina_max", 100, lo=0, hi=100000, cast=int)))
        self.job_stamina_min = max(0, int(_num_cfg(
            "job_stamina_min", 1, lo=0, hi=100000, cast=int)))
        self.job_stamina_max = max(0, int(_num_cfg(
            "job_stamina_max", 5, lo=0, hi=100000, cast=int)))
        if self.job_stamina_max < self.job_stamina_min:
            self.job_stamina_min, self.job_stamina_max = (
                self.job_stamina_max, self.job_stamina_min)
        self.stamina_food_restore = max(0, int(_num_cfg(
            "stamina_food_restore", 30, lo=0, hi=100000, cast=int)))
        self.stamina_refill_per_hour = max(0, int(_num_cfg(
            "stamina_refill_per_hour", 10, lo=0, hi=100000, cast=int)))
        self.stamina_refill_min = max(0, int(_num_cfg(
            "stamina_refill_min", 5, lo=0, hi=100000, cast=int)))
        # 触发词本来就定义在模块函数里（见 `stamina_view_trigger_names`），
        # 热刷新时按同样的取法即可。
        for _k, _dft in (("stamina_view_trigger_names", "我的体力,体力"),
                         ("food_eat_trigger_names", "吃食物,吃东西"),
                         ("stamina_refill_menu_names", "加班功能"),
                         ("stamina_refill_trigger_names", "加班,一键冷却"),
                         ("stamina_refill_status_names", "加班状态"),
                         ("stamina_refill_all_names", "加班全部,加班 all")):
            _raw = str(cfg.get(_k, _dft) or "").strip()
            _nm = [x.strip() for x in _raw.split(",") if x.strip()]
            setattr(self, _k, _nm if _nm else _dft.split(",")[:1])

        raw = str(cfg.get("cmd_mount_add_names", "添加坐骑,新增坐骑") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.cmd_mount_add_names = names if names else ["添加坐骑"]

        raw = str(cfg.get("cmd_mount_del_names", "删除坐骑,删坐骑") or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.cmd_mount_del_names = names if names else ["删除坐骑"]

        # ★ 1.7.6：装备坐骑 / 坐骑查看（都是「指令 + 坐骑名」）
        raw = str(cfg.get("mount_equip_names", "装备坐骑,骑乘坐骑")
                  or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.mount_equip_names = names if names else ["装备坐骑"]

        raw = str(cfg.get("mount_view_names", "坐骑查看,查看坐骑")
                  or "").strip()
        names = [x.strip() for x in raw.split(",") if x.strip()]
        self.mount_view_names = names if names else ["坐骑查看"]

        # ★★ 市场版：坐骑图片素材目录已移除
        self.mount_img_dir = ""

        # ★ 1.7.6：每天第一句话的登场提示
        self.mount_greet_enable = _bool_cfg("mount_greet_enable", True)
        _gt = str(cfg.get("mount_greet_text", "") or "")
        self.mount_greet_text = (_gt.strip()
                                 or "🌟 $name 骑着「$mount」闪亮登场！")
        # ★ 1.7.6：reload 后指令名可能变了，重新登记一遍
        self._register_cmd_names()

    @staticmethod
    def _parse_lines(raw) -> list:
        """
        解析多行配置项，返回去重后的列表。
        同时支持换行、英文逗号、中文逗号、顿号、分号分隔（原来只支持换行，
        导致填成 "3001,3009" 会被当成一个无效项，白名单直接失效）。
        忽略空行与 # 注释行。
        """
        if not raw:
            return []
        if isinstance(raw, list):
            parts = []
            for it in raw:
                if isinstance(it, str):
                    parts.append(it)
        else:
            parts = [str(raw)]

        out, seen = [], set()
        for chunk in parts:
            for line in chunk.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                for piece in _re.split(r"[,，、;；]+", line):
                    item = piece.strip()
                    if item and item not in seen:
                        seen.add(item)
                        out.append(item)
        return out

    # 子功能标识 -> 后台「单独群开关」配置键
    _FEATURE_GROUP_KEYS = {
        "checkin": "checkin_groups",
        "steal": "steal_groups",
        "bank": "bank_groups",
        "mount": "mount_groups",
        "job": "job_groups",
        # ★ 1.7.6：抽奖功能（黑名单：填了群号 = 该群不触发）
        "lottery": "lottery_groups",
        # ★ 1.7.6：抢银行（黑名单：填了群号 = 该群不触发）
        "rob": "rob_groups",
        # ★ 1.7.6：奖池（黑名单：填了群号 = 该群不触发）
        "lottery_pool": "lottery_pool_groups",
        # ★ 1.7.6：签到商店（黑名单：填了群号 = 该群不触发）
        "shop": "shop_groups",
    }

    def _is_group_allowed(self, group_id: str, feature: str = "") -> bool:
        """
        群过滤（**黑名单语义**）：
          ① 全局群号（checkin_global_groups）：留空 = 所有群都生效；填了则这些群不生效
          ② 子功能群号（各功能单独群号）：留空 = 所有群都生效；填了则这些群不生效
        两个条件只要命中任一条黑名单，该群就不生效。
        旧的黑/白名单配置在未填新群号时仍然生效（向后兼容）。
        """
        if not group_id:
            return True
        gid = str(group_id)
        # ① 全局群号黑名单
        if self.allowed_groups:
            if gid in self.allowed_groups:
                return False
        elif self.group_mode == "whitelist":
            if gid not in self.group_whitelist:
                return False
        elif self.group_mode == "blacklist":
            if gid in self.group_blacklist:
                return False
        # ② 子功能群号黑名单（配了才生效）
        if feature:
            gids = self.feature_groups.get(feature)
            if gids and gid in gids:
                return False
        return True

    def _load(self):
        if not os.path.exists(self.data_path):
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f) or {}
            self.users = data.get("users", {}) or {}
            self.daily = data.get("daily", {}) or {}
            self.speaks = data.get("speaks", {}) or {}
            self.robs = data.get("robs", {}) or {}
            self.lotteries = data.get("lotteries", {}) or {}
            self.pools = data.get("pools", {}) or {}
            self.mount_greet = data.get("mount_greet", {}) or {}
            self.last_interest_date = data.get("last_interest_date", "") or ""
            self._migrate_to_per_group()
        except Exception:
            logger.exception("[checkin] 读取失败")

    # ============================================================
    # 按群隔离（★ 排行榜/积分/银行等全部每群独立）
    #   数据结构：users = {群号: {用户号: 记录}}
    #            daily = {群号: {日期: {用户号: 记录}}}
    #   旧数据（扁平结构）自动迁移到「默认群」下，不丢数据
    # ============================================================
    DEFAULT_GROUP = "__default__"

    @staticmethod
    def _looks_nested(mapping) -> bool:
        """判断是否是新的「按群嵌套」结构"""
        if not isinstance(mapping, dict) or not mapping:
            return False
        for k, v in mapping.items():
            if isinstance(k, str) and k.isdigit() and isinstance(v, dict):
                return True
        return False

    def _migrate_to_per_group(self):
        """把旧的扁平数据搬到默认群下（幂等）"""
        if self.users and not self._looks_nested(self.users):
            self.users = {self.DEFAULT_GROUP: self.users}
            self._need_save = True
        if self.daily and not self._looks_nested(self.daily):
            self.daily = {self.DEFAULT_GROUP: self.daily}
            self._need_save = True
        # robs 与 daily 同构：{群号: {日期: {用户: {...}}}}
        if self.robs and not self._looks_nested(self.robs):
            self.robs = {self.DEFAULT_GROUP: self.robs}
            self._need_save = True
        # lotteries 同构
        if self.lotteries and not self._looks_nested(self.lotteries):
            self.lotteries = {self.DEFAULT_GROUP: self.lotteries}
            self._need_save = True
        # pools 同构
        if self.pools and not self._looks_nested(self.pools):
            self.pools = {self.DEFAULT_GROUP: self.pools}
            self._need_save = True
        # speaks 旧结构：{日期: {用户: 次数}} -> {群号: {日期: {用户: 次数}}}
        if self.speaks:
            first_key = next(iter(self.speaks.keys()), "")
            is_day_key = bool(_re.match(r"^\d{4}-\d{2}-\d{2}$", str(first_key)))
            if is_day_key:
                self.speaks = {self.DEFAULT_GROUP: self.speaks}
                self._need_save = True

    @staticmethod
    def _gid(group_id) -> str:
        g = str(group_id or "").strip()
        return g if g else CheckinModule.DEFAULT_GROUP

    def _gusers(self, group_id) -> dict:
        """取某群的用户记录表（引用，可直接改）"""
        gid = self._gid(group_id)
        bucket = self.users.get(gid)
        if not isinstance(bucket, dict):
            bucket = {}
            # 旧数据尚未迁移时（首群创建），把已迁移的默认群留住
            self.users.setdefault(gid, bucket)
            bucket = self.users[gid]
        return bucket

    def _gdaily(self, group_id) -> dict:
        """取某群的签到日记表（引用，可直接改）"""
        gid = self._gid(group_id)
        bucket = self.daily.get(gid)
        if not isinstance(bucket, dict):
            self.daily.setdefault(gid, {})
            bucket = self.daily[gid]
        return bucket

    def _gspeaks(self, group_id) -> dict:
        """取某群的发言日记表（引用，可直接改）"""
        gid = self._gid(group_id)
        bucket = self.speaks.get(gid)
        if not isinstance(bucket, dict):
            self.speaks.setdefault(gid, {})
            bucket = self.speaks[gid]
        return bucket

    def _guser(self, group_id, user_id) -> dict:
        """取某群某人的记录（不存在返回空 dict，不改数据）"""
        u = self._gusers(group_id).get(str(user_id))
        return u if isinstance(u, dict) else {}

    def _guser_setdefault(self, group_id, user_id, default: dict) -> dict:
        """取某群某人的记录，不存在则用 default 创建"""
        bucket = self._gusers(group_id)
        uid = str(user_id)
        u = bucket.get(uid)
        if not isinstance(u, dict):
            u = dict(default)
            bucket[uid] = u
        return u

    def _all_group_users(self, group_id) -> list:
        """某群所有用户记录，[{uid, ...}]"""
        return [(uid, u) for uid, u in self._gusers(group_id).items()
                if isinstance(u, dict)]

    def _grob(self, group_id) -> dict:
        """某群的抢银行记录：{日期起点: {用户号: {...}}}"""
        gid = self._gid(group_id)
        bucket = self.robs.get(gid)
        if not isinstance(bucket, dict):
            self.robs.setdefault(gid, {})
            bucket = self.robs[gid]
        return bucket

    def _day_start(self) -> int:
        """今天 0 点的时间戳（抢银行「每天一次」用）"""
        try:
            lt = time.localtime()
            return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday,
                                    0, 0, 0, 0, 0, -1)))
        except Exception:
            return int(time.time()) // 86400 * 86400

    def _set_rec_name(self, group_id, user_id, name: str):
        """记录某人最近昵称（每群一份，仅用于本群显示兜底）"""
        if not name:
            return
        u = self._gusers(group_id).get(str(user_id))
        if isinstance(u, dict):
            u["name"] = str(name)

    def _save(self):
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({
                    "users": self.users,
                    "daily": self.daily,
                    "speaks": self.speaks,
                    "robs": self.robs,
                    "lotteries": self.lotteries,
                    "pools": self.pools,
                    # ★ 1.7.6：每天「坐骑登场」只提示一次 -> 记录当天是否已提示
                    "mount_greet": getattr(self, "mount_greet", {}) or {},
                    "last_interest_date": self.last_interest_date,
                }, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
            self._need_save = False
        except Exception:
            logger.exception("[checkin] 保存失败")


    def match_trigger(self, text: str) -> bool:
        if not self.enable:
            return False
        for name in self.trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_rank_trigger(self, text: str) -> bool:
        """
        ★ 1.7.6：旧的「签到排行」指令**已删除**。

        排行榜拆成了三条独立指令（签到次数 / 总财富 / 负债），
        见 `match_rank_kind`。这里保留方法（永远 False）以免旧调用报错。
        """
        return False

    def match_rank_kind(self, text: str, kind: str):
        """
        1.7.6：三种独立排行榜的指令匹配。

        kind: "count"（签到次数）/ "wealth"（总财富）/ "debt"（负债）
        命中返回 True；未启用或未命中返回 False。
        """
        if not self.enable:
            return False
        names = {
            "count": getattr(self, "rank_count_names", None),
            "wealth": getattr(self, "rank_wealth_names", None),
            "debt": getattr(self, "rank_debt_names", None),
        }.get(kind) or []
        for name in names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_info_trigger(self, text: str):
        if not self.enable:
            return None
        for name in self.info_trigger_names:
            if text == name or text == f"/{name}":
                return ("self",)
            _carg = cmd_arg(text, self.info_trigger_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return ("target", arg)
                    return ("self",)
        return None

    def match_steal_trigger(self, text: str):
        if not self.enable or not self.steal_enable:
            return None
        for name in self.steal_trigger_names:
            if text == name or text == f"/{name}":
                return ("self",)
            _carg = cmd_arg(text, self.steal_trigger_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return ("target", arg)
                    return ("self",)
        return None


    # ---------- 作弊指令：加积分 / 减积分（管理员专用）----------
    # ★ 指令名后面允许「直接粘参数」：AstrBot 拼接消息段时会吃掉空格，
    #   例：加积分 10000   -> msg_str 变成 '加积分10000'
    #       加积分 @某人 100 -> '加积分@铁剑娘(1142479412)100'
    #   以前只认「名称 + 空格」，导致粘连写法完全不触发。
    _SCORE_SUFFIX_RE = _re.compile(r"^(\d|@|\[At:|\uff08|\()")

    def _match_score_cmd(self, text: str, names):
        """
        返回 ("help", "") / ("target", "参数") / None
          · 只发指令名              -> 提示用法
          · 指令名 + 参数（可粘连）  -> 交给上层解析
        """
        t = str(text or "").strip()
        if not t:
            return None
        for name in names or []:
            if not name:
                continue
            if t == name or t == f"/{name}":
                return ("help", "")
            # ① 标准写法：名称 + 空格 + 参数
            for pref in (name + " ", f"/{name} "):
                if t.startswith(pref):
                    return ("target", t[len(pref):].strip())
            # ② 粘连写法：名称后面直接跟数字 / @ / [At: / 括号
            for pref in (name, f"/{name}"):
                if not t.startswith(pref):
                    continue
                rest = t[len(pref):]
                if rest and self._SCORE_SUFFIX_RE.match(rest):
                    return ("target", rest.strip())
        return None

    def match_score_add(self, text: str):
        return self._match_score_cmd(text, self.score_add_trigger_names)

    def match_score_sub(self, text: str):
        return self._match_score_cmd(text, self.score_sub_trigger_names)

    # ------------------------------------------------------------
    # ★★ 1.7.7：清空群员财富（管理员）
    # ------------------------------------------------------------
    def match_wipe_wealth(self, text: str):
        """
        「清空财富 @某人」/「清空财富 QQ号」—— 命中返回参数字符串，
        未命中返回 None。

        ★ 用**完全相等或前缀 + 参数**判定，不做模糊匹配 ——
          这是**不可撤销**的破坏性指令，绝不能误触。
        """
        if not self.enable:
            return None
        t = str(text or "").strip()
        for name in (getattr(self, "wipe_wealth_trigger_names", None)
                     or ["清空财富"]):
            name = str(name or "").strip()
            if not name:
                continue
            if t == name or t == f"/{name}":
                return ""
            if t.startswith(name):
                _rest = t[len(name):].strip()
                if _rest:
                    return _rest
        return None

    def do_wipe_wealth(self, event, arg: str = "") -> str:
        """
        ★★ 1.7.7：**清空某群员的全部财富**（管理员，不可撤销）。

        清掉什么：
          · 钱包 `total_score` → 0
          · 银行 `bank` → 0
          · 保险箱 `vault_money` → 0（保险箱本身保留）
          · 欠款清零（含逾期罚息 / 老赖标签）
          · 理财本金 → 0
          · 积分调整类记录（打卡日榜保留，签到次数保留）

        ★ **不删人**：签到次数 / 连签 / 坐骑 / 武器 / 食物 / 打工冷却
          全部保留 —— 只清「财富」，不是把人重置成新号。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        _cmd = (getattr(self, "wipe_wealth_trigger_names", None)
                or ["清空财富"])[0]

        # ① 定位目标：优先参数里的 QQ / @，其次消息里的 @
        qq = ""
        _raw = str(arg or "").strip()
        try:
            _q, _amt, _err = self.parse_score_args(_raw)
            qq = str(_q or "")
        except Exception:
            qq = ""
        if not qq:
            try:
                _ats = _get_ats_from_msg(event) or []
                if _ats:
                    qq = str(_ats[0])
            except Exception:
                pass
        # 参数里直接给纯数字 QQ
        if not qq:
            _m = _re.search(r"\d{5,12}", _raw)
            if _m:
                qq = _m.group(0)
        if not qq:
            return "\n".join([
                f"{title_bar('清空财富')}",
                "⚠️ 要指定 QQ",
                f"用法：「{_cmd} @某人」或「{_cmd} QQ号」",
            ])

        u = self._guser(group_id, qq)
        if not isinstance(u, dict) or not u:
            return "\n".join([
                f"{title_bar('清空财富')}",
                f"⚠️ QQ {qq} 在本群没有签到记录",
            ])

        # ★★ 1.7.7：显示名统一过 `_nick_display`（长名字用省略号，
        #   别把回执行撑宽 —— 和排行榜同一个口径）
        _nick = u.get("name") or self._nick_of(group_id, qq)
        try:
            _nick = _nick_display(str(_nick))
        except Exception:
            _nick = str(_nick)
        _before = {
            "钱包": int(u.get("total_score", 0) or 0),
            "银行": int(u.get("bank", 0) or 0),
            "保险箱": int(u.get("vault_money", 0) or 0),
            "欠款": self._loan_of(u),
        }
        _fund = 0
        try:
            _f = u.get("fund")
            if isinstance(_f, dict):
                _fund = int(_f.get("principal", 0) or 0)
                _f["principal"] = 0
                _f["total_pnl"] = 0
        except Exception:
            logger.debug("[checkin] 清理财失败", exc_info=True)

        # ② 清零
        u["total_score"] = 0
        u["bank"] = 0
        u["vault_money"] = 0
        for _k in ("loan", "loan_principal", "loan_due", "loan_overdue",
                   "loan_overdue_count", "deadbeat", "loan_deadbeat",
                   "loan_interest"):
            if _k in u:
                u[_k] = 0 if not isinstance(u[_k], str) else ""
        self._save()
        logger.info("[checkin] %s 清空了 %s(%s) 的财富：%s",
                    get_user_name(event) or get_user_id(event),
                    _nick, qq, _before)

        lines = [
            f"{title_bar('清空财富')}",
            f"👤 目标：{_nick}（QQ {qq}）",
            "",
            "💸 已清零：",
            f"　 · 钱包：{fmt_num(_before['钱包'])} → 0",
            f"　 · 银行：{fmt_num(_before['银行'])} → 0",
        ]
        if _before["保险箱"] > 0:
            lines.append(f"　 · 保险箱：{fmt_num(_before['保险箱'])} → 0"
                         "（保险箱本身保留）")
        if _before["欠款"] > 0:
            lines.append(f"　 · 欠款：{fmt_num(_before['欠款'])} → 0")
        if _fund > 0:
            lines.append(f"　 · 理财本金：{fmt_num(_fund)} → 0")
        lines += [
            "",
            "✅ 完成（不可撤销）",
            "💡 签到次数 / 连签 / 坐骑 / 武器 / 食物 / 打工冷却**都保留**",
        ]
        return "\n".join(lines)

    @staticmethod
    def parse_score_args(raw: str):
        """
        解析「加积分/减积分」的参数，写法随意：
            @某人 100            -> 目标由 @ 决定，数量 100
            @铁剑娘(1142479412) 100 -> 目标 1142479412，数量 100
            100 @某人            -> 数量 100
            @某人 100 200        -> 数量 200（取最后一个数字）
            QQ号 100             -> 目标 QQ号，数量 100
            100                  -> 数量 100（目标由 @ 或本人决定）

        返回 (target_qq, amount, error)
          · target_qq 只在参数里能定位到 QQ 时才有值
          · 目标优先由调用方从消息的 @ 里取
          · 昵称里带数字不会误判成 QQ（只有 5~12 位纯数字段才算）
        """
        text = str(raw or "").strip()
        if not text:
            return "", None, ""

        # ① 先摘掉「@昵称(QQ号)」这类 @ 写法，取出 QQ，
        #    剩下的部分再找数量（避免把 QQ 当数量、或把数量当 QQ）
        qq = ""
        body = text
        m_at = _AT_INLINE_RE.search(body)
        if m_at:
            qq = m_at.group(1)
            body = (body[:m_at.start()] + " " + body[m_at.end():]).strip()

        # ② 剩下的部分里抓数字
        nums = [m.group(0) for m in _re.finditer(r"\d+", body)]

        amount = None
        if qq:
            # 目标已确定：数量取最后一个数字
            if nums:
                try:
                    amount = int(nums[-1])
                except Exception:
                    amount = None
            return qq, amount, "" if amount is not None else "no_number"

        if not nums:
            # 只有 @、没有数字
            if m_at:
                return qq, None, "no_number"
            return "", None, "no_number"

        # ③ 没有「@昵称(QQ)」写法：按原来规则区分 QQ 号与数量
        for i, val in enumerate(nums):
            is_qq_len = 5 <= len(val) <= 12
            if is_qq_len and i < len(nums) - 1 and not qq:
                qq = val
                continue
            try:
                amount = int(val)
            except Exception:
                amount = None
        if amount is None and qq:
            amount = int(qq)
            qq = ""
        return qq, amount, ""

    def do_score_adjust(self, group_id, target_qq: str, amount,
                        delta: int = 1, operator: str = "") -> str:
        """
        给某人加/减积分（管理员专用，调用方负责鉴权）。
        delta = +1 加，-1 减。减到负数会截断为 0。
        """
        cmd = (self.score_add_trigger_names or ["加积分"])[0] if delta >= 0 \
            else (self.score_sub_trigger_names or ["减积分"])[0]
        if not target_qq:
            return (f"⚠️ 请指定要调整的人：@某人 或 直接写 QQ号\n"
                    f"用法：「{cmd} @某人 100」或「{cmd} QQ号 100」")
        try:
            amt = int(amount)
        except Exception:
            amt = None
        if amt is None or amt <= 0:
            return (f"⚠️ 请给出要{'增加' if delta >= 0 else '减少'}的{self._sn()}数量（正整数）\n"
                    f"用法：「{cmd} @某人 100」")

        target_qq = str(target_qq).strip()
        u = self._guser_setdefault(group_id, target_qq, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        before = int(u.get("total_score", 0))
        if delta >= 0:
            after = before + amt
            u["total_score"] = after
            sign = f"+{amt}"
            verb = "增加"
        else:
            # ★ 1.7.6：允许扣成负数（负债），不再截断到 0
            after = before - amt
            sign = f"-{amt}"
            verb = "减少"
            u["total_score"] = after
        try:
            self._set_rec_name(group_id, target_qq)
        except Exception:
            pass
        self._save()

        lines = [
            f"{title_bar('{self._sn()}调整')}",
            f"🎯 目标：QQ {target_qq}",
            f"{'➕' if delta >= 0 else '➖'} {verb}{self._sn()}：{sign}",
            f"💰 调整前：{before}",
            f"💳 调整后：{after}",
        ]
        if after < 0:
            lines.append("⚠️ 已扣成负债（净值会相应变低）")
        if operator:
            lines.append(f"🔧 操作者：{operator}")
        return "\n".join(lines)

    # ------------------------------------------------------------
    # 积分直接增减（供其它玩法调用，如猜拳）
    # ------------------------------------------------------------
    # ------------------------------------------------------------
    # 积分显示名称
    # ------------------------------------------------------------
    def _sn(self) -> str:
        """当前积分显示名（内部快捷方式，避免到处写 self.score_label()）"""
        return self.score_label()

    def score_label(self, prefix: str = "") -> str:
        """积分显示名（后台可自定义，如「金币」）"""
        nm = str(getattr(self, "score_name", "") or "").strip() or "积分"
        return f"{prefix}{nm}"

    def score_text(self, value, prefix: str = "") -> str:
        """「金币：1000」这种带名称的显示"""
        return f"{self.score_label(prefix)}{value}"

    def get_score(self, group_id, uid) -> int:
        """读某人当前积分（不存在返回 0）"""
        try:
            u = self._guser(group_id, str(uid))
            return int(u.get("total_score", 0))
        except Exception:
            return 0

    def add_score(self, group_id, uid, delta, allow_negative: bool = True,
                  nick: str = "") -> int:
        """
        直接给某人加/减积分，返回**调整后**的积分。

        ★ 与 do_score_adjust 的区别：
          · do_score_adjust 是管理员指令，只接受正数并按方向加减，
            且减到 0 就截断；
          · 这个接口接受**带符号**的 delta（可正可负），
            `allow_negative=True` 时允许扣成负分（签到系统支持负数）。
        调用方负责保存与鉴权。
        """
        try:
            d = int(delta)
        except Exception:
            d = 0
        try:
            u = self._guser_setdefault(group_id, str(uid), {
                "total_score": 0, "total_checkin": 0, "last_date": "",
                "streak": 0, "month_map": {}, "bank": 0,
            })
            before = int(u.get("total_score", 0))
            after = before + d
            if not allow_negative and after < 0:
                after = 0
            u["total_score"] = after
            if nick:
                try:
                    u["name"] = str(nick)
                except Exception:
                    pass
            try:
                self._set_rec_name(group_id, str(uid))
            except Exception:
                pass
            try:
                self._save()
            except Exception:
                pass
            return after
        except Exception:
            logger.exception("[checkin] add_score 失败")
            return 0

    # ------------------------------------------------------------
    # 负债 / 借款（1.7.6）
    # ------------------------------------------------------------
    def _loan_of(self, u) -> int:
        """某人的欠款（本金 + 已计利息），不存在返回 0"""
        try:
            return max(0, int((u or {}).get("loan", 0) or 0))
        except Exception:
            return 0

    def get_loan(self, group_id, uid) -> int:
        """对外：读某人欠款"""
        try:
            return self._loan_of(self._guser(group_id, str(uid)))
        except Exception:
            return 0

    def net_worth(self, group_id, uid) -> int:
        """
        可用资金 = 钱包 + 银行 − 欠款（可为负）。

        ★ 花钱看的是这个：钱包不够会自动从银行扣（use_bank_pay=True 时），
          所以「银行里的钱」也算可用资金。
        """
        try:
            u = self._guser(group_id, str(uid)) or {}
        except Exception:
            return 0
        try:
            wallet = int(u.get("total_score", 0))
        except Exception:
            wallet = 0
        try:
            bank = int(u.get("bank", 0) or 0)
        except Exception:
            bank = 0
        return wallet + bank - self._loan_of(u)

    def avail_funds(self, group_id, uid) -> int:
        """
        实际可用于消费的金额（钱包 + 银行，不减欠款）。

        ★ net_worth 减了欠款，用来判断「有没有钱」；
          而真正扣款时，欠款不能当钱花，所以可用额度是钱包 + 银行。
        """
        try:
            u = self._guser(group_id, str(uid)) or {}
        except Exception:
            return 0
        try:
            wallet = int(u.get("total_score", 0))
        except Exception:
            wallet = 0
        try:
            bank = int(u.get("bank", 0) or 0)
        except Exception:
            bank = 0
        return wallet + bank

    def pay(self, group_id, uid, amount: int, allow_bank: bool = True):
        """
        ★ 统一扣款，**先扣钱包，钱包不够再从银行扣**。

        allow_bank=False（或全局 use_bank_pay 关掉）时只扣钱包，可扣成负债。

        ★★ 1.7.7：**这个方法永远不碰保险箱**。
          保险箱只在「偷积分成功时从对方那里拿钱」的那条链路里
          当作目标池（钱包 → 银行 → 保险箱），它不是**付款**来源。
          所以赔付、买东西、抽奖、坐骑、抢银行罚金都动不了保险箱。

        返回 dict：
          ok       是否扣得起
          need     需要多少
          wallet   扣前钱包
          bank     扣前银行
          from_wallet / from_bank  各自扣了多少
          short    还差多少（ok=False 时有值）
          u        用户记录（ok=True 时已被修改，调用方负责 _save）

        ★ 只负责改内存 + 返回结果，**不调 _save**，
          让调用方在整笔业务改完后再一次性保存。
        """
        try:
            need = int(amount)
        except Exception:
            need = 0
        u = self._guser_setdefault(group_id, str(uid), {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        try:
            wallet = int(u.get("total_score", 0))
        except Exception:
            wallet = 0
        try:
            bank = int(u.get("bank", 0) or 0)
        except Exception:
            bank = 0
        if need <= 0:
            return {"ok": True, "need": 0, "wallet": wallet, "bank": bank,
                    "from_wallet": 0, "from_bank": 0, "short": 0, "u": u}

        _use_bank = bool(allow_bank) and bool(
            getattr(self, "use_bank_pay", True))
        from_wallet = 0
        from_bank = 0
        rest = need
        if _use_bank:
            # ① 先扣钱包（能出多少出多少）
            take_w = min(max(0, wallet), rest)
            from_wallet = take_w
            rest -= take_w
            # ② 再从银行扣
            if rest > 0:
                take_b = min(max(0, bank), rest)
                from_bank = take_b
                rest -= take_b
        else:
            # 没开自动用银行：只动钱包（可以扣成负数 = 负债）
            from_wallet = rest
            rest = 0
        ok = (rest <= 0)
        if ok:
            u["total_score"] = wallet - from_wallet
            u["bank"] = bank - from_bank
        return {"ok": ok, "need": need, "wallet": wallet, "bank": bank,
                "from_wallet": from_wallet, "from_bank": from_bank,
                "short": max(0, rest), "u": u}

    def pay_note(self, r: dict) -> str:
        """把 pay() 的结果拼成一行说明（用于购买成功回执）"""
        try:
            fw = int(r.get("from_wallet", 0))
            fb = int(r.get("from_bank", 0))
        except Exception:
            return ""
        _parts = []
        if fw > 0:
            _parts.append(f"钱包 -{fw}")
        if fb > 0:
            _parts.append(f"银行 -{fb}")
        if not _parts:
            return f"💸 花费：-{r.get('need')} {self._sn()}"
        return (f"💸 花费：-{r.get('need')} {self._sn()}"
                f"（{'，'.join(_parts)}）")

    def short_hint(self, group_id, uid, need: int) -> str:
        """
        买不起时的提示：算出还差多少，引导去借款。

        ★★ 1.7.7：默认**不算保险箱**（保险箱只在偷积分里当资金来源）；
          偷积分那条路自己会带上保险箱额度。
        """
        _u = None
        try:
            _u = self._guser(group_id, str(uid))
        except Exception:
            _u = None
        wallet = int((_u or {}).get("total_score", 0) or 0)
        bank = int((_u or {}).get("bank", 0) or 0)
        avail = wallet + bank
        lines = [
            f"⚠️ {self._sn()}不足",
            f"💰 需要：{need} {self._sn()}",
            f"💳 当前：钱包 {fmt_num(wallet)} + 银行 {fmt_num(bank)} = {fmt_num(avail)} {self._sn()}",
        ]
        short = max(0, int(need) - avail)
        if short:
            lines.append(f"📉 还差：{short} {self._sn()}")
        _loan = self._loan_of(_u)
        if _loan > 0:
            lines.append(f"（另有欠款 {fmt_num(_loan)}，净值 {fmt_num(avail - _loan)}）")
        _h = self.loan_hint()
        if _h:
            lines += ["", _h]
        return "\n".join(lines)

    def total_assets(self, u) -> int:
        """总资产 = 钱包 + 银行 - 欠款（排行用）"""
        try:
            wallet = int((u or {}).get("total_score", 0) or 0)
        except Exception:
            wallet = 0
        try:
            bank = int((u or {}).get("bank", 0) or 0)
        except Exception:
            bank = 0
        return wallet + bank - self._loan_of(u)

    def loan_hint(self) -> str:
        """负债/余额不足时的统一提示：引导去银行借款"""
        if not self.loan_enable:
            return ""
        cmd = (self.loan_trigger_names or ["借款"])[0]
        return (f"💡 {self._sn()}不够了？可以找银行借：「{cmd} 数量」\n"
                f"　 （利息 {self.loan_interest_rate * 100:.0f}%，"
                f"单次上限 {self.loan_max}）")

    def match_loan_trigger(self, text: str):
        """
        「借款 100」/「借款」（不带数量=借上限）

        返回 (mode, arg)；不命中返回 None。
        """
        if not self.enable or not self.bank_enable or not self.loan_enable:
            return None
        for name in self.loan_trigger_names:
            if text == name or text == f"/{name}":
                return ("amount", "")
            _carg = cmd_arg(text, self.loan_trigger_names)
            if _carg is not None:
                    return ("amount", _carg)
        return None

    def match_repay_trigger(self, text: str):
        """「还款 100」/「还款 all」"""
        if not self.enable or not self.bank_enable or not self.loan_enable:
            return None
        for name in self.loan_repay_names:
            if text == name or text == f"/{name}":
                return ("amount", "")
            _carg = cmd_arg(text, self.loan_repay_names)
            if _carg is not None:
                    return ("amount", _carg)
        return None

    def match_loan_info_trigger(self, text: str) -> bool:
        """「我的借款」/「欠款」"""
        if not self.enable or not self.bank_enable or not self.loan_enable:
            return False
        for name in self.loan_info_names:
            if text == name or text == f"/{name}":
                return True
        return False

    # ------------------------------------------------------------
    # 抽奖（1.7.6）
    # ------------------------------------------------------------
    def match_lottery_trigger(self, text: str):
        """
        「开始抽奖」——**不带参数**。

        ★ 每次花多少由后台 `lottery_cost` 决定，所以这里只认纯指令；
          带参数（如「开始抽奖 200」）不命中，会落到别的规则上去。
        命中返回 True（与其它 match_* 的约定不同，这里没有参数）。
        """
        if not self.enable or not self.lottery_enable:
            return False
        for name in self.lottery_trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_lottery_all_trigger(self, text: str) -> bool:
        """
        「全部抽奖」—— **一个指令把当天剩余机会全抽完**（1.7.6 新增）。

        ★ 不带参数；触发词由后台 `lottery_all_trigger_names` 自定义。
        """
        if not self.enable or not self.lottery_enable:
            return False
        t = str(text or "").strip()
        for name in (getattr(self, "lottery_all_trigger_names", None)
                     or ["全部抽奖"]):
            if t == name or t == f"/{name}":
                return True
        return False

    def match_bank_trigger(self, text: str) -> bool:
        if not self.enable or not self.bank_enable:
            return False
        for name in self.bank_trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_deposit_trigger(self, text: str):
        if not self.enable or not self.bank_enable:
            return None
        for name in self.bank_deposit_names:
            _carg = cmd_arg(text, self.bank_deposit_names)
            if _carg is not None:
                    arg = _carg
                    return ("amount", arg) if arg else ("amount", "")
            if text == name or text == f"/{name}":
                return ("amount", "")
        return None

    # ============================================================
    # 发言统计
    # ============================================================
    def match_withdraw_trigger(self, text: str):
        if not self.enable or not self.bank_enable:
            return None
        for name in self.bank_withdraw_names:
            _carg = cmd_arg(text, self.bank_withdraw_names)
            if _carg is not None:
                    arg = _carg
                    return ("amount", arg) if arg else ("amount", "")
            if text == name or text == f"/{name}":
                return ("amount", "")
        return None

    # ============================================================
    # 坐骑匹配
    # ============================================================
    def match_mount_trigger(self, text: str):
        """
        「我的坐骑」：只列**已拥有**的坐骑（1.7.6 起支持翻页）。

        返回 ("info", page)；page 从 1 开始（不带参数 = 第 1 页）。

        ★★ 1.7.6 修：以前把 `cmd_arg(...)` 写在 `for name in ...` 循环**里**，
          而 `cmd_arg` 内部会遍历**全部**名字。于是发 `坐骑列表` 时：
          第一次循环（name='坐骑'）就命中 `cmd_arg('坐骑列表', ['坐骑','我的坐骑'])`
          ——「坐骑」后面接「列表」被当成**无空格参数** → 返回 ("info", 1)，
          把「坐骑列表」（可购买列表）整个吃掉了（用户反馈的 bug）。
          现在：① 先比「纯指令名」；② `cmd_arg` 只调一次。
        """
        if not self.enable or not self.mount_enable:
            return None
        t = str(text or "").strip()
        # ① 纯指令名（含前导 /）—— 必须优先，否则会被参数规则吃掉
        for name in self.mount_trigger_names:
            if t == name or t == f"/{name}":
                return ("info", 1)
        # ② 带参数：**只认纯页码**（"2" / "第2页" / "p2"）。
        #    非法参数（如 `坐骑功能` 的 "功能"、`坐骑列表` 的 "列表"）
        #    直接不命中 —— 否则会把别的指令吃掉。
        _carg = cmd_arg(t, self.mount_trigger_names)
        if _carg is not None and self._is_page_arg(_carg):
            return ("info", self._parse_page(_carg))
        return None

    @staticmethod
    def _is_page_arg(arg) -> bool:
        """参数是不是**合法页码**（"2" / "第2页" / "p2"）"""
        s = str(arg or "").strip()
        if not s:
            return False
        s = s.lstrip("第").rstrip("页").strip()
        return bool(_re.match(r"^[pP]?\s*\d+$", s))

    def match_mount_list_trigger(self, text: str):
        """
        「坐骑商店」：列可购买坐骑（1.7.6 起支持翻页）。

        返回页号（int）；未命中返回 None。

        ★★ 1.7.6 修：和 `match_mount_trigger` 一样的循环 bug ——
          `cmd_arg` 写在循环里会遍历全部名字，导致
          `坐骑列表 2` 先被 `坐骑` 用「无空格参数」规则吃掉。
          现在：先比纯名字，`cmd_arg` 只调一次，且**只认合法页码**。
        """
        if not self.enable or not self.mount_enable:
            return None
        t = str(text or "").strip()
        for name in self.mount_list_trigger_names:
            if t == name or t == f"/{name}":
                return 1
        _carg = cmd_arg(t, self.mount_list_trigger_names)
        if _carg is not None and self._is_page_arg(_carg):
            return self._parse_page(_carg)
        return None

    @staticmethod
    def _parse_page(arg, default: int = 1) -> int:
        """把「2」「第2页」「p2」解析成页号（非法就回第 1 页）"""
        s = str(arg or "").strip()
        if not s:
            return default
        s = s.lstrip("第").rstrip("页").strip()
        m = _re.match(r"^[pP]?\s*(\d+)$", s)
        if not m:
            return default
        return max(1, int(m.group(1)))

    def match_mount_buy_trigger(self, text: str):
        if not self.enable or not self.mount_enable:
            return None
        for name in self.mount_buy_trigger_names:
            _carg = cmd_arg(text, self.mount_buy_trigger_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return ("buy", arg)
                    return None
        return None

    def match_mount_add_cmd(self, text: str):
        """
        「添加坐骑」（管理员）：返回参数；未命中返回 None。

        ★ 1.7.6：`cmd_arg` 只调一次（以前写在循环里，虽然结果对但很浪费）。
        """
        if not self.enable or not self.mount_enable:
            return None
        _carg = cmd_arg(str(text or "").strip(), self.cmd_mount_add_names)
        if _carg is not None:
            return _carg
        return None

    def match_mount_del_cmd(self, text: str):
        """
        「删除坐骑」（管理员）：返回参数；未命中返回 None。

        ★ 1.7.6：`cmd_arg` 只调一次。
        """
        if not self.enable or not self.mount_enable:
            return None
        _carg = cmd_arg(str(text or "").strip(), self.cmd_mount_del_names)
        if _carg is not None:
            return _carg
        return None

    # ============================================================
    # 打工匹配
    # ============================================================
    def match_job_trigger(self, text: str):
        if not self.enable or not self.job_enable:
            return None
        for name in self.job_trigger_names:
            if text == name or text == f"/{name}":
                return ("list",)
            _carg = cmd_arg(text, self.job_trigger_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return ("work", arg)
                    return ("list",)
        return None

    def match_job_info_trigger(self, text: str) -> bool:
        if not self.enable or not self.job_enable:
            return False
        for name in self.job_info_trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_job_all_trigger(self, text: str) -> bool:
        """
        「全部打工」—— **一个指令把所有工种全打一遍**（1.7.6 新增）。

        ★ 不带参数；触发词由后台 `job_all_trigger_names` 自定义。
        ★ 注意：必须在 `match_job_trigger`（`打工 工种`）**之前**判断，
          否则「全部打工」会被短指令 `打工` 先吃掉。
        """
        if not self.enable or not self.job_enable:
            return False
        t = str(text or "").strip()
        for name in (getattr(self, "job_all_trigger_names", None)
                     or ["全部打工"]):
            if name and (t == name or t == f"/{name}"):
                return True
        return False

    # ------------------------------------------------------------
    # ★★ 1.7.6：签到商店匹配
    #   ★ 必须在**银行**的「存钱 / 取钱」之前判断，
    #     否则商店的存钱取钱会被银行吃掉（两边指令名不同，但顺序上仍要稳）。
    # ------------------------------------------------------------
    def match_shop_trigger(self, text: str):
        """
        「签到商店 [页码]」—— 未命中 None；命中返回**参数字符串**（可能为 ""）。

        ★★ 1.7.7：改成支持翻页 —— 「签到商店 2」看第 2 页。
          返回值从 bool 改成「参数字符串」（和 `cmd_arg` 的口径一致），
          这样 main.py 能拿到页码。
        """
        if not self.enable or not getattr(self, "shop_enable", True):
            return None
        t = str(text or "").strip()
        names = (getattr(self, "shop_trigger_names", None)
                 or ["签到商店"])
        for name in names:
            name = str(name or "").strip()
            if not name:
                continue
            if t == name or t == f"/{name}":
                return ""
            # ★ 带页码（「签到商店 2」），也容忍无空格（「签到商店2」）
            if t.startswith(name):
                _rest = t[len(name):].strip()
                if _rest.isdigit():
                    return _rest
        return None

    def _arg_is_real_name(self, arg: str, names) -> bool:
        """
        参数**本身就是一条真实数据名**时应当放行。

        ★★ 1.7.6 为什么需要：
          `cmd_arg` 会用 `_starts_with_known_cmd` 判断「这段像不像参数」，
          其中有条规则是**「某指令以这段结尾」**。于是：
            · 指令 `取出保险箱` 以 `保险箱` 结尾
            · 商品名恰好叫 `保险箱`
            -> `购买物品保险箱`（无空格）被判成「指令残片」而拒绝。
          同类问题适用于任何「数据名是某指令的子串」的情况。

          这里做一次兜底：只要参数**精确等于**一个真实数据名，就认它。
        """
        s = str(arg or "").strip()
        if not s:
            return False
        try:
            for x in (names or []):
                if str(x or "").strip() == s:
                    return True
        except Exception:
            pass
        return False

    def match_shop_buy_trigger(self, text: str):
        """
        「购买物品 名字」—— 返回物品名 / 序号；未命中 None。

        ★ 无空格写法（`购买物品保险箱`）也要认：
          `cmd_arg` 可能因为「保险箱 是 取出保险箱 的尾部」而拒绝，
          这里用真实商品名兜底放行。
        """
        if not self.enable or not getattr(self, "shop_enable", True):
            return None
        t = str(text or "").strip()
        names = getattr(self, "shop_buy_trigger_names", None) or ["购买商品"]
        r = cmd_arg(t, names)
        if r is not None:
            return r
        # ★ 兜底：自己剥前缀，参数是真实商品名（或纯序号）就放行
        for _n in names:
            _n = str(_n or "").strip()
            if not _n or not t.startswith(_n):
                continue
            _rest = t[len(_n):].strip()
            if not _rest:
                return ""
            if _rest.isdigit():
                return _rest
            if self._arg_is_real_name(
                    _rest, [i.get("name") for i in (self.shop_list or [])]):
                return _rest
        return None

    def match_shop_save_trigger(self, text: str):
        """「存钱 金额」—— 存进保险箱；返回参数；未命中 None"""
        if not self.enable or not getattr(self, "shop_enable", True):
            return None
        return cmd_arg(str(text or "").strip(),
                       getattr(self, "shop_save_trigger_names", None)
                       or ["存钱"])

    def match_shop_take_trigger(self, text: str):
        """「取钱 金额」—— 从保险箱取出；返回参数；未命中 None"""
        if not self.enable or not getattr(self, "shop_enable", True):
            return None
        return cmd_arg(str(text or "").strip(),
                       getattr(self, "shop_take_trigger_names", None)
                       or ["取钱"])

    def match_shop_equip_trigger(self, text: str):
        """
        「启用武器 名字/序号」—— 返回参数；未命中 None（1.7.7）。

        ★ 无空格写法也要认（`启用武器小刀`）。
        ★ 旧名「装备武器」仍认（老配置/老习惯）。
        """
        if not self.enable or not getattr(self, "shop_enable", True):
            return None
        t = str(text or "").strip()
        names = (getattr(self, "shop_equip_trigger_names", None)
                 or ["启用武器"])
        r = cmd_arg(t, names)
        if r is not None:
            return r
        # ★ 兜底：剥掉前缀后是纯序号 / 已有武器名就放行
        for _n in names:
            _n = str(_n or "").strip()
            if not _n or not t.startswith(_n):
                continue
            _rest = t[len(_n):].strip()
            if _rest:
                return _rest
        return None

    def match_my_equip_trigger(self, text: str):
        """「我的装备」—— 无参数查询；命中返回 True，否则 None"""
        if not self.enable:
            return None
        s = str(text or "").strip().lstrip("/").strip()
        names = (getattr(self, "my_equip_trigger_names", None)
                 or ["我的装备"])
        return True if s in [str(n).strip() for n in names if str(n).strip()] \
            else None

    # ------------------------------------------------------------
    # ★★ 1.7.7：体力 / 吃食物 / 加班
    # ------------------------------------------------------------
    def _match_exact_names(self, text: str, attr: str, dflt: list) -> bool:
        """指令名**完全相等**才算命中（避免「体力」吃掉「体力xx」）"""
        s = str(text or "").strip().lstrip("/").strip()
        if not s:
            return False
        for n in (getattr(self, attr, None) or dflt):
            n = str(n or "").strip()
            if n and s == n:
                return True
        return False

    def match_stamina_view_trigger(self, text: str) -> bool:
        """「我的体力」—— 无参数查询"""
        if not self.enable or not getattr(self, "stamina_enable", True):
            return False
        return self._match_exact_names(
            text, "stamina_view_trigger_names", ["我的体力", "体力"])

    def match_food_eat_trigger(self, text: str):
        """
        「吃食物 名字/序号」—— 返回参数；未命中 None。

        ★ 无参数也命中（返回 ""，用于展示背包），与其他带参数指令一致。
        """
        if not self.enable or not getattr(self, "stamina_enable", True):
            return None
        s = str(text or "").strip()
        names = (getattr(self, "food_eat_trigger_names", None)
                 or ["吃食物"])
        r = cmd_arg(s, names)
        if r is not None:
            return r
        # 无空格写法兜底（「吃食物面包」）
        for n in names:
            n = str(n or "").strip()
            if n and s.startswith(n):
                return s[len(n):].strip()
        return None

    def match_stamina_refill_trigger(self, text: str):
        """
        「加班 工种名」—— 单独加班一个工种。

        ★★ 1.7.7 分流规则（四个名字互不吃掉）：
          · `加班功能`   -> 菜单入口（本函数返回 None，交给菜单）
          · `加班状态`   -> 状态（本函数返回 None）
          · `全部加班`   -> 全部（本函数返回 None，交给 all 分支）
          · `加班 工种`  -> 本函数返回工种名
          · `加班`（无参数）-> 返回 ""，调用方按**状态**处理
        """
        if not self.enable or not getattr(self, "stamina_enable", True):
            return None
        s = str(text or "").strip()
        if not s:
            return None
        names = (getattr(self, "stamina_refill_trigger_names", None)
                 or ["加班"])
        # ★ 护栏 1：菜单入口名（「加班功能」）不能被当成「加班」+「功能」
        _menu_ns = {str(n).strip() for n in
                    (getattr(self, "stamina_refill_menu_names", None)
                     or ["加班功能"]) if str(n).strip()}
        for n in _menu_ns:
            if s in (n, f"/{n}"):
                return None
        # ★ 护栏 2：状态指令名（「加班状态」）有独立分支
        for _sn in (getattr(self, "stamina_refill_status_names", None)
                    or ["加班状态"]):
            _sn = str(_sn or "").strip()
            if _sn and s in (_sn, f"/{_sn}"):
                return None
        # ★ 护栏 3：全部加班名（「全部加班」/「加班全部」）要走 all 分支
        for _an in (getattr(self, "stamina_refill_all_names", None)
                    or ["全部加班"]):
            _an = str(_an or "").strip()
            if _an and s in (_an, f"/{_an}"):
                return None
        r = cmd_arg(s, names)
        if r is not None:
            return r
        # ★ 别名**带参数**的写法（「一键冷却 发传单」）：
        #   `cmd_arg` 对「一键冷却」会返回 None（它和菜单入口名同形），
        #   所以这里再补一遍「前缀 + 参数」。但要跳过菜单入口名本身，
        #   否则「加班功能」又会被吃成「加班」+「功能」。
        for n in names:
            n = str(n or "").strip()
            if not n or n in _menu_ns or s == n or s == f"/{n}":
                continue
            if s.startswith(n):
                _rest = s[len(n):].strip()
                if _rest:
                    return _rest
        return None

    def match_stamina_refill_status(self, text: str) -> bool:
        """
        ★★ 1.7.7：输出加班状态（可加班 / 不可加班工种）。

        ★ 触发条件**只有**「加班状态」（`stamina_refill_status_names`）。
          ★ 裸「加班」（不带参数）**故意不输出任何内容** ——
            用户要求：它只是「加班 工种」这条指令的关键词，
            少打参数就不该有反应（避免和「加班功能」菜单混淆）。
        """
        if not self.enable or not getattr(self, "stamina_enable", True):
            return False
        s = str(text or "").strip()
        if not s:
            return False
        for n in (getattr(self, "stamina_refill_status_names", None)
                  or ["加班状态"]):
            n = str(n or "").strip()
            if n and s in (n, f"/{n}"):
                return True
        return False

    def match_stamina_refill_all(self, text: str) -> bool:
        """
        ★★ 1.7.7：全部加班（清掉所有冷却中的工种）。

        触发词由后台 `stamina_refill_all_names` 自定义
        （默认「全部加班 / 加班全部 / 一键全部冷却」）。
        """
        if not self.enable or not getattr(self, "stamina_enable", True):
            return False
        s = str(text or "").strip()
        if not s:
            return False
        for n in (getattr(self, "stamina_refill_all_names", None)
                  or ["全部加班"]):
            n = str(n or "").strip()
            if n and s in (n, f"/{n}"):
                return True
        return False

    # ------------------------------------------------------------
    # ★★ 1.7.6：银行理财匹配
    #   ★ 必须在银行「存钱 / 取钱」之前判断（见 main.py 分发顺序），
    #     否则「购买理财 / 取出理财」会被「取钱」吃掉。
    # ------------------------------------------------------------
    def match_fund_trigger(self, text: str) -> bool:
        """「理财」—— 查看自己的理财亏盈"""
        if not self.enable or not getattr(self, "fund_enable", True):
            return False
        t = str(text or "").strip()
        for name in (getattr(self, "fund_trigger_names", None)
                     or ["理财"]):
            if name and (t == name or t == f"/{name}"):
                return True
        return False

    def match_fund_buy_trigger(self, text: str):
        """「购买理财 金额」—— 返回参数；未命中 None"""
        if not self.enable or not getattr(self, "fund_enable", True):
            return None
        return cmd_arg(str(text or "").strip(),
                       getattr(self, "fund_buy_names", None)
                       or ["购买理财"])

    def match_fund_sell_trigger(self, text: str):
        """「取出理财 [金额]」—— 返回参数；未命中 None"""
        if not self.enable or not getattr(self, "fund_enable", True):
            return None
        return cmd_arg(str(text or "").strip(),
                       getattr(self, "fund_sell_names", None)
                       or ["取出理财"])

    def match_job_add_cmd(self, text: str):
        if not self.enable or not self.job_enable:
            return None
        for name in self.cmd_job_add_names:
            _carg = cmd_arg(text, self.cmd_job_add_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return arg
                    return ""
        return None

    def match_job_del_cmd(self, text: str):
        if not self.enable or not self.job_enable:
            return None
        for name in self.cmd_job_del_names:
            _carg = cmd_arg(text, self.cmd_job_del_names)
            if _carg is not None:
                    arg = _carg
                    if arg:
                        return arg
                    return ""
        return None


    def record_speak(self, user_id: str, group_id: str = ""):
        if not user_id:
            return
        today = _today_str()
        day_map = self._gspeaks(group_id).setdefault(today, {})
        day_map[str(user_id)] = int(day_map.get(str(user_id), 0)) + 1
        bucket = self._gspeaks(group_id)
        if len(bucket) > 30:
            for k in sorted(bucket.keys())[:-30]:
                bucket.pop(k, None)

    def get_speak_today(self, group_id: str, user_id) -> int:
        """某人今天在本群的发言次数"""
        today = _today_str()
        return int(self._gspeaks(group_id).get(today, {}).get(str(user_id), 0))

    # ============================================================
    # 借款逾期利息 / 老赖（1.7.6）
    # ------------------------------------------------------------
    # 规则：
    #   · 借款时记下 `loan_due`（到期时间戳 = 借款时间 + loan_due_days 天）
    #   · 过了到期时间，每 loan_overdue_step_hours 小时加一次逾期利息
    #     每期金额 = 本金 × loan_overdue_rate（按**本金**算，越拖越多）
    #   · 逾期满 loan_deadbeat_days 天 -> 挂「老赖」标签
    #   · 每次借/还/查询前先结算，保证「欠多少」随时都是准的
    # ============================================================
    def loan_due_ts(self, u) -> float:
        """借款到期时间戳；0 = 没有欠款或没设期限"""
        try:
            return float((u or {}).get("loan_due") or 0)
        except Exception:
            return 0.0

    def loan_overdue_seconds(self, u) -> float:
        """已逾期秒数（未逾期返回 0）"""
        due = self.loan_due_ts(u)
        if due <= 0:
            return 0.0
        return max(0.0, time.time() - due)

    def loan_overdue_periods(self, u) -> int:
        """已逾期了几个计息周期"""
        secs = self.loan_overdue_seconds(u)
        if secs <= 0:
            return 0
        step = max(1, int(self.loan_overdue_step_hours or 24)) * 3600
        return int(secs // step)

    def loan_overdue_days(self, u) -> float:
        """已逾期天数（未逾期 0）"""
        return self.loan_overdue_seconds(u) / 86400.0

    def loan_principal(self, u) -> int:
        """
        欠款里属于「本金 + 借款时利息」的部分。

        ★ 存的是 loan（含逾期罚息），这里减去 `loan_extra`
          （已计的逾期罚息）得到原始欠款额，罚息才能按本金算。
        """
        try:
            extra = max(0, int((u or {}).get("loan_extra", 0) or 0))
        except Exception:
            extra = 0
        return max(0, self._loan_of(u) - extra)

    def is_deadbeat(self, u) -> bool:
        """
        是否算「老赖」：逾期时间 >= 配置天数。

        ★ 逾期惩罚整体关掉时（不设期限 / 罚息率为 0）不算老赖 ——
          否则「明明没罚钱还挂标签」会很莫名其妙。
        """
        if self._loan_of(u) <= 0:
            return False
        if int(getattr(self, "loan_due_days", 0) or 0) <= 0:
            return False
        if float(getattr(self, "loan_overdue_rate", 0) or 0) <= 0:
            return False
        od = self.loan_overdue_days(u)
        if od <= 0:
            return False
        need = max(0, int(self.loan_deadbeat_days or 0))
        return od >= need

    def deadbeat_tag_of(self, u) -> str:
        """
        老赖标签文本（不是老赖返回空串）。

        ★ 注意：`self.loan_deadbeat_tag` 是**标签文字**（后台可改），
          这里是取标签的方法，名字不能撞。
        """
        return self.loan_deadbeat_tag if self.is_deadbeat(u) else ""

    def loan_overdue_text(self, u) -> str:
        """逾期状态说明（未逾期返回空串）"""
        due = self.loan_due_ts(u)
        if due <= 0 or self._loan_of(u) <= 0:
            return ""
        per = self.loan_overdue_periods(u)
        if per <= 0:
            # 已过期但还没到第一个计息周期
            left = max(0, int(due + self.loan_overdue_step_hours * 3600
                              - time.time()))
            h = left // 3600
            m = (left % 3600) // 60
            return f"⏳ 已逾期，{h} 小时 {m} 分钟后开始计逾期利息"
        days = self.loan_overdue_days(u)
        rate = self.loan_overdue_rate * 100
        txt = (f"⏰ 已逾期 {days:.1f} 天（{per} 期 × {rate:.1f}% 罚息）")
        if self.is_deadbeat(u):
            txt += f"　{self.loan_deadbeat_tag}"
        return txt

    def apply_overdue_interest(self, group_id, uid, save: bool = True) -> int:
        """
        结算逾期利息：把「到目前应计的罚息」写进 loan。

        ★ 按**本期应计总额**校准，而不是每调用一次累加一次 ——
          这样重复调用不会重复收，重启后也不会漏收。

        返回本次新增的罚息（0 = 没变化）。
        """
        if not self.loan_enable or self.loan_overdue_rate <= 0:
            return 0
        u = self._guser(group_id, uid)
        if not isinstance(u, dict):
            return 0
        if self._loan_of(u) <= 0:
            return 0
        per = self.loan_overdue_periods(u)
        if per <= 0:
            return 0
        principal = self.loan_principal(u)
        if principal <= 0:
            return 0
        target_extra = int(round(principal * self.loan_overdue_rate * per))
        try:
            cur_extra = max(0, int(u.get("loan_extra", 0) or 0))
        except Exception:
            cur_extra = 0
        delta = target_extra - cur_extra
        if delta == 0:
            return 0
        u["loan_extra"] = max(0, target_extra)
        u["loan"] = max(0, self._loan_of(u) + delta)
        if save:
            self._save()
        if delta > 0:
            logger.info(f"[checkin] 逾期罚息 {group_id}/{uid}："
                        f"{per} 期 × {self.loan_overdue_rate:.0%} × "
                        f"本金 {principal} = +{fmt_num(delta)}")
        return delta

    def settle_all_overdue(self, save: bool = True) -> int:
        """给所有人结算一次逾期利息（银行利息结算时顺带跑）"""
        if not self.loan_enable or self.loan_overdue_rate <= 0:
            return 0
        total = 0
        for gid_key, bucket in list(self.users.items()):
            if not isinstance(bucket, dict):
                continue
            for uid, u in list(bucket.items()):
                if not isinstance(u, dict) or self._loan_of(u) <= 0:
                    continue
                total += self.apply_overdue_interest(
                    gid_key, uid, save=False)
        if total > 0:
            if save:
                self._save()
            logger.info(f"[checkin] 逾期罚息结算完成，共 +{total}")
        return total

    def settle_interest_if_needed(self):
        if not self.bank_enable:
            return
        if self.bank_interest_rate <= 0:
            return
        today = _today_str()
        if self.last_interest_date == today:
            return
        now_hour = datetime.datetime.now().hour
        if now_hour < self.bank_interest_hour:
            return
        changed = False
        for gid_key, bucket in self.users.items():
            if not isinstance(bucket, dict):
                continue
            for uid, u in bucket.items():
                if not isinstance(u, dict):
                    continue
                bank = int(u.get("bank", 0))
                if bank <= 0:
                    continue
                interest = int(bank * self.bank_interest_rate)
                if interest <= 0:
                    continue
                u["bank"] = bank + interest
                changed = True
        self.last_interest_date = today
        if changed:
            self._save()
            logger.info(f"[checkin] {today} 银行利息已结算")
        # ★ 1.7.6：顺带结算借款逾期罚息
        self.settle_all_overdue()

    def do_checkin(self, event) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        today = _today_str()
        month = _month_str()
        now = time.time()

        day_map = self._gdaily(group_id).setdefault(today, {})
        if user_id in day_map:
            rec = day_map[user_id]
            _u0 = self._guser(group_id, user_id) or {}
            _l0 = self._loan_of(_u0)
            _lines = [
                f"{title_bar('每日签到')}",
                f"👤 {user_name}",
                "⚠️ 今天已经签到过了",
                f"🕐 签到时间：{_fmt_time(rec.get('ts', 0))}",
                f"🎁 今日获得：{rec.get('score', 0)} {self._sn()}",
                f"🏅 今日名次：第 {rec.get('rank', 0)} 名",
                f"💰 拥有{self._sn()}：{int(_u0.get('total_score', 0) or 0)}",
            ]
            if _l0 > 0:
                _lines.append(
                    f"📉 欠款：{_l0}　💎 净值："
                    f"{int(_u0.get('total_score', 0) or 0) - _l0}")
            _lot0 = self._lottery_menu_line()
            if _lot0:
                _lines += ["", _lot0]
            return "\n".join(_lines)

        rank = len(day_map) + 1
        # ★ 随机范围由后台配置决定（默认 1~1000）
        score = random.randint(
            max(1, int(getattr(self, "score_min", 1))),
            max(1, int(getattr(self, "score_max", 1000))))

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u["name"] = user_name

        last_date = u.get("last_date", "")
        if last_date:
            try:
                last_dt = datetime.datetime.strptime(last_date, "%Y-%m-%d").date()
                today_dt = datetime.datetime.strptime(today, "%Y-%m-%d").date()
                delta = (today_dt - last_dt).days
                if delta == 1:
                    u["streak"] = int(u.get("streak", 0)) + 1
                elif delta > 1:
                    u["streak"] = 1
            except Exception:
                u["streak"] = 1
        else:
            u["streak"] = 1

        u["last_date"] = today
        u["total_score"] = int(u.get("total_score", 0)) + score
        u["total_checkin"] = int(u.get("total_checkin", 0)) + 1

        mm = u.setdefault("month_map", {})
        mm[month] = int(mm.get(month, 0)) + 1
        if len(mm) > 6:
            old = sorted(mm.keys())[:-6]
            for k in old:
                mm.pop(k, None)
        month_count = int(mm.get(month, 0))
        speak_count = self.get_speak_today(group_id, user_id)

        day_map[user_id] = {"ts": now, "rank": rank, "score": score}
        dm = self._gdaily(group_id)
        if len(dm) > 60:
            for k in sorted(dm.keys())[:-60]:
                dm.pop(k, None)

        self._save()

        out = [
            f"{title_bar('每日签到')}",
            f"👤 {user_name}",
            f"🕐 签到时间：{_fmt_time(now)}",
            f"🔥 连续签到：{u['streak']} 天",
            f"🏅 今日名次：第 {rank} 名",
            f"💬 今日发言：{speak_count} 次",
            f"📅 本月签到：{month_count} 天",
            f"📊 累计签到：{u['total_checkin']} 次",
            f"🎁 今日获得：{score} {self._sn()}",
            f"💰 拥有{self._sn()}：{fmt_num(u['total_score'])}",
        ]
        # ★ 负债时把欠款/净值也列出来，心里有数
        _loan = self._loan_of(u)
        if _loan > 0:
            out.append(f"📉 欠款：{fmt_num(_loan)}　💎 净值：{fmt_num(u['total_score'] - _loan)}")
        # ★ 末尾抽奖入口
        _lot = self._lottery_menu_line()
        if _lot:
            out += ["", _lot]
        return "\n".join(out)

    # ============================================================
    # 排行榜（★ 每群独立统计；昵称仍走全局缓存）
    # ============================================================
    def _nick_of(self, group_id, uid) -> str:
        """
        取显示名。

        ★ 1.7.6 修正：**有群号时优先用本群的昵称**。

        为什么：`nickname_cache` 是**跨群共享**的一张表（{QQ: 昵称}），
        同一个人在 A 群叫「老王」、B 群叫「小王」时，表里只会留下
        **最后一次发言**的那个群的名字。以前这里无条件优先读缓存，
        结果在 A 群发指令会显示 B 群的昵称。

        现在的优先级：
          ① 本群用户记录里的 `name`（每次本群互动都会更新，是本群昵称）
          ② 全局昵称缓存（没有群号时只能用它）
          ③ 脱敏 QQ 号
        """
        uid_str = str(uid)
        # ① 本群昵称优先（只在给了群号时）
        if group_id:
            try:
                u = self._guser(group_id, uid_str)
                name = str((u or {}).get("name", "") or "").strip()
                if name and not name.startswith("QQ"):
                    return _nick_narrow(name)
            except Exception:
                logger.debug("[checkin] 读本群昵称失败", exc_info=True)
        # ② 全局缓存
        if uid_str in self.nickname_cache:
            nm = str(self.nickname_cache.get(uid_str) or "").strip()
            if nm:
                return _nick_narrow(nm)
        # ③ 本群记录兜底（缓存里也没有时）
        if group_id:
            try:
                u = self._guser(group_id, uid_str)
                name = str((u or {}).get("name", "") or "").strip()
                if name and not name.startswith("QQ"):
                    return _nick_narrow(name)
            except Exception:
                pass
        if len(uid_str) > 5:
            return f"{uid_str[:3]}****{uid_str[-2:]}"
        return uid_str

    def _rank_items(self, group_id) -> list:
        """排行榜公共数据源：[{uid, score, bank, vault, loan, streak, total, wealth}]"""
        items = []
        for uid, u in self._all_group_users(group_id):
            try:
                _w = int(u.get("total_score", 0))
                _b = int(u.get("bank", 0) or 0)
                _ln = self._loan_of(u)
                # ★★ 1.7.7：**总财富要把保险箱也算进去**（用户要求）。
                #   · 保险箱余额：只有买了保险箱的人才有（`vault_money_of`
                #     已经处理了「没买 = 0」），所以直接读原始字段更快，
                #     但仍然过一遍 `user_has_vault` 防止老数据残留。
                _v = 0
                try:
                    if self.user_has_vault(group_id, uid):
                        _v = int(u.get("vault_money", 0) or 0)
                except Exception:
                    _v = 0
                items.append({
                    "uid": uid,
                    "score": _w,
                    "bank": _b,
                    "vault": _v,
                    "loan": _ln,
                    "streak": int(u.get("streak", 0)),
                    "total": int(u.get("total_checkin", 0)),
                    # ★ 总财富 = 钱包 + 银行 + 保险箱 − 欠款
                    "wealth": _w + _b + _v - _ln,
                })
            except Exception:
                continue
        return items

    def build_rank_by_count(self, group_id="") -> str:
        """【排行榜 1】签到次数排行"""
        items = self._rank_items(group_id)
        lines = [f"{title_bar('签到次数排行')}", ""]
        if not items:
            lines.append("暂无签到记录")
            return "\n".join(lines)
        top = sorted(items, key=lambda x: (-x["total"], x["uid"]))[:10]
        for i, it in enumerate(top, start=1):
            lines.append(f"{_rank_tag(i)}"
                         f"{self._nick_of(group_id, it['uid'])}"
                         f" — {it['total']} 次")
        lines += ["", "💡 只统计本群"]
        return "\n".join(lines)

    def build_rank_by_wealth(self, group_id="") -> str:
        """
        【排行榜 2】总财富排行。

        ★★ 1.7.7：口径改为 **钱包 + 银行 + 保险箱 − 欠款**
          （以前漏了保险箱，导致把钱存起来的人排名偏低）。
        ★ 只显示**总数**，不展开各项明细。
        """
        items = self._rank_items(group_id)
        lines = [f"{title_bar('总财富排行')}", ""]
        if not items:
            lines.append("暂无签到记录")
            return "\n".join(lines)
        top = sorted(items, key=lambda x: (-x["wealth"], x["uid"]))[:10]
        for i, it in enumerate(top, start=1):
            # ★★ 1.7.7：**只显示总数** —— 不再单独列出保险箱数额
            #   （用户要求：总数里已经含保险箱，单独再列一遍是重复信息）
            #   ★ 名次前缀统一 `_rank_tag`（前三名奖牌 + 两空格分列对齐）
            lines.append(f"{_rank_tag(i)}"
                         f"{self._nick_of(group_id, it['uid'])}"
                         f" — {fmt_num(it['wealth'])}")
        lines += ["", "💡 只统计本群",
                  "💡 总财富 = 钱包 + 银行 + 保险箱 − 欠款"]
        return "\n".join(lines)

    def build_rank_by_debt(self, group_id="") -> str:
        """【排行榜 3】负债排行（欠得越多越靠前；逾期挂「老赖」标签）"""
        # ★ 1.7.6：先结算逾期罚息，排名才是当前真实欠款
        try:
            for _uid in list(self._gusers(group_id).keys()):
                self.apply_overdue_interest(group_id, _uid, save=False)
        except Exception:
            logger.debug("[checkin] 负债排行结算罚息失败", exc_info=True)
        items = [x for x in self._rank_items(group_id) if x["loan"] > 0]
        lines = [f"{title_bar('负债排行')}", ""]
        if not items:
            lines.append("🎉 本群没有人欠债，都是好人")
            return "\n".join(lines)
        top = sorted(items, key=lambda x: (-x["loan"], x["uid"]))[:10]
        _deadbeats = 0
        for i, it in enumerate(top, start=1):
            nm = self._nick_of(group_id, it["uid"])
            _u = self._guser(group_id, it["uid"]) or {}
            _tag = self.deadbeat_tag_of(_u)
            if _tag:
                _deadbeats += 1
            _tail = f"　{_tag}" if _tag else ""
            lines.append(f"{_rank_tag(i)}{nm} — 欠 {fmt_num(it['loan'])}"
                         f"（净值 {fmt_num(it['wealth'])}）{_tail}")
        lines += ["", "💡 欠得越多排名越靠前 😈"]
        if _deadbeats:
            lines.append(f"{self.loan_deadbeat_tag} = 逾期未还，共 {_deadbeats} 人")
        return "\n".join(lines)

    def build_user_info_text(self, group_id="", target_uid: str = "", target_name: str = "") -> str:
        if not target_uid:
            return "⚠️ 未指定要查询的 QQ"
        today = _today_str()
        month = _month_str()
        u = self._guser(group_id, target_uid)
        _name_show = target_name or ("QQ" + target_uid)
        if not isinstance(u, dict):
            base = [
                f"{title_bar('签到统计')}",
                f"👤 {_name_show}",
                f"💳 QQ：{target_uid}",
                "",
                "📊 累计签到：0 次",
                f"💰 拥有{self._sn()}：0",
                # ★★ 1.7.7：体力（关掉就不显示）
                *(["⚡ 体力：0 / " + str(max(0, int(
                    getattr(self, "stamina_max", 100) or 0)))]
                  if getattr(self, "stamina_enable", True) else []),
                "🏦 银行余额：0",
                # ★★ 1.7.7：银行状态（没记录的人也可能是被冻过的号）
                f"🏦 银行状态：{self.bank_status_text(group_id, target_uid)}",
                "📉 欠款：0",
                "💎 净值：0",
                "📊 总资产：0",
                "",
                "📌 今日状态",
                "　 ❌ 今天还没签到",
                "🕐 今日签到时间",
                "　 —",
            ]
            return "\n".join(base)

        total_score = int(u.get("total_score", 0))
        total_checkin = int(u.get("total_checkin", 0))
        streak = int(u.get("streak", 0))
        last_date = u.get("last_date", "")
        mm = u.get("month_map", {}) or {}
        month_count = int(mm.get(month, 0))
        bank = int(u.get("bank", 0))
        loan = self._loan_of(u)

        # ★★ 1.7.7：体力（体力系统关掉就整行不显示）
        _show_stamina = bool(getattr(self, "stamina_enable", True))
        _st_cur = 0
        _st_max = max(0, int(getattr(self, "stamina_max", 100) or 0))
        if _show_stamina:
            try:
                _st = self.stamina_of(group_id, target_uid)
                _st_cur, _st_max = _st["cur"], _st["max"]
            except Exception:
                logger.debug("[checkin] 读体力失败", exc_info=True)

        today_rec = self._gdaily(group_id).get(today, {}).get(target_uid)
        if today_rec:
            today_state = f"✅ 已签到（第 {today_rec.get('rank', 0)} 名，+{today_rec.get('score', 0)} 分）"
            today_time = _fmt_time(today_rec.get("ts", 0))
        else:
            today_state = "❌ 今天还没签到"
            today_time = "—"

        lines = [
            f"{title_bar('签到统计')}",
            f"👤 {_name_show}",
            f"💳 QQ：{target_uid}",
            "",
            f"📊 累计签到：{total_checkin} 次",
            f"💰 拥有{self._sn()}：{fmt_num(total_score)}",
            # ★★ 1.7.7：当前体力（体力系统关掉就不显示）
            *([f"⚡ 体力：{_st_cur} / {_st_max}"] if _show_stamina else []),
            f"🏦 银行余额：{fmt_num(bank)}",
            # ★★ 1.7.7：银行状态（未冻结 / 解冻时间）
            f"🏦 银行状态：{self.bank_status_text(group_id, target_uid)}",
            f"📉 欠款：{fmt_num(loan)}",
            f"💎 净值：{fmt_num(total_score - loan)}",
            f"📊 总资产：{fmt_num(total_score + bank - loan)}",
            f"🔥 连续签到：{streak} 天",
            f"📅 本月签到：{month_count} 天",
        ]
        # ★★ 1.7.6：买了保险箱才显示保险箱余额
        if self.user_has_vault(group_id, target_uid):
            _vm = self.vault_money_of(group_id, target_uid)
            # ★★ 1.7.7：去掉后面的「（别人偷不走）」括号提示
            lines.append(f"🧰 保险箱：{fmt_num(_vm)}")
        # ★★ 1.7.7：今日状态**换行显示**（以前挤在一行）
        #   ★ 顺便移除「今日发言次数」（用户要求去掉）
        lines += [
            "",
            "📌 今日状态",
            f"　 {today_state}",
            "🕐 今日签到时间",
            f"　 {today_time}",
        ]
        # ★★ 1.7.7：装备状态（坐骑 + 武器）+ 所有 BUFF 分行列出
        lines += self._equip_buff_lines(group_id, target_uid)
        return "\n".join(lines)

    def _equip_buff_lines(self, group_id, uid) -> list:
        """
        ★★ 1.7.7：把「已装备的坐骑 / 武器」和**各自带来的加成**分行列出。

        输出形状：
            ── 装备 ──
            🐴 坐骑：赤兔
            ⚔️ 武器：武士刀
            ✨ 加成
            　 🦸 偷积分成功率 +8.2%
            　 🛡 被偷概率 -4%
            　 🏦 抢银行成功率 +6.1%
        没装备就提示怎么装备；一件都没有就整块不输出。
        """
        try:
            u = self._guser(group_id, uid) or {}
            mount = str(u.get("current_mount") or "").strip()
            weapon = self.current_weapon_of(group_id, uid)
            m_steal, m_rob = (self.mount_bonus_of(mount) if mount
                              else (0.0, 0.0))
            w_steal, w_def, w_rob = self.weapon_bonus_of_user(group_id, uid)
            has_vault = self.user_has_vault(group_id, uid)
            vault_def = (float(getattr(self, "vault_steal_reduce", 15.0) or 0)
                         if has_vault else 0.0)
            # 合计（防御要过上限，和实际生效值一致）
            _cap = float(getattr(self, "shop_defense_cap", 60.0) or 60.0)
            steal = m_steal + w_steal
            defense = min(w_def + vault_def, _cap)
            rob = min(m_rob + w_rob,
                      float(getattr(self, "shop_rob_bonus_cap", 20.0) or 20.0))
            if not (mount or weapon or has_vault):
                return []
            out = ["", "── 装备 ──"]
            if mount:
                # ★★ 1.7.7：统计里**不显示坐骑图**（用户要求），只显示名字
                out.append(f"🐴 坐骑：{mount}")
            else:
                out.append("🐴 坐骑：未装备")
            out.append(f"⚔️ 武器：{weapon}" if weapon else "⚔️ 武器：未启用")
            # ★★ 1.7.7：「保险箱：已拥有」这行不再显示（余额行在上面已经有了）
            out += ["", "✨ 加成"]
            _any = False
            if steal > 0:
                out.append(f"　 🦸 偷积分成功率 +{self.fmt_bonus(steal)}%")
                _any = True
            if defense > 0:
                out.append(f"　 🛡 被偷概率 -{self.fmt_bonus(defense)}%")
                _any = True
            if rob > 0:
                out.append(f"　 🏦 抢银行成功率 +{self.fmt_bonus(rob)}%")
                _any = True
            if not _any:
                out.append("　 （暂无加成）")
            # ★★ 1.7.7：**不再在统计里给「装备坐骑 / 启用武器」的提示**
            #   （用户要求精简）—— 想知道怎么装备去看「我的装备」。
            return out
        except Exception:
            logger.debug("[checkin] 装备加成行渲染失败", exc_info=True)
            return []

    # ------------------------------------------------------------
    # ★★ 1.7.7：武器破保险箱
    # ------------------------------------------------------------
    def weapon_vault_break_rate(self, group_id, user_id) -> float:
        """
        攻击方**当前启用武器**的破保险箱概率（%）。

        · 没启用武器 -> 0（空手破不了箱）
        · 武器条目填了 `vault_break_rate` -> 用它
        · 没填 -> 用全局 `vault_break_rate`
        """
        nm = self.current_weapon_of(group_id, user_id)
        if not nm:
            return 0.0
        it = self.shop_item_of(nm) or {}
        try:
            v = it.get("vault_break_rate")
            if v is None or str(v).strip() == "":
                return max(0.0, float(
                    getattr(self, "vault_break_rate", 0.0) or 0.0))
            return max(0.0, float(v))
        except Exception:
            return 0.0

    def _do_vault_break(self, group_id, attacker_id, attacker,
                        target_id, target, take: int, vault: int) -> str:
        """
        ★★ 1.7.7：**执行**破保险箱（已在调用方摇中概率）。

        参数：
          take   要抢走的金额（调用方算好，已按比例 + 不超过剩余额度）
          vault  抢之前保险箱里的总额（用来算剩余）

        ★ 这里**只负责转账**（保险箱 -take、攻击方 +take）并返回**细节文案**。
          总额已经在成功提示里汇总过了，所以细节里**不再重复报金额**，
          避免出现「+500（钱包100，银行100，保险箱300）」+「抢走箱内：+300」
          这种同一笔钱说两遍的情况。

        ★ `vault_break_destroy=True` 时把保险箱砸掉（目标需重新购买）。
        """
        take = int(take or 0)
        vault = int(vault or 0)
        if take <= 0 or vault <= 0:
            return ""
        target["vault_money"] = vault - take
        attacker["total_score"] = int(attacker.get("total_score", 0)) + take
        _destroy = bool(getattr(self, "vault_break_destroy", False))
        if _destroy:
            # 砸箱：从已购列表里移掉保险箱，余额也清零
            try:
                bought = target.get("shop_bought")
                if isinstance(bought, list):
                    target["shop_bought"] = [
                        x for x in bought
                        if str(self.shop_item_of(x).get("kind") or "")
                        != self.SHOP_KIND_VAULT]
                target["vault_money"] = 0
            except Exception:
                logger.debug("[checkin] 砸保险箱失败", exc_info=True)
        logger.info(f"[checkin] 破保险箱成功：{attacker_id} 从 {target_id} 抢走 "
                    f"{take}（箱内 {vault}）"
                    f"{'，并砸毁了保险箱' if _destroy else ''}")
        lines = ["🔨 对方的**保险箱**被你的武器撬开了"]
        if _destroy:
            lines.append("💥 保险箱已被**砸毁**（对方需重新购买）")
        else:
            lines.append(f"🧰 对方保险箱剩余：{vault - take}")
        return "\n".join(lines)

    def do_steal(self, event, target_raw: str = "") -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "steal"):
            return ""
        attacker_id = get_user_id(event)
        attacker_name = get_user_name(event) or f"QQ{attacker_id}"
        target_id = ""
        cleaned = str(target_raw).lstrip("@").strip()
        if cleaned.isdigit():
            target_id = cleaned
        if not target_id:
            return (
                f"⚠️ 请指定要偷的人\n"
                f"用法：「{self.steal_trigger_names[0]} @某人」"
                f"或「{self.steal_trigger_names[0]} QQ号」"
            )
        if target_id == attacker_id:
            return f"⚠️ 不能偷自己的{self._sn()}"

        attacker = self._guser(group_id, attacker_id)
        if not isinstance(attacker, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        attacker.setdefault("bank", 0)
        attacker["name"] = attacker_name

        target = self._guser(group_id, target_id)
        if not isinstance(target, dict):
            return f"⚠️ QQ {target_id} 还没有签到记录"
        target.setdefault("bank", 0)

        target_score = int(target.get("total_score", 0))
        target_bank = int(target.get("bank", 0) or 0)

        # ★★ 1.7.7：偷取顺序 —— **钱包 → 银行**，有武器才有概率再动保险箱。
        #   为什么不再「提前摇破箱」：
        #     用户要的是**依次**拿钱，不是并行两件事。所以先看钱包，
        #     钱包不够看银行，**只有前两处都掏空**、且攻击方带了武器，
        #     才去摇保险箱那一档。
        #   能偷到的总额上限 = 随机额度 或 对方三处总额（谁小取谁）
        _roll_amount = random.randint(self.steal_min, self.steal_max)
        _target_vault = 0
        try:
            _target_vault = int(self.vault_money_of(group_id, target_id) or 0)
        except Exception:
            _target_vault = 0
        # 攻击方有没有破箱能力（没武器 = 0）
        _break_rate = self.weapon_vault_break_rate(group_id, attacker_id)
        _total_avail = target_score + target_bank
        if _break_rate > 0:
            _total_avail += _target_vault
        if _total_avail <= 0:
            return f"⚠️ QQ {target_id} 身上没有{self._sn()}可以偷"

        amount = min(_roll_amount, _total_avail)

        # ★★ 1.7.6：成功率 = 基础 + 攻击方加成 − 防守方防御，最后夹在 0~100
        #   攻击方：① 骑乘坐骑（按价格）② **已启用**的武器
        #   防守方：① **已启用**武器的防御 ② 保险箱（买了就生效）
        #   ★ 变量名是 attacker_id（不是 user_id），写错会直接 NameError
        #   ★★ 1.7.7：`shop_bonus_of_user` 现在返回 3 元组（多了抢银行加成）
        _sb, _ = self.mount_bonus_of_user(group_id, attacker_id)
        _ssb, _, _ = self.shop_bonus_of_user(group_id, attacker_id)
        _, _tdef, _ = self.shop_bonus_of_user(group_id, target_id)
        _rate = self.steal_success_rate + _sb + _ssb - _tdef
        _rate = max(0, min(100, _rate))
        roll = random.randint(1, 100)
        if roll <= _rate:
            # ---- 依次取钱：钱包 → 银行 → 保险箱（需武器 + 概率）----
            #   ★ 先把「能拿到的上限」和「随机额度」比较，取小的那个作为目标额。
            #     保险箱只有**带了有破箱能力的武器**时才计入上限 ——
            #     摇不破的箱子不算可偷财产。
            _avail = max(0, target_score) + max(0, target_bank)
            if _break_rate > 0 and _target_vault > 0:
                _avail += _target_vault
            goal = min(amount, _avail)
            rest = goal
            take_w = min(max(0, target_score), rest)
            rest -= take_w
            take_b = min(max(0, target_bank), rest)
            rest -= take_b
            take_v = 0
            _break_txt = ""
            # ★ 钱包+银行都掏空后还差钱（rest > 0）才去撬保险箱
            if rest > 0 and _break_rate > 0 and _target_vault > 0:
                if random.randint(1, 100) <= _break_rate:
                    try:
                        ratio = float(getattr(self, "vault_break_ratio", 1.0)
                                      or 1.0)
                    except Exception:
                        ratio = 1.0
                    ratio = max(0.0, min(1.0, ratio))
                    take_v = int(_target_vault * ratio)
                    if take_v <= 0:
                        take_v = min(_target_vault, 1)
                    take_v = min(take_v, _target_vault, rest)
                    _break_txt = self._do_vault_break(
                        group_id, attacker_id, attacker, target_id, target,
                        take_v, _target_vault)
                else:
                    _break_txt = ("🔨 想撬对方的保险箱，"
                                  f"但没撬开（成功率 {self.fmt_bonus(_break_rate)}%）")
            got = take_w + take_b + take_v
            if got <= 0:
                return f"⚠️ QQ {target_id} 身上没有{self._sn()}可以偷"
            target["total_score"] = target_score - take_w
            target["bank"] = target_bank - take_b
            # ★★ 1.7.7 修正：`_do_vault_break()` 内部**已经**把保险箱那笔
            #   钱加给攻击者了，这里只补钱包 + 银行那部分 —— 否则保险箱
            #   那份会被加两次（文案写 +500、实际到手 800）。
            _settle = take_w + take_b
            attacker["total_score"] = int(attacker.get("total_score", 0)) + _settle
            self._save()
            _lines = [
                f"{title_bar('偷积分')}",
                f"🦸 {attacker_name}",
                f"🎯 目标：QQ {target_id}",
                "✅ 偷取成功！",
                f"💰 获得{self._sn()}：+{got}",
            ]
            # 钱从哪来的（多于一档时才列明细）
            if (take_w > 0) + (take_b > 0) + (take_v > 0) > 1:
                _src = []
                if take_w > 0:
                    _src.append(f"钱包 {take_w}")
                if take_b > 0:
                    _src.append(f"银行 {take_b}")
                if take_v > 0:
                    _src.append(f"保险箱 {take_v}")
                _lines.append(f"　 （{'，'.join(_src)}）")
            if _break_txt:
                _lines += ["", _break_txt]
            _lines.append(f"💳 当前{self._sn()}：{attacker['total_score']}")
            return "\n".join(_lines)

        punish_roll = random.randint(1, 100)
        if punish_roll <= self.steal_fail_punish_rate:
            punish = random.randint(self.steal_punish_min, self.steal_punish_max)
            # ★★ 1.7.7：没偷到要**赔付对方**，扣款顺序 钱包 → 银行。
            #   ★ 这里**不掏保险箱** —— 保险箱只有「偷成功时的目标池」
            #     才用得上（见上面成功分支），赔付不碰它。
            _pr = self.pay(group_id, attacker_id, punish)
            _paid = (int(_pr.get("from_wallet", 0) or 0)
                     + int(_pr.get("from_bank", 0) or 0))
            if _paid > 0:
                # 赔付的钱给受害人
                target["total_score"] = target_score + _paid
                self._save()
                _lines = [
                    f"{title_bar('偷积分')}",
                    f"🦸 {attacker_name}",
                    f"🎯 目标：QQ {target_id}",
                    "❌ 偷取失败，被发现了！",
                    f"💸 赔付对方：-{_paid}",
                ]
                # ★ 扣款明细（钱包 / 银行）
                _parts = []
                for _k, _lbl in (("from_wallet", "钱包"),
                                 ("from_bank", "银行")):
                    _v = int(_pr.get(_k, 0) or 0)
                    if _v > 0:
                        _parts.append(f"{_lbl} -{_v}")
                if _parts:
                    _lines.append(f"　 （{'，'.join(_parts)}）")
                _lines.append(
                    f"💳 当前{self._sn()}：{attacker.get('total_score', 0)}")
                return "\n".join(_lines)
            else:
                self._save()
                _lines = [
                    f"{title_bar('偷积分')}",
                    f"🦸 {attacker_name}",
                    f"🎯 目标：QQ {target_id}",
                    "❌ 偷取失败，被发现了！",
                    f"💸 但你连{self._sn()}都没有，赔不起",
                ]
                return "\n".join(_lines)

        self._save()
        _lines = [
            f"{title_bar('偷积分')}",
            f"🦸 {attacker_name}",
            f"🎯 目标：QQ {target_id}",
            "❌ 偷取失败，幸好跑掉了",
        ]
        _lines.append(f"💳 当前{self._sn()}：{attacker.get('total_score', 0)}")
        return "\n".join(_lines)

    def do_bank_info(self, event) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "\n".join([
                f"{title_bar('我的银行')}",
                f"👤 {user_name}",
                "🏦 银行余额：0",
                f"💳 持有{self._sn()}：0",
                f"💡 先签到获得{self._sn()}吧~",
            ])
        u["name"] = user_name
        bank = int(u.get("bank", 0))
        wallet = int(u.get("total_score", 0))
        loan = self._loan_of(u)
        rate_pct = self.bank_interest_rate * 100
        lines = [
            f"{title_bar('我的银行')}",
            f"👤 {user_name}",
            f"💳 持有{self._sn()}：{fmt_num(wallet)}",
            f"🏦 银行余额：{fmt_num(bank)}",
            f"📉 欠款：{fmt_num(loan)}",
            f"💎 净值：{fmt_num(wallet - loan)}",
            f"📊 总资产：{fmt_num(wallet + bank - loan)}",
            "",
            f"📈 日利率：{rate_pct:.2f}%",
            f"💡 用「{self.bank_deposit_names[0]} 数量」存钱",
            f"💡 用「{self.bank_withdraw_names[0]} 数量」取钱",
        ]
        if self.loan_enable:
            lines.append(
                f"💸 急用钱可用「{self.loan_trigger_names[0]} 数量」借款"
                f"（利息 {self.loan_interest_rate * 100:.0f}%，"
                f"上限 {self.loan_max}）")
        return "\n".join(lines)

    def _parse_amount(self, arg: str, max_amount: int) -> int:
        if not arg:
            return 0
        arg = str(arg).strip().lower()
        if arg in ("all", "全部", "所有"):
            return max_amount
        if not arg.isdigit():
            return -1
        n = int(arg)
        if n <= 0:
            return -1
        return n

    # ============================================================
    # ★★ 1.7.6：银行理财（银行子功能）
    # ------------------------------------------------------------
    # 玩法：把钱**买入理财** -> 之后**每天随机盈亏**一次
    #   · 盈利：直接加到买入金额上
    #   · 亏损：从买入金额里扣；**不够扣就从自己资产（钱包+银行）补**
    #   · 随时可取：取出的钱回**银行账户**
    # ★ 结算时机：每天第一次调用理财相关功能时结算一次（惰性结算，
    #   不依赖定时任务，重启也不会漏）。
    # ============================================================
    def _fund_of(self, u: dict) -> dict:
        """取用户理财数据（自动补默认字段）"""
        if not isinstance(u, dict):
            return {"principal": 0, "last_date": "", "total_pnl": 0,
                    "last_pnl": 0, "last_rate": 0.0, "days": 0}
        f = u.get("fund")
        if not isinstance(f, dict):
            f = {}
            u["fund"] = f
        f.setdefault("principal", 0)
        f.setdefault("last_date", "")
        f.setdefault("total_pnl", 0)
        f.setdefault("last_pnl", 0)
        f.setdefault("last_rate", 0.0)
        f.setdefault("days", 0)
        return f

    def fund_settle(self, group_id, user_id, force_rate=None) -> dict:
        """
        惰性结算理财：把「上次结算日 -> 今天」之间缺的天数**逐天补算**。

        force_rate: 仅测试用，强制某一天的涨跌比例（-1 ~ 1），
                    用来验证「亏穿本金 -> 从资产补扣」这条分支
                    （正常配置下百分比亏损**到不了**负本金）。

        返回本次结算信息：
          {"settled": 结算天数, "pnl": 这几次总盈亏, "last_pnl": 最近一天盈亏,
           "last_rate": 最近一天比例, "deducted": 从资产补扣的钱}
          principal 变 0 时视为清盘，停止结算。
        """
        res = {"settled": 0, "pnl": 0, "last_pnl": 0, "last_rate": 0.0,
               "deducted": 0}
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return res
        f = self._fund_of(u)
        principal = int(f.get("principal", 0) or 0)
        if principal <= 0:
            return res
        today = _today_str()
        last = str(f.get("last_date") or "")
        if last == today:
            return res          # 今天已经结过
        # ★ 计算要补几天：上次到现在跨了几天（首次买入当天不结算）
        days = 1
        if last:
            try:
                import datetime as _dt
                d1 = _dt.date.fromisoformat(last)
                d2 = _dt.date.fromisoformat(today)
                days = max(1, min(30, (d2 - d1).days))   # 最多补 30 天
            except Exception:
                days = 1
        pmax = float(getattr(self, "fund_profit_max", 8.0) or 0)
        lmax = float(getattr(self, "fund_loss_max", 6.0) or 0)
        total_pnl = 0
        deducted = 0
        for _ in range(days):
            if principal <= 0:
                break
            if force_rate is None:
                rate = random.uniform(-lmax, pmax) / 100.0
            else:
                rate = float(force_rate)
            delta = int(round(principal * rate))
            if delta == 0:
                delta = 1 if rate > 0 else -1
            principal += delta
            if principal < 0:
                # ★ 亏超过本金 -> 从自己资产（钱包 -> 银行）补扣
                _need = -principal
                _got = self.pay(group_id, user_id, _need)
                # pay() 会返回「实际扣到的金额」（可能不足）
                _got = int(_got if isinstance(_got, (int, float)) else _need)
                deducted += _got
                principal = 0
            total_pnl += delta
            f["last_pnl"] = delta
            f["last_rate"] = rate * 100
        f["principal"] = max(0, principal)
        f["last_date"] = today
        f["total_pnl"] = int(f.get("total_pnl", 0) or 0) + total_pnl
        f["days"] = int(f.get("days", 0) or 0) + days
        res.update({"settled": days, "pnl": total_pnl, "deducted": deducted,
                    "last_pnl": f["last_pnl"], "last_rate": f["last_rate"]})
        self._save()
        return res

    def _fund_status_line(self, f: dict) -> str:
        """今天亏了还是盈了一行字"""
        _p = int(f.get("last_pnl", 0) or 0)
        _r = float(f.get("last_rate", 0.0) or 0.0)
        if _p > 0:
            return f"📈 今天是**盈利**：+{fmt_num(_p)}（{_r:+.1f}%）"
        if _p < 0:
            return f"📉 今天是**亏损**：{fmt_num(_p)}（{_r:+.1f}%）"
        return "➖ 今天持平（还没结算 / 无涨跌）"

    def do_fund_view(self, event) -> str:
        """「理财」：查看自己的理财亏盈 + 今天是亏还是盈"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        if not getattr(self, "fund_enable", True):
            return "⚠️ 理财功能未开启"
        user_id = get_user_id(event)
        # ★★ 1.7.6：理财算**银行功能**的一部分 —— 银行冻结时也不能用
        _fz = self.bank_frozen_msg(group_id, user_id)
        if _fz:
            return _fz
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        # ★ 先结算今天的盈亏
        self.fund_settle(group_id, user_id)
        u = self._guser(group_id, user_id) or {}
        f = self._fund_of(u)
        principal = int(f.get("principal", 0) or 0)
        cmd_buy = self.fund_buy_names[0]
        lines = [
            f"{title_bar('我的理财')}",
            f"👤 {user_name}",
            "",
        ]
        if principal <= 0:
            lines += [
                "💼 当前没有买入理财",
                "",
                f"💡 买入：「{cmd_buy} 金额」",
                f"　 例：「{cmd_buy} 10000」或「{cmd_buy} 全部」",
                f"　 每天随机盈亏，盈利加本金、亏损扣本金",
            ]
            return "\n".join(lines)
        lines += [
            f"💼 当前本金：{fmt_num(principal)} {self._sn()}",
            f"📊 累计盈亏：{'+' if int(f.get('total_pnl', 0) or 0) >= 0 else ''}"
            f"{fmt_num(int(f.get('total_pnl', 0) or 0))}",
            f"📅 已持有：{int(f.get('days', 0) or 0)} 天",
            f"🕐 上次结算：{f.get('last_date') or '—'}",
            "",
            self._fund_status_line(f),
            "",
            f"💡 追加：「{cmd_buy} 金额」",
            f"💡 取出：「{self.fund_sell_names[0]}」"
            f"（取出后进**银行账户**）",
            f"💡 全部取出：「{self.fund_sell_names[0]} 全部」",
        ]
        return "\n".join(lines)

    def do_fund_buy(self, event, arg: str = "") -> str:
        """「购买理财 金额」：从钱包掏钱买入（追加）"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        if not getattr(self, "fund_enable", True):
            return "⚠️ 理财功能未开启"
        user_id = get_user_id(event)
        # ★★ 1.7.6：理财算**银行功能**的一部分 —— 银行冻结时也不能用
        _fz = self.bank_frozen_msg(group_id, user_id)
        if _fz:
            return _fz
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u["name"] = user_name
        # ★ 先结算已有的（避免把今天的盈亏算到新本金上）
        self.fund_settle(group_id, user_id)
        u = self._guser(group_id, user_id) or u
        f = self._fund_of(u)
        cmd = self.fund_buy_names[0]
        wallet = int(u.get("total_score", 0) or 0)
        amount = self._parse_amount(arg, wallet)
        if amount == -1:
            return f"⚠️ 数量无效\n💡 用法：「{cmd} 100」或「{cmd} all」"
        if amount == 0:
            _cur = int(f.get("principal", 0) or 0)
            return "\n".join([
                f"{title_bar('购买理财')}",
                f"👤 {user_name}",
                f"💼 当前本金：{fmt_num(_cur)}",
                f"💳 持有{self._sn()}：{fmt_num(wallet)}",
                "",
                f"💡 用法：「{cmd} 100」或「{cmd} all」",
            ])
        if amount > wallet:
            return (f"⚠️ 持有{self._sn()}不足（当前 {fmt_num(wallet)}）\n"
                    f"💡 想全买就发「{cmd} all」")
        u["total_score"] = wallet - amount
        f["principal"] = int(f.get("principal", 0) or 0) + amount
        # ★ 首次买入：把 last_date 设为今天，**今天不结算**
        #   （否则刚买完一次查看就立刻盈亏，体验很差）
        if not str(f.get("last_date") or ""):
            f["last_date"] = _today_str()
        self._save()
        return "\n".join([
            f"{title_bar('买入理财')}",
            f"👤 {user_name}",
            f"💼 买入：+{fmt_num(amount)} {self._sn()}",
            f"📊 当前本金：{fmt_num(f['principal'])}",
            f"💳 持有{self._sn()}：{fmt_num(u['total_score'])}",
            "",
            "📈 之后**每天随机盈亏**一次：",
            f"　 盈利最多 +{self.fmt_bonus(getattr(self, 'fund_profit_max', 8))}%",
            f"　 亏损最多 -{self.fmt_bonus(getattr(self, 'fund_loss_max', 6))}%",
            "　 亏损先从本金扣，本金不够会从你的资产里补",
            f"💡 查看：「{self.fund_trigger_names[0]}」",
        ])

    def do_fund_sell(self, event, arg: str = "") -> str:
        """「取出理财 [金额]」：先把本金（含盈亏）转进银行账户"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        if not getattr(self, "fund_enable", True):
            return "⚠️ 理财功能未开启"
        user_id = get_user_id(event)
        # ★★ 1.7.6：理财算**银行功能**的一部分 —— 银行冻结时也不能用
        _fz = self.bank_frozen_msg(group_id, user_id)
        if _fz:
            return _fz
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        # ★ 先结算，才拿到最新本金
        self.fund_settle(group_id, user_id)
        u = self._guser(group_id, user_id) or u
        f = self._fund_of(u)
        principal = int(f.get("principal", 0) or 0)
        cmd = self.fund_sell_names[0]
        if principal <= 0:
            return (f"⚠️ 你没有买入理财\n"
                    f"💡 先买入：「{self.fund_buy_names[0]} 金额」")

        s = str(arg or "").strip().lower()
        if not s or s in ("all", "全部", "所有"):
            amount = principal          # 默认全部取出
        elif s.isdigit() and int(s) > 0:
            amount = min(int(s), principal)
        else:
            return f"⚠️ 数量无效\n💡 用法：「{cmd}」全部取出 或「{cmd} 1000」"

        u["bank"] = int(u.get("bank", 0) or 0) + amount
        f["principal"] = principal - amount
        if f["principal"] <= 0:
            # 清盘：重置记录，下次买入重新开始
            f["principal"] = 0
            f["last_date"] = ""
            f["total_pnl"] = 0
            f["last_pnl"] = 0
            f["last_rate"] = 0.0
            f["days"] = 0
        self._save()
        return "\n".join([
            f"{title_bar('取出理财')}",
            f"👤 {user_name}",
            f"📤 取出：+{fmt_num(amount)} {self._sn()}",
            "",
            f"🏦 银行余额：{fmt_num(u['bank'])}",
            f"💼 剩余本金：{fmt_num(f['principal'])}",
            "",
            "✅ 取出的钱已进**银行账户**",
        ])

    def do_deposit(self, event, arg: str) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u["name"] = user_name
        wallet = int(u.get("total_score", 0))
        amount = self._parse_amount(arg, wallet)
        if amount == -1:
            return (
                f"⚠️ 数量无效\n"
                f"用法：「{self.bank_deposit_names[0]} 100」"
                f"或「{self.bank_deposit_names[0]} all」"
            )
        if amount == 0:
            return (
                f"⚠️ 请指定存款数量\n"
                f"用法：「{self.bank_deposit_names[0]} 100」"
                f"或「{self.bank_deposit_names[0]} all」"
            )
        if amount > wallet:
            return f"⚠️ 持有{self._sn()}不足（当前 {fmt_num(wallet)}）"
        u["total_score"] = wallet - amount
        u["bank"] = int(u.get("bank", 0)) + amount
        self._save()
        return "\n".join([
            f"{title_bar('存入银行')}",
            f"👤 {user_name}",
            f"💰 存入：+{amount}",
            f"🏦 银行余额：{fmt_num(u['bank'])}",
            f"💳 持有{self._sn()}：{fmt_num(u['total_score'])}",
        ])

    def do_withdraw(self, event, arg: str) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录"
        u["name"] = user_name
        bank = int(u.get("bank", 0))
        amount = self._parse_amount(arg, bank)
        if amount == -1:
            return (
                f"⚠️ 数量无效\n"
                f"用法：「{self.bank_withdraw_names[0]} 100」"
                f"或「{self.bank_withdraw_names[0]} all」"
            )
        if amount == 0:
            return (
                f"⚠️ 请指定取款数量\n"
                f"用法：「{self.bank_withdraw_names[0]} 100」"
                f"或「{self.bank_withdraw_names[0]} all」"
            )
        if amount > bank:
            return f"⚠️ 银行余额不足（当前 {fmt_num(bank)}）"
        u["bank"] = bank - amount
        u["total_score"] = int(u.get("total_score", 0)) + amount
        self._save()
        return "\n".join([
            f"{title_bar('从银行取出')}",
            f"👤 {user_name}",
            f"💰 取出：+{amount}",
            f"🏦 银行余额：{fmt_num(u['bank'])}",
            f"💳 持有{self._sn()}：{fmt_num(u['total_score'])}",
        ])

    # ------------------------------------------------------------
    # 银行冻结（抢银行失败惩罚，1.7.6）
    # ------------------------------------------------------------
    def frozen_until(self, group_id, uid) -> int:
        """银行解冻时间戳（0 = 没被冻结）"""
        try:
            u = self._guser(group_id, str(uid)) or {}
        except Exception:
            return 0
        try:
            return max(0, int(u.get("bank_frozen_until", 0) or 0))
        except Exception:
            return 0

    def list_frozen(self) -> list:
        """
        ★★ 1.7.7：列出**所有仍在冻结中**的银行账号（后台展示 / 解冻用）。

        返回 [{group_id, user_id, name, until, left_text, left_secs}, ...]，
        按剩余时间从多到少排（冻结最狠的排前面）。
        """
        out = []
        now = int(time.time())
        try:
            users = self.users if isinstance(self.users, dict) else {}
        except Exception:
            return out
        for gid, bucket in list(users.items()):
            if not isinstance(bucket, dict):
                continue
            for uid, u in list(bucket.items()):
                if not isinstance(u, dict):
                    continue
                try:
                    until = int(u.get("bank_frozen_until", 0) or 0)
                except Exception:
                    until = 0
                if until <= now:          # 没冻结 / 已过期
                    continue
                nm = str(u.get("name") or "").strip() or f"QQ{uid}"
                out.append({
                    "group_id": str(gid),
                    "user_id": str(uid),
                    "name": nm,
                    "until": until,
                    "left_secs": until - now,
                    "left_text": self.freeze_left_text(gid, uid),
                    "until_text": time.strftime("%Y-%m-%d %H:%M",
                                                time.localtime(until)),
                })
        out.sort(key=lambda x: -int(x.get("left_secs", 0)))
        return out

    def unfreeze(self, group_id, uid) -> bool:
        """
        ★★ 1.7.7：**提前解除**某个账号的银行冻结。

        返回 True = 确实解冻了；False = 本来就没冻结（或找不到人）。
        """
        try:
            u = self._guser(group_id, str(uid))
        except Exception:
            return False
        if not isinstance(u, dict):
            return False
        try:
            if int(u.get("bank_frozen_until", 0) or 0) <= 0:
                return False
        except Exception:
            return False
        u["bank_frozen_until"] = 0
        try:
            self._save()
        except Exception:
            logger.exception("[checkin] 解冻保存失败")
        return True

    def unfreeze_by_qq(self, qq: str) -> int:
        """
        ★★ 1.7.7：按 **QQ 号**解冻（全部群都解）。返回解冻的条数。

        ★ 冻结是**按群**存的，所以同一个 QQ 可能在多个群各有一条；
          后台填单个 QQ 号时把它的冻结全清掉，符合直觉。
        """
        q = str(qq or "").strip()
        if not q:
            return 0
        n = 0
        try:
            users = self.users if isinstance(self.users, dict) else {}
        except Exception:
            return 0
        for _gid, bucket in list(users.items()):
            if not isinstance(bucket, dict):
                continue
            u = bucket.get(q)
            if not isinstance(u, dict):
                continue
            try:
                if int(u.get("bank_frozen_until", 0) or 0) <= 0:
                    continue
            except Exception:
                continue
            u["bank_frozen_until"] = 0
            n += 1
        if n:
            try:
                self._save()
            except Exception:
                logger.exception("[checkin] 批量解冻保存失败")
        return n

    def freeze_left_text(self, group_id, uid) -> str:
        """剩余冻结时长文案（未冻结返回空串）"""
        until = self.frozen_until(group_id, uid)
        if until <= 0:
            return ""
        left = until - int(time.time())
        if left <= 0:
            return ""
        days, rem = divmod(left, 86400)
        hours, rem = divmod(rem, 3600)
        mins = rem // 60
        if days > 0:
            return f"{days} 天 {hours} 小时"
        if hours > 0:
            return f"{hours} 小时 {mins} 分钟"
        return f"{max(1, mins)} 分钟"

    def bank_status_text(self, group_id, uid) -> str:
        """
        ★★ 1.7.7：「银行状态」文案 —— 未冻结 或 解冻时间。

        给「签到统计」用的独立一行，两种形态：
          · 没冻结      -> "🟢 未冻结"
          · 冻结中      -> "🔴 冻结中\\n　 解冻时间：2026-10-15 20:30:00"
            （解冻时间**换行**显示，一行放不下会显得很长）
        ★ 冻结已过期（时间戳过了但没清理）也算未冻结。
        """
        until = self.frozen_until(group_id, uid)
        if until <= 0 or until <= int(time.time()):
            return "🟢 未冻结"
        return f"🔴 冻结中\n　 解冻时间：{_fmt_time(until)}"

    def bank_frozen_msg(self, group_id, uid) -> str:
        """
        冻结中 -> 返回提示文案；没冻结 -> 返回空串。

        ★ 所有银行操作（查询/存/取/借/还/借款信息）**以及抢银行**都要先过
          这一关 —— 1.7.7 起冻结中也抢不了银行（解冻后才能继续抢）。
        """
        until = self.frozen_until(group_id, uid)
        if until <= 0:
            return ""
        left = until - int(time.time())
        if left <= 0:
            # 已过期：顺手清掉标记
            try:
                u = self._guser(group_id, str(uid))
                if isinstance(u, dict) and u.get("bank_frozen_until"):
                    u["bank_frozen_until"] = 0
                    self._save()
            except Exception:
                pass
            return ""
        return "\n".join([
            "🚫 你的银行账户处于**冻结**状态",
            f"🕐 剩余：{self.freeze_left_text(group_id, uid)}",
            "💡 冻结期间无法进行任何银行操作（存/取/借/还/查询），也**不能抢银行**",
        ])

    def _rob_day_start(self) -> int:
        """抢银行的「今天」起点（用签到模块同一套逻辑日）"""
        try:
            return int(self._day_start())
        except Exception:
            pass
        try:
            now = datetime.datetime.now()
            return int(time.mktime(
                datetime.datetime(now.year, now.month, now.day).timetuple()))
        except Exception:
            return 0

    def _glottery(self, group_id) -> dict:
        """某群的抽奖记录：{日期起点: {用户号: 次数}}"""
        gid = self._gid(group_id)
        bucket = self.lotteries.get(gid)
        if not isinstance(bucket, dict):
            self.lotteries.setdefault(gid, {})
            bucket = self.lotteries[gid]
        return bucket

    def lottery_used_today(self, group_id, uid) -> int:
        """今天已经抽了几次"""
        today_key = str(self._day_start())
        try:
            return max(0, int(self._glottery(group_id)
                              .get(today_key, {}).get(str(uid), 0) or 0))
        except Exception:
            return 0

    def lottery_left_today(self, group_id, uid) -> int:
        """
        今天还能抽几次。

        ★ 返回 -1 表示**不限次数**（lottery_daily_limit = 0）。
        """
        lim = int(getattr(self, "lottery_daily_limit", 0) or 0)
        if lim <= 0:
            return -1
        return max(0, lim - self.lottery_used_today(group_id, uid))

    def _gpool(self, group_id) -> dict:
        """某群的奖池记录：{日期起点: {...}}"""
        gid = self._gid(group_id)
        bucket = self.pools.get(gid)
        if not isinstance(bucket, dict):
            self.pools.setdefault(gid, {})
            bucket = self.pools[gid]
        return bucket

    def match_pool_trigger(self, text: str) -> bool:
        """
        「参与抽奖」——**没有参数**。

        ★ 返回 True/False（不是 (mode, arg)），带参数不命中。
        """
        if not self.enable or not self.lottery_enable or not self.pool_enable:
            return False
        for name in self.pool_trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def match_pool_info_trigger(self, text: str) -> bool:
        """「奖池」——查看今日奖池与名额（没有参数）"""
        if not self.enable or not self.lottery_enable or not self.pool_enable:
            return False
        for name in self.pool_info_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def _pool_today(self, group_id) -> dict:
        """
        取本群「今天这一期」奖池。

        ★ 数据结构（1.7.6 修正）：
            g[day] = {
                "pot":   当日奖池金额（**当天固定**，只在跨天时重新随机）,
                "fee"/"slots"/"hours": 当天的配置快照,
                "rounds": [ {members, opened, ts, opened_ts}, ... ],
            }

        ★ 为什么要这样分层：
          之前「奖池金额」和「这一期」存在同一条记录里，
          开奖后为了开新一期会把整条删掉 -> 金额被**重新随机**，
          于是同一天里金额一直变。现在金额挂在「天」上，
          当天无论开几期都用同一个数，只有跨天才重随机。
        """
        import random as _random
        key = str(self._day_start())
        g = self._gpool(group_id)
        day = g.get(key)
        if not isinstance(day, dict) or "rounds" not in day:
            # ★ 兼容旧结构（老记录直接就是一期）：
            #   有旧数据时保留它的 pot，别重新随机
            old = day if isinstance(day, dict) else {}
            lo = max(0, int(getattr(self, "pool_min", 0) or 0))
            hi = max(lo, int(getattr(self, "pool_max", lo) or lo))
            pot = old.get("pot")
            if pot in (None, ""):
                pot = _random.randint(lo, hi) if hi > 0 else 0
            try:
                pot = max(0, int(pot))
            except Exception:
                pot = 0
            day = {
                # ★ 当天固定金额
                "pot": pot,
                "fee": max(0, int(getattr(self, "pool_fee", 0) or 0)),
                "slots": max(1, int(getattr(self, "pool_slots", 1) or 1)),
                "hours": float(getattr(self, "pool_timeout_hours", 0) or 0),
                "rounds": [],
            }
            # 迁移旧的一期数据（如果有人参与过）
            _om = [str(x) for x in (old.get("members") or [])]
            if _om or old.get("opened"):
                _r = {
                    "members": _om,
                    "opened": old.get("opened"),
                    "ts": int(old.get("ts") or time.time()),
                    "opened_ts": 0,
                }
                if _r["opened"]:
                    _r["opened_ts"] = int(
                        (_r["opened"] or {}).get("ts") or 0)
                day["rounds"].append(_r)
            g[key] = day
            # 只留最近 7 天
            if len(g) > 7:
                for _k in sorted(g.keys())[:-7]:
                    g.pop(_k, None)

        rounds = day.get("rounds")
        if not isinstance(rounds, list):
            rounds = []
            day["rounds"] = rounds

        # ★ 清理：已开奖且**开奖已满 auto_new_hours 小时**的期（或跨越到新的一期时）
        opened_rs = [r for r in rounds
                     if isinstance(r, dict) and r.get("opened")]
        unopened = [r for r in rounds
                    if isinstance(r, dict) and not r.get("opened")]
        if opened_rs:
            # 如果已经有一期在跑（未开奖），就不再保留历史已开奖期
            keep_opened = [] if unopened else opened_rs[-1:]
            day["rounds"] = keep_opened + unopened
            rounds = day["rounds"]

        # 当前这一期 = 最后一期未开奖的；没有就新建
        for r in rounds:
            if isinstance(r, dict) and not r.get("opened"):
                return r
        r = {
            "members": [],
            "opened": None,
            "ts": int(time.time()),
            "opened_ts": 0,
        }
        rounds.append(r)
        g[key] = day
        return r

    def pool_pot_today(self, group_id) -> int:
        """当日奖池金额（当天固定，跨天才变）"""
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start())) or {}
            return max(0, int(day.get("pot", 0) or 0))
        except Exception:
            return 0

    def pool_fee_today(self, group_id) -> int:
        """当期入门费（存在「天」层级；缺失时回落到配置）"""
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start())) or {}
            v = day.get("fee")
            if v in (None, ""):
                return max(0, int(getattr(self, "pool_fee", 0) or 0))
            return max(0, int(v))
        except Exception:
            return max(0, int(getattr(self, "pool_fee", 0) or 0))

    def pool_slots_today(self, group_id) -> int:
        """当期名额（存在「天」层级；缺失时回落到配置）"""
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start())) or {}
            v = day.get("slots")
            if v in (None, ""):
                return max(1, int(getattr(self, "pool_slots", 1) or 1))
            return max(1, int(v))
        except Exception:
            return max(1, int(getattr(self, "pool_slots", 1) or 1))

    @staticmethod
    def _split_pot(total: int, n: int) -> list:
        """
        把 total **全额随机**分给 n 个人（总和严格等于 total）。

        做法：先给每个人一份保底，剩下的用「按权重随机切分」分配，
        最后把因取整产生的零头补给随机的人 —— 保证一分不剩。
        """
        import random as _random
        if n <= 0:
            return []
        total = max(0, int(total))
        if total <= 0:
            return [0] * n
        if n == 1:
            return [total]
        # 保底：每人至少 floor(total/n * 0.15)，但不超过均分
        avg = total // n
        base = max(0, min(avg, (avg * 15) // 100))
        rest = total - base * n
        if rest <= 0:
            out = [avg] * n
            out[0] += total - sum(out)
            return out
        # 用随机权重切分 rest（Dirichlet 思路：指数分布归一化）
        w = [_random.random() + 1e-9 for _ in range(n)]
        s = sum(w)
        shares = [int(rest * (x / s)) for x in w]
        # 零头补给随机的人，保证总和精确
        left = total - (base * n + sum(shares))
        idx = list(range(n))
        _random.shuffle(idx)
        k = 0
        while left > 0 and idx:
            shares[idx[k % n]] += 1
            left -= 1
            k += 1
        return [base + x for x in shares]

    def _pool_open(self, group_id, cur: dict) -> list:
        """
        开奖：把**当日奖池金额**全额随机分给所有参与者，直接进各自钱包。

        ★ 金额取自「天」层级（当天固定），不是期自己的。
        返回 [(uid, 金额), ...]
        """
        members = [str(x) for x in (cur.get("members") or [])]
        pot = self.pool_pot_today(group_id)
        if not members:
            cur["opened"] = {"results": [], "pot": pot,
                             "ts": int(time.time())}
            return []
        shares = self._split_pot(pot, len(members))
        results = []
        for uid, amt in zip(members, shares):
            if amt > 0:
                u = self._guser_setdefault(group_id, uid, {
                    "total_score": 0, "total_checkin": 0, "last_date": "",
                    "streak": 0, "month_map": {}, "bank": 0,
                })
                u["total_score"] = int(u.get("total_score", 0)) + amt
            results.append((uid, int(amt)))
        cur["opened"] = {"results": [[a, b] for a, b in results],
                         "pot": pot, "ts": int(time.time())}
        return results

    def _pool_deadline(self, cur: dict) -> float:
        """
        本奖池的开奖截止时间戳；0 = 不自动开奖。

        ★★ 1.7.7：倒计时从**第一个人参与**那一刻开始（`first_ts`），
          而不是奖池创建时间（`ts`）。

          为什么改：以前奖池一被创建就开始倒计时，如果半天没人参与，
          时间一到就「自动开奖」，可名单是空的 —— 白开一期，
          还把当天奖池金额结算掉了。现在**没人参与就永远不开奖**。

        ★ 兼容旧数据：没有 `first_ts` 但**已经有人参与**的期，
          退回用 `ts`（否则那些期永远不开）。
          没人参与 -> 直接返回 0（不开奖）。
        """
        try:
            hours = float(cur.get("hours")
                          or getattr(self, "pool_timeout_hours", 0) or 0)
        except Exception:
            hours = 0.0
        if hours <= 0:
            return 0.0
        try:
            first = int(cur.get("first_ts", 0) or 0)
        except Exception:
            first = 0
        if first <= 0:
            # ★ 兼容：老数据只有 ts；仅当**已经有人参与**时才认它
            if not [x for x in (cur.get("members") or []) if str(x).strip()]:
                return 0.0
            try:
                first = int(cur.get("ts", 0) or 0)
            except Exception:
                first = 0
        if first <= 0:
            return 0.0
        return first + hours * 3600.0

    def _pool_expired(self, cur: dict) -> bool:
        """是否已到自动开奖时间"""
        dl = self._pool_deadline(cur)
        return bool(dl > 0 and time.time() >= dl)

    def pool_timeout_text(self, group_id) -> str:
        """
        剩余时间说明（给参与/查询文案用）。

        ★ 没人参与就**不催**（没有倒计时）—— 因为没人参与时不会自动开奖，
          显示倒计时会误导。
        """
        cur = self._pool_today(group_id)
        if not cur or cur.get("opened"):
            return ""
        if not (cur.get("members") or []):
            return ""
        dl = self._pool_deadline(cur)
        if dl <= 0:
            return ""
        left = int(dl - time.time())
        if left <= 0:
            return "⏰ 已到自动开奖时间"
        h, rem = divmod(left, 3600)
        m = rem // 60
        if h > 0:
            return f"⏳ 距自动开奖还有 {h} 小时 {m} 分钟"
        return f"⏳ 距自动开奖还有 {m} 分钟"

    def _pool_split_text(self, group_id, cur: dict) -> str:
        """已开奖 -> 拆成独立文本行；未开奖 -> 空串"""
        if not cur or not cur.get("opened"):
            return ""
        res = (cur.get("opened") or {}).get("results") or []
        pot = max(0, int((cur.get("opened") or {}).get("pot")
                         or self.pool_pot_today(group_id) or 0))
        lines = [f"{title_bar('🎊 奖池开奖 🎊')}", "",
                 f"💰 奖池总额：**{pot}** {self._sn()}（全额分完）",
                 f"👥 参与人数：{len(res)}", ""]
        order = sorted(((str(a), int(b)) for a, b in res),
                       key=lambda x: -x[1])
        for i, (uid, amt) in enumerate(order, start=1):
            try:
                # ★ 1.7.6：必须传 group_id，否则会显示别的群的昵称
                nm = self._nick_of(group_id, uid)
            except Exception:
                nm = f"QQ{uid}"
            tag = " 🏆" if i == 1 and amt > 0 else ""
            lines.append(f"  {i}. {nm} — +{amt}{tag}")
        lines += ["", f"✅ 共发出 {sum(a for _u, a in order)} {self._sn()}",
                  "💡 参与抽奖开始新一期奖池"]
        return "\n".join(lines)

    def _pool_reset(self, group_id):
        """
        结束「当前这一期」，让 `_pool_today` 下一轮开新的一期。

        ★ 1.7.6 修正：**只清当期，不动当天金额**。
          以前是 `g.pop(day)` 把整天的记录删掉，导致
          `_pool_today` 重新随机金额 —— 表现就是「当天金额一直变」。
          现在金额挂在「天」上，这里只把未开奖的期清掉。

        ★ 保留**最近一期已开奖结果**（便于查账 / 排重），
          新一期会在它后面追加。
        """
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start()))
            if not isinstance(day, dict):
                return
            rounds = [r for r in (day.get("rounds") or [])
                      if isinstance(r, dict)]
            opened = [r for r in rounds if r.get("opened")]
            # 未开奖的期丢掉；只留最后一期已开奖的
            day["rounds"] = opened[-1:] if opened else []
            g[str(self._day_start())] = day
        except Exception:
            logger.exception("[checkin] 重置奖池失败")

    def pool_tick(self, group_id):
        """
        超时检查：到点了就把奖池开掉。

        返回开奖文本列表（未触发返回空列表）。

        ★ 触发条件（必须同时满足）：
          · 当期**有人参与**（没人参与不开奖、不播报、不重置）
          · 已到自动开奖时间（**第一个参与者**的时间 + 配置小时数）

        ★ 由两处调用：
          · 群里发「参与抽奖」时（在此之前先结算上期）
          · 群里有任意消息时（on_msg 里轻量检查）
        """
        if not self.enable or not self.pool_enable:
            return []
        if not self._is_group_allowed(group_id, "lottery"):
            return []
        cur = self._pool_today(group_id)
        if not cur or cur.get("opened"):
            return []
        members = [str(x) for x in (cur.get("members") or [])]
        # ★ 没人参与 -> 什么都不做（不自动开奖、不重置、不播报）
        if not members:
            return []
        if not self._pool_expired(cur):
            return []
        results = self._pool_open(group_id, cur)
        txt = self._pool_open_text(group_id, "", cur, results, joined=False)
        # ★ 结果已经在这条消息里了，直接开新一期（金额不变，仍是当天的数）
        self._pool_reset(group_id)
        self._save()
        txt = txt.replace(f"{title_bar('🎊 奖池开奖 🎊')}",
                          "⏰ 名额没满，**到时间自动开奖**了！", 1)
        return [txt]

    # ------------------------------------------------------------
    # 「每人每天一轮」记录（天级）：
    #   pools[群][天]["draws"] = {用户号: 今天已参与的轮数}
    #   ★ 单独记在「天」上，而不是记在「期」上 ——
    #     否则开奖后开了新一期，同一个人又能再参与一次。
    # ------------------------------------------------------------
    def _pday(self, group_id) -> dict:
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start()))
            if isinstance(day, dict):
                self._pool_today(group_id)      # 确保结构升级完成
                g = self._gpool(group_id)
                day = g.get(str(self._day_start())) or {}
                d = day.get("draws")
                if not isinstance(d, dict):
                    d = {}
                    day["draws"] = d
                    g[str(self._day_start())] = day
                return d
        except Exception:
            logger.exception("[checkin] 读取奖池参与记录失败")
        return {}

    def pday_used(self, group_id, uid) -> int:
        """今天这个人参与了几轮"""
        try:
            return max(0, int(self._pday(group_id).get(str(uid), 0) or 0))
        except Exception:
            return 0

    def pday_left(self, group_id, uid) -> int:
        """
        今天这个人还能参与几轮。

        ★ 按配置返回「每天最多几轮」：
          · pool_per_user_per_day = 0 -> 不限（返回 -1）
          · 默认 1 -> 每人每天只能参与一轮
        """
        lim = int(getattr(self, "pool_per_day", 1) or 0)
        if lim <= 0:
            return -1
        return max(0, lim - self.pday_used(group_id, uid))

    def _pday_mark(self, group_id, uid):
        """记一次参与"""
        try:
            d = self._pday(group_id)
            d[str(uid)] = int(d.get(str(uid), 0) or 0) + 1
        except Exception:
            pass

    def _pool_new_round(self, group_id):
        """沿用**当天金额**开新一期，返回新一期 dict"""
        try:
            g = self._gpool(group_id)
            day = g.get(str(self._day_start()))
            if isinstance(day, dict):
                day["rounds"] = []
                g[str(self._day_start())] = day
        except Exception:
            pass
        return self._pool_today(group_id)

    def _pool_settle(self, group_id):
        """
        结算「到点但没人管的过期期」。

        返回 (要发送的文本, 是否触发了结算)。
        ★ 没人参与的过期期**不开奖也不播报**，只是不再占用。
        """
        cur = self._pool_today(group_id)
        if not cur or cur.get("opened"):
            return "", False
        members = [str(x) for x in (cur.get("members") or [])]
        if not members:
            return "", False
        if not self._pool_expired(cur):
            return "", False
        res = self._pool_open(group_id, cur)
        txt = self._pool_open_text(group_id, "", cur, res, joined=False)
        txt = txt.replace(f"{title_bar('🎊 奖池开奖 🎊')}",
                          "⏰ 名额没满，**到时间自动开奖**了！", 1)
        return txt, True

    def do_pool_join(self, event) -> str:
        """
        参与抽奖（奖池）：**没有参数**。

        · 交入门费（**归系统**，不退）
        · 名额满 -> **立刻开奖**：**当日奖池金额**全额随机分给所有参与者
        · 名额没满 -> 到时间自动开奖
        · **每人每天只能参与一轮**（后台可改）
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        if not self._is_group_allowed(group_id, "lottery"):
            return ""
        if not self.lottery_enable:
            return "⚠️ 抽奖功能未开启"
        if not self.pool_enable:
            return "⚠️ 奖池功能未开启"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        cmd = (self.pool_trigger_names or ["参与抽奖"])[0]

        # ---- ① 先结算上一期（超时未开奖的）----
        _settled, _did = self._pool_settle(group_id)
        if _did:
            self._pool_reset(group_id)
            self._save()

        cur = self._pool_today(group_id)
        members = [str(x) for x in (cur.get("members") or [])]
        # ★ 名额 / 入门费 / 金额都存在「天」层级（当天固定）
        slots = self.pool_slots_today(group_id)
        fee = self.pool_fee_today(group_id)
        pot = self.pool_pot_today(group_id)

        # ---- ② 每人每天一轮 ----
        if self.pday_left(group_id, user_id) == 0:
            lines = [f"{title_bar('参与抽奖')}",
                     f"👤 {user_name}",
                     "⚠️ 你今天已经参与过一轮了"
                     f"（每人每天 {int(self.pool_per_day or 1)} 轮）"]
            if _settled:
                lines = _settled.splitlines() + [""] + lines
            lines.append("💡 明天再来")
            return "\n".join(lines)

        # ---- ③ 本期内重复参与 -> 拦住 ----
        if str(user_id) in members:
            return "\n".join([
                f"{title_bar('参与抽奖')}",
                f"👤 {user_name}",
                "✅ 你已在本期名单里，等名额满或到点开奖",
                f"👥 名额：{len(members)} / {slots}",
            ])

        # ---- ④ 钱够不够 ----
        _avail = (self.avail_funds(group_id, user_id)
                  if getattr(self, "use_bank_pay", True)
                  else int(self.get_score(group_id, user_id)))
        if fee > 0 and _avail < fee:
            return self.short_hint(group_id, user_id, fee)

        # ---- ⑤ 扣入门费（归系统，先钱包再银行）----
        _pay = {"from_wallet": 0, "from_bank": 0}
        if fee > 0:
            _pay = self.pay(group_id, user_id, fee,
                            allow_bank=getattr(self, "use_bank_pay", True))
            if not _pay.get("ok"):
                return self.short_hint(group_id, user_id, fee)

        members.append(str(user_id))
        cur["members"] = members
        # ★★ 1.7.7：**第一个人参与时才开始倒计时** ——
        #   记下首位参与者的时间，`_pool_deadline` 用它做起点。
        #   （以前用创建时间，奖池一被创建就开跑，没人参与也会自动开奖。）
        try:
            if not int(cur.get("first_ts", 0) or 0):
                cur["first_ts"] = int(time.time())
        except Exception:
            cur["first_ts"] = int(time.time())
        self._pday_mark(group_id, user_id)
        try:
            u = self._guser(group_id, user_id)
            u["name"] = user_name
        except Exception:
            pass
        self._save()

        # ---- ⑥ 名额满 -> 立刻开奖 ----
        if len(members) >= slots:
            results = self._pool_open(group_id, cur)
            _txt = self._pool_open_text(group_id, user_name, cur, results,
                                        joined=True)
            self._pool_reset(group_id)
            self._save()
            if _settled:
                return _settled + "\n\n" + "─" * 20 + "\n\n" + _txt
            return _txt

        # ---- ⑦ 还没满：通报进度 ----
        lines = [
            f"{title_bar('参与抽奖')}",
            f"👤 {user_name}",
            f"🎫 已交入门费：-{fee} {self._sn()}",
        ]
        if fee > 0 and (_pay.get("from_bank") or 0) > 0:
            # ★ 1.7.7：这里的 pay() **不掏保险箱**，所以明细只有钱包/银行
            lines.append(f"　 （钱包 -{_pay.get('from_wallet', 0)}，"
                         f"银行 -{_pay.get('from_bank', 0)}）")
        lines += [
            "✅ 参与成功！",
            "",
            f"👥 名额：{len(members)} / {slots}",
            f"💰 当期奖池：{pot} {self._sn()}",
            f"⏳ 还差 **{slots - len(members)}** 人开奖",
        ]
        _tt = self.pool_timeout_text(group_id)
        if _tt:
            lines.append(_tt)
            lines.append("　 （倒计时从**第一个人参与**开始算）")
        else:
            lines.append("⏳ 还没人参与，**参与后才开始倒计时**")
        _lf = self.pday_left(group_id, user_id)
        if _lf >= 0:
            lines.append(f"🎯 今日可参与：{_lf} 轮（每人每天 "
                         f"{int(self.pool_per_day or 1)} 轮）")
        lines += ["", f"💡 发「{cmd}」参与；名额满立刻开奖"]
        if _settled:
            return _settled + "\n\n" + "─" * 20 + "\n\n" + "\n".join(lines)
        return "\n".join(lines)

    def _pool_open_text(self, group_id, joined_name, cur, results,
                        joined=False) -> str:
        """开奖结果文案（奖池总额取**当天**金额）"""
        pot = max(0, int((cur.get("opened") or {}).get("pot")
                         or self.pool_pot_today(group_id) or 0))
        nm = {}
        for uid, _amt in results:
            try:
                nm[str(uid)] = self._nick_of(group_id, uid)
            except Exception:
                nm[str(uid)] = f"QQ{uid}"
        lines = [f"{title_bar('🎊 奖池开奖 🎊')}"]
        if joined:
            lines.append(f"👤 {joined_name} 参与后名额满了！")
        lines += [
            f"💰 奖池总额：**{pot}** {self._sn()}（全额分完）",
            f"👥 参与人数：{len(results)}",
            "",
        ]
        # 按金额从多到少列（同额按名次）
        order = sorted(results, key=lambda x: -x[1])
        for i, (uid, amt) in enumerate(order, start=1):
            tag = " 🏆" if i == 1 and amt > 0 else ""
            lines.append(f"  {i}. {nm.get(str(uid), uid)} — +{amt}{tag}")
        total = sum(a for _u, a in results)
        lines += [
            "",
            f"✅ 共发出 {total} {self._sn()}，奖池已清空",
            "💡 明天奖池重新随机，名额满即开",
        ]
        return "\n".join(lines)

    def do_pool_info(self, event) -> str:
        """查看今日奖池与名额"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        if not self._is_group_allowed(group_id, "lottery"):
            return ""
        if not self.pool_enable:
            return "⚠️ 奖池功能未开启"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        cur = self._pool_today(group_id)
        members = [str(x) for x in (cur.get("members") or [])]
        slots = self.pool_slots_today(group_id)
        fee = self.pool_fee_today(group_id)
        # ★ 当日金额（当天固定，跨天才变）
        pot = self.pool_pot_today(group_id)
        cmd = (self.pool_trigger_names or ["参与抽奖"])[0]
        lines = [
            f"{title_bar('今日奖池')}",
            f"👤 {user_name}",
            f"💰 奖池金额：**{pot}** {self._sn()}"
            f"（当天固定，跨天才变）",
            f"👥 名额：{len(members)} / {slots}",
            f"🎫 入门费：{fee} {self._sn()}（归系统，不退）",
            "",
        ]
        _tt = self.pool_timeout_text(group_id)
        if _tt:
            lines.append(_tt)
            lines.append("　 （倒计时从**第一个人参与**开始算）")
        else:
            # ★★ 1.7.7：没人参与时不开奖，所以这里明确说明
            lines.append("⏳ 还没人参与，**参与后才开始倒计时**")
        _lf = self.pday_left(group_id, user_id)
        if _lf < 0:
            lines.append("🎯 今日参与：不限轮数")
        elif _lf > 0:
            lines.append(f"🎯 今日还能参与：{_lf} 轮")
        else:
            lines.append("🚫 今天你已经参与过一轮了，明天再来")
        if str(user_id) in members:
            lines.append("✅ 你已在本期名单里，等名额满或到点开奖")
        elif _lf != 0:
            lines.append(f"💡 发「{cmd}」参与"
                         f"（每人每天 {int(self.pool_per_day or 1)} 轮）")
        if members:
            names = []
            for uid in members[:12]:
                try:
                    names.append(self._nick_of(group_id, uid))
                except Exception:
                    names.append(f"QQ{uid}")
            more = "" if len(members) <= 12 else f" …等 {len(members)} 人"
            lines += ["", f"🙋 已参与：{'、'.join(names)}{more}"]
        return "\n".join(lines)

    def match_rob_trigger(self, text: str) -> bool:
        """
        「抢银行」——**没有参数**。

        ★ 返回 True/False（不是 (mode, arg)），带参数不命中。
        """
        if not self.enable or not self.bank_enable or not self.rob_enable:
            return False
        for name in self.rob_trigger_names:
            if text == name or text == f"/{name}":
                return True
        return False

    def _rob_pool(self, group_id) -> int:
        """
        可抢的钱池：**本群所有人银行余额之和**（不含自己）。

        ★ 抢银行是「抢别人的钱」，所以钱要从这个池子里出：
          池子不够就抢不到那么多（见 do_rob_bank）。
        """
        total = 0
        try:
            for _uid, u in self._all_group_users(group_id):
                if not isinstance(u, dict):
                    continue
                try:
                    total += max(0, int(u.get("bank", 0) or 0))
                except Exception:
                    continue
        except Exception:
            return 0
        return total

    def do_rob_bank(self, event) -> str:
        """
        抢银行（每天一次，没有参数）。

        成功：随机抢 rob_min~rob_max，从**本群银行总余额**里扣，
              自己钱包加同样的钱（池子不够就按池子里有的给）。
        失败：银行账户冻结 rob_freeze_days 天，
              并扣除一半财产（钱包+银行）的一半。
        """
        import random as _random
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        if not self.rob_enable:
            return "⚠️ 抢银行功能未开启"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u["name"] = user_name

        # ---- 每天一次 ----
        day_start = self._rob_day_start()
        today_key = str(day_start)
        rob_day = self._grob(group_id).setdefault(today_key, {})
        if user_id in rob_day:
            rec = rob_day[user_id]
            _res = bool(rec.get("ok"))
            return "\n".join([
                f"{title_bar('抢银行')}",
                f"👤 {user_name}",
                "⚠️ 今天已经抢过了，明天再来",
                f"📋 今日结果：{'✅ 抢到 ' + str(rec.get('amount', 0)) if _res else '❌ 失败被抓'}",
            ])

        # ★★ 1.7.7：**冻结中不许抢银行** —— 冻着就不能继续抢，解冻后才能再抢。
        #   （放在「今天已经抢过」之后：先把今天的战果告诉用户，再说冻结。）
        _fz = self.bank_frozen_msg(group_id, user_id)
        if _fz:
            return "\n".join([
                f"{title_bar('抢银行')}",
                f"👤 {user_name}",
                _fz,
                "",
                "💡 解冻后才能继续抢银行",
            ])

        cmd = self.rob_trigger_names[0]
        # ★★ 1.7.6：坐骑附加 BUFF —— 当前骑乘的坐骑按价格加成功率
        _, _rb = self.mount_bonus_of_user(group_id, user_id)
        _rob_rate = self.rob_success_rate + _rb
        ok = _random.randint(1, 100) <= _rob_rate
        wallet = int(u.get("total_score", 0))
        bank = int(u.get("bank", 0) or 0)

        if not ok:
            # ---- 失败：冻结 + 扣一半财产 ----
            penalty = int((max(0, wallet) + max(0, bank))
                          * self.rob_fail_penalty_rate)
            # 一半财产按比例从钱包/银行扣（先钱包后银行）
            _p = self.pay(group_id, user_id, penalty)
            frozen_until = (int(time.time()) + self.rob_freeze_days * 86400
                            if self.rob_freeze_days > 0 else 0)
            u["bank_frozen_until"] = frozen_until
            rob_day[user_id] = {"ok": False, "amount": 0,
                                "ts": int(time.time()),
                                "penalty": penalty}
            self._save()

            lines = [
                f"{title_bar('抢银行')}",
                f"👤 {user_name}",
                f"🚨 失败了！安保把你按住了…",
                f"　 （成功率只有 {self.rob_success_rate}%）",
            ]
            if penalty > 0:
                lines.append(f"💸 没收一半财产：-{penalty} {self._sn()}")
                # ★ 1.7.7：抢银行的 pay() **不掏保险箱**，明细只有钱包/银行
                lines.append(f"　 （钱包 -{_p.get('from_wallet', 0)}，"
                             f"银行 -{_p.get('from_bank', 0)}）")
            else:
                lines.append("💸 你没钱，警察都懒得理你 😂")
            lines += [
                f"💰 钱包：{u.get('total_score', 0)}"
                f"　🏦 银行：{u.get('bank', 0)}",
            ]
            if frozen_until:
                lines += [
                    "",
                    f"🚫 银行账户已冻结 **{self.rob_freeze_days} 天**",
                    "💡 冻结期间存/取/借/还/查询都用不了，**也不能再抢银行**",
                ]
            return "\n".join(lines)

        # ---- 成功：从本群银行总余额里抢钱 ----
        want = _random.randint(self.rob_min, max(self.rob_min, self.rob_max))
        pool = self._rob_pool(group_id)
        got = min(want, pool)
        if got > 0:
            # 从别人的银行余额里按顺序扣（自己除外）
            left = got
            for _uid, _u2 in self._all_group_users(group_id):
                if left <= 0:
                    break
                if str(_uid) == str(user_id) or not isinstance(_u2, dict):
                    continue
                try:
                    b2 = max(0, int(_u2.get("bank", 0) or 0))
                except Exception:
                    continue
                take = min(b2, left)
                if take > 0:
                    _u2["bank"] = b2 - take
                    left -= take
            u["total_score"] = int(u.get("total_score", 0)) + got
        rob_day[user_id] = {"ok": True, "amount": got,
                            "ts": int(time.time())}
        self._save()

        lines = [
            f"{title_bar('抢银行')}",
            f"👤 {user_name}",
            f"🎉 成功了！（成功率 {self.rob_success_rate}%）",
            f"💵 抢到：+{got} {self._sn()}",
        ]
        if want > got:
            lines.append(f"　 （本想抢 {want}，但全群银行只剩 {pool}）")
        lines += [
            f"💰 钱包：{u.get('total_score', 0)}",
            "",
            "💡 抢来的钱直接进钱包，不用交税 😈",
        ]
        return "\n".join(lines)

    # ============================================================
    # 坐骑系统
    # ============================================================
    def do_loan(self, event, arg: str) -> str:
        """
        借款：把「本金」记进 u['loan']（不动 total_score）。

        利息在**借款时**一次性计入欠款（本金 × (1 + 利息率)），
        这样「欠多少」在任何时刻都能直接读出来，不依赖结算时机。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        if not self.loan_enable:
            return "⚠️ 银行暂不提供借款"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u.setdefault("loan", 0)
        u["name"] = user_name
        # ★ 先结算旧的逾期罚息，免得新借款把旧账「洗白」
        self.apply_overdue_interest(group_id, user_id, save=False)

        amount = self._parse_amount(arg, self.loan_max)
        if amount == 0:
            amount = self.loan_max          # 不带参数 = 借上限
        if amount == -1:
            return (f"⚠️ 借款数量无效\n"
                    f"用法：「{self.loan_trigger_names[0]} 1000」"
                    f"或「{self.loan_trigger_names[0]}」借满 {self.loan_max}")
        if amount > self.loan_max:
            return (f"⚠️ 单次最多借 {self.loan_max} {self._sn()}\n"
                    f"💡 想多借就分几次，利息照算 😈")

        loan = self._loan_of(u)
        interest = int(round(amount * self.loan_interest_rate))
        total_due = amount + interest
        u["loan"] = loan + total_due
        u["loan_count"] = int(u.get("loan_count", 0) or 0) + 1
        # ★ 1.7.6：记下到期时间（0 天 = 不设期限）
        _due_days = max(0, int(getattr(self, "loan_due_days", 0) or 0))
        if _due_days > 0:
            u["loan_due"] = int(time.time() + _due_days * 86400)
        else:
            u["loan_due"] = 0
        # ★ 借新账后重新起算逾期周期
        u["loan_extra"] = 0
        # ★ 借到的钱直接进钱包
        u["total_score"] = int(u.get("total_score", 0)) + amount
        self._save()

        _lines = [
            f"{title_bar('银行借款')}",
            f"👤 {user_name}",
            f"💵 借出本金：+{fmt_num(amount)} {self._sn()}",
            f"📈 利息（{self.loan_interest_rate * 100:.0f}%）：+{fmt_num(interest)}",
            f"🧾 本次合计欠款：{fmt_num(total_due)}",
            "",
            f"💰 当前{self._sn()}：{u['total_score']}",
            f"📉 累计欠款：{fmt_num(u['loan'])}",
            f"💎 净值：{fmt_num(u['total_score'] - u['loan'])}",
        ]
        if _due_days > 0:
            _od = f"{_due_days} 天"
            _rate = self.loan_overdue_rate * 100
            _step = int(self.loan_overdue_step_hours or 24)
            _lines += [
                "",
                f"⏰ 还款期限：**{_od}**内"
                f"（{_fmt_time(u['loan_due'])} 前）",
                f"⚠️ 逾期后每 {_step} 小时加收本金 {_rate:.1f}% 的罚息，"
                f"越拖越多",
            ]
            if int(self.loan_deadbeat_days or 0) > 0:
                _lines.append(f"🐍 逾期满 {int(self.loan_deadbeat_days)} 天"
                              f"会被挂上「{self.loan_deadbeat_tag}」标签")
            else:
                _lines.append(f"🐍 一逾期就会被挂上「{self.loan_deadbeat_tag}」"
                              f"标签")
        _lines += ["", f"💡 用「{self.loan_repay_names[0]} 数量」还钱"]
        return "\n".join(_lines)

    def do_repay(self, event, arg: str) -> str:
        """还款：从钱包扣钱冲抵欠款；钱不够就按手上有的还"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        if not self.loan_enable:
            return "⚠️ 银行暂不提供借款"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录"
        u["name"] = user_name
        # ★ 1.7.6：还款前先结算逾期罚息
        self.apply_overdue_interest(group_id, user_id, save=False)
        loan = self._loan_of(u)
        if loan <= 0:
            return f"✅ 你没有欠款，腰杆很直 👍"

        wallet = int(u.get("total_score", 0))
        if wallet <= 0:
            return (f"⚠️ 你手上只有 {wallet} {self._sn()}，还不了款\n"
                    f"📉 当前欠款：{fmt_num(loan)}\n"
                    f"💡 先去签到 / 打工赚点钱")

        amount = self._parse_amount(arg, min(loan, wallet))
        if amount == 0:
            amount = min(loan, wallet)      # 不带参数 = 能还多少还多少
        if amount == -1:
            return (f"⚠️ 还款数量无效\n"
                    f"用法：「{self.loan_repay_names[0]} 500」"
                    f"或「{self.loan_repay_names[0]} all」")
        # 手里钱不够就按手里有的还
        if amount > wallet:
            amount = wallet
        if amount > loan:
            amount = loan

        u["total_score"] = wallet - amount
        u["loan"] = loan - amount
        if u["loan"] <= 0:
            u["loan"] = 0
            # ★ 还清了：清掉到期时间与累计罚息，老赖标签自然消失
            u["loan_due"] = 0
            u["loan_extra"] = 0
        else:
            # ★ 还了一部分：按「当前欠款」重新起算到期时间，
            #   否则剩一点点也会一直被追罚
            _due_days = max(0, int(getattr(self, "loan_due_days", 0) or 0))
            if _due_days > 0 and self.loan_overdue_periods(u) <= 0:
                u["loan_due"] = int(time.time() + _due_days * 86400)
        self._save()

        left = u["loan"]
        lines = [
            f"{title_bar('归还借款')}",
            f"👤 {user_name}",
            f"💸 还款：-{fmt_num(amount)} {self._sn()}",
            f"💰 当前{self._sn()}：{u['total_score']}",
            f"📉 剩余欠款：{fmt_num(left)}",
            f"💎 净值：{fmt_num(u['total_score'] - left)}",
        ]
        if left <= 0:
            lines.append("")
            lines.append("🎉 无债一身轻！")
            if self.loan_deadbeat_tag:
                lines.append(f"✅ 「{self.loan_deadbeat_tag}」标签已摘掉")
        else:
            _od = self.loan_overdue_text(u)
            if _od and self.loan_overdue_notice:
                lines.append("")
                lines.append(_od)
            elif self.loan_due_ts(u) > 0:
                lines.append("")
                lines.append(f"⏰ 还款期限：{_fmt_time(self.loan_due_ts(u))}")
        return "\n".join(lines)

    def do_loan_info(self, event) -> str:
        """查看自己的欠款与净值"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "bank"):
            return ""
        # ★ 1.7.6：银行冻结中则拒绝一切操作
        _fz = self.bank_frozen_msg(group_id, get_user_id(event))
        if _fz:
            return _fz
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return (f"{title_bar('我的借款')}\n"
                    f"👤 {user_name}\n"
                    f"✅ 没有欠款\n"
                    f"💡 先签到再看看吧~")
        # ★ 1.7.6：查询前先结算逾期罚息，保证数字是准的
        if self.apply_overdue_interest(group_id, user_id, save=False):
            self._save()
        wallet = int(u.get("total_score", 0))
        bank = int(u.get("bank", 0))
        loan = self._loan_of(u)
        _tag = self.deadbeat_tag_of(u)
        lines = [
            f"{title_bar('我的借款')}",
            f"👤 {user_name}" + (f"　{_tag}" if _tag else ""),
            f"💰 {self._sn()}：{wallet}",
            f"🏦 银行余额：{fmt_num(bank)}",
            f"📉 欠款：{fmt_num(loan)}",
            f"💎 净值：{fmt_num(wallet - loan)}",
            f"📊 总资产：{fmt_num(wallet + bank - loan)}",
        ]
        _extra = max(0, int(u.get("loan_extra", 0) or 0))
        if _extra > 0:
            lines.append(f"　 （其中逾期罚息：{_extra}）")
        if loan <= 0:
            lines.append("")
            lines.append("✅ 无欠款")
        else:
            lines.append("")
            _due = self.loan_due_ts(u)
            if _due > 0:
                _left = _due - time.time()
                if _left > 0:
                    _d = int(_left // 86400)
                    _h = int((_left % 86400) // 3600)
                    lines.append(f"⏰ 还款期限：{_fmt_time(_due)}"
                                 f"（还有 {_d} 天 {_h} 小时）")
                else:
                    lines.append(f"⏰ 还款期限：{_fmt_time(_due)}（**已过期**）")
            _od = self.loan_overdue_text(u)
            if _od and self.loan_overdue_notice:
                lines.append(_od)
            if _tag:
                lines.append(f"{_tag}　信用已受损，赶紧还钱！")
            lines.append(f"⚠️ 你欠着 {fmt_num(loan)} {self._sn()}")
            lines.append(f"💡 用「{self.loan_repay_names[0]} 数量」还钱")
        return "\n".join(lines)

    # ============================================================
    # 抽奖（接在签到最后）
    # ============================================================
    def _lottery_menu_line(self) -> str:
        """签到输出末尾那行提示文案"""
        if not self.lottery_enable:
            return ""
        cmd = (self.lottery_trigger_names or ["开始抽奖"])[0]
        _lim = int(getattr(self, "lottery_daily_limit", 0) or 0)
        _tail = f"，每天 {_lim} 次" if _lim > 0 else ""
        return (f"🎰 试试手气：「{cmd}」"
                f"（每次 {self.lottery_cost} {self._sn()}，"
                f"中奖最高 {self.lottery_prize_max}{_tail}）")

    def do_lottery(self, event, arg: str = "") -> str:
        """
        抽奖：**不带参数**，每次固定花 `lottery_cost`。

        奖品在 `0 ~ lottery_prize_max` 之间随机：
          · 抽中 0 -> 「空手而归」
          · 中奖概率由 `lottery_win_rate` 控制
        ★ 允许扣成负分（负债），扣完提示可去银行借款。
        """
        import random as _random
        group_id = get_group_id(event)
        # ★ 抽奖是签到系统下的子功能，受「签到系统」+「抽奖功能」两层开关限制
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        if not self._is_group_allowed(group_id, "lottery"):
            return ""
        if not self.lottery_enable:
            return "⚠️ 抽奖功能未开启"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        # ★ 每日次数上限（0 = 不限）
        _lim = int(getattr(self, "lottery_daily_limit", 0) or 0)
        _used = self.lottery_used_today(group_id, user_id)
        if _lim > 0 and _used >= _lim:
            return "\n".join([
                f"{title_bar('开始抽奖')}",
                f"👤 {user_name}",
                f"⚠️ 今天的抽奖次数已经用完了（每天 {_lim} 次）",
                f"📊 今日已抽：{_used} / {_lim} 次",
                "💡 明天再来试试手气",
            ])

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u["name"] = user_name

        # ★ 固定花费，不接受参数（后台可改「每次花多少」）
        cost = max(1, int(getattr(self, "lottery_cost", 100) or 100))

        # ★★ 1.7.6：抽一次的核心逻辑抽成 `_lottery_draw_once`，
        #   和「全部抽奖」共用（避免两份实现走偏）。
        _r = self._lottery_draw_once(group_id, user_id, u)
        if not _r.get("ok"):
            return str(_r.get("msg") or
                       self.short_hint(group_id, user_id, cost))
        _pay = _r["pay"]
        win = bool(_r["win"])
        prize = int(_r["prize"])
        _fw = int(_pay.get("from_wallet", 0))
        _fb = int(_pay.get("from_bank", 0))
        before_wallet = int(_pay.get("wallet", 0))
        before_bank = int(_pay.get("bank", 0))
        after = int(u.get("total_score", 0))
        self._save()

        lines = [
            f"{title_bar('开始抽奖')}",
            f"👤 {user_name}",
            self.pay_note(_pay),
        ]
        if not win:
            lines.append(f"💨 没中…（中奖率 {self.lottery_win_rate}%）")
        elif prize <= 0:
            lines.append("🎉 中奖了！但奖品是**谢谢参与** —— 空手而归 😂")
        else:
            lines.append(f"🎉 中奖！获得 +{prize} {self._sn()}")
        lines.append("")
        # ★ 钱从哪扣的说清楚（钱包/银行）
        if _fb > 0 and _fw > 0:
            lines.append(f"💳 扣款：钱包 -{_fw}，银行 -{_fb}")
        elif _fb > 0:
            lines.append(f"💳 扣款：全部从银行扣 -{_fb}")
        lines.append(
            f"💰 钱包：{fmt_num(before_wallet)} → {fmt_num(int(u.get('total_score', 0)))}"
            f"　🏦 银行：{before_bank} → {int(u.get('bank', 0))}")
        # ★ 显示今日剩余次数
        if _lim > 0:
            _left = max(0, _lim - (_used + 1))
            lines.append(f"🎯 今日次数：{_used + 1} / {_lim}"
                         f"（剩余 {_left} 次）")
        loan = self._loan_of(u)
        if loan > 0:
            lines.append(f"📉 欠款：{fmt_num(loan)}　💎 净值：{fmt_num(after - loan)}")
        # ★ 用净值判断，而不是单看钱包：
        #   钱包空了但银行还有钱（或干脆就是银行扣的）不算负债
        if self.net_worth(group_id, user_id) < 0:
            lines.append("")
            lines.append("⚠️ 你已经负债了")
            _h = self.loan_hint()
            if _h:
                lines.append(_h)
        return "\n".join(lines)

    def _lottery_draw_once(self, group_id, user_id, u) -> dict:
        """
        抽**一次**（内部核心，`do_lottery` / `do_lottery_all` 共用）。

        返回 dict：
          ok      True = 抽成功；False = 失败（钱不够等）
          win     是否中奖
          prize   本次奖金（0 = 空手而归）
          pay     self.pay() 的返回（含扣款明细）
          msg     失败原因（ok=False 时）
        """
        import random as _random
        cost = max(1, int(getattr(self, "lottery_cost", 100) or 100))
        # ★ 可用资金口径：开 use_bank_pay = 钱包+银行，关掉 = 只看钱包
        _avail = (self.avail_funds(group_id, user_id)
                  if getattr(self, "use_bank_pay", True)
                  else int(self.get_score(group_id, user_id)))
        if _avail < cost:
            return {"ok": False, "msg": self.short_hint(group_id, user_id,
                                                        cost)}
        win = _random.randint(1, 100) <= self.lottery_win_rate
        prize = 0
        if win:
            # ★ 下限固定 0：可能中奖但空手而归
            pmax = max(0, int(self.lottery_prize_max or 0))
            prize = _random.randint(0, pmax) if pmax > 0 else 0
        # ★ 扣花费：先扣钱包、钱包不够自动扣银行
        _pay = self.pay(group_id, user_id, cost,
                        allow_bank=getattr(self, "use_bank_pay", True))
        if not _pay.get("ok"):
            return {"ok": False, "msg": self.short_hint(group_id, user_id,
                                                        cost)}
        if prize > 0:
            u["total_score"] = int(u.get("total_score", 0)) + prize
        try:
            u["lottery_count"] = int(u.get("lottery_count", 0) or 0) + 1
            if prize > 0:
                u["lottery_win"] = int(u.get("lottery_win", 0) or 0) + 1
        except Exception:
            pass
        # ★ 记一次「今日已抽」
        try:
            _tk = str(self._day_start())
            _g = self._glottery(group_id)
            _day = _g.setdefault(_tk, {})
            _day[str(user_id)] = int(_day.get(str(user_id), 0) or 0) + 1
            if len(_g) > 7:
                for _k in sorted(_g.keys())[:-7]:
                    _g.pop(_k, None)
        except Exception:
            pass
        return {"ok": True, "win": win, "prize": prize, "pay": _pay}

    def do_lottery_all(self, event) -> str:
        """
        「全部抽奖」：**一个指令把当天剩余机会全抽完**（1.7.6 新增）。

        ★ 每天上限由 `lottery_daily_limit` 决定（默认 10 次），
          所以这个指令一次就把「今天还没抽的」全部抽完。
        ★ 次数不限（`lottery_daily_limit = 0`）时只抽**一次** ——
          否则会无限循环。这种情况会提示改用「开始抽奖」。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        if not self._is_group_allowed(group_id, "lottery"):
            return ""
        if not self.lottery_enable:
            return "⚠️ 抽奖功能未开启"
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        _lim = int(getattr(self, "lottery_daily_limit", 0) or 0)
        _used = self.lottery_used_today(group_id, user_id)
        _cmd1 = (self.lottery_trigger_names or ["开始抽奖"])[0]
        _title = (getattr(self, "lottery_all_trigger_names", None)
                  or ["全部抽奖"])[0]

        # ★ 不限次数时不能「全部」抽，否则死循环
        if _lim <= 0:
            return "\n".join([
                f"{title_bar(_title)}",
                f"👤 {user_name}",
                "⚠️ 本群抽奖**不限次数**，没法一次抽完",
                f"💡 请用「{_cmd1}」一次一次抽",
            ])

        _left = _lim - _used
        if _left <= 0:
            return "\n".join([
                f"{title_bar(_title)}",
                f"👤 {user_name}",
                f"⚠️ 今天的抽奖次数已经用完了（每天 {_lim} 次）",
                f"📊 今日已抽：{_used} / {_lim} 次",
                "💡 明天再来试试手气",
            ])

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u["name"] = user_name

        cost = max(1, int(getattr(self, "lottery_cost", 100) or 100))
        _before_wallet = int(u.get("total_score", 0))
        _before_bank = int(u.get("bank", 0))

        draws = []          # 每次结果
        _stop = ""          # 提前终止原因
        for _i in range(_left):
            r = self._lottery_draw_once(group_id, user_id, u)
            if not r.get("ok"):
                _stop = str(r.get("msg") or "余额不足")
                break
            draws.append(r)

        if not draws:
            return _stop or self.short_hint(group_id, user_id, cost)

        self._save()

        _total_prize = sum(int(r.get("prize", 0) or 0) for r in draws)
        _wins = sum(1 for r in draws if r.get("win")
                    and int(r.get("prize", 0) or 0) > 0)
        _hit = sum(1 for r in draws if r.get("win"))
        _spent = cost * len(draws)

        lines = [
            f"{title_bar(_title)}",
            f"👤 {user_name}",
            f"🎰 一次抽完 {len(draws)} 次"
            f"（每次 {fmt_num(cost)} {self._sn()}）",
            "",
        ]
        # ★ 逐次结果（太多就折叠）
        _show = draws if len(draws) <= 12 else draws[:12]
        for _i, r in enumerate(_show, 1):
            if not r.get("win"):
                lines.append(f"  {_i}. 💨 没中")
            elif int(r.get("prize", 0) or 0) <= 0:
                lines.append(f"  {_i}. 🎉 中奖了但空手而归 😂")
            else:
                lines.append(f"  {_i}. 🎉 +{fmt_num(int(r['prize']))}")
        if len(draws) > len(_show):
            lines.append(f"  … 其余 {len(draws) - len(_show)} 次略")
        lines.append("")
        lines.append(f"💰 合计花费：{fmt_num(_spent)} {self._sn()}")
        lines.append(f"🎁 合计中奖：+{fmt_num(_total_prize)} {self._sn()}"
                     f"（净 {'+' if _total_prize - _spent >= 0 else ''}"
                     f"{fmt_num(_total_prize - _spent)}）")
        lines.append(f"🎯 中奖 {_hit} 次（其中 {_wins} 次有奖）")
        lines.append("")
        lines.append(
            f"💰 钱包：{fmt_num(_before_wallet)} → "
            f"{fmt_num(int(u.get('total_score', 0)))}"
            f"　🏦 银行：{fmt_num(_before_bank)} → "
            f"{fmt_num(int(u.get('bank', 0)))}")
        _now_used = _used + len(draws)
        lines.append(f"🎯 今日次数：{_now_used} / {_lim}"
                     f"（剩余 {max(0, _lim - _now_used)} 次）")
        if _stop:
            lines.append("")
            lines.append("⚠️ 中途停了：" + _stop.split("\n")[0])
        loan = self._loan_of(u)
        if loan > 0:
            lines.append(f"📉 欠款：{fmt_num(loan)}"
                         f"　💎 净值：{fmt_num(self.net_worth(group_id, user_id))}")
        if self.net_worth(group_id, user_id) < 0:
            lines.append("")
            lines.append("⚠️ 你已经负债了")
            _h = self.loan_hint()
            if _h:
                lines.append(_h)
        return "\n".join(lines)

    def match_mount_equip_trigger(self, text: str):
        """装备坐骑 坐骑名（1.7.6）"""
        if not self.enable or not self.mount_enable:
            return None
        for name in self.mount_equip_names:
            _carg = cmd_arg(text, self.mount_equip_names)
            if _carg is not None:
                    arg = _carg
                    return arg or None
        return None

    def match_mount_view_trigger(self, text: str):
        """坐骑查看 坐骑名（1.7.6）"""
        if not self.enable or not self.mount_enable:
            return None
        for name in self.mount_view_names:
            _carg = cmd_arg(text, self.mount_view_names)
            if _carg is not None:
                    arg = _carg
                    return arg or None
        return None

    # ------------------------------------------------------------
    # 坐骑图片（**市场版已弃用**）
    #   · 图片标记 `[[img:...]]` 已从所有输出里移除
    #   · 这里只保留查找函数，供历史代码路径调用时不报错
    # ------------------------------------------------------------
    def mount_image(self, mount_name: str) -> str:
        """按坐骑名找图片；找不到返回空串"""
        nm = str(mount_name or "").strip()
        if not nm:
            return ""
        try:
            from .path_utils import mount_image_path
        except Exception:
            try:
                from core.path_utils import mount_image_path
            except Exception:
                return ""
        # 后台可给每个坐骑单独指定图片名（mount_list 里加 img 字段）
        for m in (self.mount_list or []):
            if str(m.get("name") or "") == nm:
                _img = str(m.get("img") or "").strip()
                if _img:
                    p = mount_image_path(_img, self.mount_img_dir)
                    if p:
                        return p
                break
        return mount_image_path(nm, self.mount_img_dir)

    # ------------------------------------------------------------
    # 「每天群里第一句话 -> 谁骑着什么坐骑闪亮登场」
    # ------------------------------------------------------------
    def _mount_greet_day(self, group_id) -> str:
        try:
            g = self._gmountg(group_id)
            return str(g.get("day") or "")
        except Exception:
            return ""

    def _gmountg(self, group_id) -> dict:
        """每天登场记录：{群号: {day, by}}"""
        gid = self._gid(group_id)
        bucket = getattr(self, "mount_greet", None)
        if not isinstance(bucket, dict):
            self.mount_greet = {}
            bucket = self.mount_greet
        row = bucket.get(gid)
        if not isinstance(row, dict):
            bucket[gid] = {"day": "", "by": ""}
            row = bucket[gid]
        return row

    def mount_daily_greet(self, group_id, user_id, user_name) -> str:
        """
        群内当天第一条消息 -> 「$name 骑着 $mount 闪亮登场！」

        ★ 只在**当天第一条**触发（不管是不是同一个人）。
        返回要发送的文本；不触发返回空串。
        """
        if not self.mount_enable or not self.mount_greet_enable:
            return ""
        gid = str(group_id or "")
        if not gid or not user_id:
            return ""
        if not self._is_group_allowed(gid, "mount"):
            return ""
        today = _today_str()
        row = self._gmountg(gid)
        if str(row.get("day") or "") == today:
            return ""
        # 当天第一次 -> 记下来（哪怕他没坐骑，也算「今天已经开过场」）
        row["day"] = today
        row["by"] = str(user_id)
        try:
            _u = self._guser(gid, user_id)
            _m = str((_u or {}).get("current_mount") or "")
        except Exception:
            _m = ""
        self._need_save = True
        if not str(_m).strip():
            return ""
        # ★★ 1.7.6：登场提示的昵称也走**统一清理+截断**
        #   （以前直接用原始昵称，脏字符/超长会把卡片排版搞乱）
        nm = _nick_display(user_name) or f"QQ{user_id}"
        tpl = str(self.mount_greet_text or "").strip() or \
            "🌟 $name 骑着「$mount」闪亮登场！"
        try:
            from .path_utils import render_greet
        except Exception:
            try:
                from core.path_utils import render_greet
            except Exception:
                render_greet = None
        kv = {"name": nm, "user": nm, "mount": str(_m),
              "group": gid, "uid": str(user_id)}
        if render_greet is not None:
            _txt = render_greet(tpl, kv)
        else:
            _txt = (tpl.replace("$name", nm).replace("$user", nm)
                    .replace("$mount", str(_m)).replace("$group", gid))
        # ★★ 1.7.6：**登场提示不带坐骑图** ——
        #   用户要求：这里只出文字，坐骑图只在「坐骑查看 / 装备坐骑」里出。
        #   （以前会往后面拼一行 `[[img:...]]`，在图片模式里会多插一张图。）
        return _txt

    def do_mount_equip(self, event, mount_name: str) -> str:
        """
        装备坐骑（1.7.6）：必须已购买；装备后每天第一句会登场提示。

        ★ 支持「坐骑名」或「序号」（序号按**已拥有列表**的顺序）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "mount"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("mounts", [])
        u.setdefault("current_mount", "")
        # ★ 先解析（名字或序号），再判断是否已拥有
        _cmd = self.mount_equip_names[0]
        _r = self.resolve_owned_mount(group_id, user_id, mount_name)
        if not _r["ok"]:
            return "\n".join([
                f"{title_bar('装备坐骑')}",
                f"👤 {user_name}",
                self.resolve_owned_msg(_r, _cmd),
                f"💡 用「{self.mount_buy_trigger_names[0]} 坐骑名或序号」先购买",
            ])
        mount_name = _r["name"]
        owned = _r.get("owned") or []
        u["current_mount"] = mount_name
        self._save()
        lines = [
            f"{title_bar('装备坐骑')}",
            f"👤 {user_name}",
            f"💰 拥有{self._sn()}：{int(u.get('total_score', 0))}",
            "",
        ]
        # ★★ 市场版：**不再插入坐骑图片**（`[[img:...]]` 标记已移除）。
        #   坐骑功能本身完整保留，只是改为纯文字显示。
        lines += [
            f"🐴 坐骑：{mount_name}",
            "",
            "✅ 装备成功！",
            "💡 每天群里第一句话会提示你骑着它闪亮登场",
        ]
        if not _img:
            lines.append(f"🖼 提示：素材目录里没找到「{mount_name}」的图片")
        return "\n".join(lines)

    def _mount_entry(self, mount_name: str) -> dict:
        """按名字取坐骑条目（找不到返回空 dict）"""
        for m in (self.mount_list or []):
            if str(m.get("name") or "") == mount_name:
                return m
        return {}

    def resolve_view_mount(self, group_id, user_id, arg) -> dict:
        """
        「坐骑查看」的参数解析（1.7.6）。

        ★ 序号**两套都认**：
            · 数字先按**坐骑商店**的绝对编号解析（和「坐骑商店」里显示的一致）
            · 超出商店范围时，再按**已拥有列表**的编号兜底
              （万一座骑被后台下架了，已拥有的还能按自己的序号查到）
          名字永远优先。

        返回 {"ok", "name", "item", "owned", "reason"}
        reason: found / empty / not_found
        """
        raw = str(arg or "").strip()
        owned = [str(x) for x in
                 ((self._guser(group_id, user_id) or {}).get("mounts")
                  or [])]
        if not raw:
            return {"ok": False, "name": "", "item": None, "owned": owned,
                    "reason": "empty"}
        # ① 名字
        _r = self.resolve_mount(raw)
        if _r["ok"]:
            return {"ok": True, "name": _r["name"], "item": _r["item"],
                    "owned": owned, "reason": "found"}
        # ②③ 纯数字
        if raw.isdigit():
            idx = int(raw)
            lst = list(self.mount_list or [])
            # ② 商店绝对编号（和「坐骑商店」显示的一致）
            if 1 <= idx <= len(lst):
                nm = str(lst[idx - 1].get("name") or "")
                return {"ok": True, "name": nm, "item": lst[idx - 1],
                        "owned": owned, "reason": "found"}
            # ③ 已拥有编号兜底（坐骑被下架时仍能查）
            if 1 <= idx <= len(owned):
                nm = owned[idx - 1]
                return {"ok": True, "name": nm,
                        "item": self._mount_entry(nm), "owned": owned,
                        "reason": "found"}
        return {"ok": False, "name": raw, "item": None, "owned": owned,
                "reason": "not_found"}

    def do_mount_view(self, event, mount_name: str) -> str:
        """
        坐骑查看 坐骑名/序号（1.7.6）。

        ★ 参数支持三种写法：
            · 坐骑名                赤兔
            · 「我的坐骑」里的序号    1  （已拥有列表的顺序）
            · 「坐骑商店」里的序号    12 （商店的绝对编号）
        ★ 没买也能查看：图 + 价格 + 描述都会显示，
          只是多一行「你还没有坐骑」提示。
        ★ 坐骑图放在昵称下方、坐骑信息**前面**（图文同一套输出）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "mount"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        _cmd = self.mount_view_names[0]
        _r = self.resolve_view_mount(group_id, user_id, mount_name)
        _resolved = bool(_r["ok"])
        mount_name = str(_r.get("name") or "") if _resolved else ""
        _owned_list = [str(x) for x in (_r.get("owned") or [])]
        # ★ 注意：解析成功 ≠ 已拥有。商店里存在但有没买，仍要提示「还没有坐骑」
        _own_ok = _resolved and mount_name in _owned_list
        # ★ 传的是数字、但两个列表都超范围 -> 明确提示
        #   （否则会走到「你还没有坐骑『999』」这种误导人的说法）
        if not _resolved and str(_r.get("name") or "").strip().isdigit():
            _n_own = len(_owned_list)
            _n_shop = len(self.mount_list or [])
            return "\n".join([
                f"{title_bar('坐骑查看')}",
                f"👤 {user_name}",
                f"⚠️ 序号「{_r.get('name')}」超出范围",
                f"📋 我的坐骑：1~{_n_own}（共 {_n_own} 个）",
                f"📋 坐骑商店：1~{_n_shop}（共 {_n_shop} 个）",
                f"💡 也可以直接用坐骑名，例如「{_cmd} 赤兔」",
            ])

        # 名字有效且在商店里 -> 展示价格 / 描述
        # ★★ 市场版：不再查坐骑图片（`[[img:...]]` 已移除）
        _entry = self._mount_entry(mount_name) if mount_name else {}
        _price = _entry.get("price", "?")
        _desc = str(_entry.get("desc") or "")

        lines = [
            f"{title_bar('坐骑查看')}",
            f"👤 {user_name}",
        ]
        # ★ 没拥有：先给一行「你还没有坐骑」（有具体名字就带上名字）
        if not _own_ok:
            if _resolved and mount_name:
                lines.append(f"⚠️ 你还没有坐骑「{mount_name}」")
            elif str(_r.get("name") or "").strip():
                lines.append(f"⚠️ 你还没有坐骑「{_r.get('name')}」")
        # 名字 / 价格 / 描述（买了没买都显示）
        if mount_name and _entry:
            lines.append(f"🐴 坐骑：{mount_name}")
            lines.append(f"💰 价格：{_price} {self._sn()}")
            if _desc:
                lines.append(f"📝 {_desc}")
        elif mount_name and _resolved:
            lines.append(f"🐴 坐骑：{mount_name}")
        if _own_ok:
            _cur = str((u or {}).get("current_mount") or "")
            lines.append(f"⭐ 当前骑乘：{'是' if _cur == mount_name else '否'}")
        if mount_name and not _img:
            lines.append(f"🖼 提示：素材目录里没找到「{mount_name}」的图片")
        # 已拥有：★ 1.7.6 只显示**只数**，不列名字。
        #   用户要求：列出全部名字会超宽折行，反而看不出到底有几只。
        #   （要看名单用「我的坐骑」；要用序号装备，序号以「我的坐骑」为准）
        if _owned_list:
            lines.append(f"📋 已拥有：{len(_owned_list)} 只")
        else:
            lines.append("📋 已拥有：暂无，先去购买")
        # ★★ 1.7.6：坐骑附加 BUFF —— **只在坐骑查看里显示**
        #   ★ 图标用**不带性别**的 `\U0001F9B8`：带性别的写法是
        #     `\U0001F9B8\u200D\u2642\uFE0F`（ZWJ 序列），渲染服务的
        #     emoji 字体 seguiemj.ttf **不支持这个组合**，会被拆成
        #     「人物 + 艺术字 ♂ + 豆腐块」。裸符号能正常画成彩色。
        _sb, _rb = self.mount_bonus_of(mount_name)
        if _sb > 0 or _rb > 0:
            lines.append("✨ 骑乘加成：")
            if _sb > 0:
                # ★ 图标与文字之间用**一个半角空格**（用户指定）
                lines.append(f"　 🦸 偷积分成功率 +{self.fmt_bonus(_sb)}%")
            if _rb > 0:
                lines.append(f"　 🏦 抢银行成功率 +{self.fmt_bonus(_rb)}%")
            if str((u or {}).get("current_mount") or "") != mount_name:
                lines.append("　 （装备后生效）")
        if _own_ok:
            lines += [
                "",
                f"💡 装备：「{self.mount_equip_names[0]} {mount_name}」",
            ]
            if mount_name in _owned_list:
                _idx = _owned_list.index(mount_name) + 1
                lines.append(f"💡 也可用序号：「{self.mount_equip_names[0]} "
                             f"{_idx}」")
        else:
            lines.append(f"💡 也可用序号，例如「{_cmd} 1」")
            if mount_name and _entry:
                lines.append("")
                lines.append(f"💡 购买：「{self.mount_buy_trigger_names[0]} "
                             f"{mount_name}」")
        return "\n".join(lines)

    def _page_slice(self, total: int, page, per: int = 10):
        """
        分页工具：返回 (本页起止序号 from0, to0, 当前页, 总页数)。

        ★ 页号超范围会自动夹到最后一页，避免用户翻过头看到空白。
        """
        try:
            per = max(1, int(per))
        except Exception:
            per = 10
        pages = max(1, (int(total) + per - 1) // per)
        try:
            p = int(page or 1)
        except Exception:
            p = 1
        p = max(1, min(p, pages))
        return (p - 1) * per, p * per, p, pages

    def _page_nav(self, cmd: str, page: int, pages: int) -> list:
        """翻页提示行（只有一页就不显示）"""
        if pages <= 1:
            return []
        out = [f"📄 第 {page} / {pages} 页"]
        if page > 1:
            out.append(f"⬅️ 上一页：「{cmd} {page - 1}」")
        if page < pages:
            out.append(f"➡️ 下一页：「{cmd} {page + 1}」")
        return out

    def do_mount_info(self, event, page=1) -> str:
        """
        「我的坐骑」：**只列已拥有的坐骑，每页 10 只**（1.7.6）。

        ★★ 用户要求：输出内容只要「已拥有坐骑」这一类，
          每页十只 —— 所以**去掉**昵称、积分、底部装备/查看提示。

        ★ 序号是**绝对编号**（第 2 页从 11 开始），
          所以「装备坐骑 12」在哪个页面看都指同一个坐骑。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "mount"):
            return ""
        user_id = get_user_id(event)
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        u.setdefault("mounts", [])
        u.setdefault("current_mount", "")

        mounts = [str(x) for x in (u.get("mounts", []) or [])]
        current = str(u.get("current_mount", "") or "")
        _cmd = self.mount_trigger_names[0]

        lines = [f"{title_bar('我的坐骑')}"]
        if not mounts:
            lines.append("")
            lines.append("🐴 暂无已拥有坐骑")
            return "\n".join(lines)

        # ★ 每页 10 只
        start, end, p, pages = self._page_slice(len(mounts), page, 10)
        lines.append(f"🐴 已拥有坐骑（共 {len(mounts)} 只）")
        lines.append("")
        for i in range(start, min(end, len(mounts))):
            nm = mounts[i]
            tag = "  ⭐当前骑乘" if nm == current else ""
            lines.append(f"  {i + 1}. {nm}{tag}")
        # 只有多页时才显示翻页提示
        _nav = self._page_nav(_cmd, p, pages)
        if _nav:
            lines.append("")
            lines += _nav
        return "\n".join(lines)

    def do_mount_list(self, page=1) -> str:
        """
        「坐骑商店」：列可购买坐骑，每页 10 个（1.7.6）。

        ★ 序号是**绝对编号**（第 2 页从 11 开始），购买时直接用这个号。
        """
        _cmd = self.mount_list_trigger_names[0]
        lines = [f"{title_bar('坐骑商店')}"]
        if not self.mount_list:
            lines.append("")
            lines.append("暂无坐骑，请联系管理员在后台添加")
            return "\n".join(lines)
        start, end, p, pages = self._page_slice(len(self.mount_list), page, 10)
        lines.append("")
        for i in range(start, min(end, len(self.mount_list))):
            m = self.mount_list[i]
            lines.append(f"{i + 1}. {m['name']} —— {m['price']} {self._sn()}")
            if m.get("desc"):
                lines.append(f"    {m['desc']}")
        lines += self._page_nav(_cmd, p, pages)
        lines.append("")
        lines.append(f"💡 用「{self.mount_buy_trigger_names[0]} 序号」购买")
        return "\n".join(lines)

    # ------------------------------------------------------------
    # 坐骑「名字 / 序号」解析（1.7.6）
    #   · 购买 / 查看 / 装备 都同时支持两种写法
    #   · 序号 = 「坐骑列表」里显示的编号（从 1 开始）
    # ------------------------------------------------------------
    def resolve_mount(self, arg) -> dict:
        """
        把用户输入解析成一个坐骑条目。

        支持：
          · 名字（精确，大小写/空格不敏感）：赤兔
          · 序号（坐骑列表里的编号，从 1 开始）：3
        返回 {"ok": bool, "name": str, "item": dict|None,
              "reason": "found"|"empty"|"not_found"|"bad_index"}
        """
        raw = str(arg or "").strip()
        if not raw:
            return {"ok": False, "name": "", "item": None, "reason": "empty"}
        lst = list(self.mount_list or [])
        # ① 名字优先（精确匹配，去掉首尾空格，大小写不敏感）
        _low = raw.lower()
        for m in lst:
            if str(m.get("name") or "").strip().lower() == _low:
                return {"ok": True, "name": str(m["name"]), "item": m,
                        "reason": "found"}
        # ② 纯数字 -> 当序号（从 1 开始）
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(lst):
                m = lst[idx]
                return {"ok": True, "name": str(m["name"]), "item": m,
                        "reason": "found"}
            return {"ok": False, "name": raw, "item": None,
                    "reason": "bad_index"}
        return {"ok": False, "name": raw, "item": None,
                "reason": "not_found"}

    def mount_slots_text(self) -> str:
        """坐骑列表速查（给「名字或序号」提示用）"""
        lst = list(self.mount_list or [])
        if not lst:
            return "（坐骑列表为空，请联系管理员添加）"
        parts = [f"{i}.{m.get('name')}" for i, m in enumerate(lst, start=1)]
        return "　".join(parts)

    def resolve_mount_msg(self, r: dict, cmd: str) -> str:
        """解析失败时的提示文案"""
        if r.get("reason") == "empty":
            return (f"⚠️ 请指定坐骑名称或序号\n"
                    f"用法：「{cmd} 坐骑名」或「{cmd} 序号」\n"
                    f"📋 {self.mount_slots_text()}")
        if r.get("reason") == "bad_index":
            return (f"⚠️ 序号「{r.get('name')}」超出范围\n"
                    f"📋 {self.mount_slots_text()}")
        return (f"⚠️ 坐骑「{r.get('name')}」不存在\n"
                f"📋 {self.mount_slots_text()}\n"
                f"💡 也可直接用序号，例如「{cmd} 1」")

    def _owned_mounts_of(self, group_id, user_id) -> list:
        u = self._guser(group_id, user_id) or {}
        return [str(x) for x in (u.get("mounts") or [])]

    def resolve_owned_mount(self, group_id, user_id, arg) -> dict:
        """
        解析**已拥有**的坐骑（供查看 / 装备用）。

        支持名字，也支持序号 —— 序号按**该用户已拥有列表**的顺序算。
        """
        raw = str(arg or "").strip()
        owned = self._owned_mounts_of(group_id, user_id)
        if not raw:
            return {"ok": False, "name": "", "item": None, "reason": "empty",
                    "owned": owned}
        _low = raw.lower()
        for nm in owned:
            if nm.strip().lower() == _low:
                return {"ok": True, "name": nm, "item": None,
                        "reason": "found", "owned": owned}
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(owned):
                return {"ok": True, "name": owned[idx], "item": None,
                        "reason": "found", "owned": owned}
            return {"ok": False, "name": raw, "item": None,
                    "reason": "bad_index", "owned": owned}
        return {"ok": False, "name": raw, "item": None,
                "reason": "not_found", "owned": owned}

    def owned_mounts_text(self, owned: list) -> str:
        if not owned:
            return "（暂无，先去购买）"
        return "　".join(f"{i}.{nm}" for i, nm in enumerate(owned, start=1))

    # ------------------------------------------------------------
    # ★★ 1.7.6：坐骑附加 BUFF（偷积分成功率 / 抢银行成功率）
    # ------------------------------------------------------------
    # 设计：
    #   · **按坐骑价格**自动算默认加成 —— 越贵加成越高，但**都很克制**
    #   · 后台可在「坐骑列表」里给每只**单独覆盖**（字段 mount_list 的
    #     `steal_bonus` / `rob_bonus`，填 0 就是不额外加成）
    #   · **只在「坐骑查看」里显示**，别的输出一概不提
    #
    # 默认公式（价格 p，用**次方曲线**而不是线性）：
    #     偷积分加成 = min(5.0, (p / 4000000) ** 0.65 * 5)
    #     抢银行加成 = min(2.5, (p / 4000000) ** 0.65 * 2.5)
    #   为什么用次方：线性算出来便宜坐骑全是 0.0%，
    #   买了「田园小驴」的人看不到任何加成、感觉白买。
    #   次方曲线让**每只坐骑都有一点**可感知的加成（最便宜约 0.1%），
    #   同时最贵的封顶在 5% / 2.5% —— 相对基础值（50% / 5%）
    #   只是「锦上添花」，不会一买就无敌。
    MOUNT_STEAL_BONUS_CAP = 5.0        # 偷积分加成上限（%）
    MOUNT_ROB_BONUS_CAP = 2.5          # 抢银行加成上限（%）
    MOUNT_STEAL_BONUS_MIN = 0.1        # 偷积分加成下限（保证便宜坐骑也有感）
    MOUNT_ROB_BONUS_MIN = 0.1          # 抢银行加成下限
    MOUNT_BONUS_REF_PRICE = 4000000.0  # 参考价：到这个价就吃满上限
    MOUNT_BONUS_CURVE = 0.65           # 曲线指数（<1 = 便宜段抬起来）

    def mount_bonus_of(self, mount_name) -> tuple:
        """
        取该坐骑的 (偷积分加成%, 抢银行加成%)。

        ★ 后台覆盖优先（`steal_bonus` / `rob_bonus` 字段），
          没填就按价格算默认值。坐骑不存在返回 (0.0, 0.0)。
        """
        nm = str(mount_name or "").strip()
        if not nm:
            return (0.0, 0.0)
        for m in (self.mount_list or []):
            if str(m.get("name") or "") != nm:
                continue
            # ① 后台覆盖
            _sb = m.get("steal_bonus")
            _rb = m.get("rob_bonus")
            if _sb is not None or _rb is not None:
                try:
                    sb = float(_sb) if _sb not in (None, "") else None
                except Exception:
                    sb = None
                try:
                    rb = float(_rb) if _rb not in (None, "") else None
                except Exception:
                    rb = None
                if sb is None or rb is None:
                    _ds, _dr = self._mount_bonus_by_price(m)
                    if sb is None:
                        sb = _ds
                    if rb is None:
                        rb = _dr
                return (max(0.0, min(100.0, sb)),
                        max(0.0, min(100.0, rb)))
            # ② 按价格算默认
            return self._mount_bonus_by_price(m)
        return (0.0, 0.0)

    def _mount_bonus_by_price(self, m: dict) -> tuple:
        """按价格算默认加成（内部用）"""
        try:
            p = float(m.get("price", 0) or 0)
        except Exception:
            p = 0.0
        if p <= 0:
            return (0.0, 0.0)
        # 归一化到 0~1，再按曲线抬起来
        ratio = min(1.0, p / self.MOUNT_BONUS_REF_PRICE)
        curve = ratio ** self.MOUNT_BONUS_CURVE
        sb = min(self.MOUNT_STEAL_BONUS_CAP, curve * self.MOUNT_STEAL_BONUS_CAP)
        rb = min(self.MOUNT_ROB_BONUS_CAP, curve * self.MOUNT_ROB_BONUS_CAP)
        # ★ 最小值：最便宜的坐骑（2000）曲线算出来只有 0.03，
        #   四舍五入成 0.0 就等于「白买、一点加成都没有」。
        #   给个下限，保证**每一只**坐骑都有可感知的提升。
        sb = max(self.MOUNT_STEAL_BONUS_MIN, sb)
        rb = max(self.MOUNT_ROB_BONUS_MIN, rb)
        # 保留一位小数（够用又好看）
        return (round(sb, 1), round(rb, 1))

    def mount_bonus_of_user(self, group_id, user_id) -> tuple:
        """当前**骑乘**坐骑带来的 (偷积分加成%, 抢银行加成%)"""
        try:
            u = self._guser(group_id, user_id) or {}
            return self.mount_bonus_of(u.get("current_mount"))
        except Exception:
            return (0.0, 0.0)

    def fmt_bonus(self, v: float) -> str:
        """加成显示：整数不写小数点（1.0 -> 1，0.5 -> 0.5）"""
        try:
            f = float(v)
        except Exception:
            return "0"
        if abs(f - round(f)) < 1e-9:
            return str(int(round(f)))
        return f"{f:g}"

    # ------------------------------------------------------------
    # ★★ 1.7.6：签到商店（保险箱 / 武器）
    # ------------------------------------------------------------
    SHOP_KIND_VAULT = "vault"      # 保险箱
    SHOP_KIND_WEAPON = "weapon"    # 武器（默认）
    # ★★ 1.7.7：食物 —— 消耗品，可重复购买，吃了解恢复体力
    SHOP_KIND_FOOD = "food"

    def shop_item_of(self, name) -> dict:
        """按名字取商店条目（找不到返回 {}）"""
        nm = str(name or "").strip()
        if not nm:
            return {}
        for it in (getattr(self, "shop_list", None) or []):
            if str(it.get("name") or "") == nm:
                return it
        return {}

    def shop_item_bonus(self, it: dict) -> tuple:
        """条目自带的 (偷取加成%, 防御加成%)"""
        if not isinstance(it, dict):
            return (0.0, 0.0)

        def _f(k):
            try:
                return float(it.get(k) or 0)
            except Exception:
                return 0.0

        return (max(0.0, _f("steal_bonus")), max(0.0, _f("defense_bonus")))

    def shop_item_rob_bonus(self, it: dict) -> float:
        """条目的抢银行加成（%）—— 1.7.7 新增字段，默认 0"""
        if not isinstance(it, dict):
            return 0.0
        try:
            return max(0.0, float(it.get("rob_bonus") or 0))
        except Exception:
            return 0.0

    # ------------------------------------------------------------
    # ★★ 1.7.7：武器**装备**机制
    #   买了不等于生效 —— 只有「装备武器」选中的那把才加 BUFF。
    # ------------------------------------------------------------
    @staticmethod
    def _is_weapon(it: dict) -> bool:
        """该商店条目是不是武器（保险箱、食物都不是）"""
        if not isinstance(it, dict):
            return False
        return str(it.get("kind") or "weapon") not in ("vault", "food")

    def owned_weapons_of(self, group_id, user_id) -> list:
        """
        该用户**已拥有**的武器名列表（按商店列表顺序，排除保险箱）。

        ★ 顺序稳定（跟商店顺序一致），所以序号在装备/查看里指同一个东西。
        """
        try:
            bought = set(self.user_shop_bought(group_id, user_id))
        except Exception:
            return []
        out = []
        for it in (getattr(self, "shop_list", None) or []):
            nm = str(it.get("name") or "")
            if nm and nm in bought and self._is_weapon(it):
                out.append(nm)
        return out

    def current_weapon_of(self, group_id, user_id) -> str:
        """当前装备的武器名（空 = 没装备）；已卖掉/删掉的自动视为没装备"""
        try:
            u = self._guser(group_id, user_id) or {}
        except Exception:
            return ""
        cur = str(u.get("current_weapon") or "").strip()
        if not cur:
            return ""
        # 装备的东西必须还在「已拥有武器」里，否则算没装备
        return cur if cur in self.owned_weapons_of(group_id, user_id) else ""

    def resolve_owned_weapon(self, group_id, user_id, arg) -> dict:
        """解析**已拥有**的武器（名字或序号），供装备用"""
        raw = str(arg or "").strip()
        owned = self.owned_weapons_of(group_id, user_id)
        if not raw:
            return {"ok": False, "name": "", "reason": "empty", "owned": owned}
        _low = raw.lower()
        for nm in owned:
            if nm.strip().lower() == _low:
                return {"ok": True, "name": nm, "reason": "found",
                        "owned": owned}
        if raw.isdigit():
            idx = int(raw) - 1
            if 0 <= idx < len(owned):
                return {"ok": True, "name": owned[idx], "reason": "found",
                        "owned": owned}
            return {"ok": False, "name": raw, "reason": "bad_index",
                    "owned": owned}
        # 没买过但商店里存在 -> 提示要买
        if self.shop_item_of(raw) and self._is_weapon(self.shop_item_of(raw)):
            return {"ok": False, "name": raw, "reason": "not_bought",
                    "owned": owned}
        return {"ok": False, "name": raw, "reason": "not_found",
                "owned": owned}

    def weapon_bonus_of_user(self, group_id, user_id) -> tuple:
        """
        该用户**已装备武器**带来的 (偷取加成%, 防御加成%, 抢银行加成%)。

        ★ 没装备 -> 全 0（这正是 1.7.7 的改动点）。
        ★ 保险箱不吃装备这一套：买了就永久生效（它没有「装备」概念）。
        """
        nm = self.current_weapon_of(group_id, user_id)
        if not nm:
            return (0.0, 0.0, 0.0)
        it = self.shop_item_of(nm)
        s, d = self.shop_item_bonus(it)
        r = self.shop_item_rob_bonus(it)
        return (s, d, r)

    def user_shop_bought(self, group_id, user_id) -> list:
        """该用户已购买的商店条目名列表"""
        try:
            u = self._guser(group_id, user_id) or {}
            v = u.get("shop_bought")
            return [str(x) for x in v] if isinstance(v, list) else []
        except Exception:
            return []

    def user_has_vault(self, group_id, user_id) -> bool:
        """是否买了保险箱"""
        for nm in self.user_shop_bought(group_id, user_id):
            if str(self.shop_item_of(nm).get("kind") or "") \
                    == self.SHOP_KIND_VAULT:
                return True
        return False

    def shop_bonus_of_user(self, group_id, user_id) -> tuple:
        """
        该用户由**商店物品**带来的 (偷取加成%, 防御加成%, 抢银行加成%)。

        规则（1.7.7 起）：
          · **武器必须装备才生效** —— 只算 `current_weapon` 那一把
          · **保险箱买了就永久生效**（它没有「装备」概念），
            额外给一份固定防御 `vault_steal_reduce`
          · 防御加成统一受 `shop_defense_cap` 上限约束
        ★ 返回值是 3 元组（多了抢银行加成），调用方已同步更新。
        """
        steal = 0.0
        defense = 0.0
        rob = 0.0
        # ① 已装备的武器
        s, d, r = self.weapon_bonus_of_user(group_id, user_id)
        steal += s
        defense += d
        rob += r
        # ② 保险箱（买了就生效，不看装备）
        if self.user_has_vault(group_id, user_id):
            defense += float(getattr(self, "vault_steal_reduce", 15.0) or 0)
        cap = float(getattr(self, "shop_defense_cap", 60.0) or 60.0)
        rob_cap = float(getattr(self, "shop_rob_bonus_cap", 20.0) or 20.0)
        return (steal, min(defense, cap), min(rob, rob_cap))

    def vault_money_of(self, group_id, user_id) -> int:
        """保险箱里的钱（只有买了保险箱才算）"""
        if not self.user_has_vault(group_id, user_id):
            return 0
        try:
            u = self._guser(group_id, user_id) or {}
            return max(0, int(u.get("vault_money", 0) or 0))
        except Exception:
            return 0

    def resolve_owned_msg(self, r: dict, cmd: str) -> str:
        """已拥有坐骑解析失败时的提示"""
        _owned = r.get("owned") or []
        if r.get("reason") == "empty":
            return (f"⚠️ 请指定坐骑名称或序号\n"
                    f"用法：「{cmd} 坐骑名」或「{cmd} 序号」\n"
                    f"📋 已拥有：{self.owned_mounts_text(_owned)}")
        if r.get("reason") == "bad_index":
            return (f"⚠️ 序号「{r.get('name')}」超出范围\n"
                    f"📋 已拥有：{self.owned_mounts_text(_owned)}")
        return (f"⚠️ 你还没有坐骑「{r.get('name')}」\n"
                f"📋 已拥有：{self.owned_mounts_text(_owned)}\n"
                f"💡 也可用序号，例如「{cmd} 1」")

    def do_mount_buy(self, event, mount_name: str) -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "mount"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        # ★ 1.7.6：支持「坐骑名」或「序号」
        _r = self.resolve_mount(mount_name)
        if not _r["ok"]:
            return self.resolve_mount_msg(_r, self.mount_buy_trigger_names[0])
        mount_name = _r["name"]
        target = _r["item"]

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u.setdefault("mounts", [])
        u.setdefault("current_mount", "")

        if mount_name in u["mounts"]:
            return f"⚠️ 你已经拥有坐骑「{mount_name}」了"

        price = int(target["price"])
        # ★ 1.7.6：先扣钱包，钱包不够自动从银行扣
        _pay = self.pay(group_id, user_id, price)
        if not _pay["ok"]:
            return self.short_hint(group_id, user_id, price)

        u["mounts"].append(mount_name)
        if not u["current_mount"]:
            u["current_mount"] = mount_name
        self._save()

        return "\n".join([
            f"{title_bar('购买坐骑')}",
            f"👤 {user_name}",
            f"🐴 坐骑：{mount_name}",
            self.pay_note(_pay),
            f"💰 钱包：{fmt_num(u['total_score'])}　🏦 银行：{fmt_num(u['bank'])}",
            "",
            "✅ 购买成功，已自动骑乘",
        ])

    def do_mount_add(self, arg: str) -> str:
        arg = str(arg or "").strip()
        if not arg:
            return (
                "⚠️ 参数不足\n"
                f"用法：「{self.cmd_mount_add_names[0]} 坐骑名 | 价格 | 描述」\n"
                "示例：「添加坐骑 修仙者专属 | 1000 | 脚踏飞剑，日行千里」"
            )
        parts = [x.strip() for x in arg.split("|")]
        if len(parts) < 1 or not parts[0]:
            return "⚠️ 坐骑名不能为空"

        name = parts[0]
        try:
            price = int(parts[1]) if len(parts) > 1 and parts[1] else 1000
        except Exception:
            return "⚠️ 价格必须是数字"
        if price < 0:
            price = 0

        desc = parts[2] if len(parts) > 2 else ""

        for m in self.mount_list:
            if m["name"] == name:
                return f"⚠️ 坐骑「{name}」已存在"

        self.mount_list.append({
            "name": name,
            "price": price,
            "desc": desc,
        })
        return (
            f"✅ 已添加坐骑：{name}\n"
            f"💰 价格：{price} {self._sn()}\n"
            f"📝 描述：{desc or '无'}\n"
            f"💡 请在 WebUI 点击「保存全部」以持久化"
        )

    def do_mount_del(self, arg: str) -> str:
        arg = str(arg or "").strip()
        if not arg:
            return (
                "⚠️ 参数不足\n"
                f"用法：「{self.cmd_mount_del_names[0]} 坐骑名或序号」\n"
                f"💡 可先发「{self.mount_list_trigger_names[0]}」查看序号"
            )

        idx = -1
        if arg.isdigit():
            n = int(arg) - 1
            if 0 <= n < len(self.mount_list):
                idx = n
        if idx == -1:
            for i, m in enumerate(self.mount_list):
                if m["name"] == arg:
                    idx = i
                    break
        if idx == -1:
            return f"⚠️ 未找到坐骑「{arg}」"

        removed = self.mount_list.pop(idx)
        return (
            f"✅ 已删除坐骑：{removed['name']}\n"
            f"💡 请在 WebUI 点击「保存全部」以持久化"
        )

    # ============================================================
    # 打工系统
    # ============================================================
    # ============================================================
    # ★★ 1.7.7：体力系统
    # ============================================================
    def stamina_of(self, group_id, uid) -> dict:
        """
        取某人的体力记录，**按天自动重置**（跨天回满，不累加）。

        返回 {"cur": 当前, "max": 上限, "date": 日期字符串}

        ★ 「不使用第二天恢复体力」的实现方式：
          记录里存 `stamina_date`，只要不是今天就**直接回满** ——
          不做任何增量叠加，所以「昨天没用完的也不累积」。
        """
        u = self._guser_setdefault(group_id, uid, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        today = _today_str()
        _max = max(0, int(getattr(self, "stamina_max", 100) or 0))
        if str(u.get("stamina_date") or "") != today:
            u["stamina_date"] = today
            u["stamina"] = _max
        try:
            cur = int(u.get("stamina", _max))
        except Exception:
            cur = _max
        cur = max(0, min(cur, _max))
        u["stamina"] = cur
        return {"cur": cur, "max": _max, "date": today}

    def stamina_cur(self, group_id, uid) -> int:
        """当前体力（会顺手做跨天重置，但**不落盘**）"""
        return int(self.stamina_of(group_id, uid).get("cur", 0))

    def stamina_add(self, group_id, uid, n: int) -> tuple:
        """
        加体力（食物 / 后台加）。返回 (实际加了多少, 加完剩多少)。

        ★ 上限是 `stamina_max`，超出部分**丢弃**（不溢出保存）。
        """
        st = self.stamina_of(group_id, uid)
        _max, cur = st["max"], st["cur"]
        try:
            n = int(n)
        except Exception:
            n = 0
        if n <= 0 or _max <= 0:
            return (0, cur)
        new = min(_max, cur + n)
        u = self._guser(group_id, uid) or {}
        u["stamina"] = new
        u["stamina_date"] = st["date"]
        return (new - cur, new)

    def stamina_cost(self, group_id, uid, n: int) -> bool:
        """
        扣体力。够就扣掉返回 True，不够返回 False（**不扣**）。
        """
        st = self.stamina_of(group_id, uid)
        try:
            n = int(n)
        except Exception:
            n = 0
        if n <= 0:
            return True
        if st["cur"] < n:
            return False
        u = self._guser(group_id, uid) or {}
        u["stamina"] = st["cur"] - n
        u["stamina_date"] = st["date"]
        return True

    def food_item_of(self, name) -> dict:
        """按名字找**食物**类商店条目（找不到返回空 dict）"""
        for it in (getattr(self, "shop_list", None) or []):
            if (str(it.get("name") or "") == str(name or "")
                    and str(it.get("kind") or "") == self.SHOP_KIND_FOOD):
                return it
        return {}

    def owned_foods_of(self, group_id, uid) -> dict:
        """
        该用户背包里的食物：{食物名: 数量}（只保留**商店里还存在**的）。

        ★ 食物是消耗品，所以按数量记在 `food_bag` 里，
          和 `shop_bought`（一次性买断的东西）分开。
        """
        u = self._guser(group_id, uid) or {}
        bag = u.get("food_bag")
        if not isinstance(bag, dict):
            return {}
        out = {}
        for k, v in bag.items():
            try:
                n = int(v or 0)
            except Exception:
                n = 0
            if n > 0 and self.food_item_of(k):
                out[str(k)] = n
        return out

    def food_restore_of(self, it: dict) -> int:
        """食物恢复多少体力（条目字段 `stamina_restore`，留空用全局默认）"""
        try:
            v = (it or {}).get("stamina_restore")
        except Exception:
            v = None
        if v is None or str(v).strip() == "":
            return max(0, int(getattr(self, "stamina_food_restore",
                                      30) or 0))
        try:
            return max(0, int(float(v)))
        except Exception:
            return 0

    def do_food_eat(self, event, arg: str = "") -> str:
        """
        ★★ 1.7.7：「吃食物 名字/序号 [/ 数量 / 全部]」—— 用食物恢复体力。

        用法（都支持，宽松解析）：
          · `吃食物 面包`        -> 吃 **1 个**（不带数字就是一个）
          · `吃食物 面包 3`      -> 吃 3 个
          · `吃食物 3`           -> 吃 3 个？不 —— 「3」是**序号**，吃 1 个
          · `吃食物 1 3`         -> 吃第 1 种食物 **3 个**
          · `吃食物 面包 3个`    -> 也认（末尾「个」自动去掉）
          · `吃食物 全部`        -> 有多少吃多少（吃到体力满为止）

        ★★ 判定规则：**最后一个纯数字**才是数量；位置参数当名字/序号。
          这样「吃食物 3」不会被误判成「吃 3 个」。

        ★ 指名道姓默认只吃 **1 个**（以前会一口气把该食物全吃光）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        _cmd = self.food_eat_trigger_names[0]
        bag = self.owned_foods_of(group_id, user_id)
        if not bag:
            return "\n".join([
                f"{title_bar('吃食物')}",
                f"👤 {user_name}",
                "",
                "🎒 你的背包里没有食物",
                f"💡 去「{self.shop_trigger_names[0]}」买食物",
            ])
        names = list(bag.keys())
        st = self.stamina_of(group_id, user_id)
        raw = str(arg or "").strip()

        # 没参数 -> 展示背包
        if not raw:
            lines = [f"{title_bar('吃食物')}", f"👤 {user_name}",
                     f"⚡ 当前体力：{st['cur']} / {st['max']}", "",
                     "🎒 背包里的食物"]
            for i, nm in enumerate(names, start=1):
                it = self.food_item_of(nm)
                lines.append(f"  {i}. {nm} ×{bag[nm]}"
                             f"（恢复 {self.food_restore_of(it)} 体力）")
            lines += ["", f"💡 吃：「{_cmd} 名字」或「{_cmd} 序号」（吃 1 个）",
                      f"💡 吃多个：「{_cmd} 名字 3」或「{_cmd} 序号 3」",
                      f"💡 一次吃完：「{_cmd} 全部」"]
            return "\n".join(lines)

        # ---- 解析「要吃哪种」和「吃几个」 ----
        #   ★ 最后一个纯数字 = 数量；剩下的当名字/序号。
        #     只有**一个 token 且是数字**时，它是**序号**（不是数量）。
        _eat_all = raw in ("全部", "all", "都吃")
        _qty = 1
        _target_raw = raw
        if not _eat_all:
            _toks = raw.replace("，", " ").split()
            if len(_toks) >= 2 and _toks[-1].rstrip("个").isdigit():
                _qty = max(1, int(_toks[-1].rstrip("个")))
                _target_raw = " ".join(_toks[:-1]).strip()
            elif len(_toks) >= 2:
                return "\n".join([
                    f"{title_bar('吃食物')}",
                    f"👤 {user_name}",
                    f"⚠️ 「{raw}」看不懂",
                    f"💡 用法：「{_cmd} 名字 数量」或「{_cmd} 名字」",
                ])

        want = []
        if _eat_all:
            want = list(names)
        else:
            one = ""
            if _target_raw.isdigit():
                idx = int(_target_raw) - 1
                if 0 <= idx < len(names):
                    one = names[idx]
            elif _target_raw in bag:
                one = _target_raw
            if not one:
                return "\n".join([
                    f"{title_bar('吃食物')}",
                    f"👤 {user_name}",
                    f"⚠️ 背包里没有「{_target_raw}」",
                    "",
                    f"🎒 有的：{'　'.join(f'{i}.{n}' for i, n in enumerate(names, start=1))}",
                ])
            want = [one]

        # 逐样吃，体力满了就停
        healed = 0
        ate = []
        for nm in want:
            if st["cur"] + healed >= st["max"]:
                break
            it = self.food_item_of(nm)
            gain_unit = self.food_restore_of(it)
            qty = int(bag.get(nm, 0))
            if gain_unit <= 0 or qty <= 0:
                continue
            # ★ 指定单个 -> 最多吃 `_qty` 个；「全部」-> 吃够为止
            _limit = qty if _eat_all else min(qty, _qty)
            used = 0
            for _ in range(_limit):
                if st["cur"] + healed >= st["max"]:
                    break
                healed += gain_unit
                used += 1
            if used:
                u = self._guser_setdefault(group_id, user_id, {})
                u["food_bag"][nm] = qty - used
                if u["food_bag"][nm] <= 0:
                    u["food_bag"].pop(nm, None)
                ate.append(f"{nm} ×{used}")
        if healed <= 0:
            return "\n".join([
                f"{title_bar('吃食物')}",
                f"👤 {user_name}",
                f"⚡ 体力已经满了（{st['cur']} / {st['max']}）",
                "💡 先消耗一点体力再吃，免得浪费",
            ])
        real, now = self.stamina_add(group_id, user_id, healed)
        self._save()
        lines = [
            f"{title_bar('吃食物')}",
            f"👤 {user_name}",
            f"🍖 吃掉：{'、'.join(ate)}",
            f"⚡ 恢复体力：+{real}",
            f"🔋 当前体力：{now} / {st['max']}",
        ]
        if now >= st["max"]:
            lines.append("　 （体力已满，剩下的留着下次吃）")
        return "\n".join(lines)

    def do_stamina_view(self, event) -> str:
        """
        ★★ 1.7.7：「我的体力」—— 看当前体力 + 背包食物 + 各工种消耗。

        ★ 加班提示也在这一页，免得用户找不到。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "checkin"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        if not getattr(self, "stamina_enable", True):
            return "⚠️ 体力系统未开启"
        st = self.stamina_of(group_id, user_id)
        self._save()          # 跨天重置要落盘
        lines = [
            f"{title_bar('我的体力')}",
            f"👤 {user_name}",
            "",
            f"🔋 当前体力：{st['cur']} / {st['max']}",
            f"📅 每日上限：{st['max']}（每天 0 点回满，不累积）",
        ]
        # 背包食物
        bag = self.owned_foods_of(group_id, user_id)
        if bag:
            _parts = []
            for nm, n in bag.items():
                it = self.food_item_of(nm)
                _parts.append(f"{nm} ×{n}（+{self.food_restore_of(it)}）")
            lines += ["", "🎒 背包食物：" + "　".join(_parts)]
            lines.append(f"　 💡 吃：「{self.food_eat_trigger_names[0]} 名字 [数量]」")
        else:
            lines += ["", "🎒 背包食物：暂无",
                      f"　 💡 去「{self.shop_trigger_names[0]}」买食物"]
        # 打工消耗说明
        if getattr(self, "job_enable", True) and self.job_list:
            lines += ["",
                      f"⚒ 打工消耗：每个工种随机 "
                      f"{self.job_stamina_min} ~ {self.job_stamina_max} 体力"]
            lines.append(f"　 💡 体力不够就不能打工")
            lines.append(f"　 💡 加班：「{self.stamina_refill_trigger_names[0]}"
                         f" 工种名」= 花体力一键清冷却")
        return "\n".join(lines)

    def do_stamina_refill(self, event, arg: str = "") -> str:
        """
        ★★ 1.7.7：「加班」—— 消耗体力**一键清掉某工种的冷却**。

        用法：
          · 「加班」        -> 列出正在冷却的工种 + 各自需要多少体力
          · 「加班 工种名」 -> 花体力立刻清掉该工种冷却
          · 「加班 全部」    -> 把所有冷却中的工种一起清掉

        ★ 消耗公式（后台可调）：
            需要体力 = max(加班最低体力, 剩余秒数 / 3600 × 每小时体力)
          不满 1 小时按 1 小时算（`stamina_refill_per_hour` 就是「每小时」）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "job"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        if not getattr(self, "stamina_enable", True):
            return "⚠️ 体力系统未开启，无法加班"
        if not self.job_list:
            return "⚠️ 暂无工种，请联系管理员添加"

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("job_cd", {})
        cd = u["job_cd"]
        now = time.time()
        _cmd = self.stamina_refill_trigger_names[0]

        # 找出还在冷却的工种
        cooling = []
        for j in self.job_list:
            jn = str(j.get("name") or "")
            if not jn:
                continue
            need_sec = int(j.get("duration_hours", 1) or 1) * 3600
            last_ts = float(cd.get(jn, 0) or 0)
            left = (last_ts + need_sec) - now
            if last_ts > 0 and left > 0:
                cooling.append((jn, int(left)))

        raw = str(arg or "").strip()
        if not raw:
            # ★★ 1.7.7：**加班状态** —— 用户要求「只输出当前可加班工种
            #   和不可加班工种即可」，所以这里只分两类、列名字 +
            #   加班所需体力，不再夹带指令说明（那部分移到「加班功能」
            #   下级菜单里）。
            _st_now = self.stamina_cur(group_id, user_id)
            _can, _cant = [], []
            for j in self.job_list:
                jn = str(j.get("name") or "")
                if not jn:
                    continue
                need_sec = int(j.get("duration_hours", 1) or 1) * 3600
                last_ts = float(cd.get(jn, 0) or 0)
                left = (last_ts + need_sec) - now
                if last_ts > 0 and left > 0:
                    _can.append((jn, self.stamina_refill_cost(int(left))))
                else:
                    _cant.append(jn)
            _status_cmd = (getattr(self, "stamina_refill_status_names", None)
                           or ["加班状态"])[0]
            _cmd_all = (getattr(self, "stamina_refill_all_names", None)
                        or ["全部加班"])[0]
            _cmd_one = (getattr(self, "stamina_refill_trigger_names", None)
                        or ["加班"])[0]

            def _lst(items, empty: str) -> list:
                if not items:
                    return [f"　 {empty}"]
                return [f"　 · {x}" for x in items]

            lines = [
                # ★ 标题用**状态指令名**（默认「加班」—— 裸指令也走这里）
                f"{title_bar(_status_cmd)}",
                f"👤 {user_name}",
                f"🔋 当前体力：{_st_now} / {self.stamina_max}",
                "",
                f"✅ 可加班工种（{len(_can)}）",
            ]
            lines += _lst([f"{jn}　需 {cost} 体力" for jn, cost in _can],
                          "没有工种在冷却")
            lines.append("")
            lines.append(f"❌ 不可加班工种（{len(_cant)}）")
            lines += _lst(_cant, "全部都在冷却中")
            lines += [
                "",
                f"💡 单独加班：「{_cmd_one} 工种名」",
                f"💡 全部加班：「{_cmd_all}」",
            ]
            return "\n".join(lines)

        # ★★ 1.7.7：全清支持后台自定义名（默认「全部加班」等），
        #   同时保留 全部/all 等口语写法。
        #   ★ `"__all__"` 是 main.py 分发「全部加班」指令时传进来的
        #     **内部哨兵**（因为那四个名字已经被分开匹配，走到这里时
        #     参数可能是空串，没法靠字面判断）。
        _all_names = {str(n).strip().lower() for n in
                      (getattr(self, "stamina_refill_all_names", None)
                       or ["全部加班"]) if str(n).strip()}
        _is_all = (raw == "__all__"
                   or raw.lower() in _all_names
                   or raw in ("全部", "all", "都清", "全都", "ALL", "All"))
        if _is_all:
            todo = [jn for jn, _l in cooling]
        else:
            todo = [raw] if any(jn == raw for jn, _l in cooling) else []
        if not todo:
            # ★★ 1.7.7：**两种失败要分开说** ——
            #   以前「加班全部」在没有工种冷却时也报
            #   「「加班全部」不在冷却中（或工种名不存在）」，
            #   像是在说「加班全部」是个工种名（用户反馈的文案 bug）。
            _status_cmd = (getattr(self, "stamina_refill_status_names", None)
                           or ["加班状态"])[0]
            if _is_all:
                return "\n".join([
                    f"{title_bar('加班')}",
                    f"👤 {user_name}",
                    "⚠️ 现在没有工种在冷却，不用加班",
                    f"🔋 当前体力：{self.stamina_cur(group_id, user_id)}"
                    f" / {self.stamina_max}",
                    f"💡 发「{_status_cmd}」看各工种状态",
                ])
            return "\n".join([
                f"{title_bar('加班')}",
                f"👤 {user_name}",
                f"⚠️「{raw}」不在冷却中（或工种名不存在）",
                f"💡 发「{_status_cmd}」看看哪些工种在冷却",
            ])

        # 逐个结算（体力不够就停）
        done = []
        for jn in todo:
            left = dict(cooling).get(jn, 0)
            cost = self.stamina_refill_cost(left)
            if not self.stamina_cost(group_id, user_id, cost):
                break
            # 清冷却：把上次时间往前推，使「已过时间」正好等于冷却时长
            need_sec = next((int(j.get("duration_hours", 1) or 1) * 3600
                             for j in self.job_list
                             if str(j.get("name") or "") == jn), 3600)
            cd[jn] = now - need_sec
            done.append(f"{jn}（-{cost} 体力）")
        if not done:
            # ★★ 1.7.7：说清楚**卡在哪个工种 / 要多少 / 还差多少**
            #   （以前只给「至少需要 N 体力」，看不出是哪个工种不够）
            _todo_costs = sorted(
                ((jn, self.stamina_refill_cost(_l))
                 for jn, _l in cooling if jn in todo),
                key=lambda x: x[1])
            _cur_st = self.stamina_cur(group_id, user_id)
            _need = _todo_costs[0][1] if _todo_costs else 0
            _who = _todo_costs[0][0] if _todo_costs else ""
            _total = sum(c for _n, c in _todo_costs)
            lines = [
                f"{title_bar('加班')}",
                f"👤 {user_name}",
                "⚠️ 体力不够，一个都没清掉",
                f"🔋 当前体力：{_cur_st} / {self.stamina_max}",
            ]
            if _who:
                lines.append(f"💡 最便宜的「{_who}」要 {_need} 体力"
                             f"（还差 {_need - _cur_st}）")
            if len(_todo_costs) > 1:
                lines.append(f"💡 全部清掉共需 {_total} 体力")
            lines.append("　 可以用「吃食物」补体力")
            return "\n".join(lines)
        self._save()
        _partial = len(done) < len(todo)
        lines = [
            f"{title_bar('加班')}",
            f"👤 {user_name}",
            # ★★ 1.7.7：没清完就别说「清空」了（以前只补一行小字，
            #   标题却已经宣布「冷却已清空」，容易误会）
            ("⚡ 加班完成（体力不够，只清了一部分）" if _partial
             else "✅ 加班完成，冷却已清空！"),
            "",
        ]
        lines += [f"　 · {x}" for x in done]
        lines += ["",
                  f"🔋 剩余体力：{self.stamina_cur(group_id, user_id)}"
                  f" / {self.stamina_max}"]
        if _partial:
            _rest = [jn for jn in todo if not any(jn in d for d in done)]
            lines.append(f"💡 还没清：{'、'.join(_rest)}")
            lines.append("　 可以用「吃食物」补体力后再清")
        else:
            lines.append(
                f"💡 现在可以直接发「{self.job_trigger_names[0]} 工种」继续工作")
        return "\n".join(lines)

    def stamina_refill_cost(self, left_sec: int) -> int:
        """加班清一个工种的冷却要花多少体力（后台可调）"""
        try:
            left = max(0, int(left_sec))
        except Exception:
            left = 0
        per_hour = max(0, int(getattr(self, "stamina_refill_per_hour", 10) or 0))
        _min = max(0, int(getattr(self, "stamina_refill_min", 5) or 0))
        hours = max(1, int((left + 3599) // 3600))   # 不足 1 小时按 1 小时
        return max(_min, per_hour * hours)

    def job_stamina_cost_of(self, job: dict) -> tuple:
        """
        ★★ 1.7.7：某工种的 (最少, 最多) 体力消耗。

        ★ 工种条目可用 `stamina_min` / `stamina_max` **单独覆盖**，
          留空则用全局 `job_stamina_min` / `job_stamina_max`。
        """
        def _pick(key, dflt):
            try:
                v = (job or {}).get(key)
            except Exception:
                v = None
            if v is None or str(v).strip() == "":
                return max(0, int(dflt or 0))
            try:
                return max(0, int(float(str(v).strip())))
            except Exception:
                return max(0, int(dflt or 0))

        lo = _pick("stamina_min", getattr(self, "job_stamina_min", 1))
        hi = _pick("stamina_max", getattr(self, "job_stamina_max", 5))
        if hi < lo:
            lo, hi = hi, lo
        return (lo, hi)

    def job_stamina_roll(self, job: dict) -> tuple:
        """
        摇一次该工种的体力消耗。返回 (消耗值, 最少, 最多)。

        ★ 体力关闭时返回 0（不消耗）。
        """
        if not getattr(self, "stamina_enable", True):
            return (0, 0, 0)
        lo, hi = self.job_stamina_cost_of(job)
        if hi <= 0:
            return (0, lo, hi)
        return (random.randint(lo, hi), lo, hi)

    def do_job_list(self) -> str:
        # ★★ 1.7.7 修正：`lines` 必须**先初始化** —— 之前加「体力消耗」
        #   那行时把 `lines = [title_bar(...)]` 误删了，于是这个函数
        #   一被调用就 `NameError: name 'lines' is not defined`，
        #   表现为用户发「打工列表」收到「❌ 查询失败」。
        lines = [f"{title_bar('打工列表')}"]
        if not self.job_list:
            lines.append("")
            lines.append("暂无工种，请联系管理员添加")
            lines.append("")
            lines.append(
                f"💡 管理员可用「{self.cmd_job_add_names[0]} 工种名 | 冷却小时 | 最少收益 | 最多收益」添加"
            )
            return "\n".join(lines)
        lines.append("")
        for i, j in enumerate(self.job_list, start=1):
            _smin, _smax = self.job_stamina_cost_of(j)
            lines.append(
                f"{i}. {j['name']} —— 冷却 {j['duration_hours']} 小时 "
                f"（{j['reward_min']}~{j['reward_max']} {self._sn()}）"
                + (f"　⚡{_smin}~{_smax} 体力"
                   if getattr(self, "stamina_enable", True) else "")
            )
        lines.append("")
        lines.append(f"💡 用「{self.job_trigger_names[0]} 工种」开始打工")
        # ★★ 1.7.6：顺手提示「全部打工」，否则用户不知道有这条指令
        _all = (getattr(self, "job_all_trigger_names", None)
                or ["全部打工"])[0]
        lines.append(f"💡 发「{_all}」可一次把所有工种各打一遍")
        return "\n".join(lines)

    def do_job_work(self, event, job_name: str = "") -> str:
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "job"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        if not self.job_list:
            return "⚠️ 暂无工种，请联系管理员添加"

        job_name = str(job_name).strip()
        if not job_name:
            return self.do_job_list()

        target = None
        for j in self.job_list:
            if j["name"] == job_name:
                target = j
                break
        if target is None:
            return (
                f"⚠️ 工种「{job_name}」不存在\n"
                f"💡 用「{self.job_info_trigger_names[0]}」查看可用工种"
            )

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u.setdefault("job_cd", {})

        cd = u["job_cd"]
        now = time.time()
        last_ts = float(cd.get(job_name, 0) or 0)
        need_sec = int(target["duration_hours"]) * 3600
        elapsed = now - last_ts
        if last_ts > 0 and elapsed < need_sec:
            remain = int(need_sec - elapsed)
            h, rem = divmod(remain, 3600)
            m, s = divmod(rem, 60)
            return (
                f"⚠️ 你刚刚已经做过「{job_name}」了\n"
                f"⏰ 还需等待：{h}小时{m}分{s}秒\n"
                f"💡 冷却完成后可以再做"
            )

        reward = random.randint(target["reward_min"], target["reward_max"])
        # ★★ 1.7.7：打工消耗体力 —— 不够就不能干
        _cost, _smin, _smax = self.job_stamina_roll(target)
        if _cost > 0 and not self.stamina_cost(group_id, user_id, _cost):
            return "\n".join([
                f"{title_bar('打工失败')}",
                f"👤 {user_name}",
                f"🔨 工种：{job_name}",
                "",
                f"⚡ 体力不够：需要 {_cost}，"
                f"当前只有 {self.stamina_cur(group_id, user_id)}",
                f"📅 体力每天 0 点回满 {self.stamina_max} 点",
                f"💡 吃食物恢复：「{self.food_eat_trigger_names[0]} 名字」",
                f"💡 看体力：「{self.stamina_view_trigger_names[0]}」",
            ])
        u["total_score"] = int(u.get("total_score", 0)) + reward
        cd[job_name] = now
        self._save()

        _lines = [
            f"{title_bar('打工结果')}",
            f"👤 {user_name}",
            f"🔨 工种：{job_name}",
            f"⏱️ 冷却：{target['duration_hours']} 小时",
            f"💵 获得：+{reward} {self._sn()}",
            f"💰 当前{self._sn()}：{u['total_score']}",
        ]
        if _cost > 0:
            _lines.append(f"⚡ 消耗体力：-{_cost}"
                          f"（剩 {self.stamina_cur(group_id, user_id)}"
                          f" / {self.stamina_max}）")
        _lines += [
            "",
            f"💡 下次可再做「{job_name}」需等 {target['duration_hours']} 小时",
        ]
        if _cost > 0:
            _lines.append(f"💡 急着做就发「{self.stamina_refill_trigger_names[0]}"
                          f" {job_name}」加班清冷却")
        return "\n".join(_lines)

    def do_job_work_all(self, event) -> str:
        """
        「全部打工」：**一次把所有工种各打一遍**（1.7.6 新增）。

        ★ 规则：
          · 每个工种各自判断冷却；冷却中的**跳过**（不算赚到）
          · 输出**只显示前 10 个**做成的工种，第 11 个起用省略号带过
            —— 但**实际全部结算并保存**（钱一分不少）
          · 最下面显示本次总计赚到的金额

        ★ 触发词由后台 `job_all_trigger_names` 自定义。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "job"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        if not self.job_list:
            return "⚠️ 暂无工种，请联系管理员添加"

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("bank", 0)
        u.setdefault("job_cd", {})
        cd = u["job_cd"]
        now = time.time()

        done = []        # [(工种名, 赚到的钱, 冷却小时)]  —— 全部（含省略的）
        cooling = []     # [工种名] 冷却中跳过
        no_stamina = []  # 体力不够跳过的工种
        drank_total = 0  # 本次总共消耗的体力
        for j in self.job_list:
            jn = str(j.get("name") or "")
            if not jn:
                continue
            need_sec = int(j.get("duration_hours", 1)) * 3600
            last_ts = float(cd.get(jn, 0) or 0)
            if last_ts > 0 and (now - last_ts) < need_sec:
                cooling.append(jn)
                continue
            rmin = int(j.get("reward_min", 0))
            rmax = int(j.get("reward_max", 0))
            if rmax < rmin:
                rmin, rmax = rmax, rmin
            reward = random.randint(rmin, rmax) if rmax > rmin else rmin
            # ★★ 1.7.7：先扣体力 —— 不够就停（后面的工种也不做了）
            _cost_j, _sj_min, _sj_max = self.job_stamina_roll(j)
            if _cost_j > 0 and not self.stamina_cost(group_id, user_id, _cost_j):
                no_stamina.append(jn)
                break
            # ★ 真的结算：钱和冷却都写进去（即使不显示）
            u["total_score"] = int(u.get("total_score", 0)) + reward
            cd[jn] = now
            drank_total += _cost_j
            done.append((jn, reward, int(j.get("duration_hours", 1))))

        if not done and not cooling:
            return "⚠️ 暂无可做的工种，请联系管理员添加"

        if done:
            self._save()

        total = sum(x[1] for x in done)
        _title = (getattr(self, "job_all_trigger_names", None)
                  or ["全部打工"])[0]

        if not done:
            # 全都在冷却
            lines = [
                f"{title_bar(_title)}",
                f"👤 {user_name}",
                "",
                f"⚠️ 全部 {len(cooling)} 个工种都在冷却中，暂时没法打工",
            ]
            # 挑最短的剩余时间告诉用户
            _next = None
            for j in self.job_list:
                jn = str(j.get("name") or "")
                if jn not in cooling:
                    continue
                need_sec = int(j.get("duration_hours", 1)) * 3600
                left = need_sec - (now - float(cd.get(jn, 0) or 0))
                if left > 0 and (_next is None or left < _next[1]):
                    _next = (jn, left)
            if _next:
                _h, _rem = divmod(int(_next[1]), 3600)
                _m, _s = divmod(_rem, 60)
                lines.append(
                    f"⏰ 最快可做：「{_next[0]}」还需 {_h}小时{_m}分{_s}秒")
            return "\n".join(lines)

        SHOW = 10
        lines = [
            f"{title_bar(_title)}",
            f"👤 {user_name}",
            "",
        ]
        for i, (jn, reward, hrs) in enumerate(done[:SHOW], start=1):
            lines.append(f"{i}. {jn} —— +{reward} {self._sn()}")
        if len(done) > SHOW:
            # ★ 多余的只**不显示**，钱照样给了（这里明确告诉用户数量）
            lines.append(
                f"…… 还有 {len(done) - SHOW} 个工种已结算（未逐个列出）")
        lines.append("")
        lines.append(f"💵 本次共赚：+{total} {self._sn()}")
        # ★★ 1.7.7：体力消耗汇总
        if drank_total > 0:
            lines.append(f"⚡ 消耗体力：-{drank_total}"
                         f"（剩 {self.stamina_cur(group_id, user_id)}"
                         f" / {self.stamina_max}）")
        if no_stamina:
            lines.append(f"🔋 体力不够，{len(no_stamina)} 个工种没做成"
                         f"（{no_stamina[0]} 起）")
            lines.append(f"　 💡 吃食物恢复：「{self.food_eat_trigger_names[0]}"
                         f" 名字」")
        if cooling:
            lines.append(f"⏳ 另有 {len(cooling)} 个工种冷却中，已跳过")
        lines.append(f"💰 当前{self._sn()}：{u['total_score']}")
        lines.append("")
        lines.append(
            f"💡 共 {len(done)} 个工种结算完成（显示前 {min(SHOW, len(done))} 个）")
        return "\n".join(lines)

    # ============================================================
    # ★★ 1.7.6：签到商店（保险箱 / 武器）
    # ============================================================
    SHOP_PAGE_SIZE = 10    # ★★ 1.7.7：签到商店每页 10 个商品

    def do_shop_list(self, event=None, group_id="", page=1) -> str:
        """
        「签到商店 [页码]」：列出可买的东西 + 自己已拥有的。

        ★ 条目由后台独立数据文件维护（`shop_list`）。
        ★★ 1.7.7：**每页 10 个商品**，用「签到商店 2」翻页。
          · 序号是**绝对编号**（第 2 页从 11 开始），所以
            「购买商品 12」在哪个页面看都指同一个商品。
          · 翻页提示用的是商店指令名 + 页码。
        """
        if event is not None:
            group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        lines = [f"{title_bar('签到商店')}"]
        if not self.shop_list:
            lines.append("")
            lines.append("暂无商品，请联系管理员添加")
            return "\n".join(lines)

        _uid = get_user_id(event) if event is not None else ""
        _bought = self.user_shop_bought(group_id, _uid) if _uid else []
        # ★★ 1.7.7：当前启用的武器（列表里要标出来，让人知道哪把在生效）
        _cur_w = self.current_weapon_of(group_id, _uid) if _uid else ""
        # ★★ 1.7.7：背包食物（列表里显示数量）
        _bag = self.owned_foods_of(group_id, _uid) if _uid else {}

        # ★★ 1.7.7：**按三类分组显示**（保险箱 → 武器 → 食物），
        #   每类加个小标题，比混在一堆里好找（用户要求「优化种类物品」）。
        #   ★ 序号仍是**绝对编号**（原始位置），所以「购买商品 12」不变。
        _groups = [(self.SHOP_KIND_VAULT, "🧰 保险箱"),
                   (self.SHOP_KIND_WEAPON, "⚔️ 武器"),
                   (self.SHOP_KIND_FOOD, "🍖 食物")]
        _by_kind = {}
        for _idx, _it in enumerate(self.shop_list):
            _k = str(_it.get("kind") or self.SHOP_KIND_WEAPON)
            _by_kind.setdefault(_k, []).append(_idx)
        # 未知 kind 兜底到武器组
        for _k in list(_by_kind.keys()):
            if _k not in [g[0] for g in _groups]:
                _by_kind.setdefault(self.SHOP_KIND_WEAPON, []).extend(
                    _by_kind.pop(_k))
        _shown_any = False
        for _kind, _label in _groups:
            _idxs = _by_kind.get(_kind) or []
            if not _idxs:
                continue
            lines.append(f"── {_label}（{len(_idxs)}）──")
            for i in _idxs:
                it = self.shop_list[i]
                nm = str(it.get("name") or "")
                kind = str(it.get("kind") or self.SHOP_KIND_WEAPON)
                _tag = ("🧰" if kind == self.SHOP_KIND_VAULT
                        else "🍖" if kind == self.SHOP_KIND_FOOD else "⚔️")
                _own = ""
                if kind == self.SHOP_KIND_FOOD:
                    # ★★ 1.7.7：食物显示背包数量（消耗品，可反复买）
                    _n = int((_bag or {}).get(nm, 0) or 0)
                    _own = f"　🎒×{_n}" if _n > 0 else ""
                elif nm in _bought:
                    _own = ("　⭐已启用" if nm == _cur_w else "　✅已拥有")
                # ★ 序号用**绝对编号**（i 是 0 基，所以 +1）
                lines.append(f"{_tag} {i + 1}. {nm} —— {it.get('price', 0)} "
                             f"{self._sn()}{_own}")
                if it.get("desc"):
                    lines.append(f"　　{it['desc']}")
                s, d = self.shop_item_bonus(it)
                r = self.shop_item_rob_bonus(it)
                if kind == self.SHOP_KIND_FOOD:
                    # ★★ 1.7.7：食物 —— 恢复量 + 可批量买
                    lines.append(
                        f"　　⚡ 恢复体力 +{self.food_restore_of(it)}"
                        "　+ 可重复买（「购买商品 "
                        f"{nm} 3」一次买 3 个）")
                elif kind == self.SHOP_KIND_VAULT:
                    lines.append("　　🥷 降低被偷概率 "
                                 f"{self.fmt_bonus(self.vault_steal_reduce)}%"
                                 "　+ 可存钱（存的钱偷不走）")
                else:
                    _eff = []
                    if s > 0:
                        _eff.append(f"偷积分成功率 +{self.fmt_bonus(s)}%")
                    if d > 0:
                        _eff.append(f"被偷概率 -{self.fmt_bonus(d)}%")
                    if r > 0:
                        _eff.append(f"抢银行成功率 +{self.fmt_bonus(r)}%")
                    if _eff:
                        lines.append("　　" + "　".join(_eff))
                    # ★★ 1.7.7：破保险箱能力（武器可单独覆盖，留空用全局）
                    _br = 0.0
                    try:
                        _v = it.get("vault_break_rate")
                        _br = (float(getattr(self, "vault_break_rate", 0.0)
                                     or 0.0)
                               if _v is None or str(_v).strip() == ""
                               else max(0.0, float(_v)))
                    except Exception:
                        _br = 0.0
                    if _br > 0:
                        lines.append(
                            f"　　🔨 破保险箱概率 {self.fmt_bonus(_br)}%"
                            "（偷积分时可能撬开对方保险箱）")
                _shown_any = True
            lines.append("")
        if not _shown_any:
            lines.append("暂无商品，请联系管理员添加")
        # ★★ 1.7.7：用户要求「签到商店只显示商品，其余移除」——
        #   购买 / 启用武器 / 我的装备 / 体力 / 保险箱余额等提示全部去掉
        #   （那些都写在「商店帮助」菜单里）。
        #   ★ 也不再分页：改成**按三类分组**后，12 件商品一屏看得完，
        #     分组比翻页更直观（用户要求「优化种类物品」）。
        return "\n".join(lines)

    def do_shop_buy(self, event, item_raw: str = "") -> str:
        """购买商店物品。支持名字或序号。"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        if not self.shop_list:
            return "⚠️ 暂无商品，请联系管理员添加"

        raw = str(item_raw or "").strip()
        if not raw:
            return self.do_shop_list(event=event)

        # ★★ 1.7.7：**先解析数量，再解析商品** ——
        #   「面包 3」如果先丢给 resolve_shop_item 会整体匹配失败。
        #   规则：最后一个纯数字是数量（长度 ≥2 的 token 序列）；
        #   单个纯数字仍是**序号**。
        _qty = 1
        _toks = raw.replace("，", " ").split()
        if len(_toks) >= 2 and _toks[-1].rstrip("个").isdigit():
            _qty = max(1, int(_toks[-1].rstrip("个")))
            raw = " ".join(_toks[:-1]).strip()

        target = self.resolve_shop_item(raw)
        if not target:
            return (f"⚠️ 商品「{raw}」不存在\n"
                    f"💡 用「{self.shop_trigger_names[0]}」查看可买的东西")

        nm = str(target.get("name") or "")
        price = int(target.get("price", 0) or 0)
        kind = str(target.get("kind") or self.SHOP_KIND_WEAPON)
        # ★ 只有食物支持买多个（其他是买一次就够的东西）
        if kind != self.SHOP_KIND_FOOD:
            _qty = 1

        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u["name"] = user_name
        u.setdefault("shop_bought", [])
        u.setdefault("food_bag", {})

        # ★★ 1.7.7：食物是**消耗品** —— 可以反复买，进背包；其他商品买一次
        if kind == self.SHOP_KIND_FOOD:
            if nm in [str(x) for x in u["shop_bought"]]:
                # 以前误把食物当装备买过 -> 允许继续买，只是不再记 shop_bought
                pass
        elif nm in [str(x) for x in u["shop_bought"]]:
            return (f"⚠️ 你已经买过「{nm}」了\n"
                    f"💡 每样只需要买一次")

        # ★★ 1.7.7：数量已在上面解析好了（`_qty`），这里只算总价。
        #   ★ 不要再重复解析一遍 —— 之前留了个旧块把 `_qty` 重置成 1，
        #     导致「买 3 个」只买到 1 个。
        _total = price * max(1, _qty)

        wallet = int(u.get("total_score", 0) or 0)
        if wallet < _total:
            return "\n".join([
                f"{title_bar('购买失败')}",
                f"👤 {user_name}",
                f"🛒 商品：{nm}" + (f" ×{_qty}" if _qty > 1 else ""),
                f"💰 价格：{price} {self._sn()}"
                + (f" × {_qty} = {_total}" if _qty > 1 else ""),
                f"💳 你的{self._sn()}：{fmt_num(wallet)}",
                "",
                f"⚠️ 还差 {fmt_num(_total - wallet)} {self._sn()}",
            ])

        u["total_score"] = wallet - _total
        _bag_n = 0
        if kind == self.SHOP_KIND_FOOD:
            # ★ 食物进背包（数量 += _qty），不写 shop_bought
            _bag = u["food_bag"]
            _bag[nm] = int(_bag.get(nm, 0) or 0) + _qty
            _bag_n = _bag[nm]
        else:
            u["shop_bought"] = list(u["shop_bought"]) + [nm]
        if kind == self.SHOP_KIND_VAULT:
            u.setdefault("vault_money", 0)
        self._save()

        lines = [
            f"{title_bar('购买成功')}",
            f"👤 {user_name}",
            f"🛒 商品：{nm}" + (f" ×{_qty}" if _qty > 1 else ""),
            f"💸 花费：-{fmt_num(_total)} {self._sn()}"
            + (f"（{price} × {_qty}）" if _qty > 1 else ""),
            f"💳 当前{self._sn()}：{fmt_num(u['total_score'])}",
        ]
        s, d = self.shop_item_bonus(target)
        if kind == self.SHOP_KIND_FOOD:
            # ★★ 1.7.7：食物 —— 报背包数量 + 怎么吃
            lines += [
                "",
                f"🍖 已放入背包：{nm} ×{_bag_n}",
                f"　 · 恢复体力 +{self.food_restore_of(target)} / 个",
                f"💡 吃：「{self.food_eat_trigger_names[0]} {nm}」"
                f"或「{self.food_eat_trigger_names[0]} {nm} 3」",
            ]
        elif kind == self.SHOP_KIND_VAULT:
            lines += [
                "",
                "🧰 已获得保险箱：",
                f"　 · 签到统计里会显示保险箱余额",
                f"　 · 存进去的钱**别人偷不走**",
                f"　 · 被偷概率 -{self.fmt_bonus(self.vault_steal_reduce)}%",
                f"💡 存钱：「{self.shop_save_trigger_names[0]} 金额」",
            ]
        else:
            _eff = []
            if s > 0:
                _eff.append(f"偷积分成功率 +{self.fmt_bonus(s)}%")
            if d > 0:
                _eff.append(f"被偷概率 -{self.fmt_bonus(d)}%")
            if _eff:
                lines += ["", "⚔️ 已获得加成：", "　 " + "　".join(_eff)]
        return "\n".join(lines)

    def resolve_shop_item(self, raw: str) -> dict:
        """把「名字」或「序号」解析成商店条目；失败返回 {}"""
        s = str(raw or "").strip()
        if not s:
            return {}
        # ① 序号
        if s.isdigit():
            i = int(s)
            if 1 <= i <= len(self.shop_list):
                return self.shop_list[i - 1]
            return {}
        # ② 名字（精确）
        for it in self.shop_list:
            if str(it.get("name") or "") == s:
                return it
        # ③ 名字（大小写/空格不敏感）
        low = s.lower().replace(" ", "")
        for it in self.shop_list:
            if str(it.get("name") or "").lower().replace(" ", "") == low:
                return it
        return {}

    def do_shop_save(self, event, amount_raw: str = "") -> str:
        """把钱包里的钱存进保险箱（需要先买保险箱）"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        if not self.user_has_vault(group_id, user_id):
            return (f"⚠️ 你还没有保险箱\n"
                    f"💡 先去「{self.shop_trigger_names[0]}」买一个")

        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        u.setdefault("vault_money", 0)
        wallet = int(u.get("total_score", 0) or 0)
        vault = int(u.get("vault_money", 0) or 0)

        s = str(amount_raw or "").strip()
        if not s:
            return "\n".join([
                f"{title_bar('存入保险箱')}",
                f"👤 {user_name}",
                f"💳 钱包：{fmt_num(wallet)}",
                f"🧰 保险箱：{fmt_num(vault)}",
                "",
                f"💡 用法：「{self.shop_save_trigger_names[0]} 金额」",
                f"　 全部存入：「{self.shop_save_trigger_names[0]} 全部」",
            ])
        if s in ("全部", "all", "所有"):
            amount = wallet
        else:
            try:
                amount = int(s)
            except Exception:
                return f"⚠️ 金额要填数字，例如「{self.shop_save_trigger_names[0]} 1000」"
        if amount <= 0:
            return "⚠️ 金额要大于 0"
        if amount > wallet:
            return (f"⚠️ 钱包里只有 {fmt_num(wallet)} {self._sn()}\n"
                    f"💡 想全存就发「{self.shop_save_trigger_names[0]} 全部」")

        u["total_score"] = wallet - amount
        u["vault_money"] = vault + amount
        self._save()
        return "\n".join([
            f"{title_bar('存入保险箱')}",
            f"👤 {user_name}",
            f"📥 存入：+{fmt_num(amount)} {self._sn()}",
            "",
            f"💳 钱包：{fmt_num(u['total_score'])}",
            f"🧰 保险箱：{fmt_num(u['vault_money'])}",
            "",
            "🛡 保险箱里的钱**别人偷不走**",
        ])

    def do_shop_take(self, event, amount_raw: str = "") -> str:
        """从保险箱把钱取回钱包"""
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"

        if not self.user_has_vault(group_id, user_id):
            return (f"⚠️ 你还没有保险箱\n"
                    f"💡 先去「{self.shop_trigger_names[0]}」买一个")

        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return "⚠️ 你还没有签到记录，先去签到吧"
        u.setdefault("vault_money", 0)
        wallet = int(u.get("total_score", 0) or 0)
        vault = int(u.get("vault_money", 0) or 0)

        s = str(amount_raw or "").strip()
        if not s:
            return "\n".join([
                f"{title_bar('取出保险箱')}",
                f"👤 {user_name}",
                f"💳 钱包：{fmt_num(wallet)}",
                f"🧰 保险箱：{fmt_num(vault)}",
                "",
                f"💡 用法：「{self.shop_take_trigger_names[0]} 金额」",
                f"　 全部取出：「{self.shop_take_trigger_names[0]} 全部」",
            ])
        if s in ("全部", "all", "所有"):
            amount = vault
        else:
            try:
                amount = int(s)
            except Exception:
                return f"⚠️ 金额要填数字，例如「{self.shop_take_trigger_names[0]} 1000」"
        if amount <= 0:
            return "⚠️ 金额要大于 0"
        if amount > vault:
            return (f"⚠️ 保险箱里只有 {fmt_num(vault)} {self._sn()}\n"
                    f"💡 想全取就发「{self.shop_take_trigger_names[0]} 全部」")

        u["total_score"] = wallet + amount
        u["vault_money"] = vault - amount
        self._save()
        return "\n".join([
            f"{title_bar('取出保险箱')}",
            f"👤 {user_name}",
            f"📤 取出：+{fmt_num(amount)} {self._sn()}",
            "",
            f"💳 钱包：{fmt_num(u['total_score'])}",
            f"🧰 保险箱：{fmt_num(u['vault_money'])}",
            "",
            "⚠️ 取出来的钱又会被别人偷了",
        ])

    # ------------------------------------------------------------
    # ★★ 1.7.7：启用武器（武器只有装备了才加 BUFF）
    # ------------------------------------------------------------
    def do_shop_equip(self, event, arg: str = "") -> str:
        """
        「启用武器 名字/序号」—— 装备一把已购买的武器。

        ★ 1.7.7 核心规则：**买了不等于生效**，只有装备的那把算加成。
        ★ 支持名字，也支持序号（序号按**已拥有武器**的顺序，排除保险箱）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser_setdefault(group_id, user_id, {
            "total_score": 0, "total_checkin": 0, "last_date": "",
            "streak": 0, "month_map": {}, "bank": 0,
        })
        u.setdefault("current_weapon", "")
        _cmd = self.shop_equip_trigger_names[0]
        _owned = self.owned_weapons_of(group_id, user_id)

        # ① 没参数：列出已拥有武器 + 当前装备
        if not str(arg or "").strip():
            lines = [f"{title_bar('启用武器')}", f"👤 {user_name}", ""]
            if not _owned:
                lines += ["⚔️ 还没有任何武器",
                          f"💡 先去「{self.shop_trigger_names[0]}」购买"]
                return "\n".join(lines)
            _cur = self.current_weapon_of(group_id, user_id)
            lines.append(f"⚔️ 已拥有武器（共 {len(_owned)} 把）")
            lines.append("")
            for i, nm in enumerate(_owned, start=1):
                _tag = "　⭐当前启用" if nm == _cur else ""
                lines.append(f"  {i}. {nm}{_tag}")
            lines += ["",
                      f"💡 启用：「{_cmd} 名字」或「{_cmd} 序号」",
                      "⚠️ 武器**必须启用**才加加成，没启用的只是收藏",
                      f"💡 看完整装备发「{self.my_equip_trigger_names[0]}」"]
            return "\n".join(lines)

        # ② 解析
        _r = self.resolve_owned_weapon(group_id, user_id, arg)
        if not _r["ok"]:
            why = _r.get("reason")
            _hint = {
                "empty": f"⚠️ 请填武器名或序号，例如「{_cmd} 1」",
                "bad_index": f"⚠️ 序号超出范围（你有 {len(_owned)} 把武器）",
                "not_bought": "⚠️ 这把武器你还没买",
                "not_found": "⚠️ 没有这把武器",
            }.get(why, "⚠️ 无法识别")
            lines = [f"{title_bar('启用武器')}", f"👤 {user_name}", _hint]
            if _owned:
                lines += ["",
                          f"⚔️ 你已拥有：{self.owned_weapons_text(_owned)}"]
            else:
                lines += ["", f"💡 先去「{self.shop_trigger_names[0]}」购买武器"]
            return "\n".join(lines)

        nm = _r["name"]
        it = self.shop_item_of(nm)
        s, d = self.shop_item_bonus(it)
        r = self.shop_item_rob_bonus(it)
        u["current_weapon"] = nm
        u["name"] = user_name
        self._save()

        lines = [
            f"{title_bar('启用武器')}",
            f"👤 {user_name}",
            f"💰 拥有{self._sn()}：{fmt_num(u.get('total_score', 0))}",
            "",
            f"⚔️ 武器：{nm}",
            "",
            "✅ 启用成功！",
        ]
        _buffs = []
        if s > 0:
            _buffs.append(f"　 🦸 偷积分成功率 +{self.fmt_bonus(s)}%")
        if d > 0:
            _buffs.append(f"　 🛡 被偷概率 -{self.fmt_bonus(d)}%")
        if r > 0:
            _buffs.append(f"　 🏦 抢银行成功率 +{self.fmt_bonus(r)}%")
        if _buffs:
            lines.append("✨ 生效加成：")
            lines += _buffs
        else:
            lines.append("（这把武器没有加成）")
        lines += ["",
                  "💡 换武器用同一个指令；换掉后原来的加成不再生效",
                  f"💡 看完整装备发「{self.my_equip_trigger_names[0]}」"]
        return "\n".join(lines)

    def do_my_equip(self, event) -> str:
        """
        ★★ 1.7.7：「我的装备」—— 看当前启用的坐骑 / 武器 + 全部加成。

        分三段：当前装备 / 加成明细 / 已拥有但没启用的（提示怎么启用）。
        """
        group_id = get_group_id(event)
        if not self._is_group_allowed(group_id, "shop"):
            return ""
        user_id = get_user_id(event)
        user_name = get_user_name(event) or f"QQ{user_id}"
        u = self._guser(group_id, user_id)
        if not isinstance(u, dict):
            return f"⚠️ 你还没有签到记录，先去签到吧"

        mount = str(u.get("current_mount") or "").strip()
        weapon = self.current_weapon_of(group_id, user_id)
        m_steal, m_rob = self.mount_bonus_of(mount) if mount else (0.0, 0.0)
        w_steal, w_def, w_rob = self.weapon_bonus_of_user(group_id, user_id)
        has_vault = self.user_has_vault(group_id, user_id)
        vault_def = (float(getattr(self, "vault_steal_reduce", 15.0) or 0)
                     if has_vault else 0.0)
        _dcap = float(getattr(self, "shop_defense_cap", 60.0) or 60.0)
        _rcap = float(getattr(self, "shop_rob_bonus_cap", 20.0) or 20.0)
        steal = m_steal + w_steal
        defense = min(w_def + vault_def, _dcap)
        rob = min(m_rob + w_rob, _rcap)

        lines = [f"{title_bar('我的装备')}", f"👤 {user_name}", "",
                 "── 当前装备 ──"]
        # ★★ 市场版：不再插入坐骑图片（`[[img:...]]` 已移除）
        lines.append(f"🐴 坐骑：{mount}" if mount else "🐴 坐骑：未装备")
        lines.append(f"⚔️ 武器：{weapon}" if weapon else "⚔️ 武器：未启用")
        if has_vault:
            lines.append("🧰 保险箱：已拥有")
        lines += ["", "── 加成明细 ──"]
        if steal > 0:
            lines.append(f"🦸 偷积分成功率 +{self.fmt_bonus(steal)}%")
            _src = []
            if m_steal > 0:
                _src.append(f"坐骑 +{self.fmt_bonus(m_steal)}%")
            if w_steal > 0:
                _src.append(f"武器 +{self.fmt_bonus(w_steal)}%")
            if _src:
                lines.append(f"　 （{'　'.join(_src)}）")
        if defense > 0:
            lines.append(f"🛡 被偷概率 -{self.fmt_bonus(defense)}%")
            _src = []
            if w_def > 0:
                _src.append(f"武器 -{self.fmt_bonus(w_def)}%")
            if vault_def > 0:
                _src.append(f"保险箱 -{self.fmt_bonus(vault_def)}%")
            if _src:
                lines.append(f"　 （{'　'.join(_src)}）")
        if rob > 0:
            lines.append(f"🏦 抢银行成功率 +{self.fmt_bonus(rob)}%")
            _src = []
            if m_rob > 0:
                _src.append(f"坐骑 +{self.fmt_bonus(m_rob)}%")
            if w_rob > 0:
                _src.append(f"武器 +{self.fmt_bonus(w_rob)}%")
            if _src:
                lines.append(f"　 （{'　'.join(_src)}）")
        if steal <= 0 and defense <= 0 and rob <= 0:
            lines.append("（暂无加成 —— 装备坐骑或启用武器后就有了）")

        # 已拥有但没启用的
        _mounts = self._owned_mounts_of(group_id, user_id)
        _weapons = self.owned_weapons_of(group_id, user_id)
        _idle_w = [x for x in _weapons if x != weapon]
        _idle_m = [x for x in _mounts if x != mount]
        if _idle_m or _idle_w:
            lines += ["", "── 已拥有（未启用）──"]
            if _idle_m:
                lines.append(f"🐴 坐骑：{self.owned_mounts_text(_idle_m)}")
                lines.append(f"　 💡 启用：「{self.mount_equip_names[0]} 名字/序号」")
            if _idle_w:
                lines.append(f"⚔️ 武器：{self.owned_weapons_text(_idle_w)}")
                lines.append("　 💡 启用："
                             f"「{self.shop_equip_trigger_names[0]} 名字/序号」")
        elif not mount and not weapon:
            lines += ["", f"💡 先去「{self.shop_trigger_names[0]}」购买武器，"
                          f"再用「{self.shop_equip_trigger_names[0]} 名字」启用"]
        return "\n".join(lines)

    def owned_weapons_text(self, owned: list) -> str:
        """已拥有武器拼成一行（用于提示）"""
        if not owned:
            return "（暂无）"
        return "　".join(f"{i}.{nm}" for i, nm in enumerate(owned, start=1))

    # ============================================================
    # 管理员工种管理
    # ============================================================
    def do_job_add(self, arg: str) -> str:
        arg = str(arg or "").strip()
        if not arg:
            return (
                "⚠️ 参数不足\n"
                f"用法：「{self.cmd_job_add_names[0]} 工种名 | 冷却小时 | 最少收益 | 最多收益」\n"
                "示例：「添加工种 搬砖 | 5 | 100 | 500」"
            )
        parts = [x.strip() for x in arg.split("|")]
        if len(parts) < 2:
            return (
                "⚠️ 参数不足\n"
                f"用法：「{self.cmd_job_add_names[0]} 工种名 | 冷却小时 | 最少收益 | 最多收益」\n"
                "示例：「添加工种 搬砖 | 5 | 100 | 500」"
            )
        name = parts[0].strip()
        if not name:
            return "⚠️ 工种名不能为空"
        try:
            dur = int(parts[1]) if len(parts) >= 2 and parts[1] else 1
        except Exception:
            return "⚠️ 冷却小时必须是数字"
        try:
            rmin = int(parts[2]) if len(parts) >= 3 and parts[2] else 10
        except Exception:
            return "⚠️ 最少收益必须是数字"
        try:
            rmax = int(parts[3]) if len(parts) >= 4 and parts[3] else 100
        except Exception:
            return "⚠️ 最多收益必须是数字"
        if dur < 1:
            return "⚠️ 冷却至少 1 小时"
        if rmin < 0:
            rmin = 0
        if rmax < rmin:
            rmax = rmin

        for j in self.job_list:
            if j["name"] == name:
                return f"⚠️ 工种「{name}」已存在"

        self.job_list.append({
            "name": name,
            "duration_hours": dur,
            "reward_min": rmin,
            "reward_max": rmax,
        })
        return (
            f"✅ 已添加工种：{name}\n"
            f"⏱️ 冷却：{dur} 小时\n"
            f"💰 收益：{rmin}~{rmax} {self._sn()}\n"
            f"💡 请在 WebUI 点击「保存全部」以持久化"
        )

    def do_job_del(self, arg: str) -> str:
        arg = str(arg or "").strip()
        if not arg:
            return (
                "⚠️ 参数不足\n"
                f"用法：「{self.cmd_job_del_names[0]} 工种名或序号」\n"
                f"💡 可先发「{self.job_info_trigger_names[0]}」查看序号"
            )

        idx = -1
        if arg.isdigit():
            n = int(arg) - 1
            if 0 <= n < len(self.job_list):
                idx = n
        if idx == -1:
            for i, j in enumerate(self.job_list):
                if j["name"] == arg:
                    idx = i
                    break
        if idx == -1:
            return f"⚠️ 未找到工种「{arg}」"

        removed = self.job_list.pop(idx)
        return (
            f"✅ 已删除工种：{removed['name']}\n"
            f"💡 请在 WebUI 点击「保存全部」以持久化"
        )
