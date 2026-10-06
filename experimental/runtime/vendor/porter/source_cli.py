"""Dry-run Java source recipe; explicit profile and permitted paths required."""
import argparse
import json
from pathlib import Path
from .analyzer import load_directory,InputError
from .java_identifier import propose_identifier_factory,RECIPE_ID,SOURCE_PROFILE,TARGET_PROFILE
from .patches import apply_copy,write_new_copy

def main():
 p=argparse.ArgumentParser(description='One documented source-only Identifier migration; no compilation or full-port claim')
 p.add_argument('source',type=Path);p.add_argument('--job-id',required=True)
 p.add_argument('--profile',required=True,choices=[RECIPE_ID],help='Explicit host declaration of source/target versions and Yarn mappings')
 p.add_argument('--allow-path',required=True,action='append',help='Existing relative Java path allowed in the reviewed proposal; repeat as needed')
 p.add_argument('--approved-digest');p.add_argument('--out',type=Path)
 a=p.parse_args()
 try:
  files,_=load_directory(a.source)
  result=propose_identifier_factory(files,job_id=a.job_id,permitted_paths=a.allow_path,source_profile=SOURCE_PROFILE,target_profile=TARGET_PROFILE)
  if a.approved_digest is None:
   if a.out:p.error('--out requires a previously reviewed exact --approved-digest')
   print(json.dumps(result,ensure_ascii=False,indent=2));return 2 if result['proposal'] is None and result['diagnostics'] else 0
  if a.out is None:p.error('--approved-digest requires --out')
  if result['proposal'] is None:raise InputError('No supported source edit is available; inspect TODO diagnostics')
  copied=apply_copy(files,result['proposal'],job_id=a.job_id,approved_digest=a.approved_digest,permitted_paths=a.allow_path)
  out=write_new_copy(copied.pop('files'),a.out,source_dir=a.source)
  copied['output_directory']=str(out);copied['domain_recipe']={k:result[k] for k in ['recipe_id','analysis_method','full_port_status','remaining_port_blockers','validation']}
  print(json.dumps(copied,ensure_ascii=False,indent=2));return 0
 except (InputError,OSError) as e:p.exit(3,f'Source recipe rejected: {e}\n')
if __name__=='__main__':raise SystemExit(main())
