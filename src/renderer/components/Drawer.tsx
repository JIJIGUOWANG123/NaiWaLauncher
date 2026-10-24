import { useEffect, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { IconClose } from "./icons";

export function Drawer({
  open, title, subtitle, headActions, onClose, children, footer, width,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  /** 头部动作区：渲染在标题右侧、关闭按钮左侧（详情页的「MCMOD 搜索」等）。 */
  headActions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 内容较多的抽屉（如实例详情）可加宽，默认沿用样式表里的 560px。 */
  width?: number;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="overlay overlay-right"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <header className="drawer-head">
          <div className="drawer-titles">
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          {headActions ? <div className="drawer-head-actions">{headActions}</div> : null}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("pages.common.close")}>
            <IconClose size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}