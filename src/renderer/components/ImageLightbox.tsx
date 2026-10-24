import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { IconAlert, IconChevronRight, IconClose } from "./icons";

/** 滚轮缩放：1x–4x，单步 0.25；双击回到 1x。 */
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

/** 平移量（屏幕像素，未经缩放：transform 里 translate 写在 scale 左边）。 */
type Pan = { x: number; y: number };

const clampZoom = (value: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

/**
 * 平移约束：1x 时不平移（归零）；放大后单轴最多拖出「缩放多出来的那一半」，
 * 即 limit = (zoom - 1) × 布局尺寸 / 2，正好让图像边缘停在未放大的原地，
 * 既能看到边缘细节，又不会把图拖到只剩一角。
 */
function clampPan(pan: Pan, zoom: number, image: HTMLImageElement | null): Pan {
  if (!image || zoom <= ZOOM_MIN) return { x: 0, y: 0 };
  const limitX = ((zoom - 1) * image.offsetWidth) / 2;
  const limitY = ((zoom - 1) * image.offsetHeight) / 2;
  return {
    x: Math.min(limitX, Math.max(-limitX, pan.x)),
    y: Math.min(limitY, Math.max(-limitY, pan.y)),
  };
}

/**
 * 全屏图片灯箱。
 *
 * 层级：用 Portal 挂到 document.body，自己铺满整个视口（z-index 见 overlays.css 的 .lightbox）。
 * 不放进抽屉的 DOM 里，是因为 .overlay 的 backdrop-filter 会成为 fixed 后代的包含块，
 * 那样灯箱只能盖住抽屉占的那块区域，也盖不住标题栏。
 */
export function ImageLightbox({
  images, index, onClose, onIndex, alt,
}: {
  images: string[];
  /** 当前图片下标（越界会被夹到合法范围）。 */
  index: number;
  onClose: () => void;
  onIndex: (next: number) => void;
  /** 当前图片的可读描述，缺省用「图片 N」。 */
  alt?: string;
}) {
  const tr = useT();
  const count = images.length;
  const current = count > 0 ? Math.min(Math.max(index, 0), count - 1) : 0;
  const src = images[current] ?? "";

  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  /** 进行中的拖拽：pointerId + 起点指针位置 + 起点平移量。 */
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  /** 滚轮监听只挂一次，用 ref 读到最新的缩放/平移。 */
  const liveRef = useRef<{ zoom: number; pan: Pan }>({ zoom: ZOOM_MIN, pan: { x: 0, y: 0 } });
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  /** 首尾循环：第一张再往前回到最后一张，最后一张再往后回到第一张。 */
  const step = useCallback((delta: number) => {
    if (count <= 1) return;
    onIndex((current + delta + count) % count);
  }, [count, current, onIndex]);

  // 锁背景滚动、把焦点移到关闭按钮；卸载时还原滚动条并把焦点还给被点的那张缩略图。
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const target = restoreRef.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  // 键位统一在 capture 阶段拦下：同一次 Esc 不能既关灯箱又关掉底下的抽屉/弹窗。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        step(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        step(1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, step]);

  // 滚轮缩放：React 的 onWheel 在根节点上是 passive 的，preventDefault 不生效，所以自己挂原生监听。
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const nextZoom = clampZoom(liveRef.current.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      setZoom(nextZoom);
      // 缩小时同步收拢平移；回到 1x 时 clampPan 直接归零。
      setPan((value) => clampPan(value, nextZoom, imageRef.current));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  // 换图时退回 1x、平移归零，并重新进入「加载中」，避免上一张的失败提示残留。
  useEffect(() => {
    setZoom(ZOOM_MIN);
    setPan({ x: 0, y: 0 });
    setDragging(false);
    setStatus("loading");
  }, [current]);

  useEffect(() => {
    liveRef.current = { zoom, pan };
  }, [zoom, pan]);

  // 拖拽平移：只有放大后才接管指针（1x 时不拦截，以免影响「点空白关闭」的直觉）。
  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (zoom <= ZOOM_MIN) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan(clampPan(
      { x: drag.panX + (event.clientX - drag.x), y: drag.panY + (event.clientY - drag.y) },
      zoom,
      imageRef.current,
    ));
  };

  const endDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (count === 0) return null;

  const label = alt ?? tr("lightbox.imageAlt", { index: current + 1 });

  return createPortal(
    <div
      ref={rootRef}
      className="lightbox"
      data-lightbox
      data-lightbox-index={current}
      data-lightbox-zoom={zoom}
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? tr("lightbox.viewer")}
      onMouseDown={(event) => {
        // 舞台与说明文字都设了 pointer-events:none，落在空白处的事件目标就是遮罩本身。
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        className="lightbox-close"
        data-action="lightbox-close"
        aria-label={tr("lightbox.close")}
        title={tr("lightbox.close")}
        onClick={onClose}
      >
        <IconClose size={20} />
      </button>

      {count > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-nav-prev"
          data-action="lightbox-prev"
          aria-label={tr("lightbox.prev")}
          title={tr("lightbox.prev")}
          onClick={() => step(-1)}
        >
          <IconChevronRight size={22} className="lightbox-nav-glyph" />
        </button>
      ) : null}

      {count > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-nav-next"
          data-action="lightbox-next"
          aria-label={tr("lightbox.next")}
          title={tr("lightbox.next")}
          onClick={() => step(1)}
        >
          <IconChevronRight size={22} className="lightbox-nav-glyph" />
        </button>
      ) : null}

      <figure className="lightbox-stage">
        <div className="lightbox-frame">
          <img
            ref={imageRef}
            className={`lightbox-image${status === "error" ? " is-error" : ""}${zoom > ZOOM_MIN ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
            data-lightbox-image
            src={src}
            alt={label}
            draggable={false}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            onLoad={() => setStatus("loaded")}
            onError={() => setStatus("error")}
            onDoubleClick={() => {
              // 双击复位：缩放回 1x 的同时把平移归零
              setZoom(ZOOM_MIN);
              setPan({ x: 0, y: 0 });
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          />
          {status === "loading" ? (
            <div className="lightbox-status" data-lightbox-loading>
              <span className="spinner" aria-hidden="true" />
              <span>{tr("lightbox.loading")}</span>
            </div>
          ) : null}
          {status === "error" ? (
            <div className="lightbox-status lightbox-status-error" data-lightbox-error>
              <IconAlert size={20} />
              <span>{tr("lightbox.loadFailed")}</span>
            </div>
          ) : null}
        </div>
        <figcaption className="lightbox-caption" data-lightbox-caption>
          <span data-lightbox-count>{current + 1} / {count}</span>
          <span className="lightbox-hint">{tr("lightbox.hint")}</span>
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}
