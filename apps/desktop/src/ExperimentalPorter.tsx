/** Porter source, rule and risk surfaces. The workspace owns project selection
 * and dialog lifecycle; the shared native host owns jobs, grants and approval. */
import { useState } from "react";
import { CeSelect } from "./CeSelect";
import { t } from "./i18n";
import {
  porterPathCanBeGranted,
  type ImportedSource,
  type PorterSource,
  type PorterReport,
  type PorterDomainResult,
  type PorterRecipeResult,
} from "./experimentalPorterTypes";

export function ExperimentalPorter({
  source,
  directory,
  targets,
  targetId,
  rights,
  beta,
  allowed,
  identifierDeclared,
  disabled,
  onImport,
  onTarget,
  onRights,
  onBeta,
  onAllowed,
  onIdentifierDeclared,
}: {
  source: ImportedSource | null;
  directory: string;
  targets: { id: string; minecraft: string; loader: string; channel: string }[];
  targetId: string;
  rights: string;
  beta: boolean;
  allowed: string[];
  identifierDeclared: boolean;
  disabled: boolean;
  onImport: () => void;
  onTarget: (value: string) => void;
  onRights: (value: string) => void;
  onBeta: (value: boolean) => void;
  onAllowed: (value: string[]) => void;
  onIdentifierDeclared: (value: boolean) => void;
}) {
  return (
    <section className="ce-card">
      <h2 className="ce-card-title">{t("experimental.porter")}</h2>
      <p>{t("experimental.porterHelp")}</p>
      <label className="ce-row">
        <span>{t("experimental.source")}</span>
        <input
          className="ce-field"
          readOnly
          value={directory}
          placeholder={t("experimental.noSource")}
        />
      </label>
      <div className="ce-actions">
        <button className="ce-button" disabled={disabled} onClick={onImport}>
          {t("experimental.sourceChoose")}
        </button>
      </div>
      {source && (
        <>
          <p className="experimental-origin">
            {t("experimental.importScope", {
              count: Object.keys(source.files).length,
              skipped: source.skipped.length,
            })}
          </p>
          {!!source.skipped.length && (
            <details>
              <summary>{t("experimental.porterSkipped")}</summary>
              <div className="experimental-paths">
                {source.skipped.map((path) => (
                  <span className="experimental-origin" key={path}>
                    {path}
                  </span>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      <label className="ce-row">
        <span>{t("experimental.target")}</span>
        <CeSelect
          className="ce-field"
          value={targetId}
          disabled={disabled}
          onChange={(e) => onTarget(e.target.value)}
        >
          {targets.map((v) => (
            <option key={v.id} value={v.id}>
              {v.loader} · {v.minecraft} ({v.channel})
            </option>
          ))}
        </CeSelect>
      </label>
      <p className="experimental-origin">
        {t("experimental.porterOfflineCatalog")}
      </p>
      <label className="ce-row">
        <span>{t("experimental.rights")}</span>
        <CeSelect
          className="ce-field"
          value={rights}
          disabled={disabled}
          onChange={(e) => onRights(e.target.value)}
        >
          <option value="unknown">{t("experimental.rightsUnknown")}</option>
          <option value="owner">{t("experimental.rightsOwner")}</option>
          <option value="permission">
            {t("experimental.rightsPermission")}
          </option>
          <option value="license-reviewed">
            {t("experimental.rightsLicense")}
          </option>
        </CeSelect>
      </label>
      <label className="ce-check experimental-safe">
        <input
          type="checkbox"
          checked={beta}
          disabled={disabled}
          onChange={(e) => onBeta(e.target.checked)}
        />
        <span>{t("experimental.beta")}</span>
      </label>
      {targetId === "fabric-1.21-yarn-source" && (
        <label className="ce-check experimental-safe">
          <input
            type="checkbox"
            checked={identifierDeclared}
            disabled={disabled}
            onChange={(e) => onIdentifierDeclared(e.target.checked)}
          />
          <span>{t("experimental.porterIdentifierDeclaration")}</span>
        </label>
      )}
      <h3 className="experimental-subtitle">
        {t("experimental.porterSupported")}
      </h3>
      <p>{t("experimental.porterMetadataScope")}</p>
      <p>{t("experimental.porterIdentifierScope")}</p>
      <p className="experimental-origin">
        {t("experimental.porterCopyBoundary")}
      </p>
      {source && (
        <details className="experimental-safe">
          <summary>{t("experimental.allowedPaths")}</summary>
          <p className="experimental-origin">
            {t("experimental.porterGrantHelp")}
          </p>
          <div className="experimental-paths">
            {Object.keys(source.files).map((path) => (
              <label className="ce-check" key={path}>
                <input
                  type="checkbox"
                  checked={allowed.includes(path)}
                  disabled={disabled || !porterPathCanBeGranted(path)}
                  onChange={(e) =>
                    onAllowed(
                      e.target.checked
                        ? [...allowed, path]
                        : allowed.filter((v) => v !== path),
                    )
                  }
                />
                <span>{path}</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function ExperimentalPorterReport({ report }: { report: PorterReport }) {
  return (
    <section className="ce-card">
      <h2 className="ce-card-title">{t("experimental.report")}</h2>
      <p className="experimental-origin">
        {report.catalog_checked_at} · {report.status}
      </p>
      <p>{t("experimental.porterValidationBoundary")}</p>
      <h3 className="experimental-subtitle">
        {t("experimental.porterBlockers")}
      </h3>
      {report.blockers.length ? (
        report.blockers.map((b, i) => (
          <div key={i}>
            <strong>{b.title}</strong>
            <p>{b.detail}</p>
          </div>
        ))
      ) : (
        <p>{t("experimental.porterNoBlockers")}</p>
      )}
      {!!report.warnings?.length && (
        <>
          <h3 className="experimental-subtitle">
            {t("experimental.porterWarnings")}
          </h3>
          {report.warnings.map((warning, i) => (
            <div key={i}>
              <strong>{warning.title}</strong>
              <p>{warning.detail}</p>
              {!!warning.evidence?.length && (
                <details>
                  <summary>{t("experimental.porterEvidence")}</summary>
                  {warning.evidence.map((e, j) => (
                    <p
                      className="experimental-origin experimental-body"
                      key={j}
                    >
                      {e.path}:{e.line} {e.excerpt}
                    </p>
                  ))}
                </details>
              )}
            </div>
          ))}
        </>
      )}
      {!!report.dependencies?.length && (
        <details className="experimental-safe">
          <summary>{t("experimental.porterDependencies")}</summary>
          {report.dependencies.map((d, i) => (
            <p className="experimental-origin" key={i}>
              {d.id} ·{" "}
              {typeof d.constraint === "string"
                ? d.constraint
                : JSON.stringify(d.constraint)}{" "}
              · {t("experimental.porterUnverified")}
            </p>
          ))}
        </details>
      )}
      {report.steps.map((step, i) => (
        <div key={i}>
          <h3 className="experimental-subtitle">
            {i + 1}. {step.title}
          </h3>
          <p>{step.action}</p>
        </div>
      ))}
    </section>
  );
}

export function ExperimentalPorterDiagnostics({
  result,
}: {
  result?: PorterDomainResult;
}) {
  if (!result) return <p>{t("experimental.porterValidationBoundary")}</p>;
  const diagnosed = new Set(result.diagnostics.map((d) => d.code));
  return (
    <>
      <p>{t("experimental.porterValidationBoundary")}</p>
      {result.target_id && (
        <p className="experimental-origin">
          {t("experimental.target")}: {result.target_id}
        </p>
      )}
      {result.diagnostics.map((d, i) => (
        <div key={i}>
          <p
            className={
              d.severity === "blocked"
                ? "experimental-error"
                : "experimental-body"
            }
          >
            {d.message}
          </p>
          {d.evidence && (
            <p className="experimental-origin experimental-body">
              {d.evidence.path}:{d.evidence.line} {d.evidence.excerpt}
            </p>
          )}
        </div>
      ))}
      {result.remaining_port_blockers
        .filter((b) => !diagnosed.has(b.code))
        .map((b, i) => (
          <p className="experimental-body" key={i}>
            {b.message}
          </p>
        ))}
    </>
  );
}

export function ExperimentalPorterPatch({
  source,
  disabled,
  result,
  onRecipe,
  onPreview,
}: {
  source?: PorterSource;
  disabled: boolean;
  result: PorterRecipeResult | null;
  onRecipe: (recipe: "metadata" | "identifier") => void;
  onPreview: (path: string, text: string, purpose: string) => void;
}) {
  const [path, setPath] = useState(""),
    [text, setText] = useState(""),
    [purpose, setPurpose] = useState("");
  const paths = source?.permittedPaths || [];
  return (
    <section className="ce-card">
      <h2 className="ce-card-title">{t("experimental.review")}</h2>
      <p className="experimental-origin">
        {t("experimental.porterJobSnapshot")}
      </p>
      {!!source && (
        <p className="experimental-origin">
          {t("experimental.target")}: {source.targetId}
        </p>
      )}
      {!paths.length && <p>{t("experimental.porterNoGrants")}</p>}
      <div className="ce-actions">
        {(["metadata", "identifier"] as const).map((recipe) => (
          <button
            className="ce-button"
            key={recipe}
            disabled={disabled || !paths.length}
            onClick={() => onRecipe(recipe)}
          >
            {t(
              recipe === "metadata"
                ? "experimental.metadataRecipe"
                : "experimental.javaRecipe",
            )}
          </button>
        ))}
      </div>
      {result && (
        <div className="experimental-safe">
          {!result.review && <p>{t("experimental.noChanges")}</p>}
          <ExperimentalPorterDiagnostics result={result} />
        </div>
      )}
      <h3 className="experimental-subtitle">{t("experimental.manualPatch")}</h3>
      <label className="ce-row">
        <span>{t("experimental.file")}</span>
        <CeSelect
          className="ce-field"
          value={path}
          disabled={disabled || !paths.length}
          onChange={(e) => {
            setPath(e.target.value);
            setText(source?.files[e.target.value] || "");
          }}
        >
          <option value="">{t("common.none")}</option>
          {paths.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </CeSelect>
      </label>
      <label className="ce-row">
        <span>{t("experimental.patchPurpose")}</span>
        <input
          className="ce-field"
          value={purpose}
          maxLength={500}
          disabled={disabled || !path}
          onChange={(e) => setPurpose(e.target.value)}
        />
      </label>
      <textarea
        className="ce-field experimental-editor"
        aria-label={t("experimental.manualPatch")}
        spellCheck={false}
        value={text}
        disabled={disabled || !path}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="ce-button"
        disabled={
          disabled ||
          !paths.includes(path) ||
          !purpose.trim() ||
          text === source?.files[path]
        }
        onClick={() => onPreview(path, text, purpose)}
      >
        {t("experimental.patchPreview")}
      </button>
    </section>
  );
}
