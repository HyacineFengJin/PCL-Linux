"""Two-phase fixture demo CLI; default is preview only."""
import argparse
import json
from pathlib import Path
from .analyzer import load_directory,InputError
from .patches import authored_demo,apply_copy,write_new_copy,DEMO_PATH

def main():
 p=argparse.ArgumentParser(description='Authored fixture patch lifecycle; no automatic mod conversion')
 p.add_argument('source',type=Path)
 p.add_argument('--job-id',required=True)
 p.add_argument('--approved-digest',help='Exact digest of the preview the user reviewed')
 p.add_argument('--out',type=Path,help='New source-copy directory outside the original source')
 a=p.parse_args()
 try:
  files,_=load_directory(a.source)
  contract=authored_demo(files,job_id=a.job_id)
  if a.approved_digest is None:
   if a.out:p.error('--out requires --approved-digest; preview and review first')
   print(json.dumps(contract,indent=2,ensure_ascii=False));return 0
  if a.out is None:p.error('--approved-digest requires --out')
  result=apply_copy(files,contract,job_id=a.job_id,approved_digest=a.approved_digest,permitted_paths=[DEMO_PATH])
  output=write_new_copy(result.pop('files'),a.out,source_dir=a.source)
  result['output_directory']=str(output)
  print(json.dumps(result,indent=2,ensure_ascii=False));return 0
 except (InputError,OSError) as e:p.exit(3,f'Patch rejected: {e}\n')
if __name__=='__main__':raise SystemExit(main())
