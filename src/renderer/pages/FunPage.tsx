import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/store";
import { useT } from "../lib/i18n";
import { errorMessage } from "../lib/useAsync";
import { IconMessage, IconZap } from "../components/icons";

/** 设备种子：第一次进页面时生成并落盘，之后一直用它（清掉等于重新抽一个）。 */
const SEED_KEY = "naiwa.fun.seed";
/** 今日人品：{ date: "YYYY-MM-DD", value: n }；日期不是今天就当作没抽过。 */
const FORTUNE_KEY = "naiwa.fun.fortune";
/** 反馈文案的构成：10 段基调 × 10 个修饰 = 100 条，两段各自唯一，拼接后必然互不相同。 */
const MOODS = 10;
/** 运势小结按 20 一档，共 5 句。 */
const LUCK_BANDS = 5;

/** 本地日期：不用 toISOString（那是 UTC，东八区过了 16 点会跨到「明天」）。 */
export function dateKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 今日人品：FNV-1a 32 位哈希（日期 + 种子）落到 1–100。
 * 纯函数：同一天同一台设备点多少次都是这个数；换一天、换账号才会变。
 */
export function fortuneFor(date: string, seed: string): number {
  let hash = 0x811c9dc5;
  const input = `${date}|${seed}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 100) + 1;
}

/**
 * 数值 → 文案 key：基调按十位分段（tone.1 最好、tone.10 最差，所以数值越大编号越小）、
 * 修饰按个位（10 句「今天适合做什么」，不带好坏），运势小结按 20 一档（luck.1 最差）。
 * 两段各自唯一，拼接后 100 条必然互不相同。
 */
export function fortuneTextKeys(value: number): { feedback: string; tone: string; mood: string; luck: string } {
  const index = Math.min(100, Math.max(1, Math.round(value))) - 1;
  return {
    feedback: "pages.fun.feedback",
    tone: `pages.fun.tone.${MOODS - Math.floor(index / MOODS)}`,
    mood: `pages.fun.mood.${(index % MOODS) + 1}`,
    luck: `pages.fun.luck.${Math.min(LUCK_BANDS, Math.floor(index / 20) + 1)}`,
  };
}

/** 读种子：localStorage 不可用（隐私模式）时退化成进程内常量，页面生命周期内仍然稳定。 */
function readSeed(): string {
  try {
    const existing = window.localStorage.getItem(SEED_KEY);
    if (existing) return existing;
    const created = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(SEED_KEY, created);
    return created;
  } catch {
    return "naiwa-fun-fallback";
  }
}

/** 读今日人品：存的是别的日期就当作没抽过（第二天自动回到未获取状态）。 */
function readFortune(today: string): number | null {
  try {
    const raw = window.localStorage.getItem(FORTUNE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { date?: unknown; value?: unknown };
    if (parsed.date !== today || typeof parsed.value !== "number") return null;
    return Math.min(100, Math.max(1, Math.round(parsed.value)));
  } catch {
    return null;
  }
}

function writeFortune(entry: { date: string; value: number }): void {
  try {
    window.localStorage.setItem(FORTUNE_KEY, JSON.stringify(entry));
  } catch {
    // 存不下也不影响这一次显示，下次进来重新算（同一天算出来还是同一个数）
  }
}

export function FunPage() {
  const tr = useT();
  const { settings } = useApp();
  const today = dateKey();
  // 账号也进种子：同一台设备换账号会换一个数，删掉 seed 也会换一个数
  const seed = useMemo(
    () => `${readSeed()}|${settings?.activeAccountId ?? ""}`,
    [settings?.activeAccountId],
  );
  const [value, setValue] = useState<number | null>(() => readFortune(dateKey()));

  // 页面挂着跨过零点是可能的：日期一变就重新读一次（过期记录等于没抽）
  useEffect(() => {
    setValue(readFortune(today));
  }, [today]);

  const roll = useCallback(() => {
    const next = fortuneFor(today, seed);
    writeFortune({ date: today, value: next });
    setValue(next);
  }, [seed, today]);

  const [saying, setSaying] = useState("");
  const [sayingError, setSayingError] = useState("");
  const [sayingUrl, setSayingUrl] = useState("");
  const [drawing, setDrawing] = useState(false);

  /** 抽一句：请求与解析都在主进程（渲染层 CSP 只允许 self），这里只管显示与失败兜底。 */
  const draw = useCallback(async () => {
    if (drawing) return;
    setDrawing(true);
    setSayingError("");
    try {
      const result = await api.fun.saying();
      setSayingUrl(result.url);
      setSaying(result.text || tr("pages.fun.sayingFallback"));
      if (result.error) setSayingError(result.error);
    } catch (error: unknown) {
      // IPC 本身挂了也不能让卡片空着：兜底文案 + 可读提示，不弹阻塞框
      setSaying(tr("pages.fun.sayingFallback"));
      setSayingError(errorMessage(error));
    } finally {
      setDrawing(false);
    }
  }, [drawing, tr]);

  const keys = value === null ? null : fortuneTextKeys(value);
  const feedback = keys
    ? tr(keys.feedback, { tone: tr(keys.tone), mood: tr(keys.mood) })
    : "";

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{tr("pages.fun.title")}</h1>
          <p className="page-sub">{tr("pages.fun.subtitle")}</p>
        </div>
      </header>

      <div className="fun-grid">
        <div className="panel fun-card" data-fortune-card data-fortune-date={today} data-fortune-value={value === null ? "" : String(value)}>
          <div className="panel-head">
            <h2 className="panel-title">
              <IconZap size={16} /> {tr("pages.fun.fortuneTitle")}
            </h2>
            <span className="panel-count">{tr("pages.fun.fortuneRange")}</span>
          </div>

          {value === null ? (
            <>
              <p className="fun-empty">{tr("pages.fun.fortuneSub")}</p>
              <div className="fun-actions">
                <button type="button" className="btn btn-primary" data-action="fortune-roll" onClick={roll}>
                  {tr("pages.fun.roll")}
                </button>
              </div>
            </>
          ) : (
            <>
              <strong className="fun-number" data-fortune-number>
                {value}
              </strong>
              <p className="fun-feedback" data-fortune-feedback>
                {feedback}
              </p>
              <p className="fun-luck" data-fortune-luck>
                {tr(keys!.luck)}
              </p>
              <div className="fun-actions">
                <button type="button" className="btn btn-ghost btn-sm" data-action="fortune-roll" onClick={roll}>
                  {tr("pages.fun.rollAgain")}
                </button>
              </div>
            </>
          )}
          <span className="fun-hint">{tr("pages.fun.fortuneStored", { date: today })}</span>
        </div>

        <div className="panel fun-card" data-saying-card data-saying-url={sayingUrl}>
          <div className="panel-head">
            <h2 className="panel-title">
              <IconMessage size={16} /> {tr("pages.fun.sayingTitle")}
            </h2>
            <span className="panel-count">{tr("pages.fun.sayingSub")}</span>
          </div>

          {/* 整块可点：点一下就换一句（第二次点击同时是「再抽一次」） */}
          <button type="button" className="fun-saying-draw" data-action="saying-draw" onClick={() => void draw()} disabled={drawing}>
            <span data-saying-text>{drawing ? tr("pages.fun.sayingLoading") : saying || tr("pages.fun.sayingInitial")}</span>
          </button>

          <span className="fun-hint">{saying ? tr("pages.fun.sayingAgain") : tr("pages.fun.sayingInitial")}</span>
          {sayingError ? <span className="fun-error" data-saying-error>{sayingError}</span> : null}
          {sayingUrl ? <span className="fun-hint" data-saying-source>{tr("pages.fun.sayingFrom", { url: sayingUrl })}</span> : null}
        </div>
      </div>
    </section>
  );
}
