import { useMemo, useState } from "react";
import type { ModpackZipInfo } from "../../shared/ipc";
import type { InstanceMeta, ModContentKind } from "../../shared/types";
import { api } from "../lib/api";
import { formatBytes, formatRelative, instanceDiskUsage, instanceMemory, loaderLabel } from "../lib/format";
import { iconSrc } from "../lib/appIcon";
import { useT } from "../lib/i18n";
import { useApp } from "../lib/store";
import { errorMessage } from "../lib/useAsync";
import { useToast } from "../components/Toast";
import { LoaderBadge } from "../components/Badges";
import { ConfirmDialog, Modal } from "../components/Modal";
import { Field, TextInput } from "../components/Form";
import { CreateInstanceModal, EditInstanceModal } from "../components/InstanceModals";
import { AnchoredMenu } from "../components/AnchoredMenu";
import { InstanceDetailDrawer } from "../components/InstanceDetailDrawer";
import { ContentDrawer } from "../components/ContentDrawer";
import { SaveDrawer } from "../components/SaveDrawer";
import { EmptyState, ErrorState, SkeletonCards } from "../components/State";
import {
  IconBook, IconDownload, IconFolder, IconList, IconMods, IconPackage, IconPlay, IconPlus, IconRefresh, IconSettings, IconTrash,
} from "../components/icons";

/** 「资源目录」下拉里的三项：label 存 i18n key，目录名原样保留。 */
const CONTENT_DIRS: Array<{ kind: ModContentKind; labelKey: string; short: string }> = [
  { kind: "mod", labelKey: "pages.instances.dirMods", short: "mods" },
  { kind: "shader", labelKey: "pages.instances.dirShaders", short: "shaderpacks" },
  { kind: "resourcepack", labelKey: "pages.instances.dirResourcepacks", short: "resourcepacks" },
];

export function InstancesPage() {
  const { info, instances, instancesLoading, instancesError, reloadInstances, iconUrl } = useApp();
  const { push } = useToast();
  const t = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<InstanceMeta | null>(null);
  const [deleting, setDeleting] = useState<InstanceMeta | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  // 「资源目录」下拉：记下被点的按钮当锚点，浮层 Portal 到 body 才不会被卡片裁切。
  const [dirMenu, setDirMenu] = useState<{ instance: InstanceMeta; anchor: HTMLElement; name: string } | null>(null);
  // 导出先过确认弹窗：exporting 存待导出实例，busyExport 控制「导出中…」。
  const [exporting, setExporting] = useState<InstanceMeta | null>(null);
  const [busyExport, setBusyExport] = useState(false);
  const [importing, setImporting] = useState(false);
  // 整合包压缩包：选包后先识别，把「这是什么包」摆给用户看，确认才真装。
  const [pack, setPack] = useState<{ zipPath: string; info: ModpackZipInfo } | null>(null);
  const [packName, setPackName] = useState("");
  const [packPicking, setPackPicking] = useState(false);
  const [packBusy, setPackBusy] = useState(false);
  // 只存 id：reloadInstances 之后抽屉拿到的永远是最新实例对象（加载器徽标随之更新）。
  const [managingId, setManagingId] = useState<string | null>(null);
  // 同理只存 id：存档抽屉要拿最新的实例对象。
  const [savesId, setSavesId] = useState<string | null>(null);
  const savesInstance = useMemo(
    () => (savesId ? instances.find((item) => item.id === savesId) ?? null : null),
    [instances, savesId],
  );
  // 内容管理（模组 / 光影包 / 资源包）独立成抽屉，同样只存 id。
  const [contentId, setContentId] = useState<string | null>(null);
  const contentInstance = useMemo(
    () => (contentId ? instances.find((item) => item.id === contentId) ?? null : null),
    [instances, contentId],
  );
  const managing = useMemo(
    () => (managingId ? instances.find((item) => item.id === managingId) ?? null : null),
    [instances, managingId],
  );

  const launch = async (instance: InstanceMeta) => {
    setLaunchingId(instance.id);
    try {
      await api.instances.launch(instance.id);
      push(t("pages.instances.launched", { name: instance.name }), "success");
      push(t("pages.instances.launchHint"), "info");
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
      push(t("pages.instances.logsOpened"), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  /**
   * 实例里的三类内容目录都在游戏目录下，主进程负责 resolve 与越界拒绝。
   * 按钮统一叫「资源目录」，点开后再选具体是哪一类。
   */
  const openContentDir = async (instance: InstanceMeta, kind: ModContentKind, label: string, folder: string) => {
    try {
      await api.app.openInstanceContent(instance.id, kind);
      push(t("pages.instances.contentDirOpened", { label, folder }), "success");
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  // 导出的 zip 常在启动器根目录之外（默认落在系统下载目录），openPath 的根目录守卫会拒绝，
  // 所以这里走 revealInFolder：直接把文件交给系统资源管理器定位，传完整文件路径。
  const revealExport = async (filePath: string) => {
    try {
      await api.app.revealInFolder(filePath);
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    }
  };

  const confirmExport = async () => {
    if (!exporting) return;
    setBusyExport(true);
    try {
      const result = await api.instances.exportArchive(exporting.id);
      const filePath = result.path;
      // 用户取消保存对话框时 path 为 null：按约定不打扰。
      if (!filePath) return;
      push(t("pages.instances.exported", { path: filePath }), "success", {
        label: t("pages.instances.showInFolder"),
        onClick: () => void revealExport(filePath),
      });
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setBusyExport(false);
      // 成功、取消、失败都把确认弹窗关掉：失败信息交给 toast，避免弹窗挡住后续操作。
      setExporting(null);
    }
  };

  // 文件选择框由主进程弹，渲染层只负责收结果与刷新列表。
  const importArchive = async () => {
    setImporting(true);
    try {
      const result = await api.instances.importArchive();
      // 用户取消（instanceId 为 null）同样不提示。
      if (!result.instanceId) return;
      push(t("pages.instances.imported", { name: result.name }), "success");
      if (result.installedMissing) push(t("pages.instances.bootstrapInstalled"), "info");
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setImporting(false);
    }
  };

  // 选包 + 识别：文件选择框由主进程弹，回来的是「这是什么整合包」的元信息。
  const pickModpack = async () => {
    setPackPicking(true);
    try {
      const result = await api.modpacks.inspectLocal();
      if (result.canceled || !result.info || !result.zipPath) return;
      if (!result.info.installable) {
        push(result.info.reason ?? t("pages.instances.importPackUnsupported"), "error");
        return;
      }
      setPackName(result.info.name);
      setPack({ zipPath: result.zipPath, info: result.info });
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPackPicking(false);
    }
  };

  const confirmModpack = async () => {
    if (!pack) return;
    setPackBusy(true);
    try {
      const result = await api.modpacks.installLocal(pack.zipPath, packName.trim() || undefined);
      push(t("pages.instances.importPackDone", { name: result.name, done: result.downloaded, overrides: result.overridesExtracted }), "success");
      push(t("pages.instances.importPackProgress"), "info");
      if (result.failed.length > 0) {
        push(t("pages.instances.importPackPartial", {
          count: result.failed.length,
          list: result.failed.slice(0, 3).map((item) => item.path).join("、"),
        }), "info");
      }
      await reloadInstances();
    } catch (error: unknown) {
      push(errorMessage(error), "error");
    } finally {
      setPackBusy(false);
      setPack(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyDelete(true);
    try {
      await api.instances.remove(deleting.id);
      push(t("pages.instances.deleted", { name: deleting.name }), "success");
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
          <h1 className="page-title">{t("pages.instances.title")}</h1>
          <p className="page-sub">{t("pages.instances.sub")}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={() => void reloadInstances()} disabled={instancesLoading}>
            <IconRefresh size={16} />
            {t("pages.instances.refresh")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void importArchive()} disabled={importing}>
            <IconDownload size={16} />
            {importing ? t("pages.instances.importing") : t("pages.instances.import")}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-import-modpack
            onClick={() => void pickModpack()}
            disabled={packPicking || packBusy}
            title={t("pages.instances.importPackTitle")}
          >
            <IconPackage size={16} />
            {packPicking ? t("pages.instances.importPackPicking") : t("pages.instances.importPack")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={16} />
            {t("pages.instances.create")}
          </button>
        </div>
      </header>

      {instancesLoading && instances.length === 0 ? <SkeletonCards count={3} /> : null}

      {instancesError ? <ErrorState message={instancesError} onRetry={() => void reloadInstances()} /> : null}

      {!instancesLoading && !instancesError && instances.length === 0 ? (
        <EmptyState
          title={t("pages.instances.emptyTitle")}
          hint={t("pages.instances.emptyHint")}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} />
              {t("pages.instances.create")}
            </button>
          }
        />
      ) : null}

      {instances.length > 0 ? (
        <div className="instance-grid">
          {instances.map((instance) => (
            <article key={instance.id} className="instance-card">
              <div className="instance-top">
                {/* 实例图标跟随「界面图标」：选了自定义 logo 后卡片头像同步换图 */}
                <img
                  className="instance-avatar"
                  src={iconSrc(iconUrl)}
                  alt=""
                  width={44}
                  height={44}
                  data-instance-avatar
                  data-app-icon={iconUrl ? "custom" : "default"}
                />
                <div className="instance-titles">
                  <h2 className="instance-name" title={instance.name}>{instance.name}</h2>
                  {/* 运存 / 本地占用分两段：窄卡片放不下时整段换行，不挤压标题。 */}
                  <p className="instance-meta" data-instance-meta>
                    <span className="instance-meta-item">Minecraft {instance.mcVersion}</span>
                    <span className="instance-meta-item">
                      {t("pages.instances.memory", { value: instanceMemory(instance) })}
                    </span>
                    <span
                      className="instance-meta-item instance-disk"
                      data-disk-state={
                        instance.diskUsageBytes === undefined || instance.diskUsageBytes === null
                          ? "pending"
                          : instance.diskUsageBytes === 0 ? "zero" : "known"
                      }
                      title={t("pages.instances.diskTitle")}
                    >
                      {t("pages.instances.diskUsage", { value: instanceDiskUsage(instance, t) })}
                    </span>
                  </p>
                </div>
                <LoaderBadge loader={instance.loader} />
              </div>

              <dl className="instance-facts">
                <div>
                  <dt>{t("pages.instances.launchVersion")}</dt>
                  <dd>{instance.versionId}</dd>
                </div>
                <div>
                  <dt>{t("pages.instances.lastPlayed")}</dt>
                  <dd>{formatRelative(instance.lastPlayedAt, t)}</dd>
                </div>
                {instance.loaderVersion ? (
                  <div>
                    <dt>{t("pages.instances.loaderVersion", { loader: loaderLabel(instance.loader, t) })}</dt>
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
                  {launchingId === instance.id ? t("pages.instances.launching") : t("pages.instances.launch")}
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEditing(instance)} title={t("pages.instances.settingsTitle")}>
                  <IconSettings size={16} />
                  <span>{t("pages.instances.settings")}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setManagingId(instance.id)} title={t("pages.instances.manageTitle")}>
                  <IconMods size={16} />
                  <span>{t("pages.instances.manage")}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-action="open-content"
                  onClick={() => setContentId(instance.id)}
                  title={t("pages.instances.contentTitle")}
                >
                  <IconList size={16} />
                  <span>{t("pages.instances.content")}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => void openLogsDir(instance)} title={t("pages.instances.logsTitle")}>
                  <IconFolder size={16} />
                  <span>{t("pages.instances.logs")}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-haspopup="menu"
                  aria-expanded={dirMenu?.instance.id === instance.id}
                  data-action="open-content-dir"
                  onClick={(event) => setDirMenu({ instance, anchor: event.currentTarget, name: instance.name })}
                  title={t("pages.instances.contentDirTitle")}
                >
                  <IconFolder size={16} />
                  <span>{t("pages.instances.contentDir")}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setSavesId(instance.id)} title={t("pages.instances.savesTitle")}>
                  <IconBook size={16} />
                  <span>{t("pages.instances.saves")}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon" onClick={() => setExporting(instance)} title={t("pages.instances.exportTitle")}>
                  <IconPackage size={16} />
                  <span>{t("pages.instances.export")}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon btn-danger-ghost" onClick={() => setDeleting(instance)} title={t("pages.instances.deleteTitle")}>
                  <IconTrash size={16} />
                  <span>{t("pages.instances.delete")}</span>
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
      <ContentDrawer
        instance={contentInstance}
        open={contentId !== null}
        onClose={() => setContentId(null)}
      />
      <SaveDrawer
        instance={savesInstance}
        open={savesId !== null}
        onClose={() => setSavesId(null)}
        onLaunched={() => void reloadInstances()}
      />
      {/* 整合包压缩包确认框：先把识别出的元信息摆出来，用户看清了再装 */}
      <Modal
        open={pack !== null}
        title={t("pages.instances.importPackTitle")}
        subtitle={pack?.zipPath ?? undefined}
        width={560}
        onClose={() => {
          if (!packBusy) setPack(null);
        }}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setPack(null)} disabled={packBusy}>
              {t("pages.common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-import-modpack-confirm
              onClick={() => void confirmModpack()}
              disabled={packBusy}
            >
              {packBusy ? t("pages.instances.importPackInstalling") : t("pages.instances.importPackConfirm")}
            </button>
          </>
        }
      >
        {pack ? (
          <div data-import-modpack-info>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackFormat")}</span>
              <span data-import-modpack-format>{pack.info.format}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackVersion")}</span>
              <span>{pack.info.version || t("pages.instances.importPackVersionUnknown")}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackMcVersion")}</span>
              <span>{pack.info.mcVersion}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackLoader")}</span>
              <span>{loaderLabel(pack.info.loader, t) + (pack.info.loaderVersion ? ` ${pack.info.loaderVersion}` : "")}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackFiles")}</span>
              <span>{t("pages.instances.importPackFileCount", { count: pack.info.fileCount })}</span>
            </div>
            <div className="field">
              <span className="field-label">{t("pages.instances.importPackSize")}</span>
              <span>{formatBytes(pack.info.sizeBytes)}</span>
            </div>
            <Field label={t("pages.instances.importPackInstanceName")} hint={t("pages.instances.importPackInstanceNameHint")}>
              <TextInput
                value={packName}
                onChange={(event) => setPackName(event.target.value)}
                placeholder={pack.info.name}
                disabled={packBusy}
              />
            </Field>
            <p className="field-hint">{t("pages.instances.importPackHint")}</p>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={exporting !== null}
        title={t("pages.instances.exportDialogTitle")}
        message={t("pages.instances.exportDialogMessage")}
        confirmText={t("pages.instances.export")}
        busyText={t("pages.instances.exporting")}
        busy={busyExport}
        onCancel={() => setExporting(null)}
        onConfirm={() => void confirmExport()}
      />
      {dirMenu ? (
        <AnchoredMenu
          anchor={dirMenu.anchor}
          onClose={() => setDirMenu(null)}
          ariaLabel={t("pages.instances.contentMenuLabel")}
          menuKey={dirMenu.instance.id}
          width={208}
        >
          <span className="res-menu-title">{t("pages.instances.contentMenuTitle", { name: dirMenu.name })}</span>
          {CONTENT_DIRS.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className="res-menu-item"
              data-menu-dir={item.kind}
              onClick={() => {
                const target = dirMenu.instance;
                setDirMenu(null);
                void openContentDir(target, item.kind, t(item.labelKey), item.short);
              }}
            >
              <span className="res-menu-name">{t(item.labelKey)}</span>
              <span className="res-menu-meta">{item.short}</span>
            </button>
          ))}
        </AnchoredMenu>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t("pages.instances.deleteTitle")}
        message={deleting ? t("pages.instances.deleteMessage", { name: deleting.name }) : ""}
        confirmText={t("pages.instances.delete")}
        danger
        busy={busyDelete}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}