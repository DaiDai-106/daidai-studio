import { cloneElement, type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { DialogChangeContext, DialogContainerContext } from "../logic/dialog_context.ts";
import { useOverlay } from "../logic/overlay_context.tsx";
import { Icon } from "./icon.tsx";

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  protectChanges = false,
  className = "",
  closeLabel = "关闭弹窗",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  protectChanges?: boolean;
  className?: string;
  closeLabel?: string;
}) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useOverlay(true);
  const close = () => {
    if (protectChanges && dirty) setConfirm(true);
    else onClose();
  };
  useEffect(() => {
    const dialog = element;
    dialog?.showModal();
    return () => dialog?.close();
  }, [element]);
  return (
    <dialog
      ref={setElement}
      className={["dialog", wide && "wide", className].filter(Boolean).join(" ")}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button type="button" className="icon-button" aria-label={closeLabel} onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <DialogContainerContext value={element ?? undefined}>
        <DialogChangeContext value={() => setDirty(true)}>
          <div className="dialog-body" hidden={confirm} onChangeCapture={() => setDirty(true)}>
            {children}
          </div>
        </DialogChangeContext>
      </DialogContainerContext>
      {confirm && (
        <div className="dialog-body">
          <p>此表单有未保存的修改，是否放弃？</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setConfirm(false)}>
              继续编辑
            </button>
            <button type="button" className="primary" onClick={onClose}>
              放弃修改
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
