import type { ReactNode } from "react";
import type { LoaderKind, VersionBrief } from "../../shared/types";
import { loaderLabel, versionTypeLabel } from "../lib/format";
import { useT } from "../lib/i18n";

export function LoaderBadge({ loader }: { loader: LoaderKind }) {
  const t = useT();
  return <span className={`badge loader-badge loader-${loader}`}>{loaderLabel(loader, t)}</span>;
}

export function VersionTypeTag({ type }: { type: VersionBrief["type"] }) {
  const t = useT();
  return <span className={`badge type-tag type-${type}`}>{versionTypeLabel(type, t)}</span>;
}

const RELEASE_KEY: Record<"release" | "beta" | "alpha", string> = {
  release: "pages.badges.stable",
  beta: "pages.badges.beta",
  alpha: "pages.badges.alpha",
};

export function ReleaseTypeTag({ type }: { type: "release" | "beta" | "alpha" }) {
  const t = useT();
  return <span className={`badge type-tag type-${type}`}>{t(RELEASE_KEY[type])}</span>;
}

export function LtsTag() {
  return <span className="badge lts-tag">LTS</span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

export function MatchTag({ exact }: { exact: boolean }) {
  const t = useT();
  return exact
    ? <span className="badge match-tag">{t("pages.badges.matchExact")}</span>
    : <span className="badge muted-tag">{t("pages.badges.matchOther")}</span>;
}
