// ブロック馬 競馬シミュ オンライン版サーバー
// ・public/index.html(ゲーム本体)を配信
// ・馬券ランキング：各プレイヤーの馬券成績を集計して保存
// ・対戦：ルームに集まり、ホストが組んだレースを全員に配信。全員が同じ着順のレースを観る
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // Railwayでボリュームを付けるならそのパスを指定
const FILE = path.join(DATA_DIR, 'players.json');
const BET_SEC = 45;            // 対戦レースの馬券購入時間(秒)
const ROOM_MAX = 8;            // 1ルームの最大人数
const N_HORSE = 16;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.static(path.join(__dirname, 'public')));

// ===== プレイヤーデータ(ランキング) =====
let players = {};
try { fs.mkdirSync(DATA_DIR, { recursive: true }); players = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { players = {}; }
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
const ranking = () => Object.values(players).filter(p => p.name && (p.n || p.vsRaces)).map(p => ({ pid: p.pid, name: p.name, bet: p.bet, pay: p.pay, hits: p.hits, n: p.n, best: p.best, vsWins: p.vsWins, vsRaces: p.vsRaces }));

// ===== 対戦ルーム =====
const rooms = {};   // code -> { code, host(pid), state, members: Map<socketId, {pid,name,horse}>, spec, ready:Set, timer }
const newCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; } while (rooms[c]); return c; };
const roomView = r => ({ code: r.code, host: r.host, state: r.state, members: [...r.members.values()].map(m => ({ pid: m.pid, name: m.name, horse: m.horse })) });   // ホストがレースを組むので馬データは全員に渡す
const emitRoom = r => io.to(r.code).emit('room', roomView(r));
// 馬データは見た目と能力だけ受け取る(余計なものは捨てる)
function cleanHorse(h) {
  if (!h || typeof h !== 'object' || !h.st) return null;
  const st = {}; for (const k of ['spd', 'sta', 'brs', 'gut', 'hlt', 'turf', 'dirt', 'rain']) st[k] = Math.max(0, Math.min(100, +h.st[k] || 0));
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
    const pid = String((d && d.pid) || '').slice(0, 40); if (!pid) return;
    sock.data.pid = pid;
    const p = getPlayer(pid, d.name); save();
    sock.emit('me', { pid: p.pid, name: p.name, bet: p.bet, pay: p.pay, hits: p.hits, n: p.n, best: p.best, vsWins: p.vsWins, vsRaces: p.vsRaces });
  });
  sock.on('setName', name => {
    if (!sock.data.pid) return;
    const p = getPlayer(sock.data.pid, name); save();
    const r = rooms[sock.data.room]; if (r && r.members.get(sock.id)) { r.members.get(sock.id).name = p.name; emitRoom(r); }
    sock.emit('me', p);
  });
  sock.on('getRanking', () => sock.emit('ranking', ranking()));

  // 馬券の成績(1レース分)
  sock.on('report', d => {
    if (!sock.data.pid || !d) return;
    const bet = Math.max(0, Math.min(1e8, +d.bet || 0)), pay = Math.max(0, Math.min(1e9, +d.pay || 0));
    const p = getPlayer(sock.data.pid);
    p.bet += bet; p.pay += pay; p.hits += Math.max(0, Math.min(100, +d.hits || 0)); p.n += Math.max(0, Math.min(100, +d.n || 0));
    p.best = Math.max(p.best, Math.max(0, Math.min(1e9, +d.best || 0)));
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
