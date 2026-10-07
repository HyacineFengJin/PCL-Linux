"""Review-bound text patch lifecycle. No builds, agents, or edits to original input."""
from __future__ import annotations
import difflib
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from .analyzer import InputError, safe_name, validate_files

CONTRACT_VERSION = 1
DEMO_PATH = 'src/main/resources/fabric.mod.json'
DENIED_NAMES = {'build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradlew','gradlew.bat','gradle-wrapper.properties','gradle-wrapper.jar','libs.versions.toml','pom.xml','package.json','package-lock.json','requirements.txt','setup.py','pyproject.toml','makefile','dockerfile'}
DENIED_SUFFIXES = {'.sh','.bash','.bat','.cmd','.ps1','.exe','.dll','.so','.dylib','.jar','.class','.py','.js','.mjs','.cjs'}

class PatchError(InputError):
    pass

def sha(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()

def canonical_hash(data) -> str:
    try:
        return sha(json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False))
    except (ValueError,TypeError,RecursionError) as e:
        raise PatchError('Contract must be bounded, canonical JSON') from e

def validate_job(job_id):
    if not isinstance(job_id,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}',job_id):
        raise PatchError('job_id must be 8–80 letters, digits, underscores or hyphens')

def imported_snapshot(files: dict) -> dict:
    clean, skipped = validate_files(files)
    if set(clean) != set(files):
        raise PatchError('Snapshot paths must be canonical relative paths')
    if skipped:
        raise PatchError('Patch lifecycle requires an explicit imported text snapshot; unsupported/ignored paths are not silently copied')
    hashes = {p:sha(text) for p,text in clean.items()}
    return {'scope':'imported-text-files-only','file_count':len(clean),'file_sha256':hashes,'fingerprint':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()}

def permitted_set(paths) -> set[str]:
    if not isinstance(paths,(list,tuple,set)) or not paths:
        raise PatchError('An explicit nonempty permitted path list is required')
    normalized = []
    for p in paths:
        n=safe_name(p)
        if n != p:
            raise PatchError('Permitted paths must be canonical relative paths')
        parts=PurePosixPath(n).parts
        name=parts[-1].lower()
        if name in DENIED_NAMES or PurePosixPath(name).suffix in DENIED_SUFFIXES or any(x.lower() in {'gradle','.github','.git','buildsrc','build-logic','scripts'} for x in parts):
            raise PatchError('Build scripts, executable/configuration surfaces and toolchain files are excluded from this patch mode')
        normalized.append(n)
    if len(set(normalized)) != len(normalized):
        raise PatchError('Duplicate permitted path')
    return set(normalized)

def review_digest(contract: dict) -> str:
    return canonical_hash({k:v for k,v in contract.items() if k!='review_digest'})

def text_diff(path: str, before: str, after: str) -> str:
    """Keep EOF boundaries visible even when either text lacks a final newline."""
    lines = difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True), fromfile='a/'+path, tofile='b/'+path)
    return ''.join(line if line.endswith(('\n', '\r')) else line+'\n\\ No newline at end of file\n' for line in lines)

def create_patch(files: dict, replacements: dict, *, job_id: str, permitted_paths: list[str], purpose: str) -> dict:
    validate_job(job_id)
    snap=imported_snapshot(files)
    allow=permitted_set(permitted_paths)
    if not allow <= set(files):
        raise PatchError('This prototype replaces existing imported text files only; additions require a separate contract')
    if not isinstance(replacements,dict) or not replacements or any(not isinstance(k,str) for k in replacements):
        raise PatchError('At least one replacement is required')
    if not isinstance(purpose,str) or not purpose or len(purpose)>500:
        raise PatchError('A short human-readable patch purpose is required')
    changes=[]
    for path,new_text in sorted(replacements.items()):
        if path not in allow:
            raise PatchError('Patch path is not explicitly permitted')
        validate_files({path:new_text})
        if files[path]==new_text:
            raise PatchError('Patch must change the selected text')
        changes.append({'path':path,'base_sha256':sha(files[path]),'new_sha256':sha(new_text),'new_text':new_text,'unified_diff':text_diff(path, files[path], new_text)})
    # Refuse an unmaterializable aggregate before presenting an approval.
    imported_snapshot({**files, **replacements})
    contract={'contract_version':CONTRACT_VERSION,'job_id':job_id,'purpose':purpose,'source_snapshot':snap,'permitted_paths':sorted(allow),'changes':changes,'apply_mode':'new-imported-text-copy-only','validation':{'contract_checks':'required-at-apply','semantic_correctness':'not-established','build':'not-run','game':'not-run'},'not_a_general_mod_converter':True}
    contract['review_digest']=review_digest(contract)
    return contract

def apply_copy(files: dict, contract: dict, *, job_id: str, approved_digest: str, permitted_paths: list[str]) -> dict:
    validate_job(job_id)
    if not isinstance(contract,dict) or type(contract.get('contract_version')) is not int or contract.get('contract_version') != CONTRACT_VERSION:
        raise PatchError('Unsupported patch contract')
    if contract.get('job_id') != job_id:
        raise PatchError('Cross-job patch rejected')
    if not isinstance(approved_digest,str) or approved_digest != contract.get('review_digest') or approved_digest != review_digest(contract):
        raise PatchError('Exact current review digest approval is required; patch may have changed')
    current=imported_snapshot(files)
    if current != contract.get('source_snapshot'):
        raise PatchError('Stale source snapshot rejected; regenerate and review the patch')
    allow=permitted_set(permitted_paths)
    if allow != permitted_set(contract.get('permitted_paths')):
        raise PatchError('Permitted path scope changed; review is required again')
    if contract.get('apply_mode') != 'new-imported-text-copy-only':
        raise PatchError('Only new-copy application is supported')
    changes=contract.get('changes')
    if not isinstance(changes,list) or not changes:
        raise PatchError('No reviewed changes found')
    output=dict(files); changed=[]
    for c in changes:
        if not isinstance(c,dict) or not isinstance(c.get('path'),str):
            raise PatchError('Invalid change entry')
        path=c['path']
        if path not in allow or path not in files or path in changed:
            raise PatchError('Unpermitted, missing or duplicate patch path')
        if sha(files[path]) != c.get('base_sha256'):
            raise PatchError('Exact base file hash mismatch')
        new=c.get('new_text')
        validate_files({path:new})
        if sha(new) != c.get('new_sha256'):
            raise PatchError('Replacement hash mismatch')
        actual_diff=text_diff(path, files[path], new)
        # Persisted v1 reviews used difflib's ambiguous missing-newline spelling.
        # Their exact bytes and hashes still bind approval; retain apply support.
        legacy_diff=''.join(difflib.unified_diff(files[path].splitlines(keepends=True),new.splitlines(keepends=True),fromfile='a/'+path,tofile='b/'+path))
        if c.get('unified_diff') not in {actual_diff, legacy_diff}:
            raise PatchError('Preview no longer matches patch content')
        output[path]=new;changed.append(path)
    after=imported_snapshot(output)
    if imported_snapshot(files) != current:
        raise PatchError('Original source unexpectedly changed')
    return {'job_id':job_id,'review_digest':approved_digest,'status':'copy-created-not-semantically-validated','files':output,'receipt':{'source_fingerprint':current['fingerprint'],'copy_fingerprint':after['fingerprint'],'changed_paths':changed,'original_source_unchanged':True,'copy_sha256':after['file_sha256'],'validation':{'contract_and_hashes':'passed','source_immutable':'passed','compile':'not-run','runtime':'not-run','semantic_correctness':'not-established'}}}

def authored_demo(files: dict, *, job_id: str) -> dict:
    """One narrow administrative metadata edit for our exact authored fixture."""
    from .analyzer import load_directory
    fixture,_=load_directory(Path(__file__).resolve().parents[1]/'fixtures'/'fabric-lantern')
    if imported_snapshot(files) != imported_snapshot(fixture):
        raise PatchError('Demo transformation is limited to the unchanged authored Fabric Lantern fixture')
    metadata=json.loads(files[DEMO_PATH])
    metadata['description']='Reviewed metadata lifecycle demonstration. No behavior or loader conversion was performed.'
    replacement=json.dumps(metadata,ensure_ascii=False,indent=2)+'\n'
    return create_patch(files,{DEMO_PATH:replacement},job_id=job_id,permitted_paths=[DEMO_PATH],purpose='Authored fixture only: add an explanatory description to demonstrate preview, exact review approval and apply-to-copy. This is not a loader/API port.')

def write_new_copy(files: dict, output_dir: Path, *, source_dir: Path) -> Path:
    """CLI-only materialization to a NEW directory. Refuses source or existing target."""
    imported_snapshot(files)
    source=source_dir.resolve(strict=True)
    out=output_dir.absolute()
    if out.is_symlink() or out.exists():
        raise PatchError('Output must be a new, nonexistent directory')
    parent=out.parent.resolve(strict=True)
    resolved=parent/out.name
    if resolved==source or resolved.is_relative_to(source):
        raise PatchError('Output cannot be inside the original source directory')
    resolved.mkdir(exist_ok=False)
    for path,content in sorted(files.items()):
        target=resolved/path
        target.parent.mkdir(parents=True,exist_ok=True)
        # All target paths are validated and the output tree was just created.
        with target.open('x',encoding='utf-8') as f:f.write(content)
    for path,content in files.items():
        if (resolved/path).read_bytes() != content.encode('utf-8'):
            raise PatchError('New-copy materialization verification failed')
    return resolved
