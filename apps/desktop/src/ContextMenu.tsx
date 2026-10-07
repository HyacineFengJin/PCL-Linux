import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Scissors, ClipboardPaste, TextSelect } from "lucide-react";
import { t } from "./i18n";
import "./context-menu.css";
import "./cursors.css";

type EditAction = "copy" | "cut" | "paste" | "selectAll";
type TextField = HTMLInputElement | HTMLTextAreaElement;
type Menu = {
  scope: string;
  x: number;
  y: number;
  keyboard: boolean;
  target: HTMLElement;
  field: TextField | null;
  editable: boolean;
  selected: boolean;
  range: Range | null;
  caret: {
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
  } | null;
};

function capture(
  target: HTMLElement,
  scope: string,
  x: number,
  y: number,
  keyboard: boolean,
): Menu {
  const element = target.closest("input, textarea, [contenteditable]");
  const field =
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
      ? element
      : null;
  const textField =
    !!field &&
    (field instanceof HTMLTextAreaElement ||
      ["text", "search", "password", "email", "url", "tel", "number"].includes(
        field.type,
      ));
  const editable = textField
    ? !field!.disabled && !field!.readOnly
    : target.isContentEditable;
  const selection = window.getSelection();
  const caret =
    textField && field!.selectionStart !== null && field!.selectionEnd !== null
      ? {
          start: field!.selectionStart!,
          end: field!.selectionEnd!,
          direction: field!.selectionDirection ?? "none",
        }
      : null;
  const password =
    field instanceof HTMLInputElement && field.type === "password";
  return {
    scope,
    x,
    y,
    keyboard,
    target: textField
      ? field!
      : target.isContentEditable && element instanceof HTMLElement
        ? element
        : target,
    field: textField ? field : null,
    editable,
    selected:
      !password &&
      (caret ? caret.end > caret.start : !!selection && !selection.isCollapsed),
    range:
      !textField && selection?.rangeCount
        ? selection.getRangeAt(0).cloneRange()
        : null,
    caret,
  };
}

/** Keep the original editor/selection while the popup handles focus. WebKit's
 * native commands perform the edit, so React input events and undo still work;
 * no clipboard contents or password values cross our IPC boundary. */
export function ContextMenu({
  native,
  enabled,
  density,
  scopeKey,
  onNotify,
}: {
  native: boolean;
  enabled: boolean;
  density: "comfortable" | "compact";
  scopeKey: string;
  onNotify: (message: string) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const popup = useRef<HTMLDivElement>(null);
  const visible = enabled && menu?.scope === scopeKey ? menu : null;
  const current = useRef(visible);
  current.current = visible;

  function restore(snapshot: Menu) {
    if (!snapshot.target.isConnected) return false;
    snapshot.target.focus({ preventScroll: true });
    if (snapshot.field && snapshot.caret)
      snapshot.field.setSelectionRange(
        snapshot.caret.start,
        snapshot.caret.end,
        snapshot.caret.direction,
      );
    else if (snapshot.range?.commonAncestorContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(snapshot.range);
    }
    return true;
  }

  useEffect(() => {
    setMenu(null);
    if (!enabled) return;
    const open = (event: MouseEvent) => {
      // React's directory menu has already claimed the event before it bubbles
      // to document. Never put a second generic menu over a specific one.
      if (event.defaultPrevented) {
        setMenu(null);
        return;
      }
      event.preventDefault();
      const target =
        event.target instanceof HTMLElement
          ? event.target
          : event.target instanceof Element
            ? event.target.parentElement
            : null;
      if (!target || target.closest(".ce-context-menu")) return;
      setMenu(capture(target, scopeKey, event.clientX, event.clientY, false));
    };
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node)) setMenu(null);
    };
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => {
      const snapshot = current.current;
      if (
        (event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")) &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        const target =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : document.body;
        const rect = target.getBoundingClientRect();
        setMenu(capture(target, scopeKey, rect.left + 8, rect.bottom, true));
      } else if (snapshot && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        restore(snapshot);
      } else if (
        snapshot &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [
          ...(popup.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : index < 0
                ? event.key === "ArrowUp"
                  ? buttons.length - 1
                  : 0
                : (index +
                    (event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      } else if (snapshot && event.key === "Tab") {
        close();
        restore(snapshot);
      } else if (snapshot && !popup.current?.contains(event.target as Node))
        close();
    };
    document.addEventListener("contextmenu", open);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [scopeKey, enabled]);

  useLayoutEffect(() => {
    if (!visible || !popup.current) return;
    const rect = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        6,
        Math.min(visible.x, window.innerWidth - rect.width - 6),
      ),
      top: Math.max(
        6,
        Math.min(visible.y, window.innerHeight - rect.height - 6),
      ),
    });
    if (visible.keyboard)
      popup.current
        .querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
  }, [visible, density]);

  if (!visible) return null;
  const options = [
    {
      action: "copy",
      label: t("context.copy"),
      icon: Copy,
      shortcut: "Ctrl+C",
      disabled: !visible.selected,
    },
    {
      action: "cut",
      label: t("context.cut"),
      icon: Scissors,
      shortcut: "Ctrl+X",
      disabled: !visible.editable || !visible.selected,
    },
    {
      action: "paste",
      label: t("context.paste"),
      icon: ClipboardPaste,
      shortcut: "Ctrl+V",
      disabled: !visible.editable,
    },
    {
      action: "selectAll",
      label: t("context.selectAll"),
      icon: TextSelect,
      shortcut: "Ctrl+A",
      disabled: !!visible.field?.disabled,
    },
  ] as const;
  async function edit(action: EditAction) {
    if (current.current !== visible || !restore(visible!)) return;
    // Recheck read-only state after opening; a form may become disabled while
    // the popup is visible. The native engine remains the final edit authority.
    if (
      (action === "cut" || action === "paste") &&
      visible!.field &&
      (visible!.field.disabled || visible!.field.readOnly)
    ) {
      setMenu(null);
      return;
    }
    setMenu(null);
    try {
      if (native) await invoke("launcher_edit", { action });
      else if (!document.execCommand(action))
        throw new Error("editing unavailable");
    } catch {
      onNotify(t("context.failed"));
    }
  }
  return createPortal(
    <div
      className="ce-context-menu"
      data-density={density}
      ref={popup}
      role="menu"
      aria-label={t("context.menu")}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
    >
      {options.map(({ action, label, icon: Icon, shortcut, disabled }) => (
        <button
          type="button"
          role="menuitem"
          key={action}
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void edit(action)}
        >
          <Icon size={15} />
          <span>{label}</span>
          <kbd>{shortcut}</kbd>
        </button>
      ))}
    </div>,
    document.body,
  );
}
