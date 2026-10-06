from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tomllib
from typing import Protocol

BASE = Path(__file__).parent
CATALOG = json.loads((BASE / 'catalog.json').read_text())
MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES = 1500, 512_000, 8_000_000
EXCLUDED = {'.git', '.gradle', '.idea', 'node_modules', 'build', 'out', 'target', '.minecraft'}
NAMES = {'fabric.mod.json', 'neoforge.mods.toml', 'mods.toml', 'gradle.properties', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle-wrapper.properties', 'libs.versions.toml', 'pack.mcmeta', 'license', 'license.txt', 'license.md', 'copying', 'notice'}

class InputError(ValueError):
    pass

def selected(path: str) -> bool:
    p = PurePosixPath(path)
    if any(part in EXCLUDED or part.startswith('.') for part in p.parts):
        return False
    return p.name.lower() in NAMES or p.suffix in {'.java', '.kt', '.accesswidener', '.classtweaker'} or (p.suffix == '.json' and ('src' in p.parts or 'mixin' in p.name))

def safe_name(path: str) -> str:
    if not isinstance(path, str) or not path or len(path) > 500:
        raise InputError('Each file needs a relative path of at most 500 characters')
    if '\\' in path or ':' in path or any(ord(c) < 32 for c in path):
        raise InputError('Unsafe source path')
    p = PurePosixPath(path)
    if p.is_absolute() or '..' in p.parts:
        raise InputError('Absolute paths and parent traversal are not accepted')
    return str(p)

def validate_files(files: dict) -> tuple[dict[str, str], list[str]]:
    if not isinstance(files, dict) or len(files) > MAX_FILES:
        raise InputError(f'Expected at most {MAX_FILES} source files')
    clean, skipped, total = {}, [], 0
    if any(not isinstance(name, str) for name in files):
        raise InputError('Source file paths must be strings')
    for name, content in sorted(files.items()):
        path = safe_name(name)
        if not isinstance(content, str):
            raise InputError('File content must be UTF-8 text')
        size = len(content.encode('utf-8'))
        total += size
        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise InputError('Source input exceeds 512 KB per file or 8 MB total')
        if not selected(path):
            skipped.append(path)
            continue
        if '\x00' in content:
            raise InputError('Binary input is not supported; provide the original source tree')
        if path in clean:
            raise InputError('Duplicate normalized source path')
        clean[path] = content
    return clean, skipped

def load_directory(root: Path) -> tuple[dict[str, str], list[str]]:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise InputError('Provide a source directory. JAR conversion is not supported')
    files, skipped, total, count = {}, [], 0, 0
    for current, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED and not d.startswith('.') and not (Path(current)/d).is_symlink())
        for name in sorted(names):
            p = Path(current) / name
            rel = p.relative_to(root).as_posix()
            count += 1
            if count > 20000:
                raise InputError('Directory is too large; select only the mod source project')
            if p.is_symlink() or not p.is_file() or not selected(rel):
                skipped.append(rel)
                continue
            if p.stat().st_size > MAX_FILE_BYTES:
                raise InputError(f'File exceeds 512 KB: {rel}')
            raw = p.read_bytes()
            total += len(raw)
            if total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
                raise InputError('Source tree exceeds analysis limits')
            try:
                files[rel] = raw.decode('utf-8')
            except UnicodeDecodeError as e:
                raise InputError(f'Not UTF-8 source: {rel}') from e
    return files, skipped

def evidence(files: dict, pattern: str, limit=40):
    matches = []
    rx = re.compile(pattern)
    for path, content in files.items():
        for line, text in enumerate(content.splitlines(), 1):
            if rx.search(text):
                matches.append({'path':path, 'line':line, 'excerpt':text.strip()[:200]})
                if len(matches) >= limit:
                    return matches
    return matches

def properties(files):
    result = {}
    for path, text in files.items():
        if PurePosixPath(path).name == 'gradle.properties':
            for line in text.splitlines():
                m = re.match(r'^\s*([\w.]+)\s*=\s*(.*?)\s*$', line)
                if m:
                    # Only version/build metadata, never arbitrary credentials.
                    if any(w in m[1].lower() for w in ('version', 'license', 'mod_id', 'mod_name', 'mapping')):
                        result[m[1]] = m[2]
    return result

def resolve(value, props):
    if not isinstance(value, str):
        return value
    return re.sub(r'\$\{([\w.]+)\}', lambda m: props.get(m[1], m[0]), value)

class PlanProvider(Protocol):
    """Future provider boundary. No external provider is implemented or contacted."""
    name: str
    def suggest(self, report: dict) -> list[dict]: ...

class DeterministicProvider:
    name = 'deterministic-rules-v1 (no LLM)'
    def suggest(self, report):
        return report['steps']

def analyze(files: dict, target_id='neoforge-26.3', rights='unknown', acknowledge_beta=False):
    if rights not in {'unknown', 'owner', 'permission', 'license-reviewed'}:
        raise InputError('Choose a supported rights declaration')
    if type(acknowledge_beta) is not bool:
        raise InputError('Beta acknowledgment must be a boolean')
    files, skipped = validate_files(files)
    target = next((t.copy() for t in CATALOG['targets'] if t['id'] == target_id), None)
    if not target:
        raise InputError('Unknown target: select a verified catalog entry')
    props = properties(files)
    blockers, warnings, metadata, dependencies, steps = [], [], [], [], []
    def block(code, title, detail, paths=None):
        blockers.append({'code':code, 'title':title, 'detail':detail, 'paths':paths or []})
    def warn(code, title, detail, ev=None):
        warnings.append({'code':code, 'title':title, 'detail':detail, 'evidence':ev or []})
    for path, text in files.items():
        name = PurePosixPath(path).name
        try:
            if name == 'fabric.mod.json':
                data = json.loads(text)
                if not isinstance(data, dict) or not isinstance(data.get('id'), str) or not isinstance(data.get('version'), str) or type(data.get('schemaVersion')) is not int or data.get('schemaVersion') != 1:
                    raise ValueError('Expected schemaVersion 1 with string id and version')
                depends = data.get('depends', {})
                entrypoints = data.get('entrypoints', {})
                if not isinstance(depends, dict) or not isinstance(entrypoints, dict):
                    raise ValueError('depends and entrypoints must be objects')
                item = {'loader':'fabric', 'path':path, 'id':data['id'], 'version':resolve(data['version'], props), 'license':data.get('license'), 'minecraft':resolve(depends.get('minecraft'), props), 'entrypoints':entrypoints, 'mixins':data.get('mixins', []), 'environment':data.get('environment', '*')}
                metadata.append(item)
                dependencies.extend({'id':k, 'constraint':resolve(v, props), 'source':path, 'required':True, 'target_status':'unverified'} for k,v in depends.items())
            elif name in {'neoforge.mods.toml', 'mods.toml'}:
                data = tomllib.loads(text)
                mods = data.get('mods', [])
                if not isinstance(mods, list) or not mods:
                    raise ValueError('Expected at least one [[mods]] entry')
                for mod in mods:
                    if not isinstance(mod, dict) or not isinstance(mod.get('modId'), str):
                        raise ValueError('Each mod needs a string modId')
                    deps = data.get('dependencies', {}).get(mod['modId'], [])
                    if not isinstance(deps, list):
                        raise ValueError('Dependencies must use [[dependencies.modid]] tables')
                    if any(not isinstance(d, dict) or not isinstance(d.get('modId'), str) for d in deps):
                        raise ValueError('Each dependency needs a string modId')
                    metadata.append({'loader':'neoforge' if name == 'neoforge.mods.toml' else 'forge-legacy', 'path':path, 'id':resolve(mod['modId'], props), 'version':resolve(mod.get('version'), props), 'license':resolve(data.get('license'), props), 'minecraft':next((resolve(d.get('versionRange'), props) for d in deps if d.get('modId') == 'minecraft'), None), 'entrypoints':{}, 'mixins':data.get('mixins', []), 'environment':'verify in source'})
                    dependencies.extend({'id':d.get('modId','unknown'), 'constraint':resolve(d.get('versionRange'), props), 'source':path, 'required':d.get('type', 'required') == 'required' and d.get('mandatory', True), 'target_status':'unverified'} for d in deps)
        except (ValueError, TypeError, AttributeError, RecursionError) as e:
            block('invalid-metadata', 'Metadata could not be parsed', f'{path}: {str(e)[:180]}', [path])
    source_files = [p for p in files if PurePosixPath(p).suffix in {'.java','.kt'}]
    builds = [p for p in files if PurePosixPath(p).name in {'build.gradle','build.gradle.kts'}]
    licenses = [p for p in files if PurePosixPath(p).name.lower() in {'license','license.txt','license.md','copying','notice'}]
    if not source_files:
        block('source-required', 'Original source is required', 'No Java/Kotlin source was supplied. A JAR or metadata alone cannot establish a feasible source port')
    if not metadata:
        block('metadata-required', 'No supported mod manifest found', 'Supply fabric.mod.json or META-INF/neoforge.mods.toml with the source tree')
    if not builds:
        block('build-missing', 'Build configuration is missing', 'Supply the Gradle build files. This planner reads them as text and never runs them')
    if rights == 'unknown':
        block('rights-required', 'Permission needs confirmation', 'Declare ownership, explicit permission, or a reviewed license allowing this modification; public source alone is insufficient')
    if not licenses or any(not m['license'] for m in metadata):
        warn('license-review', 'License evidence is incomplete', 'Preserve original notices and verify source, assets and dependency terms before sharing any port')
    if target['channel'] == 'beta' and not acknowledge_beta:
        block('beta-unaccepted', 'Target is a beta release', 'Explicitly acknowledge the beta target before planning implementation')
    if target['loader_version'] is None:
        block('target-pair-unverified', 'Target loader pair is not verified', 'The game exists in the official catalog, but this snapshot does not verify an exact loader/game pair')
    loaders = sorted(set(m['loader'] for m in metadata))
    cross = bool(loaders and target['loader'] not in loaders)
    if len(loaders) > 1:
        warn('multi-loader', 'Multiple loader source sets detected', 'Keep module boundaries; the planner does not evaluate Gradle source sets')
    unresolved = [m['path'] for m in metadata if '${' in json.dumps(m)]
    if unresolved:
        block('unresolved-properties', 'Metadata placeholders remain unresolved', 'Confirm dynamic Gradle expansions in a reviewed build environment', unresolved)
    if source_files:
        warn('static-only', 'Static analysis cannot prove compatibility', 'Regex evidence may include comments and unused code; absence of a match is not proof of safety')
    third = [d for d in dependencies if d['id'] not in {'minecraft','java','fabricloader','neoforge','forge','fabric-api'}]
    if third:
        block('dependencies-unverified', 'Third-party dependency ports need verification', 'Find an exact compatible artifact or port/replacement for: '+', '.join(sorted(set(str(d['id']) for d in third))))
    if cross:
        warn('loader-change', 'Loader APIs need source changes', 'Metadata renaming cannot replace entrypoints, event lifecycle, registrations or networking APIs')
    def step(key, title, action, paths, ev=None, prerequisite=None):
        steps.append({'id':key, 'title':title, 'action':action, 'files':paths, 'evidence':ev or [], 'depends_on':prerequisite or [], 'status':'manual-review', 'apply_automatically':False})
    step('baseline','Freeze a reproducible source baseline','Record source revision and SHA-256 inventory; review rights and build scripts; prepare a disposable worktree without real saves', list(files), prerequisite=[])
    step('toolchain','Select and pin target toolchain',f'Confirm target MDK/Loom, Gradle and JDK requirements for Minecraft {target["minecraft"]}; pin loader {target["loader_version"] or "<UNVERIFIED>"}. Do not infer Fabric API or plugin versions from the game number', builds, evidence(files,r'loom|moddev|neo_version|minecraft_version|JavaLanguageVersion|jvmToolchain|mappings'), ['baseline'])
    step('metadata','Translate loader metadata','Preserve IDs, versions, license notices and side restrictions. Translate dependency constraints with target-loader semantics; do not widen them merely to suppress errors', [m['path'] for m in metadata], prerequisite=['toolchain'])
    api_ev = evidence(files,r'net\.fabricmc\.|net\.neoforged\.|net\.minecraftforge\.|@Mod\b|ModInitializer|DeferredRegister')
    if api_ev:
        step('loader-api','Review entrypoints, events and registries','Map each used API against target documentation. Separate shared logic from loader-specific initialization; confirm registration timing and client/server separation', sorted(set(e['path'] for e in api_ev)), api_ev, ['metadata'])
    mix_ev = evidence(files,r'@Mixin|@Inject|@Redirect|@Modify|@Accessor|@Invoker|mixins|accessWidener|accesswidener|classtweaker')
    if mix_ev:
        warn('mixin-risk','Mixin targets require runtime validation','Method names, descriptors, injection points and access modifications may change independently of compilation',mix_ev)
        step('mixins','Revalidate every Mixin and access change','Inspect target bytecode/source and injection counts. Prefer supported public hooks when available. Verify both remapping and required-injection behavior', sorted(set(e['path'] for e in mix_ev)),mix_ev,['toolchain'])
    glfw = evidence(files,r'org\.lwjgl\.glfw|GLFW\.|glfw[A-Z]')
    if target['minecraft'] == '26.3' and glfw:
        block('glfw-sdl','26.3 input/window API migration detected','The official 26.3 primer documents GLFW to SDL changes. Inspect these call sites before implementation',sorted(set(e['path'] for e in glfw)))
        step('input-api','Review GLFW to SDL migration','Replace raw input/window assumptions using verified target APIs; no automated symbol substitution is safe',sorted(set(e['path'] for e in glfw)),glfw,['toolchain'])
    res_ev = evidence(files,r'pack_format|supported_formats|registerGlobalReceiver|PayloadTypeRegistry|StreamCodec|Codec|Registry')
    if res_ev:
        step('data-network','Review data, resources and networking','Check codecs, packets, registry IDs, resource/data pack schema and save migration. Preserve identifiers; use copied throwaway worlds for tests',sorted(set(e['path'] for e in res_ev)),res_ev,['toolchain'])
    step('dependencies','Resolve dependency compatibility','Check every required and optional dependency against exact target artifacts, loader, side and license. Fabric API is not interchangeable with NeoForge',sorted(set(d['source'] for d in dependencies)),prerequisite=['toolchain'])
    step('validation','Validate in an isolated test matrix','Only after authorization to execute reviewed code: compile, run unit/GameTests, launch client and dedicated server, then test a copied disposable world. Record logs; never claim success from a clean compile alone',[],prerequisite=[s['id'] for s in steps if s['id'] != 'baseline'])
    hashes = {p:hashlib.sha256(c.encode()).hexdigest() for p,c in files.items()}
    fingerprint = hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
    report = {'schema_version':1,'engine':'deterministic-rules-v1 (no LLM)','mode':'read-only-dry-run','input_fingerprint':fingerprint,'source':{'loaders':loaders,'metadata':metadata,'source_files':len(source_files),'files_analyzed':len(files),'skipped':skipped,'file_sha256':hashes,'build_files':builds,'license_files':licenses},'target':target,'catalog_checked_at':CATALOG['checked_at'],'rights_declaration':rights,'rights_verified':False,'status':'blocked' if blockers else 'review-required','blockers':blockers,'warnings':warnings,'dependencies':dependencies,'steps':steps,'execution':{'build_run':False,'game_run':False,'source_modified':False,'external_provider_contacted':False},'validation_matrix':[{'stage':s,'result':'not-run'} for s in ['compile','unit-tests','GameTests','client-launch','dedicated-server','copied-world-behavior']],'references':CATALOG['sources']}
    report['patch_preview'] = patch_preview(report)
    return report

def patch_preview(report):
    if not report['source']['metadata']:
        return {'available':False,'reason':'A valid source manifest is needed','content':''}
    m = report['source']['metadata'][0]
    if report['target']['loader'] == 'neoforge':
        # JSON-quoted strings are also valid TOML basic strings for these values.
        q = lambda x: json.dumps(str(x or '<VERIFY>'),ensure_ascii=False)
        content = '# REVIEW SKETCH ONLY: incomplete, never applied or built\n# Preserve source notices and verify all fields against target MDK\nmodLoader="javafml"\nloaderVersion="<VERIFY_FML_LOADER_RANGE>"\nlicense='+q(m['license'])+'\n\n[[mods]]\nmodId='+q(m['id'])+'\nversion='+q(m['version'])+'\n\n# TODO: complete dependencies, entrypoints, mixins, side restrictions\n# Target NeoForge: '+report['target']['loader_version']+'\n'
        path = 'src/main/resources/META-INF/neoforge.mods.toml'
    else:
        content = json.dumps({'schemaVersion':1,'id':m['id'],'version':m['version'],'license':m['license'],'entrypoints':{'main':['<VERIFY_TARGET_ENTRYPOINT>']},'depends':{'minecraft':report['target']['minecraft'],'fabricloader':'<VERIFY_LOADER_VERSION>'}},indent=2,ensure_ascii=False)
        path = 'src/main/resources/fabric.mod.json'
    return {'available':True,'proposed_path':path,'content':content,'apply_allowed':False,'complete':False,'reason':'Illustrative manifest scaffold only. Blockers and manual source work remain'}

def markdown(report):
    r=report
    lines=['# Mod Port Lab: dry-run plan', '',f"Status: {r['status']}; engine: {r['engine']}",f"Target: Minecraft {r['target']['minecraft']} / {r['target']['loader']} {r['target']['loader_version'] or 'unverified'}",f"Catalog checked: {r['catalog_checked_at']}",'','No source changed. No build or game was run. This is not a compatibility certificate.','','## Blockers']
    lines += [f"- {b['title']}: {b['detail']}" for b in r['blockers']] or ['- None detected; human review and runtime validation remain required']
    lines += ['', '## Review plan']
    for i,s in enumerate(r['steps'],1):
        lines += [f"{i}. {s['title']}: {s['action']}"]
    lines += ['', '## Sources']+[f"- [{x['title']}]({x['url']})" for x in r['references']]
    return '\n'.join(lines)+'\n'
