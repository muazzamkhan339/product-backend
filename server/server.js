const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USER = process.env.SUPER_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'CHANGE-ME-NOW';
const DB_FILE = path.join(__dirname, 'data.json');
const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, 'private.pem'), 'utf8');

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { schools: [], updates: [], activity: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { schools: [], updates: [], activity: [] }; }
}
let db = loadDb();
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function hashPassword(v, salt=crypto.randomBytes(16).toString('hex')) { const derived=crypto.scryptSync(String(v), salt, 64).toString('hex'); return `${salt}:${derived}`; }
function passwordMatches(password, stored) { try { const [salt,hex]=String(stored||'').split(':'); if(!salt||!hex)return false; const actual=crypto.scryptSync(String(password),salt,64); const expected=Buffer.from(hex,'hex'); return actual.length===expected.length && crypto.timingSafeEqual(actual,expected); } catch { return false; } }
function constantTimeStringEqual(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && crypto.timingSafeEqual(x,y);}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||'')) && !Number.isNaN(new Date(v+'T00:00:00Z').getTime());}

function b64u(v) { return Buffer.from(v).toString('base64url'); }
function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(body), PRIVATE_KEY).toString('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token, role) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    if (!crypto.verify('RSA-SHA256', Buffer.from(body), PRIVATE_KEY, Buffer.from(sig, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.role !== role) return null;
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}
function admin(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && !!verifyToken(h.slice(7), 'super-admin');
}
function json(res, status, data) {
  const out = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS'
  });
  res.end(out);
}
function body(req, limit=2e6) {
  return new Promise((resolve, reject) => {
    let s=''; req.on('data', c => { s += c; if (s.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}
function audit(action, schoolId, meta={}) {
  db.activity.unshift({ id:id('act'), at:new Date().toISOString(), action, schoolId:schoolId||null, meta });
  db.activity = db.activity.slice(0, 5000); saveDb();
}
function normalizeSchool(s) {
  const now = new Date();
  const plan = ['Monthly','Yearly','Free','Days'].includes(s.plan) ? s.plan : 'Monthly';
  const planDays = clampDays(s.planDays);
  const start = s.subscriptionStart || now.toISOString().slice(0,10);
  const defaultDays = planLengthDays(plan, planDays);
  const expiry = s.subscriptionExpiry || new Date(now.getTime()+defaultDays*864e5).toISOString().slice(0,10);
  return {
    id:s.id || id('school'),
    schoolName:String(s.schoolName||'').trim(),
    schoolId:String(s.schoolId||'').trim() || id('SCH').toUpperCase(),
    username:String(s.username||'').trim(),
    location:String(s.location||s.address||'').trim(),
    address:String(s.address||s.location||'').trim(),
    ownerName:String(s.ownerName||'').trim(),
    logo:String(s.logo||''),
    accountStatus: s.accountStatus === 'Locked' ? 'Locked' : 'Active',
    passwordHash: s.passwordHash || '',
    phone:String(s.phone||'').trim(),
    email:String(s.email||'').trim(),
    plan,
    planDays,
    monthlyFee:Number(s.monthlyFee||0),
    subscriptionStart:start,
    subscriptionExpiry:expiry,
    paymentStatus:s.paymentStatus || 'Pending',
    status:s.status || 'Active',
    applicationVersion:s.applicationVersion || '1.0.0',
    notes:String(s.notes||''),
    appConfig:s.appConfig||{hidden:[],labels:{},lastUpdateId:''},
    appConfigPrev:s.appConfigPrev||null,
    features:Array.isArray(s.features)?s.features:[],
    createdAt:s.createdAt || now.toISOString(),
    updatedAt:new Date().toISOString()
  };
}
function clampDays(v){const n=Math.floor(Number(v));return Number.isFinite(n)&&n>=1?Math.min(36500,n):30}
function planLengthDays(plan,planDays){return plan==='Yearly'?365:plan==='Free'?36500:plan==='Days'?clampDays(planDays):30}
function publicSchool(s) { const {passwordHash, ...safe}=s; return safe; }
// ---------- Update management helpers ----------
const UPDATES_DIR = path.join(__dirname, 'updates');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const APP_DIR = path.join(__dirname, '..', 'app');
const UPDATE_TYPES = ['New Feature', 'Bug Fix', 'Improvement', 'Security Update'];
const ALLOWED_UPDATE_FILE = /\.(html|js|css|json|svg|png|jpe?g)$/i;
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
fs.mkdirSync(UPDATES_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function schoolFromReq(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const p = verifyToken(h.slice(7), 'school');
  return p ? (db.schools.find(x => x.schoolId === p.schoolId) || null) : null;
}
function parseTargets(v) {
  if (v === 'ALL') return { value: 'ALL' };
  if (!Array.isArray(v) || !v.length) return { error: 'Select All Schools, one school, or at least one school.' };
  const ids = [...new Set(v.map(String))];
  if (ids.some(x => !db.schools.some(s => s.schoolId === x))) return { error: 'One or more selected schools do not exist.' };
  return { value: ids };
}
// A package is a JSON file: { format:"hps-update-1", files:[{path:"app/...", encoding:"base64", content}] }.
// Only files under app/ with approved extensions are accepted; database migrations are refused.
function parsePackage(text) {
  if (Buffer.byteLength(text) > MAX_PACKAGE_BYTES) throw new Error('The update package is larger than 25 MB.');
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('The file is not a valid HPS update package.'); }
  if (!p || p.format !== 'hps-update-1') throw new Error('Unsupported update package format.');
  if (Array.isArray(p.migrations) && p.migrations.length) throw new Error('This package includes database migrations, which this build cannot apply safely.');
  if (!Array.isArray(p.files) || !p.files.length) throw new Error('The update package contains no files.');
  const seen = new Set();
  return p.files.map(f => {
    const rel = String(f.path || '').replace(/\\/g, '/');
    if (!rel.startsWith('app/') || rel.includes('..') || !ALLOWED_UPDATE_FILE.test(rel) || !/^[A-Za-z0-9_\-\/.]+$/.test(rel))
      throw new Error('Package path not allowed: ' + rel);
    if (seen.has(rel)) throw new Error('Duplicate file in package: ' + rel);
    seen.add(rel);
    if (f.encoding !== 'base64') throw new Error('Unsupported encoding for ' + rel);
    const buf = Buffer.from(String(f.content || ''), 'base64');
    return { rel, buf, sha256: sha256Hex(buf) };
  });
}
// Writes files only inside app/. Backs up every existing file first; on any failure restores what was written.
function applyPackage(files) {
  const root = path.join(__dirname, '..');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS_DIR, stamp);
  fs.mkdirSync(backup, { recursive: true });
  const plan = files.map(f => {
    const target = path.resolve(root, f.rel);
    if (!target.startsWith(APP_DIR + path.sep)) throw new Error('Refusing to write outside the app folder: ' + f.rel);
    const existed = fs.existsSync(target) && fs.statSync(target).isFile();
    return { ...f, target, existed };
  });
  const written = [];
  try {
    for (const f of plan) {
      if (f.existed) {
        const bp = path.join(backup, f.rel);
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        fs.copyFileSync(f.target, bp);
      }
    }
    for (const f of plan) {
      fs.mkdirSync(path.dirname(f.target), { recursive: true });
      fs.writeFileSync(f.target, f.buf);
      written.push(f);
    }
    for (const f of plan) {
      if (sha256Hex(fs.readFileSync(f.target)) !== f.sha256) throw new Error('Verification failed after writing ' + f.rel);
    }
    return { backup, files: plan.map(f => f.rel) };
  } catch (e) {
    for (const f of written.reverse()) {
      try {
        if (f.existed) fs.copyFileSync(path.join(backup, f.rel), f.target);
        else fs.unlinkSync(f.target);
      } catch { /* keep restoring the rest */ }
    }
    e.rolledBack = true;
    e.message = 'Installation failed: ' + e.message + '.';
    throw e;
  }
}
function eligibleFor(up, school) {
  if (!up || !school || up.status !== 'Published') return false;
  const targeted = up.targetSchools === 'ALL' || (Array.isArray(up.targetSchools) && up.targetSchools.includes(school.schoolId));
  if (!targeted) return false;
  const d = up.deliveries && up.deliveries[school.schoolId];
  return !(d && (d.status === 'Installed' || d.status === 'RolledBack'));
}
function publicUpdate(up) {
  return { id: up.id, title: up.title, description: up.description, updateType: up.updateType, version: up.version, publishedAt: up.publishedAt, kind: up.kind || 'files' };
}
function setDelivery(up, sid, status, error = '') {
  up.deliveries = up.deliveries || {};
  up.deliveries[sid] = { status, at: new Date().toISOString(), error, version: up.version || '' };
}

// ---------- Menu configuration (hps-config-1) ----------
const CONFIG_FEATURES = {
  dashboard:'Dashboard', staff:'Staff Information', students:'Student Information', attendance:'Attendance',
  idcards:'ID Card Generator', fees:'Fees Section', exams:'Exam Section', results:'Result Section',
  certificates:'Certificate Section', library:'Library Management', expenses:'School Expenses', reports:'Reports', settings:'Settings'
};
const PROTECTED_FEATURES = ['dashboard','settings'];
const MAX_CONFIG_OPS = 50;
function emptyConfig() { return { hidden: [], labels: {}, lastUpdateId: '' }; }
function detectKind(text) {
  if (text.trimStart().startsWith('<')) return 'html';
  try { const p = JSON.parse(text); return (p && p.format === 'hps-config-1') ? 'config' : 'files'; } catch { return 'files'; }
}

// ---------- Full application files (replace one school's app/index.html) ----------
const BRIDGE_TAG = '<script src="http://127.0.0.1:8787/bridge.js"></script>';
const MAX_APP_HTML = 18 * 1024 * 1024;
function isFullAppHtml(text) { return /hps-sidebar/.test(text) && /hps-topbar/.test(text); }
function validateAppHtml(text) {
  if (Buffer.byteLength(text) > MAX_APP_HTML) throw new Error('The application file is larger than 18 MB.');
  if (!/school\/login/.test(text)) throw new Error('This file uses the old local login, so it cannot be sent as a school update. Build the application from the current project, which logs schools in through the central server.');
}
function buildAppPackage(text) {
  validateAppHtml(text);
  let finalText = text;
  if (!/bridge\.js/.test(finalText)) {
    const lastBody = finalText.toLowerCase().lastIndexOf('</body>');
    finalText = lastBody >= 0
      ? finalText.slice(0, lastBody) + BRIDGE_TAG + finalText.slice(lastBody)
      : finalText + BRIDGE_TAG;
  }
  return JSON.stringify({ format: 'hps-update-1', files: [{ path: 'app/index.html', encoding: 'base64', content: Buffer.from(finalText, 'utf8').toString('base64') }] });
}
const MAX_FEATURE_HTML = 20 * 1024 * 1024;
function validateFeatureHtml(text) {
  if (Buffer.byteLength(text) > MAX_FEATURE_HTML) throw new Error('The HTML file is larger than 20 MB.');
  if (/<(iframe|object|embed|base|frame|frameset)\b/i.test(text)) throw new Error('The HTML file contains a tag that is not allowed (iframe, object, embed, base or frame).');
  if (/<meta[^>]+http-equiv\s*=\s*["']?(refresh|content-security-policy)/i.test(text)) throw new Error('The HTML file contains a meta tag that is not allowed.');
  if (/<(script|link|img|audio|video|source)[^>]+\b(src|href)\s*=\s*["']?\s*(https?:|\/\/)/i.test(text)) throw new Error('The HTML file loads external resources, which are not allowed.');
  if (!/<(html|body|div|section|main|h1|h2|p)\b/i.test(text)) throw new Error('The file does not look like an HTML page.');
}
function parseConfigPackage(text) {
  if (Buffer.byteLength(text) > 1000000) throw new Error('The configuration file is too large.');
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  if (!p || p.format !== 'hps-config-1') throw new Error('Unsupported configuration format.');
  if (!Array.isArray(p.operations) || !p.operations.length) throw new Error('The configuration has no operations.');
  if (p.operations.length > MAX_CONFIG_OPS) throw new Error('Too many operations (maximum ' + MAX_CONFIG_OPS + ').');
  return p.operations.map((o, i) => {
    const n = i + 1;
    if (!o || typeof o !== 'object') throw new Error('Operation ' + n + ' is not valid.');
    const feature = String(o.feature || '');
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FEATURES, feature)) throw new Error('Operation ' + n + ': unknown feature "' + feature + '".');
    if (o.op === 'hide') {
      if (PROTECTED_FEATURES.includes(feature)) throw new Error('Operation ' + n + ': "' + feature + '" cannot be hidden.');
      return { op: 'hide', feature };
    }
    if (o.op === 'show') return { op: 'show', feature };
    if (o.op === 'relabel') {
      const label = String(o.label || '').trim();
      if (!label || label.length > 40) throw new Error('Operation ' + n + ': label must be 1 to 40 characters.');
      if (/[<>]/.test(label)) throw new Error('Operation ' + n + ': label cannot contain < or >.');
      return { op: 'relabel', feature, label };
    }
    throw new Error('Operation ' + n + ': unsupported operation "' + o.op + '".');
  });
}
function applyConfigOps(cfg, ops) {
  const next = { hidden: [...(cfg.hidden || [])], labels: { ...(cfg.labels || {}) }, lastUpdateId: cfg.lastUpdateId || '' };
  for (const o of ops) {
    if (o.op === 'hide') { if (!next.hidden.includes(o.feature)) next.hidden.push(o.feature); }
    else if (o.op === 'show') next.hidden = next.hidden.filter(f => f !== o.feature);
    else if (o.op === 'relabel') next.labels[o.feature] = o.label;
  }
  return next;
}
function validatePackageText(text) {
  const kind = detectKind(text);
  if (kind === 'html') {
    if (isFullAppHtml(text)) { validateAppHtml(text); return 'app'; }
    validateFeatureHtml(text); return 'html';
  }
  if (kind === 'config') { parseConfigPackage(text); return 'config'; }
  if (!text.trimStart().startsWith('{')) throw new Error('Unsupported file type. Upload an .html or .htm file, or a .json update package.');
  parsePackage(text);
  return 'files';
}
function setPackage(up, pkg) {
  let text = String(pkg.text || '');
  let kind = validatePackageText(text);
  up.appFile = false;
  if (kind === 'app') { text = buildAppPackage(text); kind = 'files'; up.appFile = true; }
  if (kind === 'files') parsePackage(text);
  up.kind = kind;
  fs.writeFileSync(path.join(UPDATES_DIR, up.id + '.json'), text, 'utf8');
  up.packageName = String(pkg.name || 'update.json').slice(0, 200);
  up.packageSize = Buffer.byteLength(text);
  up.packageSha256 = sha256Hex(Buffer.from(text));
}
function adminUpdateView(up) {
  const targets = up.targetSchools === 'ALL' ? db.schools : db.schools.filter(s => (up.targetSchools || []).includes(s.schoolId));
  const dl = up.deliveries || {};
  return {
    id: up.id, title: up.title, description: up.description, updateType: up.updateType, version: up.version, kind: up.kind || 'files', appFile: !!up.appFile,
    targetSchools: up.targetSchools, status: up.status, createdAt: up.createdAt, publishedAt: up.publishedAt,
    packageName: up.packageName, packageSize: up.packageSize, packageSha256: up.packageSha256,
    schoolStatus: targets.map(s => { const d = dl[s.schoolId] || {}; return { schoolId: s.schoolId, schoolName: s.schoolName, status: d.status || 'Pending', at: d.at || '', error: d.error || '' }; })
  };
}


function licenseFor(s) {
  const exp = new Date(s.subscriptionExpiry+'T23:59:59Z').getTime();
  const active = s.status === 'Active' && s.accountStatus !== 'Locked' && (s.plan === 'Free' || s.paymentStatus === 'Paid') && exp >= Date.now();
  const payload = {
    type:'school-license',
    schoolId:s.schoolId,
    accountId:s.id,
    status: active ? 'Active' : (s.status==='Blocked' ? 'Blocked' : 'Expired'),
    applicationVersion:s.applicationVersion,
    expiresAt:s.subscriptionExpiry+'T23:59:59Z',
    issuedAt:new Date().toISOString(),
    checkAfter:new Date(Date.now()+24*3600e3).toISOString()
  };
  return {token:signToken(payload), payload};
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
function serveStatic(file,res){
  if(!fs.existsSync(file)) return false;
  res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});
  fs.createReadStream(file).pipe(res); return true;
}
const server = http.createServer(async (req,res)=>{
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=url.parse(req.url,true);
  try {
    if(!u.pathname.startsWith('/api/')) {
      if(u.pathname==='/super-admin' || u.pathname==='/super-admin/') return serveStatic(path.join(__dirname,'admin.html'),res);
      if(u.pathname==='/bridge.js') return serveStatic(path.join(__dirname,'bridge.js'),res);
      if(u.pathname==='/' || u.pathname==='/app' || u.pathname==='/app/') return serveStatic(path.join(__dirname,'..','app','index.html'),res);
    }
    if(u.pathname==='/api/health') return json(res,200,{ok:true,time:new Date().toISOString()});
    if(u.pathname==='/api/admin/login' && req.method==='POST'){
      const b=await body(req);
      if(String(b.username)!==ADMIN_USER || !constantTimeStringEqual(String(b.password||''),String(ADMIN_PASSWORD)))
        return json(res,401,{error:'Invalid Super Admin credentials.'});
      return json(res,200,{token:signToken({role:'super-admin',sub:ADMIN_USER,iat:Date.now()})});
    }
    if(u.pathname==='/api/school/login' && req.method==='POST'){
      const b=await body(req);
      const username=String(b.username||'').trim().toLowerCase();
      const s=db.schools.find(x=>String(x.username||'').trim().toLowerCase()===username || String(x.schoolId||'').trim().toLowerCase()===username);
      if(!s || !passwordMatches(b.password,s.passwordHash)) return json(res,401,{error:'Incorrect school login ID or password.'});
      if(s.accountStatus==='Locked' || s.status==='Blocked') return json(res,403,{error:'This school account is locked. Contact your software administrator.'});
      const lic=licenseFor(s);
      if(lic.payload.status!=='Active') return json(res,403,{error:'Subscription inactive. Contact your software administrator to renew or activate it.',license:lic.payload});
      audit('School login successful',s.id,{username:s.username});
      const token=signToken({role:'school',schoolId:s.schoolId,sub:s.id,exp:Date.now()+12*3600e3});
      return json(res,200,{ok:true,token,school:{id:s.id,schoolId:s.schoolId,schoolName:s.schoolName,username:s.username},license:lic});
    }
    if(u.pathname==='/api/license/verify' && req.method==='POST'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const lic=licenseFor(school);
      const updates=lic.payload.status==='Active' ? db.updates.filter(x=>eligibleFor(x,school)).map(publicUpdate) : [];
      return json(res,200,{...lic,updates,serverTime:new Date().toISOString()});
    }
    if(u.pathname==='/api/license/public-key' && req.method==='GET'){
      return json(res,200,{publicKey:fs.readFileSync(path.join(__dirname,'public.pem'),'utf8')});
    }
    const spk=u.pathname.match(/^\/api\/school\/updates\/([^/]+)\/package$/);
    if(spk && req.method==='GET'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const up=db.updates.find(x=>x.id===spk[1]);
      if(!eligibleFor(up,school) || licenseFor(school).payload.status!=='Active') return json(res,404,{error:'No update available for this school.'});
      const text=fs.readFileSync(path.join(UPDATES_DIR,up.id+'.json'),'utf8');
      setDelivery(up,school.schoolId,'Downloaded'); saveDb();
      return json(res,200,{updateId:up.id,manifestToken:up.manifestToken,package:text});
    }
    if(u.pathname==='/api/local/apply-update' && req.method==='POST'){
      const ra=req.socket.remoteAddress||'';
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ra)) return json(res,403,{error:'Updates can only be installed from the school computer.'});
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const b=await body(req,30e6);
      const up=db.updates.find(x=>x.id===String(b.updateId||''));
      const mp=verifyToken(String(b.manifestToken||''),'update');
      if(!up || !mp || mp.updateId!==up.id) return json(res,400,{error:'The update signature is not valid.'});
      if(!eligibleFor(up,school)) return json(res,404,{error:'No update available for this school.'});
      if((up.kind||'files')!=='files') return json(res,400,{error:'This update is not a file package. Install it from the app.'});
      const text=String(b.package||'');
      if(sha256Hex(Buffer.from(text))!==mp.sha256) return json(res,400,{error:'The update package does not match its signature.'});
      setDelivery(up,school.schoolId,'Installing'); saveDb();
      try{
        const files=parsePackage(text);
        const r=applyPackage(files);
        setDelivery(up,school.schoolId,'Installed'); saveDb();
        audit('Update installed',school.id,{updateId:up.id,version:up.version});
        return json(res,200,{ok:true,version:up.version,installedFiles:r.files});
      }catch(e){
        setDelivery(up,school.schoolId,'Failed',String(e.message).slice(0,500)); saveDb();
        audit('Update failed',school.id,{updateId:up.id,error:e.message});
        return json(res,500,{error:e.message,rolledBack:!!e.rolledBack});
      }
    }
    if(u.pathname==='/api/school/config' && req.method==='GET'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      return json(res,200,{config:school.appConfig||emptyConfig()});
    }
    if(u.pathname==='/api/school/features' && req.method==='GET'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      return json(res,200,{features:(school.features||[]).map(f=>({updateId:f.updateId,title:f.title}))});
    }
    const fhm=u.pathname.match(/^\/api\/school\/features\/([^/]+)\/html$/);
    if(fhm && req.method==='GET'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const f=(school.features||[]).find(x=>x.updateId===fhm[1]);
      if(!f||licenseFor(school).payload.status!=='Active') return json(res,404,{error:'Feature not installed for this school.'});
      return json(res,200,{title:f.title,html:fs.readFileSync(path.join(UPDATES_DIR,f.updateId+'.json'),'utf8')});
    }
    const fst=u.pathname.match(/^\/api\/school\/features\/([^/]+)\/storage$/);
    if(fst && req.method==='POST'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const f=(school.features||[]).find(x=>x.updateId===fst[1]);
      if(!f) return json(res,404,{error:'Feature not installed for this school.'});
      const b=await body(req);
      const key=String(b.key||'');
      if(!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return json(res,400,{error:'Storage key must be 1 to 64 letters, numbers, dots, dashes or underscores.'});
      db.featureStorage=db.featureStorage||{};
      const bucket=((db.featureStorage[school.schoolId]=db.featureStorage[school.schoolId]||{})[f.updateId]=db.featureStorage[school.schoolId][f.updateId]||{});
      if(b.op==='get') return json(res,200,{value:Object.prototype.hasOwnProperty.call(bucket,key)?bucket[key]:null});
      if(b.op==='delete'){ delete bucket[key]; saveDb(); return json(res,200,{ok:true}); }
      if(b.op==='set'){
        const value=String(b.value==null?'':b.value);
        if(value.length>65536) return json(res,400,{error:'A stored value can be at most 64 KB.'});
        if(!Object.prototype.hasOwnProperty.call(bucket,key)&&Object.keys(bucket).length>=100) return json(res,400,{error:'This feature can store at most 100 keys.'});
        bucket[key]=value; saveDb(); return json(res,200,{ok:true});
      }
      return json(res,400,{error:'Unsupported storage operation.'});
    }
    const ifm=u.pathname.match(/^\/api\/school\/updates\/([^/]+)\/install-feature$/);
    if(ifm && req.method==='POST'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const up=db.updates.find(x=>x.id===ifm[1]);
      if(!eligibleFor(up,school) || (up.kind||'files')!=='html') return json(res,404,{error:'No update available for this school.'});
      if(licenseFor(school).payload.status!=='Active') return json(res,403,{error:'Subscription inactive.'});
      const text=fs.readFileSync(path.join(UPDATES_DIR,up.id+'.json'),'utf8');
      if(sha256Hex(Buffer.from(text))!==up.packageSha256) return json(res,500,{error:'The stored update file is damaged. It was not installed.'});
      try{
        validateFeatureHtml(text);
        school.features=(school.features||[]).filter(f=>f.updateId!==up.id);
        school.features.push({updateId:up.id,title:up.title,installedAt:new Date().toISOString()});
        setDelivery(up,school.schoolId,'Installed'); saveDb();
        audit('Feature installed',school.id,{updateId:up.id,title:up.title});
        return json(res,200,{ok:true,features:school.features.map(f=>({updateId:f.updateId,title:f.title}))});
      }catch(e){
        setDelivery(up,school.schoolId,'Failed',String(e.message).slice(0,500)); saveDb();
        audit('Feature install failed',school.id,{updateId:up.id,error:e.message});
        return json(res,400,{error:e.message});
      }
    }
    const acm=u.pathname.match(/^\/api\/school\/updates\/([^/]+)\/apply-config$/);
    if(acm && req.method==='POST'){
      const school=schoolFromReq(req);
      if(!school) return json(res,401,{error:'School authorization required.'});
      const up=db.updates.find(x=>x.id===acm[1]);
      if(!eligibleFor(up,school) || (up.kind||'files')!=='config') return json(res,404,{error:'No update available for this school.'});
      if(licenseFor(school).payload.status!=='Active') return json(res,403,{error:'Subscription inactive.'});
      const text=fs.readFileSync(path.join(UPDATES_DIR,up.id+'.json'),'utf8');
      if(sha256Hex(Buffer.from(text))!==up.packageSha256) return json(res,500,{error:'The stored update file is damaged. It was not applied.'});
      try{
        const ops=parseConfigPackage(text);
        const before=school.appConfig||emptyConfig();
        const next=applyConfigOps(before,ops);
        next.lastUpdateId=up.id;
        school.appConfigPrev=before;
        school.appConfig=next;
        setDelivery(up,school.schoolId,'Installed'); saveDb();
        audit('Configuration update applied',school.id,{updateId:up.id});
        return json(res,200,{ok:true,config:next});
      }catch(e){
        setDelivery(up,school.schoolId,'Failed',String(e.message).slice(0,500)); saveDb();
        audit('Configuration update failed',school.id,{updateId:up.id,error:e.message});
        return json(res,400,{error:e.message});
      }
    }
    if(!admin(req)) return json(res,401,{error:'Super Admin authorization required.'});

    if(u.pathname==='/api/dashboard' && req.method==='GET'){
      const today=Date.now(), soon=Date.now()+7*864e5;
      const stats={
        totalSchools:db.schools.length,
        activeSchools:db.schools.filter(s=>s.status==='Active' && new Date(s.subscriptionExpiry+'T23:59:59Z').getTime()>=today).length,
        expiredSchools:db.schools.filter(s=>new Date(s.subscriptionExpiry+'T23:59:59Z').getTime()<today).length,
        blockedSchools:db.schools.filter(s=>s.status==='Blocked').length,
        pendingPayments:db.schools.filter(s=>s.paymentStatus!=='Paid').length,
        expiringSoon:db.schools.filter(s=>{const t=new Date(s.subscriptionExpiry+'T23:59:59Z').getTime();return t>=today&&t<=soon}).length,
        availableUpdates:db.updates.filter(x=>x.status==='Published').length
      };
      return json(res,200,{stats,schools:db.schools.map(publicSchool),updates:db.updates.map(adminUpdateView),activity:db.activity.slice(0,100)});
    }
    if(u.pathname==='/api/schools' && req.method==='GET') return json(res,200,{schools:db.schools.map(publicSchool)});
    if(u.pathname==='/api/schools' && req.method==='POST'){
      const b=await body(req);
      const input={...b};
      if(!String(input.schoolName||'').trim()) return json(res,400,{error:'School Name is required.'});
      if(!String(input.username||'').trim()) return json(res,400,{error:'School login username is required.'});
      if(String(input.password||'').length<8) return json(res,400,{error:'Password must be at least 8 characters.'});
      if(input.password!==input.confirmPassword) return json(res,400,{error:'Password and Confirm Password do not match.'});
      const generatedId = String(input.schoolId||'').trim() || ('SCH-'+crypto.randomBytes(4).toString('hex').toUpperCase());
      if(db.schools.some(x=>String(x.schoolId).toLowerCase()===generatedId.toLowerCase())) return json(res,409,{error:'School ID already exists.'});
      if(db.schools.some(x=>String(x.username||'').toLowerCase()===String(input.username).trim().toLowerCase())) return json(res,409,{error:'Username already exists.'});
      const plan=['Monthly','Yearly','Free','Days'].includes(input.plan)?input.plan:'Monthly';
      if(plan==='Days'){const n=Number(input.planDays);if(!Number.isInteger(n)||n<1||n>36500) return json(res,400,{error:'Enter the number of days (1 to 36500) for the Days plan.'});}
      const now=new Date().toISOString().slice(0,10);
      const start=input.subscriptionStart||now;
      const days=planLengthDays(plan,input.planDays);
      const expiry=input.subscriptionExpiry||(new Date(Date.now()+days*864e5).toISOString().slice(0,10));
      if(!validDate(start)||!validDate(expiry)||expiry<start) return json(res,400,{error:'Enter valid subscription dates. Expiry must be on or after the start date.'});
      if(plan==='Free') input.paymentStatus='Paid';
      const s=normalizeSchool({...input,schoolId:generatedId,plan,subscriptionStart:start,subscriptionExpiry:expiry,passwordHash:hashPassword(input.password)});
      if(!validDate(s.subscriptionStart)||!validDate(s.subscriptionExpiry)||s.subscriptionExpiry<s.subscriptionStart) return json(res,400,{error:'Enter valid subscription dates. Expiry must be on or after the start date.'});
      delete s.password;
      db.schools.push(s); audit('School created',s.id,{schoolName:s.schoolName}); return json(res,201,{school:publicSchool(s)});
    }
    const sm=u.pathname.match(/^\/api\/schools\/([^/]+)$/);
    if(sm){
      const s=db.schools.find(x=>x.id===sm[1] || x.schoolId===sm[1]);
      if(!s) return json(res,404,{error:'School not found.'});
      if(req.method==='GET') return json(res,200,{school:publicSchool(s),updates:db.updates.filter(x=>x.targetSchools==='ALL'||x.targetSchools.includes(s.schoolId)),activity:db.activity.filter(a=>a.schoolId===s.id).slice(0,100)});
      if(req.method==='PATCH'){
        const b=await body(req);
        if(b.schoolId && db.schools.some(x=>x.id!==s.id&&String(x.schoolId).toLowerCase()===String(b.schoolId).toLowerCase())) return json(res,409,{error:'School ID already exists.'});
        if(b.username && db.schools.some(x=>x.id!==s.id&&String(x.username||'').toLowerCase()===String(b.username).toLowerCase())) return json(res,409,{error:'Username already exists.'});
        if(b.subscriptionStart||b.subscriptionExpiry){const st=b.subscriptionStart||s.subscriptionStart, ex=b.subscriptionExpiry||s.subscriptionExpiry;if(!validDate(st)||!validDate(ex)||ex<st)return json(res,400,{error:'Enter valid subscription dates. Expiry must be on or after the start date.'});}
        delete b.passwordHash; delete b.password; delete b.confirmPassword;
        Object.assign(s,normalizeSchool({...s,...b,id:s.id,createdAt:s.createdAt,passwordHash:s.passwordHash})); audit('School updated',s.id,{changes:Object.keys(b)}); return json(res,200,{school:publicSchool(s)});
      }
    }
    const reset=u.pathname.match(/^\/api\/schools\/([^/]+)\/password$/);
    if(reset && req.method==='POST'){const s=db.schools.find(x=>x.id===reset[1]||x.schoolId===reset[1]);if(!s)return json(res,404,{error:'School not found.'});const b=await body(req);if(String(b.password||'').length<8)return json(res,400,{error:'Password must be at least 8 characters.'});s.passwordHash=hashPassword(b.password);s.updatedAt=new Date().toISOString();audit('School password reset',s.id);saveDb();return json(res,200,{ok:true});}
    const action=u.pathname.match(/^\/api\/schools\/([^/]+)\/(block|unblock|renew)$/);
    if(action && req.method==='POST'){
      const s=db.schools.find(x=>x.id===action[1]||x.schoolId===action[1]); if(!s) return json(res,404,{error:'School not found.'});
      const b=await body(req);
      if(action[2]==='block'){s.status='Blocked';s.accountStatus='Locked'; audit('School blocked',s.id);}
      if(action[2]==='unblock'){s.status='Active';s.accountStatus='Active'; audit('School unblocked',s.id);}
      if(action[2]==='renew'){
        const defaultDays=planLengthDays(s.plan,s.planDays); const days=Math.max(1,Math.min(36500,Number(b.days||defaultDays))); const base=Math.max(Date.now(),new Date(s.subscriptionExpiry+'T23:59:59Z').getTime());
        s.subscriptionExpiry=new Date(base+days*864e5).toISOString().slice(0,10); s.paymentStatus='Paid'; s.status='Active'; audit('Subscription renewed',s.id,{days});
      }
      s.updatedAt=new Date().toISOString(); saveDb(); return json(res,200,{school:publicSchool(s)});
    }
    if(u.pathname==='/api/updates' && req.method==='GET') return json(res,200,{updates:db.updates.map(adminUpdateView)});
    if(u.pathname==='/api/updates' && req.method==='POST'){
      const b=await body(req,30e6);
      const title=String(b.title||'').trim();
      if(!title) return json(res,400,{error:'Update Title is required.'});
      if(!UPDATE_TYPES.includes(b.updateType)) return json(res,400,{error:'Choose an Update Type.'});
      const tg=parseTargets(b.targetSchools); if(tg.error) return json(res,400,{error:tg.error});
      const up={id:id('upd'),title,description:String(b.description||'').trim(),updateType:b.updateType,version:String(b.version||'').trim(),targetSchools:tg.value,status:'Draft',createdAt:new Date().toISOString(),publishedAt:null,packageName:'',packageSize:0,packageSha256:'',manifestToken:'',deliveries:{}};
      if(b.package && typeof b.package.text==='string'){ try{ setPackage(up,b.package); }catch(e){ return json(res,400,{error:e.message}); } }
      db.updates.unshift(up); audit('Update draft created',null,{updateId:up.id,title}); saveDb();
      return json(res,201,{update:adminUpdateView(up)});
    }
    const rmf=u.pathname.match(/^\/api\/schools\/([^/]+)\/features\/([^/]+)\/remove$/);
    if(rmf && req.method==='POST'){
      const sc=db.schools.find(x=>x.id===rmf[1]||x.schoolId===rmf[1]);
      if(!sc) return json(res,404,{error:'School not found.'});
      const before=(sc.features||[]).length;
      sc.features=(sc.features||[]).filter(f=>f.updateId!==rmf[2]);
      if(sc.features.length===before) return json(res,404,{error:'That feature is not installed for this school.'});
      const up=db.updates.find(x=>x.id===rmf[2]);
      if(up) setDelivery(up,sc.schoolId,'RolledBack');
      audit('Feature removed',sc.id,{updateId:rmf[2]}); saveDb();
      return json(res,200,{features:sc.features});
    }
    const rbk=u.pathname.match(/^\/api\/schools\/([^/]+)\/config\/rollback$/);
    if(rbk && req.method==='POST'){
      const sc=db.schools.find(x=>x.id===rbk[1]||x.schoolId===rbk[1]);
      if(!sc) return json(res,404,{error:'School not found.'});
      if(!sc.appConfigPrev) return json(res,409,{error:'There is no configuration change to roll back.'});
      const lastId=(sc.appConfig&&sc.appConfig.lastUpdateId)||'';
      sc.appConfig=sc.appConfigPrev; sc.appConfigPrev=null;
      const lastUp=db.updates.find(x=>x.id===lastId);
      if(lastUp) setDelivery(lastUp,sc.schoolId,'RolledBack');
      audit('Configuration rolled back',sc.id,{updateId:lastId}); saveDb();
      return json(res,200,{config:sc.appConfig});
    }
    const um=u.pathname.match(/^\/api\/updates\/([^/]+)$/);
    if(um){
      const up=db.updates.find(x=>x.id===um[1]); if(!up) return json(res,404,{error:'Update not found.'});
      if(req.method==='GET') return json(res,200,{update:adminUpdateView(up)});
      if(req.method==='PATCH'){
        if(up.status!=='Draft') return json(res,409,{error:'Only drafts can be edited. Disable a published update instead.'});
        const b=await body(req,30e6);
        // Validate everything before changing anything, so a rejected edit leaves the draft untouched.
        const next={};
        if(b.title!==undefined){ next.title=String(b.title).trim(); if(!next.title) return json(res,400,{error:'Update Title is required.'}); }
        if(b.updateType!==undefined){ if(!UPDATE_TYPES.includes(b.updateType)) return json(res,400,{error:'Choose an Update Type.'}); next.updateType=b.updateType; }
        if(b.targetSchools!==undefined){ const tg=parseTargets(b.targetSchools); if(tg.error) return json(res,400,{error:tg.error}); next.targetSchools=tg.value; }
        if(b.package && typeof b.package.text==='string'){ try{ validatePackageText(b.package.text); }catch(e){ return json(res,400,{error:e.message}); } }
        if(next.title!==undefined) up.title=next.title;
        if(b.description!==undefined) up.description=String(b.description).trim();
        if(next.updateType!==undefined) up.updateType=next.updateType;
        if(b.version!==undefined) up.version=String(b.version).trim();
        if(next.targetSchools!==undefined) up.targetSchools=next.targetSchools;
        if(b.package && typeof b.package.text==='string') setPackage(up,b.package);
        up.updatedAt=new Date().toISOString(); audit('Update draft edited',null,{updateId:up.id}); saveDb();
        return json(res,200,{update:adminUpdateView(up)});
      }
      if(req.method==='DELETE'){
        if(up.status!=='Draft') return json(res,409,{error:'Only drafts can be deleted. Disable a published update instead.'});
        fs.rmSync(path.join(UPDATES_DIR,up.id+'.json'),{force:true});
        db.updates=db.updates.filter(x=>x!==up); audit('Update draft deleted',null,{updateId:up.id}); saveDb();
        return json(res,200,{ok:true});
      }
    }
    const pm=u.pathname.match(/^\/api\/updates\/([^/]+)\/publish$/);
    if(pm && req.method==='POST'){
      const up=db.updates.find(x=>x.id===pm[1]); if(!up) return json(res,404,{error:'Update not found.'});
      if(up.status!=='Draft') return json(res,409,{error:'Only drafts can be published.'});
      if(!up.packageSha256) return json(res,400,{error:'Attach an update package file before publishing.'});
      up.status='Published'; up.publishedAt=new Date().toISOString();
      up.manifestToken=signToken({role:'update',updateId:up.id,version:up.version||'',sha256:up.packageSha256,publishedAt:up.publishedAt});
      audit('Update published',null,{updateId:up.id,targetSchools:up.targetSchools}); saveDb();
      return json(res,200,{update:adminUpdateView(up)});
    }
    const dm=u.pathname.match(/^\/api\/updates\/([^/]+)\/disable$/);
    if(dm && req.method==='POST'){
      const up=db.updates.find(x=>x.id===dm[1]); if(!up) return json(res,404,{error:'Update not found.'});
      if(up.status!=='Published') return json(res,409,{error:'Only published updates can be disabled.'});
      up.status='Disabled'; audit('Update disabled',null,{updateId:up.id}); saveDb();
      return json(res,200,{update:adminUpdateView(up)});
    }
    return json(res,404,{error:'Not found.'});
  } catch(e) { console.error(e); return json(res,500,{error:'Server error.'}); }
});

server.listen(PORT,HOST,()=>console.log(`School SaaS server: http://${HOST}:${PORT}`));
