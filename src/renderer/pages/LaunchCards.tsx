import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import { useApp } from "../lib/store";
import { useSliderDraft } from "../lib/useSliderDraft";
import { errorMessage } from "../lib/useAsync";
import { Collapse } from "../components/Collapse";
import { Field, Segmented, Select, Slider, TextInput } from "../components/Form";
import { InstanceDetailDrawer } from "../components/InstanceDetailDrawer";
import { EmptyState } from "../components/State";
import { useToast } from "../components/Toast";
import { IconRefresh } from "../components/icons";
import { RECOMMENDED_MEMORY_MB, deviceMemoryGb, memoryUpperMb, readHeap } from "../lib/memory";

const MODE_OPTIONS: Array<{ value: "auto" | "custom"; label: string }> = [
  { value: "auto", label: "自动配置" },
  { value: "custom", label: "自定义" },
];

function memoryLabel(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** 内存分配：设置页只负责推荐展示，真正的值写在当前选中实例上。 */
export function MemoryCard() {
  const { instances, currentInstance, currentInstanceId, setCurrentInstanceId, reloadInstances } = useApp();
  const { push } = useToast();
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
        push(`内存回读校验失败：写入 ${mb} MB，回读 ${confirmed ? confirmed.memoryMb : "无"} MB`, "error");
        return;
      }
      push(`「${confirmed.name}」内存已设为 ${memoryLabel(mb)}，回读确认 memoryMb=${mb}`, "success");
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
        <h2 className="panel-title">内存分配</h2>
        <span className="panel-count">
          {busy ? "写入中…" : currentInstance ? `当前实例：${currentInstance.name}` : "未选择实例"}
        </span>
      </div>

      <div className="mem-head-row">
        <Field label="当前实例">
          <Select
            value={currentInstanceId ?? ""}
            options={instances.map((item) => ({ value: item.id, label: `${item.name} · ${item.mcVersion}` }))}
            onChange={setCurrentInstanceId}
            ariaLabel="当前实例"
            placeholder="请选择实例"
            disabled={instances.length === 0}
          />
        </Field>
        <Segmented value={mode} options={MODE_OPTIONS} onChange={setMode} />
      </div>

      {instances.length === 0 ? (
        <EmptyState title="还没有实例" hint="内存分配写在实例上，先到「实例」页新建一个实例" />
      ) : null}

      {instances.length > 0 && mode === "auto" ? (
        <p className="mem-hint">
          自动配置：按本机物理内存 {deviceMemoryGb()} GB 推荐 {memoryLabel(RECOMMENDED_MEMORY_MB)}，
          可分配上限 {memoryLabel(recommendedUpper)}
          {upperMb > recommendedUpper ? `（当前实例已分配 ${memoryLabel(upperMb)}，滑杆上限跟随实例）` : ""}；
          自动模式只展示推荐值，不写实例。
        </p>
      ) : null}

      {instances.length > 0 && mode === "custom" ? (
        <>
          <Field label="游戏内存上限" hint="拖动后自动写入当前实例（api.instances.update），停手即保存">
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
            <p className="field-hint">未选择实例：内存写在实例上，请先在上方选择一个实例</p>
          ) : null}
        </>
      ) : null}

      <div className="mem-bars">
        <div className="mem-bar">
          <div className="mem-bar-head">
            <span>已使用内存</span>
            <span className="mem-bar-value">
              {heap.used === null || heap.limit === null ? "—" : `${formatBytes(heap.used)} / ${formatBytes(heap.limit)}`}
            </span>
            <button type="button" className="link-btn" onClick={() => setHeap(readHeap())}>
              <IconRefresh size={13} />
              刷新
            </button>
          </div>
          <div className="bar-track">
            <div className="bar-fill alt" style={{ width: `${heapPercent}%` }} />
          </div>
        </div>
        <div className="mem-bar">
          <div className="mem-bar-head">
            <span>游戏分配</span>
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
  return (
    <Collapse title="离线皮肤" hint="占位">
      <p className="ext-note">离线皮肤需要本地皮肤站，当前版本仅支持离线身份，皮肤功能在后续版本提供。</p>
    </Collapse>
  );
}

/** 高级选项：额外 JVM 参数按实例保存，「版本独立设置」复用实例详情抽屉。 */
export function AdvancedCard() {
  const { currentInstance, reloadInstances } = useApp();
  const { push } = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

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
        push("额外 JVM 参数回读校验失败，请检查实例文件", "error");
        return;
      }
      push(`「${confirmed.name}」额外 JVM 参数已保存，回读确认`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Collapse title="高级选项" hint={currentInstance ? `当前实例：${currentInstance.name}` : "未选择实例"}>
      {currentInstance ? (
        <>
          <Field label="额外 JVM 参数" hint="写进该实例启动命令，例如 -XX:+UseG1GC；留空表示不追加">
            <div className="key-row">
              <TextInput
                value={draft}
                placeholder="-XX:+UseG1GC"
                aria-label="额外 JVM 参数"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void save();
                }}
                spellCheck={false}
              />
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </Field>
          <div className="ext-row">
            <button type="button" className="btn btn-ghost" onClick={() => setDetailOpen(true)}>
              版本独立设置
            </button>
            <span className="ext-note">打开「{currentInstance.name}」的实例详情，单独调整加载器与模组</span>
          </div>
        </>
      ) : (
        <EmptyState title="还没有选择实例" hint="高级选项按实例保存，先到「实例」页选择或新建实例" />
      )}

      <InstanceDetailDrawer
        instance={currentInstance}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onChanged={() => void reloadInstances()}
      />
    </Collapse>
  );
}
