"""Fixed trusted domain bridge. Reads JSON on stdin; never executes generated code."""
import base64
import io
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2] / 'vendor'
OPERATIONS = {'maker.validate', 'maker.plan', 'maker.generate', 'porter.inspect', 'porter.plan', 'porter.validate',
              'maker.preview_revision', 'maker.prepare_revision', 'maker.preview_source_edit', 'maker.prepare_source_edit', 'porter.propose_metadata', 'porter.propose_identifier', 'porter.import_snapshot', 'porter.create_patch', 'porter.apply_copy', 'host.archive'}


def module_at(name, file):
    if not file.is_file():
        raise ValueError(f'Required sibling domain module is unavailable: {file.name}')
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in OPERATIONS:
        raise ValueError('Unknown fixed domain operation')
    operation = sys.argv[1]
    text = sys.stdin.read(128001)
    if len(text.encode()) > 128000:
        raise ValueError('Domain input exceeds 128 KB')
    args = json.loads(text)
    if operation == 'host.archive':
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in args['files']:
                name = file['path']
                if not isinstance(name, str) or name.startswith('/') or '\\' in name or any(p in {'', '.', '..'} for p in name.split('/')) or any(ord(c) < 32 for c in name):
                    raise ValueError('Invalid archive path')
                info = zipfile.ZipInfo('source-project/' + name, (2026, 10, 6, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, base64.b64decode(file['base64'], validate=True))
        return {'base64': base64.b64encode(output.getvalue()).decode('ascii')}
    if operation.startswith('maker.'):
        maker = module_at('pcl_maker', ROOT / 'maker' / 'mod_creator.py')
        if operation in {'maker.preview_source_edit', 'maker.prepare_source_edit'}:
            sys.modules['mod_creator'] = maker
            editor = module_at('pcl_source_editor', ROOT / 'maker' / 'source_editor.py')
            request = args['request']
            if request.get('operation') == 'regenerate':
                preview, files = editor.prepare_regenerate(args['sourceRoot'], request['spec'])
            elif request.get('operation') == 'restore':
                preview, files = editor.prepare_restore(args['sourceRoot'], request['checkpointRoot'])
            else:
                preview, files = editor.prepare_patch(args['sourceRoot'], request)
            if operation == 'maker.preview_source_edit':
                return preview
            if preview['revision'] != args['expectedRevision']:
                raise ValueError('Stale source-edit review')
            return {'preview': preview, 'files': [{'path': name, 'base64': base64.b64encode(content).decode('ascii')} for name, content in sorted(files.items())]}
        if operation in {'maker.preview_revision', 'maker.prepare_revision'}:
            preview, files = maker.prepare_revision(args['sourceRoot'], args['newSpec'])
            if operation == 'maker.preview_revision':
                return preview
            if preview['revision'] != args['expectedRevision']:
                raise ValueError('Stale Maker review: source or proposed specification changed')
            return {'preview': preview, 'files': [{'path': name, 'base64': base64.b64encode(content).decode('ascii')} for name, content in sorted(files.items())]}
        if operation == 'maker.validate':
            maker.validate(args['spec'])
            return {'status': 'valid_spec_only', 'build': 'not_run', 'model_calls': 0}
        if operation == 'maker.plan':
            return maker.plan(args['spec'])
        files = maker.render(args['spec'])
        return {'files': [{'path': name, 'base64': base64.b64encode(content).decode('ascii')} for name, content in sorted(files.items())], 'build': 'not_run'}
    module_at('pcl_porter', ROOT / 'porter' / '__init__.py')
    porter = module_at('pcl_porter.analyzer', ROOT / 'porter' / 'analyzer.py')
    if operation in {'porter.propose_metadata', 'porter.propose_identifier', 'porter.import_snapshot', 'porter.create_patch', 'porter.apply_copy'}:
        patches = module_at('pcl_porter.patches', ROOT / 'porter' / 'patches.py')
        if operation == 'porter.import_snapshot':
            patches.permitted_set(args['permittedPaths'])
            if not set(args['permittedPaths']) <= set(args['files']):
                raise ValueError('Only existing imported paths may be permitted')
            return patches.imported_snapshot(args['files'])
        if operation == 'porter.create_patch':
            return patches.create_patch(args['files'], args['replacements'], job_id=args['jobId'],
                                        permitted_paths=args['permittedPaths'], purpose=args['purpose'])
        return patches.apply_copy(args['files'], args['contract'], job_id=args['jobId'],
                                  approved_digest=args['approvedDigest'], permitted_paths=args['permittedPaths'])
    report = porter.analyze(args['files'], target_id=args.get('targetId', 'neoforge-26.3'),
                            rights=args.get('rights', 'unknown'), acknowledge_beta=args.get('acknowledgeBeta', False))
    if not all(value is False for value in report['execution'].values()):
        raise ValueError('Unexpected domain execution claim')
    if not all(stage['result'] == 'not-run' for stage in report['validation_matrix']):
        raise ValueError('Unexpected build/runtime validation claim')
    return report


if __name__ == '__main__':
    try:
        output = {'ok': True, 'result': main()}
    except Exception as error:
        output = {'ok': False, 'error': {'type': type(error).__name__, 'message': str(error)[:500]}}
    print(json.dumps(output, ensure_ascii=True))
    sys.exit(0 if output['ok'] else 2)
