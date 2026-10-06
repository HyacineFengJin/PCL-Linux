"""Source-only identity metadata proposal. No Java or build conversion."""
import argparse
import json
from pathlib import Path
from .analyzer import InputError,load_directory
from .metadata_port import propose_identity_mapping,TEMPLATE_PATH
from .patches import apply_copy,write_new_copy

def main():
 p=argparse.ArgumentParser(description='Review Fabric identity fields mapped into an existing NeoForge manifest template')
 p.add_argument('source',type=Path);p.add_argument('--job-id',required=True);p.add_argument('--approved-digest');p.add_argument('--out',type=Path)
 a=p.parse_args()
 try:
  files,_=load_directory(a.source)
  result=propose_identity_mapping(files,job_id=a.job_id,permitted_paths=[TEMPLATE_PATH])
  if a.approved_digest is None:
   if a.out:p.error('--out requires an explicit approved digest')
   print(json.dumps(result,indent=2,ensure_ascii=False));return 2 if result['status']=='blocked' else 0
  if a.out is None:p.error('--approved-digest requires --out')
  if result['proposal'] is None:raise InputError('No applicable metadata proposal; inspect diagnostics')
  applied=apply_copy(files,result['proposal'],job_id=a.job_id,approved_digest=a.approved_digest,permitted_paths=[TEMPLATE_PATH])
  output=write_new_copy(applied.pop('files'),a.out,source_dir=a.source)
  applied['output_directory']=str(output);applied['domain_validation']=result['validation'];applied['remaining_port_blockers']=result['remaining_port_blockers'];print(json.dumps(applied,ensure_ascii=False,indent=2));return 0
 except (InputError,OSError) as e:p.exit(3,f'Metadata proposal rejected: {e}\n')
if __name__=='__main__':raise SystemExit(main())
