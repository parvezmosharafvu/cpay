// Admin parity: member invitations, manual statement register and safe gateway toggles.
// No money is sent or received by these screens; all mutations are guarded
// by the server and each form sends a single non-retried request.
(function () {
  'use strict';
  const sb = window.supabaseClient;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dollar = (n) => '$' + Number(n || 0).toFixed(2);
  const showError = (host, e) => { const x = host.querySelector('[role="alert"]'); if (x) x.textContent = e?.message || 'Request could not be confirmed.'; };
  let statementBusy = false, inviteBusy = false, methodBusy = false;
  let statementRows = [];
  let memberRows = [];
  const navTo = (tab) => {
    const n = document.querySelector('.side .navi[data-tab="' + tab + '"]');
    if (n) n.click();
  };

  function mountInvite() {
    const host = document.getElementById('people');
    if (!host || host.querySelector('#adminInviteCard') || host.querySelector('[data-panel-retry]')) return;
    const panel = document.createElement('div');
    panel.className = 'card';
    panel.id = 'adminInviteCard';
    panel.innerHTML = '<div class="card-head"><h3>Invite a new member</h3><p class="faint">Email invitation only. New members stay pending until you approve them.</p></div>'
      + '<form id="adminInviteForm" class="form-grid">'
      + '<div class="field"><label for="inviteName">Full name</label><input id="inviteName" required maxlength="80" autocomplete="off"></div>'
      + '<div class="field"><label for="inviteEmail">Email</label><input id="inviteEmail" type="email" required autocomplete="off"></div>'
      + '<div class="field"><label for="invitePhone">International phone (optional)</label><input id="invitePhone" type="tel" placeholder="+8801XXXXXXXXX" maxlength="16"></div>'
      + '<div class="field"><label for="inviteType">Account type</label><select id="inviteType"><option value="individual">Individual</option><option value="business">Business / Organization</option></select></div>'
      + '<div class="field" id="inviteBusinessRow" hidden><label for="inviteBusiness">Organization name</label><input id="inviteBusiness" maxlength="120"></div>'
      + '<div><button class="btn primary" type="submit">Send invitation</button></div>'
      + '<p class="hint" role="status" id="inviteFeedback"></p><p class="err" role="alert"></p></form>';
    host.prepend(panel);
    const byId = id => panel.querySelector('#' + id);
    byId('inviteType').onchange = () => { byId('inviteBusinessRow').hidden = byId('inviteType').value !== 'business'; };
    byId('adminInviteForm').onsubmit = async e => {
      e.preventDefault();
      if (inviteBusy) return;
      const body = {
        displayName: byId('inviteName').value.trim(),
        email: byId('inviteEmail').value.trim(),
        phone: byId('invitePhone').value.trim(),
        accountType: byId('inviteType').value,
        businessName: byId('inviteBusiness').value.trim(),
      };
      if (body.phone && !/^\+[1-9][0-9]{6,14}$/.test(body.phone)) {
        showError(panel,{message:'Enter a phone number with country code.'}); return;
      }
      inviteBusy = true;
      const button = panel.querySelector('button[type="submit"]');
      button.disabled = true;
      panel.querySelector('[role="alert"]').textContent = '';
      byId('inviteFeedback').textContent = 'Sending invitation…';
      try {
        const call = async () => {
          const {data,error} = await sb.functions.invoke('admin-user-invite',{body});
          if (error) throw error;
          if (!data?.ok) throw Error(data?.error || 'Invitation not confirmed');
          return data;
        };
        const result = window.cpayWithStepUp ? await window.cpayWithStepUp(call) : await call();
        byId('inviteFeedback').textContent = result.message || 'Invitation sent; awaiting approval.';
        byId('adminInviteForm').reset();
        byId('inviteBusinessRow').hidden = true;
      } catch (error) {
        byId('inviteFeedback').textContent = '';
        showError(panel,error);
      } finally { inviteBusy = false; button.disabled = false; }
    };
  }

  async function renderStatements() {
    const host = document.getElementById('statements');
    if (!host || statementBusy) return;
    host.innerHTML = '<div class="card"><p>Loading administrative statements…</p></div>';
    const [list, users] = await Promise.all([
      sb.rpc('admin_statement_list',{p_status:null}),
      sb.rpc('admin_list_business_profiles'),
    ]);
    if (list.error || users.error) {
      host.innerHTML = '<div class="card"><p class="err" role="alert"></p><button class="btn ghost" id="reloadStatements">Retry</button></div>';
      host.querySelector('[role="alert"]').textContent = list.error?.message || users.error?.message || 'Unavailable';
      host.querySelector('#reloadStatements').onclick = renderStatements;
      return;
    }
    statementRows = list.data || []; memberRows = (users.data || []).filter(u=>u.role!=='admin');
    host.innerHTML = '<div class="section-intro"><div><h2>Administrative invoices</h2><p>Record and track manually issued statements. This does not create a Lightning invoice, change a balance, or pay anyone.</p></div><button class="btn ghost" id="reloadStatements">Refresh</button></div>'
      + '<div class="card"><h3 id="statementFormHeading">Create statement</h3><form id="statementForm" class="form-grid">'
      + '<div class="field"><label for="statementUser">Member</label><select id="statementUser" required><option value="">Select member</option>'
      + memberRows.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.display_name || p.email)+' · '+esc(p.email)+'</option>').join('')+'</select></div>'
      + '<div class="field"><label for="statementTitle">Title</label><input id="statementTitle" required minlength="3" maxlength="120"></div>'
      + '<div class="field"><label for="statementAmount">USD amount</label><input id="statementAmount" type="number" min="0.01" max="1000000" step="0.01" required></div>'
      + '<div class="field"><label for="statementDue">Due date (optional)</label><input id="statementDue" type="date"></div>'
      + '<div class="field"><label for="statementStatus">Status</label><select id="statementStatus"><option value="draft">Draft</option><option value="outstanding" selected>Outstanding</option><option value="paid">Paid (external proof required)</option><option value="cancelled">Cancelled</option></select></div>'
      + '<div class="field"><label for="statementReference">External payment reference (if paid)</label><input id="statementReference" maxlength="200"></div>'
      + '<div class="field"><label for="statementNote">Details</label><textarea id="statementNote" maxlength="1000" rows="2"></textarea></div>'
      + '<div><button type="submit" class="btn primary" id="saveStatement">Save statement</button> <button type="button" class="btn ghost" id="clearStatement">Clear form</button></div>'
      + '<p role="alert" class="err" id="statementError"></p><p role="status" id="statementMessage" class="hint"></p></form></div>'
      + '<div class="card flush"><div class="card-head"><h3>Outstanding and past statements</h3><span class="faint">Latest 250</span></div>'
      + '<div class="scroll"><table class="table rtable"><thead><tr><th>Title / member</th><th>Amount</th><th>Due</th><th>Status</th><th>External ref.</th><th></th></tr></thead><tbody>'
      + statementRows.map(s=>'<tr><td>'+esc(s.title)+'<div class="faint">'+esc(s.owner_name)+'</div></td><td>'+dollar(s.amount_usd)+'</td>'
        + '<td>'+esc(s.due_on || '—')+'</td><td>'+esc(s.status)+'</td><td class="mono">'+esc(s.external_reference || '—')+'</td><td>'
        + (['draft','outstanding'].includes(s.status)?'<button class="btn ghost sm" type="button" data-edit-statement="'+esc(s.id)+'">Edit</button>':'Final')+'</td></tr>').join('')
      + '<tr id="noStatements" '+(statementRows.length?'hidden':'')+'><td colspan="6">No statements yet.</td></tr>'
      + '</tbody></table></div></div>';
    host.querySelector('#reloadStatements').onclick = renderStatements;
    let editId = null;
    const at = id => host.querySelector('#' + id);
    const clear = () => { editId = null; at('statementForm').reset(); at('statementFormHeading').textContent='Create statement'; at('statementError').textContent=''; };
    at('clearStatement').onclick = clear;
    host.querySelectorAll('[data-edit-statement]').forEach(button => {
      button.onclick = () => {
        const s = statementRows.find(a=>a.id===button.dataset.editStatement);
        if (!s) return;
        editId = s.id;
        at('statementUser').value=s.user_id;
        at('statementTitle').value=s.title;
        at('statementAmount').value=s.amount_usd;
        at('statementDue').value=s.due_on || '';
        at('statementStatus').value=s.status;
        at('statementReference').value=s.external_reference || '';
        at('statementNote').value=s.description || '';
        at('statementFormHeading').textContent='Edit statement';
        at('statementForm').scrollIntoView({block:'start',behavior:'smooth'});
      };
    });
    at('statementForm').onsubmit = async e => {
      e.preventDefault();
      if (statementBusy) return;
      const amount = at('statementAmount').value.trim();
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) { at('statementError').textContent='Enter a valid amount with at most two decimals.';return; }
      const status=at('statementStatus').value,reference=at('statementReference').value.trim();
      if (status==='paid' && reference.length<4) { at('statementError').textContent='Paid status requires an external payment reference.';return; }
      if (!window.confirm('Save this administrative record? It does not change real payments or account balances.')) return;
      const args={p_id:editId,p_user:at('statementUser').value,p_title:at('statementTitle').value.trim(),
        p_description:at('statementNote').value.trim(),p_amount:Number(amount),p_due:at('statementDue').value || null,
        p_status:status,p_reference:reference || null};
      statementBusy=true; at('saveStatement').disabled=true;at('statementError').textContent='';
      try {
        const call=async()=>{const {data,error}=await sb.rpc('admin_statement_write',args);if(error)throw error;return data;};
        await (window.cpayWithStepUp ? window.cpayWithStepUp(call):call());
        await renderAfterSave();
      } catch(ex){at('statementError').textContent=ex.message || 'Could not save statement';}
      finally{statementBusy=false;const b=at('saveStatement');if(b)b.disabled=false;}
    };
    async function renderAfterSave() {
      at('statementMessage').textContent='Statement saved. Refreshing…';
      statementBusy=false;
      await renderStatements();
    }
  }

  const KEYS=[
    ['btcpay_enabled','BTCPay checkout','Invoices created by your configured BTCPay gateway'],
    ['btcpay_lightning_only','Lightning only','Keep on-chain payment methods off'],
    ['custodial_receive_enabled','CPAY balance receiving','Operator-owned balance receiving'],
    ['custodial_new_links_enabled','New balance links','Allow new links to use CPAY balance'],
    ['custodial_withdraw_enabled','Balance withdrawals','Allow withdrawal requests from balances'],
    ['blink_receive_switch_enabled','Receiving account rotation','Rotate configured receiving accounts when eligible'],
  ];
  async function renderMethods() {
    const host=document.getElementById('methods');
    if(!host || methodBusy)return;
    host.innerHTML='<div class="card">Loading payment methods…</div>';
    const {data,error}=await sb.rpc('admin_platform_settings');
    if(error){host.innerHTML='<div class="card"><p role="alert" class="err">'+esc(error.message)+'</p><button id="retryMethods" class="btn ghost">Retry</button></div>';host.querySelector('#retryMethods').onclick=renderMethods;return;}
    const byKey=Object.fromEntries((data||[]).map(x=>[x.key,x]));
    host.innerHTML='<div class="section-intro"><div><h2>Payment methods</h2><p>Manage configured receiving routes. These switches do not set up provider credentials or prove incoming payments work.</p></div><button id="refreshMethods" class="btn ghost">Refresh</button></div>'
    +'<p class="hint">Changing checkout or receiving methods may interrupt payments. Review the destination, provider health and open invoices before switching.</p>'
    +'<div class="card flush"><table class="table rtable"><thead><tr><th>Method</th><th>Current</th><th>Control</th></tr></thead><tbody>'
    + KEYS.filter(([key])=>byKey[key]&&byKey[key].kind==='boolean').map(([key,label,desc])=>{
      const row=byKey[key],on=row.value===true;
      return '<tr><td><strong>'+esc(label)+'</strong><div class="faint">'+esc(desc)+'</div></td><td>'+ (on?'On':'Off') +'</td><td><button class="btn ghost sm" type="button" data-method="'+esc(key)+'" data-next="'+(!on)+'">Turn '+(on?'off':'on')+'</button></td></tr>';
    }).join('')+'</tbody></table></div><p class="err" role="alert" id="methodsError"></p>';
    host.querySelector('#refreshMethods').onclick=renderMethods;
    host.querySelectorAll('[data-method]').forEach(b=>b.onclick=async()=>{
      if(methodBusy)return;
      const key=b.dataset.method, row=byKey[key], next=b.dataset.next==='true';
      if(!row || !KEYS.some(x=>x[0]===key))return;
      if(!window.confirm('Change "'+row.label+'" to '+(next?'ON':'OFF')+'? Check your live receiving setup first.'))return;
      methodBusy=true;b.disabled=true;host.querySelector('#methodsError').textContent='';
      let saved=false;
      try{
        const write=async()=>{const {error}=await sb.rpc('admin_set_platform_setting',{p_key:key,p_value:next});if(error)throw error;};
        await (window.cpayWithStepUp?window.cpayWithStepUp(write):write());
        saved=true;
      }catch(e){const msg=host.querySelector('#methodsError');if(msg)msg.textContent=e.message || 'Switch not confirmed';}
      finally{methodBusy=false;b.disabled=false;if(saved)await renderMethods();}
    });
  }

  document.querySelectorAll('.navi[data-tab]').forEach(btn=>{
    btn.addEventListener('click',()=>{if(btn.dataset.tab==='statements')renderStatements();if(btn.dataset.tab==='methods')renderMethods();});
  });
  window.addEventListener('hashchange',()=>{
    if(location.hash==='#statements')renderStatements();
    if(location.hash==='#methods')renderMethods();
  });
  window.cpayAdminExtras={mountInvite,renderStatements,renderMethods,navTo};
})();
