"""Offline authored source snapshots. Never compile or run the supplied Java."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from porter.analyzer import InputError
from porter.java_identifier import RECIPE_ID
from porter.metadata_port import SOURCE_PATH, TEMPLATE_PATH, propose_identity_mapping
from porter.patches import PatchError, apply_copy, create_patch, review_digest
from porter.recipes import propose_recipe

JAVA_PATH = 'src/main/java/example/Example.java'
JOB = 'offline-porter-job'


def source():
    return {
        'gradle.properties': 'minecraft_version=1.20.6\n',
        'build.gradle': '// Read as text only.\n',
        SOURCE_PATH: json.dumps({'schemaVersion': 1, 'id': 'example', 'version': '1.0', 'license': 'MIT', 'depends': {'minecraft': '1.20.6'}, 'entrypoints': {'main': ['example.Example']}}),
        TEMPLATE_PATH: 'modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="template"\nversion="0"\ndisplayName="Template"\ndescription="Template"\n',
        JAVA_PATH: 'package example;\nimport net.minecraft.util.Identifier;\nclass Example { Object id = new Identifier("example:item"); }\n',
    }


def propose(files=None, recipe='metadata', **overrides):
    args = dict(job_id=JOB, permitted_paths=[TEMPLATE_PATH, JAVA_PATH], recipe=recipe,
                target_id='neoforge-26.2' if recipe == 'metadata' else 'fabric-1.21-yarn-source',
                rights='owner', identifier_profile=RECIPE_ID)
    args.update(overrides)
    return propose_recipe(source() if files is None else files, **args)


class RecipeTests(unittest.TestCase):
    def test_metadata_keeps_unsupported_work_inside_exact_review(self):
        files = source()
        original = copy.deepcopy(files)
        result = propose(files)
        contract = result['proposal']
        self.assertEqual([c['path'] for c in contract['changes']], [TEMPLATE_PATH])
        self.assertEqual(set(contract['permitted_paths']), {TEMPLATE_PATH, JAVA_PATH})
        self.assertIn('unmapped-entrypoints', {d['code'] for d in contract['domain_recipe']['diagnostics']})
        self.assertEqual(contract['domain_recipe']['validation']['compile'], 'not-run')
        copied = apply_copy(files, contract, job_id=JOB, approved_digest=contract['review_digest'], permitted_paths=contract['permitted_paths'])
        self.assertEqual(files, original)
        self.assertEqual(copied['files'][JAVA_PATH], files[JAVA_PATH])
        self.assertIn('modId = "example"', copied['files'][TEMPLATE_PATH])
        changed = copy.deepcopy(contract)
        changed['domain_recipe']['diagnostics'] = []
        with self.assertRaises(PatchError):
            apply_copy(files, changed, job_id=JOB, approved_digest=contract['review_digest'], permitted_paths=contract['permitted_paths'])

    def test_version_rights_beta_and_scope_gates_return_no_proposal(self):
        cases = [
            ('metadata', dict(target_id='fabric-26.3'), 'unsupported-target-loader'),
            ('metadata', dict(rights='unknown'), 'rights-required'),
            ('metadata', dict(target_id='neoforge-26.3', acknowledge_beta=False), 'beta-unaccepted'),
            ('metadata', dict(permitted_paths=[JAVA_PATH]), 'destination-not-permitted'),
            ('identifier', dict(target_id='neoforge-26.2'), 'unsupported-version-mapping'),
            ('identifier', dict(identifier_profile=None), 'source-profile-required'),
            ('identifier', dict(permitted_paths=[TEMPLATE_PATH]), 'java-path-required'),
        ]
        for recipe, options, code in cases:
            with self.subTest(code=code):
                result = propose(recipe=recipe, **options)
                self.assertIsNone(result['proposal'])
                self.assertIn(code, {d['code'] for d in result['diagnostics']})
                self.assertIn(code, {d['code'] for d in result['remaining_port_blockers']})

    def test_identifier_requires_literal_consistent_source_pin(self):
        for pin in (None, '1.21', '${game_version}'):
            files = source()
            if pin is None:
                del files['gradle.properties']
            else:
                files['gradle.properties'] = 'minecraft_version='+pin+'\n'
            result = propose(files, recipe='identifier')
            self.assertIsNone(result['proposal'])
            self.assertIn('source-version-unverified', {d['code'] for d in result['diagnostics']})
        files = source()
        manifest = json.loads(files[SOURCE_PATH])
        manifest['depends']['minecraft'] = '1.21'
        files[SOURCE_PATH] = json.dumps(manifest)
        self.assertIsNone(propose(files, recipe='identifier')['proposal'])
        files = source()
        files['gradle.properties'] = 'minecraft_version=1.21\nminecraft_version=1.20.6\n'
        self.assertIsNone(propose(files, recipe='identifier')['proposal'])
        files = source()
        files['a-subproject/gradle.properties'] = 'minecraftVersion=1.21\n'
        self.assertIsNone(propose(files, recipe='identifier')['proposal'])

    def test_identifier_preserves_comments_strings_and_dynamic_todos(self):
        files = source()
        files[JAVA_PATH] = ('package example;\nimport net.minecraft.util.Identifier;\nclass Example {\n'
                            '// new Identifier("comment")\n'
                            'String text = "new Identifier";\n'
                            'Object a = new Identifier("example:item");\n'
                            'Object b = new Identifier(dynamicValue);\n}\n')
        result = propose(files, recipe='identifier')
        change = result['proposal']['changes'][0]['new_text']
        self.assertIn('Identifier.of("example:item")', change)
        self.assertIn('// new Identifier("comment")', change)
        self.assertIn('"new Identifier"', change)
        self.assertIn('new Identifier(dynamicValue)', change)
        self.assertIn('argument-review', {d['code'] for d in result['diagnostics']})
        self.assertEqual(result['full_port_status'], 'blocked-unvalidated')

    def test_ambiguous_identifier_file_remains_unchanged(self):
        files = source()
        files[JAVA_PATH] = files[JAVA_PATH].replace('class Example', 'class Example extends Parent')
        result = propose(files, recipe='identifier')
        self.assertIsNone(result['proposal'])
        self.assertIn('inheritance-or-record', {d['code'] for d in result['diagnostics']})

    def test_blocked_metadata_keeps_blockers_on_early_exit(self):
        files = source()
        del files[TEMPLATE_PATH]
        result = propose_identity_mapping(files, job_id=JOB, permitted_paths=[TEMPLATE_PATH])
        self.assertIsNone(result['proposal'])
        self.assertIn('existing-inputs-required', {b['code'] for b in result['remaining_port_blockers']})

    def test_exact_job_source_grants_and_preview_are_required_to_apply(self):
        files = source()
        contract = propose(files)['proposal']
        options = dict(job_id=JOB, approved_digest=contract['review_digest'], permitted_paths=contract['permitted_paths'])
        for overrides in (dict(job_id='another-offline-job'), dict(permitted_paths=[TEMPLATE_PATH])):
            with self.assertRaises(PatchError):
                apply_copy(files, contract, **{**options, **overrides})
        stale = {**files, JAVA_PATH: files[JAVA_PATH]+'// changed\n'}
        with self.assertRaises(PatchError):
            apply_copy(stale, contract, **options)
        forged = copy.deepcopy(contract)
        forged['changes'][0]['unified_diff'] = 'misleading preview'
        forged['review_digest'] = review_digest(forged)
        with self.assertRaises(PatchError):
            apply_copy(files, forged, **{**options, 'approved_digest': forged['review_digest']})

    def test_missing_newline_is_visible_and_legacy_review_still_applies(self):
        files = {JAVA_PATH: 'old'}
        contract = create_patch(files, {JAVA_PATH: 'new'}, job_id=JOB, permitted_paths=[JAVA_PATH], purpose='EOF regression')
        self.assertEqual(contract['changes'][0]['unified_diff'].count('\\ No newline at end of file'), 2)
        self.assertIn('-old\n', contract['changes'][0]['unified_diff'])
        legacy = copy.deepcopy(contract)
        legacy['changes'][0]['unified_diff'] = '--- a/'+JAVA_PATH+'\n+++ b/'+JAVA_PATH+'\n@@ -1 +1 @@\n-old+new'
        legacy['review_digest'] = review_digest(legacy)
        result = apply_copy(files, legacy, job_id=JOB, approved_digest=legacy['review_digest'], permitted_paths=[JAVA_PATH])
        self.assertEqual(result['files'][JAVA_PATH], 'new')

    def test_unpermitted_build_surface_cannot_become_a_recipe_grant(self):
        with self.assertRaises(InputError):
            propose(permitted_paths=['build.gradle'])


if __name__ == '__main__':
    unittest.main()
