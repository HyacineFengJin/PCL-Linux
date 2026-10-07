"""One documented metadata-only recipe. Never rewrites Java or build scripts."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import re
import tomllib
from .analyzer import InputError, load_directory, safe_name
from .patches import create_patch, imported_snapshot, review_digest, PatchError
SOURCE_PATH='src/main/resources/fabric.mod.json'
TEMPLATE_PATH='src/main/resources/META-INF/neoforge.mods.toml'
RECIPE_ID='fabric-identity-to-neoforge-template-v1'
SOURCES=[
 {'title':'Fabric fabric.mod.json specification','url':'https://docs.fabricmc.net/develop/loader/fabric-mod-json'},
 {'title':'NeoForge mod file specification (documentation labelled 26.1)','url':'https://docs.neoforged.net/docs/gettingstarted/modfiles/'}
]
MAPPINGS=[('license','license','root'),('id','modId','mod'),('version','version','mod'),('name','displayName','mod'),('description','description','mod')]

def propose_identity_mapping(files:dict, *, job_id:str, permitted_paths:list[str], source_path=SOURCE_PATH, template_path=TEMPLATE_PATH):
    imported_snapshot(files)
    if safe_name(source_path)!=source_path or safe_name(template_path)!=template_path:
        raise InputError('Source and template paths must be canonical relative paths')
    diagnostics=[]
    result={'recipe_id':RECIPE_ID,'status':'blocked','scope':'identity-metadata-only','source_path':source_path,'destination_template_path':template_path,'mapped_fields':[],'diagnostics':diagnostics,'proposal':None,'full_port_status':'blocked-unvalidated','remaining_port_blockers':[{'code':'build-runtime-unvalidated','message':'Build, client, dedicated server, data/resources and runtime behavior remain unvalidated; metadata mapping cannot establish a complete port.'}],'references':SOURCES,'validation':{'json_parse':'not-run','toml_parse':'not-run','unmapped_template_fields':'not-run','compile':'not-run','game':'not-run','full_loader_port':'not-established'}}
    def note(code,message,severity='blocked'):
        diagnostics.append({'code':code,'message':message,'severity':severity})
        if severity in {'blocked','manual-port-required'}:
            result['remaining_port_blockers'].append({'code':code,'message':message})
    if source_path not in files or template_path not in files:
        note('existing-inputs-required','Both the source manifest and an existing explicitly provided destination template are required. This recipe cannot create new files.')
        return result
    if permitted_paths != [template_path]:
        note('exact-destination-scope-required','This recipe requires host review of exactly the existing destination TOML path; no source/build file is writable.')
        return result
    def unique_object(pairs):
        value={}
        for key,item in pairs:
            if key in value:raise ValueError('Duplicate JSON metadata key: '+key)
            value[key]=item
        return value
    try:
        fabric=json.loads(files[source_path],object_pairs_hook=unique_object);target=tomllib.loads(files[template_path])
        if not isinstance(fabric,dict) or type(fabric.get('schemaVersion')) is not int or fabric.get('schemaVersion') != 1:
            raise ValueError('Expected Fabric metadata schemaVersion 1')
        if not isinstance(target.get('mods'),list) or len(target['mods']) != 1 or not isinstance(target['mods'][0],dict):
            raise ValueError('Destination template must contain exactly one [[mods]] table')
        result['validation']['json_parse']='passed';result['validation']['toml_parse']='passed'
    except (ValueError,TypeError,AttributeError,RecursionError) as e:
        note('parse-or-shape-error',str(e)[:200]);return result
    source_values={'license':fabric.get('license'),'id':fabric.get('id'),'version':fabric.get('version'),'name':fabric.get('name',fabric.get('id')),'description':fabric.get('description','')}
    for field,value in source_values.items():
        if not isinstance(value,str):note('string-field-required',f'{field}: a single string is required. License arrays need a human licensing decision and are not joined automatically.')
        elif '${' in value:note('dynamic-source-value',f'{field}: unresolved Gradle/property value; no build script is executed or altered by this recipe.')
        elif field in {'license','id','version'} and not value:note('required-value-empty',f'{field}: a nonempty value is required.')
    mod_id=source_values['id']
    if isinstance(mod_id,str) and not re.fullmatch(r'[a-z][a-z0-9_]{1,63}',mod_id):
        note('incompatible-mod-id','Fabric ID cannot be copied safely into the stricter supported NeoForge ID form. Hyphens, capitals or namespace changes require a reviewed project-wide migration; no automatic renaming.')
    old_id=target['mods'][0].get('modId')
    if not isinstance(old_id,str):note('template-id-type','Destination modId must be a string')
    if isinstance(old_id,str) and old_id != mod_id:
        for section in ('dependencies','features','modproperties'):
            table=target.get(section,{})
            if isinstance(table,dict) and old_id in table:
                note('id-keyed-template-section',f'{section} is keyed by the old target ID. This recipe will not silently rename related sections or namespaces.')
    if 'namespace' in target['mods'][0] and target['mods'][0]['namespace'] != mod_id:
        note('explicit-namespace-review','Destination template declares a different explicit namespace; decide its preservation before identity mapping.')
    for source_key,target_key,scope in MAPPINGS:
        existing=target.get(target_key) if scope=='root' else target['mods'][0].get(target_key)
        if not isinstance(existing,str):note('template-field-required',f'Destination {target_key} must exist as a direct single-line string field in its expected table.')
        elif '${' in existing:note('gradle-managed-target-value',f'{target_key} is managed by Gradle/property substitution. Editing its source property is outside this recipe\'s permitted paths.')
    for field in ('entrypoints','mixins','accessWidener','depends','recommends','suggests','conflicts','breaks','jars','languageAdapters','custom'):
        if fabric.get(field):note('unmapped-'+field,f'Fabric {field} is not converted. Its loader/API, dependency or packaging meaning needs a separate reviewed task.','manual-port-required')
    if any(fabric.get(k) for k in ('authors','contributors','contact','icon')):
        note('unmapped-display-attribution','Authors, contributors, contact and icon are outside this five-field recipe. Preserve credits/notices and review their display mapping separately.','review-required')
    if fabric.get('environment','*') != '*':note('unmapped-side','Fabric environment is not copied as a NeoForge side policy. Review client/server loading separately.','manual-port-required')
    note('loader-template-preserved','modLoader, loaderVersion, dependencies and all other template fields are preserved. Their suitability for the target is not verified here.','review-required')
    if any(d['severity']=='blocked' for d in diagnostics):return result
    # Only direct single-line string assignments in root/one [[mods]] are supported.
    # TOML is parsed before and after; untouched semantics must remain identical.
    updates={('root' if scope=='root' else 'mod',target_key):source_values[source_key] for source_key,target_key,scope in MAPPINGS}
    counts={key:0 for key in updates};section='root';lines=[]
    assignment=re.compile(r'''^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$''')
    for line in files[template_path].splitlines(keepends=True):
        ending='\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
        bare=line[:-len(ending)] if ending else line
        if re.match(r'^\s*\[\[mods\]\]\s*(?:#.*)?$',bare):section='mod'
        elif bare.lstrip().startswith('['):section='other'
        m=assignment.fullmatch(bare)
        key=(section,m[2]) if m else None
        if key in updates:
            counts[key]+=1
            lines.append(m[1]+m[2]+' = '+json.dumps(updates[key],ensure_ascii=False)+m[4]+ending)
        else:lines.append(line)
    if any(n!=1 for n in counts.values()):
        note('unsupported-template-syntax','Each mapped template field must be a direct, unique, single-line string. Multiline/quoted/dotted keys are intentionally not rewritten.');return result
    proposed=''.join(lines)
    try:
        parsed=tomllib.loads(proposed)
        expected=copy.deepcopy(target)
        for source_key,target_key,scope in MAPPINGS:
            if scope=='root':expected[target_key]=source_values[source_key]
            else:expected['mods'][0][target_key]=source_values[source_key]
        if parsed!=expected:raise ValueError('A field outside the explicit mapping would change')
    except (ValueError,TypeError,RecursionError) as e:
        note('post-transform-validation',str(e));return result
    if proposed==files[template_path]:
        note('already-mapped','Template already matches; no patch generated.','info');result['status']='no-change';result['validation']['unmapped_template_fields']='preserved';return result
    result['mapped_fields']=[{'source_field':s,'target_field':('license' if scope=='root' else 'mods[0].'+t),'value':source_values[s]} for s,t,scope in MAPPINGS]
    result['validation']['unmapped_template_fields']='preserved'
    contract=create_patch(files,{template_path:proposed},job_id=job_id,permitted_paths=permitted_paths,purpose='Documented identity/display metadata mapping from Fabric into an existing NeoForge template. No entrypoint, API, dependency, build or full-loader conversion.')
    contract['domain_recipe']={'recipe_id':RECIPE_ID,'mapped_fields':result['mapped_fields'],'diagnostics':diagnostics,'references':SOURCES,'validation':result['validation'],'full_port_status':result['full_port_status'],'remaining_port_blockers':result['remaining_port_blockers']}
    contract['review_digest']=review_digest(contract)
    result['status']='metadata-only-proposal';result['proposal']=contract
    return result

def authored_identity_demo(files:dict,*,job_id:str):
    expected,_=load_directory(Path(__file__).resolve().parents[1]/'fixtures/metadata-identity')
    if imported_snapshot(files)!=imported_snapshot(expected):raise PatchError('Identity demo is limited to the unchanged authored metadata-identity fixture')
    return propose_identity_mapping(files,job_id=job_id,permitted_paths=[TEMPLATE_PATH])
