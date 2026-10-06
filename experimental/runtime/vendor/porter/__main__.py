import argparse
import json
from pathlib import Path
from .analyzer import analyze, load_directory, markdown, InputError

def main():
    p=argparse.ArgumentParser(description='Read-only Minecraft mod source portability planner')
    p.add_argument('source',type=Path)
    p.add_argument('--target',default='neoforge-26.3')
    p.add_argument('--rights',choices=['unknown','owner','permission','license-reviewed'],default='unknown')
    p.add_argument('--acknowledge-beta',action='store_true')
    p.add_argument('--format',choices=['json','markdown'],default='json')
    args=p.parse_args()
    try:
        files,skipped=load_directory(args.source)
        r=analyze(files,args.target,args.rights,args.acknowledge_beta)
        r['source']['skipped'].extend(skipped)
        print(markdown(r) if args.format=='markdown' else json.dumps(r,ensure_ascii=False,indent=2))
        return 2 if r['status']=='blocked' else 0
    except (InputError,OSError) as e:
        p.exit(3,f'Input error: {e}\n')

if __name__=='__main__':
    raise SystemExit(main())
