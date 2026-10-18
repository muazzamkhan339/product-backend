(()=> {
const PUBLIC_KEY_PEM=`-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx/g+IoRiEyNegcXnTXMC\n+3/nn2s4Qi21B3aebko26oE1xPJUfkUwZ03LvY/EqhuL4bjzQhSVv+e5QGieyxD0\na8XWeWDmx1URnDcDKWC0JeFoHTdTFnZko0VcrZn8eWAzcruWdqWNkM8RURDPjqFp\nEKaN6UIiY0rk9R88SHHZA2I35srSVg/4x/46NndwV/zmsHDUsqdnysj4B3boCKvW\nSSf37+llfQjuPuOokf19b5trtnDR3Iq/Ar0hSH9a4LDzSL8endcPi6tkuPhJUEag\n9S3OyZNF3Ga6c+bva/myttEXI+zDIpz7QNmHyVQ/ycUyp5++q2+GCOqhUaTy2f8z\nvQIDAQAB\n-----END PUBLIC KEY-----\n`;
const API=localStorage.getItem("saas_api_url")||"http://127.0.0.1:8787/api";
const KEY="hps_saas_license";
const SEEN_KEY="hps_saas_last_seen";
const OFFLINE_GRACE_DAYS=7;
const CLOCK_TOLERANCE_MS=5*60*1000;
const TOKEN_KEY="hps_saas_school_token";
const API_TIMEOUT_MS=8000;
function b64u(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";return atob(s)}
function bytes(s){return Uint8Array.from(s,c=>c.charCodeAt(0))}
function pemToBytes(pem){return bytes(atob(pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,"")))}
async function verifyToken(token){
 try{const [body,sig]=token.split(".");const key=await crypto.subtle.importKey("spki",pemToBytes(PUBLIC_KEY_PEM),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);return await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,bytes(b64u(sig)),bytes(body))}
 catch(e){return false}
}
function payload(token){try{return JSON.parse(b64u(token.split(".")[0]))}catch{return null}}
function schoolId(){const q=new URLSearchParams(location.search).get("school");if(q){localStorage.setItem("hps_saas_school_id",q);return q}return localStorage.getItem("hps_saas_school_id")||""}
function schoolToken(){return localStorage.getItem(TOKEN_KEY)||""}
function authHeaders(json){const h=json?{"Content-Type":"application/json"}:{};const t=schoolToken();if(t)h.Authorization="Bearer "+t;return h}
function withTimeout(url,opts){const c=new AbortController();const t=setTimeout(()=>c.abort(),API_TIMEOUT_MS);return fetch(url,{...opts,signal:c.signal,cache:"no-store"}).finally(()=>clearTimeout(t))}
function el(tag,css,text){const e=document.createElement(tag);if(css)e.style.cssText=css;if(text!==undefined)e.textContent=text;return e}

// Capture the School ID and session token from the school's own successful login.
const __origFetch=window.fetch.bind(window);
window.fetch=function(input,init){
 const url=typeof input==="string"?input:(input&&input.url)||"";
 const p=__origFetch(input,init);
 if(/\/api\/school\/login$/.test(url)){
  p.then(r=>{if(!r.ok)return;return r.clone().json().then(d=>{
   if(d&&d.school&&d.school.schoolId){localStorage.setItem("hps_saas_school_id",d.school.schoolId)}
   if(d&&d.token){localStorage.setItem(TOKEN_KEY,d.token)}
   setTimeout(check,800);
  }).catch(()=>{})}).catch(()=>{});
 }
 return p;
};

function removePublicRegistration(){
 const clean=()=>{document.querySelectorAll('button,a,[role="button"]').forEach(el=>{const t=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();if(t==='register now'||t==='register'||t==='create school account'){el.style.display='none';el.setAttribute('aria-hidden','true');}})};
 clean();
 if(!window.__saasRegisterObserver){window.__saasRegisterObserver=new MutationObserver(clean);window.__saasRegisterObserver.observe(document.documentElement,{subtree:true,childList:true});}
}
function ui(){
 if(document.getElementById("saas-license-ui"))return;
 const box=el("div",'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:12px system-ui');box.id="saas-license-ui";
 const b=el("button",'border:1px solid #dbe5ef;background:#fff;color:#0B1D33;border-radius:999px;padding:8px 12px;box-shadow:0 8px 24px #001b3822;cursor:pointer','Subscription');b.id="saas-status";
 box.appendChild(b);document.body.appendChild(box);
 b.onclick=()=>{let id=schoolId();if(!id){id=prompt("Enter the School ID provided by your Super Admin:","");if(id){localStorage.setItem("hps_saas_school_id",id.trim());location.reload();return}}alert("School License: "+(id||"Not connected")+"\n\nThis installation uses the central subscription service when an internet connection is available.");};
}
function blocked(reason){
 if(document.getElementById("saas-block-screen"))return;
 const x=el("div",'position:fixed;inset:0;z-index:2147483647;background:linear-gradient(135deg,#06152a,#0B1D33);display:grid;place-items:center;padding:24px;color:#fff;font-family:system-ui');x.id="saas-block-screen";
 const inner=el("div",'max-width:520px;text-align:center');
 inner.appendChild(el("div","font-size:12px;letter-spacing:2px;color:#7dcaff;font-weight:800","SUBSCRIPTION INACTIVE"));
 inner.appendChild(el("h1","margin:10px 0;font-size:32px","School Application Locked"));
 inner.appendChild(el("p","color:#b9c9da;line-height:1.7",String(reason||"Your subscription is inactive or expired.")));
 inner.appendChild(el("p","color:#b9c9da","Please contact your software administrator to renew or reactivate this application."));
 const retry=el("button","margin-top:12px;padding:11px 18px;border:0;border-radius:10px;background:#2388ff;color:#fff;font-weight:800;cursor:pointer","Check Again");retry.id="saas-check-again";
 inner.appendChild(retry);x.appendChild(inner);document.body.appendChild(x);
 retry.onclick=()=>{x.remove();check();};
}

// ---- Subscription expiry warning (final 3 days and expiry day only) ----
const SUB_WARNING_ID="saas-subscription-warning";
function localYmd(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function daysUntilExpiry(expiryYmd){
 const e=String(expiryYmd||"").split("-").map(Number), t=localYmd(new Date()).split("-").map(Number);
 if(e.length!==3||t.length!==3||e.some(isNaN)||t.some(isNaN))return null;
 return Math.round((Date.UTC(e[0],e[1]-1,e[2])-Date.UTC(t[0],t[1]-1,t[2]))/864e5);
}
function subscriptionWarningFor(days){
 if(days===null||days<0||days>3)return null;
 if(days===0)return {level:"critical",text:"Your subscription expires today. Please renew your subscription to avoid interruption."};
 if(days===1)return {level:"critical",text:"Urgent! Your subscription will expire tomorrow. Please renew now."};
 if(days===2)return {level:"high",text:"Alert! Your subscription will expire in 2 days. Please renew it immediately."};
 return {level:"medium",text:"Warning! Your subscription will expire in 3 days. Please renew it soon."};
}
const WARNING_STYLES={
 medium:{bg:"#FFFBEB",border:"#F59E0B",fg:"#92400E",icon:"#D97706"},
 high:{bg:"#FFF7ED",border:"#F97316",fg:"#9A3412",icon:"#EA580C"},
 critical:{bg:"#FEF2F2",border:"#DC2626",fg:"#991B1B",icon:"#DC2626"}
};
function warningIcon(){
 const NS="http://www.w3.org/2000/svg";
 const svg=document.createElementNS(NS,"svg");svg.setAttribute("width","20");svg.setAttribute("height","20");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("fill","none");svg.setAttribute("aria-hidden","true");svg.style.flexShrink="0";
 const mk=(tag,attrs)=>{const n=document.createElementNS(NS,tag);Object.keys(attrs).forEach(k=>n.setAttribute(k,attrs[k]));return n};
 svg.appendChild(mk("path",{d:"M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",stroke:"currentColor","stroke-width":"2","stroke-linejoin":"round"}));
 svg.appendChild(mk("line",{x1:"12",y1:"9",x2:"12",y2:"13",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round"}));
 svg.appendChild(mk("line",{x1:"12",y1:"17",x2:"12.01",y2:"17",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round"}));
 return svg;
}
function renderSubscriptionWarning(){
 const bar=document.querySelector(".hps-topbar");
 let box=document.getElementById(SUB_WARNING_ID);
 const p=window.__saasLicensePayload;
 const w=(p&&p.status==="Active")?subscriptionWarningFor(daysUntilExpiry(String(p.expiresAt||"").slice(0,10))):null;
 if(!w||!bar){if(box)box.remove();return}
 if(!box){
  box=el("div","display:flex;align-items:center;gap:12px;box-sizing:border-box;width:100%;padding:10px 20px;border-bottom:1px solid;font:600 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.4;flex-wrap:wrap");
  box.id=SUB_WARNING_ID;box.className="no-print";box.setAttribute("role","alert");
  box.appendChild(warningIcon());box.appendChild(el("span","flex:1;min-width:0"));
 }
 const st=WARNING_STYLES[w.level];
 box.style.background=st.bg;box.style.borderBottomColor=st.border;box.style.color=st.fg;
 box.querySelector("svg").style.color=st.icon;
 box.querySelector("span").textContent=w.text;
 if(box.nextElementSibling!==bar)bar.parentNode.insertBefore(box,bar);
}

// ---- Menu configuration (per school, from the server; cached for offline use) ----
const CONFIG_KEY="hps_saas_config";
const CONFIG_LABELS={dashboard:"Dashboard",staff:"Staff Information",students:"Student Information",attendance:"Attendance",idcards:"ID Card Generator",fees:"Fees Section",exams:"Exam Section",results:"Result Section",certificates:"Certificate Section",library:"Library Management",expenses:"School Expenses",reports:"Reports",settings:"Settings"};
function setSchoolConfig(cfg){
 if(!cfg||typeof cfg!=="object")return;
 window.__saasConfig={hidden:Array.isArray(cfg.hidden)?cfg.hidden:[],labels:cfg.labels&&typeof cfg.labels==="object"?cfg.labels:{}};
 try{localStorage.setItem(CONFIG_KEY,JSON.stringify(window.__saasConfig))}catch{}
 applySchoolConfig();
}
function loadCachedConfig(){
 try{const c=JSON.parse(localStorage.getItem(CONFIG_KEY)||"null");if(c)setSchoolConfig(c)}catch{}
}
function applySchoolConfig(){
 const cfg=window.__saasConfig;if(!cfg)return;
 const sidebar=document.querySelector(".hps-sidebar");if(!sidebar)return;
 const nav=sidebar.querySelector("nav")||sidebar;
 Array.from(nav.children).forEach(btn=>{
  if(btn.tagName!=="BUTTON")return;
  const textNode=Array.from(btn.childNodes).find(n=>n.nodeType===3&&n.nodeValue.trim());
  if(!textNode)return;
  let feature=btn.getAttribute("data-hps-feature");
  if(!feature){
   feature=Object.keys(CONFIG_LABELS).find(k=>CONFIG_LABELS[k]===textNode.nodeValue.trim())||"";
   if(!feature)return;
   btn.setAttribute("data-hps-feature",feature);
  }
  const hide=cfg.hidden.indexOf(feature)>=0;
  const display=hide?"none":"flex";
  if(btn.style.display!==display)btn.style.display=display;
  const label=cfg.labels[feature]||CONFIG_LABELS[feature];
  if(textNode.nodeValue!==label)textNode.nodeValue=label;
 });
}

// ---- HTML features: each runs in a sandboxed frame with no access to school records, login, or the network ----
const FEATURES_KEY="hps_saas_features";
let schoolFeatures=[];
try{schoolFeatures=JSON.parse(localStorage.getItem(FEATURES_KEY)||"[]")}catch{}
let featureOverlay=null, openFeatureId="";
const FEATURE_CSP='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:">';
const FEATURE_BRIDGE_JS='<script>window.hps={storage:{get:function(k){return featureCall("get",k)},set:function(k,v){return featureCall("set",k,v)},remove:function(k){return featureCall("delete",k)}}};function featureCall(op,key,value){return new Promise(function(res,rej){var id=Math.random().toString(36).slice(2);function on(e){if(!e.data||e.data.id!==id)return;window.removeEventListener("message",on);e.data.ok?res(e.data.value):rej(new Error(e.data.error))}window.addEventListener("message",on);parent.postMessage({type:"hps-storage",id:id,op:op,key:key,value:value},"*")})}<\/script>';
function setSchoolFeatures(list){
 schoolFeatures=Array.isArray(list)?list:[];
 try{localStorage.setItem(FEATURES_KEY,JSON.stringify(schoolFeatures))}catch{}
 applyFeatureMenu();
}
function applyFeatureMenu(){
 const nav=document.querySelector(".hps-sidebar nav");
 if(!nav)return;
 const tpl=Array.from(nav.children).find(b=>b.tagName==="BUTTON"&&b.getAttribute("data-hps-feature")==="settings");
 if(!tpl)return;
 const wanted=schoolFeatures.map(f=>"feat:"+f.updateId);
 Array.from(nav.children).forEach(b=>{
  const id=b.getAttribute("data-hps-feature-id");
  if(id&&wanted.indexOf(id)<0)b.remove();
 });
 schoolFeatures.forEach(f=>{
  const attr="feat:"+f.updateId;
  if(Array.from(nav.children).some(b=>b.getAttribute("data-hps-feature-id")===attr))return;
  const btn=tpl.cloneNode(true);
  btn.removeAttribute("data-hps-feature");
  btn.setAttribute("data-hps-feature-id",attr);
  btn.style.display="flex";
  const tn=Array.from(btn.childNodes).find(n=>n.nodeType===3&&n.nodeValue.trim());
  if(tn)tn.nodeValue=f.title;
  btn.onclick=()=>openFeature(f.updateId,f.title);
  nav.appendChild(btn);
 });
}
function closeFeature(){if(featureOverlay){featureOverlay.remove();featureOverlay=null}openFeatureId=""}
async function openFeature(updateId,title){
 closeFeature();
 try{
  const r=await withTimeout(API+"/school/features/"+encodeURIComponent(updateId)+"/html",{headers:authHeaders(false)});
  if(!r.ok) throw Error("not available");
  const d=await r.json();
  const box=el("div","position:fixed;left:240px;top:56px;right:0;bottom:0;z-index:2147483000;background:#f4f7fb;display:flex;flex-direction:column");
  box.id="saas-feature-overlay";
  const head=el("div","display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid #dbe5ef;font:600 14px system-ui");
  head.appendChild(el("span","",d.title||title));
  head.appendChild(mkBtn("Close","border:1px solid #dbe5ef;background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer",closeFeature));
  box.appendChild(head);
  const frame=document.createElement("iframe");
  frame.setAttribute("sandbox","allow-scripts");
  frame.setAttribute("title",d.title||title);
  frame.style.cssText="flex:1;border:0;width:100%;background:#fff";
  frame.srcdoc=FEATURE_CSP+FEATURE_BRIDGE_JS+d.html;
  box.appendChild(frame);
  document.body.appendChild(box);
  featureOverlay=box; openFeatureId=updateId;
 }catch(e){ alert("This feature could not be opened right now. Please try again when the internet is available."); }
}
window.addEventListener("message",async e=>{
 const d=e.data;
 if(!d||d.type!=="hps-storage"||!featureOverlay||!openFeatureId)return;
 const frame=featureOverlay.querySelector("iframe");
 if(!frame||e.source!==frame.contentWindow)return;
 const reply=x=>frame.contentWindow.postMessage(Object.assign({id:d.id},x),"*");
 try{
  const r=await withTimeout(API+"/school/features/"+encodeURIComponent(openFeatureId)+"/storage",{method:"POST",headers:authHeaders(true),body:JSON.stringify({op:d.op,key:d.key,value:d.value})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw Error(j.error||"Storage could not be used.");
  reply({ok:true,value:j.value===undefined?null:j.value});
 }catch(err){ reply({ok:false,error:err.message}); }
});

// ---- Updates: offered only when published for this school; installed only after a verified local install ----
const dismissedUpdates=new Set();   // "Later" hides an update until the next launch
let lastUpdates=[];
function mkBtn(text,css,onclick){const b=el("button",css,text);b.onclick=onclick;return b}
function showUpdateCard(updates){
 const next=(updates||[]).find(u=>!dismissedUpdates.has(u.id));
 let card=document.getElementById("saas-update-notice");
 if(!next){if(card)card.remove();return}
 if(card&&card.dataset.updateId===next.id)return;
 if(card)card.remove();
 card=el("div","position:fixed;right:16px;top:16px;z-index:2147483001;width:min(390px,calc(100vw - 32px));background:#fff;border:1px solid #dbe5ef;border-radius:14px;padding:16px;box-shadow:0 20px 50px #001b3830;font:13px system-ui;color:#12263f");
 card.id="saas-update-notice";card.dataset.updateId=next.id;
 card.appendChild(el("b","font-size:15px","A New Update Is Available"));
 card.appendChild(el("div","color:#64748b;margin:7px 0",[next.version?("Version "+next.version):"",next.updateType||"",next.title||""].filter(Boolean).join(" · ")));
 card.appendChild(el("div","color:#475569;line-height:1.5",next.description||"An update has been authorized for this school."));
 const status=el("div","margin-top:8px;color:#475569");status.id="saas-update-status";card.appendChild(status);
 const actions=el("div","margin-top:12px;display:flex;gap:8px");actions.id="saas-update-actions";card.appendChild(actions);
 document.body.appendChild(card);
 const close=()=>{dismissedUpdates.add(next.id);card.remove();showUpdateCard(lastUpdates)};
 actions.appendChild(mkBtn("Later","flex:1;padding:9px;border:1px solid #dbe5ef;background:#fff;border-radius:9px;cursor:pointer",close));
 actions.appendChild(mkBtn("Update Now","flex:1;padding:9px;border:0;background:#2388ff;color:#fff;border-radius:9px;font-weight:700;cursor:pointer",()=>installUpdate(next,card)));
}
async function sha256Hex(text){
 const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
 return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
// Downloads from the central server, verifies the signature and checksum, then asks the local
// server to install. Nothing is installed unless the school clicks Update Now.
async function applyUpdate(updateId){
 const dl=await withTimeout(API+"/school/updates/"+encodeURIComponent(updateId)+"/package",{headers:authHeaders(false)});
 if(!dl.ok) throw Error("The update could not be downloaded.");
 const got=await dl.json();
 const mp=payload(got.manifestToken||"");
 if(!mp||mp.role!=="update"||mp.updateId!==updateId||!(await verifyToken(got.manifestToken)))
  throw Error("The update signature could not be verified.");
 if((await sha256Hex(got.package))!==mp.sha256) throw Error("The update file is damaged or altered.");
 const ap=await withTimeout(API+"/local/apply-update",{method:"POST",headers:authHeaders(true),body:JSON.stringify({updateId,manifestToken:got.manifestToken,package:got.package})});
 const r=await ap.json().catch(()=>({}));
 if(!ap.ok) throw Error(r.error||"Installation did not complete.");
 return r;
}
async function applyConfigUpdate(updateId){
 const r=await withTimeout(API+"/school/updates/"+encodeURIComponent(updateId)+"/apply-config",{method:"POST",headers:authHeaders(false)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok) throw Error(d.error||"The configuration could not be applied.");
 setSchoolConfig(d.config);
 return d;
}
async function installFeature(updateId){
 const r=await withTimeout(API+"/school/updates/"+encodeURIComponent(updateId)+"/install-feature",{method:"POST",headers:authHeaders(false)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok) throw Error(d.error||"The feature could not be installed.");
 setSchoolFeatures(d.features);
 return d;
}
async function installUpdate(u,card){
 const status=document.getElementById("saas-update-status"), actions=document.getElementById("saas-update-actions");
 actions.innerHTML="";
 status.textContent="Downloading and verifying the update…";
 try{
  if(u.kind==='config'){await applyConfigUpdate(u.id)}else if(u.kind==='html'){await installFeature(u.id)}else{await applyUpdate(u.id)}
  dismissedUpdates.add(u.id);
  status.textContent="Update installed successfully. Reload the application to see the changes.";
  actions.appendChild(mkBtn("Reload Now","flex:1;padding:9px;border:0;background:#0c9b70;color:#fff;border-radius:9px;font-weight:700;cursor:pointer",()=>location.reload()));
 }catch(e){
  status.textContent="The update was not installed and your application is unchanged. ("+e.message+")";
  actions.appendChild(mkBtn("Close","flex:1;padding:9px;border:1px solid #dbe5ef;background:#fff;border-radius:9px;cursor:pointer",()=>{dismissedUpdates.add(u.id);card.remove()}));
 }
}

async function check(){
 ui();removePublicRegistration();
 if(window.__saasLoginGate&&!window.__saasAuthenticated)return;
 const id=schoolId();if(!id)return;
 let cache=null;try{cache=JSON.parse(localStorage.getItem(KEY)||"null")}catch{}
 try{
  const r=await withTimeout(API+"/license/verify",{method:"POST",headers:authHeaders(true),body:JSON.stringify({schoolId:id})});
  if(!r.ok)throw Error("verify");
  const d=await r.json();
  if(!d.token||!(await verifyToken(d.token))||!d.payload)throw Error("signature");
  localStorage.setItem(KEY,JSON.stringify({token:d.token,checkedAt:Date.now()}));
  localStorage.setItem(SEEN_KEY,String(Math.max(Number(localStorage.getItem(SEEN_KEY)||0),Date.now())));
  window.__saasLicensePayload=d.payload;renderSubscriptionWarning();
  if(d.payload.status!=="Active")return blocked(d.payload.status==="Blocked"?"Your school account has been blocked by the administrator.":"Your subscription has expired or is inactive.");
  lastUpdates=d.updates||[];showUpdateCard(lastUpdates);
  try{const cr=await withTimeout(API+"/school/config",{headers:authHeaders(false)});if(cr.ok){const cd=await cr.json();setSchoolConfig(cd.config)}}catch(e){}
  try{const fr=await withTimeout(API+"/school/features",{headers:authHeaders(false)});if(fr.ok){const fd=await fr.json();setSchoolFeatures(fd.features)}}catch(e){}
 }catch(e){
  // Offline or server unreachable: keep working from the cached, signed license, within limits.
  loadCachedConfig();
  applyFeatureMenu();
  const now=Date.now();
  const lastSeen=Number(localStorage.getItem(SEEN_KEY)||0);
  if(lastSeen&&now<lastSeen-CLOCK_TOLERANCE_MS)return blocked("The computer's date or time has been set back. Connect to the internet to continue.");
  if(cache&&cache.token&&(await verifyToken(cache.token))){
   const p=payload(cache.token);
   const expired=!p||p.status!=="Active"||new Date(p.expiresAt).getTime()<=now;
   if(expired)return blocked("Your subscription has expired. Connect to the internet and renew to continue.");
   if(now-(cache.checkedAt||0)>OFFLINE_GRACE_DAYS*864e5)return blocked("Offline use has expired. Connect to the internet once to continue.");
   window.__saasLicensePayload=p;renderSubscriptionWarning();
  }
 }
}
const originalSetActiveAccount=window.__setActiveAccount;
if(typeof originalSetActiveAccount==="function"){
 window.__setActiveAccount=function(id){
  const result=originalSetActiveAccount.apply(this,arguments);
  window.__saasAuthenticated=true;window.__saasLoginGate=false;
  setTimeout(()=>{if(window.__saasAuthenticated)check()},800);
  return result;
 };
}
const originalClearActiveAccount=window.__clearActiveAccount;
if(typeof originalClearActiveAccount==="function"){
 window.__clearActiveAccount=function(){window.__saasAuthenticated=false;return originalClearActiveAccount.apply(this,arguments)};
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>setTimeout(check,500));else setTimeout(check,500);
new MutationObserver(removePublicRegistration).observe(document.documentElement,{subtree:true,childList:true});
setInterval(check,6*60*60*1000);
setInterval(renderSubscriptionWarning,2000);
setInterval(applySchoolConfig,2000);
setInterval(applyFeatureMenu,2000);
loadCachedConfig();
applyFeatureMenu();
})();
