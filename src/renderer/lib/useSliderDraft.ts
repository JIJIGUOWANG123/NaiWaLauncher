import { useEffect, useRef, useState } from "react";

/**
 * 滑杆草稿：拖动时只改本地值，停手 260ms 才写一次设置/实例，
 * 否则每一格都会发一次 IPC 并弹一次回读 toast。
 */
export function useSliderDraft(
  initial: number,
  onCommit: (value: number) => void,
): readonly [number, (value: number) => void] {
  const [value, setValue] = useState(initial);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const committed = useRef(initial);

  useEffect(() => {
    if (committed.current === initial) return;
    committed.current = initial;
    setValue(initial);
  }, [initial]);

  useEffect(() => {
    if (value === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = value;
      commit.current(value);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [value]);

  return [value, setValue] as const;
}
