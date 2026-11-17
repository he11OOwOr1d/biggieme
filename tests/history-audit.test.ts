import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { Store } from '../server/store.ts';import { chatContext } from '../server/chat-context.ts';import { timeContext } from '../server/time.ts';
function setup(t: any) { const dir=mkdtempSync(join(tmpdir(),'history-audit-'));const s=new Store(dir);s.user('alice','UTC');s.user('bob','UTC');t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s; }
const variants=['Has anything changed since we last talked','Has anything changed since we last spoke?','What did we discuss last time?','What was our previous conversation about?','Has anything changed since our last chat?'];
test('history reference variants recover the actual answered turn through poisoned and preference-only conversations', t => {
 const s=setup(t);const original=s.create('alice');const q=s.add('alice',original.id,'user','Compare twenty AI tools for CS students.');const a=s.add('alice',original.id,'assistant','The comparison included Tool01 through Tool20.');
 const bad=s.create('alice');s.add('alice',bad.id,'user','Has anything changed since our last chat?');s.add('alice',bad.id,'assistant','I cannot find our previous conversation.');
 const pref=s.create('alice');s.add('alice',pref.id,'user','Remember that I like short precise answers');s.add('alice',pref.id,'assistant','I will keep answers short.');
 for(const text of variants){const c=s.create('alice');const id=s.add('alice',c.id,'user',text);const ctx=chatContext(s,'alice',c.id,text,id,timeContext(text,'UTC'));assert.equal(ctx.memory.baselineQuestionId,q,text);assert.equal(ctx.memory.baselineAnswerId,a,text);assert.equal(ctx.baseline?.answer,'The comparison included Tool01 through Tool20.');assert.equal(ctx.messages.at(-1)?.content,text);}
});
test('a long twenty-item baseline remains complete without duplication in same-chat and cross-chat context', t => {
 const s=setup(t);const original=s.create('alice');const question='Compare twenty tools for CS students.';s.add('alice',original.id,'user',question);const answer=Array.from({length:20},(_,i)=>`| ${i+1} | Tool${String(i+1).padStart(2,'0')} | ${'Exact original capabilities and price context. '.repeat(8)} |`).join('\n');const a=s.add('alice',original.id,'assistant',answer);assert.ok(answer.length>7000);
 for(const c of [original,s.create('alice')]){const text='Has anything changed since we last talked';const id=s.add('alice',c.id,'user',text);const ctx=chatContext(s,'alice',c.id,text,id,timeContext(text,'UTC'));assert.equal(ctx.baseline?.answer,answer);assert.equal(ctx.baseline?.complete,true);assert.equal(ctx.history.filter(m=>m.id===a).length,1);assert.ok(ctx.baseline?.answer.includes('Tool20'));}
});
test('latest topical question wins over a preference reply in the same conversation', t => {
 const s=setup(t);const c=s.create('alice');s.add('alice',c.id,'user','Compare CRM vendors.');s.add('alice',c.id,'assistant','CRM comparison.');const q=s.add('alice',c.id,'user','Compare marketing vendors.');const a=s.add('alice',c.id,'assistant','Marketing comparison.');s.add('alice',c.id,'user','Remember that I like short precise answers');s.add('alice',c.id,'assistant','Repeated marketing table.');const next=s.create('alice');const text=variants[0];const id=s.add('alice',next.id,'user',text);const ctx=chatContext(s,'alice',next.id,text,id,timeContext(text,'UTC'));assert.equal(ctx.memory.baselineQuestionId,q);assert.equal(ctx.memory.baselineAnswerId,a);
});
test('diagnostic traces are owned and cascade with conversation deletion', t => {
 const s=setup(t);const c=s.create('alice');const id=s.add('alice',c.id,'assistant','Answer');s.saveTrace('alice',id,{events:[{stage:'history',selectedMessageIds:['fixture']}]});assert.equal(s.messageTrace('alice',id).events[0].stage,'history');assert.equal(s.messageTrace('bob',id),undefined);s.remove('alice',c.id);assert.equal(s.messageTrace('alice',id),undefined);assert.equal(s.db.prepare('SELECT count(*) AS n FROM message_traces').get()!.n,0);
});

test('plain last-conversation recall uses the saved question and answer link without a model call', async t => {
 const {runChat}=await import('../server/agent.ts');const {SearchService}=await import('../server/search.ts');const {MockLanguageModelV4}=await import('ai/test');
 const s=setup(t);const c=s.create('alice');const question='Compare twenty tools for CS students.';s.add('alice',c.id,'user',question);const a=s.add('alice',c.id,'assistant','Tool01 through Tool20.');const next=s.create('alice');const model=new MockLanguageModelV4({doStream:async()=>{throw new Error('A database recall must not require generation');}});
 const r=await runChat({store:s,search:new SearchService(''),user:'alice',session:next.id,text:'What did we discuss last time?',provider:'compatible',model,timezone:'UTC',signal:new AbortController().signal,emit:()=>{}});
 assert.ok(r.text.includes(question));assert.ok(r.text.includes(a));assert.equal(r.metrics.inputTokens,0);const saved=s.messages('alice',next.id).at(-1)!;assert.ok(s.messageTrace('alice',saved.id).events.some((e:any)=>e.stage==='direct_history_reply'));
});

test('an unverified research response cannot replace the original answered topic', t => {
 const s=setup(t);const c=s.create('alice');const q=s.add('alice',c.id,'user','Compare student coding tools.');const a=s.add('alice',c.id,'assistant','Original tool comparison.');
 const retry=s.create('alice');s.add('alice',retry.id,'user',variants[0]);const failed=s.add('alice',retry.id,'assistant','Fresh web research did not succeed.');s.saveTrace('alice',failed,{version:1,outcome:'unverified',events:[]});
 const next=s.create('alice');const id=s.add('alice',next.id,'user',variants[0]);const ctx=chatContext(s,'alice',next.id,variants[0],id,timeContext(variants[0],'UTC'));assert.equal(ctx.baseline?.questionId,q);assert.equal(ctx.baseline?.answerId,a);
});
