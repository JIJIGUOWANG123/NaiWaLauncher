import { useEffect, useMemo, useState } from "react";
import type { DownloadSourceId, ModProviderId, Settings, SourceProbe } from "../../shared/types";
import { api } from "../lib/api";
import { formatLatency } from "../lib/format";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, Segmented, TextInput, Toggle } from "../components/Form";
import { LANGUAGES, translate, useT, type Lang } from "../lib/i18n";
import { ErrorState, LoadingState } from "../components/State";
import { IconEye, IconEyeOff, IconFolder, IconInfo, IconZap } from "../components/icons";

/** 关闭窗口的三种行为：ask 会弹窗询问并记住，tray/quit 直接按选择走。 */
const CLOSE_ACTIONS: Array<{ value: Settings["closeAction"]; labelKey: string }> = [
  { value: "ask", labelKey: "settings.close.ask" },
  { value: "tray", labelKey: "settings.close.tray" },
  { value: "quit", labelKey: "settings.close.quit" },
];

/** 更新方式（都由主进程在启动后查一次）：manual 只提示，用户点「立即更新」才装；auto 查到就自动下载安装。 */
const UPDATE_MODES: Array<{ value: Settings["updateMode"]; labelKey: string }> = [
  { value: "manual", labelKey: "settings.update.manual" },
  { value: "auto", labelKey: "settings.update.auto" },
];

const MOD_PROVIDERS: Array<{ value: ModProviderId; labelKey: string }> = [
  { value: "modrinth", labelKey: "settings.provider.modrinth" },
  { value: "curseforge", labelKey: "settings.provider.curseforge" },
  { value: "minekuai", labelKey: "settings.provider.zh" },
];

export function SettingsPage() {
  const { settings, saveSettings, applySettings, settingsError, navigate, info } = useApp();
  const tr = useT();
  // 选项常量里存的是 i18n key，渲染前按当前语言翻成 label
  const modProviders = MOD_PROVIDERS.map((item) => ({ value: item.value, label: tr(item.labelKey) }));
  const closeActions = CLOSE_ACTIONS.map((item) => ({ value: item.value, label: tr(item.labelKey) }));
  const updateModes = UPDATE_MODES.map((item) => ({ value: item.value, label: tr(item.labelKey) }));

  /** 界面语言：立即写设置并回读，当前页面马上按新语言重渲染。 */
  const changeLanguage = async (next: Lang) => {
    if (next === settings?.language) return;
    try {
      await saveSettings({ language: next });
      push(translate(next, "settings.languageToast"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };
  const { push } = useToast();
  const sources = useAsync(() => api.sources.list(), []);
  const [probes, setProbes] = useState<SourceProbe[] | null>(null);
  const [probing, setProbing] = useState(false);
  const persist = usePersist();
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);

  const [wallpaperDraft, setWallpaperDraft] = useState("");
  const [savingWallpaper, setSavingWallpaper] = useState(false);

  useEffect(() => {
    if (settings) setWallpaperDraft(settings.wallpaperEngineDir);
  }, [settings?.wallpaperEngineDir]);

  /** 打开本地目录（原关于页的两颗按钮搬到这里）：路径来自 AppInfo，接口仍是 api.app.openPath。 */
  const openDir = async (target: string | undefined, label: string) => {
    if (!target) return;
    try {
      await api.app.openPath(target);
      push(tr("about.openedDir", { label }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const saveWallpaperDir = async () => {
    const next = wallpaperDraft.trim();
    if (next === settings?.wallpaperEngineDir) return;
    setSavingWallpaper(true);
    try {
      await saveSettings({ wallpaperEngineDir: next });
      push(next ? tr("settings.wpDirSaved") : tr("settings.wpDirAuto"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setSavingWallpaper(false);
    }
  };

  useEffect(() => {
    if (settings) setKeyDraft(settings.curseforgeApiKey);
  }, [settings?.curseforgeApiKey]);

  useEffect(() => {
    if (settings) setThresholdDraft(String(settings.autoSwitchThresholdMs));
  }, [settings?.autoSwitchThresholdMs]);

  const probeMap = useMemo(() => {
    const map = new Map<DownloadSourceId, SourceProbe>();
    (probes ?? []).forEach((probe) => map.set(probe.sourceId, probe));
    return map;
  }, [probes]);

  const runProbe = async () => {
    setProbing(true);
    try {
      const result = await api.sources.probe();
      setProbes(result);
      push(tr("settings.speedDone"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setProbing(false);
    }
  };

  const selectSource = async (id: DownloadSourceId) => {
    try {
      const next = await api.sources.set(id);
      applySettings(next);
      push(tr("settings.sourceSwitched"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const saveKey = async () => {
    setSavingKey(true);
    await saveSettings({ curseforgeApiKey: keyDraft.trim() });
    setSavingKey(false);
    push(keyDraft.trim() ? tr("settings.apiKeySaved") : tr("settings.apiKeyCleared"), "success");
  };

  const saveThreshold = async () => {
    const parsed = Number(thresholdDraft);
    if (!Number.isFinite(parsed) || thresholdDraft.trim() === "") {
      push(tr("settings.thresholdInvalid"), "error");
      return;
    }
    const clamped = Math.min(10000, Math.max(200, Math.round(parsed)));
    if (clamped !== parsed) push(tr("settings.thresholdClamped", { value: clamped }), "info");
    setThresholdDraft(String(clamped));
    setSavingThreshold(true);
    await persist({ autoSwitchThresholdMs: clamped }, tr("settings.threshold"));
    setSavingThreshold(false);
  };

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">{tr("settings.title")}</h1>
        </header>
        <LoadingState label={tr("settings.loading")} />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("settings.title")}</h1>
          <p className="page-sub">{tr("settings.subtitle")}</p>
        </div>
        {settingsError ? <span className="inline-error">{settingsError}</span> : null}
      </header>

      <div className="settings-grid">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.language")}</h2>
            <span className="panel-count">{tr("settings.languageHint")}</span>
          </div>
          <div className="form-grid">
            <Field label={tr("settings.language")} hint={tr("settings.languageHint")}>
              {/* data-language 带上当前值，便于自检 */}
              <div data-language={settings.language}>
                <Segmented
                  value={settings.language}
                  options={LANGUAGES.map((item) => ({ value: item.value, label: item.label }))}
                  onChange={(value) => void changeLanguage(value as Lang)}
                />
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.group.sources")}</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runProbe()} disabled={probing}>
              <IconZap size={15} />
              {probing ? tr("common.speedTesting") : tr("common.speedTest")}
            </button>
          </div>

          {sources.loading ? <LoadingState label={tr("settings.readingSources")} /> : null}
          {sources.error ? <ErrorState message={sources.error} onRetry={sources.reload} /> : null}

          <div className="source-list">
            {(sources.data ?? []).map((source) => {
              const active = settings.downloadSource === source.id;
              const probe = probeMap.get(source.id);
              return (
                <button
                  key={source.id}
                  type="button"
                  className={`source-card ${active ? "active" : ""}`}
                  onClick={() => void selectSource(source.id)}
                >
                  <span className={`radio-dot ${active ? "on" : ""}`} aria-hidden="true" />
                  <span className="source-text">
                    <span className="source-name">{source.name}</span>
                    <span className="source-desc">{source.description}</span>
                  </span>
                  {source.selectable ? (
                    <span className={`latency ${probe ? (probe.ok ? "ok" : "bad") : ""}`}>
                      {probe ? formatLatency(probe.latencyMs, probe.ok, tr) : tr("common.notTested")}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.group.versions")}</h2>
            <span className="panel-count">{tr("settings.recheckedAfterSave")}</span>
          </div>
          <div className="form-grid">
            <Toggle
              label={tr("settings.showSnapshot")}
              hint={tr("settings.showSnapshotHint")}
              checked={settings.showSnapshot}
              onChange={(value) => void persist({ showSnapshot: value }, tr("settings.showSnapshot"))}
            />
            <Field label={tr("settings.threshold")} hint={tr("settings.thresholdHint")}>
              <div className="key-row">
                <TextInput
                  type="number"
                  min={200}
                  max={10000}
                  step={100}
                  value={thresholdDraft}
                  onChange={(event) => setThresholdDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveThreshold();
                  }}
                />
                <button type="button" className="btn btn-primary" onClick={() => void saveThreshold()} disabled={savingThreshold}>
                  {savingThreshold ? tr("common.saving") : tr("common.save")}
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.updateMode")}</h2>
          </div>
          <div className="form-grid">
            <Field label={tr("settings.updateMode")} hint={tr("settings.updateModeHint")}>
              {/* data-update-mode 带上当前值，便于自检 */}
              <div data-update-mode={settings.updateMode}>
                <Segmented
                  value={settings.updateMode}
                  options={updateModes}
                  onChange={(value) => void saveSettings({ updateMode: value })}
                />
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">CurseForge</h2>
            <span className="panel-count">{tr("settings.needsApiKey")}</span>
          </div>
          <div className="form-grid">
            <Field label="API Key" hint={tr("settings.apiKeyHint")}>
              <div className="key-row">
                <TextInput
                  type={showKey ? "text" : "password"}
                  value={keyDraft}
                  placeholder={tr("settings.apiKeyPlaceholder")}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={showKey ? tr("settings.hideKey") : tr("settings.showKey")}
                >
                  {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void saveKey()} disabled={savingKey}>
                  {savingKey ? tr("common.saving") : tr("common.save")}
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.group.modsJava")}</h2>
          </div>
          <div className="form-grid">
            <Field label={tr("settings.modSource")}>
              <Segmented
                value={settings.modProvider}
                options={modProviders}
                onChange={(value) => void saveSettings({ modProvider: value })}
              />
            </Field>
            <Toggle
              label={tr("settings.autoJava")}
              hint={tr("settings.autoJavaHint")}
              checked={settings.javaAutoDownload}
              onChange={(value) => void saveSettings({ javaAutoDownload: value })}
            />
            <Toggle
              label={tr("settings.autoMatchJava")}
              hint={tr("settings.autoMatchJavaHint")}
              checked={settings.javaAutoMatch}
              onChange={(value) => void persist({ javaAutoMatch: value }, tr("settings.autoMatchJava"))}
            />
            <Toggle
              label={tr("settings.closeToTray")}
              hint={tr("settings.closeToTrayHint")}
              checked={settings.closeToTray}
              onChange={(value) => void saveSettings({ closeToTray: value })}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.group.windowWallpaper")}</h2>
          </div>
          <div className="form-grid">
            <Field
              label={tr("settings.onClose")}
              hint={tr("settings.onCloseHint")}
            >
              {/* data-close-action 带上当前值，便于自检 */}
              <div data-close-action={settings.closeAction}>
                <Segmented
                  value={settings.closeAction}
                  options={closeActions}
                  onChange={(value) => void saveSettings({ closeAction: value })}
                />
              </div>
            </Field>

            <Field
              label={tr("settings.wpDir")}
              hint={tr("settings.wpDirHint")}
            >
              <div className="key-row">
                <TextInput
                  value={wallpaperDraft}
                  placeholder={tr("settings.wpDirPlaceholder")}
                  aria-label={tr("settings.wpDir")}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setWallpaperDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveWallpaperDir();
                  }}
                  onBlur={() => void saveWallpaperDir()}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  data-save-wallpaper-dir
                  onClick={() => void saveWallpaperDir()}
                  disabled={savingWallpaper}
                >
                  {savingWallpaper ? tr("common.saving") : tr("common.save")}
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{tr("pages.settings.dirs")}</h2>
            <span className="panel-count">{tr("pages.settings.dirsHint")}</span>
          </div>
          <div className="dir-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-settings-dir="launcher"
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
              data-settings-dir="game"
              title={info?.gameRoot}
              disabled={!info}
              onClick={() => void openDir(info?.gameRoot, tr("about.openGameDir"))}
            >
              <IconFolder size={14} />
              {tr("about.openGameDir")}
            </button>
          </div>
        </div>

        <div className="panel panel-about">
          <div className="panel-head">
            <h2 className="panel-title">{tr("settings.group.about")}</h2>
          </div>
          <p className="about-note">
            {tr("settings.aboutNote")}
          </p>
          <button type="button" className="btn btn-ghost about-entry" data-open-about onClick={() => navigate("about")}>
            <IconInfo size={15} />
            {tr("settings.openAbout")}
          </button>
        </div>
      </div>
    </section>
  );
}