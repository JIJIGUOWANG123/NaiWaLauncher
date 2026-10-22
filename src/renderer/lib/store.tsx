import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppInfo, InstanceMeta, Settings, UpdateCheckResult, VersionBrief } from "../../shared/types";
import { api } from "./api";
import { NO_APP_ICON, fetchAppIcon, type AppIconInfo } from "./appIcon";
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
  setCurrentInstanceId(id: string): void;
  currentInstance: InstanceMeta | null;
  /** 自定义界面图标 URL（null 表示用内置 logo），标题栏/侧边栏/启动屏共用。 */
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

  const reloadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const list = await api.instances.list();
      setInstances(list);
      setInstancesError(null);
    } catch (error: unknown) {
      setInstancesError(errorMessage(error));
    } finally {
      setInstancesLoading(false);
    }
  }, []);

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

  const setCurrentInstanceId = useCallback((id: string) => {
    setCurrentId(id);
    try {
      localStorage.setItem(INSTANCE_KEY, id);
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略即可。
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [infoResult, settingsResult, iconResult] = await Promise.all([
          api.app.info(), api.settings.get(), fetchAppIcon(),
        ]);
        if (!alive) return;
        setInfo(infoResult);
        setSettings(settingsResult);
        // 启动屏先渲染内置 logo，图标取到后自动替换。
        setIcon(iconResult);
      } catch (error: unknown) {
        if (alive) setSettingsError(errorMessage(error));
      }
      await reloadInstances();
      await reloadVersions(false);
      if (alive) setBooted(true);
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

  const currentInstance = useMemo(() => {
    if (instances.length === 0) return null;
    return instances.find((item) => item.id === currentInstanceId) ?? instances[0];
  }, [instances, currentInstanceId]);

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
    currentInstanceId: currentInstance?.id ?? currentInstanceId,
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
