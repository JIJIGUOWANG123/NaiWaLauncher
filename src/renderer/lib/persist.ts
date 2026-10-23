import { useCallback } from "react";
import type { Settings } from "../../shared/types";
import { api } from "./api";
import { useT } from "./i18n";
import { useApp } from "./store";
import { errorMessage } from "./useAsync";
import { useToast } from "../components/Toast";

/**
 * 写入 settings 后立刻回读，逐字段比对 patch / 写入值 / 回读值，
 * 并把回读结果回写全局状态。设置页与个性化页共用同一套机制。
 * label 由调用方传入（已经是译文），这里只负责套三语模板。
 */
export function usePersist(): (patch: Partial<Settings>, label: string) => Promise<boolean> {
  const { applySettings } = useApp();
  const { push } = useToast();
  const tr = useT();

  return useCallback(
    async (patch: Partial<Settings>, label: string): Promise<boolean> => {
      try {
        const written = await api.settings.update(patch);
        const confirmed = await api.settings.get();
        applySettings(confirmed);
        const keys = Object.keys(patch) as Array<keyof Settings>;
        const separator = tr("pages.persist.separator");
        const mismatch = keys.filter(
          (key) => String(confirmed[key]) !== String(patch[key]) || String(confirmed[key]) !== String(written[key]),
        );
        if (mismatch.length > 0) {
          push(tr("pages.persist.mismatch", { label, fields: mismatch.join(separator) }), "error");
          return false;
        }
        const fields = keys.map((key) => `${key}=${String(confirmed[key])}`).join(separator);
        push(tr("pages.persist.saved", { label, fields }), "success");
        return true;
      } catch (error: unknown) {
        push(tr("pages.persist.failed", { error: errorMessage(error) }), "error");
        return false;
      }
    },
    [applySettings, push, tr],
  );
}
