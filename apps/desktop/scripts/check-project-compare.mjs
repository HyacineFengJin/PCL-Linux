/** Real project-component events with isolated hook scheduling and API fixtures.
 * No desktop, game, provider credentials or network are used. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = fileURLToPath(new URL("../src/", import.meta.url));
function harness(api, retained, config = {}) {
  const modules = new Map(),
    hooks = [];
  let cursor = 0,
    dirty = false,
    pending = [],
    tree;
  const opened = [],
    indexed = [];
  const react = {
    useLayoutEffect(effect, deps) {
      react.useEffect(effect, deps);
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [
        hooks[index],
        (next) => {
          const value = typeof next === "function" ? next(hooks[index]) : next;
          if (!Object.is(value, hooks[index])) {
            hooks[index] = value;
            dirty = true;
          }
        },
      ];
    },
    useRef(value) {
      return (hooks[cursor++] ??= { current: value });
    },
    useMemo(factory, deps) {
      const index = cursor++,
        old = hooks[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i])))
        hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++,
        old = hooks[index];
      if (
        !deps ||
        !old ||
        deps.some((value, i) => !Object.is(value, old.deps[i]))
      ) {
        hooks[index] = { deps };
        pending.push(() => {
          old?.cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    function localRequire(name) {
      if (name === "react") return react;
      if (name === "./CeSelect") return { CeSelect: function CeSelect() {} };
      if (name.endsWith(".css")) return {};
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        return load(
          fs.existsSync(base + ".tsx") ? base + ".tsx" : base + ".ts",
        );
      }
      return require(name);
    }
    new Function("require", "module", "exports", code)(
      localRequire,
      module,
      module.exports,
    );
    return module.exports;
  }
  const component = load(path.join(source, "ExperimentalProjects.tsx"));
  const draft = retained ?? { current: component.createProjectManagerDraft() };
  const i18n = load(path.join(source, "i18n.ts"));
  function render() {
    cursor = 0;
    dirty = false;
    pending = [];
    tree = load(
      path.join(source, "ExperimentalProjectCompare.tsx"),
    ).ExperimentalProjectCompare({
      api,
      native: config.native ?? true,
      project: config.project,
      checkpointId: config.checkpointId,
    });
    for (const effect of pending) effect();
  }
  async function flush() {
    for (let count = 0; count < 20; count++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) return tree;
      render();
    }
    throw new Error("Project component did not settle");
  }
  render();
  return {
    flush,
    i18n,
    draft,
    opened,
    replaceApi(next) {
      api = next;
      render();
    },
    replaceComparison(project, checkpointId = project.checkpoints.at(-1)?.id) {
      config.project = project;
      config.checkpointId = checkpointId;
      render();
    },
    disableNative() {
      config.native = false;
      render();
    },
    indexed,
    get tree() {
      return tree;
    },
    close() {
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree && typeof tree === "object") return content(tree.props?.children);
  return typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : "";
}
function elements(tree, match) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree))
    return tree.flatMap((value) => elements(value, match));
  return [
    ...(match(tree) ? [tree] : []),
    ...elements(tree.props?.children, match),
  ];
}
function button(ui, key) {
  const text = ui.i18n.t(key);
  const value = elements(
    ui.tree,
    (node) => node.type === "button" && node.props.children === text,
  )[0];
  assert.ok(value, "Missing button: " + key);
  return value;
}
function field(ui, key) {
  const text = ui.i18n.t(key);
  const label = elements(
    ui.tree,
    (node) =>
      node.type === "label" &&
      elements(
        node.props.children,
        (child) => child.type === "span" && child.props.children === text,
      ).length,
  )[0];
  assert.ok(label, "Missing field: " + key);
  return elements(
    label,
    (node) =>
      node.type === "input" ||
      node.type === "textarea" ||
      node.type?.name === "CeSelect",
  )[0];
}
async function click(ui, key) {
  const value = button(ui, key);
  assert.equal(value.props.disabled, false);
  value.props.onClick();
  await ui.flush();
}
async function change(ui, key, value) {
  field(ui, key).props.onChange({ target: { value } });
  await ui.flush();
}
const checkpoint = {
  id: "point-1",
  label: "Initial",
  jobId: "job-1",
  operationId: "generate-1",
  workflow: "maker",
  createdAt: "2026-01-01T00:00:00.000Z",
};
function project(id = "project-1") {
  return {
    id,
    name: id,
    notes: "Saved notes",
    revision: "revision-1",
    archived: false,
    updatedAt: checkpoint.createdAt,
    checkpoints: [checkpoint],
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function comparisonFixture() {
  const record = {
    ...project(),
    checkpoints: [1, 2, 3].map((index) => ({
      ...checkpoint,
      id: "point-" + index,
      label: "Version " + index,
      fingerprint: String(index).repeat(64),
    })),
  };
  const calls = [],
    intercept = new Map();
  const changed = {
    path: "changed.java",
    kind: "modified",
    before: { bytes: 12, sha256: "old-hash" },
    after: { bytes: 20, sha256: "new-hash" },
  };
  const binary = {
    path: "image.png",
    kind: "added",
    before: null,
    after: { bytes: 8, sha256: "image-hash" },
  };
  const identity = (args) => ({
    id: args.id,
    revision: args.expectedRevision,
    baseCheckpointId: args.baseCheckpointId,
    targetCheckpointId: args.targetCheckpointId,
    baseFingerprint: record.checkpoints.find(
      (point) => point.id === args.baseCheckpointId,
    )?.fingerprint,
    targetFingerprint: record.checkpoints.find(
      (point) => point.id === args.targetCheckpointId,
    )?.fingerprint,
  });
  function listing(args) {
    const all = [
      changed,
      binary,
      ...Array.from({ length: 50 }, (_, i) => ({
        ...binary,
        path: `src/Added${i}.java`,
      })),
    ];
    const filtered = args.filter
      ? all.filter((change) => change.path.includes(args.filter))
      : all;
    const page = filtered.slice(args.offset, args.offset + 50);
    return {
      ...identity(args),
      counts: { added: 51, deleted: 0, modified: 1, unchanged: 3 },
      totalChanges: all.length,
      filteredCount: filtered.length,
      changes: page,
      offset: args.offset,
      pageSize: 50,
      nextOffset:
        args.offset + page.length < filtered.length
          ? args.offset + page.length
          : null,
    };
  }
  function preview(args) {
    const change = args.path === binary.path ? binary : changed;
    const metadata = {
      status: "text",
      truncated: true,
      previewBytes: 12,
      previewLines: 2,
    };
    return {
      ...identity(args),
      change,
      status: args.path === binary.path ? "uncomparable" : "text",
      before: change.before ? { ...change.before, ...metadata } : null,
      after: {
        ...change.after,
        ...metadata,
        ...(args.path === binary.path
          ? { status: "unsupported_type", truncated: false }
          : {}),
      },
      rows:
        args.path === binary.path
          ? []
          : [
              {
                kind: "deleted",
                beforeLine: 1,
                afterLine: null,
                text: "old source",
              },
              {
                kind: "added",
                beforeLine: null,
                afterLine: 1,
                text: "<script>new source</script>",
              },
            ],
      limits: { bytes: 16384, lines: 200, rows: 400 },
    };
  }
  async function api(command, { operation, args }) {
    assert.equal(command, "experimental_call");
    calls.push({ operation, args });
    if (intercept.has(operation)) return intercept.get(operation)(args);
    if (operation === "project_compare") return listing(args);
    if (operation === "project_compare_file") return preview(args);
    throw new Error(
      "Comparison must not invoke mutation, AI, build or game APIs: " +
        operation,
    );
  }
  function ui() {
    return harness(api, undefined, {
      compare: true,
      project: record,
      checkpointId: "point-2",
    });
  }
  return { record, calls, intercept, listing, preview, api, ui };
}
async function readComparison(ui, name) {
  await change(ui, "experimental.file", name);
  await click(ui, "experimental.comparePreview");
}
test("comparison sends version/revision references only, uses host paging/filter cursors and renders bounded read-only text and binary reasons", async () => {
  const f = comparisonFixture(),
    ui = f.ui();
  await ui.flush();
  assert.equal(f.calls.length, 0);
  await click(ui, "experimental.compareVersions");
  assert.deepEqual(f.calls[0].args, {
    id: f.record.id,
    expectedRevision: f.record.revision,
    baseCheckpointId: "point-1",
    targetCheckpointId: "point-2",
    filter: "",
    offset: 0,
  });
  await readComparison(ui, "changed.java");
  const rendered = elements(ui.tree, (node) => node.type === "pre")[0];
  assert.ok(rendered);
  assert.match(content(rendered), /- 1:– old source/);
  assert.match(content(rendered), /\+ –:1 <script>new source<\/script>/);
  assert.equal(
    elements(
      ui.tree,
      (node) => node.type === "script" || node.type === "textarea",
    ).length,
    0,
  );
  assert.match(content(ui.tree), /16384/);
  assert.match(content(ui.tree), /200/);
  await readComparison(ui, "image.png");
  assert.equal(elements(ui.tree, (node) => node.type === "pre").length, 0);
  assert.match(content(ui.tree), /二进制|Binary/);
  await click(ui, "experimental.nextPage");
  assert.equal(f.calls.at(-1).args.offset, 50);
  await click(ui, "experimental.previousPage");
  assert.equal(f.calls.at(-1).args.offset, 0);
  await change(ui, "experimental.pathFilter", "changed");
  assert.equal(button(ui, "experimental.nextPage").props.disabled, true);
  await click(ui, "experimental.compareVersions");
  assert.equal(f.calls.at(-1).args.filter, "changed");
  assert.equal(f.calls.at(-1).args.offset, 0);
  ui.close();
});
test("comparison retires prior render, selected-file and unmounted callbacks before any read admission", async () => {
  const f = comparisonFixture(),
    ui = f.ui();
  await ui.flush();
  await click(ui, "experimental.compareVersions");
  const oldCompare = button(ui, "experimental.compareVersions").props.onClick;
  const oldFile = field(ui, "experimental.file").props.onChange;
  await change(ui, "experimental.file", "changed.java");
  const preview = button(ui, "experimental.comparePreview").props.onClick;
  await change(ui, "experimental.file", "image.png");
  const before = f.calls.length;
  oldCompare();
  oldFile({ target: { value: "changed.java" } });
  preview();
  await ui.flush();
  assert.equal(f.calls.length, before);
  assert.equal(field(ui, "experimental.file").props.value, "image.png");
  const unmounted = button(ui, "experimental.comparePreview").props.onClick;
  ui.close();
  unmounted();
  await ui.flush();
  assert.equal(f.calls.length, before);
});
test("a delayed comparison and error cannot restore the old pair or filter", async () => {
  const f = comparisonFixture(),
    ui = f.ui(),
    delayed = deferred();
  await ui.flush();
  f.intercept.set("project_compare", () => delayed.promise);
  button(ui, "experimental.compareVersions").props.onClick();
  field(ui, "experimental.compareTarget").props.onChange({
    target: { value: "point-3" },
  });
  await ui.flush();
  delayed.resolve(f.listing(f.calls[0].args));
  await ui.flush();
  assert.equal(field(ui, "experimental.compareTarget").props.value, "point-3");
  assert.equal(
    elements(
      ui.tree,
      (node) => node.type === "option" && node.props.value === "changed.java",
    ).length,
    0,
  );
  let reject;
  f.intercept.set(
    "project_compare",
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  button(ui, "experimental.compareVersions").props.onClick();
  field(ui, "experimental.pathFilter").props.onChange({
    target: { value: "new-filter" },
  });
  await ui.flush();
  reject(new Error("obsolete comparison error"));
  await ui.flush();
  assert.equal(content(ui.tree).includes("obsolete comparison error"), false);
  assert.equal(field(ui, "experimental.pathFilter").props.value, "new-filter");
  ui.close();
});
test("a delayed file preview cannot overwrite a newer queued file selection", async () => {
  const f = comparisonFixture(),
    ui = f.ui(),
    delayed = deferred();
  await ui.flush();
  await click(ui, "experimental.compareVersions");
  await change(ui, "experimental.file", "changed.java");
  f.intercept.set("project_compare_file", () => delayed.promise);
  button(ui, "experimental.comparePreview").props.onClick();
  field(ui, "experimental.file").props.onChange({
    target: { value: "image.png" },
  });
  await ui.flush();
  delayed.resolve(f.preview(f.calls.at(-1).args));
  await ui.flush();
  assert.equal(field(ui, "experimental.file").props.value, "image.png");
  assert.equal(elements(ui.tree, (node) => node.type === "pre").length, 0);
  f.intercept.delete("project_compare_file");
  await click(ui, "experimental.comparePreview");
  assert.match(content(ui.tree), /二进制|Binary/);
  ui.close();
});
test("replacement APIs, projects, revisions and disabled native scopes retire old comparison requests", async () => {
  for (const replacement of ["api", "project", "revision", "native"]) {
    const f = comparisonFixture(),
      ui = f.ui(),
      delayed = deferred();
    await ui.flush();
    f.intercept.set("project_compare", () => delayed.promise);
    const oldClick = button(ui, "experimental.compareVersions").props.onClick;
    oldClick();
    await ui.flush();
    let newCalls = 0;
    if (replacement === "api")
      ui.replaceApi(async (_, { args }) => {
        newCalls++;
        return f.listing(args);
      });
    else if (replacement === "native") ui.disableNative();
    else
      ui.replaceComparison({
        ...f.record,
        ...(replacement === "project"
          ? { id: "next-project" }
          : { revision: "new-revision" }),
      });
    await ui.flush();
    delayed.resolve(f.listing(f.calls[0].args));
    await ui.flush();
    oldClick();
    await ui.flush();
    assert.equal(f.calls.length, 1);
    assert.equal(newCalls, 0);
    assert.equal(
      elements(
        ui.tree,
        (node) => node.type === "option" && node.props.value === "changed.java",
      ).length,
      0,
    );
    assert.equal(
      button(ui, "experimental.compareVersions").props.disabled,
      replacement === "native",
    );
    ui.close();
  }
});
test("comparison rejects wrong source fingerprints and file identity before rendering results", async () => {
  const f = comparisonFixture(),
    ui = f.ui();
  await ui.flush();
  f.intercept.set("project_compare", (args) => ({
    ...f.listing(args),
    baseFingerprint: "wrong",
  }));
  await click(ui, "experimental.compareVersions");
  assert.match(content(ui.tree), /不一致|does not match/);
  assert.equal(
    elements(
      ui.tree,
      (node) => node.type === "option" && node.props.value === "changed.java",
    ).length,
    0,
  );
  f.intercept.delete("project_compare");
  await click(ui, "experimental.compareVersions");
  await change(ui, "experimental.file", "changed.java");
  f.intercept.set("project_compare_file", (args) => ({
    ...f.preview(args),
    change: { ...f.preview(args).change, path: "wrong.java" },
  }));
  await click(ui, "experimental.comparePreview");
  assert.match(content(ui.tree), /不一致|does not match/);
  assert.equal(elements(ui.tree, (node) => node.type === "pre").length, 0);
  ui.close();
});
test("same-checkpoint selection and duplicate queued comparison events do not admit extra reads", async () => {
  const f = comparisonFixture(),
    ui = f.ui(),
    delayed = deferred();
  await ui.flush();
  await change(ui, "experimental.compareBase", "point-2");
  assert.equal(button(ui, "experimental.compareVersions").props.disabled, true);
  button(ui, "experimental.compareVersions").props.onClick();
  await ui.flush();
  assert.equal(f.calls.length, 0);
  await change(ui, "experimental.compareBase", "point-1");
  f.intercept.set("project_compare", () => delayed.promise);
  const click = button(ui, "experimental.compareVersions").props.onClick;
  click();
  click();
  await ui.flush();
  assert.equal(f.calls.length, 1);
  ui.close();
  delayed.resolve(f.listing(f.calls[0].args));
  await ui.flush();
});
