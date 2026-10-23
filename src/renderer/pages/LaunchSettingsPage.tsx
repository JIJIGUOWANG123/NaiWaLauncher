import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { useT } from "../lib/i18n";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { Field, Select, TextInput, Toggle } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { useToast } from "../components/Toast";
import { AdvancedCard, MemoryCard, OfflineSkinCard } from "./LaunchCards";

type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** 选项文案存 key，渲染时再翻：模块级常量在切换语言后不会自己更新。 */
type OptionKey<T extends string> = { value: T; labelKey?: string; label?: string };

function localize<T extends string>(options: Array<OptionKey<T>>, tr: Translator): Array<{ value: T; label: string }> {
  return options.map(({ value, labelKey, label }) => ({ value, label: labelKey ? tr(labelKey) : (label ?? value) }));
}

const ISOLATION_OPTIONS: Array<OptionKey<"all" | "none">> = [
  { value: "all", labelKey: "pages.launchSettings.isolationAll" },
  { value: "none", labelKey: "pages.launchSettings.isolationNone" },
];

/** 同时运行的游戏实例数：默认只允许一个，改成无限即可多开。 */
const INSTANCE_LIMIT_OPTIONS: Array<OptionKey<"one" | "unlimited">> = [
  { value: "one", labelKey: "pages.launchSettings.limitOne" },
  { value: "unlimited", labelKey: "pages.launchSettings.limitUnlimited" },
];

const VISIBILITY_OPTIONS: Array<OptionKey<"keep" | "minimize" | "close">> = [
  { value: "keep", labelKey: "pages.launchSettings.visKeep" },
  { value: "minimize", labelKey: "pages.launchSettings.visMinimize" },
  { value: "close", labelKey: "pages.launchSettings.visClose" },
];

const PRIORITY_OPTIONS: Array<OptionKey<"low" | "normal" | "high">> = [
  { value: "low", labelKey: "pages.launchSettings.prioLow" },
  { value: "normal", labelKey: "pages.launchSettings.prioNormal" },
  { value: "high", labelKey: "pages.launchSettings.prioHigh" },
];

const WINDOW_PRESETS = ["default", "1024x768", "1280x720", "1600x900", "1920x1080"];
const WINDOW_OPTIONS: Array<OptionKey<string>> = [
  { value: "default", labelKey: "pages.launchSettings.windowDefault" },
  { value: "1024x768", label: "1024 × 768" },
  { value: "1280x720", label: "1280 × 720" },
  { value: "1600x900", label: "1600 × 900" },
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "custom", labelKey: "pages.launchSettings.windowCustom" },
];

function parseSize(value: string): { w: number; h: number } | null {
  const matched = /^(\d{3,5})x(\d{3,5})$/i.exec(value.trim());
  return matched ? { w: Number(matched[1]), h: Number(matched[2]) } : null;
}

export function LaunchSettingsPage() {
  const { settings, settingsError } = useApp();
  const tr = useT();

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">{tr("pages.launchSettings.title")}</h1>
        </header>
        <LoadingState label={tr("pages.launchSettings.loading")} />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("pages.launchSettings.title")}</h1>
          <p className="page-sub">{tr("pages.launchSettings.sub")}</p>
        </div>
      </header>

      {settingsError ? <ErrorState message={settingsError} /> : null}

      <div className="settings-grid">
        <LaunchOptionsCard settings={settings} />
        <MemoryCard />
        <OfflineSkinCard />
        <AdvancedCard />
      </div>
    </section>
  );
}

function LaunchOptionsCard({ settings }: { settings: Settings }) {
  const persist = usePersist();
  const { push } = useToast();
  const tr = useT();
  const [titleDraft, setTitleDraft] = useState(settings.windowTitle);
  const [brandDraft, setBrandDraft] = useState(settings.launcherBrand);
  const [customSize, setCustomSize] = useState(false);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);

  useEffect(() => setTitleDraft(settings.windowTitle), [settings.windowTitle]);
  useEffect(() => setBrandDraft(settings.launcherBrand), [settings.launcherBrand]);
  useEffect(() => {
    const parsed = parseSize(settings.windowSize);
    if (parsed) {
      setWidth(parsed.w);
      setHeight(parsed.h);
    }
    setCustomSize(!WINDOW_PRESETS.includes(settings.windowSize));
  }, [settings.windowSize]);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next !== settings.windowTitle) void persist({ windowTitle: next }, tr("pages.launchSettings.persistWindowTitle"));
  };

  const commitBrand = () => {
    const next = brandDraft.trim();
    if (next !== settings.launcherBrand) void persist({ launcherBrand: next }, tr("pages.launchSettings.persistBrand"));
  };

  const applySize = () => {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 640 || h < 480) {
      push(tr("pages.launchSettings.sizeTooSmall"), "error");
      return;
    }
    void persist({ windowSize: `${w}x${h}` }, tr("pages.launchSettings.persistWindowSize"));
  };

  return (
    <div className="panel" data-card="launch-options">
      <div className="panel-head">
        <h2 className="panel-title">{tr("pages.launchSettings.optionsTitle")}</h2>
        <span className="panel-count">{tr("pages.launchSettings.optionsCount")}</span>
      </div>
      <div className="form-grid">
        <Field label={tr("pages.launchSettings.isolationLabel")} hint={tr("pages.launchSettings.isolationHint")}>
          <Select
            value={settings.versionIsolation}
            options={localize(ISOLATION_OPTIONS, tr)}
            ariaLabel={tr("pages.launchSettings.isolationLabel")}
            onChange={(value) => void persist({ versionIsolation: value as Settings["versionIsolation"] }, tr("pages.launchSettings.persistIsolation"))}
          />
        </Field>

        <Field
          label={tr("pages.launchSettings.instanceLimitLabel")}
          hint={tr("pages.launchSettings.instanceLimitHint")}
        >
          {/* data-game-limit 带上当前值，便于自检脚本断言 */}
          <div data-game-limit={settings.gameInstanceLimit}>
            <Select
              value={settings.gameInstanceLimit}
              options={localize(INSTANCE_LIMIT_OPTIONS, tr)}
              ariaLabel={tr("pages.launchSettings.instanceLimitLabel")}
              onChange={(value) => void persist({ gameInstanceLimit: value as Settings["gameInstanceLimit"] }, tr("pages.launchSettings.persistInstanceLimit"))}
            />
          </div>
        </Field>

        <Field
          label={tr("pages.launchSettings.memOptLabel")}
          hint={tr("pages.launchSettings.memOptHint")}
        >
          <Toggle
            label={tr("pages.launchSettings.memOptToggle")}
            checked={settings.memoryOptimize}
            onChange={(value) => void persist({ memoryOptimize: value }, tr("pages.launchSettings.persistMemoryOptimize"))}
          />
        </Field>

        <Field
          label={tr("pages.launchSettings.advProcLabel")}
          hint={tr("pages.launchSettings.advProcHint")}
        >
          <Toggle
            label={tr("pages.launchSettings.advProcToggle")}
            checked={settings.advancedProcessTweaks}
            onChange={(value) => void persist({ advancedProcessTweaks: value }, tr("pages.launchSettings.persistAdvancedProcess"))}
          />
        </Field>

        <Field
          label={tr("pages.launchSettings.localSkinLabel")}
          hint={tr("pages.launchSettings.localSkinHint")}
        >
          <Toggle
            label={tr("pages.launchSettings.localSkinToggle")}
            checked={settings.localSkinApi}
            onChange={(value) => void persist({ localSkinApi: value }, tr("pages.launchSettings.persistLocalSkinApi"))}
          />
        </Field>

        <Field label={tr("pages.launchSettings.windowTitleLabel")} hint={tr("pages.launchSettings.windowTitleHint")}>
          <TextInput
            value={titleDraft}
            placeholder={tr("pages.launchSettings.windowTitlePlaceholder")}
            aria-label={tr("pages.launchSettings.windowTitleLabel")}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitTitle();
            }}
            spellCheck={false}
          />
        </Field>

        <Field label={tr("pages.launchSettings.brandLabel")} hint={tr("pages.launchSettings.brandHint")}>
          <TextInput
            value={brandDraft}
            placeholder="NaiWa"
            aria-label={tr("pages.launchSettings.brandLabel")}
            onChange={(event) => setBrandDraft(event.target.value)}
            onBlur={commitBrand}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitBrand();
            }}
            spellCheck={false}
          />
        </Field>

        <Field label={tr("pages.launchSettings.visibilityLabel")} hint={tr("pages.launchSettings.visibilityHint")}>
          <Select
            value={settings.launcherVisibility}
            options={localize(VISIBILITY_OPTIONS, tr)}
            ariaLabel={tr("pages.launchSettings.visibilityLabel")}
            onChange={(value) => void persist({ launcherVisibility: value as Settings["launcherVisibility"] }, tr("pages.launchSettings.persistVisibility"))}
          />
        </Field>

        <Field label={tr("pages.launchSettings.priorityLabel")} hint={tr("pages.launchSettings.priorityHint")}>
          <Select
            value={settings.processPriority}
            options={localize(PRIORITY_OPTIONS, tr)}
            ariaLabel={tr("pages.launchSettings.priorityLabel")}
            onChange={(value) => void persist({ processPriority: value as Settings["processPriority"] }, tr("pages.launchSettings.persistPriority"))}
          />
        </Field>

        <Field label={tr("pages.launchSettings.windowSizeLabel")} hint={tr("pages.launchSettings.windowSizeHint")}>
          <div className="window-size-row">
            <Select
              value={customSize ? "custom" : settings.windowSize}
              options={localize(WINDOW_OPTIONS, tr)}
              ariaLabel={tr("pages.launchSettings.windowSizeLabel")}
              onChange={(value) => {
                if (value === "custom") {
                  setCustomSize(true);
                  return;
                }
                setCustomSize(false);
                void persist({ windowSize: value }, tr("pages.launchSettings.persistWindowSize"));
              }}
            />
            {customSize ? (
              <>
                <TextInput
                  type="number"
                  min={640}
                  max={7680}
                  value={width}
                  aria-label={tr("pages.launchSettings.windowWidthAria")}
                  onChange={(event) => setWidth(Number(event.target.value))}
                />
                <span className="window-size-x">×</span>
                <TextInput
                  type="number"
                  min={480}
                  max={4320}
                  value={height}
                  aria-label={tr("pages.launchSettings.windowHeightAria")}
                  onChange={(event) => setHeight(Number(event.target.value))}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={applySize}>
                  {tr("pages.launchSettings.apply")}
                </button>
              </>
            ) : null}
          </div>
        </Field>
      </div>
    </div>
  );
}
