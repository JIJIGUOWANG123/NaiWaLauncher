"""
赛车功能（1.6）

玩法：
  · `赛车商店`        —— 看商店里能买的车（积分购买）
  · `我的赛车`        —— 看自己拥有的车 + 当前装备
  · `装备赛车 <名字>`  —— 装备一辆车（决定参赛用哪辆）
  · `赛车查看 <名字>`  —— 看某辆车的属性 + 插图
  · `参与比赛`        —— 报名（满 5 人开赛；**1 小时没满自动补 NPC 开赛**）
  · `快速比赛`        —— PVE，对手全是 NPC，立刻开赛

核心规则（用户要求）：
  · 可以买**多辆**车，每辆基础属性不同
  · 属性决定参赛**赢得比赛的概率**
  · 默认 **5 人**开赛
  · 每人每天默认 **10 场**
  · 每天奖金**随机范围**，**前三名瓜分**（4/5 名没有）
  · **报名费不退**，奖池机制同抽奖（报名费总和 + 系统随机加成）
  · 抽奖可以抽到商店买不到的**超稀有赛车**
    —— 奖池由后台自定义（默认 3 个赛车奖品，其余是积分）

属性设计（1~100）：
  · 速度 speed         —— 最高速，影响直道
  · 加速 accel         —— 起步/出弯，影响前段
  · 操控 handling      —— 过弯，影响中段
  · 稳定 stability     —— 抗随机波动
  · 幸运 luck          —— 保底 / 爆发

排名算法（**时间模拟**，不是纯随机）：
  每辆车跑出一个用时，用时最小者胜：
      t = 基准
        - 速度/加速/操控 的加权贡献
        + 随机波动 × (1 - 稳定/150)      # 越稳波动越小
        - 幸运 × 小系数                   # 幸运是稳定的小加成
  这样「属性好的车更容易赢」是**可解释**的，
  同时保留冷门 —— 稳定低的车运气好能夺冠。

数据独立存放：`..._racing.json`
    {
      "version": 1,
      "groups": {
        "<群号>": {
          "users": {
            "<QQ>": {
              "name": "昵称",
              "cars": ["疾风 GT", "夜枭 RS"],
              "equipped": "疾风 GT",
              "races": 0, "wins": 0, "top3": 0, "date": "2026-10-12",
              "today": 3,
              "last_ts": 0
            }
          },
          "queue": {
            "cars": [{"uid": "...", "name": "...", "car": "...",
                      "ts": 0, "npc": false, "counted": true}, ...],
            "started_ts": 0
          }
        }
      }
    }

设计说明：
  · 赛车的**真值积分**始终在签到模块里（`checkin`），这里只统计战绩
  · 所有文件操作都吞异常，绝不因为赛车把主流程搞崩
"""
import json
import os
import random
import time
from datetime import datetime

# ★★ 市场版 1.1.0：日志记录器**必须且只能**从 astrbot.api 导入。
#   原来这里有一段内置日志库的兜底分支，已按上架规范删除。
from astrbot.api import logger

# ------------------------------------------------------------------
# 属性键（顺序固定，用于展示）
# ------------------------------------------------------------------
ATTR_KEYS = ("speed", "accel", "handling", "stability", "luck")
ATTR_LABEL = {
    "speed": "速度",
    "accel": "加速",
    "handling": "操控",
    "stability": "稳定",
    "luck": "幸运",
}
ATTR_ICON = {
    "speed": "🏎️", "accel": "⚡", "handling": "🌀",
    "stability": "🛡️", "luck": "🍀",
}
# 排名权重（总和 1.0）
ATTR_WEIGHT = {
    "speed": 0.38, "accel": 0.24, "handling": 0.22,
    "stability": 0.08, "luck": 0.08,
}

# ------------------------------------------------------------------
# 商店默认车（后台可增删改；`shop` 字段由 main.py 从配置读）
# 属性是 1~100，价格越高总体越强，但**各有侧重**
# ------------------------------------------------------------------
DEFAULT_CARS = [
    {"name": "买菜小车", "price": 2000,
     "desc": "刚拿到驾照的第一辆车，胜在便宜",
     "speed": 22, "accel": 30, "handling": 38, "stability": 45, "luck": 40},
    {"name": "街头改装", "price": 8000,
     "desc": "小排量涡轮，起步有点猛",
     "speed": 38, "accel": 48, "handling": 42, "stability": 40, "luck": 35},
    {"name": "弯道之王", "price": 20000,
     "desc": "底盘扎实，弯道几乎不用减速",
     "speed": 45, "accel": 44, "handling": 72, "stability": 58, "luck": 38},
    {"name": "疾风 GT", "price": 45000,
     "desc": "均衡型跑车，四项都在及格线以上",
     "speed": 65, "accel": 62, "handling": 64, "stability": 62, "luck": 48},
    {"name": "夜枭 RS", "price": 90000,
     "desc": "夜间赛道特化，中段加速凶",
     "speed": 72, "accel": 80, "handling": 66, "stability": 60, "luck": 44},
    {"name": "雷霆 F1", "price": 180000,
     "desc": "方程式底盘，直道快得离谱",
     "speed": 92, "accel": 86, "handling": 78, "stability": 66, "luck": 50},
    {"name": "幻影 X", "price": 400000,
     "desc": "顶级超跑，几乎没有短板",
     "speed": 95, "accel": 93, "handling": 92, "stability": 82, "luck": 62},
]

# ------------------------------------------------------------------
# 抽奖能抽到的**超稀有车**（商店买不到，用户要求）
# 后台 `race_lottery_cars` 可自定义；默认这三辆
# ------------------------------------------------------------------
DEFAULT_LOTTERY_CARS = [
    {"name": "星轨 S", "price": 0,
     "desc": "★超稀有★ 抽奖限定，操控与稳定兼备",
     "speed": 88, "accel": 90, "handling": 96, "stability": 90, "luck": 70},
    {"name": "深渊之影", "price": 0,
     "desc": "★超稀有★ 抽奖限定，爆发力恐怖",
     "speed": 96, "accel": 98, "handling": 84, "stability": 78, "luck": 66},
    {"name": "黄金圣骑", "price": 0,
     "desc": "★超稀有★ 抽奖限定，幸运值天花板",
     "speed": 90, "accel": 88, "handling": 88, "stability": 96, "luck": 99},
]

# NPC 车手用的车（不外售，只用来补位）
NPC_CARS = [
    {"name": "路人甲的车", "price": 0, "desc": "NPC",
     "speed": 40, "accel": 42, "handling": 40, "stability": 45, "luck": 40},
    {"name": "路人乙的车", "price": 0, "desc": "NPC",
     "speed": 52, "accel": 48, "handling": 50, "stability": 50, "luck": 45},
    {"name": "路人丙的车", "price": 0, "desc": "NPC",
     "speed": 60, "accel": 58, "handling": 62, "stability": 55, "luck": 48},
    {"name": "路人丁的车", "price": 0, "desc": "NPC",
     "speed": 70, "accel": 68, "handling": 66, "stability": 60, "luck": 52},
]
NPC_NAMES = ["秋名山车神", "隔壁老王", "摸鱼司机", "头文字D粉", "漂移新手",
             "夜跑狂魔", "加油站小哥", "键盘车神", "送豆腐的", "退休老司机"]

# 前三名奖金分配比例（4/5 名没有）—— 用户要求「前三名瓜分最多」
PRIZE_RATIO = (0.50, 0.30, 0.20)

# ★★ 1.6：赛车插图目录（用户指定）
#   按**车名**找同名图片：`疾风 GT.png` / `疾风 GT.jpg` / ...
#   找不到就不发图（只发文字），绝不报错。
DEFAULT_RACE_IMG_DIR = r"D:\MemeAPI\bar"

# ★★ 1.6：赛车列表的数据集合名（和坐骑 / 签到商店一样走**数据管理**）
#   结构：[{name, price, kind, desc, speed, accel, handling,
#           stability, luck}, ...]
#   kind: "shop"  = 商店在售（可积分购买）
#         "lucky" = 抽奖限定（商店买不到）
RACE_CAR_COLLECTION = "race_car_list"
KIND_SHOP = "shop"
KIND_LUCKY = "lucky"

# ★★ 1.6：**NPC 用车**的数据集合名（也用「数据管理」列表 UI 维护）
#   结构和 race_car_list 一样：{name, desc, speed, accel, handling,
#   stability, luck}
#   ★ 数据文件里空 -> 用内置 NPC_CARS 兜底
RACE_NPC_COLLECTION = "race_npc_cars"


def kind_of_car(kind) -> str:
    """把后台填的类型归一成 shop / lucky（留空 = shop）"""
    s = str(kind or "").strip().lower()
    if s in ("lucky", "lottery", "抽奖", "抽奖限定", "稀有", "超稀有",
             "限定"):
        return KIND_LUCKY
    return KIND_SHOP


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _clamp_num(v, lo=1, hi=100, dflt=50) -> int:
    try:
        n = int(round(float(v)))
    except Exception:
        return dflt
    return max(lo, min(hi, n))


def normalize_car(raw) -> dict:
    """
    把后台填的一行车洗干净 —— 支持：
      · dict（**数据管理 UI 用这个**，规范形态）
      · "名字 | 价格 | 描述 | 速度 | 加速 | 操控 | 稳定 | 幸运"（旧文本框）
      · "名字|8000|描述"（省略属性 -> 给 50 中位）
    """
    if isinstance(raw, dict):
        name = str(raw.get("name", "")).strip()
        if not name:
            return {}
        out = {"name": name}
        try:
            out["price"] = max(0, int(float(raw.get("price", 0) or 0)))
        except Exception:
            out["price"] = 0
        out["desc"] = str(raw.get("desc", "") or "").strip()
        out["kind"] = kind_of_car(raw.get("kind"))
        for k in ATTR_KEYS:
            out[k] = _clamp_num(raw.get(k, 50))
        return out
    s = str(raw or "").strip()
    if not s or s.startswith("#"):
        return {}
    parts = [x.strip() for x in s.split("|")]
    if not parts or not parts[0]:
        return {}
    out = {"name": parts[0], "price": 0, "desc": "", "kind": KIND_SHOP}
    if len(parts) >= 2:
        try:
            out["price"] = max(0, int(float(parts[1] or 0)))
        except Exception:
            out["price"] = 0
    if len(parts) >= 3:
        out["desc"] = parts[2]
    for i, k in enumerate(ATTR_KEYS):
        if len(parts) >= 4 + i and parts[3 + i]:
            out[k] = _clamp_num(parts[3 + i])
        else:
            out[k] = 50
    return out


def parse_car_list(raw) -> list:
    """
    解析后台的车列表配置（多行文本 / 列表 / 逗号分隔都行）。

    ★ 每行一辆车，支持 `|` 分隔字段；`#` 开头是注释。
    """
    if isinstance(raw, (list, tuple)):
        items = list(raw)
    else:
        txt = str(raw or "")
        # 换行优先；没有换行再按逗号切（但逗号可能是描述里的，所以优先换行）
        if "\n" in txt:
            items = txt.split("\n")
        elif "；" in txt or ";" in txt:
            items = txt.replace("；", ";").split(";")
        else:
            items = [txt]
    out = []
    seen = set()
    for it in items:
        car = normalize_car(it)
        if not car:
            continue
        if car["name"] in seen:
            continue
        seen.add(car["name"])
        out.append(car)
    return out


def car_power(car: dict) -> float:
    """车的综合实力（0~100），用于展示 / 粗略比较"""
    if not isinstance(car, dict):
        return 0.0
    return sum(float(car.get(k, 50) or 50) * w
               for k, w in ATTR_WEIGHT.items())


def simulate_race(entries: list, rng=None) -> list:
    """
    ★ 比赛核心：给每个参赛者算一个**用时**，用时短的排前面。

    entries: [{"uid":..., "name":..., "car": {...}, "npc": bool}, ...]
    返回：按名次排好的新列表，每项多出
          `time`（用时，越小越好）与 `rank`（1 起）。

    ★ 为什么用「时间模拟」而不是直接按概率抽：
      这样结果是**可解释的** —— 群里能看到每辆车跑了多少秒，
      好车赢得多但冷门也可能爆（稳定低的车波动大）。
    """
    r = rng or random
    out = []
    for e in entries:
        # ★ 兼容 `car_obj`（车属性 dict）与 `car`（车名 / dict）
        car = e.get("car_obj")
        if not isinstance(car, dict):
            car = e.get("car")
        if not isinstance(car, dict):
            car = {"name": str(car or ""), "speed": 50, "accel": 50,
                   "handling": 50, "stability": 50, "luck": 50}
        sp = float(car.get("speed", 50) or 50)
        ac = float(car.get("accel", 50) or 50)
        hd = float(car.get("handling", 50) or 50)
        st = float(car.get("stability", 50) or 50)
        lk = float(car.get("luck", 50) or 50)

        # ① 基础用时：三个主属性越高越快
        #   ★★ 1.6 调参：原来属性贡献 9 秒，而波动只有 ±2.2 秒，
        #     导致最强车对最弱车胜率 96% : 0.1% —— 弱车完全没机会，
        #     「冷门也能夺冠」就成空话了。
        #   现在 **属性总贡献 6 秒**、**波动 ±3.6 秒**，
        #   强弱车的差距仍在（好车稳定多赢），但弱车也常能爆冷。
        t = 30.0
        t -= sp * ATTR_WEIGHT["speed"] / 100.0 * 6.0
        t -= ac * ATTR_WEIGHT["accel"] / 100.0 * 6.0
        t -= hd * ATTR_WEIGHT["handling"] / 100.0 * 6.0
        # ② 稳定：降低波动幅度
        st_scale = max(0.45, 1.0 - (st - 50.0) / 110.0)
        # ③ 幸运：小的正向偏移
        t -= (lk / 100.0) * 0.6
        # ④ 随机波动（稳定越低越大）
        t += r.uniform(-3.6, 3.6) * st_scale
        # ⑤ 小概率的「神之一圈 / 爆胎」
        roll = r.random()
        if roll < 0.02:
            t -= r.uniform(1.0, 2.2)          # 神之一圈
        elif roll > 0.98:
            t += r.uniform(1.2, 2.8)          # 爆胎 / 打滑

        item = dict(e)
        item["time"] = max(5.0, round(t, 2))
        out.append(item)

    out.sort(key=lambda x: x["time"])
    for i, it in enumerate(out, 1):
        it["rank"] = i
    return out


class RacingModule:
    """赛车数据层 + 比赛逻辑"""

    def __init__(self, data_path: str):
        self.data_path = data_path
        self.groups = {}
        # ---- 配置（由 main.py 注入）----
        self.enable = True
        self.score_name = "积分"
        # 指令名
        self.trigger_names = ["参与比赛"]          # 报名
        self.fast_names = ["快速比赛"]             # PVE 立刻开
        self.my_names = ["我的赛车"]
        self.equip_names = ["装备赛车"]
        self.view_names = ["赛车查看"]
        self.shop_names = ["赛车商店"]
        self.buy_names = ["购买赛车"]        # ★★ 1.6 购买（看店是另一条）
        # ★★ 1.6：抽奖
        self.lucky_names = ["赛车抽奖"]      # 抽奖指令
        self.lucky_all_names = ["赛车一键抽奖", "赛车全部抽奖"]
        self.lucky_all_raw = "赛车一键抽奖,赛车全部抽奖"
        self.lucky_fee = 2000                # 每次抽奖费用
        self.lucky_daily_limit = 1           # 每人每天几次
        self.lottery_pool = []               # 奖品池（数据管理里配）
        # 规则
        self.players = 5                 # 几人开赛
        self.wait_sec = 3600             # 多久没满就补 NPC（默认 1 小时）
        self.daily_limit = 10            # 每人每天几场
        self.entry_fee = 500             # 报名费（不退）
        self.pool_bonus_min = 1000       # 奖池系统加成下限
        self.pool_bonus_max = 5000       # 奖池系统加成上限
        self.npc_fill = True             # 允许补 NPC
        self.fast_npc = 5                # 快速比赛的 NPC 数量
        # ★★ 1.6：NPC 强度（%）
        self.npc_power = 100             # 100=原样 / 80=弱 / 120=强
        # ★★ 1.6：NPC 用车（数据管理可自定义；空则用内置 NPC_CARS）
        self.npc_cars = [dict(c) for c in NPC_CARS]
        self.show_time = True            # 结果里显示用时
        # 车
        self.shop = [dict(c) for c in DEFAULT_CARS]
        self.lottery_cars = [dict(c) for c in DEFAULT_LOTTERY_CARS]
        self.img_dir = DEFAULT_RACE_IMG_DIR
        self._load()

    # ------------------------------------------------------------
    # 持久化
    # ------------------------------------------------------------
    def _load(self):
        try:
            if not os.path.isfile(self.data_path):
                return
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                d = json.load(f)
            g = d.get("groups")
            if isinstance(g, dict):
                self.groups = g
        except Exception:
            logger.exception("[racing] 读取赛车数据失败")

    def _save(self):
        try:
            d = os.path.dirname(self.data_path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "groups": self.groups},
                          f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[racing] 保存赛车数据失败")

    # ------------------------------------------------------------
    # ★★ 1.6：从**数据管理**的文件里读车列表
    #   （和坐骑 / 签到商店同一套：后台「数据管理」页可视化增删改）
    # ------------------------------------------------------------
    def load_cars_from_store(self) -> bool:
        """
        从 `data_store` 的 `race_car_list` 读车。

        · `kind = shop`  -> 商店在售（可积分购买）
        · `kind = lucky` -> 抽奖限定（商店买不到）
        · 数据文件里**空**就返回 False（调用方保留内置默认车）

        ★ 后台配置里的 `race_shop_list` / `race_lottery_cars` 文本
          只是**迁移来源**，不是真值 —— 真值在这里。
        """
        try:
            ds = getattr(self, "data_store", None)
            rows = ds.get(RACE_CAR_COLLECTION) if ds is not None else None
        except Exception:
            logger.exception("[racing] 从数据文件读赛车失败")
            rows = None
        if not isinstance(rows, list) or not rows:
            return False
        shop, lucky = [], []
        seen = set()
        for it in rows:
            car = normalize_car(it)
            if not car:
                continue
            if car["name"] in seen:
                continue
            seen.add(car["name"])
            (lucky if car.get("kind") == KIND_LUCKY else shop).append(car)
        if not shop and not lucky:
            return False
        # 全被标成抽奖限定也要把商店填上，否则没法买车
        self.shop = shop
        self.lottery_cars = lucky
        logger.info(f"[racing] 从数据文件读到赛车：商店 {len(shop)} 辆 / "
                    f"抽奖限定 {len(lucky)} 辆")
        return True

    def default_cars_as_rows(self) -> list:
        """把内置默认车转成数据文件的行（首次迁移用）"""
        out = []
        for c in DEFAULT_CARS:
            r = dict(c)
            r["kind"] = KIND_SHOP
            out.append(r)
        for c in DEFAULT_LOTTERY_CARS:
            r = dict(c)
            r["kind"] = KIND_LUCKY
            r["price"] = 0
            out.append(r)
        return out

    # ------------------------------------------------------------
    # 基础读取
    # ------------------------------------------------------------
    @staticmethod
    def _gid(group_id) -> str:
        s = str(group_id or "0").strip()
        return s or "0"

    def _day_start(self) -> int:
        """
        「今天」的起点时间戳（和签到模块同一套逻辑日）。

        ★ 尽量用签到模块的 `_day_start()` —— 这样「跨天」的判定
          和签到 / 抽奖完全一致，不会出现「签到已经跨天、赛车还没跨」
          这种两套日界线打架的情况。
        ★ 拿不到就退回本机 0 点。
        """
        # ① 优先借用 checkin 的逻辑日（插件实例注入过）
        try:
            ck = getattr(getattr(self, "_plugin", None),
                         "checkin_module", None)
            if ck is not None and hasattr(ck, "_day_start"):
                return int(ck._day_start())
        except Exception:
            pass
        # ② 兜底：checkin 模块被注入到 self 上（测试时常见）
        try:
            ck = getattr(self, "checkin_module", None)
            if ck is not None and hasattr(ck, "_day_start"):
                return int(ck._day_start())
        except Exception:
            pass
        # ③ 最终兜底：本机 0 点
        try:
            now = datetime.now()
            return int(time.mktime(
                datetime(now.year, now.month, now.day).timetuple()))
        except Exception:
            return 0

    def _gbucket(self, group_id) -> dict:
        gid = self._gid(group_id)
        b = self.groups.get(gid)
        if not isinstance(b, dict):
            b = {"users": {}, "queue": {"cars": [], "started_ts": 0}}
            self.groups[gid] = b
        b.setdefault("users", {})
        # ★★ 1.6：每日奖池加成（当天固定，跨天重随机）
        if not isinstance(b.get("daily"), dict):
            b["daily"] = {}
        q = b.get("queue")
        if not isinstance(q, dict):
            q = {"cars": [], "started_ts": 0}
            b["queue"] = q
        q.setdefault("cars", [])
        q.setdefault("started_ts", 0)
        return b

    def get_user(self, group_id, uid) -> dict:
        b = self._gbucket(group_id)
        u = b["users"].get(str(uid))
        if not isinstance(u, dict):
            u = {"cars": [], "equipped": "", "races": 0, "wins": 0,
                 "top3": 0, "date": "", "today": 0, "last_ts": 0,
                 # ★★ 1.6：今日抽奖次数
                 "lucky_today": 0}
            b["users"][str(uid)] = u
        u.setdefault("cars", [])
        if not isinstance(u.get("cars"), list):
            u["cars"] = []
        u.setdefault("equipped", "")
        for k in ("races", "wins", "top3", "today", "last_ts",
                  "lucky_today"):
            try:
                u[k] = int(u.get(k, 0) or 0)
            except Exception:
                u[k] = 0
        u.setdefault("date", "")
        u.setdefault("name", "")
        return u

    def touch_today(self, group_id, uid) -> dict:
        """跨天就把今日场次 + 今日抽奖次数都清零"""
        u = self.get_user(group_id, uid)
        today = _today_str()
        if u.get("date") != today:
            u["date"] = today
            u["today"] = 0
            # ★★ 1.6：抽奖次数也是**按天**重置
            u["lucky_today"] = 0
        return u

    def left_today(self, group_id, uid) -> int:
        if self.daily_limit <= 0:
            return 9999
        u = self.touch_today(group_id, uid)
        return max(0, self.daily_limit - int(u.get("today", 0) or 0))

    # ------------------------------------------------------------
    # ★★ 1.6：赛车抽奖
    #   · 后台可自定义指令名 / 每次费用 / 每天次数
    #   · **抽到过的限定车不会再抽中同一台**（抽完就排除）
    #   · 奖池（奖品+权重）来自数据管理 `race_lottery_pool`
    # ------------------------------------------------------------
    def lucky_left_today(self, group_id, uid) -> int:
        """今天还能抽几次（<=0 表示不限）"""
        if int(getattr(self, "lucky_daily_limit", 0) or 0) <= 0:
            return 9999
        u = self.touch_today(group_id, uid)
        return max(0, int(self.lucky_daily_limit)
                   - int(u.get("lucky_today", 0) or 0))

    def lucky_left_cars(self, group_id, uid) -> list:
        """
        抽奖池里**还没抽到过**的限定车名。

        ★ 这些车一旦抽中就不再出现在池子里 ——
          所以抽到过的限定车**不会重复抽中同一台**。
        """
        try:
            _all = [str(c.get("name") or "").strip()
                    for c in (self.lottery_cars or [])]
        except Exception:
            _all = []
        _all = [x for x in _all if x]
        if not _all:
            return []
        _own = {str(x).strip()
                for x in (self.get_user(group_id, uid).get("cars") or [])}
        return [x for x in _all if x not in _own]

    def lucky_prizes(self, group_id, uid) -> list:
        """
        本次可用的抽奖奖品列表。

        · 车类奖品：只保留**还没抽到过**的限定车；
          如果限定车都抽完了，这些车条目会被剔除（不占权重）。
        · 积分奖品：始终保留。
        """
        _pool = []
        try:
            _pool = list(getattr(self, "lottery_pool", []) or [])
        except Exception:
            _pool = []
        if not _pool:
            # 没配奖池 -> 用限定车兜底（等价于纯抽车）
            _left = self.lucky_left_cars(group_id, uid)
            return [{"kind": "car", "name": n, "weight": 1} for n in _left]
        _leftset = set(self.lucky_left_cars(group_id, uid))
        out = []
        for it in _pool:
            if not isinstance(it, dict):
                continue
            _k = str(it.get("kind") or "score").strip().lower()
            if _k in ("car", "lucky", "赛车", "抽奖限定"):
                _nm = str(it.get("name") or "").strip()
                if _nm and _nm not in _leftset:
                    continue          # 已抽到过 -> 从这个池子剔掉
            out.append(it)
        return out

    def lucky_draw(self, group_id, uid):
        """
        抽一次（**不扣钱**，扣钱由调用方做）。

        返回 (kind, prize_dict) 或 (None, 原因字符串)。
          kind = "car"   -> prize = 车 dict
          kind = "score" -> prize = {"amount": n}
        """
        import random as _random
        left = self.lucky_left_cars(group_id, uid)
        prizes = self.lucky_prizes(group_id, uid)
        if not prizes:
            if not left:
                return None, "抽奖限定车你已经**全收集**了，没有可抽的奖品"
            return None, "奖池是空的（后台可添加奖品）"
        _weights = []
        for it in prizes:
            try:
                w = int(it.get("weight", 1) or 1)
            except Exception:
                w = 1
            _weights.append(max(0, w))
        if sum(_weights) <= 0:
            _weights = [1] * len(prizes)
        it = _random.choices(prizes, weights=_weights, k=1)[0]
        _k = str(it.get("kind") or "score").strip().lower()
        if _k in ("car", "lucky", "赛车", "抽奖限定"):
            nm = str(it.get("name") or "").strip()
            car = self.find_car(nm)
            if car is None:
                # 奖池里的车名不在车列表里 -> 用兜底属性也能发
                car = {"name": nm, "price": 0, "desc": "★超稀有★ 抽奖限定",
                       "speed": 70, "accel": 70, "handling": 70,
                       "stability": 70, "luck": 70}
            return "car", car
        try:
            amt = int(it.get("amount") or it.get("name") or 0)
        except Exception:
            amt = 0
        return "score", {"amount": max(0, amt)}

    # ------------------------------------------------------------
    # 车
    # ------------------------------------------------------------
    def all_known_cars(self) -> list:
        """商店 + 抽奖限定（用于「赛车查看」认名字）"""
        out = []
        seen = set()
        for c in list(self.shop) + list(self.lottery_cars):
            if not isinstance(c, dict):
                continue
            nm = str(c.get("name", "")).strip()
            if not nm or nm in seen:
                continue
            seen.add(nm)
            out.append(c)
        return out

    def find_car(self, name: str):
        """按名字找车（精确 -> 去空格 -> 包含）"""
        t = str(name or "").strip()
        if not t:
            return None
        cars = self.all_known_cars()
        for c in cars:
            if str(c.get("name", "")).strip() == t:
                return c
        t2 = t.replace(" ", "")
        for c in cars:
            if str(c.get("name", "")).strip().replace(" ", "") == t2:
                return c
        for c in cars:
            if t in str(c.get("name", "")):
                return c
        return None

    # ------------------------------------------------------------
    # ★★ 1.6：按「名字 或 序号」定位（用户要求：可以输入车名和序号）
    # ------------------------------------------------------------
    @staticmethod
    def _is_index(s: str) -> bool:
        """是不是纯序号（支持 1 起；`#3` / `No.3` 也认）"""
        t = str(s or "").strip().lstrip("#").strip()
        for pre in ("No.", "no.", "NO.", "No", "no"):
            if t.startswith(pre):
                t = t[len(pre):].strip()
                break
        return t.isdigit()

    def pick_car(self, listing: list, raw):
        """
        在给定列表里按**名字或序号**取一辆车。

        listing: 车列表（顺序 = 菜单/列表里显示的编号顺序）
        raw:     用户输入（车名 或 序号）

        返回 (car, err)：err 非空表示失败原因。
        """
        t = str(raw or "").strip()
        if not t:
            return None, "请写车名或序号"
        items = [c for c in (listing or []) if isinstance(c, dict)]
        if not items:
            return None, "列表是空的"
        # ① 纯序号（1 起）
        if self._is_index(t):
            try:
                idx = int(str(t).strip().lstrip("#").strip()
                          .replace("No.", "").replace("no.", "").strip())
            except Exception:
                idx = 0
            if 1 <= idx <= len(items):
                return items[idx - 1], ""
            return None, f"序号超出范围（1~{len(items)}）"
        # ② 车名
        want = t.replace(" ", "")
        for c in items:
            if str(c.get("name", "")).strip() == t:
                return c, ""
        for c in items:
            if str(c.get("name", "")).strip().replace(" ", "") == want:
                return c, ""
        for c in items:
            if t in str(c.get("name", "")):
                return c, ""
        return None, f"没有找到「{t}」"

    def shop_index_of(self, car_name: str) -> int:
        """这辆车在商店列表里的序号（1 起）；不在商店返回 0"""
        for i, c in enumerate(list(getattr(self, "shop", []) or []), 1):
            if str(c.get("name", "")) == str(car_name or ""):
                return i
        return 0

    def owned_index_of(self, group_id, uid, car_name: str) -> int:
        """这辆车在该用户车库里的序号（1 起）；没有返回 0"""
        for i, c in enumerate(self.owned_cars(group_id, uid), 1):
            if str(c.get("name", "")) == str(car_name or ""):
                return i
        return 0

    def owned_cars(self, group_id, uid) -> list:
        """该用户拥有的车（车没在商店里也保留，避免抽奖车丢失）"""
        u = self.get_user(group_id, uid)
        out = []
        for nm in list(u.get("cars") or []):
            nm = str(nm or "").strip()
            if not nm:
                continue
            c = self.find_car(nm)
            if c is None:
                c = {"name": nm, "price": 0, "desc": "（已下架）",
                     "speed": 50, "accel": 50, "handling": 50,
                     "stability": 50, "luck": 50}
            out.append(c)
        return out

    def add_car(self, group_id, uid, name: str) -> bool:
        """发一辆车给某人（已有则不加）。返回是否新增。"""
        u = self.get_user(group_id, uid)
        nm = str(name or "").strip()
        if not nm:
            return False
        if nm in [str(x).strip() for x in (u.get("cars") or [])]:
            return False
        u.setdefault("cars", []).append(nm)
        if not u.get("equipped"):
            u["equipped"] = nm
        self._save()
        return True

    def equipped_car(self, group_id, uid):
        """当前装备的车（没装备就返回拥有的第一辆）"""
        u = self.get_user(group_id, uid)
        nm = str(u.get("equipped") or "").strip()
        cars = self.owned_cars(group_id, uid)
        if not cars:
            return None
        for c in cars:
            if str(c.get("name", "")) == nm:
                return c
        return cars[0]

    def equip(self, group_id, uid, name: str):
        """
        装备一辆车。

        ★★ 1.6：**支持序号** —— 写「装备赛车 2」就装车库里的第 2 辆。
        返回 (ok, 车dict 或 失败原因)
        """
        u = self.get_user(group_id, uid)
        cars = self.owned_cars(group_id, uid)
        if not cars:
            return False, "你还没有赛车"
        car, err = self.pick_car(cars, name)
        if car is None:
            return False, err or "你没有这辆车"
        u["equipped"] = str(car.get("name"))
        self._save()
        return True, car

    # ------------------------------------------------------------
    # 报名队列
    # ------------------------------------------------------------
    def queue_of(self, group_id) -> dict:
        return self._gbucket(group_id)["queue"]

    def in_queue(self, group_id, uid) -> bool:
        q = self.queue_of(group_id)
        return any(str(c.get("uid")) == str(uid)
                   for c in (q.get("cars") or []))

    def queue_size(self, group_id) -> int:
        return len(self.queue_of(group_id).get("cars") or [])

    def join(self, group_id, uid, name: str, car_name: str) -> str:
        """
        报名。返回提示文案（"" = 成功加入，还会继续等）。
        ★ 队列若已过期（超过 wait_sec）会**先清空**再让他进新的。
        """
        if not self.enable:
            return "⚠️ 赛车功能未开启"
        q = self.queue_of(group_id)
        if self._queue_expired(group_id):
            self._clear_queue(group_id)
            q = self.queue_of(group_id)
        if self.in_queue(group_id, uid):
            return (f"⚠️ 你已经在等待名单里了"
                    f"（{self.queue_size(group_id)}/{self.players} 人）")
        if self.left_today(group_id, uid) <= 0:
            return (f"⚠️ 你今天已经跑满 {self.daily_limit} 场了，明天再来")
        q["cars"].append({
            "uid": str(uid), "name": str(name or f"QQ{uid}"),
            "car": str(car_name or ""), "ts": int(time.time()),
            "npc": False, "counted": False,
        })
        if not q.get("started_ts"):
            q["started_ts"] = int(time.time())
        self._save()
        return ""

    def _queue_expired(self, group_id) -> bool:
        """
        队列是否「等太久了」。

        ★ 从**第一个人报名**开始算（started_ts），
          超过 wait_sec 就该补 NPC 开赛（用户要求：1 小时没满就塞 NPC）。
        """
        if self.wait_sec <= 0:
            return False
        q = self.queue_of(group_id)
        if not (q.get("cars") or []):
            return False
        st = int(q.get("started_ts", 0) or 0)
        if st <= 0:
            return True
        return (time.time() - st) >= self.wait_sec

    def _clear_queue(self, group_id):
        b = self._gbucket(group_id)
        b["queue"] = {"cars": [], "started_ts": 0}
        self._save()

    def make_npcs(self, n: int, exclude_names=()) -> list:
        """
        造 n 个 NPC 车手。

        ★★ 1.6：NPC 的车来自 `self.npc_cars`（后台「数据管理 →
          赛车功能 → NPC 用车」可自定义）；数据文件为空时用内置
          `NPC_CARS` 兜底。
        ★ `self.npc_power`（%）会**整体缩放** NPC 属性：
            100 = 原样；80 = 弱一点；120 = 强一点。
          这样不想逐个改属性时，调一个数就能整体加减强度。
        """
        out = []
        used = set(str(x) for x in (exclude_names or ()))
        pool = [x for x in NPC_NAMES if x not in used] or list(NPC_NAMES)
        random.shuffle(pool)
        _cars = [c for c in (getattr(self, "npc_cars", None) or [])
                 if isinstance(c, dict) and str(c.get("name") or "").strip()]
        if not _cars:
            _cars = [dict(c) for c in NPC_CARS]
        _pct = self._npc_pct()
        for i in range(max(0, int(n))):
            nm = pool[i % len(pool)]
            car = dict(random.choice(_cars))
            if _pct != 100:
                for _k in ATTR_KEYS:
                    try:
                        _v = float(car.get(_k, 50) or 50) * _pct / 100.0
                    except Exception:
                        _v = 50.0
                    car[_k] = int(max(1, min(200, round(_v))))
            car.setdefault("price", 0)
            car.setdefault("desc", "NPC")
            out.append({
                "uid": f"npc_{i}_{int(time.time())}", "name": nm,
                "car": car["name"], "car_obj": car,
                "ts": int(time.time()), "npc": True, "counted": False,
            })
        return out

    def _npc_pct(self) -> float:
        """NPC 强度百分比（读后台 `race_npc_power`，默认 100）"""
        try:
            v = float(getattr(self, "npc_power", 100) or 100)
        except Exception:
            v = 100.0
        return max(10.0, min(300.0, v))

    def load_npcs_from_store(self) -> bool:
        """
        ★★ 1.6：从 `data_store` 的 `race_npc_cars` 读 NPC 用车。

        返回 True 表示读到了（覆盖内置）；False 表示数据文件为空。
        """
        try:
            ds = getattr(self, "data_store", None)
            rows = (ds.get(RACE_NPC_COLLECTION)
                    if ds is not None else None)
        except Exception:
            logger.exception("[racing] 读 NPC 用车失败")
            return False
        if not isinstance(rows, list) or not rows:
            return False
        out = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            c = normalize_car(r)
            if c and str(c.get("name") or "").strip():
                out.append(c)
        if not out:
            return False
        self.npc_cars = out
        return True

    def default_npcs_as_rows(self) -> list:
        """内置 NPC 车转成数据文件的行（首次迁移用）"""
        return [dict(c) for c in NPC_CARS]

    def build_lineup(self, group_id, force_npc: int = 0,
                     only_npc: bool = False) -> tuple:
        """
        组一局的参赛名单。

        返回 (lineup, npc_count)：
          · only_npc=True  -> 只有 NPC（快速比赛：真人 + fast_npc 个 NPC）
          · 否则用队列里的人，不够就补 NPC 到 self.players

        ★★ 1.6 修 bug：队列里存的是**车名**（字符串），
          而比赛模拟需要的是**车属性 dict** —— 这里统一解析成
          `car_obj` 并补上 `name`，否则 simulate_race 会崩。
        """
        q = self.queue_of(group_id)
        real = []
        for c in list(q.get("cars") or []):
            if c.get("npc"):
                continue
            e = dict(c)
            nm = str(e.get("car") or "").strip()
            e["car_name"] = nm
            # 没车 -> 给一辆「没车」的垫底车（正常流程进不来）
            e["car_obj"] = self.find_car(nm) or {
                "name": nm or "无车", "price": 0, "desc": "",
                "speed": 20, "accel": 20, "handling": 20,
                "stability": 20, "luck": 20,
            }
            real.append(e)

        need = max(0, int(self.players) - len(real))
        if only_npc:
            need = max(need, int(force_npc or self.fast_npc))
        if not bool(getattr(self, "npc_fill", True)):
            need = 0                  # 关了「允许补 NPC」就不补
        npcs = self.make_npcs(need, exclude_names=[c.get("name")
                                                   for c in real])
        lineup = real + npcs
        return lineup, len(npcs)

    # ------------------------------------------------------------
    # 奖金
    # ------------------------------------------------------------
    def _daily_range(self) -> tuple:
        """
        ★★ 1.6：当日随机加成的**上下限**。

        ★ **赛车有自己独立的奖池**（用户明确要求）：
          上下限就是 `race_pool_bonus_min` / `race_pool_bonus_max`，
          和签到系统的「抽奖奖池」**机制相同但数值独立**，
          改抽奖的上下限**不会**影响赛车。

        返回 (lo, hi)，保证 hi >= lo。
        """
        lo = max(0, int(getattr(self, "pool_bonus_min", 0) or 0))
        hi = max(lo, int(getattr(self, "pool_bonus_max", lo) or lo))
        return lo, hi

    def daily_bonus(self, group_id, save: bool = True) -> tuple:
        """
        ★★ 1.6：**当天的系统加成**（当天固定，跨天重新随机）。

        返回 (bonus, day_key)。

        ★ 和银行那边「抽奖奖池」的做法一致（`_pool_today` 的 pot）：
          金额挂在**天**上，所以同一天里跑多少场都用同一个数，
          只有跨天才重随机 —— 不会出现「同一场里问两次金额不一样」。
        ★ 上下限是**赛车自己的**（`race_pool_bonus_min/max`）——
          机制和抽奖一样，但奖池独立，互不影响。
        """
        import random as _random
        b = self._gbucket(group_id)
        day_key = str(self._day_start())
        daily = b.setdefault("daily", {})
        rec = daily.get(day_key)
        lo, hi = self._daily_range()
        # ★★ 1.6 修 bug：缓存里要带上**生成时的区间** `rng`。
        #   后台把上下限从 1000~5000 改成 20万~600万时，如果只看
        #   「今天有没有缓存」，就会继续用旧区间生成的那个数
        #   （用户反馈：奖池金额和后台设置对不上）。
        #   现在区间一变就**立刻重随机**。
        _rng_tag = f"{lo}-{hi}"
        if isinstance(rec, dict):
            try:
                _cached = max(0, int(rec.get("bonus", 0) or 0))
                # 老数据没有 rng 字段 -> 只要不在当前区间内就重算
                if rec.get("rng") == _rng_tag:
                    return _cached, day_key
                if not rec.get("rng") and lo <= _cached <= hi:
                    # 兼容老数据：值还在新区间里就沿用，顺手补上 rng
                    rec["rng"] = _rng_tag
                    if save:
                        self._save()
                    return _cached, day_key
            except Exception:
                pass
        bonus = _random.randint(lo, hi) if hi > 0 else 0
        daily[day_key] = {"bonus": int(bonus), "ts": int(time.time()),
                          "rng": _rng_tag}
        # 只留最近 7 天，别让文件无限长
        if len(daily) > 7:
            for _k in sorted(daily.keys())[:-7]:
                daily.pop(_k, None)
        if save:
            self._save()
        logger.info(f"[racing] {group_id} 今日奖池加成 = {bonus}"
                    f"（{lo}~{hi}）")
        return int(bonus), day_key

    def roll_pool(self, group_id, n_paid: int, save: bool = True) -> tuple:
        """
        算奖池：**报名费总和 + 当天的系统加成**。

        ★★ 1.6：加成改为**每天随机固定**（跟抽奖奖池一样），
          不再是「每场都重新随机」。

        返回 (pool, bonus)
        """
        fee = max(0, int(self.entry_fee or 0)) * max(0, int(n_paid))
        bonus, _ = self.daily_bonus(group_id, save=save)
        return fee + bonus, bonus

    @staticmethod
    def split_prize(pool: int) -> list:
        """按 50/30/20 分给前三名（余数给第一名，保证不丢钱）"""
        pool = max(0, int(pool or 0))
        out = [int(pool * r) for r in PRIZE_RATIO]
        out[0] += pool - sum(out)
        return out

    # ------------------------------------------------------------
    # 结算
    # ------------------------------------------------------------
    def settle(self, group_id, lineup: list):
        """
        跑完一局并**记账**（场次 / 战绩），返回结算结果 dict：

            {
              "ranking": [ {...entry..., "time":..,"rank":..}, ... ],
              "pool": int, "bonus": int, "prizes": [前三名金额],
              "winners": [(uid,name,amount,rank,is_npc), ...],
              "npc": int,
            }

        ★ 只统计**真人**的场次与战绩（NPC 不占名额）。
        """
        ranking = simulate_race(lineup)
        real_n = sum(1 for c in ranking if not c.get("npc"))
        npc_n = len(ranking) - real_n
        # ★★ 1.6：奖池 = 报名费 + **当天固定**的系统加成
        pool, bonus = self.roll_pool(group_id, real_n)
        prizes = self.split_prize(pool)

        winners = []
        for item in ranking:
            rk = int(item.get("rank", 99))
            if rk > 3:
                continue
            amt = prizes[rk - 1] if rk - 1 < len(prizes) else 0
            winners.append({
                "uid": str(item.get("uid")), "name": str(item.get("name")),
                "amount": amt, "rank": rk, "npc": bool(item.get("npc")),
                "car": str(item.get("car") or ""),
            })

        # ---- 记战绩 ----
        for item in ranking:
            if item.get("npc"):
                continue
            uid = str(item.get("uid"))
            u = self.touch_today(group_id, uid)
            u["name"] = str(item.get("name") or u.get("name") or "")
            u["races"] = int(u.get("races", 0) or 0) + 1
            u["today"] = int(u.get("today", 0) or 0) + 1
            u["last_ts"] = int(time.time())
            rk = int(item.get("rank", 99))
            if rk == 1:
                u["wins"] = int(u.get("wins", 0) or 0) + 1
            if rk <= 3:
                u["top3"] = int(u.get("top3", 0) or 0) + 1
        self._clear_queue(group_id)

        return {"ranking": ranking, "pool": pool, "bonus": bonus,
                "prizes": prizes, "winners": winners,
                "real": real_n, "npc_n": npc_n}

    # ------------------------------------------------------------
    # 展示
    # ------------------------------------------------------------
    def car_stat_lines(self, car: dict) -> list:
        """一辆车的属性行（带进度条）"""
        if not isinstance(car, dict):
            return []
        out = []
        for k in ATTR_KEYS:
            v = _clamp_num(car.get(k, 50))
            bar_n = max(0, min(10, int(round(v / 10.0))))
            bar = "█" * bar_n + "░" * (10 - bar_n)
            out.append(f"{ATTR_ICON[k]} {ATTR_LABEL[k]}：{bar} {v}")
        return out

    def win_chance_of(self, car: dict, others: list) -> float:
        """
        粗算胜率（%）：用**大量模拟**估计，给「赛车查看」展示。

        ★ 这是估算不是真值 —— 真值在比赛时才定（有随机波动）。
        """
        if not isinstance(car, dict):
            return 0.0
        others = [c for c in (others or []) if isinstance(c, dict)]
        if not others:
            return 100.0
        trials = 240
        win = 0
        field = [{"uid": "me", "name": "me", "car": car}]
        for i, o in enumerate(others):
            field.append({"uid": f"o{i}", "name": f"o{i}", "car": o})
        for _ in range(trials):
            r = simulate_race([dict(x) for x in field])
            if r and r[0].get("uid") == "me":
                win += 1
        return round(win * 100.0 / trials, 1)
