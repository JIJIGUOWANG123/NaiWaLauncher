import { api } from "./api";

const clampVolume = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * 启动音效 / 试听的音频元素：不挂在 <audio ref> 上（与背景音乐互不影响），
 * 但塞进 body 方便在开发者工具里看到 src 与 volume；hidden 保证不参与布局。
 */
function createAudio(url: string, volume: number, role: string): HTMLAudioElement {
  const audio = new Audio(url);
  audio.dataset.role = role;
  audio.hidden = true;
  audio.loop = false;
  audio.volume = clampVolume(volume);
  document.body.appendChild(audio);
  return audio;
}

function dispose(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.remove();
}

let startupAudio: HTMLAudioElement | null = null;
let startupRequested = false;

/**
 * 启动音效：boot 完成后调用一次即止（切页面不会重跑）。
 * url 为 null（已关闭 / 文件不存在）时静默跳过；play() 被自动播放策略拒绝同样静默。
 */
export async function playStartupSound(): Promise<HTMLAudioElement | null> {
  if (startupRequested) return startupAudio;
  startupRequested = true;
  try {
    const { url, volume } = await api.app.startupSound();
    if (!url) return null;
    const audio = createAudio(url, volume, "startup-sound");
    startupAudio = audio;
    await audio.play().catch(() => undefined);
    return audio;
  } catch {
    return null;
  }
}

export function stopStartupSound(): void {
  dispose(startupAudio);
  startupAudio = null;
}

let previewAudio: HTMLAudioElement | null = null;

/** 试听：用当前选择临时播一次，播完自动收尾（不受「启动时播放」影响）。 */
export async function playPreviewSound(url: string, volume: number, onEnded: () => void): Promise<boolean> {
  stopPreviewSound();
  const audio = createAudio(url, volume, "startup-preview");
  audio.addEventListener("ended", () => {
    onEnded();
    stopPreviewSound();
  }, { once: true });
  previewAudio = audio;
  try {
    await audio.play();
    return true;
  } catch {
    stopPreviewSound();
    return false;
  }
}

export function stopPreviewSound(): void {
  dispose(previewAudio);
  previewAudio = null;
}
