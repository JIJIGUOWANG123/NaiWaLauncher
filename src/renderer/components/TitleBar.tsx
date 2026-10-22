import { useEffect, useState } from "react";
import type { TitleBarStyle } from "../../shared/types";
import { api } from "../lib/api";
import { iconSrc } from "../lib/appIcon";
import { mediaUrl } from "../lib/media";
import { useApp } from "../lib/store";
import { IconClose, IconMaximize, IconMinus } from "./icons";

/** titleBarText 为空时展示的默认文字。 */
export const DEFAULT_TITLE_TEXT = "奶娃启动器 NaiWa Launcher";

/**
 * 自绘标题栏：主进程窗口已无边框（系统标题栏移除），因此始终渲染。
 * compact = 主题渐变细条；image = 当前背景图做条底 + 半透明遮罩 + 主题色描边。
 * 中间空白区是拖拽区（-webkit-app-region: drag），右侧按钮区为 no-drag。
 */
export function TitleBar({
  style, text, backgroundDir, backgroundName,
}: {
  style: TitleBarStyle;
  text: string;
  backgroundDir: string;
  backgroundName: string;
}) {
  const { iconUrl } = useApp();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.window
      .isMaximized()
      .then((value) => {
        if (alive) setMaximized(value);
      })
      .catch(() => {
        // 浏览器预览没有真实窗口，忽略。
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleMaximize = async () => {
    try {
      setMaximized(await api.window.toggleMaximize());
    } catch {
      // 同上：预览模式无窗口 API。
    }
  };

  const label = text.trim() || DEFAULT_TITLE_TEXT;
  const imageUrl = style === "image" ? mediaUrl(backgroundDir, backgroundName) : "";
  const background = imageUrl ? { backgroundImage: `url("${imageUrl}")` } : undefined;

  return (
    <header
      className={`titlebar titlebar-${style} ${imageUrl ? "titlebar-has-image" : ""}`.trim()}
      style={background}
      data-titlebar-style={style}
    >
      <div className="titlebar-brand">
        <img
          className="titlebar-logo"
          src={iconSrc(iconUrl)}
          alt=""
          width={22}
          height={22}
          data-app-icon={iconUrl ? "custom" : "default"}
        />
        <strong className="titlebar-text" title={label}>{label}</strong>
      </div>

      <div className="titlebar-drag" aria-hidden="true" />

      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn"
          aria-label="最小化"
          title="最小化"
          onClick={() => void api.window.minimize()}
        >
          <IconMinus size={15} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void toggleMaximize()}
        >
          <IconMaximize size={14} />
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void api.window.close()}
        >
          <IconClose size={15} />
        </button>
      </div>
    </header>
  );
}
