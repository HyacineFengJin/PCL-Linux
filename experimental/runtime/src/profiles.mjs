const common = ["workspace.read", "workspace.write", "build.validate"];
export const PROFILES = Object.freeze({
  maker: Object.freeze({
    id: "maker",
    systemPrompt:
      "Create a new Minecraft mod in this job workspace. Use deterministic templates and validators. Report unsupported requests. A generated project is not a verified build. Never claim a playable mod without independent build and runtime validation.",
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
