import { useMemo, useState } from "react";
import logo from "../assets/logo.png";
import type { InstanceMeta } from "../../shared/types";
import { api } from "../lib/api";
import { formatRelative, instanceMemory, loaderLabel } from "../lib/format";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { LoaderBadge } from "../components/Badges";
import { ConfirmDialog } from "../components/Modal";
import { CreateInstanceModal, EditInstanceModal } from "../components/InstanceModals";
import { InstanceDetailDrawer } from "../components/InstanceDetailDrawer";
import { SaveDrawer } from "../components/SaveDrawer";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import {
  IconBook, IconFolder, IconMods, IconPlay, IconPlus, IconRefresh, IconSettings, IconTrash,
} from "../components/icons";

export function InstancesPage() {
  const { info, instances, instancesLoading, instancesError, reloadInstances } = useApp();
  const { push } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceMeta | null>(null);
  const [deleting, setDeleting] = useState<InstanceMeta | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  // 只存 id：reloadInstances 之后抽屉拿到的永远是最新实例对象（加载器徽标随之更新）。
  const [managingId, setManagingId] = useState<string | null>(null);
  // 同理只存 id：存档抽屉要拿最新的实例对象。
  const [savesId, setSavesId] = useState<string | null>(null);
  const savesInstance = useMemo(
    () => (savesId ? instances.find((item) => item.id === savesId) ?? null : null),
    [instances, savesId],
  );
  const managing = useMemo(
    () => (managingId ? instances.find((item) => item.id === managingId) ?? null : null),
    [instances, managingId],
  );

  const launch = async (instance: InstanceMeta) => {
    setLaunchingId(instance.id);
    try {
      await api.instances.launch(instance.id);
      push(`「${instance.name}」已启动`, "success");
      push("若没有出现游戏窗口，点实例上的「日志」查看原因（NaiWa/logs 与实例 logs 目录）", "info");
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setLaunchingId(null);
    }
  };

  // 打不开游戏时先看日志：启动器日志在 <root>/NaiWa/logs，游戏日志在实例目录 logs/
  const openLogsDir = async (instance: InstanceMeta) => {
    try {
      const rootDir = (info ?? (await api.app.info())).rootDir.replace(/[\\/]+$/, "");
      await api.app.openPath(rootDir + "/NaiWa/logs");
      push("已打开启动器日志目录", "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  // 实例模组目录在游戏目录下，主进程会 resolve 并拒绝越界路径。
  const openModsDir = async (instance: InstanceMeta) => {
    try {
      const gameRoot = (info ?? (await api.app.info())).gameRoot.replace(/[\\/]+$/, "");
      await api.app.openInstanceMods(instance.id);
      push(`已打开模组目录：.minecraft/instances/${instance.id}/mods`, "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await api.instances.remove(deleting.id);
      push(`实例「${deleting.name}」已删除`, "success");
      setDeleting(null);
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyDelete(false);
    }
  };

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">实例</h1>
          <p className="page-sub">每个实例都有独立的模组目录、内存与启动参数</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void reloadInstances()} disabled={instancesLoading}>
            <IconRefresh size={16} />
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            新建实例
          </button>
        </div>
      </header>

      {instancesLoading && instances.length === 0 ? <SkeletonCards count={3} /> : null}

      {instancesError ? <ErrorState message={instancesError} onRetry={() => void reloadInstances()} /> : null}

      {!instancesLoading && !instancesError && instances.length === 0 ? (
        <EmptyState
          title="还没有实例"
          hint="新建一个实例，启动器会自动下载游戏本体、加载器与资源文件。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} />
              新建实例
            </button>
          }
        />
      ) : null}

      {instances.length > 0 ? (
        <div className="instance-grid">
          {instances.map((instance) => (
            <article key={instance.id} className="instance-card">
              <div className="instance-top">
                <img className="instance-avatar" src={logo} alt="" width={44} height={44} />
                <div className="instance-titles">
                  <h2 className="instance-name" title={instance.name}>{instance.name}</h2>
                  <p className="instance-meta">
                    <span>Minecraft {instance.mcVersion}</span>
                    <span className="dot" aria-hidden="true">·</span>
                    <span>{instanceMemory(instance)}</span>
                  </p>
                </div>
                <LoaderBadge loader={instance.loader} />
              </div>

              <dl className="instance-facts">
                <div>
                  <dt>启动版本</dt>
                  <dd>{instance.versionId}</dd>
                </div>
                <div>
                  <dt>最后启动</dt>
                  <dd>{formatRelative(instance.lastPlayedAt)}</dd>
                </div>
                {instance.loaderVersion ? (
                  <div>
                    <dt>{loaderLabel(instance.loader)} 版本</dt>
                    <dd>{instance.loaderVersion}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="instance-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-play"
                  onClick={() => void launch(instance)}
                  disabled={launchingId === instance.id}
                >
                  <IconPlay size={15} />
                  {launchingId === instance.id ? "启动中…" : "启动"}
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEditing(instance)} title="实例设置">
                  <IconSettings size={16} />
                  <span>设置</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setManagingId(instance.id)} title="管理加载器与模组">
                  <IconMods size={16} />
                  <span>管理</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => void openLogsDir(instance)} title="打开启动器日志目录（排查启动失败）">
                  <IconFolder size={16} />
                  <span>日志</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => void openModsDir(instance)} title="打开模组目录">
                  <IconFolder size={16} />
                  <span>模组目录</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setSavesId(instance.id)} title="查看存档并直接进入">
                  <IconBook size={16} />
                  <span>存档</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon btn-danger-ghost" onClick={() => setDeleting(instance)} title="删除实例">
                  <IconTrash size={16} />
                  <span>删除</span>
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <CreateInstanceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void reloadInstances()}
      />
      <EditInstanceModal
        instance={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void reloadInstances()}
      />
      <InstanceDetailDrawer
        instance={managing}
        open={managingId !== null}
        onClose={() => setManagingId(null)}
        onChanged={() => void reloadInstances()}
      />
      <SaveDrawer
        instance={savesInstance}
        open={savesId !== null}
        onClose={() => setSavesId(null)}
        onLaunched={() => void reloadInstances()}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="删除实例"
        message={deleting ? `确定删除「${deleting.name}」吗？实例配置与该实例模组目录会被移除，已下载的游戏本体会保留。` : ""}
        confirmText="删除"
        danger
        busy={busyDelete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}