const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const { installWebGlobals, evaluateUserscript } = require('./helpers/userscript.cjs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../gohigherlevel.user.js'), 'utf8');
const L = '3QixdLNutDXye95tTBK0', origin = 'https://services.leadconnectorhq.com';
const contact = { id:'c1', locationId:L, firstName:'Ada', lastName:'Lee', phone:'+12345678901', assignedTo:'owner1' };
const number = { phoneNumber:'+19876543210', capabilities:{sms:true}, linkedUser:'user1' };
function harness(t) {
  const dom = new JSDOM('<body><textarea id="conv-composer-textarea-input">untouched</textarea></body>', { url:`https://go.pertamaproperty.com/v2/location/${L}/contacts/detail/c1`, runScripts:'outside-only', virtualConsole:new VirtualConsole() });
  const w = dom.window; t.after(() => w.close());
  installWebGlobals(w);
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
      else throw new Error('Unexpected SMS read');
    }
    return new Response(JSON.stringify(data));
  };
  const e = evaluateUserscript(w, source);
  const token = `x.${Buffer.from(JSON.stringify({user_id:'user1',sub:'user1',locations:[L],exp:Date.now()/1000+3600})).toString('base64url')}.x`;
  e(`captureReadHeaders('${origin}/contacts/c1', ${JSON.stringify({'token-id':token})}); workflow.startingContact='c1'; workflow.approvedActionContext={contact:'c1',route:stageRouteRevision,user:currentUserId,epoch:contactReadEpoch,ownedEpoch:0,ownedWritesPending:0,stopSaves:false,contactRecord:${JSON.stringify(contact)},actions:{sms:true},sms:{from:'${number.phoneNumber}',to:'${contact.phone}',message:'Hello'}};`);
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
for (const change of ['workflow.approvedActionContext=null','workflow.approvedActionContext.actions.sms=false','workflow.approvedActionContext.sms.from=""','workflow.approvedActionContext.sms.to="+19999999999"','workflow.approvedActionContext.sms.message=" "','workflow.pendingSave="unresolved"']) test(`send refuses ${change}`,async t=>{
  const h=harness(t); h.e(change); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);
});
for (const isSpam of [true,null,undefined]) test(`spam ${isSpam} blocks send`,async t=>{
  const h=harness(t); h.hook(c=>c.path.includes('/spam/')?{isSpam}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
});
test('exact send succeeds on durable acknowledgment without history readback or resend',async t=>{
  const h=harness(t); await h.send(); const send=h.calls.find(c=>c.path==='/conversations/messages');
  assert.deepEqual(send.body,{contactId:'c1',locationId:L,message:'Hello',fromNumber:number.phoneNumber,toNumber:contact.phone,type:'SMS',channel:'sms',fromOneToOneConversation:true,attachments:[]});
  assert.equal(h.checkpoint().pendingSave,'');
  assert.match(h.checkpoint().completed.join(' '),/SMS message m1; conversation v1: accepted by CRM; delivery not confirmed/);
  assert.equal(h.calls.some(c=>c.path.startsWith('/f1/')),false);
  assert.match(h.w.document.getElementById('pertama-task-notice').textContent,/accepted.*delivery not confirmed/i);
  assert.equal(h.w.document.querySelector('textarea').value,'untouched');
  await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
for (const patch of [{phone:'+12222222222'}]) test('fresh contact change blocks send '+JSON.stringify(patch),async t=>{
  const h=harness(t); h.hook(c=>c.path==='/contacts/c1'?{contact:{...contact,...patch}}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);
});
test('concurrent-save approval keeps the preflight owner but still rechecks the SMS recipient', async t => {
  const h = harness(t);
  h.hook(c => c.path === '/contacts/c1' ? { contact: { ...contact, assignedTo: 'other' } } : undefined);
  await h.send();
  assert.equal(h.calls.filter(c => c.path === '/conversations/messages').length, 1);
});

test('a concurrent-save approval never permits a changed SMS phone number', async t => {
  const h = harness(t);
  h.hook(c => c.path === '/contacts/c1' ? { contact: { ...contact, phone: '+12222222222' } } : undefined);
  await assert.rejects(h.send());
  assert.equal(h.calls.filter(c => c.init.method === 'POST').length, 0);
});

test('sender removed blocks send',async t=>{const h=harness(t); h.hook(c=>c.path.startsWith('/phone-system/')?{numbers:[],total:0}:undefined); await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.init.method==='POST').length,0);});
for (const response of [{}, {conversationId:'v1'}, {messageId:'m1'}, {conversationId:'bad/id',messageId:'m1'}, {conversationId:'v1',messageId:'bad/id'}]) test('malformed ack leaves unknown journal',async t=>{
  const h=harness(t); h.hook(c=>c.path==='/conversations/messages'?response:undefined); await assert.rejects(h.send()); assert.match(h.checkpoint().pendingSave,/Hello/); await assert.rejects(h.send());
});
for (const change of ['route', 'auth']) test(`${change} changed during send preserves acknowledgment and blocks continuation`,async t=>{
  const h=harness(t); h.hook(c=>{if(c.path==='/conversations/messages') {
    if(change === 'route') h.w.history.pushState({},'', '/away'); else h.e('rejectCrmAuthorization()');
  }});
  await assert.rejects(h.send());
  assert.match(h.checkpoint().completed.join(' '),/m1.*accepted by CRM/);
  assert.match(h.checkpoint().pendingSave,/m1/);
  assert.equal(h.calls.filter(c=>c.path.startsWith('/f1/')).length,0);
  await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
test('storage failure prevents send and retry',async t=>{
  const h=harness(t); h.e('Storage.prototype.setItem=function(){throw new Error("storage full")}');
  await assert.rejects(h.send());
  assert.equal(h.e('workflow.pendingSave'), `SMS from ${number.phoneNumber} to ${contact.phone}; message: Hello; acceptance not yet confirmed`);
  assert.equal(h.e('workflow.completed.length'), 0);
  assert.equal(h.checkpoint(), null);
  await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
});
for (const status of [401,403,500]) test(`inventory HTTP ${status} sanitized`,async t=>{
  const h=harness(t); h.hook(c=>c.path.startsWith('/phone-system/')?new Response('secret',{status}):undefined); await assert.rejects(h.prep(),e=>!e.message.includes('secret')); if(status!==500)assert.equal(h.e('currentUserId'),null);
  assert.ok(!JSON.stringify(h.w.pertamaRequestDiagnostics).includes(number.phoneNumber));
});
test('unknown SMS send outcome remains blocked and redacted',async t=>{
  const h=harness(t); h.hook(c=>{if(c.path==='/conversations/messages')throw new Error('secret-token-and-body');});
  await assert.rejects(h.send(),e=>!e.message.includes('secret')); assert.ok(h.checkpoint().pendingSave); await assert.rejects(h.send());
  assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
for (const status of [401,403,500]) test(`send HTTP ${status} retains the intent and cannot resend`,async t=>{
  const h=harness(t);
  h.hook(c=>c.path==='/conversations/messages'?new Response('private-payload',{status}):undefined);
  await assert.rejects(h.send(),error=>!error.message.includes('private-payload'));
  assert.match(h.checkpoint().pendingSave,/acceptance not yet confirmed/);
  assert.equal(h.checkpoint().completed.length,0);
  await assert.rejects(h.send());
  assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
});
for (const path of ['/contacts/c1', '/phone-system/numbers/v2/location/' + L, '/conversations/messages/drafts/' + L + '/contacts/c1',
  '/conversations/messages/spam/v2', '/conversations/messages']) {
  test(`malformed SMS JSON fails closed without replay: ${path}`, async t => {
    const h = harness(t);
    h.hook(c => c.path === path ? new Response('{private-payload') : undefined);
    await assert.rejects(h.send(), error => !error.message.includes('private-payload'));
    const sends = h.calls.filter(c => c.path === '/conversations/messages').length;
    assert.equal(sends, path === '/conversations/messages' ? 1 : 0);
    await assert.rejects(h.send());
    assert.equal(h.calls.filter(c => c.path === '/conversations/messages').length, sends);
    assert.doesNotMatch(JSON.stringify(h.w.pertamaRequestDiagnostics), /private-payload/);
  });
}
test('durable pre-send intent contains exact consent; ack storage failure cannot resend',async t=>{
  const h=harness(t); let intent;
  h.hook(c=>{if(c.path==='/conversations/messages'){
    intent = h.checkpoint();
    assert.equal(intent.pendingSave, `SMS from ${number.phoneNumber} to ${contact.phone}; message: Hello; acceptance not yet confirmed`);
    assert.deepEqual(intent.completed, []);
    assert.deepEqual(intent.pendingActions, {});
    h.e('Storage.prototype.setItem=function(){throw new Error("storage full")}');
  }});
  await assert.rejects(h.send());
  assert.equal(h.e('workflow.pendingSave'), 'SMS message m1; conversation v1: accepted; workflow continuation not yet approved');
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(workflow.completed)')), ['SMS message m1; conversation v1: accepted by CRM; delivery not confirmed.']);
  assert.deepEqual(h.checkpoint(), intent);
  await assert.rejects(h.send()); assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,1);
  assert.deepEqual(h.calls.find(c=>c.path==='/conversations/messages').body, {contactId:'c1',locationId:L,message:'Hello',fromNumber:number.phoneNumber,toNumber:contact.phone,type:'SMS',channel:'sms',fromOneToOneConversation:true,attachments:[]});
});
test('final SMS clear failure restores the unresolved accepted summary without resend', async t => {
  const h = harness(t), original = h.w.Storage.prototype.setItem;
  let accepted;
  h.w.Storage.prototype.setItem = function (key, value) {
    if (key.includes('unfinished')) {
      const snapshot = JSON.parse(value);
      if (!snapshot.pendingSave) throw new Error('Storage refused');
      if (snapshot.completed.length) accepted = snapshot;
    }
    return original.call(this, key, value);
  };
  await assert.rejects(h.send());
  assert.equal(h.e('workflow.pendingSave'), 'SMS message m1; conversation v1: accepted; workflow continuation not yet approved');
  assert.deepEqual(h.checkpoint(), accepted);
  assert.deepEqual(JSON.parse(h.e('JSON.stringify(workflow.completed)')), accepted.completed);
  await assert.rejects(h.send());
  assert.equal(h.calls.filter(c => c.path === '/conversations/messages').length, 1);
});
test('timeout aborts send once without losing intent',async t=>{
  const h=harness(t); let abort;
  const timer=h.w.setTimeout.bind(h.w);
  h.w.setTimeout=(fn,ms,...args)=>ms===30000?(abort=fn,timer(()=>{},60000)):timer(fn,ms,...args);
  h.hook(c=>c.path==='/conversations/messages'?new Promise((resolve,reject)=>c.init.signal.addEventListener('abort',()=>reject(new DOMException('secret','AbortError')))):undefined);
  const pending=h.send(); await h.flush(); abort(); await assert.rejects(pending,/Timed out/); assert.ok(h.checkpoint().pendingSave); await assert.rejects(h.send());
});
test('changed route during spam check prevents sending',async t=>{
  const h=harness(t); h.hook(c=>{if(c.path==='/conversations/messages/spam/v2')h.w.history.pushState({},'', '/away');}); await assert.rejects(h.send());
  assert.equal(h.calls.filter(c=>c.path==='/conversations/messages').length,0);
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
