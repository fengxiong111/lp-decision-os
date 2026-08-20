export function renderRuntime(config) {
  return `const CONFIG=${JSON.stringify({
    snapshotUrl: "./top3.json",
    refreshIntervalMs: config.refreshIntervalMs,
  })};
const ACTIONS=new Set(['OPEN','HOLD','MOVE CORE','MOVE BOTH','CLOSE','UNAVAILABLE']);
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const displayAction=(value)=>{const action=String(value??'UNAVAILABLE').replaceAll('_',' ');return ACTIONS.has(action)?action:'UNAVAILABLE'};
const fmt=(value,digits)=>Number.isFinite(Number(value))?Number(value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'等待证据';
const usd=(value,digits)=>Number.isFinite(Number(value))?'$'+fmt(value,digits):'等待证据';
const range=(lower,upper)=>Number.isFinite(Number(lower))&&Number.isFinite(Number(upper))?fmt(lower,4)+' – '+fmt(upper,4):'等待合法 Tick';
const rowValues=(row)=>({
  pair:row.pair??((row.symbol??'')+'/USDC'),
  net24h:row.net24h,
  coreCapital:row.coreCapital,
  coreLower:row.coreLower,
  coreUpper:row.coreUpper,
  bufferCapital:row.bufferCapital,
  bufferLower:row.bufferLower,
  bufferUpper:row.bufferUpper,
  action:displayAction(row.action),
});
const renderRow=(row,index)=>{const value=rowValues(row);const actionClass=value.action.toLowerCase().replaceAll(' ','-');return '<article class="optimizer-row" data-pool-address="'+esc(row.poolAddress)+'" role="row"><div class="row-grid"><div class="rank" role="cell">#'+String(index+1).padStart(2,'0')+'</div><div class="pair" role="cell"><strong>'+esc(value.pair)+'</strong></div><div class="net" role="cell"><strong>'+esc(usd(value.net24h,2))+'</strong></div><div class="strategy" role="cell"><strong>'+esc(usd(value.coreCapital,0))+'</strong><em>'+esc(range(value.coreLower,value.coreUpper))+'</em></div><div class="strategy" role="cell"><strong>'+esc(usd(value.bufferCapital,0))+'</strong><em>'+esc(range(value.bufferLower,value.bufferUpper))+'</em></div><div class="action '+esc(actionClass)+'" role="cell"><strong>'+esc(value.action)+'</strong></div></div></article>'};
const validRow=(row)=>row&&typeof row==='object'&&Number.isFinite(Number(row.rank))&&typeof row.pair==='string'&&ACTIONS.has(displayAction(row.action))&&Number.isFinite(Number(row.net24h))&&Number.isFinite(Number(row.coreCapital))&&Number.isFinite(Number(row.coreLower))&&Number.isFinite(Number(row.coreUpper))&&Number.isFinite(Number(row.bufferCapital))&&Number.isFinite(Number(row.bufferLower))&&Number.isFinite(Number(row.bufferUpper));
const validSnapshot=(snapshot)=>Boolean(snapshot&&snapshot.schemaVersion===1&&typeof snapshot.generatedAt==='string'&&typeof snapshot.snapshotHash==='string'&&/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)&&snapshot.dataFreshness&&snapshot.scope?.capital===1000&&snapshot.scope?.autoExecution===false&&Array.isArray(snapshot.top3)&&snapshot.top3.slice(0,3).every(validRow));
const freshSnapshot=(snapshot)=>{const timestamp=Date.parse(snapshot.generatedAt);const sla=Number(snapshot.dataFreshness?.slaMs);return Number.isFinite(timestamp)&&Number.isFinite(sla)&&Date.now()-timestamp<=sla&&snapshot.dataFreshness?.state==='FRESH'};
const setStatus=(text,state)=>{const target=document.querySelector('#live-status');if(target){target.textContent=text;target.dataset.state=state}};
const setTimestamp=(value)=>{const date=new Date(value);const target=document.querySelector('#observed-at');const wrap=document.querySelector('#observed-wrap');if(!target||!wrap||!Number.isFinite(date.valueOf()))return;target.textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date).replaceAll('/','-');wrap.hidden=false};
const setCount=(snapshot)=>{const target=document.querySelector('#market-count');if(target)target.textContent='已验证 '+Math.min(3,Array.isArray(snapshot.top3)?snapshot.top3.length:0)+' / 3 个可执行 Pool'};
const renderEmpty=(reason)=>{const list=document.querySelector('#ranking-list');const empty=document.querySelector('#empty-state');if(list)list.replaceChildren();if(empty){empty.innerHTML='<strong>RWA TOP 3</strong><span class="ready-count">0 / 3 READY</span><span class="reason">'+esc(reason??'当前没有满足完整证据门槛的可执行 Pool。')+'</span>';empty.hidden=false}};
const renderRows=(snapshot)=>{const rows=Array.isArray(snapshot.top3)?snapshot.top3.slice(0,3):[];const list=document.querySelector('#ranking-list');const empty=document.querySelector('#empty-state');if(!list||!empty)return;if(rows.length===0){renderEmpty('当前没有满足完整证据门槛的可执行 Pool。');return}list.innerHTML=rows.map(renderRow).join('');empty.replaceChildren();empty.hidden=true};
let requestInFlight=false;
const refresh=async()=>{if(requestInFlight||document.hidden)return;requestInFlight=true;try{const response=await fetch(CONFIG.snapshotUrl+'?_='+Date.now(),{cache:'no-store',headers:{accept:'application/json'}});if(!response.ok)throw new Error('HTTP '+response.status);const snapshot=await response.json();if(!validSnapshot(snapshot))throw new Error('top3.json 格式无效');setCount(snapshot);setTimestamp(snapshot.generatedAt);const main=document.querySelector('main');if(main)main.dataset.snapshotHash=snapshot.snapshotHash;if(!freshSnapshot(snapshot)){setStatus('证据快照已过期 · 当前不显示排名','warning');renderEmpty('当前快照已过期，等待新的 top3.json。');return}renderRows(snapshot);if(snapshot.top3.length===0)setStatus('0 / 3 READY · 当前没有可执行 Pool','warning');else setStatus('已载入 '+Math.min(3,snapshot.top3.length)+' 个可执行 Pool','fresh')}catch(error){setStatus('top3.json 读取失败 · 当前不显示排名','warning');renderEmpty('无法读取 mobile-dashboard/top3.json。');const target=document.querySelector('#live-status');if(target)target.title=error instanceof Error?error.message:'读取失败'}finally{requestInFlight=false}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh()});
void refresh();window.setInterval(refresh,CONFIG.refreshIntervalMs);`;
}
