/** Isolated component-event checks using real TS/JSX and message catalogs.
 * Only useRef is supplied by this harness; no desktop app or browser is opened.
 * Run with: node apps/desktop/scripts/check-maker.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = fileURLToPath(new URL("../src/", import.meta.url));

function panel() {
  const modules = new Map(),
    refs = [];
  let cursor = 0;
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    function localRequire(name) {
      if (name === "react")
        return {
          useRef(value) {
            const index = cursor++;
            return (refs[index] ??= { current: value });
          },
        };
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
  const maker = load(path.join(source, "ExperimentalMaker.tsx"));
  const i18n = load(path.join(source, "i18n.ts"));
  let spec = structuredClone(maker.initialMakerSpec);
  function render(disabled = false) {
    cursor = 0;
    return maker.ExperimentalMaker({
      spec,
      disabled,
      onChange(next) {
        spec = next;
      },
    });
  }
  return {
    maker,
    i18n,
    render,
    get spec() {
      return spec;
    },
    set spec(next) {
      spec = next;
    },
  };
}

function elements(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree))
    return tree.flatMap((node) => elements(node, predicate));
  return [
    ...(predicate(tree) ? [tree] : []),
    ...elements(tree.props?.children, predicate),
  ];
}
function field(tree, text) {
  const label = elements(
    tree,
    (node) =>
      node.type === "label" && node.props.children[0].props.children === text,
  )[0];
  assert.ok(label, `Field missing: ${text}`);
  return label.props.children[1];
}
function button(tree, text) {
  const found = elements(
    tree,
    (node) => node.type === "button" && node.props.children === text,
  );
  assert.ok(found.length, `Button missing: ${text}`);
  return found;
}

test("adding after removal or manual rename keeps item IDs unique and defaults private", () => {
  const p = panel();
  const t = p.i18n.t;
  button(p.render(), t("experimental.addItem"))[0].props.onClick();
  button(p.render(), t("experimental.addItem"))[0].props.onClick();
  button(p.render(), t("experimental.removeItem"))[1].props.onClick();
  button(p.render(), t("experimental.addItem"))[0].props.onClick();
  assert.equal(
    new Set(p.spec.items.map((item) => item.id)).size,
    p.spec.items.length,
  );
  const item = p.maker.createMakerItem([
    { id: "item_1" },
    { id: "item_2" },
    { id: "item_4" },
  ]);
  assert.equal(item.id, "item_3");
  item.names.en_us = "Edited";
  item.recipe.ingredients.push("minecraft:diamond");
  assert.equal(p.maker.initialMakerSpec.items[0].names.en_us, "Crystal");
  assert.deepEqual(p.maker.initialMakerSpec.items[0].recipe.ingredients, [
    "minecraft:amethyst_shard",
  ]);
});

test("recipe draft follows retained items while replacement specs use their own ingredients", () => {
  const p = panel();
  const t = p.i18n.t;
  const ingredients = t("experimental.ingredients");
  field(p.render(), ingredients).props.onChange({
    target: { value: "minecraft:diamond, " },
  });
  assert.equal(
    field(p.render(), ingredients).props.value,
    "minecraft:diamond, ",
  );
  assert.deepEqual(p.spec.items[0].recipe.ingredients, ["minecraft:diamond"]);
  field(p.render(), t("experimental.recipeCount")).props.onChange({
    target: { value: "2" },
  });
  assert.equal(
    field(p.render(), ingredients).props.value,
    "minecraft:diamond, ",
  );
  button(p.render(), t("experimental.addItem"))[0].props.onClick();
  p.spec = { ...p.spec, items: [...p.spec.items].reverse() };
  const labels = elements(
    p.render(),
    (node) =>
      node.type === "label" &&
      node.props.children[0].props.children === ingredients,
  );
  assert.equal(labels[1].props.children[1].props.value, "minecraft:diamond, ");
  p.spec = structuredClone(p.maker.initialMakerSpec);
  p.spec.items[0].recipe.ingredients = ["minecraft:emerald"];
  assert.equal(field(p.render(), ingredients).props.value, "minecraft:emerald");
});

test("null recipe remains editable; bilingual fields and component footer stay in place", () => {
  const p = panel();
  p.spec.items[0].recipe = null;
  for (const language of ["zh-CN", "en-US"]) {
    p.i18n.configureLocale({ language, region: language });
    const tree = p.render();
    assert.equal(tree.props.className, "ce-card experimental-form");
    assert.equal(
      field(tree, p.i18n.t("experimental.ingredients")).props.value,
      "",
    );
    assert.equal(
      field(tree, p.i18n.t("experimental.itemId")).props.maxLength,
      48,
    );
    const footer = elements(
      tree,
      (node) => typeof node.type === "function" && node.props.version,
    )[0];
    assert.equal(footer.props.version, "0.7");
  }
  field(p.render(), p.i18n.t("experimental.ingredients")).props.onChange({
    target: { value: "minecraft:paper" },
  });
  assert.deepEqual(p.spec.items[0].recipe, {
    ingredients: ["minecraft:paper"],
    count: 1,
  });
});

test("disabled and maximum item count retain existing control limits", () => {
  const p = panel();
  assert.ok(
    elements(
      p.render(true),
      (node) => node.type === "input" && !node.props.readOnly,
    ).every((node) => node.props.disabled),
  );
  assert.ok(
    elements(p.render(true), (node) => node.type === "button").every(
      (node) => node.props.disabled,
    ),
  );
  p.spec.items = Array.from({ length: 16 }, (_, index) => ({
    ...structuredClone(p.maker.initialMakerSpec.items[0]),
    id: `item_${index}`,
  }));
  assert.equal(
    button(p.render(), p.i18n.t("experimental.addItem"))[0].props.disabled,
    true,
  );
});
