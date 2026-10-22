import type { ReactNode } from "react";
import type { LoaderKind, VersionBrief } from "../../shared/types";
import { loaderLabel, versionTypeLabel } from "../lib/format";

export function LoaderBadge({ loader }: { loader: LoaderKind }) {
  return <span className={`badge loader-badge loader-${loader}`}>{loaderLabel(loader)}</span>;
}

export function VersionTypeTag({ type }: { type: VersionBrief["type"] }) {
  return <span className={`badge type-tag type-${type}`}>{versionTypeLabel(type)}</span>;
}

export function ReleaseTypeTag({ type }: { type: "release" | "beta" | "alpha" }) {
  return <span className={`badge type-tag type-${type}`}>{type === "release" ? "稳定版" : type === "beta" ? "测试版" : "预览版"}</span>;
}

export function LtsTag() {
  return <span className="badge lts-tag">LTS</span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

export function MatchTag({ exact }: { exact: boolean }) {
  return exact
    ? <span className="badge match-tag">匹配当前版本</span>
    : <span className="badge muted-tag">其他版本</span>;
}
