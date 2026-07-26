'use strict';

// Armazenamento a prova de crash, zero dependência nativa.
// - captures.jsonl : tráfego bruto da rede (fonte "rede")
// - events.jsonl   : eventos do jogo (capturas, shiny, raridade, prints) — fonte "tela"
// - latest.json    : último snapshot por conta (pro painel)
// - settings.json  : preferências de alerta
// - shots/         : prints .png

const fs = require('fs');
const path = require('path');
const { catchScore } = require('./game-parse');

let DIR = null, RAW = null, EVENTS = null, LATEST = null, SETTINGS = null, SHOTS = null, CAUGHT = null, PROGRESS = null, DAILY = null, BOX = null;

const DEFAULT_SETTINGS = {
  soundOn: true,
  // critério de "notável" (alerta de captura raro E filtro da Box): quality >= qualityMin E IV >= ivMin.
  qualityMin: 1.73,      // quality mínima (ex.: 1.73 = Lendária forte)
  ivMin: 110,            // IV mínimo absoluto (0–192)
  alertRarity: 'Rara',   // (legado) mantido só p/ compat; a lógica agora usa qualityMin/ivMin
  ivAlertFrac: 0.9,      // (legado)
  screenshotOnShiny: true,
  ballsAlert: 200,       // alerta quando as ULTRA BALLS caem até aqui (só a Ultra conta)
  potionsAlert: 30,      // alerta quando o total de potions cai até aqui
  revivesAlert: 10,      // alerta quando o total de revives cai até aqui
  giftAlert: true,       // avisa quando há presente(s) pra coletar no correio
  gameClean: true,       // declutter da UI do jogo (esconde chat/apaga barras que sobrepõem)
  sellProtect: true,     // bloqueia venda de poke shiny/lendário e itens protegidos (pheromone/picture/cards)
  netCapture: true,      // captura de rede (CDP); só anexa após o login
  activeSlots: [1],      // telas abertas (slots 1..4); lembrado entre execuções
  accountNames: {},      // { slot: "nome" } — apelidos das contas
  discordWebhook: '',    // URL do webhook do Discord: avisa quando VOCÊ pega um shiny (vazio = desligado)
};

function init(userData) {
  DIR = path.join(userData, 'poke-coletor-data');
  SHOTS = path.join(DIR, 'shots');
  fs.mkdirSync(SHOTS, { recursive: true });
  RAW = path.join(DIR, 'captures.jsonl');
  EVENTS = path.join(DIR, 'events.jsonl');
  LATEST = path.join(DIR, 'latest.json');
  SETTINGS = path.join(DIR, 'settings.json');
  CAUGHT = path.join(DIR, 'caught.json');
  PROGRESS = path.join(DIR, 'progress.json');
  DAILY = path.join(DIR, 'daily.json');
  BOX = path.join(DIR, 'box.json');
}

// ---- Box Pokémon: coleção persistida por conta, chaveada pelo `id` único do poke.
// Fonte: frame `pokes` (coleção inteira) + poke-delta (captura nova). MERGE (nunca apaga por
// frame parcial) — a reconciliação de vendidos/soltos vem depois via /api/game/all-pokes.
function saveBoxList(account, list) {
  if (!BOX || !account || !Array.isArray(list) || !list.length) return;
  const all = _readJson(BOX) || {};
  const m = all[account] || (all[account] = {});
  for (const p of list) if (p && p.id != null) m[p.id] = Object.assign(m[p.id] || {}, p, { _ts: Date.now() });
  _writeJson(BOX, all);
}
function upsertBox(account, poke) {
  if (!BOX || !account || !poke || poke.id == null) return;
  const all = _readJson(BOX) || {};
  const m = all[account] || (all[account] = {});
  m[poke.id] = Object.assign(m[poke.id] || {}, poke, { _ts: Date.now() });
  _writeJson(BOX, all);
}
function getBox() { return _readJson(BOX) || {}; }

// ---- snapshot diário: agregado por dia (a "seção" de cada dia fecha sozinha à meia-noite,
// porque a chave é a data local do evento). Fica completo pra sempre, mesmo que o
// events.jsonl cresça além da janela de leitura do painel.
const CAP_TYPES = ['capture', 'rare_capture', 'shiny_capture'];
function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _bumpInto(all, ev) {
  const isCap = CAP_TYPES.includes(ev.type);
  if (!isCap && ev.type !== 'shiny_wild') return false;
  const day = dayKey(ev.ts), acc = ev.account || '?';
  const d = all[day] || (all[day] = {});
  const a = d[acc] || (d[acc] = { captures: 0, shiny: 0, shinyLost: 0, byRarity: {}, best: null });
  if (isCap) {
    a.captures++;
    if (ev.rarity) a.byRarity[ev.rarity] = (a.byRarity[ev.rarity] || 0) + 1;
    if (ev.type === 'shiny_capture') a.shiny++;
    // "melhor catch do dia": quality manda (desempate por IV quase perfeito), não IV puro
    if (ev.quality != null || ev.iv != null) {
      const cur = { name: ev.name || null, dex: ev.dex || null, level: ev.level, iv: ev.iv, quality: ev.quality,
        rarity: ev.rarity || null, power: ev.power, type1: ev.type1 || null, type2: ev.type2 || null,
        stats: ev.stats || null, shiny: !!ev.shiny };
      if (!a.best || catchScore(cur) > catchScore(a.best)) a.best = cur;
    }
  } else a.shinyLost++;   // shiny_wild = shiny selvagem derrotado (apareceu e não foi capturado)
  return true;
}
function bumpDaily(ev) {
  if (!DAILY) return;
  const all = _readJson(DAILY) || {};
  if (_bumpInto(all, ev)) _writeJson(DAILY, all);
}
function getDaily() {
  const cur = _readJson(DAILY);
  if (cur) return cur;
  // 1º uso: reconstrói o agregado a partir de TODO o histórico de eventos já salvo (em memória, 1 escrita)
  const all = {};
  try { for (const ev of _readJsonl(EVENTS, 0)) if (ev && ev.ts) _bumpInto(all, ev); } catch {}
  _writeJson(DAILY, all);
  return all;
}

// cache durável por conta: analyzer/profissão/correio — pra o painel mostrar SEM re-abrir nada
function getProgress(account) { const p = _readJson(PROGRESS) || {}; return account ? (p[account] || {}) : p; }
function saveProgress(account, patch) {
  if (!PROGRESS || !patch) return;
  const p = _readJson(PROGRESS) || {};
  p[account] = Object.assign({}, p[account] || {}, patch);
  _writeJson(PROGRESS, p);
}

// pokédex: dex das espécies que a conta já teve/capturou (acumula pra sempre)
function addCaught(account, ids) {
  if (!CAUGHT || !ids || !ids.length) return;
  const c = _readJson(CAUGHT) || {};
  const set = new Set(c[account] || []);
  let ch = false;
  for (const id of ids) if (id != null && !set.has(id)) { set.add(id); ch = true; }
  if (ch) { c[account] = [...set]; _writeJson(CAUGHT, c); }
}
function getCaught(account) { const c = _readJson(CAUGHT) || {}; return c[account] || []; }

function _appendJsonl(file, rec) {
  if (!file) return;
  if (!rec.ts) rec.ts = Date.now();
  try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch {}
}
function _readJsonl(file, limit) {
  if (!file || !fs.existsSync(file)) return [];
  let data; try { data = fs.readFileSync(file, 'utf8').trim(); } catch { return []; }
  if (!data) return [];
  const lines = data.split('\n');
  const slice = limit ? lines.slice(-limit) : lines;
  return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function _readJson(f) { if (!f || !fs.existsSync(f)) return null; try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function _writeJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch {} }

function appendRaw(rec) {
  // NUNCA gravar o token de login: a URL do WebSocket vem como ws12?token=<JWT>.
  if (rec && rec.url) rec.url = String(rec.url).split('?')[0];
  _appendJsonl(RAW, rec);
}
function appendEvent(ev) { if (!ev.ts) ev.ts = Date.now(); _appendJsonl(EVENTS, ev); try { bumpDaily(ev); } catch {} return ev; }
function readEvents(limit) { return _readJsonl(EVENTS, limit || 200).reverse(); }

function setLatest(account, snap) {
  const cur = _readJson(LATEST) || {};
  cur[account] = Object.assign({}, snap, { ts: Date.now() });
  _writeJson(LATEST, cur);
}
function getLatest() { return _readJson(LATEST) || {}; }

function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, _readJson(SETTINGS) || {}); }
function setSettings(patch) { const s = Object.assign(getSettings(), patch || {}); _writeJson(SETTINGS, s); return s; }

function saveShot(account, pngBuffer) {
  const file = path.join(SHOTS, `${account}_${Date.now()}.png`);
  try { fs.writeFileSync(file, pngBuffer); return file; } catch { return null; }
}
function readShotDataURL(p) {
  try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch { return null; }
}

function summarize() {
  const latest = getLatest();
  const events = _readJsonl(EVENTS, 5000);
  const per = {};
  const ensure = (acc) => per[acc] || (per[acc] = { account: acc, latest: latest[acc] || null, captures: 0, shiny: 0, rare: 0 });
  for (const acc of Object.keys(latest)) ensure(acc);
  for (const e of events) {
    const a = ensure(e.account || '?');
    if (e.type === 'capture' || e.type === 'rare_capture' || e.type === 'shiny_capture') a.captures++;
    if (e.type === 'shiny_capture' || e.type === 'shiny_encounter') a.shiny++;
    if (e.type === 'rare_capture') a.rare++;
  }
  const shots = events.filter((e) => e.type === 'shot').slice(-24).reverse();
  return {
    accounts: Object.values(per).sort((a, b) => a.account.localeCompare(b.account)),
    totalEvents: events.length,
    recent: events.filter((e) => e.type !== 'shot').slice(-80).reverse(),
    shots,
  };
}

function exportResumo() {
  const s = summarize();
  const lines = [`# Poke Idle Launcher — ${new Date().toLocaleString()}`, ''];
  for (const a of s.accounts) {
    lines.push(`## ${a.account} — ${a.captures} capturas · ✨ shiny ${a.shiny} · raras ${a.rare}`);
    const L = a.latest || {};
    if (L.session) lines.push('Sessão: ' + JSON.stringify(L.session));
    if (L.drops && L.drops.length) lines.push('Drops: ' + L.drops.map((d) => `${d.item} ×${d.qty}`).join(', '));
    lines.push('');
  }
  lines.push('## Últimos eventos');
  s.recent.slice(0, 50).forEach((e) =>
    lines.push(`- [${e.account}] ${e.type} ${e.name || ''} ${e.rarity || ''} ${e.iv ? 'IV ' + e.iv + '/' + (e.ivMax || '?') : ''}`.trim()));
  const file = path.join(DIR, `resumo-${Date.now()}.md`);
  const content = lines.join('\n');
  try { fs.writeFileSync(file, content, 'utf8'); } catch {}
  return { path: file, content };
}

module.exports = {
  init, appendRaw, appendEvent, readEvents, setLatest, getLatest,
  getSettings, setSettings, saveShot, readShotDataURL, summarize, exportResumo,
  addCaught, getCaught, getProgress, saveProgress, getDaily,
  saveBoxList, upsertBox, getBox,
};
