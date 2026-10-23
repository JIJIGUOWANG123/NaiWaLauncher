import type { ModDependency } from "../../shared/types";
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
  return (
    <Modal
      open={open}
      title="需要前置"
      subtitle={`为「${projectTitle}」补齐必需前置后才能正常工作；前置会按各自类型装进 mods / resourcepacks / shaderpacks`}
      width={480}
      onClose={() => onChoose("cancel")}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => onChoose("cancel")} data-action="deps-cancel">
            取消
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onChoose("self")} data-action="deps-self">
            仅安装本体
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onChoose("with")} data-action="deps-with">
            一并安装
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
                  <span className="badge dep-badge-builtin" data-dep-builtin title="启动器按加载器推断出来的前置">
                    内置规则
                  </span>
                ) : null}
              </span>
              {dep.installed && dep.installedFileName ? (
                <span className="dep-file" data-dep-file>{dep.installedFileName}</span>
              ) : null}
            </div>
            <span className={`badge ${dep.installed ? "dep-badge-ok" : "dep-badge-missing"}`} data-dep-badge>
              {dep.installed ? "已安装" : "将一并安装"}
            </span>
          </li>
        ))}
      </ul>
      <p className="dep-hint" data-dep-hint>已装好的前置不会重复下载，「一并安装」只补缺失的必需前置。</p>
    </Modal>
  );
}
