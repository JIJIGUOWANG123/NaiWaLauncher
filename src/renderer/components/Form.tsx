import type { InputHTMLAttributes, ReactNode } from "react";
import { IconChevronDown } from "./icons";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`input ${className ?? ""}`.trim()} />;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 原生 option 的悬停提示，例如 JDK 的完整路径。 */
  title?: string;
}

export function Select({
  value, options, onChange, disabled, placeholder, ariaLabel, keepEmpty = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** 空串本身是一个有效选项（例如「默认」）时置 true：保留 value="" 的选项，不渲染 placeholder。 */
  keepEmpty?: boolean;
}) {
  const items = keepEmpty ? options : options.filter((option) => option.value !== "");
  const missing = value !== "" && !items.some((option) => option.value === value);
  return (
    <div className="select-wrap">
      <select
        className="input select"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      >
        {!keepEmpty && value === "" ? <option value="">{placeholder ?? "请选择"}</option> : null}
        {missing ? <option value={value}>{value}</option> : null}
        {items.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={16} className="select-icon" />
    </div>
  );
}

export function Slider({
  value, min, max, step = 1, onChange, format, disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ background: `linear-gradient(90deg, var(--accent) ${percent}%, color-mix(in srgb, var(--text) 14%, transparent) ${percent}%)` }}
      />
      <span className="slider-value">{format ? format(value) : String(value)}</span>
    </div>
  );
}

export function Toggle({
  checked, onChange, label, hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`segmented-item ${option.value === value ? "active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}