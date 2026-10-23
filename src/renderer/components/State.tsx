import type { ReactNode } from "react";
import { useT } from "../lib/i18n";
import { IconAlert, IconRefresh } from "./icons";

export function LoadingState({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="state state-loading">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t("pages.state.loading")}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="state state-error" role="alert">
      <IconAlert size={22} />
      <div className="state-body">
        <p className="state-title">{t("pages.state.errorTitle")}</p>
        <p className="state-hint">{message}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          <IconRefresh size={16} />
          {t("pages.state.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <div className="state-body">
        <p className="state-title">{title}</p>
        {hint ? <p className="state-hint">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton-card" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-rows">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton-row" />
      ))}
    </div>
  );
}
