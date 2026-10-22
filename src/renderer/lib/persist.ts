import { useCallback } from "react";
import type { Settings } from "../../shared/types";
import { api } from "./api";
import { useApp } from "./store";
import { errorMessage } from "./useAsync";
import { useToast } from "../components/Toast";

/**
 * 写入 settings 后立刻回读，逐字段比对 patch / 写入值 / 回读值，
 * 并把回读结果回写全局状态。设置页与个性化页共用同一套机制。
 */
export function usePersist(): (patch: Partial<Settings>, label: string) => Promise<boolean> {
  const { applySettings } = useApp();
  const { push } = useToast();

  return useCallback(
    async (patch: Partial<Settings>, label: string): Promise<boolean> => {
      try {
        const written = await api.settings.update(patch);
        const confirmed = await api.settings.get();
        applySettings(confirmed);
        const keys = Object.keys(patch) as Array<keyof Settings>;
        const mismatch = keys.filter(
          (key) => String(confirmed[key]) !== String(patch[key]) || String(confirmed[key]) !== String(written[key]),
        );
        if (mismatch.length > 0) {
          push(`${label}回读校验失败（${mismatch.join("，")}），请检查 config/settings.json`, "error");
          return false;
        }
        push(`${label}已保存，回读确认：${keys.map((key) => `${key}=${String(confirmed[key])}`).join("，")}`, "success");
        return true;
      } catch (error: unknown) {
        push(errorMessage(error), "error");
        return false;
      }
    },
    [applySettings, push],
  );
}
