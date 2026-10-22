import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { usePersist } from "../lib/persist";
import { useApp } from "../lib/store";
import { Field, Select, TextInput } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { useToast } from "../components/Toast";
import { AdvancedCard, MemoryCard, OfflineSkinCard } from "./LaunchCards";

const ISOLATION_OPTIONS = [
  { value: "all", label: "隔离所有版本（每个实例独立游戏目录）" },
  { value: "none", label: "共用 .minecraft（不隔离）" },
];

const VISIBILITY_OPTIONS = [
  { value: "keep", label: "保持不变" },
  { value: "minimize", label: "最小化" },
  { value: "close", label: "启动后关闭" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "低" },
  { value: "normal", label: "中（平衡）" },
  { value: "high", label: "高" },
];

const WINDOW_PRESETS = ["default", "1024x768", "1280x720", "1600x900", "1920x1080"];
const WINDOW_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "1024x768", label: "1024 × 768" },
  { value: "1280x720", label: "1280 × 720" },
  { value: "1600x900", label: "1600 × 900" },
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "custom", label: "自定义…" },
];

function parseSize(value: string): { w: number; h: number } | null {
  const matched = /^(\d{3,5})x(\d{3,5})$/i.exec(value.trim());
  return matched ? { w: Number(matched[1]), h: Number(matched[2]) } : null;
}

export function LaunchSettingsPage() {
  const { settings, settingsError } = useApp();

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">启动</h1>
        </header>
        <LoadingState label="读取启动选项…" />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">启动</h1>
          <p className="page-sub">仿 PCL2 的启动选项：版本隔离、游戏窗口、内存与高级参数</p>
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
    if (next !== settings.windowTitle) void persist({ windowTitle: next }, "游戏窗口标题");
  };

  const commitBrand = () => {
    const next = brandDraft.trim();
    if (next !== settings.launcherBrand) void persist({ launcherBrand: next }, "自定义信息");
  };

  const applySize = () => {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 640 || h < 480) {
      push("窗口宽高至少 640 × 480", "error");
      return;
    }
    void persist({ windowSize: `${w}x${h}` }, "窗口大小");
  };

  return (
    <div className="panel" data-card="launch-options">
      <div className="panel-head">
        <h2 className="panel-title">启动选项</h2>
        <span className="panel-count">改动即时保存并回读校验</span>
      </div>
      <div className="form-grid">
        <Field label="默认版本隔离" hint="隔离后每个实例有独立存档、模组与配置文件">
          <Select
            value={settings.versionIsolation}
            options={ISOLATION_OPTIONS}
            ariaLabel="默认版本隔离"
            onChange={(value) => void persist({ versionIsolation: value as Settings["versionIsolation"] }, "版本隔离")}
          />
        </Field>

        <Field label="游戏窗口标题" hint="支持 {instance} 与 {version} 占位符；留空则用实例名">
          <TextInput
            value={titleDraft}
            placeholder="默认（实例名）"
            aria-label="游戏窗口标题"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitTitle();
            }}
            spellCheck={false}
          />
        </Field>

        <Field label="自定义信息" hint="写入 -Dminecraft.launcher.brand，日志与崩溃报告会带上它">
          <TextInput
            value={brandDraft}
            placeholder="NaiWa"
            aria-label="自定义信息"
            onChange={(event) => setBrandDraft(event.target.value)}
            onBlur={commitBrand}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitBrand();
            }}
            spellCheck={false}
          />
        </Field>

        <Field label="启动器可见性" hint="游戏启动后启动器窗口的行为">
          <Select
            value={settings.launcherVisibility}
            options={VISIBILITY_OPTIONS}
            ariaLabel="启动器可见性"
            onChange={(value) => void persist({ launcherVisibility: value as Settings["launcherVisibility"] }, "启动器可见性")}
          />
        </Field>

        <Field label="进程优先级" hint="高优先级更吃 CPU，低优先级让其他程序更流畅">
          <Select
            value={settings.processPriority}
            options={PRIORITY_OPTIONS}
            ariaLabel="进程优先级"
            onChange={(value) => void persist({ processPriority: value as Settings["processPriority"] }, "进程优先级")}
          />
        </Field>

        <Field label="窗口大小" hint="游戏窗口初始尺寸；自定义时填宽 × 高">
          <div className="window-size-row">
            <Select
              value={customSize ? "custom" : settings.windowSize}
              options={WINDOW_OPTIONS}
              ariaLabel="窗口大小"
              onChange={(value) => {
                if (value === "custom") {
                  setCustomSize(true);
                  return;
                }
                setCustomSize(false);
                void persist({ windowSize: value }, "窗口大小");
              }}
            />
            {customSize ? (
              <>
                <TextInput
                  type="number"
                  min={640}
                  max={7680}
                  value={width}
                  aria-label="窗口宽度"
                  onChange={(event) => setWidth(Number(event.target.value))}
                />
                <span className="window-size-x">×</span>
                <TextInput
                  type="number"
                  min={480}
                  max={4320}
                  value={height}
                  aria-label="窗口高度"
                  onChange={(event) => setHeight(Number(event.target.value))}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={applySize}>
                  应用
                </button>
              </>
            ) : null}
          </div>
        </Field>
      </div>
    </div>
  );
}
