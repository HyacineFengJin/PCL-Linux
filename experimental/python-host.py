"""Launcher-owned read adapters. Never import modules or execute code from a project."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent / 'runtime' / 'vendor'

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

def dispatch(operation, args):
    if operation == 'porter.read_directory':
        load('pcl_porter', ROOT / 'porter' / '__init__.py')
        porter = load('pcl_porter.analyzer', ROOT / 'porter' / 'analyzer.py')
        files, skipped = porter.load_directory(Path(args['directory']))
        # The engine's job and review budgets are deliberately smaller than the
        # standalone scanner. Reject rather than silently dropping source files.
        if len(json.dumps(files).encode()) > 30000:
            raise ValueError('Selected text snapshot exceeds the shared engine 30 KB import budget')
        return {'files': files, 'skipped': skipped}
    if operation == 'catalog':
        return json.loads((ROOT / 'porter' / 'catalog.json').read_text())
    raise ValueError('Unknown launcher read operation')

try:
    text = sys.stdin.read(128001)
    if len(text.encode()) > 128000:
        raise ValueError('Input exceeds 128 KB')
    result = dispatch(sys.argv[1], json.loads(text))
    output = {'ok': True, 'result': result}
except Exception as error:
    output = {'ok': False, 'error': str(error)[:500]}
print(json.dumps(output, ensure_ascii=True))
