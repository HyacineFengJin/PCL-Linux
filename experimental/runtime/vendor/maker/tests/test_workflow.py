"""Bounded offline workflow regressions. Generated code and builds never run."""
import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MAKER = Path(__file__).resolve().parents[1]
REPO = MAKER.parents[3]
sys.path.insert(0, str(MAKER))
import mod_creator as maker
import source_editor as editor


def sample_spec():
    return {"schema_version": 1, "target": "fabric-1.21.1", "mod_id": "sample_mod",
        "name": "Sample Mod", "description": "A small collection of custom items.",
        "items": [{"id": "crystal", "names": {"en_us": "Crystal", "zh_cn": "结晶"},
            "color": "#71b8ff", "max_count": 64,
            "recipe": {"ingredients": ["minecraft:amethyst_shard"], "count": 1}}]}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        scratch = REPO / "work" / "maker-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.spec = sample_spec()
        self.source, self.generated = maker.generate(self.spec, self.root / "source")
        self.java = next(name for name in maker.render(self.spec) if name.endswith(".java"))
        self.original = maker.snapshot_project(self.source)

    def assert_unbuilt(self, result):
        for name in ("java_compilation", "gradle_build", "minecraft_smoke_test"):
            self.assertEqual(result[name], "not_run")

    def patch(self, source, request, name="edited"):
        preview, _ = editor.prepare_patch(source, request)
        self.assert_unbuilt(preview)
        destination, result = editor.apply(source, "patch", request, preview["revision"], self.root / name)
        self.assert_unbuilt(result)
        return destination

    def lock(self):
        return self.patch(self.source, {"schema_version": 1, "edits": [], "lock_paths": [self.java]})

    def handwritten(self):
        text = self.original[self.java].decode() + "// Reviewed handwritten code.\n"
        edited = self.patch(self.source, {"schema_version": 1, "lock_paths": [],
            "edits": [{"path": self.java, "expected_sha256": editor.sha(self.original[self.java]), "text": text}]})
        return edited, text.encode()

    def test_generation_is_deterministic_source_only(self):
        self.assertEqual(self.generated["status"], "verified_source")
        self.assert_unbuilt(self.generated)
        self.assertEqual(self.original, maker.render(self.spec))
        png = next(data for name, data in self.original.items() if name.endswith(".png"))
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertIn("结晶", self.original["src/main/resources/assets/sample_mod/lang/zh_cn.json"].decode())
        self.assertEqual(maker.snapshot_project(self.source), self.original)

    def test_lock_only_then_normal_revision_refreshes_ownership(self):
        locked = self.lock()
        before = maker.snapshot_project(locked)
        changed = copy.deepcopy(self.spec)
        changed["items"][0]["color"] = "#ff8844"
        preview, expected = maker.prepare_revision(locked, changed)
        regenerated, _ = editor.prepare_regenerate(locked, changed)
        self.assertEqual(preview["revision"], regenerated["revision"])
        revised, result = maker.revise(locked, changed, preview["revision"], self.root / "revised")
        self.assertEqual(maker.snapshot_project(revised), expected)
        self.assertIn(self.java, editor.inspect(revised)["ownership"]["locked"])
        self.assertTrue(result["generated_files_verified"])
        self.assert_unbuilt(result)
        self.assertEqual(maker.snapshot_project(locked), before)

    def test_handwriting_survives_both_revision_entry_points(self):
        edited, text = self.handwritten()
        changed = copy.deepcopy(self.spec)
        changed["items"][0]["max_count"] = 16
        preview, files = maker.prepare_revision(edited, changed)
        self.assertEqual(files[self.java], text)
        self.assertEqual(preview["suppressed_template_changes"][0]["path"], self.java)
        revised, result = maker.revise(edited, changed, preview["revision"], self.root / "revised")
        self.assertFalse(result["generated_files_verified"])
        self.assertEqual((revised / self.java).read_bytes(), text)
        self.assertEqual(editor.inspect(revised)["source_integrity"], "checked")
        self.assertEqual(maker.snapshot_project(self.source), self.original)

    def test_revision_of_original_records_ownership_and_preserves_unrelated(self):
        note = self.source / "notes.txt"
        note.write_text("Keep this unrelated note.\n")
        changed = copy.deepcopy(self.spec)
        changed["name"] = "Changed Name"
        preview, _ = maker.prepare_revision(self.source, changed)
        self.assertEqual(preview["preserved_unrelated"], ["notes.txt"])
        destination, result = maker.revise(self.source, changed, preview["revision"], self.root / "revised")
        self.assertEqual((destination / "notes.txt").read_bytes(), note.read_bytes())
        self.assertEqual(editor.inspect(destination)["ownership"]["user"], ["notes.txt"])
        self.assert_unbuilt(result)

    def test_updated_template_cannot_claim_unrelated_file(self):
        collision = "src/main/resources/assets/sample_mod/models/item/other.json"
        (self.source / collision).write_bytes(b"{}\n")
        changed = copy.deepcopy(self.spec)
        extra = copy.deepcopy(changed["items"][0]); extra["id"] = "other"
        changed["items"].append(extra)
        before = maker.snapshot_project(self.source)
        with self.assertRaisesRegex(maker.SpecError, "unrelated user file"):
            maker.prepare_revision(self.source, changed)
        self.assertEqual(maker.snapshot_project(self.source), before)

    def test_added_java_is_locked_and_retained(self):
        name = "src/main/java/lab/generated/sample_mod/Helper.java"
        request = {"schema_version": 1, "lock_paths": [], "edits": [
            {"path": name, "expected_sha256": None, "text": "package lab.generated.sample_mod;\nclass Helper {}\n"}]}
        edited = self.patch(self.source, request)
        preview, files = editor.prepare_regenerate(edited, self.spec)
        self.assertEqual(files[name], request["edits"][0]["text"].encode())
        self.assertIn(name, preview["preserved_locked_files"])
        regenerated, _ = editor.apply(edited, "regenerate", self.spec, preview["revision"], self.root / "regenerated")
        self.assertIn(name, editor.inspect(regenerated)["ownership"]["locked"])

    def test_removed_item_warning_despite_locked_registration(self):
        edited, text = self.handwritten()
        changed = copy.deepcopy(self.spec)
        changed["items"][0]["id"] = "new_crystal"
        preview, files = editor.prepare_regenerate(edited, changed)
        self.assertEqual(preview["removed_item_ids"], ["crystal"])
        self.assertEqual(preview["added_item_ids"], ["new_crystal"])
        self.assertTrue(any("existing worlds" in warning and "crystal" in warning for warning in preview["warnings"]))
        self.assertEqual(files[self.java], text)

    def test_restore_is_exact_new_copy_and_warns_about_removed_items(self):
        changed = copy.deepcopy(self.spec)
        extra = copy.deepcopy(changed["items"][0]); extra["id"] = "other"
        changed["items"].append(extra)
        current, _ = maker.generate(changed, self.root / "current")
        before = maker.snapshot_project(current)
        preview, _ = editor.prepare_restore(current, self.source)
        self.assertEqual(preview["removed_item_ids"], ["other"])
        self.assertTrue(any("existing worlds" in warning for warning in preview["warnings"]))
        destination, result = editor.apply(current, "restore", self.source, preview["revision"], self.root / "restored")
        self.assertEqual(maker.snapshot_project(destination), self.original)
        self.assertEqual(maker.snapshot_project(current), before)
        self.assertEqual(maker.snapshot_project(self.source), self.original)
        self.assert_unbuilt(result)

    def test_restored_handwriting_stays_protected_on_later_revision(self):
        edited, text = self.handwritten()
        restore, _ = editor.prepare_restore(self.source, edited)
        restored, _ = editor.apply(self.source, "restore", edited, restore["revision"], self.root / "restored")
        changed = copy.deepcopy(self.spec); changed["items"][0]["max_count"] = 32
        preview, _ = maker.prepare_revision(restored, changed)
        revised, _ = maker.revise(restored, changed, preview["revision"], self.root / "revised")
        self.assertEqual((revised / self.java).read_bytes(), text)
        self.assertIn(self.java, editor.inspect(revised)["ownership"]["locked"])

    def test_stale_spec_revision_creates_no_destination(self):
        preview, _ = maker.prepare_revision(self.source, self.spec)
        changed = copy.deepcopy(self.spec); changed["name"] = "Changed Name"
        destination = self.root / "stale"
        with self.assertRaisesRegex(maker.SpecError, "stale revision"):
            maker.revise(self.source, changed, preview["revision"], destination)
        self.assertFalse(destination.exists())
        self.assertEqual(maker.snapshot_project(self.source), self.original)

    def test_external_handwritten_change_is_refused_and_retained(self):
        edited, text = self.handwritten()
        preview, _ = maker.prepare_revision(edited, self.spec)
        external = text + b"// External editor change.\n"
        (edited / self.java).write_bytes(external)
        destination = self.root / "stale"
        with self.assertRaisesRegex(maker.SpecError, "outside reviewed workflow"):
            maker.revise(edited, self.spec, preview["revision"], destination)
        self.assertFalse(destination.exists())
        self.assertEqual((edited / self.java).read_bytes(), external)

    def test_restore_binds_all_checkpoint_bytes(self):
        preview, _ = editor.prepare_restore(self.source, self.source)
        (self.source / "notes.txt").write_text("Late checkpoint content.\n")
        destination = self.root / "stale"
        with self.assertRaisesRegex(maker.SpecError, "stale source proposal"):
            editor.apply(self.source, "restore", self.source, preview["revision"], destination)
        self.assertFalse(destination.exists())

    def test_cross_namespace_restore_is_refused(self):
        changed = copy.deepcopy(self.spec); changed["mod_id"] = "different_mod"
        other, _ = maker.generate(changed, self.root / "other")
        with self.assertRaisesRegex(maker.SpecError, "different mod namespace"):
            editor.prepare_restore(self.source, other)

    def test_build_files_and_malformed_resources_are_refused(self):
        for name, content in (("build.gradle", "// Changed"), ("src/main/resources/assets/sample_mod/lang/en_us.json", "{bad}")):
            with self.subTest(name=name), self.assertRaises(maker.SpecError):
                editor.prepare_patch(self.source, {"schema_version": 1, "lock_paths": [], "edits": [
                    {"path": name, "expected_sha256": editor.sha(self.original[name]), "text": content}]})
        self.assertEqual(maker.snapshot_project(self.source), self.original)

    def test_standalone_cli_revision_imports_the_trusted_sibling(self):
        edited, text = self.handwritten()
        changed = copy.deepcopy(self.spec); changed["items"][0]["max_count"] = 16
        spec_file = self.root / "spec.json"; spec_file.write_bytes(maker.encode(changed))
        result = subprocess.run([sys.executable, "-B", str(MAKER / "mod_creator.py"),
            "preview-revision", str(edited), str(spec_file)], check=True, capture_output=True)
        preview = editor.object_json(result.stdout)
        destination = self.root / "cli"
        result = subprocess.run([sys.executable, "-B", str(MAKER / "mod_creator.py"),
            "revise", str(edited), str(spec_file), "--expected-revision", preview["revision"],
            "--output", str(destination)], check=True, capture_output=True)
        self.assert_unbuilt(editor.object_json(result.stdout))
        self.assertEqual((destination / self.java).read_bytes(), text)
        self.assertIn(self.java, editor.inspect(destination)["ownership"]["locked"])


if __name__ == "__main__":
    unittest.main()
