"""Launcher recipe policy over a frozen imported snapshot.

The host supplies the submitted target, rights and source-profile declaration.
Recipes never infer a whole-mod port from a successful text transformation.
The complete domain result is retained in the review contract, so approval also
binds the unsupported work and validation limits shown alongside the diff.
"""
from __future__ import annotations

import json
import re
from pathlib import PurePosixPath
from .analyzer import CATALOG, InputError
from .patches import imported_snapshot, permitted_set, review_digest
from .metadata_port import propose_identity_mapping, TEMPLATE_PATH
from .java_identifier import (
    propose_identifier_factory, RECIPE_ID as IDENTIFIER_PROFILE,
    SOURCE_PROFILE, TARGET_PROFILE,
)


def propose_recipe(files, *, job_id, permitted_paths, recipe, target_id,
                   rights='unknown', acknowledge_beta=False,
                   identifier_profile=None):
    snapshot = imported_snapshot(files)
    allowed = permitted_set(permitted_paths)
    if not allowed <= set(files):
        raise InputError('Only existing imported text paths may be permitted')
    if recipe not in {'metadata', 'identifier'}:
        raise InputError('Unknown migration recipe')
    target = next((t for t in CATALOG['targets'] if t['id'] == target_id), None)
    if target is None:
        raise InputError('Choose a target from the offline catalog')
    result = {
        'recipe_id': recipe, 'status': 'blocked', 'proposal': None,
        'source_fingerprint': snapshot['fingerprint'], 'target_id': target_id,
        'diagnostics': [], 'full_port_status': 'blocked-unvalidated',
        'remaining_port_blockers': [],
        'validation': {'compile': 'not-run', 'game': 'not-run',
                       'full_semantic_equivalence': 'not-established'},
    }

    def block(code, message):
        result['diagnostics'].append({'code': code, 'severity': 'blocked', 'message': message})
        result['remaining_port_blockers'].append({'code': code, 'message': message})

    if rights not in {'owner', 'permission', 'license-reviewed'}:
        block('rights-required', 'Declare source modification rights before proposing changes. The declaration is not independently verified.')
    if target['channel'] == 'beta' and acknowledge_beta is not True:
        block('beta-unaccepted', 'The submitted beta target must be explicitly accepted before proposing changes.')
    if recipe == 'metadata':
        if target['loader'] != 'neoforge':
            block('unsupported-target-loader', 'This identity-only recipe requires a NeoForge target and an existing NeoForge metadata template.')
        if TEMPLATE_PATH not in allowed:
            block('destination-not-permitted', 'Explicitly permit the existing NeoForge metadata template before proposing this recipe.')
    else:
        if target_id != 'fabric-1.21-yarn-source':
            block('unsupported-version-mapping', 'Only the Fabric/Yarn 1.20.6 to 1.21 source recipe is supported; no 26.x or cross-loader rewrite is inferred.')
        if identifier_profile != IDENTIFIER_PROFILE:
            block('source-profile-required', 'Explicitly declare the Fabric/Yarn 1.20.6 source profile when submitting the job. The model cannot make this declaration.')
        if not any(p.endswith('.java') for p in allowed):
            block('java-path-required', 'Explicitly permit at least one existing Java source file.')
        # A user declaration supplements static evidence, rather than overriding
        # a conflicting or unresolved project pin. Never evaluate Gradle code.
        # Keep every literal pin, including duplicate keys and subprojects.
        # A merged property dictionary would hide conflicting declarations.
        pins = []
        for path, text in files.items():
            if PurePosixPath(path).name != 'gradle.properties':
                continue
            for line in text.splitlines():
                match = re.match(r'^\s*(minecraft_version|minecraftVersion)\s*=\s*(.*?)\s*$', line)
                if match:
                    pins.append(match[2])
        if not pins or any(v != SOURCE_PROFILE['minecraft'] for v in pins):
            block('source-version-unverified', 'This launcher recipe requires a literal minecraft_version or minecraftVersion = 1.20.6 in imported gradle.properties; missing, dynamic or conflicting pins need manual review.')
        for path, text in files.items():
            if not path.endswith('/fabric.mod.json') and path != 'fabric.mod.json':
                continue
            try:
                data = json.loads(text)
                dependency = data.get('depends', {}).get('minecraft')
                # Exact contradictory declarations are enough to refuse; ranges
                # are not interpreted as a compatibility certificate.
                if isinstance(dependency, str) and dependency.lstrip('= ').replace('.', '').isdigit() and dependency.lstrip('= ') != SOURCE_PROFILE['minecraft']:
                    block('source-version-conflict', 'The Fabric manifest declares a different exact Minecraft version; review the project profile manually.')
            except (ValueError, TypeError, AttributeError):
                block('source-metadata-unresolved', 'Fabric metadata could not be inspected for source-version conflicts.')
    if result['diagnostics']:
        return result

    if recipe == 'metadata':
        result = propose_identity_mapping(files, job_id=job_id, permitted_paths=[TEMPLATE_PATH])
    else:
        result = propose_identifier_factory(
            files, job_id=job_id,
            permitted_paths=sorted(p for p in allowed if p.endswith('.java')),
            source_profile=SOURCE_PROFILE, target_profile=TARGET_PROFILE,
        )
    result['source_fingerprint'] = snapshot['fingerprint']
    result['target_id'] = target_id
    if result['proposal']:
        contract = result['proposal']
        # Keep the exact host grant set for apply-time scope checks. Actual
        # replacements remain the narrower subset selected by the recipe.
        contract['permitted_paths'] = sorted(allowed)
        contract['domain_recipe'] = {k: v for k, v in result.items() if k != 'proposal'}
        contract['review_digest'] = review_digest(contract)
    return result
