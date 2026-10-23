// 皮肤 PNG 的最小解析：本地皮肤库只需要「宽高 + 像素 alpha」（宽高校验、手臂模型判定），
// 不引入任何图像依赖（docs/CONTRACT.md 禁止新增 npm 依赖）。
// 只支持真实皮肤会出现的形态：8bit、非隔行、RGBA / RGB / 调色板；其它一律当作「无法判定」由调用方兜底。
import { inflateSync } from "node:zlib";

/** 解码后的像素：RGBA8，行优先，长度 = width * height * 4。 */
export interface PngImage {
  width: number;
  height: number;
  data: Buffer;
}

/** 手臂模型：slim = 细臂（Alex），classic = 宽臂（Steve）。 */
export type SkinModel = "classic" | "slim";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 只读 IHDR：宽高校验不需要解压整张图，几 KB 的文件也不会白读。 */
export function readPngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return undefined;
  // 第一个块必须是 IHDR（PNG 规范 5.6）
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** 逐块扫描，拿到 IHDR / PLTE / tRNS / IDAT；坏文件返回 undefined。 */
function scanChunks(buf: Buffer): { header: PngHeader; idat: Buffer[]; palette?: Buffer; trns?: Buffer } | undefined {
  const size = readPngSize(buf);
  if (!size) return undefined;
  let pos = 8;
  let header: PngHeader | undefined;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (data.length !== length) return undefined;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!header || idat.length === 0) return undefined;
  return { header, idat, palette, trns };
}

/** 解成 RGBA8；不支持的形态返回 undefined（调用方按 classic 兜底）。 */
export function decodePng(buf: Buffer): PngImage | undefined {
  const scanned = scanChunks(buf);
  if (!scanned) return undefined;
  const { header, idat, palette, trns } = scanned;
  // 隔行（Adam7）与位深不是 8 的皮肤从未出现过，不去实现
  if (header.bitDepth !== 8 || header.interlace !== 0) return undefined;
  const channels = header.colorType === 6 ? 4 : header.colorType === 2 ? 3 : header.colorType === 3 ? 1 : 0;
  if (channels === 0) return undefined;
  if (header.colorType === 3 && !palette) return undefined;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const { width, height } = header;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return undefined;

  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    // PNG 的四种行过滤器（规范 9.2）；这里必须逐行还原，否则 alpha 会被前一行污染
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = value & 0xff;
    }
    prev = line;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (header.colorType === 6) {
        out[at] = line[x * 4];
        out[at + 1] = line[x * 4 + 1];
        out[at + 2] = line[x * 4 + 2];
        out[at + 3] = line[x * 4 + 3];
      } else if (header.colorType === 2) {
        out[at] = line[x * 3];
        out[at + 1] = line[x * 3 + 1];
        out[at + 2] = line[x * 3 + 2];
        out[at + 3] = 255;
      } else {
        const index = line[x];
        const base = index * 3;
        out[at] = palette && base + 2 < palette.length ? palette[base] : 0;
        out[at + 1] = palette && base + 2 < palette.length ? palette[base + 1] : 0;
        out[at + 2] = palette && base + 2 < palette.length ? palette[base + 2] : 0;
        out[at + 3] = trns && index < trns.length ? trns[index] : 255;
      }
    }
  }
  return { width, height, data: out };
}

/** 矩形内不透明像素的数量。 */
function opaqueCount(image: PngImage, x0: number, x1: number, y0: number, y1: number): number {
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 0) count += 1;
    }
  }
  return count;
}

/**
 * 手臂模型判定：必须看图才知道 slim 还是 classic（皮肤文件本身不带模型标记）。
 *
 * 布局依据（64×64 皮肤图集，来自 Minecraft 官方默认皮肤纹理实测 + 图集展开规则）：
 * 手臂贴图块从 (40,16) 起，顶/底各一行，下面一行按「右(厚度 4) / 前(宽) / 左(厚度 4) / 后(宽)」展开。
 * - classic：宽 4 → 展开后正好用满 x=40..55；
 * - slim：宽 3、厚度仍是 4 → 右臂只用到 x=40..53，最右两列 x=54..55 全透明；
 *   左臂块从 (32,48) 起 → 只用到 x=32..45，x=46..47 全透明。
 * 实测（xfl03/MCCustomSkinLoader 与官方默认皮肤 wide/steve vs slim/alex）：
 *   steve 的 x=54..55/y=20..31 与 x=46..47/y=52..63 共 48 个像素全部不透明；
 *   alex 的同两处全部 alpha=0，而紧邻的手臂本体列（x=52..53 / x=44..45）有像素。
 * 因此规则是「两处空列都全透明 + 就近的本体列有像素 → slim」，其余一律 classic：
 * 宁可把细臂画成宽臂，也不要把宽臂画成细臂（后者会露出间隙）。
 * 64×32 老皮肤没有左手与手臂外层，一律 classic；HD 皮肤按 64 的整数倍等比缩放同一条规则。
 */
export function detectSkinModel(image: PngImage): SkinModel {
  const scale = image.width === image.height && image.width % 64 === 0 ? image.width / 64 : 0;
  // 老格式（64×32）与无法等比缩放的图：没有细臂布局可言
  if (scale < 1) return "classic";
  const unit = (value: number): number => value * scale;
  const rightEmpty = opaqueCount(image, unit(54), unit(56) - 1, unit(20), unit(32) - 1) === 0;
  const leftEmpty = opaqueCount(image, unit(46), unit(48) - 1, unit(52), unit(64) - 1) === 0;
  const rightBody = opaqueCount(image, unit(52), unit(54) - 1, unit(20), unit(32) - 1) > 0;
  const leftBody = opaqueCount(image, unit(44), unit(46) - 1, unit(52), unit(64) - 1) > 0;
  return rightEmpty && leftEmpty && rightBody && leftBody ? "slim" : "classic";
}
