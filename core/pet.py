"""
宠物功能模块（每群独立）

数据文件：data/plugin_data/<插件>/..._pet.json
{
  "groups": {
    "<群号>": {
      "pets": {
        "<用户号>": {
          "宠物名": {
            "lv": 1, "exp": 0, "hp": 100, "hp_max": 100,
            "mp": 50, "mp_max": 50, "atk": 10, "df": 8,
            "elem": "金", "cd_adventure": 0, "cd_rest": 0,
            "cd_work": 0, "cd_duel": 0
          }
        }
      },
      "items": {"<用户号>": {"体力恢复药剂": 2}}
    }
  }
}

五行克制（伤害加成）：
  金克木 / 木克土 / 土克水 / 水克火 / 火克金
"""
import datetime
import json
import os
import random
import threading
import time
from .path_utils import title_bar, title_foot
from .path_utils import fmt_num
from .path_utils import cmd_arg

from astrbot.api import logger
_LOCK = threading.RLock()

ELEMENTS = ["金", "木", "水", "火", "土"]
# 五行相克：key 克 value
COUNTER = {"金": "木", "木": "土", "土": "水", "水": "火", "火": "金"}
MAX_LEVEL = 100


def _parse_names(raw) -> list:
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        out = []
        for it in raw:
            out.extend(_parse_names(it))
        return out
    import re as _re
    return [x.strip() for x in _re.split(r"[,，]", str(raw)) if x.strip()]


def _now() -> float:
    return time.time()


def _fmt_cd(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h} 小时 {m} 分"
    if m:
        return f"{m} 分 {s} 秒"
    return f"{s} 秒"


# ============================================================
# 默认宠物图鉴（约 60 种，五行分配好）
# ============================================================
DEFAULT_CATALOG = [
    # ---- 金 ----
    ("小铁鼠", "爱啃铁的机灵小鼠", 100, "金"),
    ("铜铃猫", "脖子上挂着铜铃", 180, "金"),
    ("银翼鸽", "翅膀泛着银光", 260, "金"),
    ("钢牙兔", "牙齿能咬断铁钉", 340, "金"),
    ("金羽鸡", "羽毛像金子一样亮", 420, "金"),
    ("铁甲龟", "背壳坚硬如铁", 520, "金"),
    ("银角鹿", "角是纯银打造", 640, "金"),
    ("鎏金狐", "尾巴上鎏着金粉", 780, "金"),
    ("白金狮", "鬃毛雪白带金属光泽", 950, "金"),
    ("黄金龙", "传说中的金龙", 1500, "金"),
    ("钛合金狼", "改造过的机械狼", 1200, "金"),
    ("星尘隼", "羽毛里藏着星尘", 1800, "金"),
    # ---- 木 ----
    ("嫩芽兔", "耳朵像两片叶子", 100, "木"),
    ("藤蔓蛇", "会缠绕猎物的绿蛇", 180, "木"),
    ("蘑菇精", "顶着大蘑菇的小妖精", 260, "木"),
    ("树懒熊", "整天挂在树上", 340, "木"),
    ("青竹鹿", "跑起来像风过竹林", 420, "木"),
    ("花间蝶", "翅膀上开着花", 520, "木"),
    ("古藤猿", "手臂是粗壮的藤", 640, "木"),
    ("木灵猫", "由百年老树化形", 780, "木"),
    ("苍松虎", "斑纹像松树皮", 950, "木"),
    ("世界树苗", "会长成参天大树", 1500, "木"),
    ("食人花妖", "笑得很甜但要吃人", 1200, "木"),
    ("翠羽孔雀", "开屏时满室生春", 1800, "木"),
    # ---- 水 ----
    ("水泡鱼", "一戳就破的小鱼", 100, "水"),
    ("蟹老板", "横行霸道的小螃蟹", 180, "水"),
    ("海螺姑娘", "能把声音装进壳里", 260, "水"),
    ("水母灯", "夜里会发蓝光", 340, "水"),
    ("冰晶企鹅", "住在冰面上的企鹅", 420, "水"),
    ("珊瑚马", "鬃毛是活珊瑚", 520, "水"),
    ("深海章鱼", "八条腕足很有力", 640, "水"),
    ("雾隐水獭", "能把自己化成雾", 780, "水"),
    ("玄水龙龟", "背甲上刻着水纹", 950, "水"),
    ("沧海鲲", "一尾可化鹏", 1500, "水"),
    ("珍珠贝妖", "壳里养着夜明珠", 1200, "水"),
    ("极地冰狐", "呼气成冰", 1800, "水"),
    # ---- 火 ----
    ("火苗蜥", "尾巴上顶着火苗", 100, "火"),
    ("炭烤猪", "全身暖烘烘", 180, "火"),
    ("熔岩犬", "皮肤像流动的岩浆", 260, "火"),
    ("烈焰鸟", "飞过的地方会冒烟", 340, "火"),
    ("赤炎马", "四蹄踏火", 420, "火"),
    ("爆竹猴", "一激动就噼啪响", 520, "火"),
    ("岩浆龟", "壳里装着岩浆", 640, "火"),
    ("焚天隼", "俯冲时带起热浪", 780, "火"),
    ("太阳狮", "鬃毛像小太阳", 950, "火"),
    ("涅槃凤", "浴火重生的神鸟", 1500, "火"),
    ("炉心猫", "肚子里有个小火炉", 1200, "火"),
    ("焚云麒麟", "脚踏火云", 1800, "火"),
    # ---- 土 ----
    ("泥巴猪", "喜欢在泥里打滚", 100, "土"),
    ("石子鼠", "会扔小石子", 180, "土"),
    ("沙丘蜥", "能在沙里游泳", 260, "土"),
    ("岩石羊", "角是两块石头", 340, "土"),
    ("黄土狗", "挖洞一把好手", 420, "土"),
    ("仙人掌熊", "抱一下会扎手", 520, "土"),
    ("山岩犀", "皮厚得像山", 640, "土"),
    ("陶土猫", "会自己烧制成型", 780, "土"),
    ("大地熊", "一掌能拍裂石头", 950, "土"),
    ("不周山灵", "传说中山的化身", 1500, "土"),
    ("沙漠蝎王", "尾针带毒", 1200, "土"),
    ("厚土麒麟", "背上驮着一片土地", 1800, "土"),
]

# 默认事件（宠物上班）—— 元组格式：(事件, 经验下限, 经验上限, 积分下限, 积分上限)
DEFAULT_WORK_EVENTS = [
    ("在街角发传单", 5, 30, 310, 1200),
    ("帮邻居看店", 10, 50, 310, 1200),
    ("送外卖跑单", 15, 70, 320, 1250),
    ("当图书馆管理员", 20, 80, 330, 1300),
    ("参加宠物选美", 25, 100, 330, 1300),
    ("给小朋友当玩伴", 18, 90, 340, 1350),
    ("去码头搬货", 30, 120, 360, 1400),
    ("做直播当网红", 40, 160, 360, 1400),
    ("帮侦探找线索", 35, 140, 370, 1450),
    ("上山采药", 45, 180, 380, 1500),
    # ---- 服务业（稳定、低风险）----
    ("在奶茶店摇奶茶", 12, 55, 480, 1500),
    ("给火锅店端盘子", 16, 68, 500, 1550),
    ("在早餐铺包包子", 14, 60, 510, 1600),
    ("当一天快递分拣员", 22, 92, 530, 1650),
    ("给花店修剪枝叶", 13, 58, 540, 1700),
    ("在便利店值夜班", 26, 105, 560, 1750),
    ("帮人遛狗", 11, 48, 560, 1750),
    ("在洗车行擦车", 17, 72, 580, 1800),
    ("当婚礼现场布置工", 28, 115, 590, 1850),
    ("给宠物店照顾小动物", 20, 85, 610, 1900),
    ("在书店整理书架", 15, 66, 510, 2000),
    ("当街边擦鞋匠", 9, 42, 520, 2050),
    ("给面馆擀面条", 19, 80, 540, 2100),
    ("在电影院验票", 23, 95, 550, 2150),
    ("帮健身房看前台", 21, 88, 560, 2200),
    ("给蛋糕店裱花", 27, 110, 570, 2250),
    # ---- 技术活（中等）----
    ("修电脑装系统", 48, 185, 590, 2300),
    ("给网站写代码", 70, 260, 1440, 4500),
    ("当游戏主播带队上分", 60, 235, 600, 2350),
    ("给乐队调音", 42, 165, 610, 2400),
    ("帮人拍摄剪辑短视频", 55, 215, 640, 2500),
    ("修空调外机", 50, 195, 820, 2550),
    ("给手机换屏幕", 45, 175, 830, 2600),
    ("画一张插画接单", 52, 205, 860, 2700),
    ("翻译一份外文说明", 58, 225, 880, 2750),
    ("当摄影师跟拍一天", 62, 240, 910, 2850),
    ("做手办模型上色", 66, 250, 1470, 4600),
    ("给餐厅设计菜单", 40, 158, 930, 2900),
    ("写一篇公众号推文", 38, 150, 940, 2950),
    # ---- 体力活（累但赚）----
    ("给搬家公司扛冰箱", 55, 210, 980, 3050),
    ("在建筑工地扎钢筋", 75, 270, 1500, 4700),
    ("去果园摘一整天果子", 44, 170, 990, 3100),
    ("给农田插秧", 46, 180, 1020, 3200),
    ("在冷库搬冻品", 58, 220, 920, 3600),
    ("上山背石头下山", 64, 245, 1540, 4800),
    ("给货车装卸货物", 68, 255, 1570, 4900),
    ("帮渔民拉一网鱼", 56, 215, 930, 3650),
    ("在养殖场喂猪", 43, 168, 940, 3700),
    ("去伐木场搬木头", 61, 232, 970, 3800),
    # ---- 特殊 / 高回报（有脾气）----
    ("给大熊猫当一天铲屎官", 80, 290, 1600, 5000),
    ("当剧组群众演员", 36, 145, 980, 3850),
    ("给演唱会当安保", 54, 208, 1010, 3950),
    ("做一日动物园向导", 39, 152, 1020, 4000),
    ("帮考古队筛土", 72, 268, 1630, 5100),
    ("给五星酒店做试睡员", 76, 275, 1660, 5200),
    ("当气象站观测员", 33, 138, 1050, 4100),
    ("给马戏团当替补演员", 86, 300, 1570, 6150),
    # ============================================================
    # 1.7.6 扩充：又加了 60 个上班事件，并把整体收益提上来
    #   （原来太抠：58 条里积分上限最高才 300、大多只有几十）
    # ============================================================
    # ---- 日常打工（低门槛，但比以前给得多）----
    ("去菜市场帮人看摊", 8, 40, 1060, 4150),
    ("给早餐车卖豆浆油条", 9, 42, 1080, 4250),
    ("在写字楼送桶装水", 16, 70, 1590, 6250),
    ("给网吧值夜班", 20, 82, 1630, 6400),
    ("在菜鸟驿站分件", 17, 74, 1660, 6500),
    ("帮人排队买限量球鞋", 12, 55, 1530, 6000),
    ("给广场舞大妈放音响", 7, 38, 1390, 4350),
    ("在超市当试吃员", 13, 58, 1560, 6100),
    ("给早点铺洗碗", 11, 50, 1420, 4450),
    ("在窗帘店量尺寸", 15, 66, 1680, 6600),
    ("帮婚纱店整理礼服", 19, 80, 1710, 6700),
    ("在网吧当网管", 22, 90, 2270, 7100),
    ("给剧本杀店当NPC", 26, 105, 2320, 7250),
    ("在溜冰场租鞋处值班", 18, 76, 1750, 6850),
    ("给娃娃机补货", 14, 62, 1780, 7000),
    # ---- 手艺活（收入明显更高）----
    ("给老房子刷墙", 45, 180, 2500, 7800),
    ("上门通下水道", 42, 170, 2450, 7650),
    ("给木门换锁芯", 40, 165, 2400, 7500),
    ("装一台空调内机", 60, 240, 2510, 9850),
    ("给旧沙发换皮", 55, 220, 2470, 9700),
    ("打一套实木书架", 70, 275, 2730, 10700),
    ("给汽车做一次精洗", 48, 190, 2590, 8100),
    ("贴一间房的地板", 65, 255, 2640, 10350),
    ("给店面装发光字", 58, 230, 2550, 10000),
    ("修一台老式挂钟", 50, 200, 2690, 8400),
    ("给皮衣翻新上油", 44, 175, 2540, 7950),
    ("打一副银饰手镯", 66, 260, 2680, 10500),
    ("给民宿做布草更换", 38, 155, 2370, 7400),
    ("给老照片做修复", 62, 245, 2590, 10150),
    # ---- 技术活（高薪）----
    ("给小店做收银系统", 95, 370, 4000, 12500),
    ("帮公司做数据报表", 88, 345, 3660, 11450),
    ("给应用做界面设计", 100, 390, 4140, 12950),
    ("部署一台服务器", 110, 430, 3880, 15200),
    ("给人做简历优化", 52, 205, 2450, 9600),
    ("做一套企业logo", 92, 360, 3870, 12100),
    ("给视频做字幕打轴", 46, 182, 2640, 8250),
    ("用AI给小说配音", 78, 305, 2770, 10850),
    ("给小程序接支付接口", 105, 410, 3820, 15000),
    ("帮人做电商详情页", 86, 338, 3600, 11250),
    ("给无人机做航拍测绘", 118, 460, 3940, 15450),
    ("调一台三坐标测量仪", 125, 490, 4000, 15700),
    # ---- 体力活（累但赚得多）----
    ("给高层擦外窗", 130, 510, 4070, 15950),
    ("在物流园开叉车", 96, 375, 4080, 12750),
    ("给冷库做卸货", 84, 330, 2820, 11050),
    ("扛着设备爬30层楼", 140, 550, 4130, 16200),
    ("去山上拉一车毛竹", 90, 352, 3790, 11850),
    ("给货车换一整套轮胎", 88, 345, 3730, 11650),
    ("在港口绑扎集装箱", 145, 570, 4210, 16500),
    ("给演出搭一整天台子", 100, 392, 4220, 13200),
    ("去田里收一季稻子", 92, 360, 3940, 12300),
    ("给矿山做安全巡查", 150, 590, 4280, 16800),
    # ---- 特殊 / 高回报（看运气也看胆量）----
    ("给顶流明星当一天替身", 160, 620, 4360, 17100),
    ("去无人区拍纪录片", 175, 680, 5790, 18100),
    ("当一回深海潜水员", 190, 740, 6020, 18800),
    ("给富豪的私人岛屿做维护", 200, 780, 6240, 19500),
    ("参与一次火箭残骸回收", 220, 860, 6480, 20250),
    ("在极地科考站做帮工", 210, 820, 6350, 19850),
    ("给博物馆修复一件文物", 185, 720, 5900, 18450),
    ("当一天国家级赛事的裁判", 170, 660, 5680, 17750),
    ("去台风天做应急抢险", 195, 760, 6130, 19150),
    ("给航天基地搬精密仪器", 230, 900, 6590, 20600),
    ("当一回野生动物救护员", 165, 645, 4450, 17450),
    ("给金库做一天安保", 240, 940, 6720, 21000),
]

# 默认事件（宠物冒险）—— (事件, 经验下限, 经验上限, 积分下限, 积分上限, 额外掉血)
#   额外掉血是「在全局 pet_adventure_hp_cost 之外」多扣的血，让危险事件更有代价
DEFAULT_ADVENTURE_EVENTS = [
    # ---- 探索类（安全，稳收益）----
    ("钻进雾气弥漫的森林深处", 5, 40, 1, 6, 0),
    ("爬上一座陡峭的小山看日落", 6, 45, 1, 6, 1),
    ("在河边发现一个隐蔽的洞穴", 8, 55, 1, 8, 2),
    ("穿过一片金色的麦田", 4, 35, 1, 5, 0),
    ("在雪地里留下一串脚印", 7, 50, 1, 7, 1),
    ("沿着废弃的铁轨一直走", 9, 60, 2, 8, 1),
    ("翻过结冰的湖面", 10, 65, 2, 9, 2),
    ("走进一片会发光的蘑菇林", 12, 72, 2, 10, 2),
    ("顺着溪流找到源头", 11, 68, 2, 9, 1),
    ("爬上一棵最高的古树", 13, 76, 2, 10, 3),
    ("在草原上追着风跑", 5, 38, 1, 6, 0),
    ("走进一座被藤蔓覆盖的凉亭", 8, 52, 1, 7, 0),
    ("在黄昏时分的海边散步", 6, 42, 1, 6, 0),
    ("探访山谷里的回声壁", 14, 80, 2, 11, 2),
    ("在天坑边往下张望", 15, 85, 3, 12, 3),
    # ---- 寻宝类（收益高，风险中）----
    ("挖开一块松动的石板", 20, 105, 4, 15, 2),
    ("潜进水下的沉船残骸", 28, 130, 5, 18, 5),
    ("撬开一只生锈的旧木箱", 18, 98, 3, 14, 1),
    ("在沙漠里挖到半埋的陶罐", 24, 118, 4, 16, 3),
    ("闯进废弃矿洞找矿脉", 32, 142, 6, 20, 6),
    ("在古墓外室找到陪葬品", 35, 150, 6, 22, 7),
    ("从瀑布后面摸进石窟", 30, 136, 5, 19, 5),
    ("在雷雨后的河滩上捡到宝石", 26, 124, 5, 17, 3),
    ("爬上悬崖掏鹰巢", 34, 146, 6, 21, 8),
    ("在荒废的灯塔顶找到航海图", 29, 134, 5, 19, 5),
    ("钻进蚁丘下的地窖", 22, 112, 4, 15, 4),
    ("挖开雪堆下的旧雪橇", 19, 100, 3, 14, 2),
    # ---- 奇遇类（看运气）----
    ("遇到一只会说话的老猫头鹰", 40, 165, 7, 24, 2),
    ("被一阵怪风卷到半空", 36, 155, 6, 22, 5),
    ("误入一片时间流速不同的林子", 45, 180, 8, 26, 4),
    ("在月光下看见湖心的倒影在动", 42, 170, 7, 25, 3),
    ("捡到一枚会发烫的奇怪硬币", 38, 160, 7, 23, 2),
    ("听见石头在低声唱歌", 44, 175, 8, 25, 4),
    ("被一群萤火虫引着走了很远", 33, 145, 6, 21, 1),
    ("遇到一只受伤的小兽并救下它", 37, 158, 7, 23, 3),
    ("在沙暴里撞见一座幻影城", 48, 190, 8, 28, 6),
    ("跟着一只白鹿走进雾里", 46, 182, 8, 27, 4),
    # ---- 危险类（掉血多，回报大）----
    ("和一头野猪正面撞上", 50, 195, 8, 29, 10),
    ("被一群野狼围住", 55, 210, 9, 31, 12),
    ("从崩塌的山道上滚下来", 52, 200, 8, 30, 14),
    ("掉进猎人布置的深坑", 47, 188, 8, 28, 11),
    ("在沼泽里越陷越深", 49, 192, 8, 29, 12),
    ("被毒藤划伤了腿", 43, 172, 7, 25, 9),
    ("在暴风雪里迷了路", 54, 205, 9, 30, 13),
    ("被湍急的暗流卷走", 57, 215, 9, 32, 15),
    ("撞见一条盘在洞口的巨蟒", 62, 235, 11, 36, 16),
    ("和一只守宝的岩熊打了一架", 68, 250, 12, 40, 18),
    ("踩空掉进地下暗河", 58, 220, 10, 33, 15),
    ("被山火逼到崖边", 60, 228, 10, 34, 16),
    # ---- 传说类（稀有高收益）----
    ("在彩虹尽头的树下挖到一只小箱子", 75, 270, 13, 44, 5),
    ("撞见一场只持续三秒的流星雨", 80, 285, 14, 46, 3),
    ("在古战场捡到一柄断剑", 78, 278, 13, 45, 8),
    ("唤醒了一尊沉睡的石像", 88, 305, 16, 52, 12),
    ("走进了地图上不存在的小镇", 92, 315, 17, 55, 10),
    ("与传说中的九尾灵狐对视一眼", 96, 330, 18, 58, 14),
    ("在极光下捡到一颗星屑", 100, 340, 19, 60, 6),
]

# 默认物品
DEFAULT_ITEMS = [
    ("体力恢复药剂", 50, "mp", 50, "恢复 50 点体力"),
    ("血量恢复药剂", 50, "hp", 50, "恢复 50 点血量"),
    ("高级体力药剂", 150, "mp", 120, "恢复 120 点体力"),
    ("高级血量药剂", 150, "hp", 120, "恢复 120 点血量"),
]


class PetModule:
    """宠物系统（每群独立）"""

    DEFAULT_GROUP = "__default__"

    def _sn(self) -> str:
        """积分显示名（后台可自定义）"""
        return str(getattr(self, "score_name", "") or "").strip() or "积分"

    def __init__(self, plugin_dir: str, data_path: str):
        self.plugin_dir = plugin_dir
        self.data_path = data_path

        self.enable = True
        # ★ 积分显示名称（由 main.py 注入，后台可改，如「金币」）
        self.score_name = "积分"

        # 指令名（都可在后台自定义多个）
        self.cmd_buy = ["购买宠物", "买宠物"]
        self.cmd_mine = ["我的宠物"]
        self.cmd_sell = ["出售宠物"]
        self.cmd_release = ["放生宠物"]
        self.cmd_shop = ["宠物商店"]
        self.cmd_add = ["添加宠物"]
        self.cmd_del = ["删除宠物"]
        self.cmd_adventure = ["宠物冒险"]
        self.cmd_view = ["宠物查看"]
        self.cmd_rest = ["宠物休息"]
        self.cmd_duel = ["宠物决斗"]
        self.cmd_his_pet = ["他的宠物"]
        self.cmd_work = ["宠物上班"]
        self.cmd_item_shop = ["物品商店"]
        self.cmd_item_buy = ["购买物品", "买物品"]
        self.cmd_item_use = ["使用物品", "喂药"]

        # 冷却（小时）
        self.cd_adventure = 2.0
        self.cd_rest = 1.0
        self.cd_work = 4.0
        self.cd_duel = 1.0

        # 数值
        self.exp_per_level = 100          # 每级基础经验（实际 = base * lv）
        self.adventure_exp_min = 1
        self.adventure_exp_max = 200
        self.adventure_mp_cost = 5
        self.adventure_hp_cost = 5
        self.levelup_card_rate = 5        # 直接升一级的概率 %
        self.counter_bonus = 30           # 五行克制伤害加成 %

        # 群号黑名单
        self.allowed_groups = []
        self.group_mode = "off"
        self.group_whitelist = []
        self.group_blacklist = []

        self.catalog = []
        self.work_events = []
        self.adventure_events = []
        self.items = []

        self.groups = {}
        self._load()

    # ============================================================
    # 配置
    # ============================================================
    def reload(self, cfg: dict):
        cfg = cfg if isinstance(cfg, dict) else {}
        self.enable = bool(cfg.get("pet_enable", True))

        def _names(key, default):
            got = _parse_names(cfg.get(key, ""))
            return got if got else list(default)

        self.cmd_buy = _names("cmd_pet_buy_names", ["购买宠物", "买宠物"])
        self.cmd_mine = _names("cmd_pet_mine_names", ["我的宠物"])
        self.cmd_sell = _names("cmd_pet_sell_names", ["出售宠物"])
        self.cmd_release = _names("cmd_pet_release_names", ["放生宠物"])
        self.cmd_shop = _names("cmd_pet_shop_names", ["宠物商店"])
        self.cmd_add = _names("cmd_pet_add_names", ["添加宠物"])
        self.cmd_del = _names("cmd_pet_del_names", ["删除宠物"])
        self.cmd_adventure = _names("cmd_pet_adventure_names", ["宠物冒险"])
        self.cmd_view = _names("cmd_pet_view_names", ["宠物查看"])
        self.cmd_rest = _names("cmd_pet_rest_names", ["宠物休息"])
        self.cmd_duel = _names("cmd_pet_duel_names", ["宠物决斗"])
        self.cmd_his_pet = _names("cmd_pet_his_names", ["他的宠物"])
        self.cmd_work = _names("cmd_pet_work_names", ["宠物上班"])
        self.cmd_item_shop = _names("cmd_item_shop_names", ["物品商店"])
        self.cmd_item_buy = _names("cmd_item_buy_names", ["购买物品", "买物品"])
        self.cmd_item_use = _names("cmd_item_use_names", ["使用物品", "喂药"])

        def _f(key, default, lo=0.0):
            try:
                v = float(str(cfg.get(key, default) or default))
            except Exception:
                v = float(default)
            return max(lo, v)

        # ★ 五行是否在购买时随机分配（默认开启）
        self.elem_random_on_buy = bool(cfg.get("pet_elem_random_on_buy", True))

        self.cd_adventure = _f("pet_cd_adventure_hours", 2.0)
        self.cd_rest = _f("pet_cd_rest_hours", 1.0)
        self.cd_work = _f("pet_cd_work_hours", 4.0)
        self.cd_duel = _f("pet_cd_duel_hours", 1.0)

        try:
            self.exp_per_level = max(1, int(float(str(
                cfg.get("pet_exp_per_level", 100) or 100))))
        except Exception:
            self.exp_per_level = 100
        try:
            self.adventure_exp_min = max(0, int(float(str(
                cfg.get("pet_adventure_exp_min", 1) or 1))))
            self.adventure_exp_max = max(self.adventure_exp_min, int(float(str(
                cfg.get("pet_adventure_exp_max", 200) or 200))))
        except Exception:
            self.adventure_exp_min, self.adventure_exp_max = 1, 200
        try:
            self.adventure_mp_cost = max(0, int(float(str(
                cfg.get("pet_adventure_mp_cost", 5) or 5))))
            self.adventure_hp_cost = max(0, int(float(str(
                cfg.get("pet_adventure_hp_cost", 5) or 5))))
        except Exception:
            self.adventure_mp_cost, self.adventure_hp_cost = 5, 5
        try:
            self.levelup_card_rate = max(0, min(100, int(float(str(
                cfg.get("pet_levelup_card_rate", 5) or 5)))))
        except Exception:
            self.levelup_card_rate = 5
        try:
            self.counter_bonus = max(0, int(float(str(
                cfg.get("pet_counter_bonus", 30) or 30))))
        except Exception:
            self.counter_bonus = 30

        from .group_filter import parse_gid_whitelist
        self.allowed_groups = parse_gid_whitelist(cfg.get("pet_groups", ""))
        self.group_mode = str(cfg.get("pet_group_mode", "off") or "off").strip().lower()
        if self.group_mode not in ("off", "whitelist", "blacklist"):
            self.group_mode = "off"
        self.group_whitelist = self._lines(cfg.get("pet_group_whitelist", ""))
        self.group_blacklist = self._lines(cfg.get("pet_group_blacklist", ""))

        # 宠物图鉴（后台 template_list）
        raw = cfg.get("pet_list", [])
        cat = []
        if isinstance(raw, list):
            for it in raw:
                if not isinstance(it, dict):
                    continue
                name = str(it.get("name", "")).strip()
                if not name:
                    continue
                try:
                    price = int(float(str(it.get("price", 100) or 100)))
                except Exception:
                    price = 100
                elem = str(it.get("elem", "") or "").strip()
                if elem not in ELEMENTS:
                    elem = ELEMENTS[len(cat) % len(ELEMENTS)]
                cat.append({
                    "name": name,
                    "desc": str(it.get("desc", "")).strip(),
                    "price": max(0, price),
                    "elem": elem,
                })
        self.catalog = cat if cat else [
            {"name": n, "desc": d, "price": p, "elem": e}
            for (n, d, p, e) in DEFAULT_CATALOG
        ]

        # 上班事件
        raw_ev = cfg.get("pet_work_events", [])
        evs = []
        if isinstance(raw_ev, list):
            for it in raw_ev:
                if not isinstance(it, dict):
                    continue
                ev = str(it.get("event", "")).strip()
                if not ev:
                    continue
                def _i(k, d):
                    try:
                        return int(float(str(it.get(k, d) or d)))
                    except Exception:
                        return d
                evs.append({
                    "event": ev,
                    "exp_min": _i("exp_min", 5),
                    "exp_max": max(_i("exp_min", 5), _i("exp_max", 30)),
                    "score_min": _i("score_min", 1),
                    "score_max": max(_i("score_min", 1), _i("score_max", 5)),
                })
        self.work_events = evs if evs else [
            {"event": e, "exp_min": a, "exp_max": b,
             "score_min": c, "score_max": d}
            for (e, a, b, c, d) in DEFAULT_WORK_EVENTS
        ]

        # 冒险事件（可后台增删改；空则用内置默认）
        raw_adv = cfg.get("pet_adventure_events", [])
        advs = []
        if isinstance(raw_adv, list):
            for it in raw_adv:
                if not isinstance(it, dict):
                    continue
                ev = str(it.get("event", "")).strip()
                if not ev:
                    continue

                def _ai(k, d):
                    try:
                        return int(float(str(it.get(k, d) or d)))
                    except Exception:
                        return d
                advs.append({
                    "event": ev,
                    "exp_min": _ai("exp_min", 5),
                    "exp_max": max(_ai("exp_min", 5), _ai("exp_max", 30)),
                    "score_min": _ai("score_min", 1),
                    "score_max": max(_ai("score_min", 1), _ai("score_max", 5)),
                    "hp_cost": max(0, _ai("hp_cost", 0)),
                })
        self.adventure_events = advs if advs else [
            {"event": e, "exp_min": a, "exp_max": b,
             "score_min": c, "score_max": d, "hp_cost": h}
            for (e, a, b, c, d, h) in DEFAULT_ADVENTURE_EVENTS
        ]

        # 物品
        raw_item = cfg.get("pet_item_list", [])
        its = []
        if isinstance(raw_item, list):
            for it in raw_item:
                if not isinstance(it, dict):
                    continue
                nm = str(it.get("name", "")).strip()
                if not nm:
                    continue
                kind = str(it.get("kind", "") or "hp").strip().lower()
                if kind not in ("hp", "mp"):
                    kind = "hp"
                try:
                    price = int(float(str(it.get("price", 50) or 50)))
                    val = int(float(str(it.get("value", 50) or 50)))
                except Exception:
                    price, val = 50, 50
                its.append({
                    "name": nm,
                    "price": max(0, price),
                    "kind": kind,
                    "value": max(0, val),
                    "desc": str(it.get("desc", "")).strip(),
                })
        self.items = its if its else [
            {"name": n, "price": p, "kind": k, "value": v, "desc": d}
            for (n, p, k, v, d) in DEFAULT_ITEMS
        ]

    @staticmethod
    def _lines(raw) -> list:
        if not raw:
            return []
        if isinstance(raw, (list, tuple)):
            out = []
            for it in raw:
                out.extend(str(it).splitlines())
        else:
            out = str(raw).splitlines()
        return [x.strip() for x in out if x.strip() and not x.strip().startswith("#")]

    def set_enable(self, on: bool):
        self.enable = bool(on)

    def is_group_allowed(self, group_id) -> bool:
        from .group_filter import group_allowed, is_group_allowed
        if self.allowed_groups:
            return group_allowed(group_id, self.allowed_groups)
        return is_group_allowed(
            group_id, self.group_mode, self.group_whitelist, self.group_blacklist
        )

    # ============================================================
    # 指令匹配
    # ============================================================
    @staticmethod
    def _hit(text: str, names):
        for n in (names or []):
            if n and (text == n or text == f"/{n}"):
                return True
        return False

    @staticmethod
    def _arg(text: str, names) -> str:
        """返回指令后面的参数（没带参数返回空串，不匹配返回 None）"""
        for n in (names or []):
            if not n:
                continue
            if text == n or text == f"/{n}":
                return ""
            _carg = cmd_arg(text, (n,))
            if _carg is not None:
                    return _carg
        return None

    # ============================================================
    # 数据层
    # ============================================================
    @staticmethod
    def _gid(group_id) -> str:
        g = str(group_id or "").strip()
        return g if g else PetModule.DEFAULT_GROUP

    def _load(self):
        if not self.data_path or not os.path.exists(self.data_path):
            return
        try:
            with open(self.data_path, "r", encoding="utf-8-sig") as f:
                data = json.load(f) or {}
            self.groups = data.get("groups", {}) or {}
        except Exception:
            logger.exception("[pet] 读取失败")

    def _save(self):
        if not self.data_path:
            return
        try:
            tmp = self.data_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"groups": self.groups}, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.data_path)
        except Exception:
            logger.exception("[pet] 保存失败")

    def _gmap(self, group_id) -> dict:
        gid = self._gid(group_id)
        bucket = self.groups.get(gid)
        if not isinstance(bucket, dict):
            bucket = {"pets": {}, "items": {}}
            self.groups[gid] = bucket
        bucket.setdefault("pets", {})
        bucket.setdefault("items", {})
        return bucket

    def _upets(self, group_id, user_id) -> dict:
        """某群某人的宠物表（引用）"""
        m = self._gmap(group_id)["pets"]
        uid = str(user_id)
        d = m.get(uid)
        if not isinstance(d, dict):
            d = {}
            m[uid] = d
        return d

    def _uitems(self, group_id, user_id) -> dict:
        """某群某人的物品表（引用）"""
        m = self._gmap(group_id)["items"]
        uid = str(user_id)
        d = m.get(uid)
        if not isinstance(d, dict):
            d = {}
            m[uid] = d
        return d

    # ============================================================
    # 宠物基础计算
    # ============================================================
    def _need_exp(self, lv: int) -> int:
        """升到下一级所需经验（随等级递增，100 级封顶）"""
        lv = max(1, int(lv))
        return int(self.exp_per_level * lv * (1 + lv / 20))

    @staticmethod
    def _base_stats(price: int, elem: str, name: str = "",
                    owner_id: str = "") -> dict:
        """
        购买成功后生成初始属性（商店与图鉴里都不展示属性）。

        用「玩家QQ + 宠物名 + 价格 + 五行」做种子：
          · 同一个玩家买同一只 -> 基准稳定（重启/重算结果一致）
          · **不同玩家买同一只 -> 属性各不相同**（各自随机生成）
          · 商店列表与图鉴始终看不到属性，只有买下之后才能看到
        """
        rnd = random.Random(f"{owner_id}|{name}|{price}|{elem}")
        base = 60 + price // 10
        return {
            "hp_max": base + rnd.randint(0, 30),
            "mp_max": 40 + price // 20 + rnd.randint(0, 20),
            "atk": 8 + price // 60 + rnd.randint(0, 5),
            "df": 5 + price // 80 + rnd.randint(0, 4),
        }

    def pick_elem(self, name: str, owner_id: str = "", fallback: str = "金") -> str:
        """
        决定这只宠物的五行。
        默认在**购买时随机分配**（按玩家QQ + 宠物名，同一玩家结果稳定、不同玩家各不相同）。
        把后台「五行购买时随机分配」关掉后，则沿用图鉴里配的五行。
        """
        if not bool(getattr(self, "elem_random_on_buy", True)):
            return fallback if fallback in ELEMENTS else "金"
        rnd = random.Random(f"elem|{owner_id}|{name}")
        return rnd.choice(list(ELEMENTS))

    def _new_pet(self, entry: dict, owner_id: str = "") -> dict:
        name = str(entry.get("name", ""))
        owner = str(owner_id or "")
        # 五行也是购买时才定的（商店/图鉴都不展示）
        elem = self.pick_elem(name, owner, str(entry.get("elem", "金") or "金"))
        st = self._base_stats(int(entry.get("price", 100)), elem, name, owner)
        return {
            "lv": 1, "exp": 0,
            "hp": st["hp_max"], "hp_max": st["hp_max"],
            "mp": st["mp_max"], "mp_max": st["mp_max"],
            "atk": st["atk"], "df": st["df"],
            "elem": elem,
            "price": int(entry.get("price", 100)),
            "cd_adventure": 0.0, "cd_rest": 0.0,
            "cd_work": 0.0, "cd_duel": 0.0,
        }

    def _power(self, p: dict) -> int:
        """简单战力评估，用于决斗胜率"""
        return (int(p.get("atk", 0)) * 3 + int(p.get("df", 0)) * 2
                + int(p.get("hp_max", 0)) + int(p.get("lv", 1)) * 5)

    def _elem_bonus(self, a_elem: str, d_elem: str) -> float:
        """五行克制加成：克制返回 >1，被克返回 <1"""
        pct = float(self.counter_bonus) / 100.0
        if COUNTER.get(a_elem) == d_elem:
            return 1.0 + pct
        if COUNTER.get(d_elem) == a_elem:
            return max(0.5, 1.0 - pct / 2.0)
        return 1.0

    def _level_up(self, p: dict) -> int:
        """升级：随机增加若干属性，返回升了几级"""
        ups = 0
        while int(p.get("lv", 1)) < MAX_LEVEL:
            need = self._need_exp(int(p.get("lv", 1)))
            if int(p.get("exp", 0)) < need:
                break
            p["exp"] = int(p.get("exp", 0)) - need
            p["lv"] = int(p.get("lv", 1)) + 1
            ups += 1
            # 随机增加 2~3 项属性
            gains = random.sample(
                ["hp_max", "mp_max", "atk", "df"], k=random.randint(2, 3)
            )
            for g in gains:
                if g == "hp_max":
                    p[g] = int(p.get(g, 0)) + random.randint(5, 15)
                elif g == "mp_max":
                    p[g] = int(p.get(g, 0)) + random.randint(3, 10)
                elif g == "atk":
                    p[g] = int(p.get(g, 0)) + random.randint(1, 3)
                else:
                    p[g] = int(p.get(g, 0)) + random.randint(1, 3)
            # 升级回满
            p["hp"] = int(p.get("hp_max", 100))
            p["mp"] = int(p.get("mp_max", 50))
        return ups

    def _cd_left(self, p: dict, key: str) -> float:
        """剩余冷却秒数（0 表示可用）"""
        last = float(p.get(key, 0) or 0)
        if last <= 0:
            return 0.0
        return max(0.0, last - _now())

    def _set_cd(self, p: dict, key: str, hours: float):
        p[key] = _now() + float(hours) * 3600.0

    # ============================================================
    # 指令参数解析
    # ============================================================
    def parse_buy(self, text):
        return self._arg(text, self.cmd_buy)

    def parse_mine(self, text):
        return self._arg(text, self.cmd_mine)

    def parse_sell(self, text):
        return self._arg(text, self.cmd_sell)

    def parse_release(self, text):
        return self._arg(text, self.cmd_release)

    def parse_shop(self, text):
        return self._arg(text, self.cmd_shop)

    def parse_add(self, text):
        return self._arg(text, self.cmd_add)

    def parse_del(self, text):
        return self._arg(text, self.cmd_del)

    def parse_adventure(self, text):
        return self._arg(text, self.cmd_adventure)

    def parse_view(self, text):
        return self._arg(text, self.cmd_view)

    def parse_rest(self, text):
        return self._arg(text, self.cmd_rest)

    def parse_duel(self, text):
        """
        宠物决斗。支持三种写法：

            {cmd} @某人                -> 双方随机出一只
            {我的宠物名} {cmd} @某人    -> 指定我的宠物，对方随机
            {我的宠物名} {cmd} @某人 对方宠物名 -> 双方都指定

        返回：None=不匹配；否则=指令后面的参数原文
              （可能是 "@某人"、"@某人 对方宠物名" 等）
        """
        return self._arg(text, self.cmd_duel)

    def parse_his_pet(self, text):
        """他的宠物 @某人 -> 查对方的宠物列表"""
        return self._arg(text, self.cmd_his_pet)

    def parse_work(self, text):
        return self._arg(text, self.cmd_work)

    def parse_item_shop(self, text):
        return self._arg(text, self.cmd_item_shop)

    def parse_item_buy(self, text):
        return self._arg(text, self.cmd_item_buy)

    def parse_item_use(self, text):
        return self._arg(text, self.cmd_item_use)

    # ============================================================
    # 图鉴
    # ============================================================
    def _find_entry(self, name: str):
        name = str(name or "").strip()
        if not name:
            return None
        for e in self.catalog:
            if e.get("name") == name:
                return e
        return None

    def _owned_by_anyone(self, group_id, name: str) -> str:
        """
        本群是否已有人拥有该宠物，返回拥有者 uid（没有返回空）。

        注：宠物商店已改为「每种宠物每人都能买一只」，
        购买流程不再调用它；保留此方法供后续统计/管理功能使用。
        """
        m = self._gmap(group_id)["pets"]
        for uid, pets in m.items():
            if isinstance(pets, dict) and name in pets:
                return str(uid)
        return ""

    # ============================================================
    # 宠物商店 / 购买 / 我的宠物 / 出售 / 放生
    # ============================================================
    PAGE_SIZE = 20
    # 「全部宠物一起出勤」时（冒险 / 上班），最多显示几只的详细记录。
    # 其余用省略号带过 —— 但**所有宠物都会真正结算并保存**。
    BATCH_SHOW = 10

    def shop_text(self, group_id, page: int = 1, viewer_id: str = "") -> str:
        total = len(self.catalog)
        if total == 0:
            return "⚠️ 宠物图鉴为空，请管理员用「添加宠物」添加"
        max_page = max(1, (total + self.PAGE_SIZE - 1) // self.PAGE_SIZE)
        page = max(1, min(int(page or 1), max_page))
        start = (page - 1) * self.PAGE_SIZE
        end = start + self.PAGE_SIZE

        lines = [f"{title_bar(f'宠物商店（第 {page}/{max_page} 页）')}", ""]
        mine = self._upets(group_id, viewer_id) if viewer_id else {}
        # ★ 每只宠物谁都能买一只，所以不再标注「已被购买」，
        #   只看「你自己是否已有」（集合提到循环外，避免重复构造）
        mine_names = set(mine.keys())
        for i, e in enumerate(self.catalog[start:end], start=start + 1):
            tag = "（你已拥有）" if e["name"] in mine_names else ""
            # 不展示五行：属性（含五行）都在购买后才生成，商店里一律不露出
            lines.append(
                f"{i}. {e['name']} — {e['price']} {self._sn()}{tag}"
            )
            if e.get("desc"):
                lines.append(f"    {e['desc']}")
        lines.append("")
        lines.append(f"💡 每页 {self.PAGE_SIZE} 种；用「{self.cmd_shop[0]} 页码」翻页")
        lines.append(f"💡 购买：「{self.cmd_buy[0]} 宠物名」")
        lines.append("💡 每种宠物每人都能买一只，互不影响")
        return "\n".join(lines)

    def buy(self, group_id, user_id, name: str, balance_getter=None,
            balance_setter=None) -> str:
        entry = self._find_entry(name)
        if not entry:
            return (f"⚠️ 没有叫「{name}」的宠物\n"
                    f"💡 用「{self.cmd_shop[0]}」查看可购买列表")
        pets = self._upets(group_id, user_id)
        # ★ 每只宠物「谁都能买一只」：只拦「自己已经有了」，
        #   不再限制别的群友是否已购买。
        if name in pets:
            return (f"⚠️ 你已经拥有「{name}」了\n"
                    f"💡 每人每种宠物限一只，其它宠物可继续购买")

        price = int(entry.get("price", 0))
        if balance_getter is not None:
            bal = int(balance_getter() or 0)
            if bal < price:
                # ★ main.py 注入的 short_hint 会显示「钱包 + 银行 = 可用，还差 N」
                _fn = getattr(self, "short_hint", None)
                if callable(_fn):
                    try:
                        return str(_fn(price) or "")
                    except Exception:
                        pass
                _lines = [
                    f"⚠️ {self._sn()}不足",
                    f"💰 需要：{price} {self._sn()}",
                    f"💳 当前：{bal} {self._sn()}",
                ]
                _h = ""
                try:
                    _lf = getattr(self, "loan_hint", None)
                    if callable(_lf):
                        _h = str(_lf() or "")
                except Exception:
                    _h = ""
                if _h:
                    _lines += ["", _h]
                return "\n".join(_lines)
            if balance_setter is not None:
                balance_setter(bal - price)

        pets[name] = self._new_pet(entry, owner_id=str(user_id or ""))
        self._save()
        p = pets[name]
        return "\n".join([
            f"{title_bar('购买成功')}",
            "",
            f"🎉 你获得了「{name}」【{p['elem']}】",
            f"💰 花费：{fmt_num(price)} {self._sn()}",
            f"📈 等级：Lv.{p['lv']}（满级 {MAX_LEVEL}）",
            "",
            f"💡 用「{self.cmd_adventure[0]} {name}」带它冒险",
            f"💡 用「{self.cmd_view[0]} {name}」查看属性",
        ])

    def mine_text(self, group_id, user_id, name: str = "",
                  page: int = 1) -> str:
        """
        我的宠物列表。

        排版（每只两行，无多余空格）：
            1. 名字【属性】Lv.等级
            ❤️血量 💧体力 ⚔️攻击 🛡防御 ✨经验 冒险状态
        分页：每页 PAGE_SIZE（20）只。
        """
        pets = self._upets(group_id, user_id)
        if not pets:
            return (f"⚠️ 你还没有宠物\n"
                    f"💡 用「{self.cmd_shop[0]}」看看宠物商店")

        names = sorted(pets.keys())
        total = len(names)
        max_page = max(1, (total + self.PAGE_SIZE - 1) // self.PAGE_SIZE)
        try:
            page = int(page or 1)
        except Exception:
            page = 1
        page = max(1, min(page, max_page))
        start = (page - 1) * self.PAGE_SIZE
        end = start + self.PAGE_SIZE

        head = f"{title_bar('我的宠物')}"
        if max_page > 1:
            head = f"{title_bar(f'我的宠物（{page}/{max_page}）')}"
        lines = [head, ""]
        for i, nm in enumerate(names[start:end], start=start + 1):
            p = pets[nm]
            cd = self._cd_left(p, "cd_adventure")
            adv = _fmt_cd(cd) if cd > 0 else "就绪"
            lines.append(
                f"{i}. {nm}【{p.get('elem', '?')}】Lv.{p.get('lv', 1)}"
            )
            lines.append(
                f"❤️{p.get('hp', 0)}/{p.get('hp_max', 0)}"
                f" 💧{p.get('mp', 0)}/{p.get('mp_max', 0)}"
                f" ⚔️{p.get('atk', 0)} 🛡{p.get('df', 0)}"
                f" ✨{p.get('exp', 0)}/{self._need_exp(int(p.get('lv', 1)))}"
                f" 冒险{adv}"
            )
        lines.append("")
        if max_page > 1:
            lines.append(
                f"💡 共 {total} 只；用「{self.cmd_mine[0]} 页码」翻页"
            )
        else:
            lines.append(f"💡 共 {total} 只；满级 Lv.{MAX_LEVEL}")
        return "\n".join(lines)

    def sell(self, group_id, user_id, name: str,
             balance_getter=None, balance_setter=None) -> str:
        pets = self._upets(group_id, user_id)
        if name not in pets:
            return f"⚠️ 你没有叫「{name}」的宠物"
        p = pets[name]
        price = int(p.get("price", 0))
        refund = int(price * 0.75)      # 扣除市场价 25%
        del pets[name]
        if balance_setter is not None and balance_getter is not None:
            balance_setter(int(balance_getter() or 0) + refund)
        self._save()
        return "\n".join([
            f"{title_bar('出售成功')}",
            "",
            f"📤 已出售「{name}」Lv.{p.get('lv', 1)}",
            f"💰 获得：{refund} {self._sn()}（市场价 {price} 的 75%）",
        ])

    def release(self, group_id, user_id, name: str) -> str:
        pets = self._upets(group_id, user_id)
        if name not in pets:
            return f"⚠️ 你没有叫「{name}」的宠物"
        p = pets.pop(name)
        self._save()
        return "\n".join([
            f"{title_bar('放生成功')}",
            "",
            f"🕊 已把「{name}」Lv.{p.get('lv', 1)} 放归自然",
            f"💡 放生不返还{self._sn()}",
        ])

    # ============================================================
    # 管理员：添加 / 删除宠物
    # ============================================================
    def add_pet(self, arg: str) -> str:
        if not arg:
            return ("用法：添加宠物 名字|介绍|价格|属性\n"
                    "属性可选：金 木 水 火 土（不填则自动分配）")
        parts = [x.strip() for x in str(arg).split("|")]
        while len(parts) < 4:
            parts.append("")
        name, desc, price_s, elem = parts[0], parts[1], parts[2], parts[3]
        if not name:
            return "⚠️ 宠物名字不能为空"
        try:
            price = int(float(price_s or 100))
        except Exception:
            price = 100
        if elem not in ELEMENTS:
            elem = ELEMENTS[len(self.catalog) % len(ELEMENTS)]
        if self._find_entry(name):
            return f"⚠️ 宠物「{name}」已存在"

        self.catalog.append({
            "name": name, "desc": desc, "price": max(0, price), "elem": elem,
        })
        self._save_catalog_to_disk()
        return "\n".join([
            f"{title_bar('已添加宠物')}",
            "",
            f"🐾 {name}【{elem}】",
            f"💰 价格：{price} {self._sn()}",
            f"📝 介绍：{desc or '（无）'}",
            f"📊 图鉴共 {len(self.catalog)} 种",
        ])

    def del_pet(self, arg: str) -> str:
        text = str(arg or "").strip()
        if not text.isdigit():
            return "用法：删除宠物 序号（序号见宠物商店）"
        idx = int(text) - 1
        if idx < 0 or idx >= len(self.catalog):
            return f"⚠️ 序号不存在（当前共 {len(self.catalog)} 种）"
        entry = self.catalog.pop(idx)
        self._save_catalog_to_disk()
        return "\n".join([
            f"{title_bar('已删除宠物')}",
            "",
            f"🗑 已从图鉴移除：{entry['name']}",
            f"📊 图鉴剩余 {len(self.catalog)} 种",
        ])

    def _save_catalog_to_disk(self):
        """图鉴需要写回后台配置（template_list），否则重启会丢"""
        try:
            writer = getattr(self, "_cfg_catalog_write", None)
            if writer:
                writer(self.catalog)
        except Exception:
            logger.exception("[pet] 写回宠物图鉴失败")

    # ============================================================
    # 宠物查看
    # ============================================================
    def view_text(self, group_id, user_id, name: str, owner_name: str = "") -> str:
        pets = self._upets(group_id, user_id)
        if not pets:
            return f"⚠️ 你还没有宠物"
        if not name:
            return f"用法：{self.cmd_view[0]} 宠物名"
        p = pets.get(name)
        if not isinstance(p, dict):
            return (f"⚠️ 你没有叫「{name}」的宠物\n"
                    f"💡 已拥有：{'、'.join(pets.keys())}")
        need = self._need_exp(int(p.get("lv", 1)))
        # ★ 1.7.6：标题**不带名字**（用户要求），名字只放在属性行。
        #   以前写成 title_bar('宠物查看：{name}') —— 占位符在**单引号**里，
        #   f-string 不替换，用户看到字面量 `{name}`（bug，已修）。
        lines = [
            f"{title_bar('宠物查看')}",
            "",
            f"🐾 宠物名字：{name}",
            f"🏷 属性：{p.get('elem', '?')}　📈 等级：Lv.{p.get('lv', 1)}/{MAX_LEVEL}",
            f"✨ 经验：{p.get('exp', 0)}/{need}",
            "",
            f"❤️ 血量：{p.get('hp', 0)}/{p.get('hp_max', 0)}",
            f"💧 体力：{p.get('mp', 0)}/{p.get('mp_max', 0)}",
            f"⚔️ 攻击：{p.get('atk', 0)}",
            f"🛡 防御：{p.get('df', 0)}",
            "",
        ]
        if int(p.get("lv", 1)) >= MAX_LEVEL:
            lines.append("🌟 已满级")
        else:
            lines.append(f"📊 战力评估：{self._power(p)}")
        for key, label in (("cd_adventure", "冒险"), ("cd_rest", "休息"),
                           ("cd_work", "上班"), ("cd_duel", "决斗")):
            left = self._cd_left(p, key)
            lines.append(f"⏳ {label}冷却：{'就绪' if left <= 0 else _fmt_cd(left)}")
        return "\n".join(lines)

    # ============================================================
    # 宠物冒险
    # ============================================================
    def _adventure_one(self, name: str, p: dict, score_getter=None,
                       score_setter=None):
        """
        让单只宠物冒险一次。

        返回 (结果文本 or None, 状态)。状态取值：
          ok      成功
          cd      还在冷却
          nomp    体力不足
          nohp    血量太低
          noevent 后台没配事件
        文本已包含完整的宠物名，可直接拼进总输出。
        """
        left = self._cd_left(p, "cd_adventure")
        if left > 0:
            return (f"·「{name}」还在休息（剩 {_fmt_cd(left)}）", "cd")

        # ★ 先挑一个冒险事件（后台可增删改）
        if not self.adventure_events:
            return ("⚠️ 后台还没有配置冒险事件", "noevent")
        adv = random.choice(self.adventure_events)
        mp_cost = self.adventure_mp_cost
        # 事件自带的额外掉血叠加在全局掉血之上
        hp_cost = self.adventure_hp_cost + max(0, int(adv.get("hp_cost", 0) or 0))
        if int(p.get("mp", 0)) < mp_cost:
            return (f"·「{name}」体力不足（需 {mp_cost}，现有 "
                    f"{int(p.get('mp', 0))}）", "nomp")
        if int(p.get("hp", 0)) <= hp_cost:
            return (f"·「{name}」血量太低（需 >{hp_cost}，现有 "
                    f"{int(p.get('hp', 0))}）", "nohp")

        p["mp"] = int(p.get("mp", 0)) - mp_cost
        p["hp"] = max(1, int(p.get("hp", 0)) - hp_cost)
        _emin = max(int(adv.get("exp_min", self.adventure_exp_min) or 0),
                    self.adventure_exp_min)
        _emax = max(_emin, int(adv.get("exp_max", self.adventure_exp_max) or 0))
        gain = random.randint(_emin, _emax)
        p["exp"] = int(p.get("exp", 0)) + gain
        self._set_cd(p, "cd_adventure", self.cd_adventure)

        lines = [f"🗺 「{name}」{adv['event']}…"]
        lines.append("")
        lines.append(f"✨ 获得经验：+{gain}")

        ups = self._level_up(p)
        if ups:
            lines.append(f"🎉 升级成功！现在是 Lv.{p.get('lv', 1)}")
            if ups > 1:
                lines.append(f"   （连升 {ups} 级）")

        # 一定概率掉落直升一级卡
        if random.randint(1, 100) <= self.levelup_card_rate:
            before = int(p.get("lv", 1))
            if before < MAX_LEVEL:
                p["lv"] = before + 1
                p["exp"] = 0
                lines.append("")
                lines.append("🍀 幸运！拾到一张「直升一级卡」")
                lines.append(f"📈 等级直接提升：Lv.{before} → Lv.{before + 1}")
            else:
                lines.append("")
                lines.append("🍀 幸运！拾到「直升一级卡」，但已经满级了")

        _smin = max(int(adv.get("score_min", 1) or 0), 1)
        _smax = max(_smin, int(adv.get("score_max", 20) or 0))
        bonus = random.randint(_smin, _smax)
        if score_setter is not None and score_getter is not None:
            score_setter(int(score_getter() or 0) + bonus)
        lines.append(f"💰 顺路捡到：+{bonus} {self._sn()}")

        lines.append(f"❤️ 血量 {p.get('hp', 0)}/{p.get('hp_max', 0)}　"
                     f"💧 体力 {p.get('mp', 0)}/{p.get('mp_max', 0)}")
        return ("\n".join(lines), "ok")

    def adventure(self, group_id, user_id, name: str,
                  score_getter=None, score_setter=None) -> str:
        """宠物冒险。不带宠物名 -> 全部宠物一起冒险（各自随机事件）。"""
        pets = self._upets(group_id, user_id)
        if not pets:
            return f"⚠️ 你还没有宠物，先去「{self.cmd_shop[0]}」买一只"

        # 指定了名字：只跑那一只（保持原有输出格式）
        if name:
            p = pets.get(name)
            if not isinstance(p, dict):
                return f"⚠️ 你没有叫「{name}」的宠物"
            text, state = self._adventure_one(
                name, p, score_getter, score_setter
            )
            if state != "ok":
                return f"{title_bar(f'宠物冒险：{name}')}\n\n{text}"
            self._save()
            return (f"{title_bar(f'宠物冒险：{name}')}\n\n{text}\n"
                    f"⏳ 下次冒险需等：{_fmt_cd(self.cd_adventure * 3600)}")

        # 没给名字：全部一起冒险
        #   ★ 所有宠物都会真正跑一遍（冷却/体力/经验/积分都照常结算并保存），
        #     只是**输出只显示前 BATCH_SHOW 只**，其余用省略号带过，
        #     避免宠物多时刷屏。
        blocks, went, skipped = [], 0, 0
        for nm in list(pets.keys()):
            p = pets.get(nm)
            if not isinstance(p, dict):
                continue
            text, state = self._adventure_one(
                nm, p, score_getter, score_setter
            )
            if state == "noevent":
                return text                      # 后台没配事件，整条中止
            blocks.append(text)
            if state == "ok":
                went += 1
            else:
                skipped += 1

        if went:
            self._save()

        shown = blocks[:self.BATCH_SHOW]
        hidden = len(blocks) - len(shown)
        lines = [f"{title_bar('宠物冒险（全部 {len(pets)} 只）')}", ""]
        lines.append("\n".join(shown))
        if hidden > 0:
            lines.append("")
            lines.append(f"…… 其余 {hidden} 只的冒险记录已省略")
        lines.append("")
        lines.append(f"📊 出勤 {went} 只，未出发 {skipped} 只")
        if went:
            lines.append(f"⏳ 下次冒险需等：{_fmt_cd(self.cd_adventure * 3600)}")
        return "\n".join(lines)

    # ============================================================
    # 宠物休息
    # ============================================================
    def rest(self, group_id, user_id, name: str = "") -> str:
        pets = self._upets(group_id, user_id)
        if not pets:
            return f"⚠️ 你还没有宠物"
        targets = []
        if name:
            if name not in pets:
                return f"⚠️ 你没有叫「{name}」的宠物"
            targets = [name]
        else:
            targets = list(pets.keys())

        lines = [f"{title_bar('宠物休息')}", ""]
        rested = 0
        for nm in targets:
            p = pets[nm]
            left = self._cd_left(p, "cd_rest")
            if left > 0:
                lines.append(f"· {nm}：还在恢复中（剩 {_fmt_cd(left)}）")
                continue
            # 恢复 40% 血量与体力
            hp_add = max(1, int(int(p.get("hp_max", 100)) * 0.4))
            mp_add = max(1, int(int(p.get("mp_max", 50)) * 0.4))
            p["hp"] = min(int(p.get("hp_max", 100)), int(p.get("hp", 0)) + hp_add)
            p["mp"] = min(int(p.get("mp_max", 50)), int(p.get("mp", 0)) + mp_add)
            self._set_cd(p, "cd_rest", self.cd_rest)
            rested += 1
            lines.append(f"· {nm}：❤️+{hp_add} 💧+{mp_add} "
                         f"→ {p['hp']}/{p['hp_max']}、{p['mp']}/{p['mp_max']}")
        if rested:
            self._save()
        lines.append("")
        lines.append(f"💡 休息冷却：{self.cd_rest} 小时")
        return "\n".join(lines)

    # ============================================================
    # 宠物决斗
    # ============================================================
    def _pick_random(self, pets: dict, exclude: str = ""):
        """从宠物里**随机**挑一只（可排除某个名字）。返回 (名字, 数据)"""
        names = [k for k in pets.keys() if k != exclude]
        if not names:
            names = list(pets.keys())
        if not names:
            return ("", None)
        nm = random.choice(names)
        return (nm, pets[nm])

    def _pick_any(self, pets: dict, want: str = "", exclude: str = ""):
        """
        挑一只宠物：want 给了就用 want（不存在返回 None），
        否则随机挑一只。返回 (名字, 数据) 或 (名字, None) 表示指定了但不存在。
        """
        if want:
            p = pets.get(want)
            if not isinstance(p, dict):
                return (want, None)
            return (want, p)
        return self._pick_random(pets, exclude)

    def his_pets_text(self, group_id, target_id, owner_name: str = "") -> str:
        """「他的宠物」：列出某个人在这个群的所有宠物"""
        pets = self._upets(group_id, target_id)
        who = owner_name or (str(target_id)[:3] + "****" + str(target_id)[-2:]
                             if len(str(target_id)) > 5 else str(target_id))
        if not pets:
            return f"⚠️ {who} 还没有宠物"

        # 按战力从高到低排
        items = sorted(pets.items(), key=lambda kv: self._power(kv[1]),
                       reverse=True)
        lines = [
            f"{title_bar(f'{who} 的宠物（{len(items)} 只）')}",
            "",
        ]
        for idx, (name, p) in enumerate(items, 1):
            elem = p.get("elem", "?")
            lv = p.get("lv", 1)
            hp, hpm = p.get("hp", 0), p.get("hp_max", 0)
            lines.append(f"{idx}. 「{name}」【{elem}】Lv.{lv}")
            lines.append(f"　 ❤️ {hp}/{hpm}　📊 战力 {self._power(p)}")
        lines.append("")
        lines.append(f"💡 想挑战：{self.cmd_duel[0]} {who}")
        return "\n".join(lines)

    def duel(self, group_id, attacker_id, defender_id,
             attacker_name: str = "", defender_name: str = "",
             a_want: str = "", d_want: str = "") -> str:
        """
        宠物决斗。

        a_want / d_want 指定用哪只宠物；空着就**随机**挑一只。
        指定了但宠物不存在时会给出提示，不会静默换别的。
        """
        a_pets = self._upets(group_id, attacker_id)
        d_pets = self._upets(group_id, defender_id)
        if not a_pets:
            return f"⚠️ 你还没有宠物，无法决斗"
        if not d_pets:
            return f"⚠️ 对方还没有宠物，无法决斗"

        a_name, a = self._pick_any(a_pets, a_want)
        if a is None:
            return (f"⚠️ 你没有叫「{a_want}」的宠物\n"
                    f"💡 已拥有：{'、'.join(a_pets.keys())}")
        d_name, d = self._pick_any(d_pets, d_want)
        if d is None:
            return (f"⚠️ 对方没有叫「{d_want}」的宠物\n"
                    f"💡 对方拥有：{'、'.join(d_pets.keys())}")

        for side, p in (("你", a), ("对方", d)):
            left = self._cd_left(p, "cd_duel")
            if left > 0:
                return f"⚠️ {side}的宠物还在恢复，剩 {_fmt_cd(left)}"

        pa, pd = self._power(a), self._power(d)
        bonus_a = self._elem_bonus(a.get("elem", "金"), d.get("elem", "金"))
        bonus_d = self._elem_bonus(d.get("elem", "金"), a.get("elem", "金"))
        # 胜率：基础 50% + 战力差影响 + 属性克制影响
        ratio = (pa * bonus_a) / max(1.0, (pa * bonus_a + pd * bonus_d))
        win_rate = max(10, min(90, int(ratio * 100)))
        win = random.randint(1, 100) <= win_rate

        # 双方消耗
        a["hp"] = max(1, int(a.get("hp", 1)) - random.randint(5, 20))
        d["hp"] = max(1, int(d.get("hp", 1)) - random.randint(5, 20))
        a["mp"] = max(0, int(a.get("mp", 0)) - 5)
        d["mp"] = max(0, int(d.get("mp", 0)) - 5)
        exp_gain = random.randint(5, 30)
        (a if win else d)["exp"] = int((a if win else d).get("exp", 0)) + exp_gain
        self._level_up(a)
        self._level_up(d)
        self._set_cd(a, "cd_duel", self.cd_duel)
        self._set_cd(d, "cd_duel", self.cd_duel)
        self._save()

        def nm(uid, fallback):
            return fallback or (str(uid)[:3] + "****" + str(uid)[-2:]
                                if len(str(uid)) > 5 else str(uid))

        lines = [
            f"{title_bar('宠物决斗')}",
            "",
            f"⚔️ {nm(attacker_id, attacker_name)} 的「{a_name}」"
            f"【{a.get('elem')}】Lv.{a.get('lv')}",
            f"🆚 {nm(defender_id, defender_name)} 的「{d_name}」"
            f"【{d.get('elem')}】Lv.{d.get('lv')}",
            "",
        ]
        if bonus_a > 1:
            lines.append(f"✨ 你的「{a_name}」属性克制对方（伤害 +{self.counter_bonus}%）")
        elif bonus_d > 1:
            lines.append(f"✨ 对方的「{d_name}」属性克制你（伤害 +{self.counter_bonus}%）")
        lines.append(f"📊 胜率评估：{win_rate}%")
        lines.append("")
        lines.append("🏆 你赢了！" if win else "💀 你输了…")
        lines.append(f"✨ 经验奖励：+{fmt_num(exp_gain)}（归{'你' if win else '对方'}）")
        lines.append("")
        lines.append(f"❤️ 你的「{a_name}」血量：{a['hp']}/{a['hp_max']}")
        lines.append(f"❤️ 对方「{d_name}」血量：{d['hp']}/{d['hp_max']}")
        lines.append(f"⏳ 决斗冷却：{self.cd_duel} 小时")
        return "\n".join(lines)

    # ============================================================
    # 宠物上班
    # ============================================================
    def _work_one(self, name: str, p: dict, score_getter=None,
                  score_setter=None):
        """
        让单只宠物上班一次。

        返回 (结果文本, 状态)。状态：ok / cd / noevent
        文本已含宠物名，可直接拼进总输出。
        """
        left = self._cd_left(p, "cd_work")
        if left > 0:
            return (f"·「{name}」还在上班中（剩 {_fmt_cd(left)}）", "cd")
        if not self.work_events:
            return ("⚠️ 后台还没有配置上班事件", "noevent")

        ev = random.choice(self.work_events)
        exp = random.randint(int(ev["exp_min"]), int(ev["exp_max"]))
        score = random.randint(int(ev["score_min"]), int(ev["score_max"]))
        p["exp"] = int(p.get("exp", 0)) + exp
        p["mp"] = max(0, int(p.get("mp", 0)) - 3)
        self._set_cd(p, "cd_work", self.cd_work)
        ups = self._level_up(p)
        if score_setter is not None and score_getter is not None:
            score_setter(int(score_getter() or 0) + score)

        lines = [
            f"💼 「{name}」{ev['event']}",
            f"✨ 获得经验：+{exp}",
            f"💰 获得{self._sn()}：+{score}",
        ]
        if ups:
            lines.append(f"🎉 升级！现在是 Lv.{p.get('lv', 1)}")
        lines.append(f"📈 经验：{p.get('exp', 0)}/"
                     f"{self._need_exp(int(p.get('lv', 1)))}")
        return ("\n".join(lines), "ok")

    def work(self, group_id, user_id, name: str = "",
             score_getter=None, score_setter=None) -> str:
        """宠物上班。不带宠物名 -> 全部宠物一起上班（各自随机事件）。"""
        pets = self._upets(group_id, user_id)
        if not pets:
            return f"⚠️ 你还没有宠物"

        # 指定了名字：只跑那一只（保持原有输出格式）
        if name:
            p = pets.get(name)
            if not isinstance(p, dict):
                return f"⚠️ 你没有叫「{name}」的宠物"
            text, state = self._work_one(name, p, score_getter, score_setter)
            if state != "ok":
                return f"{title_bar(f'宠物上班：{name}')}\n\n{text}"
            self._save()
            return (f"{title_bar(f'宠物上班：{name}')}\n\n{text}\n"
                    f"⏳ 下次上班需等：{_fmt_cd(self.cd_work * 3600)}")

        # 没给名字：全部一起上班
        #   ★ 与冒险一致：所有宠物都真正跑一遍并保存，
        #     但输出只显示前 BATCH_SHOW 只，其余省略号带过。
        blocks, went, skipped = [], 0, 0
        for nm in list(pets.keys()):
            p = pets.get(nm)
            if not isinstance(p, dict):
                continue
            text, state = self._work_one(nm, p, score_getter, score_setter)
            if state == "noevent":
                return text                      # 后台没配事件，整条中止
            blocks.append(text)
            if state == "ok":
                went += 1
            else:
                skipped += 1

        if went:
            self._save()

        shown = blocks[:self.BATCH_SHOW]
        hidden = len(blocks) - len(shown)
        lines = [f"{title_bar('宠物上班（全部 {len(pets)} 只）')}", ""]
        lines.append("\n".join(shown))
        if hidden > 0:
            lines.append("")
            lines.append(f"…… 其余 {hidden} 只的上班记录已省略")
        lines.append("")
        lines.append(f"📊 出勤 {went} 只，未出发 {skipped} 只")
        if went:
            lines.append(f"⏳ 下次上班需等：{_fmt_cd(self.cd_work * 3600)}")
        return "\n".join(lines)

    # ============================================================
    # 物品商店 / 购买 / 使用
    # ============================================================
    def item_shop_text(self, group_id, user_id) -> str:
        if not self.items:
            return "⚠️ 后台还没有配置物品"
        bag = self._uitems(group_id, user_id)
        lines = [f"{title_bar('物品商店')}", ""]
        for i, it in enumerate(self.items, start=1):
            have = int(bag.get(it["name"], 0))
            tag = f"（拥有 {have}）" if have else ""
            lines.append(f"{i}. {it['name']} — {it['price']} {self._sn()}{tag}")
            lines.append(f"    {it.get('desc') or ''}"
                         f"（{'恢复血量' if it['kind'] == 'hp' else '恢复体力'} {it['value']}）")
        lines.append("")
        lines.append(f"💡 购买：「{self.cmd_item_buy[0]} 物品名 数量」")
        lines.append(f"💡 使用：「{self.cmd_item_use[0]} 物品名 宠物名」")
        return "\n".join(lines)

    def _find_item(self, name: str):
        for it in self.items:
            if it["name"] == str(name or "").strip():
                return it
        return None

    def buy_item(self, group_id, user_id, arg: str,
                 score_getter=None, score_setter=None) -> str:
        text = str(arg or "").strip()
        if not text:
            return f"用法：{self.cmd_item_buy[0]} 物品名 数量"
        parts = text.split()
        name = parts[0]
        count = 1
        if len(parts) >= 2 and parts[1].isdigit():
            count = max(1, int(parts[1]))
        it = self._find_item(name)
        if not it:
            return f"⚠️ 没有叫「{name}」的物品\n💡 用「{self.cmd_item_shop[0]}」查看"
        total = int(it["price"]) * count
        if score_getter is not None:
            bal = int(score_getter() or 0)
            if bal < total:
                _fn = getattr(self, "short_hint", None)
                if callable(_fn):
                    try:
                        return str(_fn(total) or "")
                    except Exception:
                        pass
                _lines = [f"⚠️ {self._sn()}不足",
                          f"💰 需要：{total}", f"💳 当前：{bal}"]
                _h = ""
                try:
                    _lf = getattr(self, "loan_hint", None)
                    if callable(_lf):
                        _h = str(_lf() or "")
                except Exception:
                    _h = ""
                if _h:
                    _lines += ["", _h]
                return "\n".join(_lines)
            if score_setter is not None:
                score_setter(bal - total)
        bag = self._uitems(group_id, user_id)
        bag[name] = int(bag.get(name, 0)) + count
        self._save()
        return "\n".join([
            f"{title_bar('购买成功')}",
            "",
            f"🎁 获得：{name} ×{count}",
            f"💰 花费：{fmt_num(total)} {self._sn()}",
            f"📦 当前拥有：{bag[name]}",
        ])

    def use_item(self, group_id, user_id, arg: str) -> str:
        text = str(arg or "").strip()
        if not text:
            return f"用法：{self.cmd_item_use[0]} 物品名 宠物名"
        parts = text.split()
        name = parts[0]
        pet_name = parts[1] if len(parts) >= 2 else ""
        bag = self._uitems(group_id, user_id)
        if int(bag.get(name, 0)) <= 0:
            return f"⚠️ 你没有「{name}」\n💡 用「{self.cmd_item_shop[0]}」购买"
        it = self._find_item(name)
        if not it:
            return f"⚠️ 没有叫「{name}」的物品"
        pets = self._upets(group_id, user_id)
        if not pets:
            return "⚠️ 你还没有宠物，无法使用"
        if not pet_name:
            if len(pets) == 1:
                pet_name = next(iter(pets.keys()))
            else:
                return (f"用法：{self.cmd_item_use[0]} {name} 宠物名\n"
                        f"💡 你有多只宠物：{'、'.join(pets.keys())}")
        p = pets.get(pet_name)
        if not isinstance(p, dict):
            return f"⚠️ 你没有叫「{pet_name}」的宠物"

        val = int(it["value"])
        if it["kind"] == "hp":
            before = int(p.get("hp", 0))
            p["hp"] = min(int(p.get("hp_max", 100)), before + val)
            gained = p["hp"] - before
            label = f"❤️ 血量 +{gained}"
        else:
            before = int(p.get("mp", 0))
            p["mp"] = min(int(p.get("mp_max", 50)), before + val)
            gained = p["mp"] - before
            label = f"💧 体力 +{gained}"

        bag[name] = int(bag.get(name, 0)) - 1
        if bag[name] <= 0:
            bag.pop(name, None)
        self._save()
        return "\n".join([
            f"{title_bar('使用成功')}",
            "",
            f"🧪 对「{pet_name}」使用了「{name}」",
            f"{label}",
            f"❤️ {p.get('hp', 0)}/{p.get('hp_max', 0)}　"
            f"💧 {p.get('mp', 0)}/{p.get('mp_max', 0)}",
            f"📦 剩余：{bag.get(name, 0)}",
        ])

