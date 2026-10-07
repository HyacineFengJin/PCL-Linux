const common = ["workspace.read", "workspace.write", "build.validate"];
export const PROFILES = Object.freeze({
  maker: Object.freeze({
    id: "maker",
    systemPrompt:
      "Create or extend a Minecraft mod in this job workspace. When input has sourceOperationId, read sourceDirectory and sourceInventory, respect project notes and continue that existing source through maker.preview_source_edit or maker.preview_revision. You may propose new Java classes and supported resource files with expected_sha256 null; use recorded hashes for existing files. Preserve handwritten code and explain conflicts. Changes need human review; do not replace an existing project with a fresh template. Use deterministic templates for project setup, and source editing for complex behavior. Report unsupported requests. A generated project is not a verified build. Never claim a playable mod without independent build and runtime validation.",
    tools: Object.freeze([
      ...common,
      "maker.plan",
      "maker.generate",
      "maker.validate",
      "maker.preview_revision",
      "maker.preview_source_edit",
    ]),
  }),
  porter: Object.freeze({
    id: "porter",
    systemPrompt:
      "Inspect and plan porting of the supplied Minecraft mod. Distinguish metadata compatibility, source migration, and semantic behavior. Preserve original inputs. Report blockers rather than inventing a successful port. All output is a draft until independent validators pass.",
    tools: Object.freeze([
      ...common,
      "porter.inspect",
      "porter.plan",
      "porter.validate",
      "porter.preview_patch",
      "porter.propose_metadata",
      "porter.propose_identifier",
    ]),
  }),
});
