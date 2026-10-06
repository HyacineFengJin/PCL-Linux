#!/usr/bin/env python3
"""Original, offline source ownership + reviewed new-copy editing. Never builds code."""
from __future__ import annotations
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata
import mod_creator as m

META = "creator-ownership.json"
MAX_TEXT = 256 * 1024
HEX = re.compile(r"[0-9a-f]{64}\Z")
STATUSES = {"source_integrity": "checked", "java_compilation": "not_run", "gradle_build": "not_run", "minecraft_smoke_test": "not_run"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def object_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=m.no_duplicates,
            parse_constant=lambda _x: (_ for _ in ()).throw(m.SpecError("non-finite JSON value")))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise m.SpecError("invalid bounded UTF-8 JSON") from exc


def valid_path(path):
    m.require(type(path) is str and 1 <= len(path) <= 220 and not path.startswith("/") and "\\" not in path,
              "invalid relative source path")
    m.require(all(part not in {"", ".", ".."} for part in path.split("/")), "unsafe relative path")
    m.require(re.fullmatch(r"[A-Za-z0-9_.\-/]+", path) is not None, "source paths must use safe ASCII characters")


def editable(path):
    valid_path(path)
    if path == "src/main/resources/fabric.mod.json":
        return False
    return ((path.startswith("src/main/java/") and path.endswith(".java")) or
            (path.startswith("src/main/resources/") and Path(path).suffix in {".json", ".mcmeta", ".txt", ".lang"}))


def check_text(path, text):
    m.require(type(text) is str, "source replacement must be text")
    m.require(all(unicodedata.category(c) not in {"Cf", "Cs"} and (unicodedata.category(c) != "Cc" or c in "\t\r\n") for c in text),
              "source text contains unsafe control, bidi or surrogate characters")
    data = text.encode("utf-8")
    m.require(len(data) <= MAX_TEXT, "replacement exceeds 256 KiB")
    if Path(path).suffix in {".json", ".mcmeta"}:
        object_json(data)
    return data


def inventory(files):
    return {name: sha(data) for name, data in sorted(files.items())}


def audit(root):
    """Validate all bytes/ownership. This is integrity, not authenticity or compilation."""
    files = m.snapshot_project(root)
    m.require("creator-spec.json" in files, "creator-spec.json missing")
    spec = m.parse(files["creator-spec.json"])
    baseline = m.render(spec)
    if META not in files:
        m.require(all(files.get(name) == data for name, data in baseline.items()),
                  "unmanaged generated files differ; explicit import/reconciliation is required")
        records = {name: {"owner": "template" if name in baseline else "user", "sha256": sha(data),
            "baseline_sha256": sha(baseline[name]) if name in baseline else None} for name, data in files.items()}
    else:
        meta = object_json(files[META])
        m.exact(meta, ("schema_version", "template_version", "files", "verification"), "ownership")
        m.require(type(meta["schema_version"]) is int and meta["schema_version"] == 1 and meta["template_version"] == m.VERSION,
                  "unsupported ownership/template version")
        m.require(meta["verification"] == STATUSES, "ownership verification claims must remain source-only")
        records = meta["files"]
        m.require(type(records) is dict and set(records) == set(files) - {META}, "ownership inventory does not match project")
        m.require(set(baseline) <= set(records), "template-owned files missing")
        for name, record in records.items():
            valid_path(name)
            m.exact(record, ("owner", "sha256", "baseline_sha256"), "file ownership")
            owner = record["owner"]
            m.require(owner in ("template", "locked", "user"), "invalid file owner")
            m.require(type(record["sha256"]) is str and HEX.fullmatch(record["sha256"]) and sha(files[name]) == record["sha256"],
                      "owned file changed outside reviewed workflow: " + name)
            m.require(record["baseline_sha256"] == (sha(baseline[name]) if name in baseline else None),
                      "ownership baseline mismatch: " + name)
            if owner == "template":
                m.require(name in baseline and files[name] == baseline[name], "template file mismatch: " + name)
            elif owner == "locked":
                m.require(editable(name), "protected file cannot be code-locked: " + name)
            else:
                m.require(name not in baseline, "template file cannot be disguised as unrelated user content: " + name)
    return files, spec, baseline, records


def owned_snapshot(files, owners, baseline):
    files = dict(files)
    files.pop(META, None)
    for name in files:
        valid_path(name)
    # Reject path/file hierarchy collisions before any destination exists.
    for name in files:
        m.require(not any(str(parent) in files for parent in Path(name).parents if str(parent) != "."), "file/directory collision")
    records = {name: {"owner": owners[name], "sha256": sha(data), "baseline_sha256": sha(baseline[name]) if name in baseline else None}
        for name, data in sorted(files.items())}
    files[META] = m.encode({"schema_version": 1, "template_version": m.VERSION, "files": records, "verification": STATUSES})
    m.require(all(len(data) <= m.REVISION_FILE_LIMIT for data in files.values()) and sum(map(len, files.values())) <= m.REVISION_TOTAL_LIMIT,
              "owned snapshot exceeds resource limits")
    return files


def preview(root, operation, before, after, details, *, extra_binding=None):
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(name for name in set(before) & set(after) if before[name] != after[name])
    diffs = []
    for name in sorted(set(added + removed + modified)):
        a, b = before.get(name, b""), after.get(name, b"")
        entry = {"path": name, "before_sha256": sha(a) if name in before else None, "after_sha256": sha(b) if name in after else None}
        try:
            entry.update(kind="text", diff="".join(difflib.unified_diff(a.decode().splitlines(True), b.decode().splitlines(True), fromfile="before/" + name, tofile="after/" + name)))
        except UnicodeError:
            entry.update(kind="binary", before_bytes=len(a), after_bytes=len(b))
        diffs.append(entry)
    binding = {"source": str(m.safe_path(root)), "operation": operation, "before": inventory(before), "after": inventory(after), "extra": extra_binding}
    return {"status": "source_edit_preview", "operation": operation, "revision": sha(m.encode(binding)),
        "added": added, "modified": modified, "removed": removed, "diffs": diffs, "checkpoint_sha256": sha(m.encode(inventory(before))),
        "source_unchanged_by_tool": True, "mode": "new_copy_only", **STATUSES, **details}, after


def prepare_patch(root, request):
    m.exact(request, ("schema_version", "edits", "lock_paths"), "source patch")
    m.require(type(request["schema_version"]) is int and request["schema_version"] == 1, "source patch version must be 1")
    m.require(type(request["edits"]) is list and len(request["edits"]) <= 32, "at most 32 source edits")
    m.require(type(request["lock_paths"]) is list and len(request["lock_paths"]) <= 64, "at most 64 explicit locks")
    m.require(request["edits"] or request["lock_paths"], "empty source patch")
    before, spec, baseline, records = audit(root)
    after = dict(before); owners = {name: record["owner"] for name, record in records.items()}
    seen = set()
    for edit in request["edits"]:
        m.exact(edit, ("path", "expected_sha256", "text"), "source edit")
        name = edit["path"]
        m.require(editable(name), "only Java/resource source is editable; build/control files are protected")
        m.require(name not in seen, "duplicate edited path"); seen.add(name)
        expected = edit["expected_sha256"]
        m.require(expected is None or (type(expected) is str and HEX.fullmatch(expected)), "expected_sha256 must be null or 64 hex characters")
        m.require(expected == (sha(before[name]) if name in before else None), "stale per-file patch: " + name)
        after[name] = check_text(name, edit["text"])
        owners[name] = "locked"  # Handwritten code cannot later become template-overwritable implicitly.
    lock_seen = set()
    for name in request["lock_paths"]:
        m.require(editable(name) and name in after, "lock target must be an existing editable source file")
        m.require(name not in lock_seen, "duplicate lock path"); lock_seen.add(name); owners[name] = "locked"
    after = owned_snapshot(after, owners, baseline)
    return preview(root, "patch", before, after, {"locked_files": sorted(name for name, owner in owners.items() if owner == "locked"),
        "warnings": ["Handwritten Java is uncompiled executable source. Resource JSON parsing does not prove game compatibility."],
        "checks": ["ownership inventory", "expected source hashes", "path allowlist", "UTF-8/control checks", "JSON syntax where applicable"]}, extra_binding=request)


def prepare_regenerate(root, new_spec):
    m.validate(new_spec)
    before, old_spec, baseline, records = audit(root)
    m.require(old_spec["mod_id"] == new_spec["mod_id"], "mod namespace migration is unsupported")
    generated = m.render(new_spec)
    after = {}; owners = {}; skipped = []
    for name, data in generated.items():
        record = records.get(name)
        m.require(record is None or record["owner"] != "user", "template would overwrite unrelated user file: " + name)
        if record and record["owner"] == "locked":
            after[name] = before[name]; owners[name] = "locked"
            if before[name] != data:
                skipped.append({"path": name, "preserved_sha256": sha(before[name]), "proposed_template_sha256": sha(data), "reason": "code_locked"})
        else:
            after[name] = data; owners[name] = "template"
    for name, record in records.items():
        if name not in generated and record["owner"] != "template":
            after[name] = before[name]; owners[name] = record["owner"]
            if record["owner"] == "locked":
                skipped.append({"path": name, "preserved_sha256": sha(before[name]), "proposed_template_sha256": None, "reason": "locked_file_retained"})
    after = owned_snapshot(after, owners, generated)
    warnings = ["Locked files are kept byte-for-byte. Template changes affecting them require manual reconciliation; this result is not a compiled or game-validated mod."]
    return preview(root, "regenerate", before, after, {"preserved_locked_files": sorted(name for name, owner in owners.items() if owner == "locked"),
        "suppressed_template_changes": skipped, "warnings": warnings}, extra_binding=new_spec)


def prepare_restore(root, checkpoint_root):
    before, current_spec, _, _ = audit(root)
    checkpoint, prior_spec, _, _ = audit(checkpoint_root)
    m.require(current_spec["mod_id"] == prior_spec["mod_id"], "checkpoint belongs to a different mod namespace")
    return preview(root, "restore", before, checkpoint, {"warnings": ["Restores a checkpoint into a new copy only. Original and current copies are retained; no game world is rolled back."]},
        extra_binding={"checkpoint_path": str(m.safe_path(checkpoint_root)), "checkpoint_inventory": inventory(checkpoint)})


def inspect(root):
    files, _, _, records = audit(root)
    return {"status": "source_integrity_verified", "file_count": len(files),
        "ownership": {owner: sorted(name for name, item in records.items() if item["owner"] == owner) for owner in ("template", "locked", "user")},
        "checkpoint_sha256": sha(m.encode(inventory(files))), **STATUSES,
        "note": "Ownership and byte integrity only; not compiler/game validation or an authenticity signature"}


def apply(root, operation, payload, expected_revision, output=None):
    m.require(type(expected_revision) is str and HEX.fullmatch(expected_revision), "expected_revision must be the reviewed digest")
    m.require(operation in {"patch", "regenerate", "restore"}, "unknown source-edit operation")
    roots = [m.safe_path(root)] + ([m.safe_path(payload)] if operation == "restore" else [])
    if output is not None:
        target = m.safe_path(output)
        m.require(all(target != source and source not in target.parents for source in roots), "new copy must be outside source/checkpoint trees")
    prepared, files = {"patch": prepare_patch, "regenerate": prepare_regenerate, "restore": prepare_restore}[operation](root, payload)
    m.require(prepared["revision"] == expected_revision, "stale source proposal: preview again")
    destination = m.write_new_project(files, output)
    m.require(m.snapshot_project(destination) == files, "new-copy byte verification failed")
    inspected = inspect(destination)
    return destination, {**inspected, "status": "reviewed_source_copy_created", "operation": operation, "revision": expected_revision,
        "output": str(destination), "parent_checkpoint_sha256": prepared["checkpoint_sha256"], "source_unchanged_by_tool": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inspect").add_argument("project", type=Path)
    for name in ("patch", "regenerate", "restore"):
        for prefix in ("preview-", ""):
            p = commands.add_parser(prefix + name)
            p.add_argument("project", type=Path); p.add_argument("input", type=Path)
            if not prefix:
                p.add_argument("--expected-revision", required=True); p.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect(args.project)
        else:
            operation = args.command.removeprefix("preview-")
            payload = args.input if operation == "restore" else (m.load(args.input) if operation == "regenerate" else object_json(m.read_bytes(args.input, m.REVISION_FILE_LIMIT)))
            if args.command.startswith("preview-"):
                result = {"patch": prepare_patch, "regenerate": prepare_regenerate, "restore": prepare_restore}[operation](args.project, payload)[0]
            else:
                _, result = apply(args.project, operation, payload, args.expected_revision, args.output)
        print(m.encode(result).decode(), end=""); return 0
    except (m.SpecError, OSError, UnicodeError) as exc:
        print(m.encode({"status": "rejected", "error": str(exc)}).decode(), file=sys.stderr, end=""); return 2


if __name__ == "__main__":
    raise SystemExit(main())
