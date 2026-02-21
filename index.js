/**
 * Walkie Talkie Server — Mix-Minus Audio Relay
 *
 * Cambios:
 *  - Canales persistentes (no se eliminan al quedar vacíos)
 *  - Panel de administrador en /admin/panel
 *  - API REST de admin protegida por token
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

// ─── Admin token ──────────────────────────────────────────────────────────────
// Cambiar por algo secreto, o setear env var ADMIN_TOKEN en Replit
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin1234";

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== ADMIN_TOKEN)
    return res.status(401).json({ error: "No autorizado" });
  next();
}

// ─── Constantes de audio ──────────────────────────────────────────────────────
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 320;
const BYTES_PER_SAMPLE = 2;
const CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE;
const SILENCE = Buffer.alloc(CHUNK_BYTES, 0);
const MIX_INTERVAL_MS = 20;
const JITTER_BUFFER_CHUNKS = 2;
const PING_INTERVAL_MS = 15000;

// ─── Estado global ────────────────────────────────────────────────────────────
const channels = {};
const clients = new Map(); // ws -> { name, channel }

// ─── Helper: buscar cliente por nombre ───────────────────────────────────────
function findClientByName(name) {
  for (const [ws, client] of clients.entries()) {
    if (client.name === name) return { ws, client };
  }
  return null;
}

// ─── Audio ────────────────────────────────────────────────────────────────────
function mixMinus(channelName, excludeName) {
  const ch = channels[channelName];
  if (!ch) return SILENCE;
  const output = new Float32Array(CHUNK_SAMPLES);
  let speakerCount = 0;
  Object.entries(ch.users).forEach(([name, user]) => {
    if (name === excludeName) return;
    if (user.muted) return;
    const buf = user.audioQueue.shift();
    if (!buf) return;
    for (let i = 0; i < CHUNK_SAMPLES; i++)
      output[i] += buf.readInt16LE(i * 2) / 32768.0;
    speakerCount++;
  });
  if (speakerCount === 0) return SILENCE;
  const gain = speakerCount > 1 ? 0.7 / speakerCount : 1.0;
  const result = Buffer.allocUnsafe(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    const s = Math.tanh(output[i] * gain) * 32767;
    result.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(s))),
      i * 2,
    );
  }
  return result;
}

function startMixLoop(channelName) {
  const ch = channels[channelName];
  if (!ch || ch.mixInterval) return;
  ch.mixInterval = setInterval(() => {
    const ch = channels[channelName];
    if (!ch) return;
    Object.entries(ch.users).forEach(([name, user]) => {
      if (user.ws.readyState !== 1) return;
      const hasSpeakers = Object.entries(ch.users).some(
        ([n, u]) =>
          n !== name && !u.muted && u.audioQueue.length >= JITTER_BUFFER_CHUNKS,
      );
      if (!hasSpeakers) return;
      const mix = mixMinus(channelName, name);
      if (mix !== SILENCE) user.ws.send(mix);
    });
  }, MIX_INTERVAL_MS);
}

function stopMixLoop(channelName) {
  const ch = channels[channelName];
  if (!ch || !ch.mixInterval) return;
  clearInterval(ch.mixInterval);
  ch.mixInterval = null;
}

// ─── Señalización ─────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(channelName, obj, excludeWs = null) {
  const ch = channels[channelName];
  if (!ch) return;
  const data = JSON.stringify(obj);
  Object.values(ch.users).forEach((user) => {
    if (user.ws !== excludeWs && user.ws.readyState === 1) user.ws.send(data);
  });
}

function broadcastAll(obj, excludeWs = null) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws !== excludeWs && ws.readyState === 1) ws.send(data);
  });
}

function getChannelList() {
  return Object.entries(channels).map(([name, ch]) => ({
    name,
    owner: ch.owner,
    userCount: Object.keys(ch.users).length,
    users: Object.keys(ch.users),
  }));
}

// ─── leaveChannel — canal queda vacio pero NO se borra ───────────────────────
function leaveChannel(ws) {
  const client = clients.get(ws);
  if (!client || !client.channel) return;
  const { name, channel } = client;
  const ch = channels[channel];
  if (ch) {
    delete ch.users[name];
    broadcast(channel, { type: "user_left", name, channel });
    broadcastAll({ type: "channels", list: getChannelList() });
    // Detener mix loop si queda vacio, pero NO borrar el canal
    if (Object.keys(ch.users).length === 0) stopMixLoop(channel);
  }
  client.channel = null;
}

// ─── joinChannel — reutilizable por WS y admin API ───────────────────────────
function joinChannel(ws, channelName) {
  const client = clients.get(ws);
  if (!client) return { ok: false, error: "Cliente no registrado" };
  if (!channels[channelName]) return { ok: false, error: "Canal no existe" };
  if (client.channel === channelName) return { ok: true };

  leaveChannel(ws);
  channels[channelName].users[client.name] = {
    ws,
    audioQueue: [],
    talking: false,
    muted: false,
  };
  client.channel = channelName;
  startMixLoop(channelName);

  send(ws, {
    type: "joined",
    channel: channelName,
    owner: channels[channelName].owner,
    users: Object.keys(channels[channelName].users).filter(
      (n) => n !== client.name,
    ),
  });
  broadcast(channelName, { type: "user_joined", name: client.name }, ws);
  broadcastAll({ type: "channels", list: getChannelList() });
  console.log(`${client.name} entro a [${channelName}]`);
  return { ok: true };
}

// ─── Heartbeat basado en ping JSON ───────────────────────────────────────────
const PING_TIMEOUT_MS = 25000;

const pingInterval = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    const client = clients.get(ws);
    if (!client) return;

    const elapsed = now - (ws.lastPingAt || ws.connectedAt || now);
    if (elapsed > PING_TIMEOUT_MS) {
      console.log(
        `Timeout por inactividad: ${client.name} (${Math.round(elapsed / 1000)}s sin ping)`,
      );
      leaveChannel(ws);
      clients.delete(ws);
      ws.terminate();
    }
  });
}, 5000);

wss.on("close", () => clearInterval(pingInterval));

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on("connection", (ws) => {
  ws.connectedAt = Date.now();
  console.log("Nueva conexion");

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const client = clients.get(ws);
      if (!client || !client.channel) return;
      const ch = channels[client.channel];
      if (!ch || !ch.users[client.name]) return;
      const user = ch.users[client.name];
      if (user.muted || !user.talking) return;
      if (data.length !== CHUNK_BYTES) return;
      if (user.audioQueue.length < 10) user.audioQueue.push(Buffer.from(data));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "register": {
        const { name } = msg;
        if (!name || name.trim() === "") {
          send(ws, { type: "error", message: "Nombre requerido" });
          break;
        }
        clients.set(ws, { name: name.trim(), channel: null });
        send(ws, { type: "registered", name, channels: getChannelList() });
        console.log(`Registrado: ${name}`);
        break;
      }

      case "create_channel": {
        const client = clients.get(ws);
        const { channel } = msg;
        if (!client) {
          send(ws, { type: "error", message: "Registrate primero" });
          break;
        }
        if (!channel || channel.trim() === "") {
          send(ws, { type: "error", message: "Nombre invalido" });
          break;
        }
        if (channels[channel]) {
          send(ws, { type: "error", message: "El canal ya existe" });
          break;
        }
        channels[channel] = {
          owner: client.name,
          users: {},
          mixInterval: null,
        };
        broadcastAll({ type: "channel_created", channel, owner: client.name });
        broadcastAll({ type: "channels", list: getChannelList() });
        console.log(`Canal creado: [${channel}] por ${client.name}`);
        break;
      }

      case "join": {
        const client = clients.get(ws);
        const { channel } = msg;
        if (!client) {
          send(ws, { type: "error", message: "Registrate primero" });
          break;
        }
        if (!channels[channel]) {
          send(ws, { type: "error", message: "El canal no existe" });
          break;
        }
        if (channels[channel].users[client.name]) {
          send(ws, {
            type: "error",
            message: "Nombre ya en uso en este canal",
          });
          break;
        }
        const r = joinChannel(ws, channel);
        if (!r.ok) send(ws, { type: "error", message: r.error });
        break;
      }

      case "switch": {
        const client = clients.get(ws);
        const { channel } = msg;
        if (!client) break;
        if (!channels[channel]) {
          send(ws, { type: "error", message: "El canal no existe" });
          break;
        }
        const r = joinChannel(ws, channel);
        if (!r.ok) send(ws, { type: "error", message: r.error });
        break;
      }

      case "leave": {
        leaveChannel(ws);
        send(ws, { type: "left" });
        break;
      }

      case "close_channel": {
        const client = clients.get(ws);
        const { channel } = msg;
        if (!channels[channel]) {
          send(ws, { type: "error", message: "Canal no existe" });
          break;
        }
        if (channels[channel].owner !== client?.name) {
          send(ws, {
            type: "error",
            message: "Solo el creador puede cerrar el canal",
          });
          break;
        }
        stopMixLoop(channel);
        broadcast(channel, { type: "channel_closed", channel });
        Object.values(channels[channel].users).forEach((user) => {
          const c = clients.get(user.ws);
          if (c) c.channel = null;
        });
        delete channels[channel];
        broadcastAll({ type: "channel_deleted", channel });
        broadcastAll({ type: "channels", list: getChannelList() });
        console.log(`Canal cerrado: [${channel}]`);
        break;
      }

      case "list_channels":
        send(ws, { type: "channels", list: getChannelList() });
        break;

      case "talking": {
        const client = clients.get(ws);
        if (!client || !client.channel) break;
        const user = channels[client.channel]?.users[client.name];
        if (!user) break;
        user.talking = msg.talking;
        broadcast(
          client.channel,
          { type: "talking", name: client.name, talking: msg.talking },
          ws,
        );
        break;
      }

      case "mute": {
        const client = clients.get(ws);
        if (!client || !client.channel) break;
        const user = channels[client.channel]?.users[client.name];
        if (!user) break;
        user.muted = msg.muted;
        send(ws, { type: "muted", muted: msg.muted });
        break;
      }

      case "ping": {
        ws.lastPingAt = Date.now();
        send(ws, { type: "pong" });
        break;
      }

      default:
        send(ws, { type: "error", message: `Tipo desconocido: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`Desconectado: ${client.name}`);
      leaveChannel(ws);
      clients.delete(ws);
    }
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN API REST
// ════════════════════════════════════════════════════════════════════════════

app.get("/admin/status", requireAdmin, (req, res) => {
  const clientList = [];
  for (const [, client] of clients.entries()) {
    const userInfo = client.channel
      ? channels[client.channel]?.users[client.name]
      : null;
    clientList.push({
      name: client.name,
      channel: client.channel,
      muted: userInfo?.muted ?? null,
      talking: userInfo?.talking ?? null,
      queue: userInfo?.audioQueue?.length ?? 0,
    });
  }
  res.json({
    uptime: process.uptime(),
    clients: clientList,
    channels: getChannelList().map((ch) => ({
      ...ch,
      users: Object.entries(channels[ch.name]?.users || {}).map(
        ([name, u]) => ({
          name,
          muted: u.muted,
          talking: u.talking,
          queue: u.audioQueue?.length ?? 0,
        }),
      ),
    })),
  });
});

app.post("/admin/channel/create", requireAdmin, (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel requerido" });
  if (channels[channel]) return res.status(409).json({ error: "Ya existe" });
  channels[channel] = { owner: "admin", users: {}, mixInterval: null };
  broadcastAll({ type: "channel_created", channel, owner: "admin" });
  broadcastAll({ type: "channels", list: getChannelList() });
  res.json({ ok: true, channel });
});

app.delete("/admin/channel/:channel", requireAdmin, (req, res) => {
  const { channel } = req.params;
  if (!channels[channel])
    return res.status(404).json({ error: "Canal no existe" });
  stopMixLoop(channel);
  broadcast(channel, { type: "channel_closed", channel });
  Object.values(channels[channel].users).forEach((user) => {
    const c = clients.get(user.ws);
    if (c) c.channel = null;
  });
  delete channels[channel];
  broadcastAll({ type: "channel_deleted", channel });
  broadcastAll({ type: "channels", list: getChannelList() });
  res.json({ ok: true });
});

app.post("/admin/client/:name/join", requireAdmin, (req, res) => {
  const { name } = req.params;
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: "channel requerido" });
  const found = findClientByName(name);
  if (!found)
    return res.status(404).json({ error: `Cliente "${name}" no conectado` });
  if (!channels[channel])
    return res.status(404).json({ error: "Canal no existe" });
  const r = joinChannel(found.ws, channel);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

app.post("/admin/client/:name/leave", requireAdmin, (req, res) => {
  const { name } = req.params;
  const found = findClientByName(name);
  if (!found)
    return res.status(404).json({ error: `Cliente "${name}" no conectado` });
  leaveChannel(found.ws);
  send(found.ws, { type: "left" });
  res.json({ ok: true });
});

app.post("/admin/client/:name/mute", requireAdmin, (req, res) => {
  const { name } = req.params;
  const muted = req.body.muted ?? true;
  const found = findClientByName(name);
  if (!found)
    return res.status(404).json({ error: `Cliente "${name}" no conectado` });
  const { client } = found;
  if (!client.channel)
    return res.status(400).json({ error: "Cliente no esta en un canal" });
  const user = channels[client.channel]?.users[name];
  if (!user)
    return res.status(400).json({ error: "Usuario no encontrado en canal" });
  user.muted = muted;
  send(found.ws, { type: "muted", muted, source: "admin" });
  res.json({ ok: true, name, muted });
});

app.post("/admin/client/:name/kick", requireAdmin, (req, res) => {
  const { name } = req.params;
  const found = findClientByName(name);
  if (!found)
    return res.status(404).json({ error: `Cliente "${name}" no conectado` });
  send(found.ws, {
    type: "kicked",
    message: "Desconectado por un administrador",
  });
  leaveChannel(found.ws);
  clients.delete(found.ws);
  found.ws.terminate();
  res.json({ ok: true });
});

app.get("/admin/panel", requireAdmin, (req, res) => {
  const token = req.query.token || ADMIN_TOKEN;
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin — WalkieTalkie</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;padding:24px}
h1{color:#f0a520;font-size:1.3rem;margin-bottom:20px;border-bottom:1px solid #30363d;padding-bottom:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px}
.card-title{font-size:0.8rem;color:#f0a520;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
table{width:100%;border-collapse:collapse;font-size:0.78rem}
th{text-align:left;color:#8b949e;padding:6px 8px;border-bottom:1px solid #21262d;font-weight:500}
td{padding:6px 8px;border-bottom:1px solid #21262d;vertical-align:middle}
.badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:0.68rem;font-weight:600}
.badge.green{background:rgba(46,160,67,0.2);color:#3fb950}
.badge.gray{background:rgba(139,148,158,0.15);color:#8b949e}
.btn{border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.7rem;font-weight:600;transition:opacity 0.15s;white-space:nowrap}
.btn:hover{opacity:0.75}
.btn.red{background:#da3633;color:#fff}
.btn.green{background:#2ea043;color:#fff}
.btn.blue{background:#1f6feb;color:#fff}
.btn.orange{background:#d4850a;color:#fff}
.btn.gray{background:#30363d;color:#c9d1d9}
.actions{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.row-input{display:flex;gap:8px;margin-top:12px}
input[type=text],select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:5px 9px;border-radius:4px;font-size:0.78rem;outline:none}
input[type=text]:focus,select:focus{border-color:#f0a520}
input[type=text]{flex:1}
.toast{position:fixed;bottom:20px;right:20px;background:#161b22;border:1px solid #30363d;padding:10px 16px;border-radius:6px;font-size:0.78rem;display:none;z-index:999;min-width:200px}
.toast.ok{border-color:#3fb950;color:#3fb950}
.toast.err{border-color:#f85149;color:#f85149}
.uptime{font-size:0.7rem;color:#8b949e}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>📡 WalkieTalkie — Admin Panel <span class="uptime" id="uptime"></span></h1>
<div class="toast" id="toast"></div>
<div class="grid">
  <div class="card">
    <div class="card-title">CLIENTES CONECTADOS <button class="btn gray" onclick="load()">↻</button></div>
    <table>
      <thead><tr><th>Nombre</th><th>Canal</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody id="clients-tbody"></tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-title">CANALES</div>
    <table>
      <thead><tr><th>Canal</th><th>Usuarios</th><th>Acciones</th></tr></thead>
      <tbody id="channels-tbody"></tbody>
    </table>
    <div class="row-input">
      <input type="text" id="new-ch" placeholder="Nombre del nuevo canal"/>
      <button class="btn green" onclick="createChannel()">+ Crear</button>
    </div>
  </div>
</div>
<script>
const TOKEN = '${token}';
function toast(msg, ok=true){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast '+(ok?'ok':'err');
  el.style.display='block';
  clearTimeout(el._t); el._t=setTimeout(()=>el.style.display='none',2500);
}
async function api(method,path,body){
  const r=await fetch(path+'?token='+TOKEN,{
    method,
    headers:{'Content-Type':'application/json','x-admin-token':TOKEN},
    body:body?JSON.stringify(body):undefined
  });
  const j=await r.json();
  if(!r.ok) throw new Error(j.error||'Error');
  return j;
}
async function load(){
  try {
    const data = await api('GET', '/admin/status');
    document.getElementById('uptime').textContent = 'Uptime: ' + Math.floor(data.uptime) + 's';
    const ct = document.getElementById('clients-tbody');
    ct.innerHTML = '';
    data.clients.forEach(c => {
      const statusBadge = c.channel ? '<span class="badge green">EN LÍNEA</span>' : '<span class="badge gray">sin canal</span>';
      const chOptions = data.channels.map(ch => '<option value="'+ch.name+'"'+(ch.name===c.channel?' selected':'')+'>'+ch.name+'</option>').join('');
      ct.innerHTML += '<tr><td>'+c.name+'</td><td>'+(c.channel||'—')+'</td><td>'+statusBadge+'</td><td class="actions"><select id="sel_'+c.name+'"><option value="">— canal —</option>'+chOptions+'</select><button class="btn blue" onclick="joinClient(\''+c.name+'\')">Join</button><button class="btn '+(c.muted?'green':'orange')+'" onclick="muteClient(\''+c.name+'\','+(!c.muted)+')">'+(c.muted?'Unmute':'Mute')+'</button><button class="btn red" onclick="kickClient(\''+c.name+'\')">Kick</button></td></tr>';
    });
    const chanT = document.getElementById('channels-tbody');
    chanT.innerHTML = '';
    data.channels.forEach(c => {
      chanT.innerHTML += '<tr><td>'+c.name+'</td><td>'+c.userCount+'</td><td class="actions"><button class="btn red" onclick="deleteChannel(\''+c.name+'\')">Eliminar</button></td></tr>';
    });
  } catch(e) { toast(e.message, false); }
}
async function joinClient(name){
  const ch=document.getElementById('sel_'+name)?.value;
  if(!ch) return;
  try { await api('POST', '/admin/client/'+name+'/join', {channel:ch}); load(); } catch(e){ toast(e.message, false); }
}
async function muteClient(name, muted){
  try { await api('POST', '/admin/client/'+name+'/mute', {muted}); load(); } catch(e){ toast(e.message, false); }
}
async function kickClient(name){
  try { await api('POST', '/admin/client/'+name+'/kick'); load(); } catch(e){ toast(e.message, false); }
}
async function deleteChannel(name){
  try { await api('DELETE', '/admin/channel/'+name); load(); } catch(e){ toast(e.message, false); }
}
async function createChannel(){
  const name=document.getElementById('new-ch').value;
  try { await api('POST', '/admin/channel/create', {channel:name}); load(); } catch(e){ toast(e.message, false); }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`);
});

app.get("/", (req, res) => {
  res.send("OK — Admin: /admin/panel?token=admin1234");
});

app.get("/status", (req, res) => {
  res.json({
    uptime: process.uptime(),
    totalClients: clients.size,
    channels: getChannelList(),
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Walkie Talkie Server en puerto ${PORT}`);
});
