'use strict';
/*
 * 지렁이 파티 — 멀티플레이 서버
 * - 6자리 숫자 방 코드로 입장 (없으면 새로 만들어짐)
 * - 방 인원 전원이 "준비완료"를 누르면 3초 카운트다운 후 시작
 * - 1명 ~ 30명
 * - 서버가 모든 게임 판정을 담당 (서버 권위 방식)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: false, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ───────── 설정값 ─────────
const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                                   // 초당 게임 업데이트 횟수
const MAX_PLAYERS = 30;                                 // 방 최대 인원
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 180; // 한 판 제한 시간
const COUNTDOWN = 3;                                    // 시작 전 카운트다운(초)
const START_MASS = 15;                                  // 시작 몸무게(점수)
const BASE_SPEED = 5;                                   // 기본 속도 (px/틱)
const BOOST_SPEED = 10;                                 // 부스트 속도
const MIN_BOOST_MASS = 12;                              // 이보다 작으면 부스트 불가

const lengthOf = (m) => 40 + m * 7;                     // 몸 길이(px)
const radiusOf = (m) => Math.min(8 + Math.sqrt(m) * 0.9, 30); // 몸 두께(반지름)

const rooms = new Map();

function sanitizeName(n) {
  n = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
  return n || '익명';
}

function pickHue(room) {
  const used = new Set([...room.players.values()].map((p) => p.hue));
  for (let i = 0; i < 60; i++) {
    const h = Math.round((i * 137.508) % 360);
    if (!used.has(h)) return h;
  }
  return Math.floor(Math.random() * 360);
}

function lobbyPayload(room) {
  return {
    code: room.code,
    state: room.state,
    countdown: room.countdown,
    max: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, hue: p.hue, ready: p.ready, waiting: p.waiting,
    })),
  };
}
function sendLobby(room) { io.to(room.code).emit('lobby', lobbyPayload(room)); }

function rosterPayload(room) {
  const g = room.game;
  return {
    radius: g.radius,
    tickRate: TICK_RATE,
    roundSeconds: ROUND_SECONDS,
    snakes: [...g.snakes.values()].map((s) => ({ i: s.idx, id: s.id, name: s.name, hue: s.hue })),
  };
}

// ───────── 소켓 연결 ─────────
io.on('connection', (socket) => {
  let room = null;

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = String((data && data.code) || '').trim();
    if (!/^\d{6}$/.test(code)) return ack({ ok: false, error: '방 코드는 숫자 6자리로 입력해 주세요.' });
    if (room) leaveRoom();

    let r = rooms.get(code);
    if (!r) {
      r = { code, players: new Map(), state: 'lobby', countdown: null, countdownTimer: null, game: null };
      rooms.set(code, r);
    }
    if (r.players.size >= MAX_PLAYERS) {
      if (r.players.size === 0) rooms.delete(code);
      return ack({ ok: false, error: `방이 가득 찼어요 (최대 ${MAX_PLAYERS}명).` });
    }
    const p = {
      id: socket.id, name: sanitizeName(data.name), hue: pickHue(r),
      ready: false, waiting: r.state === 'playing', socket,
      input: { a: 0, b: false }, view: { w: 1000, h: 800 },
    };
    r.players.set(socket.id, p);
    room = r;
    socket.join(code);
    ack({ ok: true, id: socket.id, code });
    if (r.state === 'playing' && r.game) socket.emit('start', rosterPayload(r)); // 진행 중이면 관전
    sendLobby(r);
  });

  socket.on('ready', (v) => {
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!v;
    checkStart(room);
    sendLobby(room);
  });

  socket.on('input', (d) => {
    if (!room || !d) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const a = Number(d.a);
    if (Number.isFinite(a)) p.input.a = a;
    p.input.b = !!d.b;
  });

  socket.on('view', (d) => {
    if (!room || !d) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    const w = Number(d.w), h = Number(d.h);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      p.view.w = Math.max(300, Math.min(4000, w));
      p.view.h = Math.max(300, Math.min(4000, h));
    }
  });

  socket.on('leave', () => leaveRoom());
  socket.on('disconnect', () => leaveRoom());

  function leaveRoom() {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.code);
    r.players.delete(socket.id);
    if (r.game) {
      const s = r.game.snakes.get(socket.id);
      if (s && s.alive) killSnake(r, s, null);
    }
    if (r.players.size === 0) {
      if (r.countdownTimer) clearInterval(r.countdownTimer);
      rooms.delete(r.code);
      return;
    }
    checkStart(r);
    sendLobby(r);
  }
});

function cancelCountdown(r) {
  if (r.countdownTimer) clearInterval(r.countdownTimer);
  r.countdownTimer = null;
  r.countdown = null;
}

function checkStart(r) {
  if (r.state !== 'lobby') return;
  const allReady = r.players.size > 0 && [...r.players.values()].every((p) => p.ready);
  if (allReady && r.countdown === null) {
    r.countdown = COUNTDOWN;
    r.countdownTimer = setInterval(() => {
      r.countdown--;
      if (r.countdown <= 0) {
        cancelCountdown(r);
        startGame(r);
      } else sendLobby(r);
    }, 1000);
  } else if (!allReady && r.countdown !== null) {
    cancelCountdown(r);
  }
}

// ───────── 게임 로직 ─────────
function randomFood(R) {
  const a = Math.random() * Math.PI * 2;
  const d = Math.sqrt(Math.random()) * (R - 40);
  return { x: Math.cos(a) * d, y: Math.sin(a) * d, v: 0.6 + Math.random() * 1.0, h: Math.floor(Math.random() * 360) };
}

function startGame(r) {
  r.state = 'playing';
  const n = r.players.size;
  const R = 1200 + n * 80;                  // 인원이 많을수록 맵이 커짐
  const g = {
    radius: R, snakes: new Map(), foods: [], tick: 0,
    endTick: ROUND_SECONDS * TICK_RATE, initial: n, nextIdx: 0, deathOrder: 0,
    foodTarget: Math.round((Math.PI * R * R) / 15000), // 맵 넓이에 비례
  };
  r.game = g;
  for (const p of r.players.values()) {
    p.waiting = false;
    p.ready = false;
    spawnSnake(r, p);
  }
  while (g.foods.length < g.foodTarget) g.foods.push(randomFood(R));
  io.to(r.code).emit('start', rosterPayload(r));
  sendLobby(r);
}

function spawnSnake(r, p) {
  const g = r.game;
  let best = { x: 0, y: 0 }, bestD = -1;
  for (let t = 0; t < 40; t++) {
    const ang = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * g.radius * 0.7;
    const x = Math.cos(ang) * d, y = Math.sin(ang) * d;
    let md = Infinity;
    for (const s of g.snakes.values()) {
      const h = s.pts[0];
      md = Math.min(md, Math.hypot(h.x - x, h.y - y));
    }
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  const angle = Math.atan2(-best.y, -best.x) + (Math.random() - 0.5);
  const pts = [];
  const L = lengthOf(START_MASS);
  for (let d = 0; d <= L; d += BASE_SPEED) {
    pts.push({ x: best.x - Math.cos(angle) * d, y: best.y - Math.sin(angle) * d });
  }
  const s = {
    id: p.id, idx: g.nextIdx++, name: p.name, hue: p.hue, pts, angle,
    mass: START_MASS, alive: true, kills: 0, boost: false, deathOrder: 0,
    r: radiusOf(START_MASS), bbox: null, dropAcc: 0,
  };
  p.input.a = angle;
  p.input.b = false;
  g.snakes.set(p.id, s);
}

function moveSnake(g, s, inp) {
  const target = inp ? inp.a : s.angle;
  let diff = target - s.angle;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const maxTurn = Math.max(0.06, 0.16 - s.r * 0.003);  // 굵을수록 천천히 회전
  s.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

  s.boost = !!(inp && inp.b) && s.mass > MIN_BOOST_MASS;
  const sp = s.boost ? BOOST_SPEED : BASE_SPEED;
  const h = s.pts[0];
  s.pts.unshift({ x: h.x + Math.cos(s.angle) * sp, y: h.y + Math.sin(s.angle) * sp });

  if (s.boost) {                                     // 부스트하면 몸이 줄고 꼬리에 먹이를 흘림
    const loss = 0.1;
    s.mass -= loss;
    s.dropAcc += loss;
    if (s.dropAcc >= 0.6) {
      const t = s.pts[s.pts.length - 1];
      g.foods.push({ x: t.x + (Math.random() - 0.5) * 8, y: t.y + (Math.random() - 0.5) * 8, v: s.dropAcc * 0.75, h: s.hue });
      s.dropAcc = 0;
    }
  }

  const L = lengthOf(s.mass);                        // 꼬리 자르기
  let acc = 0;
  for (let i = 1; i < s.pts.length; i++) {
    const a = s.pts[i - 1], b = s.pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    acc += d;
    if (acc >= L) {
      const t = d > 0 ? (acc - L) / d : 0;
      b.x += (a.x - b.x) * t;
      b.y += (a.y - b.y) * t;
      s.pts.length = i + 1;
      break;
    }
  }
}

function computeBBox(s) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of s.pts) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  s.bbox = { minX, minY, maxX, maxY };
}

function killSnake(r, s, killer) {
  const g = r.game;
  s.alive = false;
  s.deathOrder = ++g.deathOrder;
  if (killer && killer !== s) killer.kills++;
  const n = s.pts.length;
  const count = Math.ceil(n / 3);
  const per = Math.max(0.8, (s.mass * 0.7) / Math.max(1, count));
  for (let i = 0; i < n; i += 3) {                    // 죽으면 몸이 먹이로 변함
    const q = s.pts[i];
    g.foods.push({ x: q.x + (Math.random() - 0.5) * s.r * 1.5, y: q.y + (Math.random() - 0.5) * s.r * 1.5, v: per, h: s.hue });
  }
  io.to(r.code).emit('kill', {
    victim: s.name, vh: s.hue,
    killer: killer && killer !== s ? killer.name : null, kh: killer ? killer.hue : 0,
  });
}

function tickRoom(r) {
  const g = r.game;
  g.tick++;
  const alive = [];
  for (const s of g.snakes.values()) if (s.alive) alive.push(s);

  for (const s of alive) {
    const p = r.players.get(s.id);
    moveSnake(g, s, p ? p.input : null);
  }

  // 먹이 먹기
  for (const s of alive) {
    const h = s.pts[0];
    const er = s.r + 12, er2 = er * er;
    for (let i = g.foods.length - 1; i >= 0; i--) {
      const f = g.foods[i];
      const dx = f.x - h.x, dy = f.y - h.y;
      if (dx * dx + dy * dy < er2) {
        s.mass += f.v;
        g.foods[i] = g.foods[g.foods.length - 1];
        g.foods.pop();
      }
    }
    s.r = radiusOf(s.mass);
  }

  for (const s of alive) computeBBox(s);

  // 충돌: 내 머리가 다른 지렁이 몸에 닿으면 탈락
  const dead = [];
  for (const s of alive) {
    const h = s.pts[0];
    const lim = g.radius - s.r;
    if (h.x * h.x + h.y * h.y > lim * lim) { dead.push([s, null]); continue; }
    for (const o of alive) {
      if (o === s) continue;
      const b = o.bbox, m = o.r + s.r;
      if (h.x < b.minX - m || h.x > b.maxX + m || h.y < b.minY - m || h.y > b.maxY + m) continue;
      const hr = o.r + s.r * 0.5, hr2 = hr * hr;
      let hit = false;
      for (let i = 0; i < o.pts.length; i++) {
        const q = o.pts[i];
        const dx = q.x - h.x, dy = q.y - h.y;
        if (dx * dx + dy * dy < hr2) { hit = true; break; }
      }
      if (hit) { dead.push([s, o]); break; }
    }
  }
  for (const [s, k] of dead) if (s.alive) killSnake(r, s, k);

  // 먹이 보충
  for (let k = 0; k < 10 && g.foods.length < g.foodTarget; k++) g.foods.push(randomFood(g.radius));

  // 종료 조건
  let aliveN = 0;
  for (const s of g.snakes.values()) if (s.alive) aliveN++;
  if (aliveN === 0 || (g.initial >= 2 && aliveN <= 1) || g.tick >= g.endTick) {
    endGame(r);
    return;
  }
  broadcast(r);
}

function broadcast(r) {
  const g = r.game;
  const alive = [];
  for (const s of g.snakes.values()) if (s.alive) alive.push(s);
  let leader = null;
  for (const s of alive) if (!leader || s.mass > leader.mass) leader = s;

  const extra = g.tick % 5 === 0;
  let lb, mm;
  if (extra) {
    lb = alive.slice().sort((a, b) => b.mass - a.mass).slice(0, 10).map((s) => [s.idx, Math.floor(s.mass)]);
    mm = alive.map((s) => [s.idx, Math.round(s.pts[0].x), Math.round(s.pts[0].y)]);
  }
  const timeLeft = Math.max(0, Math.ceil((g.endTick - g.tick) / TICK_RATE));

  for (const p of r.players.values()) {
    const me = g.snakes.get(p.id);
    const focus = me && me.alive ? me : leader;      // 탈락하면 1등을 관전
    const cx = focus ? focus.pts[0].x : 0, cy = focus ? focus.pts[0].y : 0;
    const hw = p.view.w / 2 + 120, hh = p.view.h / 2 + 120;
    const minX = cx - hw, maxX = cx + hw, minY = cy - hh, maxY = cy + hh;

    const ss = [];
    for (const s of alive) {
      const b = s.bbox;
      if (b.maxX + s.r < minX || b.minX - s.r > maxX || b.maxY + s.r < minY || b.minY - s.r > maxY) continue;
      const pts = s.pts, arr = [];
      for (let i = 0; i < pts.length; i += 2) arr.push(Math.round(pts[i].x), Math.round(pts[i].y));
      if ((pts.length - 1) % 2 !== 0) {
        const t = pts[pts.length - 1];
        arr.push(Math.round(t.x), Math.round(t.y));
      }
      ss.push([s.idx, Math.round(s.r * 10), s.boost ? 1 : 0, arr]);
    }
    const sendFood = g.tick % 2 === 0;               // 먹이는 2틱마다 전송(트래픽 절약)
    const fs = [];
    if (sendFood) for (const f of g.foods) {
      if (f.x < minX || f.x > maxX || f.y < minY || f.y > maxY) continue;
      fs.push(Math.round(f.x), Math.round(f.y), Math.round(f.v * 10), f.h);
    }
    const msg = {
      t: g.tick, cx: Math.round(cx), cy: Math.round(cy), s: ss, f: fs,
      al: alive.length, tl: timeLeft, fi: focus ? focus.idx : -1,
    };
    if (!sendFood) delete msg.f;
    if (me) msg.me = { a: me.alive ? 1 : 0, m: Math.floor(me.mass), k: me.kills, i: me.idx };
    if (extra) { msg.lb = lb; msg.mm = mm; }
    p.socket.volatile.emit('state', msg);
  }
}

function endGame(r) {
  const g = r.game;
  const list = [...g.snakes.values()];
  list.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;  // 살아남은 사람이 위
    if (a.alive) return b.mass - a.mass;               // 생존자끼리는 길이순
    return b.deathOrder - a.deathOrder;                // 탈락자는 늦게 탈락한 순
  });
  const ranking = list.map((s, i) => ({
    rank: i + 1, id: s.id, name: s.name, hue: s.hue,
    mass: Math.floor(s.mass), kills: s.kills, alive: s.alive,
  }));
  const timeUp = g.tick >= g.endTick;
  r.state = 'lobby';
  r.game = null;
  for (const p of r.players.values()) { p.ready = false; p.waiting = false; }
  io.to(r.code).emit('gameover', { ranking, timeUp });
  sendLobby(r);
}

setInterval(() => {
  for (const r of rooms.values()) {
    if (r.state === 'playing' && r.game) {
      try { tickRoom(r); } catch (e) { console.error('tick error', e); }
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`🐍 지렁이 파티 서버 실행 중: http://localhost:${PORT}`);
});
