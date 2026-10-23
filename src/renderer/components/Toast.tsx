import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { t } from "../lib/i18n";

type Tone = "success" | "error" | "info";

/** 提示条上的可选动作（如导出成功后的「打开所在文件夹」）。 */
export interface ToastAction {
  label: string;
  onClick(): void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: ToastAction;
}

interface ToastValue {
  push(message: string, tone?: Tone, action?: ToastAction): void;
}

const ToastContext = createContext<ToastValue | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((message: string, tone: Tone = "info", action?: ToastAction) => {
    seq += 1;
    const id = seq;
    setItems((prev) => [...prev, { id, message, tone, action }]);
    // 带动作的提示条要留够点击时间，否则用户还没伸手就消失了。
    window.setTimeout(() => dismiss(id), action ? 9000 : 4200);
  }, [dismiss]);

  const value = useMemo<ToastValue>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`} onClick={() => dismiss(item.id)}>
            <span className="toast-msg">{item.message}</span>
            {item.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={(event) => {
                  // 点动作按钮不能顺带触发整条 toast 的点击（那会先卸载掉按钮）。
                  event.stopPropagation();
                  dismiss(item.id);
                  item.action?.onClick();
                }}
              >
                {item.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error(t("pages.common.toastProviderMissing"));
  return context;
}
