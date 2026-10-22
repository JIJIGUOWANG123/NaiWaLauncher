import type { ReactNode } from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconInstances(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v11" />
      <path d="m7.2 10.2 4.8 4.8 4.8-4.8" />
      <path d="M4 20.2h16" />
    </Svg>
  );
}

export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20" />
      <path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" />
    </Svg>
  );
}

export function IconMods(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <path d="M17 13v8M13 17h8" />
    </Svg>
  );
}

export function IconJava(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9h12v4.5A4.5 4.5 0 0 1 11.5 18h-3A4.5 4.5 0 0 1 4 13.5Z" />
      <path d="M16 10h1.4a2.3 2.3 0 0 1 0 4.6H16" />
      <path d="M7.5 3.4v2.4M11.5 3.4v2.4" />
      <path d="M3 21h14" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.4M12 19v2.4M4.4 6.9l2.1 1.2M17.5 15.9l2.1 1.2M4.4 17.1l2.1-1.2M17.5 8.1l2.1-1.2" />
    </Svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 4.8 19 12 7.5 19.2Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6.8h16" />
      <path d="M9.2 6.8V4.6h5.6v2.2" />
      <path d="M6.3 6.8 7.3 20h9.4l1-13.2" />
    </Svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h3.8l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.4" />
      <path d="m16 16 4.6 4.6" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.8 4.6 4.6L19 6.6" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.2 2.8 19.8h18.4Z" />
      <path d="M12 9.6v4.2" />
      <path d="M12 17.1v.1" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11.2A8 8 0 1 0 17.4 17" />
      <path d="M20 4.8v6.4h-6.4" />
    </Svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l16 16" />
      <path d="M10.7 6.2A9.9 9.9 0 0 1 12 6.1c6 0 9.4 5.9 9.4 5.9a17 17 0 0 1-2.3 3" />
      <path d="M6.6 8.3C3.9 10 2.6 12 2.6 12S6 17.9 12 17.9c1.5 0 2.9-.4 4.1-1" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  );
}

export function IconPackage(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 3.6 7.5v9L12 21l8.4-4.5v-9Z" />
      <path d="m3.6 7.5 8.4 4.5 8.4-4.5" />
      <path d="M12 12v9" />
    </Svg>
  );
}

export function IconZap(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.4 2.4 4.8 14h5.4l-1.6 7.6L17.2 10h-5.4Z" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconPalette(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.3 0 2-.9 2-1.9 0-.6-.3-1-.3-1.6 0-.8.6-1.4 1.5-1.4h1.3a4.3 4.3 0 0 0 4.3-4.3c0-4.6-4-8.4-8.8-8.4Z" />
      <circle cx="8.1" cy="9.6" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.7" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="9.7" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="13.6" r="1.15" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconMaximize(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="2" />
    </Svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconRocket(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.6 3.5c3.1 1.2 5.6 3.7 6.8 6.8-2 4.5-5.6 7.6-9.9 9l-3.4-3.4c1.4-4.3 4.5-7.9 9-9.9Z" />
      <circle cx="15.2" cy="8.8" r="1.7" />
      <path d="M7.1 16.9c-1.4 1.4-1.7 3.6-1.7 3.6s2.2-.3 3.6-1.7" />
      <path d="M4.6 12.4 3 11l3-3 1.4 1.6" />
    </Svg>
  );
}

/** 联机：Wi‑Fi 信号弧。 */
export function IconWifi(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 8.5a14.2 14.2 0 0 1 18.8 0" />
      <path d="M5.9 12.2a9.3 9.3 0 0 1 12.2 0" />
      <path d="M9.1 15.9a4.5 4.5 0 0 1 5.8 0" />
      <circle cx="12" cy="19.2" r="1.15" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h8M18 7h2M4 12h3M13 12h7M4 17h11M21 17h0.1" />
      <circle cx="15" cy="7" r="2.1" />
      <circle cx="10" cy="12" r="2.1" />
      <circle cx="18" cy="17" r="2.1" />
    </Svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.2" r="3.8" />
      <path d="M4.6 20.2c0-3.7 3.3-6.2 7.4-6.2s7.4 2.5 7.4 6.2" />
    </Svg>
  );
}

/** 存档：书架/箱子形状的入口图标。 */
export function IconBook(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5.5h6.2A1.8 1.8 0 0 1 12 7.3v11.2a1.8 1.8 0 0 0-1.8-1.8H4Z" />
      <path d="M20 5.5h-6.2A1.8 1.8 0 0 0 12 7.3v11.2a1.8 1.8 0 0 1 1.8-1.8H20Z" />
    </Svg>
  );
}

/** 关于页：圆形信息图标。 */
export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5.1" />
      <circle cx="12" cy="7.9" r="0.95" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 项目主页：两节链条。 */
export function IconLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.1 13.9a3.9 3.9 0 0 0 5.5 0l2.6-2.6a3.9 3.9 0 0 0-5.5-5.5l-1.4 1.4" />
      <path d="M13.9 10.1a3.9 3.9 0 0 0-5.5 0l-2.6 2.6a3.9 3.9 0 0 0 5.5 5.5l1.4-1.4" />
    </Svg>
  );
}

/** 皮肤文件：相框 + 山峦。 */
export function IconImage(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2.2" />
      <circle cx="9" cy="9.8" r="1.4" />
      <path d="m4.6 17.4 4.5-4.2 3.2 2.9 3.1-2.6 4 3.6" />
    </Svg>
  );
}

/** 皮肤：一件短袖上衣。 */
export function IconSkin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.4 4.6 4.2 6.9a2.4 2.4 0 0 0-1.1 3l.9 2 2.2-1v8.1h11.6v-8.1l2.2 1 .9-2a2.4 2.4 0 0 0-1.1-3L15.6 4.6" />
      <path d="M9 4.6a3 3 0 0 0 6 0" />
    </Svg>
  );
}

/** 问题反馈：对话气泡。 */
export function IconMessage(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.4 12.2c0 3.6-3.6 6.5-8.1 6.5-1 0-2-.2-2.9-.5l-4.3 1.6 1.4-3.5c-1.3-1.2-2-2.7-2-4.1 0-3.6 3.6-6.5 8.1-6.5s7.8 3 7.8 6.5Z" />
    </Svg>
  );
}
