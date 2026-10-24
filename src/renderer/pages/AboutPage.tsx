import { useEffect, useState, type CSSProperties } from "react";
import logo from "../assets/logo.png";
import avatarNailong from "../assets/team/nailong.png";
import avatarXiaoqi from "../assets/team/xiaoqi.png";
import avatarDeepseek from "../assets/team/deepseek.png";
import avatarSakura from "../assets/team/sakura.png";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useT } from "../lib/i18n";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import {
  IconAlert,
  IconBook,
  IconChevronRight,
  IconGithub,
  IconDownload,
  IconFolder,
  IconImage,
  IconInstances,
  IconJava,
  IconLink,
  IconMessage,
  IconMods,
  IconPackage,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconSliders,
  IconUser,
  IconWifi,
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
/** 联机能力来源：联机页的内网穿透用樱花穿透，联机模组用陶瓦联机。 */
const SAKURA_FRP_URL = "https://www.natfrp.com/";
const TERRACOTTA_URL = "https://github.com/burningtnt/Terracotta";
/** 工具提供方走官网（比仓库说明更能说明它是什么）。 */
const DEEPSEEK_URL = "https://www.deepseek.com/";

/** 能力卡：capKey 同时作为自检用的 data-about-capability 属性。 */
const CAPABILITIES = [
  { capKey: "fabric", Icon: IconPackage, titleKey: "about.capability.fabric", descKey: "about.capability.fabricDesc" },
  { capKey: "mods", Icon: IconMods, titleKey: "about.capability.mods", descKey: "about.capability.modsDesc" },
  { capKey: "instances", Icon: IconInstances, titleKey: "about.capability.instances", descKey: "about.capability.instancesDesc" },
  { capKey: "search", Icon: IconSearch, titleKey: "about.capability.search", descKey: "about.capability.searchDesc" },
  { capKey: "java", Icon: IconJava, titleKey: "about.capability.java", descKey: "about.capability.javaDesc" },
  { capKey: "download", Icon: IconDownload, titleKey: "about.capability.download", descKey: "about.capability.downloadDesc" },
  // 0.3.4–0.3.9 新增能力，文案在 lib/i18n-extra.ts 的 pages.about.capability.*
  { capKey: "net", Icon: IconWifi, titleKey: "pages.about.capability.net", descKey: "pages.about.capability.netDesc" },
  { capKey: "background", Icon: IconImage, titleKey: "pages.about.capability.background", descKey: "pages.about.capability.backgroundDesc" },
  { capKey: "javaSources", Icon: IconSliders, titleKey: "pages.about.capability.javaSources", descKey: "pages.about.capability.javaSourcesDesc" },
  { capKey: "github", Icon: IconGithub, titleKey: "pages.about.capability.github", descKey: "pages.about.capability.githubDesc" },
  { capKey: "diagnose", Icon: IconAlert, titleKey: "pages.about.capability.diagnose", descKey: "pages.about.capability.diagnoseDesc" },
  { capKey: "languages", Icon: IconBook, titleKey: "pages.about.capability.languages", descKey: "pages.about.capability.languagesDesc" },
  { capKey: "updateMode", Icon: IconRefresh, titleKey: "pages.about.capability.updateMode", descKey: "pages.about.capability.updateModeDesc" },
];

const LINKS = [
  { Icon: IconLink, labelKey: "about.link.project", hintKey: "", url: PROJECT_URL },
  { Icon: IconMessage, labelKey: "about.link.feedback", hintKey: "about.link.feedbackHint", url: FEEDBACK_URL },
  { Icon: IconUser, labelKey: "about.link.qq", hintKey: "about.link.qqHint", url: QQ_GROUP_URL },
  { Icon: IconPackage, labelKey: "about.link.modrinth", hintKey: "", url: "https://modrinth.com/" },
  { Icon: IconMods, labelKey: "about.link.curseforge", hintKey: "", url: "https://www.curseforge.com/minecraft" },
  { Icon: IconZap, labelKey: "about.link.mirror", hintKey: "about.link.mirrorHint", url: "https://bmclapi2.bangbang93.com/" },
  { Icon: IconRocket, labelKey: "about.link.steam302", hintKey: "about.link.steam302Hint", url: RECOMMEND_URL },
];



type TeamEntry = {
  /** 显示名；项目卡走 nameKey 翻译，人名保持原样。 */
  name: string;
  nameKey?: string;
  roleKey: string;
  /** 没有头像时用首字色块或图标占位。 */
  initial: string;
  avatar?: string;
  Icon?: typeof IconLink;
  url: string;
  kind?: "person" | "project";
  license?: string;
};

/** 团队头像一律用本地 png；项目卡用组件库里已有的图标，不引新依赖。 */
const TEAM: TeamEntry[] = [
  { name: "奶龙", roleKey: "about.role.main", initial: "奶", avatar: avatarNailong, url: PROJECT_URL },
  { name: "小七", roleKey: "about.role.co", initial: "七", avatar: avatarXiaoqi, url: PROJECT_URL },
  { name: "DeepSeek", roleKey: "about.role.tools", initial: "D", avatar: avatarDeepseek, url: DEEPSEEK_URL },
  {
    name: "樱花穿透",
    nameKey: "pages.about.team.sakura",
    roleKey: "pages.about.role.net",
    initial: "樱",
    // 樱花穿透的官方头像（由 https://a.favicon.im/openid.13a.com 的 ico 转成 png 后随包分发，离线也能显示）
    avatar: avatarSakura,
    url: SAKURA_FRP_URL,
    kind: "project",
  },
  {
    name: "陶瓦联机",
    nameKey: "pages.about.team.terracotta",
    roleKey: "pages.about.role.net",
    initial: "陶",
    // 陶瓦联机没有官方应用图标，按需求直接用 GitHub 标志（它的项目与发布都在 GitHub 上）
    Icon: IconGithub,
    url: TERRACOTTA_URL,
    kind: "project",
    license: "AGPL-3.0-or-later",
  },
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
  const tr = useT();
  const { info, settings, update, setUpdate } = useApp();
  const { push } = useToast();
  const heroImage = useAppBackground();
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloadHighlight, setDownloadHighlight] = useState(false);
  const version = info?.version ?? "0.1.5";
  // 只显示「当前发行版本」的更新内容：历史版本去仓库的 CHANGELOG.md 看，避免程序里的日志越滚越长
  const changelog = useAsync(() => api.app.changelog(1), []);
  // 发布说明只展示前 3 行，避免长文档把首屏顶开。
  const updateNotes = (update?.notes ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  const open = async (url: string, label: string) => {
    try {
      await api.app.openExternal(url);
      push(tr("about.openedExternal", { label }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const openDir = async (target: string | undefined, label: string) => {
    if (!target) return;
    try {
      await api.app.openPath(target);
      push(tr("about.openedDir", { label }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      const result = await api.app.checkUpdates();
      setUpdate(result);
      if (result.error) push(tr("about.checkFailed", { error: result.error }), "error");
      else if (result.hasUpdate) push(tr("about.foundUpdate", { version: result.latest ?? "" }), "success");
      else if (result.latest) push(tr("about.upToDate", { version: result.current }), "success");
    } catch (error: unknown) {
      const message = errorMessage(error);
      setUpdate({ current: version, latest: null, hasUpdate: false, channel: "none", error: message });
      push(tr("about.checkFailed", { error: message }), "error");
    } finally {
      setChecking(false);
    }
  };

  // 「立即更新」的发起地址：真实资产地址，或资产清单未知时的固定名兜底地址
  const installUrl = update?.assetUrl || update?.setupUrl;
  // 资产清单未知（走的是镜像通道）：URL 是固定名兜底，界面要如实说明
  const assetsUnknown = Boolean(update?.assetsUnknown);

  // 一键更新：免安装版替换自身；安装版下载 Setup 静默装回当前目录后重启（主进程自行判断）
  const install = async () => {
    if (!installUrl) return;
    setConfirming(false);
    setInstalling(true);
    setDownloadHighlight(false);
    try {
      await api.app.installUpdate(installUrl);
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
      push(tr("about.changelogToast"), "info");
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
          <h1 className="about-hero-title">{tr("about.title")}</h1>
          <p className="about-hero-sub">{tr("about.subtitle")}</p>
        </div>
        <div className="about-hero-side">
          <div className="about-version-row">
            <span className="about-version" data-about-version>v{version}</span>
            {update?.hasUpdate ? (
              <span className="about-new" data-about-new>{tr("about.newVersion", { version: update.latest ?? "" })}</span>
            ) : null}
          </div>
          <div className="about-tags">
            <span className="about-tag">
              <IconZap size={13} />
              {tr("about.openSource")}
            </span>
            <span className="about-tag">
              <IconUser size={13} />
              {tr("about.developer")}
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
            {checking ? tr("about.checking") : tr("about.checkUpdate")}
          </button>
          {update?.error ? (
            <div className="about-update-error" data-about-update-error>
              <span>{tr("about.checkFailed", { error: update.error })}</span>
              <button type="button" className="link-btn" data-about-repo onClick={() => void open(RELEASES_URL, tr("about.link.project"))}>
                <IconLink size={13} />
                {tr("about.openRepo")}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {update?.hasUpdate ? (
        <section className="about-update" data-about-update>
          <div className="about-update-head">
            <span className="about-update-title">{tr("about.releaseNotes", { version: update.latest ?? "" })}</span>
            <span className="about-update-meta">{tr("about.currentVersion", { version: update.current })}</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              data-about-install
              disabled={installing || !installUrl}
              title={
                installUrl
                  ? assetsUnknown
                    ? tr("about.assetsUnknownTitle")
                    : tr("about.installNote")
                  : tr("about.noPackage")
              }
              onClick={() => setConfirming(true)}
            >
              <IconRefresh size={14} />
              {installing ? tr("about.updating") : tr("about.updateNow")}
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${downloadHighlight ? " is-attention" : ""}`}
              data-about-download
              onClick={() => void open(update.url || RELEASES_URL, tr("about.goDownload"))}
            >
              <IconDownload size={14} />
              {tr("about.goDownload")}
            </button>
          </div>
          <ul className="about-update-notes">
            {updateNotes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {!installUrl ? (
            <p className="about-update-hint" data-about-no-asset>
              {tr("about.manualInstall")}
            </p>
          ) : assetsUnknown ? (
            <p className="about-update-hint" data-about-asset-unknown>
              {tr("about.assetsUnknownHint", { version: update.latest ?? "" })}
            </p>
          ) : null}
          {installing ? (
            <p className="about-update-hint" data-about-installing>
              {tr("about.restartHint")}
            </p>
          ) : settings?.updateMode === "auto" ? (
            // auto：启动检查后主进程已经在后台自己下载安装了，这里如实说明，别再让用户以为要自己点
            <p className="about-update-hint" data-about-auto-update>
              {tr("upd.autoHint")}
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="about-cards">
        {CAPABILITIES.map(({ capKey, Icon, titleKey, descKey }) => {
          const title = tr(titleKey);
          return (
          <article className="about-card" data-about-card data-about-capability={capKey} key={titleKey}>
            <div className="about-card-head">
              <span className="about-card-icon">
                <Icon size={17} />
              </span>
              <strong className="about-card-title">{title}</strong>
            </div>
            <p className="about-card-desc">{tr(descKey)}</p>
          </article>
          );
        })}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{tr("about.linksTitle")}</h2>
          <span className="panel-count">{tr("about.linksCount", { count: LINKS.length })}</span>
        </div>
        <div className="about-link-list">
          {LINKS.map(({ Icon, labelKey, hintKey, url }) => {
            const label = tr(labelKey);
            return (
            <button
              type="button"
              className="about-link"
              data-about-link
              key={labelKey}
              onClick={() => void open(url, label)}
            >
              <span className="about-link-icon">
                <Icon size={16} />
              </span>
              <span className="about-link-text">
                <strong>{label}</strong>
                {hintKey ? <small>{tr(hintKey, { number: QQ_GROUP_NO })}</small> : null}
              </span>
              <IconChevronRight size={15} className="about-link-arrow" />
            </button>
            );
          })}
        </div>
        <div className="about-dirs" data-about-dirs>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-about-dir="root"
            title={info?.rootDir}
            disabled={!info}
            onClick={() => void openDir(info?.rootDir, tr("about.openLauncherDir"))}
          >
            <IconFolder size={14} />
            {tr("about.openLauncherDir")}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-about-dir="game"
            title={info?.gameRoot}
            disabled={!info}
            onClick={() => void openDir(info?.gameRoot, tr("about.openGameDir"))}
          >
            <IconFolder size={14} />
            {tr("about.openGameDir")}
          </button>
        </div>
      </section>

      <div className="about-columns">
        {/* 核心团队在上、更新日志在下（原来是左右并排） */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("about.teamTitle")}</h2>
            <span className="panel-count">{tr("pages.about.teamHint")}</span>
          </div>
          <ul className="about-team" data-about-team>
            {TEAM.map((member) => {
              const Icon = member.Icon;
              const label = member.nameKey ? tr(member.nameKey) : member.name;
              const role = tr(member.roleKey);
              const openLabel = tr("pages.about.teamOpen", { label, role });
              return (
                <li className="about-team-cell" key={member.name}>
                  <button
                    type="button"
                    className="about-member"
                    data-about-member
                    data-about-member-kind={member.kind ?? "person"}
                    data-about-url={member.url}
                    title={openLabel}
                    aria-label={openLabel}
                    onClick={() => void open(member.url, label)}
                  >
                    <span className="about-avatar" aria-hidden="true">
                      {member.avatar ? (
                        <img src={member.avatar} alt="" loading="lazy" />
                      ) : Icon ? (
                        <Icon size={member.kind === "project" ? 22 : 17} />
                      ) : (
                        member.initial
                      )}
                    </span>
                    <span className="about-member-text">
                      <strong>{label}</strong>
                      <small>{role}</small>
                      {member.license ? <small className="about-member-license">{member.license}</small> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <IconBook size={15} className="about-title-icon" />
              {tr("about.changelogTitle")}
            </h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-about-changelog
              title={tr("about.changelogHistoryTitle")}
              onClick={() => void openChangelog()}
            >
              {tr("about.changelogHistory")}
              <IconChevronRight size={14} />
            </button>
          </div>
          {changelog.loading && !changelog.data ? <p className="field-hint">{tr("about.changelogLoading")}</p> : null}
          {changelog.error ? (
            <p className="field-hint">{tr("about.changelogFailed", { error: errorMessage(changelog.error) })}</p>
          ) : null}
          {changelog.data && changelog.data.length === 0 ? (
            <p className="field-hint">{tr("about.changelogMissing")}</p>
          ) : null}
          <p className="field-hint" data-changelog-scope>
            {tr("about.changelogScope")}
          </p>
          {(changelog.data ?? []).map((section: { version: string; lines: string[] }, index: number) => (
            <div className="about-log-version" key={section.version} data-changelog-version={section.version}>
              <p className="about-log-version-head">
                <strong>{section.version === "最新" ? section.version : "v" + section.version}</strong>
                {index === 0 ? <span className="badge about-log-latest">{tr("about.changelogLatest")}</span> : null}
              </p>
              <ul className="about-log">
                {section.lines
                  .filter((line: string) => !(line.startsWith("〔") && line.endsWith("〕")))
                  .slice(0, 6)
                  .map((line: string, lineIndex: number) => (
                    <li className="about-log-item" key={section.version + "-" + lineIndex}>
                      <span className="about-log-dot" aria-hidden="true" />
                      <div className="about-log-text">
                        <p>{line}</p>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>

      </div>

      <p className="about-foot" data-about-foot>
        {tr("about.footer", { version })}
      </p>

      <ConfirmDialog
        open={confirming}
        title={tr("about.confirmTitle")}
        message={tr("about.confirmMessage")}
        confirmText={tr("about.confirmTitle")}
        busy={installing}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void install()}
      />
    </section>
  );
}
