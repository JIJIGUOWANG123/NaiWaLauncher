import { useCallback, useEffect, useState } from "react";
import type { InstanceMeta, SaveInfo } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes, formatDate } from "../lib/format";
import { t, useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "./Toast";
import { Drawer } from "./Drawer";
import { EmptyState, ErrorState, SkeletonRows } from "./State";
import { IconFolder, IconPlay, IconPlus } from "./icons";

/** 「新建存档」按钮的哨兵值（实际行为是启动到主菜单，由玩家在游戏内创建）。 */
const NEW_SAVE = "__new__";

/** 存档时间用「相对时间」，与实例卡上的 lastPlayedAt 文案区分开。 */
function relativeTime(timestamp: number): string {
  if (!timestamp) return t("pages.saves.timeUnknown");
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return t("pages.saves.justNow");
  if (diff < 3600 * 1000) return t("pages.saves.minutesAgo", { count: Math.floor(diff / 60000) });
  if (diff < 86400 * 1000) return t("pages.saves.hoursAgo", { count: Math.floor(diff / 3600000) });
  if (diff < 30 * 86400 * 1000) return t("pages.saves.daysAgo", { count: Math.floor(diff / 86400000) });
  return formatDate(new Date(timestamp).toISOString());
}

/** 实例存档抽屉：新建并进入 + 逐个存档直接进入。 */
export function SaveDrawer({
  instance, open, onClose, onLaunched,
}: {
  instance: InstanceMeta | null;
  open: boolean;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const { push } = useToast();
  const { info } = useApp();
  const tr = useT();
  const instanceId = instance?.id ?? null;

  const [saves, setSaves] = useState<SaveInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  // 正在进行中的目标：存档 folder，或 NEW_SAVE。
  const [entering, setEntering] = useState<string | null>(null);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!open || !instanceId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setSaves(null);
    api.instances.saves(instanceId)
      .then((list) => {
        if (!alive) return;
        setSaves(list);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, instanceId, tick]);

  const enter = async (target: string, label: string) => {
    if (!instanceId) return;
    setEntering(target);
    try {
      if (target === NEW_SAVE) {
        // Minecraft 没有「新建世界」的命令行参数（quickPlay 只可靠地进入已有存档），
        // 所以这里正常启动到主菜单，由玩家在游戏内创建世界。
        await api.instances.launch(instanceId);
        push(tr("pages.saves.launchedToMenu"), "info");
      } else {
        await api.instances.launch(instanceId, target);
        push(tr("pages.saves.enteringSave", { name: label }), "success");
      }
      onLaunched();
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    } finally {
      setEntering(null);
    }
  };

  // 存档目录固定在 <gameRoot>/instances/<id>/saves，主进程会拒绝越界路径。
  const openSavesDir = async () => {
    if (!instanceId) return;
    try {
      const gameRoot = (info ?? (await api.app.info())).gameRoot.replace(/[\\/]+$/, "");
      await api.app.openPath(`${gameRoot}/instances/${instanceId}/saves`);
      push(tr("pages.saves.openedDir"), "success");
    } catch (err: unknown) {
      push(errorMessage(err), "error");
    }
  };

  const busy = entering !== null;

  return (
    <Drawer
      open={open}
      title={tr("pages.saves.title")}
      subtitle={instance ? `Minecraft ${instance.mcVersion} · ${instance.name}` : undefined}
      onClose={onClose}
      width={620}
      footer={
        <button type="button" className="btn btn-ghost" onClick={() => void openSavesDir()}>
          <IconFolder size={16} />
          {tr("pages.saves.openDir")}
        </button>
      }
    >
      <div className="save-new">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void enter(NEW_SAVE, tr("pages.saves.newWorld"))}
          disabled={busy}
        >
          <IconPlus size={16} />
          {entering === NEW_SAVE ? tr("pages.saves.entering") : tr("pages.saves.newSave")}
        </button>
        <p className="save-new-hint">{tr("pages.saves.newSaveHint")}</p>
      </div>

      <div className="save-list-head">
        <span className="field-label">{tr("pages.saves.existing")}</span>
        {saves ? <span className="save-count">{tr("pages.saves.count", { count: saves.length })}</span> : null}
      </div>

      {loading ? <SkeletonRows count={2} /> : null}

      {!loading && error ? <ErrorState message={error} onRetry={reload} /> : null}

      {!loading && !error && saves && saves.length === 0 ? (
        <EmptyState
          title={tr("pages.saves.emptyTitle")}
          hint={tr("pages.saves.emptyHint")}
        />
      ) : null}

      {!loading && !error && saves && saves.length > 0 ? (
        <ul className="save-list">
          {saves.map((save) => (
            <li className="save-row" key={save.folder} data-save-row data-save-folder={save.folder}>
              {save.iconUrl ? (
                <img className="save-icon" src={save.iconUrl} alt="" width={40} height={40} data-save-icon="image" />
              ) : (
                <span className="save-icon save-icon-placeholder" aria-hidden="true" data-save-icon="placeholder" />
              )}
              <div className="save-main">
                <p className="save-name" title={save.name}>{save.name}</p>
                <p className="save-meta">
                  <span data-save-size>{formatBytes(save.sizeBytes)}</span>
                  <span className="dot" aria-hidden="true">·</span>
                  <span data-save-modified>{relativeTime(save.lastModified)}</span>
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon save-enter"
                onClick={() => void enter(save.folder, save.name)}
                disabled={busy}
              >
                <IconPlay size={15} />
                {entering === save.folder ? tr("pages.saves.entering") : tr("pages.saves.enter")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}
