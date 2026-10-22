import { useEffect, useState, type CSSProperties } from "react";
import logo from "../assets/logo.png";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import {
  IconBook,
  IconChevronRight,
  IconDownload,
  IconFolder,
  IconInstances,
  IconJava,
  IconLink,
  IconMessage,
  IconMods,
  IconPackage,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconUser,
  IconZap,
} from "../components/icons";

/** 占位地址：仓库地址定下来后只改这三行。 */
const PROJECT_URL = "https://github.com/JIJIGUOWANG123/NaiWaLauncher";
const FEEDBACK_URL = "https://github.com/JIJIGUOWANG123/NaiWaLauncher/issues";
const CHANGELOG_URL = "https://github.com/JIJIGUOWANG123/NaiWaLauncher/blob/main/CHANGELOG.md";
const RELEASES_URL = "https://github.com/JIJIGUOWANG123/NaiWaLauncher/releases";
/** 官方 QQ 群（群号 619915692）。 */
const QQ_GROUP_NO = "619915692";
const QQ_GROUP_URL = "https://qm.qq.com/q/42ksfWCEw0";
/** 推荐软件：羽翼城的 Steamcommunity 302（改善 Steam 社区 / GitHub 访问）。 */
const RECOMMEND_URL = "https://www.dogfight360.com/blog/18682/";

const CAPABILITIES = [
  { Icon: IconPackage, title: "支持 Fabric / Forge / NeoForge", desc: "三种主流加载器一键安装，自动补齐对应版本的依赖库。" },
  { Icon: IconMods, title: "CurseForge 与 Modrinth 模组", desc: "两个平台合并搜索，装模组不用来回切网站。" },
  { Icon: IconInstances, title: "多实例与存档直进", desc: "每个实例独立配置；选中存档就启动并直接进入世界。" },
  { Icon: IconSearch, title: "中文搜索与实时翻译", desc: "模组名与简介自动译成中文，用中文关键词也能搜到。" },
  { Icon: IconJava, title: "BellSoft JDK 自动匹配", desc: "按游戏版本挑 Liberica JDK，缺了就在后台下载。" },
  { Icon: IconDownload, title: "多线程下载与断点续传", desc: "分片并发拉资源，断线从断点续，镜像自动测速。" },
];

const LINKS = [
  { Icon: IconLink, label: "项目主页", hint: "github.com/JIJIGUOWANG123/NaiWaLauncher", url: PROJECT_URL },
  { Icon: IconMessage, label: "问题反馈", hint: "提交 Issue 或建议（/issues）", url: FEEDBACK_URL },
  { Icon: IconUser, label: "加入 QQ 群", hint: `群号 ${QQ_GROUP_NO}`, url: QQ_GROUP_URL },
  { Icon: IconPackage, label: "Modrinth 官网", hint: "modrinth.com", url: "https://modrinth.com/" },
  { Icon: IconMods, label: "CurseForge 官网", hint: "curseforge.com", url: "https://www.curseforge.com/minecraft" },
  { Icon: IconZap, label: "MCIM / BMCLAPI 致谢", hint: "镜像与版本元数据来源", url: "https://bmclapi2.bangbang93.com/" },
  { Icon: IconRocket, label: "推荐：Steamcommunity 302", hint: "羽翼城出品 · 改善 Steam 社区 / GitHub 访问", url: RECOMMEND_URL },
];

/** 近期主要条目；卡片只展示最近 3 条，更多见项目 CHANGELOG.md。 */
const CHANGELOG = [
  { title: "下载器稳定性", desc: "分片并发下载与断点续传重做，切镜像不再丢进度。" },
  { title: "Java 自动匹配", desc: "启动前按版本挑 JDK，缺少时从 BellSoft 自动下载。" },
  { title: "存档直进", desc: "实例卡新增存档抽屉，选中世界直接启动并进入。" },
  { title: "中文翻译", desc: "模组列表与详情实时译成中文，搜索支持中文关键词。" },
  { title: "前置依赖", desc: "安装模组前检查前置，缺什么一次装齐。" },
];

/** 团队头像一律用首字色块占位，不放真人照片。 */
const TEAM = [
  { name: "奶龙", role: "开发者", initial: "奶" },
  { name: "NaiWa Launcher 社区", role: "测试与反馈", initial: "社" },
];

/** 把外壳 .app-bg 上当前铺着的背景图镜像到 Hero：轮播换图时跟着更新。 */
function useAppBackground(): string {
  const [image, setImage] = useState("");
  useEffect(() => {
    const layer = document.querySelector<HTMLElement>(".app-bg");
    if (!layer) return;
    const read = () => {
      const value = getComputedStyle(layer).backgroundImage;
      setImage(value && value !== "none" ? value : "");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(layer, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, []);
  return image;
}

export function AboutPage() {
  const { info, update, setUpdate } = useApp();
  const { push } = useToast();
  const heroImage = useAppBackground();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloadHighlight, setDownloadHighlight] = useState(false);
  const version = info?.version ?? "0.1.4";
  // 发布说明只展示前 3 行，避免长文档把首屏顶开。
  const updateNotes = (update?.notes ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  const open = async (url: string, label: string) => {
    try {
      await api.app.openExternal(url);
      push(`已用外部浏览器打开${label}`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const openDir = async (target: string | undefined, label: string) => {
    if (!target) return;
    try {
      await api.app.openPath(target);
      push(`已打开${label}`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await api.app.checkUpdates();
      setUpdate(result);
      if (result.error) push(`检查更新失败：${result.error}`, "error");
      else if (result.hasUpdate) push(`发现新版本 v${result.latest}`, "success");
      else if (result.latest) push(`已是最新版本 v${result.current}`, "success");
    } catch (error: unknown) {
      const message = errorMessage(error);
      setUpdate({ current: version, latest: null, hasUpdate: false, channel: "none", error: message });
      push(`检查更新失败：${message}`, "error");
    } finally {
      setChecking(false);
    }
  };

  // 一键更新：确认后下载免安装版包、替换自身并重启（真机由主进程完成，界面只轮询状态）。
  const install = async () => {
    const assetUrl = update?.assetUrl;
    if (!assetUrl) return;
    setConfirming(false);
    setInstalling(true);
    setDownloadHighlight(false);
    try {
      await api.app.installUpdate(assetUrl);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
      // 自动替换失败时把「前往下载」高亮，引导手动下载。
      setDownloadHighlight(true);
    } finally {
      setInstalling(false);
    }
  };

  const openChangelog = async () => {
    try {
      await api.app.openExternal(CHANGELOG_URL);
      push("完整更新日志见项目仓库的 CHANGELOG.md", "info");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  return (
    <section className="page about-page">
      <section
        className="about-hero"
        data-about-hero
        style={heroImage ? ({ "--about-hero-image": heroImage } as CSSProperties) : undefined}
      >
        <div className="about-hero-main">
          <img className="about-hero-logo" src={logo} alt="NaiWa Launcher" width={62} height={62} />
          <h1 className="about-hero-title">关于 NaiWa Launcher</h1>
          <p className="about-hero-sub">轻量、美观、开源的 Minecraft 启动器</p>
        </div>
        <div className="about-hero-side">
          <div className="about-version-row">
            <span className="about-version" data-about-version>v{version}</span>
            {update?.hasUpdate ? (
              <span className="about-new" data-about-new>有新版本 v{update.latest}</span>
            ) : null}
          </div>
          <div className="about-tags">
            <span className="about-tag">
              <IconZap size={13} />
              开源项目
            </span>
            <span className="about-tag">
              <IconUser size={13} />
              开发者 奶龙
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm about-check"
            data-about-check
            disabled={checking}
            onClick={() => void runCheck()}
          >
            <IconRefresh size={14} />
            {checking ? "检查中…" : "检查更新"}
          </button>
          {update?.error ? (
            <div className="about-update-error" data-about-update-error>
              <span>检查更新失败：{update.error}</span>
              <button type="button" className="link-btn" data-about-repo onClick={() => void open(RELEASES_URL, "项目仓库")}>
                <IconLink size={13} />
                打开仓库
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {update?.hasUpdate ? (
        <section className="about-update" data-about-update>
          <div className="about-update-head">
            <span className="about-update-title">发布说明 · v{update.latest}</span>
            <span className="about-update-meta">当前版本 v{update.current}</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-about-install
              disabled={installing || !update.assetUrl}
              title={update.assetUrl ? "下载新版本并替换当前程序，完成后自动重启" : "该版本未提供免安装版更新包"}
              onClick={() => setConfirming(true)}
            >
              <IconRefresh size={14} />
              {installing ? "正在更新…" : "立即更新"}
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${downloadHighlight ? " is-attention" : ""}`}
              data-about-download
              onClick={() => void open(update.url || RELEASES_URL, "下载页")}
            >
              <IconDownload size={14} />
              前往下载
            </button>
          </div>
          <ul className="about-update-notes">
            {updateNotes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {!update.assetUrl ? (
            <p className="about-update-hint" data-about-no-asset>
              该版本未提供免安装版更新包，请用「前往下载」手动安装。
            </p>
          ) : null}
          {installing ? (
            <p className="about-update-hint" data-about-installing>
              下载完成后启动器会自动重启
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="about-cards">
        {CAPABILITIES.map(({ Icon, title, desc }) => (
          <article className="about-card" data-about-card key={title}>
            <div className="about-card-head">
              <span className="about-card-icon">
                <Icon size={17} />
              </span>
              <strong className="about-card-title">{title}</strong>
            </div>
            <p className="about-card-desc">{desc}</p>
          </article>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">链接与致谢</h2>
          <span className="panel-count">{LINKS.length} 项</span>
        </div>
        <div className="about-link-list">
          {LINKS.map(({ Icon, label, hint, url }) => (
            <button
              type="button"
              className="about-link"
              data-about-link
              key={label}
              onClick={() => void open(url, label)}
            >
              <span className="about-link-icon">
                <Icon size={16} />
              </span>
              <span className="about-link-text">
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
              <IconChevronRight size={15} className="about-link-arrow" />
            </button>
          ))}
        </div>
        <div className="about-dirs" data-about-dirs>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-about-dir="root"
            title={info?.rootDir}
            disabled={!info}
            onClick={() => void openDir(info?.rootDir, "启动器目录")}
          >
            <IconFolder size={14} />
            打开启动器目录
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-about-dir="game"
            title={info?.gameRoot}
            disabled={!info}
            onClick={() => void openDir(info?.gameRoot, "游戏目录")}
          >
            <IconFolder size={14} />
            打开游戏目录
          </button>
        </div>
      </section>

      <div className="about-columns">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconBook size={15} className="about-title-icon" />
              更新日志
            </h2>
            <button type="button" className="btn btn-ghost btn-sm" data-about-changelog onClick={() => void openChangelog()}>
              查看完整
              <IconChevronRight size={14} />
            </button>
          </div>
          <ul className="about-log">
            {CHANGELOG.slice(0, 3).map((entry) => (
              <li className="about-log-item" key={entry.title}>
                <span className="about-log-dot" aria-hidden="true" />
                <div className="about-log-text">
                  <strong>{entry.title}</strong>
                  <p>{entry.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">核心团队</h2>
          </div>
          <ul className="about-team">
            {TEAM.map((member) => (
              <li className="about-member" data-about-member key={member.name}>
                <span className="about-avatar" aria-hidden="true">{member.initial}</span>
                <span className="about-member-text">
                  <strong>{member.name}</strong>
                  <small>{member.role}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="about-foot" data-about-foot>
        Designed with <span className="about-heart" aria-hidden="true">♥</span> by 奶龙 · NaiWa Launcher v{version}
      </p>

      <ConfirmDialog
        open={confirming}
        title="立即更新"
        message="将下载新版本并替换当前程序，完成后自动重启。确定现在更新吗？"
        confirmText="立即更新"
        busy={installing}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void install()}
      />
    </section>
  );
}
