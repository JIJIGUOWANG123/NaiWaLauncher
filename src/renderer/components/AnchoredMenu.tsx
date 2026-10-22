import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 浮层层级：卡片 hover 的 transform/z-index 都在 1000 以下，这里压过整页。 */
const MENU_Z_INDEX = 2000;
/** 浮层与锚点按钮之间的缝，和视口边缘的安全距离。 */
const ANCHOR_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * 挂在 document.body 上的浮层：卡片里的下拉会被后面的卡片盖住、被容器裁切，
 * 这里改成 Portal + position: fixed，用锚点按钮的 rect 定位，下方不够就向上展开。
 * 滚动（任意滚动容器）直接关闭；窗口尺寸变化用 rAF 重新定位；点外部或 Esc 也关闭。
 */
export function AnchoredMenu({
  anchor, onClose, ariaLabel, menuKey, width = 236, children,
}: {
  /** 触发浮层的按钮：位置以它的 rect 为准。 */
  anchor: HTMLElement;
  onClose: () => void;
  ariaLabel: string;
  /** 自检用：把卡片的 key 写回 DOM，断言浮层属于哪张卡片。 */
  menuKey?: string;
  width?: number;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 打开时记下锚点位置：只有锚点真的挪位才算「滚走了」，别被自己滚过去的那次滚动关掉。 */
  const anchorAt = useRef<{ top: number; left: number } | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = anchor.getBoundingClientRect();
    anchorAt.current = { top: Math.round(rect.top), left: Math.round(rect.left) };
    // 内容自然高度（此时还没有 maxHeight 限制），据此判断向下还是向上展开。
    const height = el.scrollHeight || el.offsetHeight;
    const roomBelow = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
    const roomAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;
    const openUp = height > roomBelow && roomAbove > roomBelow;
    const maxHeight = Math.max(96, openUp ? roomAbove : roomBelow);
    const used = Math.min(height, maxHeight);
    const top = openUp ? rect.top - ANCHOR_GAP - used : rect.bottom + ANCHOR_GAP;
    // 右对齐按钮；超出右边界时贴边。
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.right - width), window.innerWidth - width - VIEWPORT_MARGIN);
    setBox({ left, top, maxHeight });
  }, [anchor, width]);

  // 先用 visibility: hidden 量高度，量准后再显示，避免首帧跳位。
  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(place);
    };
    const onScroll = (event: Event) => {
      // 浮层自己的滚动（内容超高）不算「锚点丢了」。
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      // 打开前刚把卡片滚进视野：那次滚动让锚点挪位是预期的，只有真的又滚了一次才关闭。
      const rect = anchor.getBoundingClientRect();
      const known = anchorAt.current;
      if (known && Math.abs(Math.round(rect.top) - known.top) <= 1 && Math.abs(Math.round(rect.left) - known.left) <= 1) return;
      onClose();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [place, onClose]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      // 锚点按钮自己处理开合，别在按下时抢先关掉。
      if (anchor.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="res-menu"
      role="menu"
      aria-label={ariaLabel}
      data-instance-menu={menuKey}
      data-anchored-menu
      style={{
        position: "fixed",
        left: box ? box.left : 0,
        top: box ? box.top : 0,
        width,
        maxHeight: box ? box.maxHeight : undefined,
        zIndex: MENU_Z_INDEX,
        visibility: box ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
