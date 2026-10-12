const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0', origin = 'https://services.leadconnectorhq.com';
const contact = { id:'c1', locationId:L, firstName:'Ada', lastName:'Lee', phone:'+12345678901', assignedTo:'owner1' };
const number = { phoneNumber:'+19876543210', capabilities:{sms:true}, linkedUser:'user1' };
function harness(t) {
  const dom = new JSDOM('<body><textarea id="conv-composer-textarea-input">untouched</textarea></body>', { url:`https://go.pertamaproperty.com/v2/location/${L}/contacts/detail/c1`, runScripts:'outside-only', virtualConsole:new VirtualConsole() });
  const w = dom.window; t.after(() => w.close());
  for (const k of ['Request','Response','Headers','AbortController']) w[k] = globalThis[k];
  const calls = []; let hook = () => {};
  w.fetch = async (url, init) => {
    const c = {url, path:new URL(url).pathname, init, body:init.body && JSON.parse(init.body)}; calls.push(c);
    let data = await hook(c);
    if (data instanceof Response) return data;
    if (data === undefined) {
      if (c.path === '/contacts/c1') data = {contact};
      else if (c.path.startsWith('/phone-system/')) data = {numbers:[number],total:1};
      else if (c.path.includes('/drafts/')) data = {drafts:[{unknown:'native saved draft'}]};
      else if (c.path.includes('/spam/')) data = {isSpam:false};
      else if (init.method === 'POST') data = {conversationId:'v1',messageId:'m1'};
      else data = {messages:{messages:[{id:'m1',conversationId:'v1',contactId:'c1',locationId:L,type:2,direction:'outbound',status:'pending',body:'Hello',meta:{from:number.phoneNumber,to:contact.phone}}]}};
    }
    return new Response(JSON.stringify(data));
  };
  w.eval(source.replace(/\}\)\(\);\s*$/, 'globalThis.__sms = { evaluate(code) { return eval(code); } };\n})();'));
  const e = code => w.__sms.evaluate(code);
  const token = `x.${Buffer.from(JSON.stringify({user_id:'user1',sub:'user1',locations:[L],exp:Date.now()/1000+3600})).toString('base64url')}.x`;
  e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({'token-id':token})}); startingContact='c1'; approvedActionContext={contact:'c1',route:stageRouteRevision,user:currentUserId,epoch:contactReadEpoch,contactRecord:${JSON.stringify(contact)},actions:{sms:true},sms:{from:'${number.phoneNumber}',to:'${contact.phone}',message:'Hello'}};`);
  return {w,e,calls,hook:fn => {hook=fn;}, prep:()=>e('prepareSmsApi()'), send:()=>e('sendSmsApi()'), checkpoint:()=>JSON.parse(w.localStorage.getItem(`pertama:no-answer:unfinished:${L}:c1`)), flush:()=>new Promise(r=>setImmediate(r))};
}
test('sole CRM-user number becomes the SMS sender without a settings choice', async t => {
  const h = harness(t);
  h.hook(c => c.path.startsWith('/phone-system/') ? { numbers: [
    { ...number, linkedUser: 'user1' },
    { ...number, phoneNumber: '+19876543211', linkedUser: 'other', isDefaultNumber: true },
  ], total: 2 } : undefined);
  assert.equal((await h.prep()).from, number.phoneNumber);
});
test('multiple user-linked numbers require a saved settings choice', async t => {
  const h = harness(t);
  h.hook(c => c.path.startsWith('/phone-system/') ? { numbers: [
    { ...number, linkedUser: 'user1' },
    { ...number, phoneNumber: '+19876543211', linkedUser: 'user1' },
  ], total: 2 } : undefined);
  assert.equal((await h.prep()).from, null);
  h.e("settings.smsFrom = '+19876543211'");
  assert.equal((await h.prep()).from, '+19876543211');
});
test('settings saves a selected user-linked number when several are available', async t => {
  const h = harness(t);
  h.w.HTMLDialogElement.prototype.showModal = function () {};
  h.w.HTMLDialogElement.prototype.close = function () {};
  h.hook(c => c.path.startsWith('/phone-system/') ? { numbers: [number,
    { ...number, phoneNumber: '+19876543211' }], total: 2 } : undefined);
  h.e('openSettings()'); await h.flush();
  const dialog = h.w.document.getElementById('pertama-settings');
  const select = dialog.querySelector('[name="smsFrom"]');
  assert.equal(select.disabled, false);
  assert.deepEqual([...select.options].map(item => item.value), ['', number.phoneNumber, '+19876543211']);
  select.value = '+19876543211';
  dialog.querySelector('form').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(JSON.parse(h.w.localStorage.getItem(`pertama:settings:${L}`)).smsFrom, '+19876543211');
  assert.equal((await h.prep()).from, '+19876543211');
});
test('API prep returns safe explicit choices and count without touching native drafts or composer', async t => {
  const h=harness(t), p=await h.prep();
  assert.equal(p.to,contact.phone); assert.equal(p.contact.id,'c1'); assert.equal(p.savedDraftCount,1);
  assert.equal(p.fromNumbers.length,1); assert.equal(p.fromNumbers[0].number,number.phoneNumber);
  assert.equal(p.from,number.phoneNumber); assert.equal(p.drafts,undefined);
  assert.equal(h.w.document.querySelector('textarea').value,'untouched');
  assert.ok(h.calls.every(c=>c.init.method==='GET' && c.init.cache==='no-store' && c.init.redirect==='error'));
  assert.match(h.calls[1].url,/includeRcsSenderIds=true$/);
  assert.equal(h.calls[1].init.headers.version,'2021-07-28');
});
for (const data of [{}, {numbers:[number]}, {numbers:[number],total:2}, {numbers:[number,number],total:2}, {numbers:[{...number,phoneNumber:'123'}],total:1}, {numbers:[{...number,linkedUser:{id:'owner1'}}],total:1}]) test(`reject malformed inventory ${JSON.stringify(data)}`, async t=>{
  const h=harness(t); h.hook(c=>c.path.startsWith('/phone-system/')?data:undefined); await assert.rejects(h.prep());
});
test('only conservative eligible SMS numbers; no RCS inference', async t=>{
  const h=harness(t); const numbers=[number,...[{capabilities:{}},{linkedUser:'other'},{isDisabled:true},{status:'disabled'}].map((patch,i)=>({...number,phoneNumber:`+1987654322${i}`,...patch}))];
  h.hook(c=>c.path.startsWith('/phone-system/')?{numbers,total:numbers.length,rcsSenderIds:['rcs']}:undefined);
  assert.equal((await h.prep()).fromNumbers.length,1);
});
for (const change of ['approvedActionContext=null','approvedActionContext.actions.sms=false','approvedActionContext.sms.from=""','approvedActionContext.sms.to="+19999999999"','approvedActionContext.sms.message=" "','pendingSave="unresolved"']) test(`send refuses ${change}`,async t=>{
  const h=harness(t); h.e(change); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);
});
for (const isSpam of [true,null,undefined]) test(`spam ${isSpam} blocks send`,async t=>{
  const h=harness(t); h.hook(c=>c.path.includes('/spam/')?{isSpam}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
});
test('exact send, durable ack then verified pending status; no resend',async t=>{
  const h=harness(t); await h.send(); const send=h.calls.find(c=>c.path==='/conversations/messages');
  assert.deepEqual(send.body,{contactId:'c1',locationId:L,message:'Hello',fromNumber:number.phoneNumber,toNumber:contact.phone,type:'SMS',channel:'sms',fromOneToOneConversation:true,attachments:[]});
  assert.equal(h.checkpoint().pendingSave,''); assert.match(h.checkpoint().completed.join(' '),/pending/); assert.doesNotMatch(h.checkpoint().completed.join(' '),/delivered/);
  await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
for (const status of ['failed', 'undelivered']) test(`terminal SMS ${status} stops workflow and retains known outcome`, async t => {
  const h = harness(t);
  h.hook(c => c.path.startsWith('/f1/') ? { messages: { messages: [{ id: 'm1', conversationId: 'v1', contactId: 'c1', locationId: L,
    type: 2, direction: 'outbound', status, body: 'Hello', meta: { from: number.phoneNumber, to: contact.phone } }] } } : undefined);
  await assert.rejects(h.send(), new RegExp(status));
  assert.match(h.checkpoint().completed.join(' '), new RegExp(`status ${status}`));
  await assert.rejects(h.send());
  assert.equal(h.calls.filter(c => c.path === '/conversations/messages').length, 1);
});
for (const patch of [{id:'wrong'},{conversationId:'wrong'},{contactId:'wrong'},{locationId:'wrong'},{type:1},{direction:'inbound'},{body:'wrong'},{meta:{from:'+11111111111',to:contact.phone}},{meta:{from:number.phoneNumber,to:'+11111111111'}}]) test(`mismatched history retains ack ${JSON.stringify(patch)}`,async t=>{
  const h=harness(t); h.hook(c=>c.path.startsWith('/f1/')?{messages:{messages:[{id:'m1',conversationId:'v1',contactId:'c1',locationId:L,type:2,direction:'outbound',status:'sent',body:'Hello',meta:{from:number.phoneNumber,to:contact.phone},...patch}]}}:undefined);
  await assert.rejects(h.send()); assert.match(h.checkpoint().pendingSave,/m1/); await assert.rejects(h.send());
});
for (const patch of [{phone:'+12222222222'},{assignedTo:'other'}]) test('fresh contact change blocks send '+JSON.stringify(patch),async t=>{
  const h=harness(t); h.hook(c=>c.path==='/contacts/c1'?{contact:{...contact,...patch}}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);
});
test('sender removed blocks send',async t=>{const h=harness(t); h.hook(c=>c.path.startsWith('/phone-system/')?{numbers:[],total:0}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);});
for (const response of [{}, {conversationId:'v1',messageId:'bad/id'}]) test('malformed ack leaves unknown journal',async t=>{
  const h=harness(t); h.hook(c=>c.path==='/conversations/messages'?response:undefined); await assert.rejects(h.send()); assert.match(h.checkpoint().pendingSave,/Hello/); await assert.rejects(h.send());
});
test('route changed during send preserves acknowledgment',async t=>{
  const h=harness(t); h.hook(c=>{if(c.path==='/conversations/messages')h.w.history.pushState({},'', '/away');}); await assert.rejects(h.send()); assert.match(h.checkpoint().pendingSave,/m1/); assert.equal(h.calls.filter(c=>c.path.startsWith('/f1/')).length,0);
});
test('storage failure prevents send and retry',async t=>{
  const h=harness(t); h.e('Storage.prototype.setItem=function(){throw new Error("storage full")}'); await assert.rejects(h.send()); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
});
for (const status of [401,403,500]) test(`inventory HTTP ${status} sanitized`,async t=>{
  const h=harness(t); h.hook(c=>c.path.startsWith('/phone-system/')?new Response('secret',{status}):undefined); await assert.rejects(h.prep(),e=>!e.message.includes('secret')); if(status!==500)assert.equal(h.e('currentUserId'),null);
  assert.ok(!JSON.stringify(h.w.pertamaRequestDiagnostics).includes(number.phoneNumber));
});
for (const operation of ['/conversations/messages','/f1/conversations/v1/messages']) test(`unknown outcome at ${operation} remains blocked and redacted`,async t=>{
  const h=harness(t); h.hook(c=>{if(c.path===operation)throw new Error('secret-token-and-body');});
  await assert.rejects(h.send(),e=>!e.message.includes('secret')); assert.ok(h.checkpoint().pendingSave); await assert.rejects(h.send());
  assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
for (const path of ['/contacts/c1', '/phone-system/numbers/v2/location/' + L, '/conversations/messages/drafts/' + L + '/contacts/c1',
  '/conversations/messages/spam/v2', '/conversations/messages', '/f1/conversations/v1/messages']) {
  test(`malformed SMS JSON fails closed without replay: ${path}`, async t => {
    const h = harness(t);
    h.hook(c => c.path === path ? new Response('{private-payload') : undefined);
    await assert.rejects(h.send(), error => !error.message.includes('private-payload'));
    const sends = h.calls.filter(c => c.path === '/conversations/messages').length;
    assert.equal(sends, ['/conversations/messages', '/f1/conversations/v1/messages'].includes(path) ? 1 : 0);
    await assert.rejects(h.send());
    assert.equal(h.calls.filter(c => c.path === '/conversations/messages').length, sends);
    assert.doesNotMatch(JSON.stringify(h.w.pertamaRequestDiagnostics), /private-payload/);
  });
}
test('durable pre-send intent contains exact consent; ack storage failure cannot resend',async t=>{
  const h=harness(t); h.hook(c=>{if(c.path==='/conversations/messages'){
    const journal=h.checkpoint().pendingSave; for(const value of [number.phoneNumber,contact.phone,'Hello'])assert.ok(journal.includes(value));
    h.e('Storage.prototype.setItem=function(){throw new Error("storage full")}');
  }});
  await assert.rejects(h.send()); assert.match(h.e('pendingSave'),/m1/); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
test('timeout aborts send once without losing intent',async t=>{
  const h=harness(t); let abort;
  const timer=h.w.setTimeout.bind(h.w);
  h.w.setTimeout=(fn,ms,...args)=>ms===30000?(abort=fn,timer(()=>{},60000)):timer(fn,ms,...args);
  h.hook(c=>c.path==='/conversations/messages'?new Promise((resolve,reject)=>c.init.signal.addEventListener('abort',()=>reject(new DOMException('secret','AbortError')))):undefined);
  const pending=h.send(); await h.flush(); abort(); await assert.rejects(pending,/Timed out/); assert.ok(h.checkpoint().pendingSave); await assert.rejects(h.send());
});
for(const where of ['/conversations/messages/spam/v2','/f1/conversations/v1/messages']) test(`changed route while ${where} pending`,async t=>{
  const h=harness(t); h.hook(c=>{if(c.path===where)h.w.history.pushState({},'', '/away');}); await assert.rejects(h.send());
  if(where.includes('/spam/'))assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
  else {assert.equal(h.checkpoint().pendingSave,'');assert.match(h.checkpoint().completed.join(' '),/status pending/);}
});
for(const data of [{drafts:null},{drafts:{}}]) test('malformed draft array fails closed',async t=>{
  const h=harness(t);h.hook(c=>c.path.includes('/drafts/')?data:undefined);await assert.rejects(h.prep());
});
test('default and unassigned numbers cannot replace the CRM-user number',async t=>{
  const h=harness(t);h.hook(c=>c.path.startsWith('/phone-system/')?{numbers:[{...number,isDefaultNumber:true,linkedUser:'other'},{...number,phoneNumber:'+19876543211',linkedUser:null},{...number,phoneNumber:'+19876543212',linkedUser:'user1'}],total:3}:undefined);
  const p=await h.prep();assert.equal(p.fromNumbers.length,1);assert.equal(p.from,'+19876543212');
});
test('prep drains outstanding draft read after inventory failure',async t=>{
  const h=harness(t); let release,settled=false;
  h.hook(c=>c.path.includes('/drafts/')?new Promise(r=>{release=r;}):c.path.startsWith('/phone-system/')?new Response('{}',{status:500}):undefined);
  const p=h.prep().then(()=>{settled=true;},()=>{settled=true;}); await h.flush(); assert.equal(settled,false); release({drafts:[]}); await p; assert.equal(settled,true);
});
for(const change of ['contactReadEpoch++','currentUserId="other"','liveReadHeaders=null','history.pushState({},"","/away")']) test(`prep rejects pending context change ${change}`,async t=>{
  const h=harness(t); h.hook(c=>{if(c.path.includes('/drafts/'))h.e(change);}); await assert.rejects(h.prep());
});
