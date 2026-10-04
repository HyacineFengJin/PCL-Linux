import { useEffect, useRef, type ReactNode } from "react";
import type { Api } from "./types";

/** Async replies belong to the captured root and API, including reads that finish
 * after navigation. Admission uses current props so saved handlers cannot write
 * while another job has acquired the application's writer. */
export function useInstanceOperationScope(
  api: Api,
  scopeKey: string,
  native: boolean,
  disabled: boolean,
) {
  const owner = useRef({ api, scopeKey });
  if (owner.current.api !== api || owner.current.scopeKey !== scopeKey)
    owner.current = { api, scopeKey };
  const scope = owner.current;
  const live = useRef(true);
  const admission = useRef({ native, disabled });
  admission.current = { native, disabled };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () => live.current && owner.current === scope;
  return {
    scope,
    current,
    readable: () => current() && admission.current.native,
    allowed: () =>
      current() && admission.current.native && !admission.current.disabled,
  };
}

export function instanceOperationSize(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MiB`
    : `${bytes.toLocaleString("zh-CN")} 字节`;
}

/** Existing CE name/confirmation dialog; start admission is the boundary after
 * which task cancellation owns cleanup and the dialog must stay mounted. */
export function InstanceOperationDialog({
  title,
  titleId,
  children,
  busy,
  committing,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
  busy: boolean;
  committing: boolean;
  confirmLabel: string;
  confirmDisabled: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>("input:not(:disabled),button:not(:disabled)")
      ?.focus();
  }, []);
  return (
    <div
      className="modal-shade rd-name-shade"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !committing) onClose();
      }}
    >
      <form
        ref={form}
        className="rd-name-dialog ce-operation-confirmation ce-instance-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmDisabled && !busy) onConfirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!committing) onClose();
          }
          if (event.key !== "Tab") return;
          event.stopPropagation();
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "input:not(:disabled),button:not(:disabled)",
            ),
          ];
          const first = controls[0],
            last = controls[controls.length - 1];
          if (!first) event.preventDefault();
          else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="rd-name-actions">
          <button
            className="ce-button primary"
            type="submit"
            disabled={confirmDisabled || busy}
          >
            {confirmLabel}
          </button>
          <button
            className="ce-button"
            type="button"
            disabled={committing}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </form>
    </div>
  );
}
