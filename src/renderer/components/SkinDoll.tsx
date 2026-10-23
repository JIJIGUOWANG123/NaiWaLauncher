import { useRef, useState, type CSSProperties } from "react";

/** 每个皮肤像素渲染成多少 CSS 像素（8px 的头 = 40px）。 */
const SCALE = 5;

export type SkinFaceKey = "front" | "back" | "left" | "right" | "top" | "bottom";

/** 一张贴图裁切矩形，单位是皮肤像素。 */
interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 盒子的 6 个面在皮肤图上的位置（Minecraft 固定的「十字展开」排布，
 * u/v 是这个盒子的展开原点，w/h/d 是宽/高/厚）：
 *
 *            ┌───top───┐
 *   ┌──right─┼──front──┼──left──┬──back──┐
 *   └────────┴─────────┴────────┴────────┘
 *            ┌─bottom──┐
 *
 *   top    (u+d,     v)    w×d      底  bottom (u+d+w,   v)    w×d
 *   右面   right (u,       v+d)  d×h       正面 front  (u+d,     v+d)  w×h
 *   左面   left  (u+d+w,   v+d)  d×h       背面 back   (u+d+w+d, v+d)  w×h
 *
 * 例：头部 u=0,v=0,w=8,h=8,d=8 → 正脸 (8,8) 8×8、头顶 (8,0) 8×8、后脑 (24,8) 8×8，
 * 与游戏里 64×64 皮肤图的位置完全一致。
 */
function boxFaces(u: number, v: number, w: number, h: number, d: number): Record<SkinFaceKey, FaceRect> {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + d + w + d, y: v + d, w, h },
  };
}

interface DollPart {
  key: string;
  /** 展开原点，见 boxFaces 的注释。 */
  u: number;
  v: number;
  w: number;
  h: number;
  d: number;
  /** 相对小人中轴的左右偏移（皮肤像素，正值在画面右侧）。 */
  x: number;
  /** 顶边离小人头顶多少皮肤像素。 */
  top: number;
}

/**
 * 5 个盒子拼出小人：头、身、右臂、左臂、右腿、左腿（双臂双腿各一个盒子）。
 * - classic 手臂 4 宽；slim（Alex）手臂 3 宽（贴图里那一列全透明，这里直接把盒子做窄）。
 * - 64×32 旧格式没有左臂/左腿的独立贴图区，用右臂/右腿的区域镜像顶上。
 * - 站位：头 0–8、身 8–20、手臂从肩 8 起、腿从 20 起，正好 32 皮肤像素高。
 */
function partsFor(legacy: boolean, slim: boolean): DollPart[] {
  const armW = slim ? 3 : 4;
  const armX = 4 + armW / 2;
  const rightArm = { u: 40, v: 16, w: armW, h: 12, d: 4 };
  const leftArm = legacy ? rightArm : { u: 32, v: 48, w: armW, h: 12, d: 4 };
  const rightLeg = { u: 0, v: 16, w: 4, h: 12, d: 4 };
  const leftLeg = legacy ? rightLeg : { u: 16, v: 48, w: 4, h: 12, d: 4 };
  return [
    { key: "head", u: 0, v: 0, w: 8, h: 8, d: 8, x: 0, top: 0 },
    { key: "body", u: 16, v: 16, w: 8, h: 12, d: 4, x: 0, top: 8 },
    { key: "arm-right", ...rightArm, x: -armX, top: 8 },
    { key: "arm-left", ...leftArm, x: armX, top: 8 },
    { key: "leg-right", ...rightLeg, x: -2, top: 20 },
    { key: "leg-left", ...leftLeg, x: 2, top: 20 },
  ];
}

/** 皮肤的 path → 图片地址：mock 给内联 PNG，真实链路给绝对路径（转 file:// 并编码）。 */
export function skinImageUrl(target: string): string {
  if (/^(data:|file:|https?:|blob:)/i.test(target)) return target;
  return encodeURI(`file:///${target.replace(/\\/g, "/")}`);
}

/**
 * 单个盒子的 6 个面：尺寸（CSS 像素）+ 贴图裁切位置 + 3D 摆放。
 * 正面朝 +Z（对着观众），右面在 -X（角色的右侧在画面左边），左面在 +X。
 */
function facesOf(part: DollPart, url: string, texH: number): Array<{ key: string; style: CSSProperties }> {
  const rects = boxFaces(part.u, part.v, part.w, part.h, part.d);
  const halfW = (part.w * SCALE) / 2;
  const halfH = (part.h * SCALE) / 2;
  const halfD = (part.d * SCALE) / 2;
  const build = (key: SkinFaceKey, transform: string, width: number, height: number): { key: string; style: CSSProperties } => ({
    key,
    style: {
      width,
      height,
      transform,
      backgroundImage: `url("${url}")`,
      // 贴图整张放大到 SCALE 倍，再用负的 background-position 把目标方块挪到面前。
      backgroundSize: `${64 * SCALE}px ${texH * SCALE}px`,
      backgroundPosition: `${-rects[key].x * SCALE}px ${-rects[key].y * SCALE}px`,
    },
  });
  return [
    build("front", `translate(-50%, -50%) translateZ(${halfD}px)`, part.w * SCALE, part.h * SCALE),
    build("back", `translate(-50%, -50%) rotateY(180deg) translateZ(${halfD}px)`, part.w * SCALE, part.h * SCALE),
    build("right", `translate(-50%, -50%) rotateY(-90deg) translateZ(${halfW}px)`, part.d * SCALE, part.h * SCALE),
    build("left", `translate(-50%, -50%) rotateY(90deg) translateZ(${halfW}px)`, part.d * SCALE, part.h * SCALE),
    build("top", `translate(-50%, -50%) rotateX(90deg) translateZ(${halfH}px)`, part.w * SCALE, part.d * SCALE),
    build("bottom", `translate(-50%, -50%) rotateX(-90deg) translateZ(${halfH}px)`, part.w * SCALE, part.d * SCALE),
  ];
}

/** 小人贴图：本地皮肤库的皮肤与「账号在皮肤站上的皮肤」都归一成这个形状。 */
export interface SkinTexture {
  /** 可直接用作 background-image 的地址（data: / file: / http(s)）。 */
  url: string;
  model: "classic" | "slim";
  /** 贴图高度：32 = 旧格式（没有左臂/左腿贴图区），64 = 现代格式。 */
  height?: number;
  /** 写进 data-skin-doll 的标识，自检时能看出贴图来自哪张皮肤。 */
  label: string;
}

/** 披风贴图：账号官方披风与本地披风库都归一成这个形状。 */
export interface CapeTexture {
  /** 可直接用作 background-image 的地址（data: / file: / http(s)）。 */
  url: string;
  /** account = 账号自带（微软官方 / 皮肤站），local = 本地披风库。 */
  source: "account" | "local";
  /** 写进 data-skin-cape-label 的标识。 */
  label: string;
}

/**
 * 披风正面那张 10×16 的贴图裁切。
 * 依据：Minecraft 官方披风贴图是 64×32，左上有 1 像素留白，
 * 「正面」占 (1,1)-(11,17)，「背面」在 (12,1)-(22,17) —— 这里只用正面那块。
 */
function capeFaceStyle(url: string, flip: string): CSSProperties {
  return {
    transform: flip,
    backgroundImage: `url("${url}")`,
    backgroundSize: `${64 * SCALE}px ${32 * SCALE}px`,
    backgroundPosition: `${-1 * SCALE}px ${-1 * SCALE}px`,
  };
}

/**
 * CSS 3D 小人：零依赖，贴图来自一张 PNG（本地皮肤库或皮肤站直链），可再叠一层披风。
 * 拖拽绕 Y 轴旋转，松手保持角度；换皮肤/披风只换背景图，不重建结构。
 */
export function SkinDoll({
  texture, cape = null, emptyHint = "选一张皮肤就能预览",
}: {
  texture: SkinTexture | null;
  /** 披风层：只有拿到贴图时才渲染，和身体一起绕 Y 轴转。 */
  cape?: CapeTexture | null;
  emptyHint?: string;
}) {
  const [rotate, setRotate] = useState(-24);
  const drag = useRef<{ startX: number; base: number } | null>(null);

  if (!texture) {
    return (
      <div className="skin-doll skin-doll-empty" data-skin-doll="empty">
        {emptyHint}
      </div>
    );
  }

  const url = skinImageUrl(texture.url);
  const legacy = (texture.height ?? 64) === 32;
  const slim = texture.model === "slim";
  const parts = partsFor(legacy, slim);
  // 舞台固定 16 皮肤像素宽（8 宽的身体 + 两侧手臂）：slim 的手臂窄 1 像素，
  // 于是两边各留 1 像素空白，站位公式不必跟着模型变。
  const width = 16 * SCALE;
  const height = 32 * SCALE;

  return (
    <div
      className="skin-doll"
      data-skin-doll={texture.label}
      data-skin-model={texture.model}
      data-skin-legacy={legacy ? "true" : "false"}
      data-skin-cape={cape ? "true" : "false"}
      data-skin-cape-source={cape?.source ?? "none"}
      data-skin-cape-label={cape?.label}
      onPointerDown={(event) => {
        drag.current = { startX: event.clientX, base: rotate };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        setRotate(state.base + (event.clientX - state.startX) * 0.6);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div
        className="skin-doll-stage"
        data-skin-rotate-y={Math.round(rotate)}
        style={{
          width,
          height,
          transform: `rotateX(-8deg) rotateY(${rotate}deg)`,
        }}
      >
        {cape ? (
          // 披风挂在躯干后方：z 负方向再退半格，避免和后背贴图 z-fighting；
          // 高度从肩膀（8）盖到 24，宽度 10 皮肤像素（比 8 宽的躯干略宽）。
          <div
            className="skin-doll-cape"
            data-skin-cape-layer
            style={{
              left: (8 - 5) * SCALE,
              top: 8 * SCALE,
              width: 10 * SCALE,
              height: 16 * SCALE,
              transform: `translateZ(${-(2 + 0.5) * SCALE}px)`,
            }}
          >
            <div className="skin-doll-cape-face" data-skin-cape-face="outer" style={capeFaceStyle(cape.url, "rotateY(180deg)")} />
            <div className="skin-doll-cape-face" data-skin-cape-face="inner" style={capeFaceStyle(cape.url, "none")} />
          </div>
        ) : null}
        {parts.map((part) => (
          <div
            key={part.key}
            className="skin-doll-part"
            data-skin-part={part.key}
            style={{
              width: part.w * SCALE,
              height: part.h * SCALE,
              left: (8 - part.w / 2 + part.x) * SCALE,
              top: part.top * SCALE,
            }}
          >
            {facesOf(part, url, legacy ? 32 : 64).map((face) => (
              <div key={face.key} className="skin-doll-face" data-skin-face={face.key} style={face.style} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
