import { useState } from "react";
import type { LaunchDiagnosisEvent, LaunchDiagnosisKind } from "../../shared/ipc";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

/** 诊断分类 → 文案 key：弹窗顶部的小标题用它能一眼看出「谁的问题」。 */
const KIND_LABEL: Record<LaunchDiagnosisKind, string> = {
  "gpu-driver": "pages.launchFail.kindGpu",
  cert: "pages.launchFail.kindCert",
  "java-version": "pages.launchFail.kindJava",
  memory: "pages.launchFail.kindMemory",
  "jvm-startup": "pages.launchFail.kindJvm",
  mods: "pages.launchFail.kindMods",
  unknown: "pages.launchFail.kindUnknown",
};

/**
 * 启动失败弹窗：结论 + 建议 + 可能相关的模组 + 打开日志 / 打开实例目录 / 导出诊断包。
 * 只负责渲染当前这一条，排队与去重由 App 层负责（多实例同时失败时不许连弹）。
 */
export function LaunchFailureDialog({ event, onClose }: { event: LaunchDiagnosisEvent | null; onClose(): void }) {
  const tr = useT();
  const { push } = useToast();
  const [exporting, setExporting] = useState(false);

  const exportDiagnosis = async (): Promise<void> => {
    if (!event || exporting) return;
    setExporting(true);
    try {
      const result = await api.app.exportLaunchDiagnosis(event.instanceId, event.logPath);
      // 用户在保存框点了取消：静默返回，不打扰
      if (!result.path) return;
      const saved = result.path;
      push(tr("pages.launchFail.exportDone", { path: saved }), "success", {
        label: tr("pages.launchFail.reveal"),
        onClick: () => void api.app.revealInFolder(saved),
      });
    } catch (err) {
      push(tr("pages.launchFail.exportFailed", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      open={event !== null}
      width={560}
      title={tr("pages.launchFail.title")}
      subtitle={event ? tr("pages.launchFail.subtitle", { name: event.instanceName, code: event.code === null ? "?" : event.code }) : ""}
      onClose={onClose}
      footer={
        event ? (
          <>
            <button type="button" className="btn btn-ghost" data-action="open-log" onClick={() => void api.app.revealInFolder(event.logPath)}>
              {tr("pages.launchFail.openLog")}
            </button>
            <button type="button" className="btn btn-ghost" data-action="open-dir" onClick={() => void api.app.openPath(event.gameDir)}>
              {tr("pages.launchFail.openDir")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-action="export-diagnosis"
              disabled={exporting}
              onClick={() => void exportDiagnosis()}
            >
              {exporting ? tr("pages.launchFail.exporting") : tr("pages.launchFail.exportDiagnosis")}
            </button>
            <button type="button" className="btn btn-primary" data-action="close" onClick={onClose}>
              {tr("pages.common.close")}
            </button>
          </>
        ) : null
      }
    >
      {event ? (
        <div className="launch-fail" data-launch-dialog data-launch-diagnosis={event.kind} data-launch-mods={event.mods.length}>
          <span className="launch-fail-kind">{tr(KIND_LABEL[event.kind])}</span>
          <p className="launch-fail-reason">{event.reason}</p>
          <h3 className="launch-fail-head">{tr("pages.launchFail.adviceTitle")}</h3>
          <ol className="launch-fail-advice">
            {event.advice.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {event.mods.length > 0 ? (
            <>
              <h3 className="launch-fail-head">{tr("pages.launchFail.modsTitle", { count: event.mods.length })}</h3>
              <ul className="launch-fail-mods">
                {event.mods.map((mod) => (
                  <li key={mod} data-launch-mod={mod}>
                    {mod}
                  </li>
                ))}
              </ul>
              <p className="launch-fail-note">{tr("pages.launchFail.modsNote")}</p>
            </>
          ) : null}
          <p className="launch-fail-log">{tr("pages.launchFail.logPath", { path: event.logPath })}</p>
        </div>
      ) : null}
    </Modal>
  );
}
