import { useEffect, useMemo, useState } from "react";
import type { DownloadSourceId, ModProviderId, Settings, SourceProbe } from "../../shared/types";
import { api } from "../lib/api";
import { formatLatency } from "../lib/format";
import { usePersist } from "../lib/persist";
import { useSliderDraft } from "../lib/useSliderDraft";
import { useApp } from "../lib/store";
import { errorMessage, useAsync } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { Field, Segmented, Slider, TextInput, Toggle } from "../components/Form";
import { ErrorState, LoadingState } from "../components/State";
import { IconEye, IconEyeOff, IconInfo, IconZap } from "../components/icons";

const MOD_PROVIDERS: Array<{ value: ModProviderId; label: string }> = [
  { value: "modrinth", label: "Modrinth" },
  { value: "curseforge", label: "CurseForge" },
  { value: "minekuai", label: "麦块社区（中文）" },
];

export function SettingsPage() {
  const { settings, saveSettings, applySettings, settingsError, navigate } = useApp();
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

  const [connectionsDraft, setConnectionsDraft] = useSliderDraft(settings?.connectionsPerFile ?? 4, (value) => {
    void persist({ connectionsPerFile: value }, "单文件分片连接数");
  });
  const [fileConcurrencyDraft, setFileConcurrencyDraft] = useSliderDraft(settings?.concurrentDownloads ?? 12, (value) => {
    void persist({ concurrentDownloads: value }, "多线程下载（文件并发数）");
  });

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
      push("测速完成", "success");
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
      push("下载源已切换", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const saveKey = async () => {
    setSavingKey(true);
    await saveSettings({ curseforgeApiKey: keyDraft.trim() });
    setSavingKey(false);
    push(keyDraft.trim() ? "CurseForge API Key 已保存" : "已清空 CurseForge API Key", "success");
  };

  const saveThreshold = async () => {
    const parsed = Number(thresholdDraft);
    if (!Number.isFinite(parsed) || thresholdDraft.trim() === "") {
      push("阈值需要是 200–10000 之间的数字", "error");
      return;
    }
    const clamped = Math.min(10000, Math.max(200, Math.round(parsed)));
    if (clamped !== parsed) push(`阈值已收敛到 ${clamped} ms（允许范围 200–10000）`, "info");
    setThresholdDraft(String(clamped));
    setSavingThreshold(true);
    await persist({ autoSwitchThresholdMs: clamped }, "自动切换阈值");
    setSavingThreshold(false);
  };

  if (!settings) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">设置</h1>
        </header>
        <LoadingState label="读取设置…" />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-sub">所有改动即时保存到 config/settings.json</p>
        </div>
        {settingsError ? <span className="inline-error">{settingsError}</span> : null}
      </header>

      <div className="settings-grid">
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">下载源</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runProbe()} disabled={probing}>
              <IconZap size={15} />
              {probing ? "测速中…" : "测速"}
            </button>
          </div>

          {sources.loading ? <LoadingState label="读取下载源…" /> : null}
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
                      {probe ? formatLatency(probe.latencyMs, probe.ok) : "未测速"}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">下载性能</h2>
            <span className="panel-count">多线程 Range 下载</span>
          </div>
          <div className="form-grid">
            <Field label="单文件分片连接数" hint="一个大文件用几条连接并行拉（1–16，默认 4）">
              <Slider
                value={connectionsDraft}
                min={1}
                max={16}
                onChange={setConnectionsDraft}
                format={(value) => `${value} 条`}
              />
            </Field>
            <Field label="多线程下载（文件并发数）" hint="多个文件同时下载（1–32，默认 12），安装整合包/资源时提速明显">
              <Slider
                value={fileConcurrencyDraft}
                min={1}
                max={32}
                onChange={setFileConcurrencyDraft}
                format={(value) => `${value} 个`}
              />
            </Field>
            <p className="field-hint dl-parallel-note" data-dl-parallel-note>
              文件并发数 × 单文件分片数 = 理论最大连接数，过高可能被 CDN 限速
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">版本与自动切换</h2>
            <span className="panel-count">保存后回读校验</span>
          </div>
          <div className="form-grid">
            <Toggle
              label="显示测试版（快照）版本"
              hint="与下载页、新建实例弹窗的「测试版」勾选是同一项；关闭后快照版本不再出现在版本列表里"
              checked={settings.showSnapshot}
              onChange={(value) => void persist({ showSnapshot: value }, "测试版（快照）显示设置")}
            />
            <Field label="自动切换源阈值（毫秒）" hint="官方源慢于此值时自动使用 BMCLAPI 镜像；范围 200–10000，步进 100">
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
                  {savingThreshold ? "保存中…" : "保存"}
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">CurseForge</h2>
            <span className="panel-count">需要官方 API Key</span>
          </div>
          <div className="form-grid">
            <Field label="API Key" hint="从 console.curseforge.com 申请后粘贴，仅保存在本地">
              <div className="key-row">
                <TextInput
                  type={showKey ? "text" : "password"}
                  value={keyDraft}
                  placeholder="粘贴 CurseForge API Key"
                  onChange={(event) => setKeyDraft(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={() => setShowKey((value) => !value)}
                  aria-label={showKey ? "隐藏 Key" : "显示 Key"}
                >
                  {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void saveKey()} disabled={savingKey}>
                  {savingKey ? "保存中…" : "保存"}
                </button>
              </div>
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">模组与 Java</h2>
          </div>
          <div className="form-grid">
            <Field label="模组默认来源">
              <Segmented
                value={settings.modProvider}
                options={MOD_PROVIDERS}
                onChange={(value) => void saveSettings({ modProvider: value })}
              />
            </Field>
            <Toggle
              label="自动安装 Java"
              hint="启动时缺少匹配 JDK 就自动从 BellSoft 下载"
              checked={settings.javaAutoDownload}
              onChange={(value) => void saveSettings({ javaAutoDownload: value })}
            />
            <Toggle
              label="自动匹配 Java 版本"
              hint="关闭后每个实例必须单独指定 Java，否则启动报错"
              checked={settings.javaAutoMatch}
              onChange={(value) => void persist({ javaAutoMatch: value }, "Java 自动匹配")}
            />
            <Toggle
              label="关闭到托盘"
              hint="托盘图标始终显示：随时点右下角图标都能叫回界面。开启本项后点关闭不再退出、改为隐藏到托盘；关掉则点关闭直接退出。若右下角看不到图标，点任务栏的 ^ 展开通知区域，把奶娃启动器拖到显示区即可"
              checked={settings.closeToTray}
              onChange={(value) => void saveSettings({ closeToTray: value })}
            />
          </div>
        </div>

        <div className="panel panel-about">
          <div className="panel-head">
            <h2 className="panel-title">关于</h2>
          </div>
          <p className="about-note">
            版本徽标、能力清单、更新日志与核心团队都收进了独立的「关于」页，这里只留一个入口，避免两处重复维护。
          </p>
          <button type="button" className="btn btn-ghost about-entry" data-open-about onClick={() => navigate("about")}>
            <IconInfo size={15} />
            打开关于页
          </button>
        </div>
      </div>
    </section>
  );
}