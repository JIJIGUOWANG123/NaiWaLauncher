import type { ModDependency } from "../../shared/types";
import { useT } from "../lib/i18n";
import { Modal } from "./Modal";

/** 前置确认的三种选择：连带安装 / 只装本体 / 取消。 */
export type DepsChoice = "with" | "self" | "cancel";

/** 前置名展示优先级：中文名 → 原名 → 项目 id。 */
export function dependencyName(dep: ModDependency): string {
  return dep.nameZh ?? dep.name ?? dep.projectId;
}

/**
 * 安装前的必需前置确认框：每行一个前置 + 状态徽标，三个按钮交给调用方。
 * 详情面板与文件列表行内「安装」共用这一个组件。
 */
export function ModDepsDialog({
  open, deps, projectTitle, onChoose,
}: {
  open: boolean;
  deps: ModDependency[];
  projectTitle: string;
  onChoose: (choice: DepsChoice) => void;
}) {
  const t = useT();
  return (
    <Modal
      open={open}
      title={t("pages.modDeps.title")}
      subtitle={t("pages.modDeps.subtitle", { title: projectTitle })}
      width={480}
      onClose={() => onChoose("cancel")}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => onChoose("cancel")} data-action="deps-cancel">
            {t("pages.common.cancel")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onChoose("self")} data-action="deps-self">
            {t("pages.modDeps.self")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onChoose("with")} data-action="deps-with">
            {t("pages.modDeps.with")}
          </button>
        </>
      }
    >
      <ul className="dep-list" data-dep-list>
        {deps.map((dep) => (
          <li
            key={`${dep.provider}-${dep.projectId}`}
            className="dep-row"
            data-dep-row
            data-dep-state={dep.installed ? "installed" : "missing"}
          >
            <div className="dep-main">
              <span className="dep-title">
                <span className="dep-name" data-dep-name>{dependencyName(dep)}</span>
                {dep.origin === "builtin" ? (
                  <span className="badge dep-badge-builtin" data-dep-builtin title={t("pages.modDeps.builtinHint")}>
                    {t("pages.modDeps.builtin")}
                  </span>
                ) : null}
              </span>
              {dep.installed && dep.installedFileName ? (
                <span className="dep-file" data-dep-file>{dep.installedFileName}</span>
              ) : null}
            </div>
            <span className={`badge ${dep.installed ? "dep-badge-ok" : "dep-badge-missing"}`} data-dep-badge>
              {dep.installed ? t("pages.modDeps.installed") : t("pages.modDeps.willInstall")}
            </span>
          </li>
        ))}
      </ul>
      <p className="dep-hint" data-dep-hint>{t("pages.modDeps.hint")}</p>
    </Modal>
  );
}
