
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

function genPIN() {
  return String(Math.floor(100000 + Math.random()*900000));
}
function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// Room state
// rooms: Map<pin, { pin, hostId, clients: Map<clientId, ws>,
//                  players: Map<clientId, {id, name, headcount, ready, score, isHost}>,
//                  rounds: Array<{id, label, options, startAt}>,
//                  leaderboard: Array<{playerId, name, score, metrics}>
//                }>
const rooms = new Map();

function broadcast(pin, msgObj) {
  const room = rooms.get(pin);
  if (!room) return;
  const data = JSON.stringify(msgObj);
  for (const [cid, sock] of room.clients.entries()) {
    if (sock.readyState === 1) sock.send(data);
  }
}

function getPublicState(pin) {
  const room = rooms.get(pin);
  if (!room) return null;
  const players = [...room.players.values()].map(p => ({
    id: p.id, name: p.name, headcount: p.headcount, ready: p.ready, isHost: p.isHost
  }));
  return {
    pin: room.pin,
    players,
    rounds: room.rounds || [],
    leaderboard: room.leaderboard || []
  };
}

wss.on('connection', (ws) => {
  const clientId = genId();
  ws._ctx = { pin: null, clientId };

  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // CREATE ROOM
    if (msg.type === 'create_room') {
      const pin = genPIN();
      const room = {
        pin,
        hostId: clientId,
        clients: new Map([[clientId, ws]]),
        players: new Map([[clientId, {
          id: clientId, name: msg.name || 'Host', headcount: msg.headcount || 30,
          ready: false, isHost: true
        }]]),
        rounds: [],
        leaderboard: []
      };
      rooms.set(pin, room);
      ws._ctx.pin = pin;
      ws.send(JSON.stringify({ type: 'room_created', pin, state: getPublicState(pin) }));
      return;
    }

    // JOIN ROOM
    if (msg.type === 'join_room') {
      const { pin, name, headcount } = msg;
      const room = rooms.get(pin);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }
      room.clients.set(clientId, ws);
      room.players.set(clientId, {
        id: clientId, name: name || 'Player', headcount: headcount || 30, ready: false, isHost: false
      });
      ws._ctx.pin = pin;
      ws.send(JSON.stringify({ type: 'joined', pin, state: getPublicState(pin), you: clientId }));
      broadcast(pin, { type: 'state', state: getPublicState(pin) });
      return;
    }

    // READY
    if (msg.type === 'set_ready') {
      const pin = ws._ctx.pin;
      const room = rooms.get(pin);
      if (!room) return;
      const p = room.players.get(clientId);
      if (p) p.ready = !!msg.ready;
      broadcast(pin, { type: 'state', state: getPublicState(pin) });
      return;
    }

    // START ROUND (host only)
    if (msg.type === 'start_round') {
      const pin = ws._ctx.pin;
      const room = rooms.get(pin);
      if (!room) return;
      if (room.hostId !== clientId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only host can start a round' }));
        return;
      }
      const roundId = genId();
      const startAt = Date.now() + (msg.delayMs ?? 3000);
      const round = { id: roundId, label: msg.label || 'Round', options: msg.options || {}, startAt };
      room.rounds.push(round);
      // reset leaderboard for this round
      room.leaderboard = [];
      broadcast(pin, { type: 'round_start', round });
      return;
    }

    // SUBMIT SCORE
    if (msg.type === 'score_submit') {
      const pin = ws._ctx.pin;
      const room = rooms.get(pin);
      if (!room) return;
      const p = room.players.get(clientId);
      if (!p) return;
      const entry = {
        playerId: p.id,
        name: p.name,
        score: msg.total ?? 0,
        metrics: {
          loud: msg.loud ?? 0,
          unity: msg.unity ?? 0,
          pitch: msg.pitch ?? 0,
          headcount: p.headcount,
          clipRate: msg.clipRate ?? 0
        }
      };
      // replace or add
      const idx = room.leaderboard.findIndex(e => e.playerId === p.id);
      if (idx >= 0) room.leaderboard[idx] = entry; else room.leaderboard.push(entry);
      // sort
      room.leaderboard.sort((a,b)=> b.score - a.score);
      broadcast(pin, { type: 'leaderboard', leaderboard: room.leaderboard });
      return;
    }

    // UPDATE HEADCOUNT/NAME
    if (msg.type === 'update_player') {
      const pin = ws._ctx.pin;
      const room = rooms.get(pin);
      if (!room) return;
      const p = room.players.get(clientId);
      if (!p) return;
      if (typeof msg.headcount === 'number') p.headcount = msg.headcount;
      if (msg.name) p.name = msg.name;
      broadcast(pin, { type: 'state', state: getPublicState(pin) });
      return;
    }

    if (msg.type === 'request_state') {
      const pin = ws._ctx.pin;
      if (!pin) return;
      ws.send(JSON.stringify({ type: 'state', state: getPublicState(pin) }));
      return;
    }
  });

  ws.on('close', () => {
    const pin = ws._ctx.pin;
    if (!pin) return;
    const room = rooms.get(pin);
    if (!room) return;
    room.clients.delete(clientId);
    room.players.delete(clientId);
    if (room.clients.size === 0) {
      rooms.delete(pin); // cleanup
    } else {
      broadcast(pin, { type: 'state', state: getPublicState(pin) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
