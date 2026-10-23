import { useCallback, useEffect } from "react";
import { useApp } from "./store";

/** 界面语言：与 main 侧 LANGUAGES 归一化保持一致。 */
import { pagesDict } from "./i18n-pages";
import { pagesDictExtra } from "./i18n-extra";

export type Lang = "zh-CN" | "en-US" | "ja-JP";

export const LANGUAGES: Array<{ value: Lang; label: string }> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
];

/** 一条文案的三语版本；缺某个语言时回退 zh-CN。 */
type Entry = Record<Lang, string>;

const D = (zh: string, en: string, ja: string): Entry => ({ "zh-CN": zh, "en-US": en, "ja-JP": ja });

/**
 * 字典：按命名空间分组（nav / shell / titlebar / common / settings / about / toast）。
 * key 缺语言时回退 zh-CN；整个 key 不存在时返回 key 本身，方便一眼看出漏翻。
 */
const DICT: Record<string, Entry> = {
  // ---- 侧边栏 ----
  "nav.main": D("主导航", "Main navigation", "メインナビゲーション"),
  "nav.instances": D("实例", "Instances", "インスタンス"),
  "nav.servers": D("开服", "Servers", "サーバー"),
  "nav.accounts": D("账号", "Accounts", "アカウント"),
  "nav.skins": D("皮肤", "Skins", "スキン"),
  "nav.download": D("游戏", "Game", "ゲーム"),
  "nav.downloads": D("管理", "Transfers", "転送管理"),
  "nav.mods": D("资源", "Content", "コンテンツ"),
  "nav.net": D("联机", "Multiplayer", "マルチプレイ"),
  "nav.java": D("Java", "Java", "Java"),
  "nav.personalize": D("个性化", "Appearance", "外観"),
  "nav.launch": D("启动", "Launch", "起動"),
  "nav.other": D("其它", "Advanced", "その他"),
  "nav.about": D("关于", "About", "このアプリについて"),
  "nav.settings": D("设置", "Settings", "設定"),

  // ---- 外壳 ----
  "shell.mock": D("浏览器预览 · 假数据", "Browser preview · mock data", "ブラウザプレビュー · ダミーデータ"),
  "shell.live": D("已连接主进程", "Connected to main process", "メインプロセスに接続済み"),
  "shell.updateBadge": D("新", "New", "新着"),
  "shell.updateTitle": D("有新版本 v{version}", "Update available: v{version}", "新しいバージョン v{version} があります"),
  "shell.updateHint": D("有新版本 v{version}，点此查看", "Update available: v{version} — click to view", "新しいバージョン v{version} があります（クリックで表示）"),

  // ---- 标题栏 ----
  "titlebar.default": D("奶娃启动器 NaiWa Launcher", "NaiWa Launcher", "NaiWa ランチャー"),
  "titlebar.minimize": D("最小化", "Minimize", "最小化"),
  "titlebar.maximize": D("最大化", "Maximize", "最大化"),
  "titlebar.restore": D("还原", "Restore", "元に戻す"),
  "titlebar.close": D("关闭", "Close", "閉じる"),

  // ---- 通用 ----
  "common.save": D("保存", "Save", "保存"),
  "common.saving": D("保存中…", "Saving…", "保存中…"),
  "common.cancel": D("取消", "Cancel", "キャンセル"),
  "common.delete": D("删除", "Delete", "削除"),
  "common.open": D("打开", "Open", "開く"),
  "common.speedTest": D("测速", "Test speed", "速度テスト"),
  "common.speedTesting": D("测速中…", "Testing…", "テスト中…"),
  "common.notTested": D("未测速", "Not tested", "未計測"),

  // ---- 设置页 ----
  "settings.title": D("设置", "Settings", "設定"),
  "settings.subtitle": D("所有改动即时保存到 config/settings.json", "Every change is saved to config/settings.json immediately", "変更はすべて config/settings.json に即時保存されます"),
  "settings.loading": D("读取设置…", "Loading settings…", "設定を読み込み中…"),
  "settings.language": D("界面语言", "Language", "表示言語"),
  "settings.languageHint": D("立即生效，不需要重启；未翻译的页面会先显示中文", "Takes effect immediately, no restart needed", "すぐに反映されます（再起動は不要）"),
  "settings.languageToast": D("界面语言已切换", "Language changed", "表示言語を切り替えました"),
  "settings.group.sources": D("下载源", "Download sources", "ダウンロード元"),
  "settings.group.performance": D("下载性能", "Download performance", "ダウンロード性能"),
  "settings.group.versions": D("版本与自动切换", "Versions & auto-switch", "バージョンと自動切替"),
  "settings.group.curseforge": D("CurseForge", "CurseForge", "CurseForge"),
  "settings.group.modsJava": D("模组与 Java", "Mods & Java", "MOD と Java"),
  "settings.group.windowWallpaper": D("窗口与壁纸", "Window & wallpapers", "ウィンドウと壁紙"),
  "settings.group.about": D("关于", "About", "このアプリについて"),
  "settings.aboutNote": D("版本徽标、能力清单、更新日志与核心团队都收进了独立的「关于」页，这里只留一个入口，避免两处重复维护。", "Version, features, changelog and credits now live on the About page; this is just a shortcut.", "バージョン情報・機能一覧・更新履歴・開発チームは「このアプリについて」ページにまとめました。ここは入口だけです。"),
  "settings.openAbout": D("打开关于页", "Open About page", "「このアプリについて」を開く"),
  "settings.readingSources": D("读取下载源…", "Loading sources…", "ダウンロード元を読み込み中…"),
  "settings.sourceSwitched": D("下载源已切换", "Download source switched", "ダウンロード元を切り替えました"),
  "settings.speedDone": D("测速完成", "Speed test finished", "速度テストが完了しました"),
  "settings.rangeDownload": D("多线程 Range 下载", "Multi-threaded range download", "マルチスレッド Range ダウンロード"),
  "settings.connPerFile": D("单文件分片连接数", "Connections per file", "1ファイルあたりの接続数"),
  "settings.connPerFileHint": D("一个大文件用几条连接并行拉（1–16，默认 4）", "Parallel connections for a single large file (1–16, default 4)", "大きなファイルを並列で取得する接続数（1〜16、既定 4）"),
  "settings.fileConcurrency": D("多线程下载（文件并发数）", "Concurrent files", "同時ダウンロード数"),
  "settings.fileConcurrencyHint": D("多个文件同时下载（1–32，默认 12），安装整合包/资源时提速明显", "How many files download at once (1–32, default 12)", "同時にダウンロードするファイル数（1〜32、既定 12）"),
  "settings.connFormula": D("文件并发数 × 单文件分片数 = 理论最大连接数，过高可能被 CDN 限速", "Concurrent files × connections per file = theoretical max connections; too high may be throttled by the CDN", "同時ファイル数 × 接続数 = 理論上の最大接続数。大きすぎると CDN で制限されることがあります"),
  "settings.recheckedAfterSave": D("保存后回读校验", "Re-read after saving", "保存後に読み直して検証"),
  "settings.showSnapshot": D("显示测试版（快照）版本", "Show snapshot versions", "スナップショット版を表示"),
  "settings.showSnapshotHint": D("与下载页、新建实例弹窗的「测试版」勾选是同一项；关闭后快照版本不再出现在版本列表里", "Same switch as on the Game page and the new-instance dialog", "ゲームページや新規インスタンス作成ダイアログと同じ設定です"),
  "settings.threshold": D("自动切换源阈值（毫秒）", "Auto-switch threshold (ms)", "自動切替のしきい値（ミリ秒）"),
  "settings.thresholdHint": D("官方源慢于此值时自动使用 BMCLAPI 镜像；范围 200–10000，步进 100", "Use the BMCLAPI mirror when the official source is slower than this; 200–10000, step 100", "公式ソースがこの値より遅いと BMCLAPI ミラーを使います（200〜10000、100 刻み）"),
  "settings.thresholdInvalid": D("阈值需要是 200–10000 之间的数字", "The threshold must be a number between 200 and 10000", "しきい値は 200〜10000 の数値にしてください"),
  "settings.thresholdClamped": D("阈值已收敛到 {value} ms（允许范围 200–10000）", "Threshold clamped to {value} ms (allowed range 200–10000)", "しきい値を {value} ms に丸めました（範囲 200〜10000）"),
  "settings.needsApiKey": D("需要官方 API Key", "Official API key required", "公式 API キーが必要"),
  "settings.apiKeyHint": D("从 console.curseforge.com 申请后粘贴，仅保存在本地", "Create one at console.curseforge.com and paste it here; stored locally only", "console.curseforge.com で取得して貼り付けてください（ローカル保存のみ）"),
  "settings.apiKeyPlaceholder": D("粘贴 CurseForge API Key", "Paste your CurseForge API key", "CurseForge API キーを貼り付け"),
  "settings.apiKeySaved": D("CurseForge API Key 已保存", "CurseForge API key saved", "CurseForge API キーを保存しました"),
  "settings.apiKeyCleared": D("已清空 CurseForge API Key", "CurseForge API key cleared", "CurseForge API キーを消去しました"),
  "settings.showKey": D("显示 Key", "Show key", "キーを表示"),
  "settings.hideKey": D("隐藏 Key", "Hide key", "キーを隠す"),
  "settings.modSource": D("模组默认来源", "Default mod source", "MOD の既定ソース"),
  "settings.autoJava": D("自动安装 Java", "Install Java automatically", "Java を自動インストール"),
  "settings.autoJavaHint": D("启动时缺少匹配 JDK 就自动从 BellSoft 下载", "Download a matching JDK from BellSoft when one is missing", "対応する JDK が無いとき BellSoft から自動でダウンロードします"),
  "settings.autoMatchJava": D("自动匹配 Java 版本", "Match Java version automatically", "Java バージョンを自動で合わせる"),
  "settings.autoMatchJavaHint": D("关闭后每个实例必须单独指定 Java，否则启动报错", "When off, each instance must point to its own Java or launching fails", "オフにすると各インスタンスで Java を指定しないと起動できません"),
  "settings.closeToTray": D("关闭到托盘（旧开关）", "Close to tray (legacy)", "トレイに閉じる（旧設定）"),
  "settings.closeToTrayHint": D("托盘图标始终显示：随时点右下角图标都能叫回界面。这个开关只在「关闭窗口时」选择「询问我」时才起作用；一旦在下面把关闭行为定成「隐藏到托盘 / 直接退出」，就以那个选择为准，本开关被忽略。若右下角看不到图标，点任务栏的 ^ 展开通知区域，把奶娃启动器拖到显示区即可", "The tray icon is always present. This switch only applies when the close behaviour below is Ask me; choosing Hide to tray / Quit takes precedence. If the icon is hidden, expand the notification area and pin the launcher.", "トレイアイコンは常に表示されます。この設定は下の「閉じるとき」が「毎回確認」のときだけ有効で、「トレイに隠す／終了する」が優先されます。"),
  "settings.onClose": D("关闭窗口时", "When closing the window", "ウィンドウを閉じるとき"),
  "settings.onCloseHint": D("询问我：第一次点关闭会弹窗问，勾了「记住」后不再问；隐藏到托盘 / 直接退出：以后点关闭就按这里处理，上面的旧开关不再生效", "Ask me: shows a dialog the first time and remembers your choice; Hide to tray / Quit: applied right away, the legacy switch is ignored", "毎回確認：初回にダイアログで尋ね、選択を記憶します。トレイに隠す／終了する：以後はその動作になり、上の旧設定は無視されます"),
  "settings.close.ask": D("询问我", "Ask me", "毎回確認"),
  "settings.close.tray": D("隐藏到托盘", "Hide to tray", "トレイに隠す"),
  "settings.close.quit": D("直接退出", "Quit", "終了する"),
  "settings.wpDir": D("Wallpaper Engine 目录", "Wallpaper Engine folder", "Wallpaper Engine フォルダー"),
  "settings.wpDirHint": D("Steam 创意工坊应用 id 431960 的壁纸目录：<Steam 库>\\steamapps\\workshop\\content\\431960；留空则自动探测 Steam 库", "Workshop content folder for app 431960: <Steam library>\\steamapps\\workshop\\content\\431960. Leave empty to detect it automatically.", "アプリ ID 431960 のコンテンツフォルダー：<Steam ライブラリ>\\steamapps\\workshop\\content\\431960。空欄なら自動検出します"),
  "settings.wpDirPlaceholder": D("留空 = 自动探测", "Empty = auto-detect", "空欄 = 自動検出"),
  "settings.wpDirSaved": D("已保存 Wallpaper Engine 目录", "Wallpaper Engine folder saved", "Wallpaper Engine フォルダーを保存しました"),
  "settings.wpDirAuto": D("已改为自动探测 Wallpaper Engine 目录", "Switched back to auto-detect", "自動検出に戻しました"),
  "settings.provider.modrinth": D("Modrinth", "Modrinth", "Modrinth"),
  "settings.provider.curseforge": D("CurseForge", "CurseForge", "CurseForge"),
  "settings.provider.zh": D("麦块社区（中文）", "Minekuai (Chinese)", "Minekuai（中国語）"),
  "settings.unit.connections": D("{value} 条", "{value} conns", "{value} 接続"),
  "settings.unit.files": D("{value} 个", "{value} files", "{value} 個"),

  // ---- 关于页 ----
  "about.title": D("关于 NaiWa Launcher", "About NaiWa Launcher", "NaiWa ランチャーについて"),
  "about.subtitle": D("轻量、美观、开源的 Minecraft 启动器", "A lightweight, good-looking, open-source Minecraft launcher", "軽くて美しい、オープンソースの Minecraft ランチャー"),
  "about.openSource": D("开源项目", "Open source", "オープンソース"),
  "about.developer": D("开发者 奶龙", "by 奶龙", "開発 奶龙"),
  "about.newVersion": D("有新版本 v{version}", "New version v{version}", "新しいバージョン v{version}"),
  "about.checkUpdate": D("检查更新", "Check for updates", "アップデートを確認"),
  "about.checking": D("检查中…", "Checking…", "確認中…"),
  "about.checkFailed": D("检查更新失败：{error}", "Update check failed: {error}", "アップデート確認に失敗しました：{error}"),
  "about.openRepo": D("打开仓库", "Open repository", "リポジトリを開く"),
  "about.releaseNotes": D("发布说明 · v{version}", "Release notes · v{version}", "リリースノート · v{version}"),
  "about.currentVersion": D("当前版本 v{version}", "Current version v{version}", "現在のバージョン v{version}"),
  "about.installNote": D("下载新版本：免安装版替换自身；安装版会静默装回当前目录（如 D:\\minecraft\\NW）后自动重启", "Downloads the new build: the portable version replaces itself, the installer reinstalls silently and restarts", "新しいビルドを取得します。ポータブル版は自身を置き換え、インストーラー版は自動で再インストールして再起動します"),
  "about.noPackage": D("该版本还没有提供可自动更新的安装包", "This version has no auto-update package yet", "このバージョンには自動更新パッケージがありません"),
  "about.updateNow": D("立即更新", "Update now", "今すぐ更新"),
  "about.updating": D("正在更新…", "Updating…", "更新中…"),
  "about.goDownload": D("前往下载", "Open download page", "ダウンロードへ"),
  "about.manualInstall": D("该版本还没有提供可自动更新的安装包，请用「前往下载」手动安装。", "No auto-update package for this version; please install manually via the download page.", "このバージョンには自動更新パッケージがありません。「ダウンロードへ」から手動でインストールしてください。"),
  "about.restartHint": D("下载完成后启动器会自动重启", "The launcher restarts after the download finishes", "ダウンロード完了後にランチャーは自動で再起動します"),
  "about.linksTitle": D("链接与致谢", "Links & thanks", "リンクと謝辞"),
  "about.linksCount": D("{count} 项", "{count} items", "{count} 件"),
  "about.openLauncherDir": D("打开启动器目录", "Open launcher folder", "ランチャーのフォルダーを開く"),
  "about.openGameDir": D("打开游戏目录", "Open game folder", "ゲームのフォルダーを開く"),
  "about.teamTitle": D("核心团队", "Core team", "開発チーム"),
  "about.changelogTitle": D("更新日志", "Changelog", "更新履歴"),
  "about.changelogHistory": D("历史版本", "History", "過去のバージョン"),
  "about.changelogHistoryTitle": D("历史版本的更新日志在项目仓库的 CHANGELOG.md", "Older entries live in CHANGELOG.md in the repository", "過去の更新履歴はリポジトリの CHANGELOG.md にあります"),
  "about.changelogLoading": D("正在读取更新日志…", "Loading changelog…", "更新履歴を読み込み中…"),
  "about.changelogFailed": D("读取更新日志失败：{error}", "Failed to load changelog: {error}", "更新履歴の読み込みに失敗しました：{error}"),
  "about.changelogMissing": D("这个安装包里没有附带 CHANGELOG.md，点右上「历史版本」去仓库看。", "This build ships no CHANGELOG.md; use History to read it in the repository.", "このビルドには CHANGELOG.md が含まれていません。右上の「過去のバージョン」から確認してください。"),
  "about.changelogScope": D("只显示当前版本；更早的更新日志请在仓库的 CHANGELOG.md 查看。", "Only the current version is shown; older entries are in CHANGELOG.md.", "現在のバージョンのみ表示しています。過去の履歴はリポジトリの CHANGELOG.md をご覧ください。"),
  "about.changelogLatest": D("当前版本线", "Current line", "現行ライン"),
  "about.footer": D("由奶龙用心打造 · NaiWa Launcher v{version}", "Crafted by 奶龙 · NaiWa Launcher v{version}", "奶龙 が心を込めて制作 · NaiWa Launcher v{version}"),
  "about.confirmTitle": D("立即更新", "Update now", "今すぐ更新"),
  "about.confirmMessage": D("将下载新版本并替换当前程序，完成后自动重启。确定现在更新吗？", "This downloads the new build, replaces the current program and restarts. Continue?", "新しいビルドを取得して現在のプログラムを置き換え、完了後に再起動します。続行しますか？"),
  "about.openedExternal": D("已用外部浏览器打开{label}", "Opened {label} in your browser", "{label} をブラウザで開きました"),
  "about.openedDir": D("已打开{label}", "Opened {label}", "{label} を開きました"),
  "about.foundUpdate": D("发现新版本 v{version}", "New version v{version} found", "新しいバージョン v{version} が見つかりました"),
  "about.upToDate": D("已是最新版本 v{version}", "Already up to date (v{version})", "最新バージョンです（v{version}）"),
  "about.changelogToast": D("完整更新日志见项目仓库的 CHANGELOG.md", "Full changelog is in CHANGELOG.md in the repository", "完全な更新履歴はリポジトリの CHANGELOG.md にあります"),
  "about.capability.fabric": D("支持 Fabric / Forge / NeoForge", "Fabric / Forge / NeoForge support", "Fabric / Forge / NeoForge 対応"),
  "about.capability.fabricDesc": D("三种主流加载器一键安装，自动补齐对应版本的依赖库。", "One-click install for the three mainstream loaders, with matching libraries downloaded for you.", "主要3種のローダーをワンクリックで導入し、必要なライブラリも自動でそろえます。"),
  "about.capability.mods": D("CurseForge 与 Modrinth 模组", "CurseForge & Modrinth mods", "CurseForge と Modrinth の MOD"),
  "about.capability.modsDesc": D("两个平台合并搜索，装模组不用来回切网站。", "Search both platforms at once — no more tab hopping.", "2つのプラットフォームをまとめて検索。サイトを行き来する必要はありません。"),
  "about.capability.instances": D("多实例与存档直进", "Multiple instances & direct world launch", "複数インスタンスとワールド直起動"),
  "about.capability.instancesDesc": D("每个实例独立配置；选中存档就启动并直接进入世界。", "Each instance is configured separately; pick a world and jump straight in.", "インスタンスごとに設定を分離。ワールドを選べばそのまま起動します。"),
  "about.capability.search": D("中文搜索与实时翻译", "Chinese search & live translation", "中国語検索とリアルタイム翻訳"),
  "about.capability.searchDesc": D("模组名与简介自动译成中文，用中文关键词也能搜到。", "Mod names and summaries are translated, so Chinese keywords work too.", "MOD 名と説明を自動翻訳。中国語のキーワードでも探せます。"),
  "about.capability.java": D("BellSoft JDK 自动匹配", "Automatic BellSoft JDK matching", "BellSoft JDK の自動マッチング"),
  "about.capability.javaDesc": D("按游戏版本挑 Liberica JDK，缺了就在后台下载。", "Picks the right Liberica JDK for the game version and downloads it in the background.", "ゲームのバージョンに合う Liberica JDK を選び、無ければバックグラウンドで取得します。"),
  "about.capability.download": D("多线程下载与断点续传", "Multi-threaded downloads & resume", "マルチスレッドダウンロードと再開"),
  "about.capability.downloadDesc": D("分片并发拉资源，断线从断点续，镜像自动测速。", "Chunked parallel downloads that resume after drops, with automatic mirror speed testing.", "分割並列で取得し、途切れても続きから再開。ミラーは自動で速度を測ります。"),
  "about.link.project": D("项目主页", "Project home", "プロジェクトページ"),
  "about.link.feedback": D("问题反馈", "Feedback", "フィードバック"),
  "about.link.feedbackHint": D("提交 Issue 或建议（/issues）", "File an issue or suggestion (/issues)", "Issue や提案を送る（/issues）"),
  "about.link.qq": D("加入 QQ 群", "Join the QQ group", "QQ グループに参加"),
  "about.link.qqHint": D("群号 {number}", "Group {number}", "グループ番号 {number}"),
  "about.link.modrinth": D("Modrinth 官网", "Modrinth website", "Modrinth 公式サイト"),
  "about.link.curseforge": D("CurseForge 官网", "CurseForge website", "CurseForge 公式サイト"),
  "about.link.mirror": D("MCIM / BMCLAPI 致谢", "Thanks: MCIM / BMCLAPI", "謝辞：MCIM / BMCLAPI"),
  "about.link.mirrorHint": D("镜像与版本元数据来源", "Mirrors and version metadata", "ミラーとバージョンメタデータの提供元"),
  "about.link.steam302": D("推荐：Steamcommunity 302", "Recommended: Steamcommunity 302", "おすすめ：Steamcommunity 302"),
  "about.link.steam302Hint": D("羽翼城出品 · 改善 Steam 社区 / GitHub 访问", "By 羽翼城 · improves Steam Community / GitHub access", "羽翼城 制作 · Steam コミュニティ / GitHub へのアクセス改善"),
  "about.role.main": D("主开发者", "Lead developer", "メイン開発"),
  "about.role.co": D("协助开发者", "Co-developer", "サブ開発"),
  "about.role.tools": D("工具提供", "Tooling", "ツール提供"),
};

// 各页面自己的文案分两个文件放（按 pages.* 命名空间），这里合并进主字典。
// 分成两个文件是因为并行开发时两个代理各自追加，写同一个文件会互相覆盖。
Object.assign(DICT, pagesDict, pagesDictExtra);

/** 非组件场景（模块级常量、事件外的调用）用这个，组件内优先 useT()。 */
let activeLang: Lang = "zh-CN";

/** 当前语言：缺语言回退 zh-CN；缺 key 返回 key 本身（便于发现漏翻）。 */
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key];
  const raw = entry ? entry[lang] ?? entry["zh-CN"] : key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** 非 hook 版：用最近一次 useT() 观察到的语言。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(activeLang, key, vars);
}

/** 组件内用：跟随 settings.language，切换后立即重新渲染。 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const { settings } = useApp();
  const lang = (settings?.language ?? "zh-CN") as Lang;
  useEffect(() => {
    activeLang = lang;
  }, [lang]);
  return useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}
