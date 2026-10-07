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
} from "./maker-test-harness.mjs";
const doc = {
  id: "unit-1",
  name: "Complex rule",
  kind: "rules",
  state: "planned",
  notes: "Multi-stage requirements",
  files: ["src/main/java/Rule.java"],
  updatedAt: "2026-01-01T00:00:00.000Z",
};
function fixture() {
  const calls = [],
    intercept = new Map();
  let revision = "workspace-1",
    unit = doc;
  const api = async (_, { operation, args }) => {
    calls.push({ operation, args });
    if (intercept.has(operation)) return intercept.get(operation)(args);
    const common = {
      id: "project-1",
      revision: "revision-1",
      workspaceRevision: revision,
    };
    if (operation === "project_units")
      return {
        ...common,
        total: 300,
        filteredCount: 300,
        offset: args.offset ?? 0,
        nextOffset: (args.offset ?? 0) < 250 ? (args.offset ?? 0) + 50 : null,
        units: Array.from({ length: 50 }, (_, index) => ({
          id: `unit-${(args.offset ?? 0) + index}`,
          name: `Rule ${(args.offset ?? 0) + index}`,
          kind: "rules",
          state: "planned",
          fileCount: 1,
        })),
      };
    if (operation === "project_unit_read") return { ...common, unit };
    if (operation === "project_unit_save") {
      if (args.expectedWorkspaceRevision !== revision)
        throw new Error("Workspace changed");
      revision = "workspace-2";
      unit = {
        ...args.unit,
        id: args.unit.id || "new-unit",
        updatedAt: doc.updatedAt,
      };
      return { ...common, workspaceRevision: revision, unit };
    }
    throw new Error(operation);
  };
  return {
    api,
    calls,
    intercept,
    remoteRevision(next) {
      revision = next;
    },
  };
}
async function ready(section = "unit", unitId = "unit-1", f = fixture()) {
  const seed = harness("ExperimentalProjects", {
    api: async () => {},
    native: false,
  }).state.createProjectManagerDraft();
  const contexts = [],
    routes = [],
    ui = harness("MakerFeatures", {
      api: f.api,
      native: true,
      project: project(),
      route: {
        projectId: "project-1",
        section,
        unitId: section === "unit" ? unitId : undefined,
        kind: "rules",
      },
      draft: seed,
      onContext: (value) => contexts.push(value),
      onRoute: (value) => routes.push(value),
    });
  await ui.flush();
  return { f, ui, seed, contexts, routes };
}
test("large feature categories render one bounded summary page; details load only on opening", async () => {
  const { f, ui, routes } = await ready("units");
  assert.equal(
    elements(ui.tree, (node) => node.props.className === "maker-feature-row")
      .length,
    50,
  );
  assert.equal(elements(ui.tree, (node) => node.type === "textarea").length, 0);
  assert.ok(!content(ui.tree).includes(doc.notes));
  await click(ui, "experimental.nextPage");
  assert.equal(f.calls.at(-1).args.offset, 50);
  elements(
    ui.tree,
    (node) => node.props.className === "maker-feature-row",
  )[0].props.onClick();
  assert.equal(routes[0].unitId, "unit-50");
});
test("individual feature is a natural-language document and saving preserves separate source identity", async () => {
  const { f, ui, contexts } = await ready();
  await change(
    ui,
    "maker.featureRequirements",
    "A state machine with edge cases",
  );
  await click(ui, "maker.saveFeature");
  const write = f.calls.find(
    (value) => value.operation === "project_unit_save",
  ).args;
  assert.equal(write.unit.notes, "A state machine with edge cases");
  assert.equal("updatedAt" in write.unit, false);
  assert.equal(write.expectedRevision, "revision-1");
  assert.equal(contexts.at(-1).notes, write.unit.notes);
});
test("new feature uses organization CAS and routes to its durable identity", async () => {
  const { f, ui, routes } = await ready("unit", "new");
  await change(ui, "maker.featureName", "New system");
  await click(ui, "maker.saveFeature");
  assert.equal(routes[0].unitId, "new-unit");
  assert.equal(
    f.calls.filter((value) => value.operation === "job_create").length,
    0,
  );
});
test("refresh retains feature draft and requires explicit adoption of remote workspace revision", async () => {
  const { f, ui, seed } = await ready();
  await change(ui, "maker.featureRequirements", "Keep local draft");
  f.remoteRevision("workspace-new");
  await click(ui, "maker.saveFeature");
  assert.match(content(ui.tree), /Workspace changed/);
  assert.equal(seed.units.size, 1);
  await click(ui, "maker.refresh");
  assert.equal(
    field(ui, "maker.featureRequirements").props.value,
    "Keep local draft",
  );
  await click(ui, "maker.acceptFeatureRevision");
  await click(ui, "maker.saveFeature");
  assert.equal(seed.units.size, 0);
});
test("admitted feature save cannot erase a draft edited before its delayed completion", async () => {
  const f = fixture(),
    pending = deferred();
  f.intercept.set("project_unit_save", () => pending.promise);
  const { ui, seed } = await ready("unit", "unit-1", f);
  await change(ui, "maker.featureRequirements", "First edit");
  button(ui, "maker.saveFeature").props.onClick();
  await change(ui, "maker.featureRequirements", "Second edit");
  pending.resolve({
    id: "project-1",
    revision: "revision-1",
    workspaceRevision: "workspace-2",
    unit: { ...doc, notes: "First edit" },
  });
  await ui.flush();
  assert.equal(
    field(ui, "maker.featureRequirements").props.value,
    "Second edit",
  );
  assert.equal([...seed.units.values()][0].unit.notes, "Second edit");
});
test("replacement and unmounted feature callbacks cannot write or expose delayed details", async () => {
  const { ui, f } = await ready();
  const oldSave = button(ui, "maker.saveFeature").props.onClick;
  const other = fixture();
  ui.replace({ api: other.api });
  await ui.flush();
  oldSave();
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "project_unit_save").length,
    0,
  );
  const current = button(ui, "maker.saveFeature").props.onClick;
  ui.close();
  current();
  await ui.flush();
  assert.equal(
    other.calls.filter((value) => value.operation === "project_unit_save")
      .length,
    0,
  );
});
test("archived projects display feature documents without submitting edits", async () => {
  const { ui, f } = await ready();
  ui.replace({ project: { ...project(), archived: true } });
  await ui.flush();
  assert.equal(button(ui, "maker.saveFeature").props.disabled, true);
  button(ui, "maker.saveFeature").props.onClick();
  await ui.flush();
  assert.equal(
    f.calls.filter((value) => value.operation === "project_unit_save").length,
    0,
  );
});
