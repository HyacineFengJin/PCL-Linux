import { FileCode2, Folder } from "lucide-react";
type Node = { children: Map<string, Node>; files: string[] };
/** Group the current bounded index page only. Folder expansion never scans or
 * grants arbitrary disk paths; file reads still use the host source receipt. */
export function MakerFileTree({
  names,
  selected,
  disabled,
  onChoose,
}: {
  names: string[];
  selected: string;
  disabled: boolean;
  onChoose: (path: string) => void;
}) {
  const root: Node = { children: new Map(), files: [] };
  for (const name of names) {
    const parts = name.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part))
        node.children.set(part, { children: new Map(), files: [] });
      node = node.children.get(part)!;
    }
    node.files.push(name);
  }
  function render(node: Node, prefix = ""): React.ReactNode {
    return (
      <>
        {[...node.children].map(([name, child]) => {
          let label = name,
            branch = child;
          while (!branch.files.length && branch.children.size === 1) {
            const [part, next] = [...branch.children][0];
            label += `/${part}`;
            branch = next;
          }
          return (
            <details key={name} open>
              <summary title={`${prefix}${label}`}>
                <Folder size={13} />
                <span>{label}</span>
              </summary>
              <div className="maker-directory-children">
                {render(branch, `${prefix}${label}/`)}
              </div>
            </details>
          );
        })}
        {node.files.map((name) => (
          <button
            key={name}
            title={name}
            className={selected === name ? "selected" : ""}
            disabled={
              disabled ||
              !/\.(java|json|mcmeta|lang|txt|md|properties|gradle|kts|toml|xml)$/i.test(
                name,
              )
            }
            onClick={() => onChoose(name)}
          >
            <FileCode2 size={14} />
            <span>{name.split("/").at(-1)}</span>
          </button>
        ))}
      </>
    );
  }
  return <div className="maker-file-tree">{render(root)}</div>;
}
