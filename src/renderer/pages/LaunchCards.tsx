import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { useSliderDraft } from "../lib/useSliderDraft";
import { errorMessage } from "../lib/useAsync";
import { Collapse } from "../components/Collapse";
import { Field, Segmented, Select, Slider, TextInput } from "../components/Form";
import { ContentDrawer } from "../components/ContentDrawer";
import { InstanceDetailDrawer } from "../components/InstanceDetailDrawer";
import { EmptyState } from "../components/State";
import { useToast } from "../components/Toast";
import { IconList, IconRefresh } from "../components/icons";
import { RECOMMENDED_MEMORY_MB, deviceMemoryGb, memoryUpperMb, readHeap } from "../lib/memory";

const MODE_OPTIONS: Array<{ value: "auto" | "custom" }> = [
  { value: "auto" },
  { value: "custom" },
];

function memoryLabel(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** 内存分配：设置页只负责推荐展示，真正的值写在当前选中实例上。 */
export function MemoryCard() {
  const { instances, currentInstance, currentInstanceId, setCurrentInstanceId, reloadInstances } = useApp();
  const { push } = useToast();
  const tr = useT();
  const recommendedUpper = useMemo(() => memoryUpperMb(), []);
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [heap, setHeap] = useState(readHeap);
  const [busy, setBusy] = useState(false);

  const applyMemory = async (mb: number) => {
    if (!currentInstance) return;
    setBusy(true);
    try {
      const written = await api.instances.update(currentInstance.id, { memoryMb: mb });
      const confirmed = (await api.instances.list()).find((item) => item.id === currentInstance.id);
      await reloadInstances();
      if (!confirmed || confirmed.memoryMb !== mb || written.memoryMb !== mb) {
        push(tr("pages.launchCards.memoryVerifyFailed", { written: mb, readback: confirmed ? confirmed.memoryMb : tr("pages.common.none") }), "error");
        return;
      }
      push(tr("pages.launchCards.memoryApplied", { name: confirmed.name, size: memoryLabel(mb), mb }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const [memoryDraft, setMemoryDraft] = useSliderDraft(
    currentInstance?.memoryMb ?? RECOMMENDED_MEMORY_MB,
    (value) => void applyMemory(value),
  );

  // 上限取「物理内存一半」与实例现有值中的较大者，且每个实例只算一次：
  // 否则拖动把值调小后上限会跟着缩，滑不回去。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const upperMb = useMemo(() => Math.max(recommendedUpper, currentInstance?.memoryMb ?? 0), [currentInstance?.id]);
  const sliderValue = Math.min(Math.max(memoryDraft, 1024), upperMb);
  const heapPercent = heap.used !== null && heap.limit ? Math.min(100, (heap.used / heap.limit) * 100) : 0;
  const gameMb = currentInstance?.memoryMb ?? 0;
  const gamePercent = Math.min(100, (gameMb / upperMb) * 100);

  return (
    <div className="panel" data-card="memory">
      <div className="panel-head">
        <h2 className="panel-title">{tr("pages.launchCards.memoryTitle")}</h2>
        <span className="panel-count">
          {busy
            ? tr("pages.launchCards.writing")
            : currentInstance
              ? tr("pages.launchCards.currentInstance", { name: currentInstance.name })
              : tr("pages.launchCards.noInstanceSelected")}
        </span>
      </div>

      <div className="mem-head-row">
        <Field label={tr("pages.launchCards.currentInstanceLabel")}>
          <Select
            value={currentInstanceId ?? ""}
            options={instances.map((item) => ({ value: item.id, label: `${item.name} · ${item.mcVersion}` }))}
            onChange={setCurrentInstanceId}
            ariaLabel={tr("pages.launchCards.currentInstanceLabel")}
            placeholder={tr("pages.launchCards.selectInstance")}
            disabled={instances.length === 0}
          />
        </Field>
        <Segmented
          value={mode}
          options={MODE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.value === "auto" ? tr("pages.launchCards.modeAuto") : tr("pages.launchCards.modeCustom"),
          }))}
          onChange={setMode}
        />
      </div>

      {instances.length === 0 ? (
        <EmptyState title={tr("pages.launchCards.noInstancesTitle")} hint={tr("pages.launchCards.noInstancesHint")} />
      ) : null}

      {instances.length > 0 && mode === "auto" ? (
        <p className="mem-hint">
          {tr("pages.launchCards.autoHint", {
            device: deviceMemoryGb(),
            recommended: memoryLabel(RECOMMENDED_MEMORY_MB),
            upper: memoryLabel(recommendedUpper),
            extra: upperMb > recommendedUpper ? tr("pages.launchCards.autoHintExtra", { size: memoryLabel(upperMb) }) : "",
          })}
        </p>
      ) : null}

      {instances.length > 0 && mode === "custom" ? (
        <>
          <Field label={tr("pages.launchCards.memoryCapLabel")} hint={tr("pages.launchCards.memoryCapHint")}>
            <Slider
              value={sliderValue}
              min={1024}
              max={upperMb}
              step={512}
              disabled={!currentInstance || busy}
              onChange={setMemoryDraft}
              format={(value) => memoryLabel(value)}
            />
          </Field>
          {!currentInstance ? (
            <p className="field-hint">{tr("pages.launchCards.noInstanceMemoryHint")}</p>
          ) : null}
        </>
      ) : null}

      <div className="mem-bars">
        <div className="mem-bar">
          <div className="mem-bar-head">
            <span>{tr("pages.launchCards.usedMemory")}</span>
            <span className="mem-bar-value">
              {heap.used === null || heap.limit === null ? "—" : `${formatBytes(heap.used)} / ${formatBytes(heap.limit)}`}
            </span>
            <button type="button" className="link-btn" onClick={() => setHeap(readHeap())}>
              <IconRefresh size={13} />
              {tr("pages.common.refresh")}
            </button>
          </div>
          <div className="bar-track">
            <div className="bar-fill alt" style={{ width: `${heapPercent}%` }} />
          </div>
        </div>
        <div className="mem-bar">
          <div className="mem-bar-head">
            <span>{tr("pages.launchCards.gameAllocated")}</span>
            <span className="mem-bar-value">
              {currentInstance ? `${memoryLabel(currentInstance.memoryMb)} / ${memoryLabel(upperMb)}` : "—"}
            </span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${gamePercent}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function OfflineSkinCard() {
  const tr = useT();
  return (
    <Collapse title={tr("pages.launchCards.offlineSkin")} hint={tr("pages.launchCards.offlineSkinPlaceholder")}>
      <p className="ext-note">{tr("pages.launchCards.offlineSkinNote")}</p>
    </Collapse>
  );
}

/** 高级选项：额外 JVM 参数按实例保存，「版本独立设置」复用实例详情抽屉。 */
export function AdvancedCard() {
  const { currentInstance, reloadInstances } = useApp();
  const { push } = useToast();
  const tr = useT();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);

  useEffect(() => setDraft(currentInstance?.extraJvmArgs ?? ""), [currentInstance?.id, currentInstance?.extraJvmArgs]);

  const save = async () => {
    if (!currentInstance) return;
    const next = draft.trim();
    setBusy(true);
    try {
      const written = await api.instances.update(currentInstance.id, { extraJvmArgs: next });
      const confirmed = (await api.instances.list()).find((item) => item.id === currentInstance.id);
      await reloadInstances();
      if (!confirmed || confirmed.extraJvmArgs !== next || written.extraJvmArgs !== next) {
        push(tr("pages.launchCards.jvmVerifyFailed"), "error");
        return;
      }
      push(tr("pages.launchCards.jvmSaved", { name: confirmed.name }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapse
      title={tr("pages.launchCards.advancedTitle")}
      hint={currentInstance ? tr("pages.launchCards.currentInstance", { name: currentInstance.name }) : tr("pages.launchCards.noInstanceSelected")}
    >
      {currentInstance ? (
        <>
          <Field label={tr("pages.launchCards.extraJvm")} hint={tr("pages.launchCards.extraJvmHint")}>
            <div className="key-row">
              <TextInput
                value={draft}
                placeholder="-XX:+UseG1GC"
                aria-label={tr("pages.launchCards.extraJvm")}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save();
                }}
                spellCheck={false}
              />
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
                {busy ? tr("pages.common.saving") : tr("pages.common.save")}
              </button>
            </div>
          </Field>
          <div className="ext-row">
            <button type="button" className="btn btn-ghost" onClick={() => setDetailOpen(true)}>
              {tr("pages.launchCards.versionSettings")}
            </button>
            <button type="button" className="btn btn-ghost" data-action="open-content" onClick={() => setContentOpen(true)}>
              <IconList size={15} />
              {tr("pages.launchCards.manageContent")}
            </button>
            <span className="ext-note">{tr("pages.launchCards.versionSettingsNote")}</span>
          </div>
        </>
      ) : (
        <EmptyState title={tr("pages.launchCards.noInstanceTitle")} hint={tr("pages.launchCards.advancedEmptyHint")} />
      )}

      <InstanceDetailDrawer
        instance={currentInstance}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onChanged={() => void reloadInstances()}
      />
      <ContentDrawer instance={currentInstance} open={contentOpen} onClose={() => setContentOpen(false)} />
    </Collapse>
  );
}