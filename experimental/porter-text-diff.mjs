/** Bounded text comparison only. LCS work is capped before allocating; larger
 * middle blocks use a valid delete/add hunk and explicitly report coarse mode.
 * Display limits never affect file classification or the verified hashes. */
export function porterTextDiff(name, before, after, budget = 6000) {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) || [];
  const b = after.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix),
    right = b.slice(prefix, b.length - suffix);
  const coarse = (left.length + 1) * (right.length + 1) > 250000;
  const operations = a.slice(0, prefix).map((line) => ({ kind: " ", line }));
  if (coarse || !left.length || !right.length) {
    operations.push(
      ...left.map((line) => ({ kind: "-", line })),
      ...right.map((line) => ({ kind: "+", line })),
    );
  } else {
    const width = right.length + 1;
    const lcs = new Uint16Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        lcs[i * width + j] =
          left[i] === right[j]
            ? 1 + lcs[(i + 1) * width + j + 1]
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    let i = 0,
      j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        operations.push({ kind: " ", line: left[i++] });
        j++;
      } else if (
        i < left.length &&
        (j === right.length ||
          lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
      )
        operations.push({ kind: "-", line: left[i++] });
      else operations.push({ kind: "+", line: right[j++] });
    }
  }
  operations.push(
    ...a.slice(a.length - suffix).map((line) => ({ kind: " ", line })),
  );
  const ranges = [];
  for (let i = 0; i < operations.length; i++) {
    if (operations[i].kind === " ") continue;
    const start = Math.max(0, i - 3),
      end = Math.min(operations.length, i + 4);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = end;
    else ranges.push({ start, end });
  }
  let output = "",
    bytes = 0,
    truncated = false;
  function append(line) {
    if (bytes + Buffer.byteLength(line) > budget) {
      truncated = true;
      return false;
    }
    output += line;
    bytes += Buffer.byteLength(line);
    return true;
  }
  if (ranges.length && append(`--- a/${name}\n+++ b/${name}\n`)) {
    let cursor = 0,
      oldLine = 1,
      newLine = 1;
    for (const { start, end } of ranges) {
      while (cursor < start) {
        if (operations[cursor].kind !== "+") oldLine++;
        if (operations[cursor++].kind !== "-") newLine++;
      }
      const hunk = operations.slice(start, end);
      const oldCount = hunk.filter((o) => o.kind !== "+").length;
      const newCount = hunk.filter((o) => o.kind !== "-").length;
      if (
        !append(
          `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@\n`,
        )
      )
        break;
      for (const o of hunk) {
        const terminated = o.line.endsWith("\n");
        if (
          !append(
            `${o.kind}${o.line}${terminated ? "" : "\n\\ No newline at end of file\n"}`,
          )
        )
          break;
      }
      if (truncated) break;
    }
  }
  return { text: output, truncated, coarse, bytes };
}
