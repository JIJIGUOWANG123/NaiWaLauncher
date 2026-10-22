import { useEffect, useState } from "react";
import type { DownloadSourceId, Settings } from "../../shared/types";
import { api } from "../lib/api";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { useSliderDraft } from "../lib/useSliderDraft";
import { errorMessage } from "../lib/useAsync";
import { Field, Select, Slider, TextInput } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { useToast } from "../components/Toast";
import { IconEye, IconEyeOff, IconFolder } from "../components/icons";

/** 文件下载源：游戏本体 / 资源 / 依赖库都用它，含两个社区镜像。 */
const FILE_SOURCE_OPTIONS = [
  { value: "official", label: "官方源（Mojang）" },
  { value: "bmclapi", label: "BMCLAPI 镜像" },
  { value: "sjtu", label: "上海交大镜像（仅依赖库）", title: "mirror.sjtu.edu.cn：只镜像 libraries，本体与资源仍走主源" },
  { value: "auto", label: "自动测速" },
];

/** 版本清单源只有官方/镜像/自动三种（VersionListSource 没有社区镜像）。 */
const VERSION_SOURCE_OPTIONS = [
  { value: "official", label: "官方源（Mojang）" },
  { value: "bmclapi", label: "BMCLAPI 镜像" },
  { value: "auto", label: "自动测速" },
];

const COMMUNITY_SOURCE_OPTIONS = [
  { value: "official", label: "尽量使用官方源" },
  { value: "bmclapi", label: "优先镜像" },
  { value: "auto", label: "自动测速（跟随下载源）" },
];

const DISPLAY_OPTIONS = [
  { value: "title", label: "标题显示译名，详情显示文件名" },
  { value: "filename", label: "直接显示文件名" },
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

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">其它</h1>
        </header>
        <LoadingState label="读取其它设置…" />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">其它</h1>
          <p className="page-sub">仿 PCL2 的其它设置：下载、社区资源与辅助功能</p>
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

  const [connections, setConnections] = useSliderDraft(settings.connectionsPerFile, (value) => {
    void persist({ connectionsPerFile: value }, "单文件分片连接数");
  });
  const [threads, setThreads] = useSliderDraft(settings.concurrentDownloads, (value) => {
    void persist({ concurrentDownloads: value }, "多线程下载（文件并发数）");
  });
  const [speed, setSpeed] = useSliderDraft(settings.speedLimitKbps, (value) => {
    void persist({ speedLimitKbps: value }, "速度限制");
  });

  const dataRoot = info ? `${info.rootDir.replace(/[\\/]+$/, "")}\\NaiWa` : "";

  const openPath = async (target: string, label: string) => {
    if (!target) return;
    try {
      await api.app.openPath(target);
      push(`已打开${label}：${target}`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  return (
    <div className="panel" data-card="download">
      <div className="panel-head">
        <h2 className="panel-title">下载</h2>
        <span className="panel-count">与设置页共用同一批字段</span>
      </div>

      <div className="form-grid">
        <Field
          label="文件下载源"
          hint="游戏本体、资源与依赖库走这里；与「设置 → 下载源」是同一个字段。上海交大仅镜像依赖库，本体与资源仍走主源"
        >
          <Select
            value={settings.downloadSource}
            options={FILE_SOURCE_OPTIONS}
            ariaLabel="文件下载源"
            onChange={(value) => void persist({ downloadSource: value as DownloadSourceId }, "下载源")}
          />
        </Field>

        <Field label="版本列表源" hint="版本清单可以单独指定来源，官方源不稳时切镜像">
          <Select
            value={settings.versionListSource}
            options={VERSION_SOURCE_OPTIONS}
            ariaLabel="版本列表源"
            onChange={(value) => void persist({ versionListSource: value as Settings["versionListSource"] }, "版本列表源")}
          />
        </Field>

        <Field label="单文件分片连接数" hint="一个大文件用几条连接并行拉（1–16，默认 4）">
          <Slider
            value={connections}
            min={1}
            max={16}
            onChange={setConnections}
            format={(value) => `${value} 条`}
          />
        </Field>

        <Field label="多线程下载（文件并发数）" hint="多个文件同时下载（1–32，默认 12），安装整合包/资源时提速明显">
          <Slider
            value={threads}
            min={1}
            max={32}
            onChange={setThreads}
            format={(value) => `${value} 个`}
          />
        </Field>

        <p className="field-hint dl-parallel-note" data-dl-parallel-note>
          文件并发数 × 单文件分片数 = 理论最大连接数，过高可能被 CDN 限速
        </p>

        <Field label="速度限制" hint="0 表示不限速，改动即时生效">
          <Slider
            value={speed}
            min={0}
            max={10240}
            step={64}
            onChange={setSpeed}
            format={(value) => (value === 0 ? "不限速" : `${value} KB/s`)}
          />
        </Field>
      </div>

      <div className="ext-paths">
        <div className="ext-path">
          <span className="ext-path-label">游戏与模组</span>
          <span className="mono" title={info?.gameRoot}>{info?.gameRoot ?? "读取中…"}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openPath(info?.gameRoot ?? "", "游戏目录")} disabled={!info}>
            <IconFolder size={14} />
            打开
          </button>
        </div>
        <div className="ext-path">
          <span className="ext-path-label">配置与 Java</span>
          <span className="mono" title={dataRoot}>{dataRoot || "读取中…"}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openPath(dataRoot, "数据目录")} disabled={!info}>
            <IconFolder size={14} />
            打开
          </button>
        </div>
        <p className="ext-note">
          游戏与模组在 &lt;gameRoot&gt;，配置、日志、缓存与 Java 在 &lt;root&gt;/NaiWa。
        </p>
      </div>
    </div>
  );
}

function CommunityCard({ settings }: { settings: Settings }) {
  const persist = usePersist();
  const [template, setTemplate] = useState(settings.modFileNameTemplate);

  useEffect(() => setTemplate(settings.modFileNameTemplate), [settings.modFileNameTemplate]);

  const preview = fileNamePreview(template);

  const commitTemplate = () => {
    const next = template.trim() || "[{name}] {slug}-{version}";
    if (next === settings.modFileNameTemplate) return;
    void persist({ modFileNameTemplate: next }, "文件名格式");
  };

  return (
    <div className="panel" data-card="community">
      <div className="panel-head">
        <h2 className="panel-title">社区资源</h2>
        <span className="panel-count">模组下载与列表显示</span>
      </div>

      <div className="form-grid">
        <Field label="来源" hint="资源站偏好；与「下载源」是同一个字段 downloadSource，改哪边都一样">
          <Select
            value={settings.downloadSource}
            options={COMMUNITY_SOURCE_OPTIONS}
            ariaLabel="社区资源来源"
            onChange={(value) => void persist({ downloadSource: value as DownloadSourceId }, "社区资源来源")}
          />
        </Field>

        <Field label="文件名格式" hint="可用占位符 {name} {slug} {version} {loader} {mc}；改动即时预览文件名">
          <TextInput
            value={template}
            aria-label="文件名格式"
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

        <Field label="Mod 管理样式" hint="影响实例详情里的模组列表显示">
          <Select
            value={settings.modDisplayStyle}
            options={DISPLAY_OPTIONS}
            ariaLabel="Mod 管理样式"
            onChange={(value) => void persist({ modDisplayStyle: value as Settings["modDisplayStyle"] }, "Mod 管理样式")}
          />
        </Field>
      </div>
    </div>
  );
}

function AssistCard({ settings }: { settings: Settings }) {
  const persist = usePersist();
  const { push } = useToast();
  const [keyDraft, setKeyDraft] = useState(settings.deeplApiKey);
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);

  // 设置被别处改动（例如清空后回读）时同步草稿。
  useEffect(() => setKeyDraft(settings.deeplApiKey), [settings.deeplApiKey]);

  /** 写入 + 回读校验走 usePersist；清空时补一条「改回免费接口」的提示。 */
  const saveKey = async () => {
    const next = keyDraft.trim();
    setSavingKey(true);
    const ok = await persist({ deeplApiKey: next }, "DeepL Key ");
    setSavingKey(false);
    if (ok && next === "") push("已清空 DeepL Key，改回免费接口", "success");
  };

  return (
    <div className="panel" data-card="assist">
      <div className="panel-head">
        <h2 className="panel-title">辅助功能</h2>
        <span className="panel-count">提示与语言</span>
      </div>

      <div className="checkline-stack">
        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.notifyGameUpdates}
            onChange={(event) => void persist({ notifyGameUpdates: event.target.checked }, "正式版更新提示")}
          />
          正式版更新提示
        </label>
        <span className="field-hint">游戏本体的正式版有新版本时，在启动器内提示。</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.showSnapshot}
            onChange={(event) => void persist({ showSnapshot: event.target.checked }, "测试版（快照）显示设置")}
          />
          显示测试版（快照）版本
        </label>
        <span className="field-hint">复用现有字段 showSnapshot，与设置页、下载页的「测试版」勾选是同一项。</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.forceChinese}
            onChange={(event) => void persist({ forceChinese: event.target.checked }, "游戏语言")}
          />
          游戏语言：自动设置为中文
        </label>
        <span className="field-hint">启动前把实例的 options.txt 语言强制写成简体中文。</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.translateMods}
            onChange={(event) => void persist({ translateMods: event.target.checked }, "模组列表实时翻译")}
          />
          模组列表实时翻译
        </label>
        <span className="field-hint">标题与简介译为简体中文，走 uapis.cn 免费接口，需要联网。</span>

        <label className="checkline">
          <input
            type="checkbox"
            checked={settings.translateSearch}
            onChange={(event) => void persist({ translateSearch: event.target.checked }, "中文搜索")}
          />
          中文搜索
        </label>
        <span className="field-hint">输入中文时先译为英文再检索。</span>

        <Field
          label="DeepL API Key"
          hint="默认已内置一把免费 Key；填自己的会覆盖，清空则改回免费接口 uapis.cn / suapi.net。"
        >
          <div className="key-row">
            <TextInput
              type={showKey ? "text" : "password"}
              value={keyDraft}
              aria-label="DeepL API Key"
              placeholder="以 :fx 结尾为免费版"
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
              aria-label={showKey ? "隐藏 DeepL Key" : "显示 DeepL Key"}
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
              {savingKey ? "保存中…" : "保存"}
            </button>
          </div>
        </Field>
      </div>
    </div>
  );
}
