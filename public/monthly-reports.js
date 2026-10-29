// Monthly member reports. Counts and sums come from one authenticated SQL RPC,
// not the paginated payment list, and use Asia/Dhaka calendar-month bounds.
(function () {
  'use strict';
  let version = 0;
  const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd = n=>'$'+Number(n||0).toFixed(2);
  const monthDefault=()=>{
    const now=new Date();
    const part=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit'}).formatToParts(now);
    const y=part.find(p=>p.type==='year')?.value;
    const m=part.find(p=>p.type==='month')?.value;
    return y+'-'+m;
  };
  let month=monthDefault();
  async function render() {
    const root=document.getElementById('reports');
    if(!root)return;
    const thisRender=++version;
    root.innerHTML='<div class="card"><p>Loading monthly report…</p></div>';
    const {data,error}=await window.supabaseClient.rpc('my_monthly_report',{p_month:month+'-01'});
    if(thisRender!==version)return;
    if(error){root.innerHTML='<div class="card"><p class="err" role="alert">'+esc(error.message)+'</p><button class="btn ghost" id="retryMonthly">Retry</button></div>';root.querySelector('#retryMonthly').onclick=render;return;}
    const d=data||{};
    const cells=[
      ['Gross settled',usd(d.gross)],['Platform fees',usd(d.fees)],['Net earnings',usd(d.net)],
      ['Paid payments',Number(d.paid||0)],['Expired',Number(d.expired||0)],
      ['Failed',Number(d.failed||0)],['In progress',Number(d.in_progress||0)],
      ['Success rate',d.success_rate==null?'—':Number(d.success_rate).toFixed(1)+'%'],
    ];
    const recent=Array.isArray(d.recent)?d.recent:[];
    const links=Array.isArray(d.top_links)?d.top_links:[];
    root.innerHTML='<div class="section-intro"><div><h2>Monthly reports</h2><p>Review payment outcomes and link activity. Times are grouped by calendar month in Dhaka.</p></div><button id="monthlyRefresh" type="button" class="btn ghost">Refresh</button></div>'
      +'<div class="card"><div class="field"><label for="reportMonth">Report month</label><input id="reportMonth" type="month" value="'+esc(month)+'" max="'+esc(monthDefault())+'"></div>'
      +'<p class="hint">Success rate = paid ÷ (paid + expired + failed). In-progress payments are excluded.</p></div>'
      +'<div class="grid kpis">'+cells.map(([title,value])=>'<div class="card"><div class="kicker">'+esc(title)+'</div><div class="kpi">'+esc(value)+'</div></div>').join('')+'</div>'
      +'<div class="card flush"><div class="card-head"><h3>Top links</h3></div><div class="scroll"><table class="table rtable"><thead><tr><th>Link</th><th>Attempts</th><th>Paid</th><th>Gross</th></tr></thead><tbody>'
      +(links.map(v=>'<tr><td>'+esc(v.name)+'</td><td>'+Number(v.attempts||0)+'</td><td>'+Number(v.paid||0)+'</td><td>'+usd(v.gross)+'</td></tr>').join('')||'<tr><td colspan="4">No payments this month.</td></tr>')+'</tbody></table></div></div>'
      +'<div class="card flush"><div class="card-head"><h3>Recent payments</h3><span class="faint">Latest 15 this month</span></div><div class="scroll"><table class="table rtable"><thead><tr><th>When</th><th>Link</th><th>Status</th><th>Amount</th><th>Country</th></tr></thead><tbody>'
      +(recent.map(v=>'<tr><td>'+esc(new Date(v.when).toLocaleString())+'</td><td>'+esc(v.link)+'</td><td>'+esc(v.status)+'</td><td>'+usd(v.amount)+'</td><td>'+esc(v.country||'—')+'</td></tr>').join('')||'<tr><td colspan="5">No activity this month.</td></tr>')+'</tbody></table></div></div>';
    root.querySelector('#monthlyRefresh').onclick=render;
    root.querySelector('#reportMonth').onchange=e=>{
      const v=String(e.target.value||'');
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)||v>monthDefault()){e.target.value=month;return;}
      month=v;render();
    };
  }
  document.querySelectorAll('.navi[data-tab="reports"]').forEach(b=>b.addEventListener('click',render));
  window.addEventListener('hashchange',()=>{if(location.hash==='#reports')render();});
  window.cpayMonthlyReports={render};
})();
