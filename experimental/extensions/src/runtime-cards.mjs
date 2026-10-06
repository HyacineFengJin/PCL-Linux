import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson, fail, freeze } from './json.mjs';

import { WORKFLOWS, readRuntimeSummaries } from './runtime-summary.mjs';
export { RUNTIME_CARD_SCHEMA_VERSION, WORKFLOWS, JOB_STATES, ARTIFACT_STATES, BLOCKED_REASONS, readRuntimeSummaries } from './runtime-summary.mjs';

const STATUS_LABELS = freeze({queued:'等待开始',running:'流程运行中',completed:'流程已结束',cancelled:'已取消',failed:'流程失败',interrupted:'需要恢复检查'});
const ARTIFACT_LABELS = freeze({none:'暂无草稿产物',draft_ready:'草稿产物已生成',review_blocked:'草稿需要人工复核'});
const BLOCK_LABELS = freeze({build_execution_disabled:'生成代码的构建执行尚未开放',live_model_calls_disabled:'真实模型调用尚未开放',review_required:'权限、目标版本或兼容性仍需人工复核',runtime_error:'流程遇到错误，查看宿主状态页'});


// Built-in host UI: deliberately separate from third-party manifest capabilities.
// Accepting this projection grants no extension access to runtime job objects.
export class RuntimeCardHost {
  #summaries=[];
  #seen=new Map();
  #refresh=0;
  #pending=null;
  #fresh=false;
  #actions=new Map();
  #clock;
  constructor({clock=Date.now}={}){this.#clock=clock;}

  beginRefresh(){
    this.#pending=++this.#refresh;this.#fresh=false;this.#actions.clear();
    return this.#pending;
  }

  acceptSummaries(refreshId,source){
    if(refreshId!==this.#pending || this.#pending===null)
      fail('RUNTIME_STALE_REFRESH','A newer refresh owns these status cards.');
    this.#pending=null;
    const summaries=readRuntimeSummaries(source);
    // Keep high-water marks beyond selection changes and empty snapshots. Do
    // not evict old identities, which would silently reopen a replay window.
    const history=new Map(this.#seen);
    for(const next of summaries){
      const prior=history.get(next.jobId);
      const digest=createHash('sha256').update(canonicalJson(next)).digest('hex');
      if(prior && prior.workflow!==next.workflow)
        fail('RUNTIME_IDENTITY_CHANGED','A known job cannot change its workflow identity.');
      if(prior && (next.revision<prior.revision || (next.revision===prior.revision && digest!==prior.digest)))
        fail('RUNTIME_STALE_REVISION','A job summary revision went backward or changed without a new revision.');
      if(!prior&&history.size>=64)
        fail('RUNTIME_HISTORY_LIMIT','This host session reached its bounded job-identity history limit.');
      history.set(next.jobId,{revision:next.revision,workflow:next.workflow,digest});
    }
    this.#seen=history;this.#summaries=summaries;this.#fresh=true;
    return this.cards();
  }

  cards(){
    return freeze(WORKFLOWS.map(workflow=>{
      const s=this.#summaries.find(s=>s.workflow===workflow);
      return {
        source:'host-runtime-status',workflow,
        title:workflow==='maker'?'Mod Maker · 制作草稿':'Mod Porter · 移植评估',
        summary:workflow==='maker'?'从描述生成受限模板与素材草稿':'检查源代码与目标版本的迁移边界',
        statusLabel:s?STATUS_LABELS[s.status]:'尚未选择任务',
        artifactLabel:s?ARTIFACT_LABELS[s.artifactState]:'暂无草稿产物',
        blockedLabel:s?.blockedReason?BLOCK_LABELS[s.blockedReason]:null,
        verificationLabel:'尚未构建或游戏内验证',
        caution:'工作流结束不等于模组可以使用',
        updatedAt:s?.updatedAt??null,
        fresh:this.#fresh,
        freshnessLabel:this.#fresh?'只读宿主摘要':this.#pending!==null?'正在刷新，先前摘要暂不可操作':'摘要待刷新，先前摘要暂不可操作',
        action:{id:'open-job-status',label:'查看任务状态',enabled:!!s&&this.#fresh},
      };
    }));
  }

  prepareOpen(workflow){
    if(!WORKFLOWS.includes(workflow))fail('RUNTIME_WORKFLOW','Choose a known host workflow.');
    const s=this.#summaries.find(s=>s.workflow===workflow);
    if(!s||!this.#fresh)fail('RUNTIME_UNAVAILABLE','A fresh selected-job summary is required.');
    for(const [token,a] of this.#actions)if(a.expiresAt<=this.#clock())this.#actions.delete(token);
    if(this.#actions.size>=16)fail('RUNTIME_PENDING_LIMIT','Too many pending status-page requests.');
    const token=randomUUID();
    this.#actions.set(token,{workflow,jobId:s.jobId,revision:s.revision,refresh:this.#refresh,expiresAt:this.#clock()+30_000});
    return freeze({token,label:'查看任务状态'});
  }

  cancelOpen(token){return this.#actions.delete(token);}

  commitOpen(token){
    const a=this.#actions.get(token);this.#actions.delete(token);
    if(!a||a.expiresAt<=this.#clock())fail('RUNTIME_ACTION_TOKEN','Status-page request expired or was already consumed.');
    const s=this.#summaries.find(s=>s.workflow===a.workflow);
    if(!this.#fresh||a.refresh!==this.#refresh||s?.jobId!==a.jobId||s?.revision!==a.revision)
      fail('RUNTIME_STALE_ACTION','The job selection or status changed.');
    return freeze({kind:'open-job-status',workflow:a.workflow,jobId:a.jobId,revision:a.revision});
  }
}

/** Rendering strings are host labels + whitelisted timestamps, always text. */
export function renderRuntimeCards(document,container,cards,onOpen){
  container.replaceChildren(...cards.map(card=>{
    const article=document.createElement('article');article.className='runtime-card';
    const add=(tag,text,className)=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;article.append(node);};
    add('p','宿主工具 · 只读状态 / Host-owned · read-only','runtime-origin');
    add('h3',card.title);add('p',card.summary);add('p',`${card.statusLabel} · ${card.artifactLabel}`,'runtime-state');
    if(card.blockedLabel)add('p',card.blockedLabel,'runtime-blocked');
    add('p',`${card.verificationLabel}。${card.caution}`,'runtime-verification');
    add('p',card.freshnessLabel,'runtime-freshness');
    if(card.updatedAt)add('p',`更新于 ${card.updatedAt}`,'runtime-updated');
    const button=document.createElement('button');button.type='button';button.textContent=card.action.label;button.disabled=!card.action.enabled;
    button.addEventListener('click',()=>{if(!button.disabled)onOpen(card.workflow);});article.append(button);
    return article;
  }));
}
