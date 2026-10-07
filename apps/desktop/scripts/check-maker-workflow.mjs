/** Actual Maker workflow component events with isolated React scheduling and
 * a fault-injectable host fixture. No game, desktop, credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  ts = require("typescript");
const source = fileURLToPath(new URL("../src/", import.meta.url));
function harness(api, initialJob = "job-a") {
  const modules = new Map(),
    hooks = [],
    timers = new Map();
  let cursor = 0,
    dirty = false,
    pending = [],
    tree,
    closed = false;
  const drafts = { current: { maker: { jobId: initialJob } } };
  const navigated = [],
    configured = [];
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
          if (closed) return;
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
      if (!old || deps.some((v, i) => !Object.is(v, old.deps[i])))
        hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++,
        old = hooks[index];
      if (!deps || !old || deps.some((v, i) => !Object.is(v, old.deps[i]))) {
        hooks[index] = { deps };
        pending.push(() => {
          old?.cleanup?.();
          hooks[index].cleanup = effect();
        });
      }
    },
  };
  const window = {
    setInterval(callback) {
      const id = {};
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
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
      if (name === "./instanceOperationUi")
        return {
          InstanceOperationDialog: function InstanceOperationDialog() {},
        };
      if (name === "./ExperimentalExtensions")
        return { ExperimentalExtensions: function ExperimentalExtensions() {} };
      if (name === "./ExperimentalPorterWorkspace")
        return {
          ExperimentalPorterWorkspace:
            function ExperimentalPorterWorkspace() {},
        };
      if (name.endsWith(".css")) return {};
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        return load(
          fs.existsSync(base + ".tsx") ? base + ".tsx" : base + ".ts",
        );
      }
      return require(name);
    }
    new Function("require", "module", "exports", "window", code)(
      localRequire,
      module,
      module.exports,
      window,
    );
    return module.exports;
  }
  const component = load(path.join(source, "ExperimentalTools.tsx"));
  const i18n = load(path.join(source, "i18n.ts"));
  function render() {
    cursor = 0;
    dirty = false;
    pending = [];
    tree = component.ExperimentalTools({
      api,
      native: true,
      page: "maker",
      drafts,
      onNavigate: (...args) => navigated.push(args),
      onConfigureAi: () => configured.push(true),
    });
    // The integrated wrapper delegates Maker to this common component while
    // Porter owns a separate workspace. Exercise the actual Maker handlers.
    if (tree.type?.name === "ExperimentalCommonTools")
      tree = tree.type(tree.props);
    for (const effect of pending) effect();
  }
  async function flush() {
    for (let count = 0; count < 30; count++) {
      await new Promise((done) => setImmediate(done));
      if (!dirty || closed) return tree;
      render();
    }
    throw new Error("Maker workflow did not settle");
  }
  render();
  return {
    flush,
    i18n,
    drafts,
    navigated,
    configured,
    get tree() {
      return tree;
    },
    replaceApi(next) {
      api = next;
      render();
    },
    async poll() {
      for (const callback of [...timers.values()]) callback();
      await flush();
    },
    close() {
      closed = true;
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
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
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree && typeof tree === "object") return content(tree.props?.children);
  return typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : "";
}
function button(ui, key) {
  const value = elements(
    ui.tree,
    (n) => n.type === "button" && n.props.children === ui.i18n.t(key),
  )[0];
  assert.ok(value, "Missing button: " + key);
  return value;
}
function field(ui, key) {
  const label = elements(
    ui.tree,
    (n) =>
      n.type === "label" &&
      elements(
        n.props.children,
        (c) => c.type === "span" && c.props.children === ui.i18n.t(key),
      ).length,
  )[0];
  assert.ok(label, "Missing field: " + key);
  return elements(
    label,
    (n) =>
      n.type === "input" ||
      n.type === "textarea" ||
      n.type?.name === "CeSelect",
  )[0];
}
function editor(ui) {
  return elements(
    ui.tree,
    (n) =>
      n.type === "textarea" &&
      n.props["aria-label"] === ui.i18n.t("experimental.sourceEdit"),
  )[0];
}
function dialog(ui) {
  return elements(
    ui.tree,
    (n) => n.type?.name === "InstanceOperationDialog",
  )[0];
}
function select(ui, id) {
  const value = elements(
    ui.tree,
    (n) =>
      n.type === "button" &&
      n.props.className?.includes("experimental-job") &&
      content(n).includes(id),
  )[0];
  assert.ok(value, "Missing task: " + id);
  value.props.onClick();
}
async function change(ui, key, value) {
  field(ui, key).props.onChange({ target: { value } });
  await ui.flush();
}
async function edit(ui, value = "new source") {
  editor(ui).props.onChange({ target: { value } });
  await ui.flush();
}
async function preview(ui) {
  assert.equal(button(ui, "experimental.previewEdit").props.disabled, false);
  button(ui, "experimental.previewEdit").props.onClick();
  await ui.flush();
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const fileA = "src/main/java/First.java",
  fileB = "src/main/java/Second.java";
function fixture() {
  const calls = [],
    intercept = new Map(),
    digest = "a".repeat(64);
  const jobs = Object.fromEntries(
    ["job-a", "job-b"].map((jobId) => [
      jobId,
      {
        summary: {
          jobId,
          revision: 1,
          workflow: "maker",
          status: "completed",
          mode: "template",
          updatedAt: "2026-01-01T00:00:00Z",
          artifactState: "generated",
        },
        mode: "template",
        result: null,
        artifacts: ["base", "source"].map((operationId) => ({
          operationId,
          directory: operationId,
          files: [fileA, fileB],
        })),
        reviews: [],
      },
    ]),
  );
  const reviews = new Map();
  let sequence = 0,
    commits = 0;
  function commit(args) {
    const review = reviews.get(args.reviewId);
    assert.equal(review.jobId, args.jobId);
    assert.equal(review.reviewDigest, args.digest);
    assert.equal(
      review.status,
      "pending",
      "Fixture rejects replayed host approvals",
    );
    review.status = "applied";
    commits++;
    jobs[args.jobId].artifacts.push({
      operationId: `host-${args.reviewId}`,
      directory: "reviewed",
      files: [fileA, fileB],
    });
    return { reviewId: args.reviewId };
  }
  async function api(command, payload) {
    assert.equal(command, "experimental_call");
    const { operation, args } = payload;
    calls.push({ operation, args });
    if (intercept.has(operation)) return intercept.get(operation)(args);
    if (operation === "status")
      return {
        jobs: Object.values(jobs).map((j) => j.summary),
        versions: {},
        liveAvailable: true,
      };
    if (operation === "catalog") return { targets: [] };
    if (operation === "job_read") return structuredClone(jobs[args.jobId]);
    if (operation === "artifact_read")
      return {
        path: args.path,
        sha256: "b".repeat(64),
        content: `${args.jobId}/${args.operationId}/${args.path}`,
        binary: false,
      };
    if (operation === "job_create") {
      const jobId = "created-job";
      jobs[jobId] = {
        ...structuredClone(jobs["job-a"]),
        summary: { ...jobs["job-a"].summary, jobId },
      };
      return { jobId };
    }
    if (operation === "maker_review") {
      const reviewId = "review-" + ++sequence;
      reviews.set(reviewId, {
        jobId: args.jobId,
        reviewId,
        reviewDigest: digest,
        status: "pending",
        kind: "maker_source_edit",
        preview: { diffs: [{ path: args.path, diff: "+new source" }] },
      });
      jobs[args.jobId].reviews.push(reviewId);
      return { reviewId, reviewDigest: digest };
    }
    if (operation === "review_read")
      return structuredClone(reviews.get(args.reviewId));
    if (operation === "review_apply") return commit(args);
    if (operation === "review_cancel") {
      reviews.get(args.reviewId).status = "revoked";
      return {};
    }
    throw new Error("Unexpected operation: " + operation);
  }
  return {
    api,
    calls,
    intercept,
    jobs,
    reviews,
    commit,
    get commits() {
      return commits;
    },
  };
}
async function ready(f = fixture()) {
  const ui = harness(f.api);
  await ui.flush();
  assert.ok(editor(ui));
  return { ui, f };
}
async function reopen(ui) {
  const value = elements(
    ui.tree,
    (n) =>
      n.type === "button" &&
      content(n).startsWith(ui.i18n.t("experimental.review") + " ·"),
  )[0];
  assert.ok(value);
  value.props.onClick();
  await ui.flush();
}
test("retired render and unmounted Maker events cannot submit or change source selections", async () => {
  const { ui, f } = await ready();
  await edit(ui);
  const generate = button(ui, "experimental.generate").props.onClick;
  const previewEdit = button(ui, "experimental.previewEdit").props.onClick;
  const oldFile = field(ui, "experimental.file").props.onChange;
  const oldSpec = elements(
    ui.tree,
    (n) => n.type?.name === "ExperimentalMaker",
  )[0].props.onChange;
  await change(ui, "experimental.file", fileB);
  const before = f.calls.length;
  generate();
  previewEdit();
  oldFile({ target: { value: fileA } });
  oldSpec({ mod_id: "obsolete" });
  await ui.flush();
  assert.equal(f.calls.length, before);
  assert.equal(field(ui, "experimental.file").props.value, fileB);
  await edit(ui);
  await preview(ui);
  const confirm = dialog(ui).props.onConfirm,
    close = dialog(ui).props.onClose;
  const unmountedGenerate = button(ui, "experimental.generate").props.onClick;
  const unmountedPreview = button(ui, "experimental.previewEdit").props.onClick;
  const configure = button(ui, "experimental.ai").props.onClick;
  const count = f.calls.length;
  ui.close();
  confirm();
  close();
  unmountedGenerate();
  unmountedPreview();
  configure();
  await ui.flush();
  assert.equal(f.calls.length, count);
  assert.equal(ui.configured.length, 0);
});
test("admitted generation survives a queued selection but its delayed result cannot select its job", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  f.intercept.set("job_create", async () => {
    await delayed.promise;
    f.jobs["created-job"] = structuredClone(f.jobs["job-a"]);
    return { jobId: "created-job" };
  });
  button(ui, "experimental.generate").props.onClick();
  select(ui, "job-b");
  await ui.flush();
  delayed.resolve();
  await ui.flush();
  assert.ok(f.jobs["created-job"]);
  assert.equal(ui.drafts.current.maker.jobId, "job-b");
  assert.equal(f.calls.filter((v) => v.operation === "job_create").length, 1);
  ui.close();
});
test("delayed preview and review reads cannot open a review after source or draft changes", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  await edit(ui);
  f.intercept.set("maker_review", () => delayed.promise);
  button(ui, "experimental.previewEdit").props.onClick();
  field(ui, "experimental.file").props.onChange({ target: { value: fileB } });
  await ui.flush();
  delayed.resolve({ reviewId: "obsolete-review" });
  await ui.flush();
  assert.equal(f.calls.filter((v) => v.operation === "review_read").length, 0);
  assert.equal(dialog(ui), undefined);
  f.intercept.delete("maker_review");
  await edit(ui);
  const read = deferred();
  f.intercept.set("review_read", () => read.promise);
  button(ui, "experimental.previewEdit").props.onClick();
  await ui.flush();
  editor(ui).props.onChange({ target: { value: "newer draft" } });
  await ui.flush();
  read.resolve(structuredClone(f.reviews.get("review-1")));
  await ui.flush();
  assert.equal(dialog(ui), undefined);
  assert.equal(editor(ui).props.value, "newer draft");
  ui.close();
});
test("delayed source reads and poll errors do not overwrite the next file or its edits", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  f.intercept.set("artifact_read", (args) =>
    args.path === fileB
      ? delayed.promise
      : {
          path: args.path,
          sha256: "c",
          content: "current source",
          binary: false,
        },
  );
  await change(ui, "experimental.file", fileB);
  await change(ui, "experimental.file", fileA);
  await edit(ui, "local current draft");
  delayed.resolve({
    path: fileB,
    sha256: "d",
    content: "obsolete source",
    binary: false,
  });
  await ui.flush();
  assert.equal(editor(ui).props.value, "local current draft");
  const poll = deferred();
  f.intercept.set("job_read", () => poll.promise);
  await ui.poll();
  await edit(ui, "newer poll draft");
  poll.reject(new Error("obsolete poll failure"));
  await ui.flush();
  assert.equal(content(ui.tree).includes("obsolete poll failure"), false);
  ui.close();
});
test("review response identity is checked before exposing confirmation", async () => {
  const { ui, f } = await ready();
  await edit(ui);
  f.intercept.set("review_read", () => ({
    ...f.reviews.get("review-1"),
    jobId: "job-b",
  }));
  await preview(ui);
  assert.equal(dialog(ui), undefined);
  assert.match(content(ui.tree), /Review response identity/);
  ui.close();
});
test("duplicate confirmation is admitted once and selects only the owning committed copy", async () => {
  const { ui, f } = await ready();
  await edit(ui);
  await preview(ui);
  const confirm = dialog(ui).props.onConfirm;
  confirm();
  confirm();
  await ui.flush();
  assert.equal(f.commits, 1);
  assert.equal(f.calls.filter((v) => v.operation === "review_apply").length, 1);
  assert.equal(dialog(ui), undefined);
  assert.equal(field(ui, "experimental.artifact").props.value, "host-review-1");
  ui.close();
});
test("a confirmed host copy remains committed when its following job refresh fails", async () => {
  const { ui, f } = await ready();
  await edit(ui);
  await preview(ui);
  f.intercept.set("job_read", () => {
    throw new Error("post-commit refresh failed");
  });
  const confirm = dialog(ui).props.onConfirm;
  confirm();
  await ui.flush();
  confirm();
  await ui.flush();
  assert.equal(f.commits, 1);
  assert.equal(dialog(ui), undefined);
  assert.match(content(ui.tree), /post-commit refresh failed/);
  assert.ok(
    f.jobs["job-a"].artifacts.some((v) => v.operationId === "host-review-1"),
  );
  ui.close();
});
test("uncertain acknowledgements require an authoritative pending review before retry", async () => {
  for (const committed of [false, true]) {
    const { ui, f } = await ready();
    await edit(ui);
    await preview(ui);
    f.intercept.set("review_apply", (args) => {
      if (committed) f.commit(args);
      throw new Error("acknowledgement unavailable");
    });
    dialog(ui).props.onConfirm();
    await ui.flush();
    assert.equal(dialog(ui).props.confirmDisabled, true);
    dialog(ui).props.onConfirm();
    await ui.flush();
    assert.equal(
      f.calls.filter((v) => v.operation === "review_apply").length,
      1,
    );
    f.intercept.delete("review_apply");
    await ui.poll();
    await reopen(ui);
    assert.equal(dialog(ui).props.confirmDisabled, committed);
    dialog(ui).props.onConfirm();
    await ui.flush();
    assert.equal(f.commits, 1);
    assert.equal(
      f.calls.filter((v) => v.operation === "review_apply").length,
      committed ? 1 : 2,
    );
    ui.close();
  }
});
test("a delayed old-API approval is retained in the host without touching the replacement page", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  await edit(ui);
  await preview(ui);
  f.intercept.set("review_apply", async (args) => {
    const result = f.commit(args);
    await delayed.promise;
    return result;
  });
  dialog(ui).props.onConfirm();
  await ui.flush();
  const replacement = fixture();
  ui.replaceApi(replacement.api);
  await ui.flush();
  await edit(ui, "replacement source");
  delayed.resolve();
  await ui.flush();
  assert.equal(f.commits, 1);
  assert.equal(replacement.commits, 0);
  assert.equal(editor(ui).props.value, "replacement source");
  assert.equal(dialog(ui), undefined);
  assert.equal(field(ui, "experimental.artifact").props.value, "source");
  assert.equal(ui.navigated.length, 0);
  ui.close();
});

test("a dialog retired by source selection cannot confirm or cancel its old review", async () => {
  const { ui, f } = await ready();
  await edit(ui);
  await preview(ui);
  const confirm = dialog(ui).props.onConfirm,
    close = dialog(ui).props.onClose;
  await change(ui, "experimental.artifact", "base");
  const before = f.calls.length;
  confirm();
  close();
  await ui.flush();
  assert.equal(f.calls.length, before);
  assert.equal(f.reviews.get("review-1").status, "pending");
  assert.equal(dialog(ui), undefined);
  assert.equal(field(ui, "experimental.artifact").props.value, "base");
  ui.close();
});

test("a host apply admitted before a queued task selection cannot select its committed copy", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  await edit(ui);
  await preview(ui);
  f.intercept.set("review_apply", async (args) => {
    const result = f.commit(args);
    await delayed.promise;
    return result;
  });
  dialog(ui).props.onConfirm();
  select(ui, "job-b");
  await ui.flush();
  delayed.resolve();
  await ui.flush();
  assert.equal(f.commits, 1);
  assert.equal(ui.drafts.current.maker.jobId, "job-b");
  assert.equal(field(ui, "experimental.artifact").props.value, "source");
  assert.equal(dialog(ui), undefined);
  ui.close();
});

test("post-apply job reads cannot replace the source selected while that read was pending", async () => {
  const { ui, f } = await ready(),
    delayed = deferred();
  await edit(ui);
  await preview(ui);
  f.intercept.set("job_read", () => delayed.promise);
  dialog(ui).props.onConfirm();
  await ui.flush();
  assert.equal(dialog(ui), undefined);
  field(ui, "experimental.artifact").props.onChange({
    target: { value: "base" },
  });
  await ui.flush();
  delayed.resolve(structuredClone(f.jobs["job-a"]));
  await ui.flush();
  assert.equal(f.commits, 1);
  assert.equal(field(ui, "experimental.artifact").props.value, "base");
  assert.match(editor(ui).props.value, /job-a\/base\//);
  ui.close();
});
