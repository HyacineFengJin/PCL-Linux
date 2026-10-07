import { t } from "./i18n";

/** Component metadata stays in the card footer; beta status belongs to navigation. */
export function ExperimentalVersion({ version }: { version: string }) {
  return (
    <div className="experimental-component-version">
      {t("experimental.componentVersion", { version })}
    </div>
  );
}
