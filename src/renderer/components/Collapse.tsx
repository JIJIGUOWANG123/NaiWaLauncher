import { useState, type ReactNode } from "react";
import { IconChevronDown } from "./icons";

/** 折叠面板：离线皮肤、高级选项这类低频设置默认收起，保持页面像 PCL2 一样紧凑。 */
export function Collapse({
  title, hint, children, defaultOpen = false,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel collapse-panel">
      <button
        type="button"
        className="collapse-head"
        aria-expanded={open}
        data-collapse={title}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="panel-title">{title}</span>
        {hint ? <span className="panel-count">{hint}</span> : null}
        <IconChevronDown size={16} className={`collapse-icon ${open ? "open" : ""}`} />
      </button>
      {open ? <div className="collapse-body">{children}</div> : null}
    </section>
  );
}
