import { useSyncExternalStore } from "react";

export interface MusicState {
  playing: boolean;
  /** 被浏览器自动播放策略拦下：静默处理，按钮回到「播放」。 */
  blocked: boolean;
}

let audio: HTMLAudioElement | null = null;
let snapshot: MusicState = { playing: false, blocked: false };
const listeners = new Set<() => void>();

function publish(next: MusicState): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** App 层的 <audio> 挂载后登记，供个性化页的播放按钮控制。 */
export function attachAudio(element: HTMLAudioElement | null): void {
  audio = element;
}

export function subscribeMusic(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function musicSnapshot(): MusicState {
  return snapshot;
}

/** 尝试播放；失败（无文件、格式不支持、自动播放被拦）只置状态，不抛错。 */
export async function playMusic(): Promise<boolean> {
  if (!audio) return false;
  try {
    await audio.play();
    publish({ playing: true, blocked: false });
    return true;
  } catch {
    publish({ playing: false, blocked: true });
    return false;
  }
}

export function pauseMusic(): void {
  audio?.pause();
  publish({ playing: false, blocked: false });
}

export function setMusicVolume(value: number): void {
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, value));
}

export function useMusicState(): MusicState {
  return useSyncExternalStore(subscribeMusic, musicSnapshot, musicSnapshot);
}
