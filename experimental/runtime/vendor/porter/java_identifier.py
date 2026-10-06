"""Conservative Java-token recipe for one verified Fabric/Yarn API migration.

A lexer plus restricted structural checks, NOT a complete Java AST/type checker.
Only reviewed text proposals are produced. Ambiguity is reported as TODO.
"""
from __future__ import annotations
from dataclasses import dataclass
from bisect import bisect_right
from pathlib import Path, PurePosixPath
import re
from .analyzer import InputError
from .patches import imported_snapshot, create_patch, review_digest, permitted_set

RECIPE_ID='fabric-yarn-1.20.6-to-1.21-identifier-v1'
SOURCE_PROFILE={'minecraft':'1.20.6','loader':'fabric','mappings':'yarn'}
TARGET_PROFILE={'minecraft':'1.21','loader':'fabric','mappings':'yarn'}
OFFICIAL_TYPE='net.minecraft.util.Identifier'
REFERENCES=[
 {'title':'Fabric 1.21 migration: Identifier constructors to static factories','url':'https://fabricmc.net/2024/05/31/121.html#identifier'},
 {'title':'Fabric Yarn 1.20.6 build 3: Identifier API','url':'https://maven.fabricmc.net/docs/yarn-1.20.6%2Bbuild.3/net/minecraft/util/Identifier.html'},
 {'title':'Fabric Yarn 1.21 build 9: Identifier API','url':'https://maven.fabricmc.net/docs/yarn-1.21%2Bbuild.9/net/minecraft/util/Identifier.html'}
]

@dataclass(frozen=True)
class Token:
    kind:str
    text:str
    start:int
    end:int
    line:int

class SyntaxTodo(ValueError):
    def __init__(self,code,message,offset=0):
        super().__init__(message);self.code=code;self.offset=offset

def tokenize(source:str)->list[Token]:
    if '\\u' in source:
        raise SyntaxTodo('unicode-prelex','Java Unicode escapes are processed before tokenization; this recipe refuses the entire file.',source.index('\\u'))
    starts=[0]+[m.end() for m in re.finditer(r'\r\n|\r|\n',source)]
    tokens=[];i=0;n=len(source)
    def add(kind,start,end):
        tokens.append(Token(kind,source[start:end],start,end,bisect_right(starts,start)))
        if len(tokens)>40_000:raise SyntaxTodo('token-budget','Java token budget exceeded; reduce the selected file.',start)
    while i<n:
        c=source[i]
        if c in ' \t\r\n\f':i+=1;continue
        if source.startswith('//',i):
            start=i;i+=2
            while i<n and source[i] not in '\r\n':i+=1
            continue
        if source.startswith('/*',i):
            end=source.find('*/',i+2)
            if end<0:raise SyntaxTodo('unterminated-comment','Block comment is incomplete.',i)
            i=end+2;continue
        if source.startswith('"""',i):raise SyntaxTodo('text-block','Java text blocks are outside this restricted lexer; no edits are proposed for this file.',i)
        if c in '\"\'':
            quote=c;start=i;i+=1
            while i<n:
                if source[i] in '\r\n':raise SyntaxTodo('unterminated-literal','Unescaped newline in a Java literal.',start)
                if source[i]=='\\':
                    if i+1>=n or source[i+1] in '\r\n':raise SyntaxTodo('unterminated-literal','Incomplete literal escape.',start)
                    i+=2;continue
                if source[i]==quote:i+=1;break
                i+=1
            else:raise SyntaxTodo('unterminated-literal','String/character literal is incomplete.',start)
            add('string' if quote=='"' else 'char',start,i);continue
        if c.isascii() and (c.isalpha() or c in '_$'):
            start=i;i+=1
            while i<n and source[i].isascii() and (source[i].isalnum() or source[i] in '_$'):i+=1
            add('identifier',start,i);continue
        if c.isascii() and c.isdigit():
            start=i;i+=1
            while i<n and (source[i].isascii() and (source[i].isalnum() or source[i] in '._')):i+=1
            add('number',start,i);continue
        if c in '{}[]().,;:=+-*/%!&|^~<>?@':
            start=i
            if source[i:i+2] in {'::','->','&&','||','==','!=','<=','>=','++','--','+=','-=','*=','/=','&=','|=','^=','%='}:i+=2
            else:i+=1
            add('symbol',start,i);continue
        raise SyntaxTodo('unsupported-character','Unsupported Java lexical character outside comments/strings; no edits for this file.',i)
    # Delimiter balance is checked over code tokens only, never string/comment text.
    stack=[];pairs={')':'(',']':'[','}':'{'}
    for t in tokens:
        if t.text in {'(','[','{'}:stack.append(t)
        elif t.text in pairs:
            if not stack or stack[-1].text!=pairs[t.text]:raise SyntaxTodo('unbalanced-delimiter','Unbalanced Java code delimiters.',t.start)
            stack.pop()
    if stack:raise SyntaxTodo('unbalanced-delimiter','Unclosed Java code delimiter.',stack[-1].start)
    return tokens

def imports_and_package(tokens):
    imports=[];ignored=set();package='';i=0
    while i<len(tokens):
        if tokens[i].text not in {'package','import'}:i+=1;continue
        kind=tokens[i].text;start=i;j=i+1
        while j<len(tokens) and tokens[j].text!=';':j+=1
        if j==len(tokens):raise SyntaxTodo('incomplete-import','Incomplete package/import statement.',tokens[i].start)
        parts=[t.text for t in tokens[i+1:j]]
        if kind=='package':package=''.join(parts)
        else:
            static=bool(parts and parts[0]=='static');parts=parts[1:] if static else parts
            imports.append({'name':''.join(parts),'static':static,'token':tokens[i]})
        ignored.update(range(start,j+1));i=j+1
    return imports,ignored,package

def allocation_scope_issues(tokens):
    """Recognize allocation boundaries, without inferring inherited members.

    Anonymous classes implicitly inherit even when no `extends` token occurs.
    Every `new` is examined, including nested argument/array allocations. An
    allocation head we cannot classify makes the whole file a manual TODO.
    """
    matching={};stack=[]
    for index,token in enumerate(tokens):
        if token.text in {'(','[','{'}:stack.append(index)
        elif token.text in {')',']','}'}:
            opening=stack.pop();matching[opening]=index
    size=len(tokens);issues=[]
    class UnresolvedAllocation(Exception):pass
    def annotations(index):
        while index<size and tokens[index].text=='@':
            index+=1
            if index>=size or tokens[index].kind!='identifier':raise UnresolvedAllocation()
            index+=1
            while index+1<size and tokens[index].text=='.' and tokens[index+1].kind=='identifier':index+=2
            if index<size and tokens[index].text=='(':
                index=matching[index]+1
        return index
    def type_arguments(index):
        if index>=size or tokens[index].text!='<':return index
        depth=0
        while index<size:
            value=tokens[index].text
            if value=='@':index=annotations(index);continue
            if value=='[':index=matching[index]+1;continue
            if value=='<':depth+=1
            elif value=='>':
                depth-=1
                if depth==0:return index+1
            elif value in {';', '=', '{', '}', '(', ')','new'}:raise UnresolvedAllocation()
            index+=1
        raise UnresolvedAllocation()
    for start,token in enumerate(tokens):
        if token.text!='new' or (start>0 and tokens[start-1].text=='::'):continue
        try:
            index=type_arguments(start+1)
            index=annotations(index)
            if index>=size or tokens[index].kind!='identifier':raise UnresolvedAllocation()
            index=type_arguments(index+1)
            while index<size and tokens[index].text=='.':
                index=annotations(index+1)
                if index>=size or tokens[index].kind!='identifier':raise UnresolvedAllocation()
                index=type_arguments(index+1)
            index=annotations(index)
            if index<size and tokens[index].text=='(':
                end=matching[index]
                if end+1<size and tokens[end+1].text=='{':
                    issues.append(('anonymous-class-scope',f'Anonymous allocation at line {token.line} can inherit receiver-name bindings. All constructor rewrites in this file require manual type/scope review.'))
            elif index<size and tokens[index].text=='[':
                # Array initializer braces do not create an inherited scope.
                # The outer loop still examines every allocation inside them.
                while index<size and tokens[index].text=='[':
                    index=annotations(matching[index]+1)
            else:raise UnresolvedAllocation()
        except (UnresolvedAllocation,KeyError,IndexError):
            issues.append(('unresolved-allocation-scope',f'Allocation syntax at line {token.line} could not be classified; inherited/member scope is not safe to infer.'))
    return list(dict.fromkeys(issues))

def name_ambiguities(tokens,imports,ignored):
    issues=allocation_scope_issues(tokens)
    if any(x['static'] or '*' in x['name'] for x in imports):issues.append(('wildcard-or-static-import','Wildcard/static imports can introduce ambiguous symbols.'))
    if any(t.text in {'extends','implements','record','enum'} for i,t in enumerate(tokens) if i not in ignored):issues.append(('inheritance-or-record','Inherited/enum/member/type-variable resolution is outside this recipe.'))
    for imp in imports:
        if imp['name'].split('.')[-1]=='Identifier' and imp['name']!=OFFICIAL_TYPE:issues.append(('conflicting-import','A different Identifier type is imported.'))
        if imp['name'].split('.')[-1]=='net':issues.append(('qualified-root-shadow','An imported type named net can shadow a qualified factory receiver.'))
    for i,t in enumerate(tokens):
        if i in ignored or t.text not in {'Identifier','net'}:continue
        previous=tokens[i-1].text if i else '';next_token=tokens[i+1] if i+1<len(tokens) else None
        nxt=next_token.text if next_token else ''
        if previous in {'class','interface','enum','record'}:
            issues.append(('declared-type-shadow',f'A source-declared type named {t.text} makes factory name resolution ambiguous.'));continue
        # The factory receiver is an expression, whereas `new` names a type.
        # Refuse possible value bindings/type parameters/casts rather than guess.
        # Accept only recognized type/member-use continuations. Everything else
        # includes possible declarations or flow-scoped pattern bindings, e.g.
        # `obj instanceof String Identifier ? new Identifier(...) : null`.
        recognized_use = nxt in {'.','(','::'} or (next_token is not None and next_token.kind=='identifier' and nxt not in {'when','extends','implements','instanceof'})
        if not recognized_use:
            issues.append(('possible-name-shadow',f'Identifier {t.text} may be a value/type binding or unsupported type context.'))
        if t.text=='Identifier' and previous=='<' and nxt not in {'.'}:
            issues.append(('generic-type-context','Generic type/name resolution is not supported.'))
    return list(dict.fromkeys(issues))

def literal_arguments(tokens,open_index):
    depth=0;close=None
    for j in range(open_index,len(tokens)):
        if tokens[j].text=='(':depth+=1
        elif tokens[j].text==')':
            depth-=1
            if depth==0:close=j;break
    if close is None:raise SyntaxTodo('unbalanced-constructor','Constructor argument list is incomplete.',tokens[open_index].start)
    inner=tokens[open_index+1:close]
    if len(inner)==1 and inner[0].kind=='string':literals=[inner[0]]
    elif len(inner)==3 and inner[0].kind=='string' and inner[1].text==',' and inner[2].kind=='string':literals=[inner[0],inner[2]]
    else:return close,None,'Only one or two direct string literals are supported; dynamic expressions need review.'
    values=[]
    for token in literals:
        value=token.text[1:-1]
        if '\\' in value:return close,None,'Escaped identifier literals require manual value/exception-semantics review.'
        values.append(value)
    if len(values)==1:
        parts=values[0].split(':')
        if len(parts)==1:namespace,path='minecraft',parts[0]
        elif len(parts)==2:namespace,path=parts
        else:return close,None,'Identifier literal contains multiple namespace separators.'
    else:namespace,path=values
    if not re.fullmatch(r'[a-z0-9_.-]+',namespace) or not re.fullmatch(r'[a-z0-9_./-]+',path):
        return close,None,'Identifier namespace/path is invalid or outside the conservative nonempty-literal subset.'
    return close,values,None

def scan_file(source,path,allow_edit,global_issues=None):
    diagnostics=[];edits=[];changes=[]
    def todo(code,message,offset=0,line=None):
        if line is None:line=1+len(re.findall(r'\r\n|\r|\n',source[:offset]))
        lines=re.split(r'\r\n|\r|\n',source)
        diagnostics.append({'code':code,'severity':'todo','message':message,'evidence':{'path':path,'line':line,'start_offset':offset,'offset_unit':'Unicode code points','excerpt':lines[line-1][:240] if 0<line<=len(lines) else ''}})
    try:tokens=tokenize(source);imports,ignored,package=imports_and_package(tokens)
    except SyntaxTodo as e:
        todo(e.code,str(e),e.offset);return None,changes,diagnostics
    if package=='net.minecraft' or package.startswith('net.minecraft.'):
        todo('vanilla-package-source','Source inside the vanilla package prevents confirming the official class origin.');return None,changes,diagnostics
    issues=name_ambiguities(tokens,imports,ignored)+list(global_issues or [])
    imported=any(x['name']==OFFICIAL_TYPE and not x['static'] for x in imports)
    # Call-site semantics also changed for existing old `Identifier.of`; do not
    # conflate that nullable API with constructor migration.
    for i,t in enumerate(tokens):
        if t.text=='Identifier' and i+2<len(tokens) and tokens[i+1].text=='.' and tokens[i+2].text=='of':
            todo('existing-of-nullability-change','Existing 1.20.6 Identifier.of may return null; 1.21 of throws. Review tryParse separately; this call is not rewritten.',t.start,t.line)
        if t.text=='Identifier' and i+2<len(tokens) and tokens[i+1].text=='::' and tokens[i+2].text=='new':
            todo('constructor-reference','Constructor references require target functional-interface/type resolution; not rewritten.',t.start,t.line)
    for i,t in enumerate(tokens):
        if t.text!='new':continue
        j=i+1;parts=[]
        while j<len(tokens):
            if tokens[j].kind!='identifier':break
            parts.append(tokens[j].text);j+=1
            if j<len(tokens) and tokens[j].text=='.':j+=1;continue
            break
        name='.'.join(parts)
        if not parts or parts[-1]!='Identifier':
            if i+1<len(tokens) and tokens[i+1].text in {'@','<'} and any(x.text=='Identifier' for x in tokens[i+1:i+20]):todo('annotated-constructor','Annotated/type-argument new-expression is outside the supported subset.',t.start,t.line)
            continue
        if i>0 and tokens[i-1].text=='.':
            todo('qualified-instance-creation','An enclosing-instance new-expression resolves a member type, not the imported vanilla class.',t.start,t.line);continue
        if j>=len(tokens) or tokens[j].text!='(':
            todo('unsupported-new-syntax','Generic/annotated/new-expression syntax is not supported.',t.start,t.line);continue
        if name not in {'Identifier',OFFICIAL_TYPE} or (name=='Identifier' and not imported):
            todo('unresolved-type','The constructor is not an explicitly imported or unshadowed fully-qualified vanilla Identifier.',t.start,t.line);continue
        close,values,error=literal_arguments(tokens,j)
        if close+1<len(tokens) and tokens[close+1].text=='{':
            todo('anonymous-subclass','Factory calls cannot preserve an anonymous Identifier subclass.',t.start,t.line);continue
        if issues:
            for code,message in issues:todo(code,message,t.start,t.line)
            continue
        if error:todo('argument-review',error,t.start,t.line);continue
        if not allow_edit:todo('path-not-permitted','The host has not granted edits to this Java file.',t.start,t.line);continue
        # Delete only the `new` keyword and contiguous spaces/tabs after it.
        # Insert `.of` after the original type spelling. Comments and arguments
        # are copied verbatim; no search/replace is performed inside their text.
        remove_end=t.end
        while remove_end<len(source) and source[remove_end] in ' \t':remove_end+=1
        type_end=tokens[j-1].end
        edits.extend([(t.start,remove_end,''),(type_end,type_end,'.of')])
        changes.append({'path':path,'line':t.line,'start_offset':t.start,'end_offset':tokens[close].end,'before':source[t.start:tokens[close].end],'argument_literals':values,'type_resolution':'explicit-import' if name=='Identifier' else 'fully-qualified','mapping':{'from':'constructor','to':'Identifier.of'},'review_required':True})
    if not edits:return None,changes,diagnostics
    updated=source
    for start,end,replacement in sorted(edits,reverse=True):updated=updated[:start]+replacement+updated[end:]
    try:tokenize(updated)
    except SyntaxTodo as e:
        todo('post-edit-lexical-check','Proposed source did not pass the same restricted lexical checks: '+str(e));return None,[],diagnostics
    return updated,changes,diagnostics

def propose_identifier_factory(files,*,job_id,permitted_paths,source_profile,target_profile):
    snapshot=imported_snapshot(files)
    result={'recipe_id':RECIPE_ID,'status':'blocked','source_profile':source_profile,'target_profile':target_profile,'source_fingerprint':snapshot['fingerprint'],'diagnostics':[],'changes':[],'proposal':None,'references':REFERENCES,'verified_at':'2026-10-06','analysis_method':'restricted Java lexer + delimiter/import/name/argument checks; not full AST/type resolution','full_port_status':'blocked-unvalidated','remaining_port_blockers':[],'validation':{'source_parse':'restricted-checks-only','compile':'not-run','game':'not-run','full_semantic_equivalence':'not-established'}}
    if source_profile!=SOURCE_PROFILE or target_profile!=TARGET_PROFILE:
        result['diagnostics'].append({'code':'unsupported-version-mapping','severity':'todo','message':'Only the documented Fabric/Yarn 1.20.6 -> 1.21 profile is supported. No 26.x or cross-loader mapping is inferred.'})
        result['remaining_port_blockers']=[{'code':'unsupported-version-mapping','message':'Choose a verified supported version/mapping profile.'}];return result
    allow=permitted_set(permitted_paths)
    if not allow<=set(files) or any(PurePosixPath(p).suffix!='.java' for p in allow):raise InputError('This source recipe permits only explicitly selected existing .java paths')
    global_issues=[]
    # Supplied neighboring source files must not hide a competing type behind
    # the same simple/qualified receiver. Missing classpath remains unverified.
    for path,text in sorted(files.items()):
        if PurePosixPath(path).suffix!='.java':continue
        try:
            project_tokens=tokenize(text)
        except SyntaxTodo:
            global_issues.append(('project-scope-unresolved','A supplied Java file could not be lexically inspected; cross-file receiver-name scope remains unresolved.'))
            continue
        for i,token in enumerate(project_tokens[:-1]):
            if token.text in {'class','interface','enum','record'} and project_tokens[i+1].text in {'Identifier','net'}:
                global_issues.append(('project-type-shadow','A supplied source type named Identifier/net prevents establishing the receiver origin for this recipe.'))
    global_issues=list(dict.fromkeys(global_issues))
    replacements={}
    for path,text in sorted(files.items()):
        if PurePosixPath(path).suffix!='.java':continue
        updated,changes,diagnostics=scan_file(text,path,path in allow,global_issues)
        result['diagnostics'].extend(diagnostics);result['changes'].extend(changes)
        if updated is not None:replacements[path]=updated
    result['remaining_port_blockers']=[{'code':d['code'],'message':d['message']} for d in result['diagnostics']]
    result['remaining_port_blockers'].append({'code':'full-port-validation-required','message':'Only selected Identifier constructors are proposed. Build configuration, other source/API changes, compilation and client/server behavior remain unvalidated.'})
    if replacements:
        contract=create_patch(files,replacements,job_id=job_id,permitted_paths=sorted(allow),purpose='One verified Fabric/Yarn source migration: literal Identifier constructors to 1.21 static factories. Review exact spans; no build or whole-mod correctness claim.')
        contract['domain_recipe']={k:result[k] for k in ['recipe_id','source_profile','target_profile','source_fingerprint','diagnostics','changes','references','verified_at','analysis_method','full_port_status','remaining_port_blockers','validation']}
        contract['review_digest']=review_digest(contract);result['proposal']=contract
        result['status']='proposal-with-todos' if result['diagnostics'] else 'source-only-proposal'
    else:result['status']='todo-only' if result['diagnostics'] else 'no-change'
    result['summary']={'safe_call_changes':len(result['changes']),'files_changed':len(replacements),'todo_count':len(result['diagnostics']),'source_unchanged':True}
    return result

def authored_identifier_demo(files,*,job_id):
    from .analyzer import load_directory
    expected,_=load_directory(Path(__file__).resolve().parents[1]/'fixtures/identifier-source')
    if imported_snapshot(files)!=imported_snapshot(expected):raise InputError('Source recipe demo requires the unchanged authored identifier-source fixture')
    return propose_identifier_factory(files,job_id=job_id,permitted_paths=[p for p in expected if p.endswith('.java')],source_profile=SOURCE_PROFILE,target_profile=TARGET_PROFILE)
