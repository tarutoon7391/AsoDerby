// ブロック馬 競馬シミュ オンライン版サーバー
// ・public/index.html(ゲーム本体)を配信
// ・馬券ランキング：各プレイヤーの馬券成績を集計して保存
// ・対戦：ルームに集まり、ホストが組んだレースを全員に配信。全員が同じ着順のレースを観る
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // Railwayでボリュームを付けるならそのパスを指定
const FILE = path.join(DATA_DIR, 'db.json');
const OLD_FILE = path.join(DATA_DIR, 'players.json');
const SAVE_MAX = 600 * 1024;   // 牧場データの上限(バイト)
const BET_SEC = 45;            // 対戦レースの馬券購入時間(秒)
const ROOM_MAX = 8;            // 1ルームの最大人数
const N_HORSE = 16;

const app = express();
app.set('trust proxy', 1);          // Railwayなどのプロキシ越しでも接続元IPを正しく取る
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.json({ limit: '700kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== プレイヤーデータ(ランキング) =====
// players: pid -> { pid, name, 成績..., (アカウントなら) pass:{salt,hash}, tokens:[], save:{牧場データ}, created }
let players = {};
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { players = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { try { players = JSON.parse(fs.readFileSync(OLD_FILE, 'utf8')); } catch (e2) { players = {}; } }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(players), err => { if (err) console.error('save failed', err.message); }), 500);
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
function getPlayer(pid, name) {
  if (!players[pid]) players[pid] = { pid, name: '', bet: 0, pay: 0, hits: 0, n: 0, best: 0, vsWins: 0, vsRaces: 0, seen: 0 };
  const p = players[pid];
  if (name) p.name = cleanName(name);
  p.seen = Date.now();
  return p;
}
const pubStats = p => ({ pid: p.pid, name: p.name, bet: p.bet, pay: p.pay, hits: p.hits, n: p.n, best: p.best, vsWins: p.vsWins, vsRaces: p.vsRaces,
  st: !!p.st, g1: p.g1 || 0, lg: p.lg || 0, top: p.top || null });
const ranking = () => Object.values(players).filter(p => p.name && (p.n || p.vsRaces || p.st)).map(pubStats);

// ===== アカウント(ユーザーID・プレイヤー名・パスワード) =====
// パスワードはscryptでハッシュ化して保存。ログインするとトークンを発行し、クライアントはそれを持って保存・読込する
const UID_RE = /^[a-zA-Z0-9_]{3,16}$/;
const uidKey = uid => String(uid || '').toLowerCase();
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const tokenOwner = {};                                   // token -> pid (起動時に再構築)
for (const p of Object.values(players)) for (const t of p.tokens || []) tokenOwner[t] = p.pid;
function issueToken(p) {
  const t = crypto.randomBytes(24).toString('hex');
  p.tokens = (p.tokens || []).slice(-9); p.tokens.push(t); tokenOwner[t] = p.pid; save();
  return t;
}
const userOf = req => { const t = req.get('X-Token') || req.query.token; const pid = t && tokenOwner[t]; return pid && players[pid] && players[pid].pass ? players[pid] : null; };
const userView = p => ({ uid: p.pid, name: p.name, save: p.save || null });
// ログイン試行の制限(同じIPから連続で失敗したら少し待たせる)
const fails = {};
function tooMany(ip) { const f = fails[ip]; return f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000; }
function failed(ip) { const f = fails[ip] || (fails[ip] = { n: 0, t: 0 }); f.n++; f.t = Date.now(); }

app.post('/api/register', (req, res) => {
  const { uid, name, pass, save: sv } = req.body || {};
  if (!UID_RE.test(uid || '')) return res.status(400).json({ error: 'ユーザーIDは半角英数字と_で3〜16文字' });
  const nm = cleanName(name); if (!nm) return res.status(400).json({ error: 'プレイヤー名を入れてね' });
  if (typeof pass !== 'string' || pass.length < 4 || pass.length > 64) return res.status(400).json({ error: 'パスワードは4〜64文字' });
  const key = uidKey(uid);
  if (players[key] && players[key].pass) return res.status(409).json({ error: 'そのユーザーIDはもう使われています' });
  const salt = crypto.randomBytes(16).toString('hex');
  const p = getPlayer(key);
  Object.assign(p, { pid: key, name: nm, pass: { salt, hash: hashPass(pass, salt) }, tokens: [], created: Date.now() });
  if (sv && typeof sv === 'object' && Array.isArray(sv.horses) && JSON.stringify(sv).length <= SAVE_MAX) p.save = sv;
  const token = issueToken(p);
  res.json({ ok: true, token, user: userView(p) });
});
app.post('/api/login', (req, res) => {
  const ip = req.ip; if (tooMany(ip)) return res.status(429).json({ error: '失敗が続いたので10分ほど待ってね' });
  const { uid, pass } = req.body || {};
  const p = players[uidKey(uid)];
  if (!p || !p.pass || hashPass(pass || '', p.pass.salt) !== p.pass.hash) { failed(ip); return res.status(401).json({ error: 'ユーザーIDかパスワードが違います' }); }
  delete fails[ip];
  p.seen = Date.now();
  res.json({ ok: true, token: issueToken(p), user: userView(p) });
});
app.get('/api/me', (req, res) => { const p = userOf(req); res.json({ user: p ? userView(p) : null }); });
app.post('/api/save', (req, res) => {
  const p = userOf(req); if (!p) return res.status(401).json({ error: 'ログインしていません' });
  const sv = req.body && req.body.save;
  if (!sv || typeof sv !== 'object' || !Array.isArray(sv.horses)) return res.status(400).json({ error: 'データが不正です' });
  if (JSON.stringify(sv).length > SAVE_MAX) return res.status(413).json({ error: 'データが大きすぎます' });
  p.save = sv; p.seen = Date.now(); save();
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const t = req.get('X-Token'), p = userOf(req);
  if (p && t) { p.tokens = (p.tokens || []).filter(x => x !== t); delete tokenOwner[t]; save(); }
  res.json({ ok: true });
});

// ===== 対戦ルーム =====
const rooms = {};   // code -> { code, host(pid), state, members: Map<socketId, {pid,name,horse}>, spec, ready:Set, timer }
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms[c]); return c; };
const roomView = r => ({ code: r.code, host: r.host, state: r.state, members: [...r.members.values()].map(m => ({ pid: m.pid, name: m.name, horse: m.horse })) });   // ホストがレースを組むので馬データは全員に渡す
const emitRoom = r => io.to(r.code).emit('room', roomView(r));
// 馬データは見た目と能力だけ受け取る(余計なものは捨てる)
function cleanHorse(h) {
  if (!h || typeof h !== 'object' || !h.st) return null;
  const st = {}; for (const k of ['spd', 'sta', 'brs', 'gut', 'hlt', 'turf', 'dirt', 'rain']) st[k] = Math.max(0, Math.min(999, +h.st[k] || 0));   // 能力に100の天井はない
  return { name: cleanName(h.name) || '名無し', style: String(h.style || '先行').slice(0, 8), coat: +h.coat || 0, mane: +h.mane || 0, silk: +h.silk || 0,
    socks: Array.isArray(h.socks) ? h.socks.slice(0, 4).map(String) : [], blaze: !!h.blaze, st, cond: Math.max(0, Math.min(4, +h.cond || 0)),
    coatName: String(h.coatName || '').slice(0, 8), sex: h.sex === '牝' ? '牝' : '牡' };
}
function leaveRoom(sock) {
  const code = sock.data.room; if (!code) return;
  const r = rooms[code]; sock.data.room = null; sock.leave(code);
  if (!r) return;
  r.members.delete(sock.id); r.ready.delete(sock.id);
  if (!r.members.size) { clearTimeout(r.timer); delete rooms[code]; return; }
  if (![...r.members.values()].some(m => m.pid === r.host)) r.host = r.members.values().next().value.pid;   // ホストが抜けたら次の人
  if (r.state === 'betting' && r.ready.size >= r.members.size) goRace(r);
  emitRoom(r);
}
function goRace(r) {
  if (r.state !== 'betting') return;
  clearTimeout(r.timer); r.state = 'race';
  io.to(r.code).emit('go');
  r.timer = setTimeout(() => { if (r.state === 'race') { r.state = 'lobby'; emitRoom(r); } }, 10 * 60 * 1000);   // 結果が来なくても10分で戻す
  emitRoom(r);
}

io.on('connection', sock => {
  sock.data = { pid: null, room: null };

  sock.on('hello', d => {
    if (!d) return;
    const tokPid = d.token && tokenOwner[d.token];
    let pid = tokPid || String(d.pid || '').slice(0, 40); if (!pid) return;
    if (!tokPid && players[pid] && players[pid].pass) return sock.emit('err', 'ログインが必要です');   // アカウントのIDをゲストが名乗ることはできない
    sock.data.pid = pid;
    const p = getPlayer(pid, tokPid ? (d.name || players[pid].name) : d.name); save();
    sock.emit('me', pubStats(p));
  });
  // G1・レジェンドの勝利数と最強馬(クライアントが保存のたびに送る)
  sock.on('stats', d => {
    if (!sock.data.pid || !d) return;
    const p = getPlayer(sock.data.pid);
    p.st = true; p.g1 = Math.max(0, Math.min(1e6, Math.floor(+d.g1 || 0))); p.lg = Math.max(0, Math.min(1e6, Math.floor(+d.lg || 0)));
    const t = d.top && typeof d.top === 'object' ? d.top : null;
    p.top = t && t.name ? { name: String(t.name).slice(0, 20), prize: Math.max(0, Math.min(1e13, Math.floor(+t.prize || 0))) } : null;
    save();
  });
  sock.on('setName', name => {
    if (!sock.data.pid) return;
    const p = getPlayer(sock.data.pid, name); save();
    const r = rooms[sock.data.room]; if (r && r.members.get(sock.id)) { r.members.get(sock.id).name = p.name; emitRoom(r); }
    sock.emit('me', pubStats(p));
  });
  sock.on('getRanking', () => sock.emit('ranking', ranking()));

  // 馬券の成績(1レース分)
  sock.on('report', d => {
    if (!sock.data.pid || !d) return;
    const bet = Math.max(0, Math.min(1e12, +d.bet || 0)), pay = Math.max(0, Math.min(1e13, +d.pay || 0));
    const p = getPlayer(sock.data.pid);
    p.bet += bet; p.pay += pay; p.hits += Math.max(0, Math.min(100, +d.hits || 0)); p.n += Math.max(0, Math.min(100, +d.n || 0));
    p.best = Math.max(p.best, Math.max(0, Math.min(1e13, +d.best || 0)));
    save();
  });

  // ---- 対戦 ----
  sock.on('createRoom', d => {
    if (!sock.data.pid) return;
    leaveRoom(sock);
    const code = newCode(), p = getPlayer(sock.data.pid);
    const r = rooms[code] = { code, host: p.pid, state: 'lobby', members: new Map(), spec: null, ready: new Set(), timer: null };
    r.members.set(sock.id, { pid: p.pid, name: p.name, horse: cleanHorse(d && d.horse) });
    sock.join(code); sock.data.room = code;
    emitRoom(r);
  });
  sock.on('joinRoom', d => {
    if (!sock.data.pid || !d) return;
    const code = String(d.code || '').toUpperCase().trim(), r = rooms[code];
    if (!r) return sock.emit('err', 'そのコードのルームはありません');
    if (r.state !== 'lobby') return sock.emit('err', 'レース中のルームには入れません。少し待ってね');
    if (r.members.size >= ROOM_MAX) return sock.emit('err', 'ルームが満員です');
    leaveRoom(sock);
    const p = getPlayer(sock.data.pid);
    r.members.set(sock.id, { pid: p.pid, name: p.name, horse: cleanHorse(d.horse) });
    sock.join(code); sock.data.room = code;
    emitRoom(r);
  });
  sock.on('setHorse', h => {
    const r = rooms[sock.data.room], m = r && r.members.get(sock.id);
    if (!m || r.state !== 'lobby') return;
    m.horse = cleanHorse(h); emitRoom(r);
  });
  sock.on('leaveRoom', () => leaveRoom(sock));

  // ホストがレースを組んで送ってくる → 全員に配信して購入時間スタート
  sock.on('startRace', d => {
    const r = rooms[sock.data.room];
    if (!r || r.host !== sock.data.pid || r.state !== 'lobby' || !d || !d.spec) return;
    const spec = d.spec;
    if (!Array.isArray(spec.horses) || spec.horses.length !== N_HORSE || !Array.isArray(spec.planOrder) || spec.planOrder.length !== N_HORSE) return sock.emit('err', 'レースデータが不正です');
    const pids = new Set([...r.members.values()].map(m => m.pid));
    spec.horses.forEach(h => { if (h.pid && !pids.has(h.pid)) h.pid = null; });
    r.spec = spec; r.state = 'betting'; r.ready = new Set();
    io.to(r.code).emit('raceSpec', { spec, betSec: BET_SEC });
    clearTimeout(r.timer); r.timer = setTimeout(() => goRace(r), BET_SEC * 1000 + 1500);
    emitRoom(r);
  });
  sock.on('ready', () => {
    const r = rooms[sock.data.room];
    if (!r || r.state !== 'betting' || !r.members.has(sock.id)) return;
    r.ready.add(sock.id);
    if (r.ready.size >= r.members.size) goRace(r);
  });
  // ホストのレースが終わった → 参加者ごとの着順を集計して全員へ
  sock.on('raceResult', d => {
    const r = rooms[sock.data.room];
    if (!r || r.host !== sock.data.pid || r.state !== 'race' || !r.spec || !d || !Array.isArray(d.order)) return;
    const order = d.order.map(Number);
    const res = [];
    for (const m of r.members.values()) {
      const idx = r.spec.horses.findIndex(h => h.pid === m.pid);
      if (idx < 0) continue;
      res.push({ pid: m.pid, name: m.name, horse: r.spec.horses[idx].name, pos: order.indexOf(idx) + 1 });
    }
    res.sort((a, b) => a.pos - b.pos);
    res.forEach((x, k) => { const p = getPlayer(x.pid); p.vsRaces++; if (k === 0 && res.length > 1) p.vsWins++; });
    save();
    clearTimeout(r.timer); r.state = 'lobby'; r.spec = null;
    io.to(r.code).emit('vsResult', res);
    emitRoom(r);
  });

  sock.on('disconnect', () => leaveRoom(sock));
});

server.listen(PORT, () => console.log(`ブロック馬 オンライン版 起動: http://localhost:${PORT}`));
