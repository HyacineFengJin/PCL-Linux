import { ExperimentalVersion } from "./ExperimentalVersion";
import { t } from "./i18n";
import type { MakerSpec } from "./experimentalTypes";
import { useRef } from "react";
export const initialMakerSpec: MakerSpec = {
  schema_version: 1,
  target: "fabric-1.21.1",
  mod_id: "my_mod",
  name: "My Mod",
  description: "A small collection of custom items.",
  items: [
    {
      id: "crystal",
      names: { en_us: "Crystal", zh_cn: "结晶" },
      color: "#71b8ff",
      max_count: 64,
      recipe: { ingredients: ["minecraft:amethyst_shard"], count: 1 },
    },
  ],
};
/** Choose an unused ID even after removals or manual renaming. Each new item
 * owns its nested fields; it must never share mutable draft data with defaults. */
export function createMakerItem(items: MakerSpec["items"]) {
  const ids = new Set(items.map((item) => item.id));
  let index = 1;
  while (ids.has(`item_${index}`)) index++;
  const template = initialMakerSpec.items[0];
  return {
    ...template,
    id: `item_${index}`,
    names: { ...template.names },
    recipe: {
      ingredients: [...template.recipe!.ingredients],
      count: template.recipe!.count,
    },
  };
}

/** The parent owns the submitted spec. Raw recipe text follows its ingredient
 * array identity, so trailing commas survive typing and item reordering while
 * a replacement spec displays its own ingredients. Weak keys release old
 * drafts without an index-based cache leaking into a restored/replaced item. */
export function ExperimentalMaker({
  spec,
  onChange,
  disabled,
}: {
  spec: MakerSpec;
  onChange: (v: MakerSpec) => void;
  disabled: boolean;
}) {
  const recipes = useRef(new WeakMap<string[], string>());
  function updateItem(
    index: number,
    values: Partial<MakerSpec["items"][number]>,
  ) {
    onChange({
      ...spec,
      items: spec.items.map((item, i) =>
        i === index ? { ...item, ...values } : item,
      ),
    });
  }
  return (
    <section className="ce-card experimental-form">
      <h2 className="ce-card-title">{t("experimental.maker")}</h2>
      <p>{t("experimental.makerHelp")}</p>
      <label className="ce-row">
        <span>{t("experimental.target")}</span>
        <input className="ce-field" value="Fabric 1.21.1" readOnly />
      </label>
      <label className="ce-row">
        <span>{t("experimental.id")}</span>
        <input
          className="ce-field"
          value={spec.mod_id}
          minLength={2}
          maxLength={48}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, mod_id: e.target.value })}
        />
      </label>
      <label className="ce-row">
        <span>{t("experimental.name")}</span>
        <input
          className="ce-field"
          value={spec.name}
          maxLength={120}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, name: e.target.value })}
        />
      </label>
      <label className="ce-row">
        <span>{t("experimental.description")}</span>
        <input
          className="ce-field"
          value={spec.description}
          maxLength={400}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, description: e.target.value })}
        />
      </label>
      <h3 className="experimental-subtitle">{t("experimental.items")}</h3>
      {spec.items.map((item, index) => {
        const recipe = item.recipe ?? { ingredients: [], count: 1 };
        return (
          <div className="experimental-item" key={index}>
            <label className="ce-row">
              <span>{t("experimental.itemId")}</span>
              <input
                className="ce-field"
                value={item.id}
                maxLength={48}
                disabled={disabled}
                onChange={(e) => updateItem(index, { id: e.target.value })}
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.enName")}</span>
              <input
                className="ce-field"
                value={item.names.en_us}
                maxLength={120}
                disabled={disabled}
                onChange={(e) =>
                  updateItem(index, {
                    names: { ...item.names, en_us: e.target.value },
                  })
                }
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.zhName")}</span>
              <input
                className="ce-field"
                value={item.names.zh_cn}
                maxLength={120}
                disabled={disabled}
                onChange={(e) =>
                  updateItem(index, {
                    names: { ...item.names, zh_cn: e.target.value },
                  })
                }
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.color")}</span>
              <input
                className="ce-field"
                value={item.color}
                maxLength={7}
                disabled={disabled}
                onChange={(e) => updateItem(index, { color: e.target.value })}
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.stack")}</span>
              <input
                className="ce-field"
                type="number"
                min={1}
                max={64}
                value={item.max_count}
                disabled={disabled}
                onChange={(e) =>
                  updateItem(index, { max_count: Number(e.target.value) })
                }
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.ingredients")}</span>
              <input
                className="ce-field"
                value={
                  recipes.current.get(recipe.ingredients) ??
                  recipe.ingredients.join(", ")
                }
                disabled={disabled}
                onChange={(e) => {
                  const text = e.target.value;
                  const ingredients = text
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean);
                  recipes.current.set(ingredients, text);
                  updateItem(index, {
                    recipe: {
                      ...recipe,
                      ingredients,
                    },
                  });
                }}
              />
            </label>
            <label className="ce-row">
              <span>{t("experimental.recipeCount")}</span>
              <input
                className="ce-field"
                type="number"
                min={1}
                max={item.max_count}
                value={recipe.count}
                disabled={disabled}
                onChange={(e) =>
                  updateItem(index, {
                    recipe: { ...recipe, count: Number(e.target.value) },
                  })
                }
              />
            </label>
            <button
              className="ce-button"
              disabled={disabled || spec.items.length === 1}
              onClick={() => {
                onChange({
                  ...spec,
                  items: spec.items.filter((_, i) => i !== index),
                });
              }}
            >
              {t("experimental.removeItem")}
            </button>
          </div>
        );
      })}
      <button
        className="ce-button"
        disabled={disabled || spec.items.length >= 16}
        onClick={() => {
          onChange({
            ...spec,
            items: [...spec.items, createMakerItem(spec.items)],
          });
        }}
      >
        {t("experimental.addItem")}
      </button>
      <ExperimentalVersion version="0.5" />
    </section>
  );
}
