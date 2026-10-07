/** Actual component/event regressions, with an in-memory host and no native app.
 * Run: node --test apps/desktop/tests/porter-workspace.test.cjs
 * Requires desktop build dependencies and an isolated react-test-renderer of
 * the same React version. NODE_PATH may point to that test installation; this
 * does not add a renderer dependency to the shipped desktop or its lockfile.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test, after } = require("node:test");
const { Module, createRequire } = require("node:module");
const rendererRequire = createRequire(require.resolve("react-test-renderer"));
const React = rendererRequire("react");
const { act, create } = rendererRequire("react-test-renderer");
assert.equal(React.version, require("react/package.json").version);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Compile the real workspace and children, rather than a copy of its guards.
// React externals resolve beside the isolated renderer so hooks share one copy.
const desktop = path.resolve(__dirname, "..");
const output = require("esbuild").buildSync({
  absWorkingDir: desktop,
  stdin: {
    contents: `export { ExperimentalPorterWorkspace } from './src/ExperimentalPorterWorkspace';
      export { ExperimentalPorter } from './src/ExperimentalPorter';
      export { CeSelect } from './src/CeSelect';
      export { InstanceOperationDialog } from './src/instanceOperationUi';
      export { t } from './src/i18n';`,
    resolveDir: desktop,
    loader: "tsx",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom"],
  loader: { ".css": "empty" },
}).outputFiles[0].text;
const fixtureModule = new Module(
  path.join(__dirname, "porter-fixture.cjs"),
  module,
);
fixtureModule.filename = fixtureModule.id;
fixtureModule.paths = module.paths;
const defaultRequire = fixtureModule.require.bind(fixtureModule);
fixtureModule.require = (id) =>
  /^react(?:\/|$)/.test(id) ? rendererRequire(id) : defaultRequire(id);
fixtureModule._compile(output, fixtureModule.filename);
const {
  ExperimentalPorterWorkspace,
  ExperimentalPorter,
  CeSelect,
  InstanceOperationDialog,
  t,
} = fixtureModule.exports;

const oldWindow = globalThis.window;
const timers = new Map();
let timerId = 0;
globalThis.window = {
  setInterval(fn) {
    const id = ++timerId;
    timers.set(id, fn);
    return id;
  },
  clearInterval(id) {
    timers.delete(id);
  },
};
after(() => {
  assert.equal(
    timers.size,
    0,
    "every component must release its polling timers",
  );
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
});

const text = (node) =>
  typeof node === "string" ? node : (node.children || []).map(text).join("");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const source = {
  files: { "src/Example.java": "class Example {}" },
  permittedPaths: ["src/Example.java"],
  targetId: "neoforge-26.3",
  identifierProfile: null,
};
function project(id) {
  return {
    id,
    revision: 1,
    name: `Project ${id}`,
    goal: `Goal ${id}`,
    targetId: source.targetId,
    rights: "owner",
    acknowledgeBeta: true,
    identifierProfile: null,
    origin: null,
    archived: false,
    awaitingQuestion: null,
    activeRound: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    snapshot: {
      ...source,
      revision: 1,
      label: "Source",
      fingerprint: "fixture",
    },
    messages: [],
    rounds: [1, 2].map((i) => ({
      id: `${id}-round-${i}`,
      jobId: `${id}${i}`,
      status: "completed",
      mode: "template",
      targetId: source.targetId,
      baselineRevision: 1,
      createdAt: "2026-01-01",
      conversationThrough: null,
    })),
  };
}
function job(jobId) {
  return {
    summary: {
      jobId,
      revision: 1,
      workflow: "porter",
      status: "completed",
      mode: "template",
      updatedAt: "2026-01-01",
      artifactState: "retained",
      blockedReason: null,
    },
    mode: "template",
    result: null,
    porterSource: source,
    reviews: [`review-${jobId}`],
    artifacts: [1, 2].map((i) => ({
      operationId: `${jobId}-copy-${i}`,
      directory: `copy ${i}`,
      files: ["src/Example.java", "src/Other.java"],
    })),
  };
}
function server(prefix = "") {
  const projects = { A: project("A"), B: project("B") },
    calls = [],
    commits = [],
    holds = [];
  const listing = () => ({
    projects: Object.values(projects).map((p) => ({
      id: p.id,
      name: prefix + p.name,
      targetId: p.targetId,
      updatedAt: p.updatedAt,
      archived: p.archived,
      hasSource: true,
      awaitingQuestion: false,
      activeRound: null,
      latestJobId: p.rounds.at(-1).jobId,
      jobIds: p.rounds.map((r) => r.jobId),
      rounds: 2,
    })),
    unreadableProjectIds: [],
  });
  function value(op, args) {
    if (op === "status")
      return {
        versions: {},
        jobs: Object.values(projects).flatMap((p) =>
          p.rounds.map((r) => job(r.jobId).summary),
        ),
        liveAvailable: false,
      };
    if (op === "porter_projects") return listing();
    if (op === "porter_project_read")
      return structuredClone(projects[args.projectId]);
    if (op === "catalog")
      return {
        targets: [source.targetId, "fabric-1.21-yarn-source"].map((id) => ({
          id,
          minecraft: "1.21",
          loader: id,
          channel: "snapshot",
        })),
      };
    if (op === "job_read") return job(args.jobId);
    if (op === "report_read") return null;
    if (op === "artifact_read")
      return { content: `${args.jobId}/${args.operationId}/${args.path}` };
    if (op === "review_read")
      return {
        reviewId: args.reviewId,
        reviewDigest: `digest-${args.reviewId}`,
        status: "pending",
        kind: "porter",
        preview: { changes: [] },
      };
    if (op === "review_cancel") return { cancelled: true };
    if (op === "porter_project_message") {
      const p = projects[args.projectId];
      p.revision++;
      p.messages.push({
        id: `message-${p.revision}`,
        role: "user",
        kind: args.kind,
        content: args.content,
        createdAt: "2026-01-01",
      });
      return structuredClone(p);
    }
    throw new Error(`Unexpected fixture operation ${op}`);
  }
  const api = (command, envelope = {}) => {
    const op = command === "experimental_call" ? envelope.operation : command;
    const args = command === "experimental_call" ? envelope.args : envelope;
    calls.push({ op, args });
    const hold = holds.find(
      (h) => h.op === op && !h.received && (!h.match || h.match(args)),
    );
    if (hold) {
      hold.received = args;
      return hold.promise.then((result) => {
        if (
          [
            "porter_project_round",
            "review_apply",
            "porter_project_create",
          ].includes(op)
        )
          commits.push({ op, args, result });
        return result;
      });
    }
    return Promise.resolve(value(op, args));
  };
  return {
    api,
    calls,
    commits,
    projects,
    listing,
    value,
    hold(op, match) {
      const h = { ...deferred(), op, match, received: null };
      holds.push(h);
      return h;
    },
    count(op) {
      return calls.filter((c) => c.op === op).length;
    },
  };
}
async function panel(options = {}) {
  const host = options.host || server();
  const drafts = {
    current: {
      porter: { porterProjectId: "A", jobId: "A1", ...(options.draft || {}) },
    },
  };
  const navigation = [];
  let props = {
    api: host.api,
    native: true,
    drafts,
    onBrowseMods: () => navigation.push("mods"),
    onConfigureAi: () => navigation.push("ai"),
    ...(options.props || {}),
  };
  let renderer,
    closed = false;
  await act(async () => {
    renderer = create(React.createElement(ExperimentalPorterWorkspace, props));
  });
  return {
    host,
    drafts,
    navigation,
    renderer,
    async update(next) {
      props = { ...props, ...next };
      await act(async () =>
        renderer.update(
          React.createElement(ExperimentalPorterWorkspace, props),
        ),
      );
    },
    async close() {
      if (!closed) {
        closed = true;
        await act(async () => renderer.unmount());
      }
    },
  };
}
const button = (h, label) =>
  h.renderer.root.findAll((n) => n.type === "button" && text(n) === label)[0];
const projectButton = (h, id) =>
  h.renderer.root.findAll(
    (n) => n.type === "button" && text(n).startsWith(`Project ${id} ·`),
  )[0];
const roundButton = (h, i) =>
  h.renderer.root.findAll(
    (n) =>
      n.type === "button" && text(n).startsWith(`${i} · ${source.targetId} ·`),
  )[0];
const discussion = (h) =>
  h.renderer.root.findByProps({
    "aria-label": t("experimental.porterDiscussion"),
  });
const select = (h, value) =>
  h.renderer.root.findAllByType(CeSelect).find((n) => n.props.value === value);
const click = async (fn) =>
  act(async () => {
    fn();
  });
async function compose(h) {
  await click(() =>
    discussion(h).props.onChange({
      target: { value: "Please preserve this behavior" },
    }),
  );
  return button(h, t("experimental.porterSend")).props.onClick;
}
async function openReview(h) {
  const b = h.renderer.root.findAll(
    (n) =>
      n.type === "button" &&
      text(n).startsWith(t("experimental.review") + " ·"),
  )[0];
  await click(b.props.onClick);
  return h.renderer.root.findByType(InstanceOperationDialog).props;
}

test("retained message/round/apply and navigation callbacks cannot run after unmount", async () => {
  for (const action of ["message", "round", "apply", "close", "mods", "ai"]) {
    const h = await panel();
    try {
      const handler =
        action === "message"
          ? await compose(h)
          : action === "round"
            ? button(h, t("experimental.porterContinue")).props.onClick
            : action === "apply"
              ? (await openReview(h)).onConfirm
              : action === "close"
                ? (await openReview(h)).onClose
                : button(
                    h,
                    t(
                      action === "mods"
                        ? "experimental.porterBrowseMods"
                        : "experimental.ai",
                    ),
                  ).props.onClick;
      await h.close();
      const before = h.host.calls.length;
      await click(handler);
      assert.equal(h.host.calls.length, before, action);
      assert.deepEqual(h.navigation, []);
    } finally {
      await h.close();
    }
  }
});

test("API and native changes retire saved callbacks permanently", async () => {
  const h = await panel();
  try {
    const oldSend = await compose(h);
    const next = server("New API ");
    await h.update({ api: next.api });
    const before = h.host.calls.length,
      nextBefore = next.calls.length;
    await click(oldSend);
    assert.equal(h.host.calls.length, before);
    assert.equal(next.calls.length, nextBefore);
    const nativeSend = await compose(h);
    await h.update({ native: false });
    await h.update({ native: true });
    const count = next.count("porter_project_message");
    await click(nativeSend);
    assert.equal(next.count("porter_project_message"), count);
    await click(await compose(h));
    assert.equal(next.count("porter_project_message"), count + 1);
  } finally {
    await h.close();
  }
});

test("old refresh and recovery responses cannot overwrite the new API", async () => {
  for (const reject of [false, true]) {
    const h = await panel();
    try {
      const send = await compose(h);
      if (reject) {
        const write = h.host.hold("porter_project_message");
        await click(send);
        const read = h.host.hold("porter_project_read");
        await click(() => write.reject(new Error("Fixture write rejection")));
        assert.ok(read.received);
        const next = server("Current ");
        await h.update({ api: next.api });
        await click(() =>
          read.resolve({ ...project("A"), name: "Obsolete recovery" }),
        );
        assert.equal(
          text(h.renderer.root).includes("Obsolete recovery"),
          false,
        );
      } else {
        const read = h.host.hold("porter_projects");
        await click(send);
        assert.ok(read.received);
        const next = server("Current ");
        await h.update({ api: next.api });
        await click(() =>
          read.resolve({
            ...h.host.listing(),
            projects: [
              { ...h.host.listing().projects[0], name: "Obsolete refresh" },
            ],
          }),
        );
        assert.equal(text(h.renderer.root).includes("Obsolete refresh"), false);
        assert.match(text(h.renderer.root), /Current Project B/);
      }
    } finally {
      await h.close();
    }
  }
});

test("old project/round/file replies and callbacks cannot change a new selection", async () => {
  const h = await panel();
  try {
    const oldSend = await compose(h);
    const oldRound = button(h, t("experimental.porterContinue")).props.onClick;
    const held = h.host.hold("porter_project_read", (a) => a.projectId === "A");
    await click(projectButton(h, "A").props.onClick);
    assert.ok(held.received);
    await click(projectButton(h, "B").props.onClick);
    await click(() =>
      held.resolve({ ...project("A"), name: "Obsolete project A" }),
    );
    assert.equal(h.drafts.current.porter.porterProjectId, "B");
    assert.equal(text(h.renderer.root).includes("Obsolete project A"), false);
    const before = h.host.calls.length;
    await click(() => {
      oldSend();
      oldRound();
    });
    assert.equal(h.host.calls.length, before);
    const roundRead = h.host.hold("job_read", (a) => a.jobId === "B1");
    await click(roundButton(h, 1).props.onClick);
    assert.ok(roundRead.received);
    await click(roundButton(h, 2).props.onClick);
    await click(() =>
      roundRead.resolve({ ...job("B1"), error: { message: "Obsolete round" } }),
    );
    assert.equal(h.drafts.current.porter.jobId, "B2");
    assert.equal(text(h.renderer.root).includes("Obsolete round"), false);
    const fileRead = h.host.hold(
      "artifact_read",
      (a) => a.path === "src/Other.java",
    );
    await click(() =>
      select(h, "src/Example.java").props.onChange({
        target: { value: "src/Other.java" },
      }),
    );
    assert.ok(fileRead.received);
    await click(() =>
      select(h, "src/Other.java").props.onChange({
        target: { value: "src/Example.java" },
      }),
    );
    await click(() => fileRead.resolve({ content: "Obsolete file" }));
    const file = h.renderer.root.findByProps({
      "aria-label": t("experimental.file"),
    });
    assert.equal(file.props.value.includes("Obsolete file"), false);
    assert.match(file.props.value, /src\/Example.java$/);
  } finally {
    await h.close();
  }
});

test("busy admission blocks retained and current project/round/copy/file/navigation callbacks", async () => {
  const h = await panel();
  try {
    const selections = () => {
      const copy = select(h, "A1-copy-2").props.onChange;
      const file = select(h, "src/Example.java").props.onChange;
      return [
        projectButton(h, "B").props.onClick,
        roundButton(h, 2).props.onClick,
        button(h, t("experimental.porterNewProject")).props.onClick,
        button(h, t("experimental.porterConfiguration")).props.onClick,
        button(h, t("experimental.porterBrowseMods")).props.onClick,
        button(h, t("experimental.ai")).props.onClick,
        () => copy({ target: { value: "A1-copy-1" } }),
        () => file({ target: { value: "src/Other.java" } }),
      ];
    };
    const retained = selections();
    const mode = select(h, "template").props.onChange;
    const write = h.host.hold("porter_project_message");
    const send = await compose(h);
    await click(() => {
      send();
      send();
    });
    assert.equal(h.host.count("porter_project_message"), 1);
    await click(() => {
      for (const fn of [...retained, ...selections()]) fn();
      mode({ target: { value: "live" } });
    });
    assert.equal(h.drafts.current.porter.porterProjectId, "A");
    assert.equal(h.drafts.current.porter.jobId, "A1");
    assert.equal(h.drafts.current.porter.porterNew, false);
    assert.equal(select(h, "A1-copy-2").props.value, "A1-copy-2");
    assert.equal(select(h, "src/Example.java").props.value, "src/Example.java");
    assert.equal(h.drafts.current.porter.mode, "template");
    assert.deepEqual(h.navigation, []);
    await click(() =>
      write.resolve(h.host.value("porter_project_message", write.received)),
    );
    await click(projectButton(h, "B").props.onClick);
    assert.equal(h.drafts.current.porter.porterProjectId, "B");
  } finally {
    await h.close();
  }
});

test("busy source import blocks form/target/grant/cancel callbacks", async () => {
  const h = await panel({
    draft: {
      porterNew: true,
      porterName: "Draft",
      porterGoal: "Goal",
      source: { sourceId: "source", files: source.files, skipped: [] },
      rights: "owner",
      beta: true,
      allowed: source.permittedPaths,
    },
  });
  try {
    const inputs = h.renderer.root.findAll(
      (n) => n.type === "input" && !n.props.readOnly && n.props.maxLength,
    );
    const form = h.renderer.root.findByType(ExperimentalPorter).props;
    const cancel = button(h, t("common.cancel")).props.onClick;
    const chooser = h.host.hold("experimental_choose");
    await click(form.onImport);
    await click(() => {
      form.onTarget("fabric-1.21-yarn-source");
      form.onRights("unknown");
      form.onBeta(false);
      form.onAllowed([]);
      form.onIdentifierDeclared(true);
      cancel();
      inputs[0].props.onChange({ target: { value: "Obsolete draft" } });
      h.renderer.root
        .findByType(ExperimentalPorter)
        .props.onTarget("fabric-1.21-yarn-source");
    });
    const draft = h.drafts.current.porter;
    assert.equal(draft.targetId, source.targetId);
    assert.equal(draft.rights, "owner");
    assert.equal(draft.beta, true);
    assert.deepEqual(draft.allowed, source.permittedPaths);
    assert.equal(draft.porterName, "Draft");
    assert.equal(draft.porterNew, true);
    await click(() => chooser.resolve({ status: "cancelled" }));
  } finally {
    await h.close();
  }
});

test("retired multi-call actions keep admitted host writes without dispatching later steps", async () => {
  for (const action of ["round", "apply", "create"])
    for (const retire of ["unmount", "api", "intake"]) {
      const h = await panel(
        action === "create"
          ? {
              draft: {
                porterNew: true,
                porterName: "Draft",
                porterGoal: "Goal",
                source: {
                  sourceId: "source",
                  files: source.files,
                  skipped: [],
                },
              },
            }
          : {},
      );
      try {
        const op = {
          round: "porter_project_round",
          apply: "review_apply",
          create: "porter_project_create",
        }[action];
        const admitted = h.host.hold(op);
        const handler =
          action === "round"
            ? button(h, t("experimental.porterContinue")).props.onClick
            : action === "apply"
              ? (await openReview(h)).onConfirm
              : button(h, t("experimental.porterCreateAndStart")).props.onClick;
        await click(handler);
        assert.ok(admitted.received);
        if (retire === "unmount") await h.close();
        else if (retire === "api")
          await h.update({ api: server("Current ").api });
        else
          await h.update({
            intake: {
              id: "new-intake",
              title: "Current intake",
              url: "https://modrinth.com/mod/example",
            },
          });
        const before = h.host.calls.length;
        const selectedBefore = structuredClone(h.drafts.current.porter);
        // This fake host commits independently of the renderer, as the real host
        // owns durability and cleanup after request admission.
        await click(() => {
          admitted.resolve(
            action === "round"
              ? { jobId: "new-round" }
              : action === "create"
                ? project("C")
                : { applied: true },
          );
        });
        assert.equal(h.host.commits.at(-1).op, op);
        assert.equal(
          h.host.calls.length,
          before,
          "retired UI must not read/start the next step",
        );
        assert.deepEqual(
          h.drafts.current.porter,
          selectedBefore,
          "old completion cannot navigate or replace the current draft",
        );
      } finally {
        await h.close();
      }
    }
});

test("review close and repeated confirms obey current admission", async () => {
  const h = await panel();
  try {
    const review = await openReview(h);
    const apply = h.host.hold("review_apply");
    await click(review.onConfirm);
    await click(() => {
      review.onClose();
      review.onConfirm();
      h.renderer.root.findByType(InstanceOperationDialog).props.onClose();
    });
    assert.equal(h.host.count("review_cancel"), 0);
    assert.equal(h.host.count("review_apply"), 1);
    assert.equal(
      h.renderer.root.findAllByType(InstanceOperationDialog).length,
      1,
    );
    await click(() => apply.resolve({ applied: true }));
    assert.equal(
      h.renderer.root.findAllByType(InstanceOperationDialog).length,
      0,
    );
    await click(review.onConfirm);
    assert.equal(h.host.count("review_apply"), 1);
  } finally {
    await h.close();
  }
});

test("an old completion cannot unlock a newer API transaction", async () => {
  const h = await panel();
  try {
    const first = h.host.hold("porter_project_message");
    await click(await compose(h));
    const next = server(),
      second = next.hold("porter_project_message");
    await h.update({ api: next.api });
    const send = await compose(h);
    await click(send);
    assert.ok(second.received, "a new API has its own admission");
    await click(() =>
      first.resolve(h.host.value("porter_project_message", first.received)),
    );
    await click(() => {
      projectButton(h, "B").props.onClick();
      send();
    });
    assert.equal(h.drafts.current.porter.porterProjectId, "A");
    assert.equal(next.count("porter_project_message"), 1);
    await click(() =>
      second.resolve(next.value("porter_project_message", second.received)),
    );
    await click(projectButton(h, "B").props.onClick);
    assert.equal(h.drafts.current.porter.porterProjectId, "B");
  } finally {
    await h.close();
  }
});

test("same round/copy/file selections preserve admission and Strict Mode remains usable", async () => {
  const h = await panel();
  try {
    await click(() => {
      roundButton(h, 1).props.onClick();
      select(h, "A1-copy-2").props.onChange({ target: { value: "A1-copy-2" } });
      select(h, "src/Example.java").props.onChange({
        target: { value: "src/Example.java" },
      });
    });
    await click(await compose(h));
    assert.equal(h.host.count("porter_project_message"), 1);
  } finally {
    await h.close();
  }
  const host = server();
  let strict;
  try {
    await act(async () => {
      strict = create(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(ExperimentalPorterWorkspace, {
            api: host.api,
            native: true,
            drafts: { current: {} },
          }),
        ),
      );
    });
    const newProject = strict.root.findAll(
      (n) =>
        n.type === "button" && text(n) === t("experimental.porterNewProject"),
    )[0];
    await click(newProject.props.onClick);
    assert.equal(strict.root.findAllByType(ExperimentalPorter).length, 1);
  } finally {
    if (strict) await act(async () => strict.unmount());
  }
});
