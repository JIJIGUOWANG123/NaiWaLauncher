import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppInfo, InstanceMeta, Settings, UpdateCheckResult, VersionBrief } from "../../shared/types";
import { api } from "./api";
import { NO_APP_ICON, fetchAppIcon, type AppIconInfo } from "./appIcon";
import { afterFirstFrame, perfMark, perfNow, perfSince, perfTime } from "./perf";
import { errorMessage } from "./useAsync";

export type PageId = "instances" | "accounts" | "download" | "downloads" | "mods" | "net" | "java" | "personalize" | "launch" | "other" | "about" | "settings";

export interface AppContextValue {
  page: PageId;
  navigate(page: PageId): void;
  booted: boolean;
  info: AppInfo | null;
  settings: Settings | null;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  applySettings(next: Settings): void;
  settingsError: string | null;
  instances: InstanceMeta[];
  instancesLoading: boolean;
  instancesError: string | null;
  reloadInstances(): Promise<void>;
  versions: VersionBrief[] | null;
  versionsError: string | null;
  reloadVersions(force?: boolean): Promise<void>;
  currentInstanceId: string | null;
  /** 传 null（或空串）表示「不选择实例」，可以只浏览不装东西。 */
  setCurrentInstanceId(id: string | null): void;
  currentInstance: InstanceMeta | null;
  /** 自定义界面图标 URL（null 表示用内置 logo），标题栏/侧边栏/启动屏/实例头像共用。 */
  iconUrl: string | null;
  /** 对应图标文件绝对路径（null 表示未选择或文件不存在）。 */
  iconPath: string | null;
  /** 重新向主进程要一次自定义图标（设置里换了图标后调用）。 */
  reloadIcon(): Promise<void>;
  /** 最近一次更新检查结果（静默检查与关于页手动检查共用；null 表示还没查过）。 */
  update: UpdateCheckResult | null;
  setUpdate(result: UpdateCheckResult | null): void;
}

const AppContext = createContext<AppContextValue | null>(null);
const INSTANCE_KEY = "naiwa.currentInstanceId";

export function AppProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<PageId>("instances");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [instances, setInstances] = useState<InstanceMeta[]>([]);
  const [versions, setVersions] = useState<VersionBrief[] | null>(null);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [icon, setIcon] = useState<AppIconInfo>(NO_APP_ICON);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [currentInstanceId, setCurrentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(INSTANCE_KEY);
    } catch {
      return null;
    }
  });

  /** 占用统计的代次：连续 reload 时只认最后一次的结果，避免旧数据覆盖新列表。 */
  const diskUsageGeneration = useRef(0);

  /**
   * 占用统计是展示型数据（主进程要遍历实例目录），首帧之后再逐个补，不占启动链路。
   * 主进程 instances:list 只返回元数据，缺 diskUsageBytes 的在这里补齐。
   */
  const scheduleDiskUsage = useCallback((list: InstanceMeta[]) => {
    const missing = list.filter((item) => item.diskUsageBytes === undefined || item.diskUsageBytes === null);
    if (missing.length === 0) return;
    const generation = diskUsageGeneration.current + 1;
    diskUsageGeneration.current = generation;
    afterFirstFrame(() => {
      void (async () => {
        const from = perfNow();
        const settled = await Promise.all(missing.map(async (item) => {
          try {
            return { id: item.id, bytes: (await api.instances.usage(item.id)).bytes };
          } catch {
            // 统计失败就保持「计算中…」的缺省态，不影响列表本身
            return null;
          }
        }));
        if (diskUsageGeneration.current !== generation) return;
        perfSince("instances-disk-usage", from);
        setInstances((prev) => prev.map((item) => {
          const hit = settled.find((entry) => entry !== null && entry.id === item.id);
          return hit ? { ...item, diskUsageBytes: hit.bytes } : item;
        }));
      })();
    });
  }, []);

  const reloadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const list = await api.instances.list();
      setInstances(list);
      setInstancesError(null);
      scheduleDiskUsage(list);
    } catch (error: unknown) {
      setInstancesError(errorMessage(error));
    } finally {
      setInstancesLoading(false);
    }
  }, [scheduleDiskUsage]);

  const reloadVersions = useCallback(async (force?: boolean) => {
    try {
      const list = await api.versions.list(force ?? false);
      setVersions(list);
      setVersionsError(null);
    } catch (error: unknown) {
      setVersionsError(errorMessage(error));
    }
  }, []);

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    try {
      const next = await api.settings.update(patch);
      setSettings(next);
      setSettingsError(null);
    } catch (error: unknown) {
      setSettingsError(errorMessage(error));
    }
  }, []);

  const applySettings = useCallback((next: Settings) => setSettings(next), []);

  // 图标不随 settings 自动变：主进程要校验文件是否存在，改设置后显式 reloadIcon()。
  const reloadIcon = useCallback(async () => {
    setIcon(await fetchAppIcon());
  }, []);

  const setCurrentInstanceId = useCallback((id: string | null) => {
    const next = id ? id : null;
    setCurrentId(next);
    try {
      if (next) localStorage.setItem(INSTANCE_KEY, next);
      else localStorage.removeItem(INSTANCE_KEY);
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略即可。
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      perfMark("boot-start");
      try {
        const [infoResult, settingsResult, iconResult] = await Promise.all([
          perfTime("appinfo", api.app.info()),
          perfTime("settings", api.settings.get()),
          perfTime("icon", fetchAppIcon()),
        ]);
        if (!alive) return;
        setInfo(infoResult);
        setSettings(settingsResult);
        // 启动屏先渲染内置 logo，图标取到后自动替换。
        setIcon(iconResult);
      } catch (error: unknown) {
        if (alive) setSettingsError(errorMessage(error));
      }
      // 实例列表是首屏内容（默认页），必须等；版本清单只服务下拉框与新建实例弹窗，
      // 放在首帧之后拉，别让它挡着界面出来。
      await perfTime("instances", reloadInstances());
      if (!alive) return;
      setBooted(true);
      perfMark("booted");
      afterFirstFrame(() => {
        if (alive) void perfTime("versions", reloadVersions(false));
      });
    })();
    return () => {
      alive = false;
    };
  }, [reloadInstances, reloadVersions]);

  // 启动 3 秒后静默查一次更新：只写状态，不弹窗（关于页与侧边栏据此显示提示）。
  useEffect(() => {
    if (!booted) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api.app.checkUpdates();
          if (alive) setUpdate(result);
        } catch {
          // 静默检查失败就算了，用户到关于页手动检查时再报错。
        }
      })();
    }, 3000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [booted]);

  /** 记住的实例已经不在了（删掉/换目录）：清空本地记忆，回到「不选择实例」。 */
  useEffect(() => {
    if (instancesLoading || currentInstanceId === null) return;
    if (instances.some((item) => item.id === currentInstanceId)) return;
    setCurrentId(null);
    try {
      localStorage.removeItem(INSTANCE_KEY);
    } catch {
      // 同上：清不掉也不影响本次会话。
    }
  }, [instancesLoading, currentInstanceId, instances]);

  // 不做「回退到第一个实例」：允许为空，未选择时各页面自己提示去选。
  const currentInstance = useMemo(
    () => instances.find((item) => item.id === currentInstanceId) ?? null,
    [instances, currentInstanceId],
  );

  const value = useMemo<AppContextValue>(() => ({
    page,
    navigate: setPage,
    booted,
    info,
    settings,
    saveSettings,
    applySettings,
    settingsError,
    instances,
    instancesLoading,
    instancesError,
    reloadInstances,
    versions,
    versionsError,
    reloadVersions,
    currentInstanceId,
    setCurrentInstanceId,
    currentInstance,
    iconUrl: icon.url,
    iconPath: icon.path,
    reloadIcon,
    update,
    setUpdate,
  }), [
    page, booted, info, settings, saveSettings, applySettings, settingsError, instances,
    instancesLoading, instancesError, reloadInstances, versions, versionsError, reloadVersions,
    currentInstanceId, setCurrentInstanceId, currentInstance, icon, reloadIcon, update,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp 必须在 AppProvider 内使用");
  return context;
}
