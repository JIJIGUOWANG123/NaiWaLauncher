import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../lib/i18n";

type Tone = "success" | "error" | "info";

/** 两条队列：默认（顶部居中）与右上角浮条（下载结果用）。 */
type Placement = "top-center" | "top-right";

/** 提示条上的可选动作（如导出成功后的「打开所在文件夹」）。 */
export interface ToastAction {
  label: string;
  onClick(): void;
}

/** 位置与节奏的额外选项：不给就是原来的顶部居中提示条。 */
export interface ToastOptions {
  /** top-right：右上角浮条（下载完成/失败用它，不挡中间的界面操作）。 */
  placement?: Placement;
  /** 停留时长（毫秒）；默认带动作 9s、不带动作 4.2s。 */
  durationMs?: number;
  /** 同一个 slot 只保留一条：新的直接顶掉旧的（不叠加）。 */
  slot?: string;
  /** 额外写到根节点的 data-* 属性，便于自检（如 data-dl-toast）。 */
  data?: Record<string, string>;
}

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: ToastAction;
  placement: Placement;
  slot?: string;
  data?: Record<string, string>;
  /** 正在淡出：动画期间仍留在 DOM 里，动画结束才卸载。 */
  leaving?: boolean;
}

interface ToastValue {
  push(message: string, tone?: Tone, action?: ToastAction, options?: ToastOptions): void;
}

const ToastContext = createContext<ToastValue | null>(null);
let seq = 0;

/** 淡出时长，与 overlays.css 里的 toast-out / dl-toast-out 保持一致。 */
const FADE_OUT_MS = 300;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  /** 先标记 leaving 让它淡出，动画跑完再从列表里摘掉。 */
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    const timer = window.setTimeout(() => remove(id), FADE_OUT_MS);
    timers.current.set(id, timer);
  }, [remove]);

  const push = useCallback((message: string, tone: Tone = "info", action?: ToastAction, options?: ToastOptions) => {
    seq += 1;
    const id = seq;
    const item: ToastItem = {
      id,
      message,
      tone,
      action,
      placement: options?.placement ?? "top-center",
      slot: options?.slot,
      data: options?.data,
    };
    setItems((prev) => [
      // 同一 slot 最多一条：新提示顶掉旧的（连它的定时器一起清掉）
      ...prev.filter((existing) => {
        if (!options?.slot || existing.slot !== options.slot) return true;
        const timer = timers.current.get(existing.id);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timers.current.delete(existing.id);
        }
        return false;
      }),
      item,
    ]);
    // 带动作的提示条要留够点击时间，否则用户还没伸手就消失了。
    const hold = options?.durationMs ?? (action ? 9000 : 4200);
    const timer = window.setTimeout(() => dismiss(id), hold);
    timers.current.set(id, timer);
  }, [dismiss]);

  const value = useMemo<ToastValue>(() => ({ push }), [push]);

  const stack = (placement: Placement) => {
    const list = items.filter((item) => item.placement === placement);
    if (list.length === 0) return null;
    return (
      <div
        className={`toast-stack ${placement === "top-right" ? "toast-stack-tr" : ""}`.trim()}
        role="status"
        aria-live="polite"
      >
        {list.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.tone} ${item.leaving ? "toast-leaving" : ""}`.trim()}
            {...(item.data ?? {})}
            onClick={() => dismiss(item.id)}
          >
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
    );
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {stack("top-center")}
      {stack("top-right")}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error(t("pages.common.toastProviderMissing"));
  return context;
}
