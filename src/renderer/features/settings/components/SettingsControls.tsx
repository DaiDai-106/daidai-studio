import type { ReactNode } from "react";

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="setting-control">{children}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
