import assert from "node:assert/strict";
import test from "node:test";
import {
  harness,
  elements,
  content,
  button,
  field,
  click,
  change,
  deferred,
  project,
  engine,
} from "./maker-test-harness.mjs";
function fixture(records = [project()]) {
  const calls = [],
    intercept = new Map();
  const api = async (_, { operation, args }) => {
    calls.push({ operation, args });
    if (intercept.has(operation)) return intercept.get(operation)(args);
    if (operation === "projects_list") return { projects: records };
    if (operation === "status") return engine;
    if (operation === "job_create" || operation === "project_continue")
      return { jobId: "new-job" };
    if (operation === "project_update") {
      const value = {
        ...records.find((value) => value.id === args.id),
        ...args,
        revision: "revision-2",
      };
      records = records.map((old) => (old.id === value.id ? value : old));
      return value;
    }
    throw new Error(operation);
  };
  return { api, calls, intercept };
}
function openProject(ui, id = "project-1") {
  const tile = elements(
    ui.tree,
    (node) =>
      node.type === "button" &&
      node.props.className === "maker-project-tile ce-card" &&
      content(node).includes(id),
  )[0];
  assert.ok(tile);
  tile.props.onClick();
}
test("library contains summaries only; opening a project exposes separate IDE documents", async () => {
  const f = fixture(
      Array.from({ length: 30 }, (_, i) => project(`project-${i + 1}`)),
    ),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  assert.equal(
    elements(
      ui.tree,
      (node) => node.props.className === "maker-project-tile ce-card",
    ).length,
    24,
  );
  assert.equal(elements(ui.tree, (node) => node.type === "textarea").length, 0);
  assert.ok(!content(ui.tree).includes("Saved requirements"));
  openProject(ui);
  await ui.flush();
  assert.equal(ui.props.draft.current.screen, "workspace");
  assert.equal(
    elements(ui.tree, (node) => node.props.className === "maker-project-tree")
      .length,
    1,
  );
  await click(ui, "maker.kind.rules");
  const featurePanel = elements(
    ui.tree,
    (node) => node.type?.name === "MakerFeatures",
  )[0];
  assert.equal(featurePanel.props.route.section, "units");
  assert.equal(featurePanel.props.route.kind, "rules");
  featurePanel.props.onRoute({
    projectId: "project-1",
    section: "unit",
    kind: "rules",
    unitId: "rule-1",
  });
  await ui.flush();
  assert.equal(
    elements(ui.tree, (node) => node.type?.name === "MakerFeatures")[0].props
      .route.unitId,
    "rule-1",
  );
  assert.ok(elements(ui.tree, (node) => node.props.role === "tab").length >= 3);
});
test("creation submits natural language via saved shared AI; there is no template spec or implicit job", async () => {
  const f = fixture([]),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "job_create").length,
    0,
  );
  await click(ui, "maker.newProject");
  await change(ui, "experimental.projectName", "Large mod");
  await change(
    ui,
    "maker.projectGoal",
    "A multi-stage economy with rules and events",
  );
  await click(ui, "maker.createWithAi");
  const request = f.calls.find(
    (value) => value.operation === "job_create",
  ).args;
  assert.equal(request.mode, "live");
  assert.equal(request.profile, "maker");
  assert.equal("spec" in request, false);
  assert.match(request.prompt, /multi-stage economy/);
  assert.equal(ui.props.draft.current.pending.length, 1);
  assert.equal(ui.props.draft.current.route.section, "tasks");
});
test("AI continuation includes the active document and selected source without a second engine", async () => {
  const f = fixture(),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  await click(ui, "maker.kind.rules");
  elements(
    ui.tree,
    (node) => node.type?.name === "MakerFeatures",
  )[0].props.onContext({
    id: "rule",
    name: "Moon rule",
    kind: "rules",
    notes: "Three-stage event",
    files: ["src/main/java/Rule.java"],
  });
  await ui.flush();
  let panel = elements(
    ui.tree,
    (node) => node.type?.name === "MakerAiPanel",
  )[0];
  panel.props.onPrompt("Implement the event");
  await ui.flush();
  panel = elements(ui.tree, (node) => node.type?.name === "MakerAiPanel")[0];
  panel.props.onSend();
  await ui.flush();
  const request = f.calls.find(
    (value) => value.operation === "project_continue",
  ).args;
  assert.equal(request.expectedRevision, "revision-1");
  assert.equal(request.checkpointId, "point-1");
  assert.match(request.prompt, /Moon rule/);
  assert.match(request.prompt, /Three-stage event/);
  assert.equal(ui.props.draft.current.route.jobId, "new-job");
});
test("project settings preserve local drafts across remount and reject stale revision until accepted", async () => {
  const f = fixture(),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  await click(ui, "maker.section.settings");
  await change(ui, "maker.projectGoal", "My handwritten constraint");
  const retained = ui.props.draft;
  ui.close();
  const fresh = project();
  fresh.revision = "revision-new";
  const next = fixture([fresh]);
  next.intercept.set("project_update", (args) => {
    if (args.expectedRevision !== "revision-new")
      throw new Error("stale revision");
    return { ...fresh, notes: args.notes, revision: "revision-final" };
  });
  const reopened = harness("ExperimentalProjects", {
    api: next.api,
    native: true,
    draft: retained,
  });
  await reopened.flush();
  assert.equal(
    field(reopened, "maker.projectGoal").props.value,
    "My handwritten constraint",
  );
  await click(reopened, "maker.saveProject");
  assert.match(content(reopened.tree), /stale revision/);
  assert.ok(retained.current.notes.has("project-1"));
  await click(reopened, "maker.acceptProjectRevision");
  await click(reopened, "maker.saveProject");
  assert.equal(retained.current.notes.has("project-1"), false);
});
test("retired callbacks and late host completions cannot navigate a newer project selection", async () => {
  const f = fixture([project(), project("project-2")]),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  await click(ui, "maker.section.settings");
  const stale = button(ui, "maker.saveProject").props.onClick;
  await change(ui, "maker.projectGoal", "New notes");
  stale();
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "project_update").length,
    0,
  );
  const delayed = deferred();
  f.intercept.set("project_update", () => delayed.promise);
  button(ui, "maker.saveProject").props.onClick;
  const save = button(ui, "maker.saveProject").props.onClick;
  save();
  await click(ui, "maker.allProjects");
  openProject(ui, "project-2");
  await ui.flush();
  delayed.resolve({ ...project(), revision: "revision-2", notes: "New notes" });
  await ui.flush();
  assert.equal(ui.props.draft.current.route.projectId, "project-2");
  assert.ok(ui.props.draft.current.notes.has("project-1"));
});
test("old API and unmounted callbacks cannot submit new AI requests", async () => {
  const f = fixture([]),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  await click(ui, "maker.newProject");
  await change(ui, "experimental.projectName", "Mod");
  await change(ui, "maker.projectGoal", "Complex behavior");
  const old = button(ui, "maker.createWithAi").props.onClick;
  const replacement = fixture([]);
  ui.replace({ api: replacement.api });
  await ui.flush();
  old();
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "job_create").length,
    0,
  );
  const current = button(ui, "maker.createWithAi").props.onClick;
  ui.close();
  current();
  await ui.flush();
  assert.equal(
    replacement.calls.filter((value) => value.operation === "job_create")
      .length,
    0,
  );
});

test("recording a new output appends a nested source reference and preserves archive state", async () => {
  const f = fixture(),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  await click(ui, "maker.section.tasks");
  elements(ui.tree, (node) => node.type?.name === "MakerJob")[0].props.onRecord(
    "host-review-1",
  );
  await ui.flush();
  await change(ui, "experimental.versionLabel", "Second iteration");
  const modal = elements(
    ui.tree,
    (node) => node.type?.name === "InstanceOperationDialog",
  )[0];
  modal.props.onConfirm();
  await ui.flush();
  const write = f.calls.find(
    (value) => value.operation === "project_update",
  ).args;
  assert.equal(write.archived, false);
  assert.deepEqual(write.source, {
    jobId: "job-1",
    operationId: "host-review-1",
    label: "Second iteration",
  });
  assert.equal(ui.props.draft.current.route.section, "overview");
});

test("unrecorded output browsing cannot accidentally continue from a different recorded source", async () => {
  const f = fixture(),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  await click(ui, "maker.section.tasks");
  elements(ui.tree, (node) => node.type?.name === "MakerJob")[0].props.onSource(
    "new-unrecorded",
  );
  await ui.flush();
  const assistant = elements(
    ui.tree,
    (node) => node.type?.name === "MakerAiPanel",
  )[0];
  assert.equal(assistant.props.disabled, true);
  assert.ok(assistant.props.blockedReason);
  assistant.props.onSend();
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "project_continue").length,
    0,
  );
});

test("closing an earlier document tab cannot retire or select a newer document", async () => {
  const f = fixture(),
    ui = harness("ExperimentalProjects", { api: f.api, native: true });
  await ui.flush();
  openProject(ui);
  await ui.flush();
  const oldClose = elements(
    ui.tree,
    (node) => node.props.className === "maker-tab-close",
  )[0].props.onClick;
  await click(ui, "maker.kind.rules");
  const before = ui.props.draft.current.tabs.length;
  oldClose();
  await ui.flush();
  assert.equal(ui.props.draft.current.tabs.length, before);
  assert.equal(ui.props.draft.current.route.kind, "rules");
});
