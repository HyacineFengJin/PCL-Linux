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
function harness(api, retained) {
  const modules = new Map(),
    hooks = [];
  let cursor = 0,
    dirty = false,
    pending = [],
    tree;
  const opened = [];
  const react = {
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
    tree = component.ExperimentalProjects({
      api,
      native: true,
      draft,
      onOpen: (value) => opened.push(value),
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
  return typeof tree === "string" ? tree : "";
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
test("project drafts survive selection, refresh and AI-settings remount; stale writes need explicit revision acceptance", async () => {
  let records = [project(), project("project-2")];
  const saves = [];
  async function api(_, { operation, args }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list")
      return { projects: structuredClone(records) };
    if (operation === "project_update") {
      saves.push(args);
      const current = records.find((value) => value.id === args.id);
      if (args.expectedRevision !== current.revision)
        throw new Error("Project changed; refresh before saving");
      const next = { ...current, ...args, revision: "revision-3" };
      records = records.map((value) => (value.id === next.id ? next : value));
      return next;
    }
    throw new Error("Unexpected operation: " + operation);
  }
  let ui = harness(api);
  await ui.flush();
  function select(id) {
    elements(
      ui.tree,
      (node) =>
        node.type === "button" &&
        elements(
          node.props.children,
          (child) => child.type === "span" && content(child) === id,
        ).length,
    )[0].props.onClick();
  }
  select("project-1");
  await ui.flush();
  await change(ui, "experimental.projectNotes", "My unsaved design");
  select("project-2");
  await ui.flush();
  select("project-1");
  await ui.flush();
  assert.equal(
    field(ui, "experimental.projectNotes").props.value,
    "My unsaved design",
  );
  const retained = ui.draft;
  ui.close();
  ui = harness(api, retained);
  await ui.flush();
  assert.equal(
    field(ui, "experimental.projectNotes").props.value,
    "My unsaved design",
  );
  records[0] = {
    ...records[0],
    notes: "Another editor",
    revision: "revision-2",
  };
  await click(ui, "experimental.refresh");
  await click(ui, "experimental.saveProject");
  assert.equal(saves[0].expectedRevision, "revision-1");
  assert.equal(records[0].notes, "Another editor");
  assert.equal(
    field(ui, "experimental.projectNotes").props.value,
    "My unsaved design",
  );
  await click(ui, "experimental.retryProjectSave");
  await click(ui, "experimental.saveProject");
  assert.equal(saves[1].expectedRevision, "revision-2");
  assert.equal(records[0].notes, "My unsaved design");
  ui.close();
});
test("opening and AI continuation use the host-selected checkpoint and return its spec and seeded operation", async () => {
  const record = project(),
    requests = [];
  const spec = { mod_id: "retained_mod" },
    continued = {
      workflow: "maker",
      jobId: "new-job",
      operationId: "host-seed",
      spec,
    };
  async function api(_, { operation, args }) {
    requests.push({ operation, args });
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [record] };
    if (operation === "project_open")
      return {
        workflow: "maker",
        jobId: checkpoint.jobId,
        operationId: checkpoint.operationId,
        spec,
      };
    if (operation === "project_continue") return continued;
    throw new Error("Unexpected operation: " + operation);
  }
  const ui = harness(api);
  await ui.flush();
  elements(
    ui.tree,
    (node) =>
      node.type === "button" &&
      elements(
        node.props.children,
        (child) => child.type === "span" && content(child) === record.name,
      ).length,
  )[0].props.onClick();
  await ui.flush();
  await click(ui, "experimental.continueEditing");
  assert.equal(ui.opened[0].spec, spec);
  assert.deepEqual(
    requests.find((value) => value.operation === "project_open").args,
    {
      id: record.id,
      expectedRevision: record.revision,
      checkpointId: checkpoint.id,
    },
  );
  await change(ui, "experimental.prompt", "Expand behavior");
  await click(ui, "experimental.continueAI");
  assert.deepEqual(ui.opened[1], continued);
  await change(ui, "experimental.projectNotes", "Unsaved constraint");
  assert.equal(button(ui, "experimental.continueAI").props.disabled, true);
  assert.equal(
    elements(ui.tree, (node) => node.type?.name === "ExperimentalVersion")[0]
      .props.version,
    "0.5",
  );
  ui.close();
});

function selectProject(ui, name) {
  const value = elements(
    ui.tree,
    (node) =>
      node.type === "button" &&
      elements(
        node.props.children,
        (child) => child.type === "span" && content(child) === name,
      ).length,
  )[0];
  assert.ok(value, "Missing project: " + name);
  value.props.onClick();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("callbacks from an earlier render or an unmounted page cannot submit project writes or continuation", async () => {
  const writes = [],
    record = project();
  async function api(_, { operation, args }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [record] };
    writes.push({ operation, args });
    return {};
  }
  const ui = harness(api);
  await ui.flush();
  selectProject(ui, record.name);
  await ui.flush();
  await change(ui, "experimental.prompt", "Continue this mod");
  const earlierSave = button(ui, "experimental.saveProject").props.onClick;
  await change(ui, "experimental.projectNotes", "New local notes");
  earlierSave();
  await ui.flush();
  assert.equal(writes.length, 0);
  const save = button(ui, "experimental.saveProject").props.onClick;
  const continueAi = button(ui, "experimental.continueAI").props.onClick;
  ui.close();
  save();
  continueAi();
  await ui.flush();
  assert.equal(writes.length, 0);
  assert.equal(ui.draft.current.notes, "New local notes");
});
test("a delayed previous-API refresh and its retired callback cannot replace the current project list", async () => {
  const delayed = deferred(),
    current = project("current-api-project");
  let oldCalls = 0;
  async function oldApi(_, { operation }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") {
      oldCalls++;
      return delayed.promise;
    }
    throw new Error("Unexpected old API write");
  }
  async function newApi(_, { operation }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [current] };
    throw new Error("Unexpected new API write");
  }
  const ui = harness(oldApi);
  await ui.flush();
  const oldRefresh = button(ui, "experimental.refresh").props.onClick;
  ui.replaceApi(newApi);
  await ui.flush();
  selectProject(ui, current.name);
  await ui.flush();
  delayed.resolve({ projects: [project("previous-api-project")] });
  await ui.flush();
  oldRefresh();
  await ui.flush();
  assert.equal(oldCalls, 1);
  assert.equal(field(ui, "experimental.name").props.value, current.name);
  assert.equal(
    elements(
      ui.tree,
      (node) =>
        node.type === "span" && content(node) === "previous-api-project",
    ).length,
    0,
  );
  ui.close();
});
test("a committed save stays in the host but its delayed result does not replace a newer selection", async () => {
  const delayed = deferred(),
    records = [project(), project("next-project")],
    requests = [];
  async function api(_, { operation, args }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list")
      return { projects: structuredClone(records) };
    if (operation === "project_update") {
      requests.push(args);
      await delayed.promise;
      records[0] = {
        ...records[0],
        name: args.name,
        notes: args.notes,
        revision: "saved-revision",
      };
      return records[0];
    }
    throw new Error("Unexpected operation: " + operation);
  }
  const ui = harness(api);
  await ui.flush();
  selectProject(ui, records[0].name);
  await ui.flush();
  await change(ui, "experimental.projectNotes", "Committed design");
  // Two events can be queued before the busy render. The second selection must
  // remain selected even though the first event already admitted a host write.
  button(ui, "experimental.saveProject").props.onClick();
  selectProject(ui, records[1].name);
  await ui.flush();
  delayed.resolve();
  await ui.flush();
  assert.equal(requests.length, 1);
  assert.equal(records[0].notes, "Committed design");
  assert.equal(field(ui, "experimental.name").props.value, records[1].name);
  assert.equal(
    field(ui, "experimental.projectNotes").props.value,
    records[1].notes,
  );
  assert.equal(ui.draft.current.id, records[1].id);
  ui.close();
});
test("a previous-API source-open response cannot navigate the replacement page", async () => {
  const delayed = deferred(),
    oldRecord = project(),
    newRecord = project("replacement-project");
  let opens = 0;
  async function oldApi(_, { operation }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [oldRecord] };
    if (operation === "project_open") {
      opens++;
      return delayed.promise;
    }
    throw new Error("Unexpected old API operation");
  }
  async function newApi(_, { operation }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [newRecord] };
    throw new Error("Unexpected replacement API operation");
  }
  const ui = harness(oldApi);
  await ui.flush();
  selectProject(ui, oldRecord.name);
  await ui.flush();
  button(ui, "experimental.continueEditing").props.onClick();
  await ui.flush();
  ui.replaceApi(newApi);
  await ui.flush();
  selectProject(ui, newRecord.name);
  await ui.flush();
  delayed.resolve({
    workflow: "maker",
    jobId: "previous-api-job",
    operationId: "source",
    spec: { mod_id: "old_mod" },
  });
  await ui.flush();
  assert.equal(opens, 1);
  assert.equal(ui.opened.length, 0);
  assert.equal(ui.draft.current.id, newRecord.id);
  ui.close();
});

test("an edit queued after save admission remains a local draft after the host commit returns", async () => {
  const delayed = deferred();
  let record = project();
  async function api(_, { operation, args }) {
    if (operation === "status") return { jobs: [] };
    if (operation === "projects_list") return { projects: [record] };
    if (operation === "project_update") {
      await delayed.promise;
      record = { ...record, notes: args.notes, revision: "committed-revision" };
      return record;
    }
    throw new Error("Unexpected operation: " + operation);
  }
  const ui = harness(api);
  await ui.flush();
  selectProject(ui, record.name);
  await ui.flush();
  await change(ui, "experimental.projectNotes", "Committed A");
  button(ui, "experimental.saveProject").props.onClick();
  field(ui, "experimental.projectNotes").props.onChange({
    target: { value: "Draft B" },
  });
  await ui.flush();
  delayed.resolve();
  await ui.flush();
  assert.equal(record.notes, "Committed A");
  assert.equal(field(ui, "experimental.projectNotes").props.value, "Draft B");
  assert.equal(ui.draft.current.notes, "Draft B");
  assert.equal(
    button(ui, "experimental.retryProjectSave").props.disabled,
    false,
  );
  ui.close();
});
