import { useState, type ReactNode } from "react";

/** Retain opened controls during the closing transition; defer unopened lists. */
export function Collapse({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(open);
  if (open && !visited) setVisited(true);
  return (
    <div
      className={`ce-collapse-panel ${open ? "is-open" : ""}`}
      inert={!open}
      aria-hidden={!open}
    >
      <div className="ce-collapse-panel-inner">
        {(open || visited) && children}
      </div>
    </div>
  );
}
