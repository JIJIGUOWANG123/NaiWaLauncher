import { useEffect, useState } from "react";
import type { DownloadSourceId, Settings } from "../../shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { useSliderDraft } from "../lib/useSliderDraft";
import { errorMessage } from "../lib/useAsync";
import { Field, Select, Slider, TextInput } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { useToast } from "../components/Toast";
import { IconEye, IconEyeOff, IconFolder } from "../components/icons";

/** 文件下载源：游戏本体 / 资源 / 依赖库都用它，含两个社区镜像。 */
type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** 选项文案存 key，渲染时再翻：模块级常量在切换语言后不会自己更新。 */
type OptionKey<T extends string> = { value: T; labelKey: string; titleKey?: string };

function localize<T extends string>(
  options: Array<OptionKey<T>>,
  tr: Translator,
): Array<{ value: T; label: string; title?: string }> {
  return options.map(({ value, labelKey, titleKey }) => ({
    value,
    label: tr(labelKey),
    title: titleKey ? tr(titleKey) : undefined,
  }));
}

const FILE_SOURCE_OPTIONS: Array<OptionKey<DownloadSourceId>> = [
  { value: "official", labelKey: "pages.otherSettings.srcOfficial" },
  { value: "bmclapi", labelKey: "pages.otherSettings.srcBmclapi" },
  { value: "sjtu", labelKey: "pages.otherSettings.srcSjtu", titleKey: "pages.otherSettings.srcSjtuTitle" },
  { value: "auto", labelKey: "pages.otherSettings.srcAuto" },
];

/** 版本清单源只有官方/镜像/自动三种（VersionListSource 没有社区镜像）。 */
const VERSION_SOURCE_OPTIONS: Array<OptionKey<Settings["versionListSource"]>> = [
  { value: "official", labelKey: "pages.otherSettings.srcOfficial" },
  { value: "bmclapi", labelKey: "pages.otherSettings.srcBmclapi" },
  { value: "auto", labelKey: "pages.otherSettings.srcAuto" },
];

const COMMUNITY_SOURCE_OPTIONS: Array<OptionKey<DownloadSourceId>> = [
  { value: "official", labelKey: "pages.otherSettings.communityOfficial" },
  { value: "bmclapi", labelKey: "pages.otherSettings.communityMirror" },
  { value: "auto", labelKey: "pages.otherSettings.communityAuto" },
];

const DISPLAY_OPTIONS: Array<OptionKey<Settings["modDisplayStyle"]>> = [
  { value: "title", labelKey: "pages.otherSettings.displayTitle" },
  { value: "filename", labelKey: "pages.otherSettings.displayFilename" },
];

const SAMPLE = { name: "钠 · Sodium", slug: "sodium", version: "0.6.13", loader: "fabric", mc: "1.21.4" };
const SAMPLE_KEYS: Array<keyof typeof SAMPLE> = ["name", "slug", "version", "loader", "mc"];

/** 模板预览：与主进程落盘命名一致，末尾统一补 .jar。 */
function fileNamePreview(template: string): string {
  let out = template.trim() || "[{name}] {slug}-{version}";
  for (const key of SAMPLE_KEYS) out = out.split(`{${key}}`).join(SAMPLE[key]);
  return out.toLowerCase().endsWith(".jar") ? out : `${out}.jar`;
}

export function OtherSettingsPage() {
  const { settings, settingsError } = useApp();
  const tr = useT();

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">{tr("pages.otherSettings.pageTitle")}</h1>
        </header>
        <LoadingState label={tr("pages.otherSettings.loading")} />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("pages.otherSettings.pageTitle")}</h1>
          <p className="page-sub">{tr("pages.otherSettings.sub")}</p>
        </div>
      </header>

      {settingsError ? <ErrorState message={settingsError} /> : null}

      <div className="settings-grid">
        <DownloadCard settings={settings} />
        <CommunityCard settings={settings} />
        <AssistCard settings={settings} />
      </div>
    </section>
  );
}

function DownloadCard({ settings }: { settings: Settings }) {
  const { info } = useApp();
  const persist = usePersist();
  const { push } = useToast();
  const tr = useT();

  const [connections, setConnections] = useSliderDraft(settings.connectionsPerFile, (value) => {
    void persist({ connectionsPerFile: value }, tr("pages.otherSettings.persistConnections"));
  });
  const [threads, setThreads] = useSliderDraft(settings.concurrentDownloads, (value) => {
    void persist({ concurrentDownloads: value }, tr("pages.otherSettings.persistThreads"));
  });
  const [speed, setSpeed] = useSliderDraft(settings.speedLimitKbps, (value) => {
    void persist({ speedLimitKbps: value }, tr("pages.otherSettings.persistSpeed"));
  });

  const dataRoot = info ? `${info.rootDir.replace(/[\\/]+$/, "")}\\NaiWa` : "";

  const openPath = async (target: string, label: string) => {
    if (!target) return;
    try {
      await api.app.openPath(target);
      push(tr("pages.otherSettings.openedPath", { label, path: target }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  return (
    <div className="panel" data-card="download">
      <div className="panel-head">
        <h2 className="panel-title">{tr("pages.otherSettings.downloadTitle")}</h2>
        <span className="panel-count">{tr("pages.otherSettings.downloadCount")}</span>
      </div>

      <div className="form-grid">
        <Field
          label={tr("pages.otherSettings.fileSourceLabel")}
          hint={tr("pages.otherSettings.fileSourceHint")}
        >
          <Select
            value={settings.downloadSource}
            options={localize(FILE_SOURCE_OPTIONS, tr)}
            ariaLabel={tr("pages.otherSettings.fileSourceLabel")}
            onChange={(value) => void persist({ downloadSource: value as DownloadSourceId }, tr("pages.otherSettings.persistDownloadSource"))}
          />
        </Field>

        <Field label={tr("pages.otherSettings.versionSourceLabel")} hint={tr("pages.otherSettings.versionSourceHint")}>
          <Select
            value={settings.versionListSource}
            options={localize(VERSION_SOURCE_OPTIONS, tr)}
            ariaLabel={tr("pages.otherSettings.versionSourceLabel")}
            onChange={(value) => void persist({ versionListSource: value as Settings["versionListSource"] }, tr("pages.otherSettings.persistVersionSource"))}
          />
        </Field>

        <Field label={tr("pages.otherSettings.connectionsLabel")} hint={tr("pages.otherSettings.connectionsHint")}>
          <Slider
            value={connections}
            min={1}
            max={16}
            onChange={setConnections}
            format={(value) => tr("pages.otherSettings.connectionsFormat", { value })}
          />
        </Field>

        <Field label={tr("pages.otherSettings.threadsLabel")} hint={tr("pages.otherSettings.threadsHint")}>
          <Slider
            value={threads}
            min={1}
            max={32}
            onChange={setThreads}
            format={(value) => tr("pages.otherSettings.threadsFormat", { value })}
          />
        </Field>

        <p className="field-hint dl-parallel-note" data-dl-parallel-note>
          {tr("pages.otherSettings.parallelNote")}
        </p>

        <Field label={tr("pages.otherSettings.speedLabel")} hint={tr("pages.otherSettings.speedHint")}>
          <Slider
            value={speed}
            min={0}
            max={10240}
            step={64}
            onChange={setSpeed}
            format={(value) => (value === 0 ? tr("pages.otherSettings.unlimited") : `${value} KB/s`)}
          />
        </Field>
      </div>

      <div className="ext-paths">
        <div className="ext-path">
          <span className="ext-path-label">{tr("pages.otherSettings.gameAndMods")}</span>
          <span className="mono" title={info?.gameRoot}>{info?.gameRoot ?? tr("pages.otherSettings.readingPath")}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openPath(info?.gameRoot ?? "", tr("pages.otherSettings.gameDir"))}
            disabled={!info}
          >
            <IconFolder size={14} />
            {tr("pages.otherSettings.open")}
          </button>
        </div>
        <div className="ext-path">
          <span className="ext-path-label">{tr("pages.otherSettings.configAndJava")}</span>
          <span className="mono" title={dataRoot}>{dataRoot || tr("pages.otherSettings.readingPath")}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void openPath(dataRoot, tr("pages.otherSettings.dataDir"))}
            disabled={!info}
          >
            <IconFolder size={14} />
            {tr("pages.otherSettings.open")}
          </button>
        </div>
        <p className="ext-note">{tr("pages.otherSettings.pathsNote")}</p>
      </div>
    </div>
  );
}

function CommunityCard({ settings }: { settings: Settings }) {
  const persist = usePersist();
  const tr = useT();
  const [template, setTemplate] = useState(settings.modFileNameTemplate);

  useEffect(() => setTemplate(settings.modFileNameTemplate), [settings.modFileNameTemplate]);

  const preview = fileNamePreview(template);

  const commitTemplate = () => {
    const next = template.trim() || "[{name}] {slug}-{version}";
    if (next === settings.modFileNameTemplate) return;
    void persist({ modFileNameTemplate: next }, tr("pages.otherSettings.persistFileNameTemplate"));
  };

  return (
    <div className="panel" data-card="community">
      <div className="panel-head">
        <h2 className="panel-title">{tr("pages.otherSettings.communityTitle")}</h2>
        <span className="panel-count">{tr("pages.otherSettings.communityCount")}</span>
      </div>

      <div className="form-grid">
        <Field label={tr("pages.otherSettings.sourceLabel")} hint={tr("pages.otherSettings.sourceHint")}>
          <Select
            value={settings.downloadSource}
            options={localize(COMMUNITY_SOURCE_OPTIONS, tr)}
            ariaLabel={tr("pages.otherSettings.communitySourceAria")}
            onChange={(value) => void persist({ downloadSource: value as DownloadSourceId }, tr("pages.otherSettings.persistCommunitySource"))}
          />
        </Field>

        <Field label={tr("pages.otherSettings.fileNameTemplateLabel")} hint={tr("pages.otherSettings.fileNameTemplateHint")}>
          <TextInput
            value={template}
            aria-label={tr("pages.otherSettings.fileNameTemplateLabel")}
            placeholder="[{name}] {slug}-{version}"
            onChange={(event) => setTemplate(event.target.value)}
            onBlur={commitTemplate}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitTemplate();
            }}
            spellCheck={false}
          />
          <span className="template-preview" data-template-preview>
            {preview}
          </span>
        </Field>

        <Field label={tr("pages.otherSettings.modDisplayLabel")} hint={tr("pages.otherSettings.modDisplayHint")}>
          <Select
            value={settings.modDisplayStyle}
            options={localize(DISPLAY_OPTIONS, tr)}
            ariaLabel={tr("pages.otherSettings.modDisplayLabel")}
            onChange={(value) => void persist({ modDisplayStyle: value as Settings["modDisplayStyle"] }, tr("pages.otherSettings.persistModDisplay"))}
          />
        </Field>
      </div>
    </div>
  );
}

function AssistCard({ settings }: { settings: Settings }) {
  const persist = usePersist();
  const { push } = useToast();
  const tr = useT();
  const [keyDraft, setKeyDraft] = useState(settings.deeplApiKey);
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // 设置被别处改动（例如清空后回读）时同步草稿。
  useEffect(() => setKeyDraft(settings.deeplApiKey), [settings.deeplApiKey]);

  /** 写入 + 回读校验走 usePersist；清空时补一条「改回免费接口」的提示。 */
  const saveKey = async () => {
    const next = keyDraft.trim();
    setSavingKey(true);
    const ok = await persist({ deeplApiKey: next }, tr("pages.otherSettings.persistDeepLKey"));
    setSavingKey(false);
    if (ok && next === "") push(tr("pages.otherSettings.deeplCleared"), "success");
  };

  return (
    <div className="panel" data-card="assist">
      <div className="panel-head">
        <h2 className="panel-title">{tr("pages.otherSettings.assistTitle")}</h2>
        <span className="panel-count">{tr("pages.otherSettings.assistCount")}</span>
      </div>

      <div className="checkline-stack">
        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.notifyGameUpdates}
            onChange={(event) => void persist({ notifyGameUpdates: event.target.checked }, tr("pages.otherSettings.persistNotify"))}
          />
          {tr("pages.otherSettings.notifyLabel")}
        </label>
        <span className="field-hint">{tr("pages.otherSettings.notifyHint")}</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.showSnapshot}
            onChange={(event) => void persist({ showSnapshot: event.target.checked }, tr("pages.otherSettings.persistShowSnapshot"))}
          />
          {tr("pages.otherSettings.showSnapshotLabel")}
        </label>
        <span className="field-hint">{tr("pages.otherSettings.showSnapshotHint")}</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.forceChinese}
            onChange={(event) => void persist({ forceChinese: event.target.checked }, tr("pages.otherSettings.persistGameLanguage"))}
          />
          {tr("pages.otherSettings.forceChineseLabel")}
        </label>
        <span className="field-hint">{tr("pages.otherSettings.forceChineseHint")}</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.translateMods}
            onChange={(event) => void persist({ translateMods: event.target.checked }, tr("pages.otherSettings.persistTranslateMods"))}
          />
          {tr("pages.otherSettings.translateModsLabel")}
        </label>
        <span className="field-hint">{tr("pages.otherSettings.translateModsHint")}</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.translateSearch}
            onChange={(event) => void persist({ translateSearch: event.target.checked }, tr("pages.otherSettings.persistChineseSearch"))}
          />
          {tr("pages.otherSettings.chineseSearchLabel")}
        </label>
        <span className="field-hint">{tr("pages.otherSettings.chineseSearchHint")}</span>

        <Field
          label="DeepL API Key"
          hint={tr("pages.otherSettings.deeplHint")}
        >
          <div className="key-row">
            <TextInput
              type={showKey ? "text" : "password"}
              value={keyDraft}
              aria-label="DeepL API Key"
              placeholder={tr("pages.otherSettings.deeplPlaceholder")}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveKey();
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setShowKey((value) => !value)}
              aria-label={showKey ? tr("pages.otherSettings.hideKey") : tr("pages.otherSettings.showKey")}
              data-action="toggle-deepl-key"
            >
              {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveKey()}
              disabled={savingKey}
              data-action="save-deepl-key"
            >
              {savingKey ? tr("pages.common.saving") : tr("pages.common.save")}
            </button>
          </div>
        </Field>
      </div>
    </div>
  );
}
