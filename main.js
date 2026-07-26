'use strict';

// Poke Idle Launcher — casca leve (Electron), coleta 100% pela REDE.
// Janela SEM MOLDURA. Disposição: barra no topo + PAINEL fixo à esquerda +
// JOGOS à direita (em GRADE ou ÚNICO). Vê-se o painel E os jogos ao mesmo tempo.
// Trocar de conta = clicar na aba (instantâneo). O DOM do jogo não é lido pra
// dado — só capturePage() pra print do MEU shiny.

const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const gp = require('./game-parse');
const calc = require('./calc');
const api = require('./server-api');
const { createTokenVault } = require('./token-vault');
const { ShinyHuntBot } = require('./shiny-hunt-bot');

const SERVER_MODE = process.argv.includes('--server') || process.env.POKE_SERVER_MODE === '1';
if (SERVER_MODE && process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');
if (process.env.POKE_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.POKE_USER_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), 'poke-coletor'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// manter o jogo rodando a full mesmo escondido (não freia a hunt idle)
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const GAME_URL = 'https://poke.idleworld.online/play';
const MAXV = 4;
const LANDING_URL = 'https://idle247.antoniofleck.com.br/?ref=launcher';
const BAR = 46;      // altura da barra (bate com o app.html)
const SIDE_W = 312;  // largura da sidebar no modo "jogo em foco" (bate com .side.wide)

const rarityIdx = (r) => { const i = gp.RARITY_ORDER.indexOf((r || '').trim()); return i < 0 ? 1 : i; };

// catálogo de itens do jogo (id -> nome/ícone/categoria), pra montar a Bag
const GAME_ORIGIN = 'https://poke.idleworld.online';
// normaliza o ícone do item pra uma URL usável: absoluta fica; começando com "/" ganha o origin;
// nome cru vira /assets/items/<nome> (mesma regra do cliente do jogo).
function itemIconUrl(icon) {
  if (!icon) return null;
  if (/^https?:\/\//.test(icon)) return icon;
  if (icon.startsWith('/')) return GAME_ORIGIN + icon;
  return GAME_ORIGIN + '/assets/items/' + icon;
}
let itemCatalog = {};
async function loadItemCatalog() {
  try {
    const r = await fetch(GAME_ORIGIN + '/game/items.json');
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.items || Object.values(j));
    for (const it of arr) itemCatalog[it.id] = { name: it.name, icon: itemIconUrl(it.icon), category: it.category, rare: it.rare, npcPrice: it.npcPrice };
  } catch (e) { console.error('[coletor] items.json', e && e.message); }
}
function buildBag(inv) {
  if (!inv) return null;
  let total = 0; const items = [];
  for (const it of inv) {
    const c = itemCatalog[it.itemId] || {};
    total += it.quantity || 0;
    items.push({ id: it.itemId, name: c.name || ('item ' + it.itemId), icon: c.icon || null, category: c.category || 'loot', rare: !!c.rare, qty: it.quantity, price: c.npcPrice || 0 });
  }
  return { total, items };
}

// catálogo de espécies (pokédex): dex, nome, tipos, nível de hunt, raridade
let creatures = [];
// mapa nome(->dex NACIONAL) só das espécies base (pokeId<10000). Outland/variantes têm pokeId>=10000
// (ex.: "Brave Blastoise"=10001) e NÃO existem no PokeAPI — pra achar o sprite a gente casa pelo nome
// (última palavra) com o dex base ("Brave Blastoise" -> "blastoise" -> 9).
let dexByName = {};
function idxName(name, dex) {
  if (!name) return;
  const low = String(name).toLowerCase();
  if (dexByName[low] == null) dexByName[low] = dex;
  const toks = low.split(/[\s-]+/).filter(Boolean);
  const last = toks[toks.length - 1];
  if (last && dexByName[last] == null) dexByName[last] = dex;
}
// dex "renderável" no PokeAPI: se já é nacional (<10000) usa direto; senão resolve pelo nome (outland).
function resolveDex(id, name) {
  if (id != null && id > 0 && id < 10000) return id;
  if (name) {
    const low = String(name).toLowerCase();
    if (dexByName[low] != null) return dexByName[low];
    const toks = low.split(/[\s-]+/).filter(Boolean);
    for (let i = toks.length - 1; i >= 0; i--) if (dexByName[toks[i]] != null) return dexByName[toks[i]];
  }
  return (id != null && id > 0 && id < 10000) ? id : null;
}
async function loadCreatures() {
  try {
    const j = await (await fetch('https://poke.idleworld.online/game/creatures.json')).json();
    const arr = Array.isArray(j) ? j : (j.creatures || Object.values(j));
    creatures = arr.map((c) => ({ dex: c.pokeId, name: c.name, type1: c.type1, type2: c.type2 || null, huntLevel: c.huntLevel, rarity: c.rarity,
      sellValue: c.sellValue || 0, xpKill: c.experience || 0,
      // stats base + tipos dos golpes: usados pela sugestão de leveling (velocidade de kill = bulk do alvo; cobertura de tipo)
      baseHp: c.baseHp || 0, baseDef: c.baseDef || 0, baseSpDef: c.baseSpDef || 0,
      moveTypes: [...new Set((c.attacks || []).map((a) => a.type).filter(Boolean))],
      loot: (c.loot || []).map((l) => ({ name: l.name, chance: l.chance || 0, min: l.minCount || 1, max: l.maxCount || 1 })) }));
    dexByName = {};
    for (const c of arr) if (c.pokeId != null && c.pokeId < 10000) idxName(c.name, c.pokeId);   // só as base viram fonte de sprite
  } catch (e) { console.error('[coletor] creatures.json', e && e.message); }
}

// LOGIN PERSISTENTE: o jogo autentica por cookie de SESSÃO, que o Electron apaga
// ao fechar. Aqui a gente converte esses cookies em PERSISTENTES (via API de sessão,
// no processo main — não toca no jogo, não envia nada ao servidor).
async function persistCookies(g) {
  try {
    const ses = g.view.webContents.session;
    const cookies = await ses.cookies.get({ domain: 'idleworld.online' });
    const far = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 60 dias
    for (const c of cookies) {
      if (!c.session) continue;   // só as de sessão precisam virar persistentes
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) continue;
      const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
      try {
        const sameSite = c.sameSite && c.sameSite !== 'unspecified' ? c.sameSite : 'lax';   // 'unspecified' faz o set falhar em silêncio
        await ses.cookies.set({ url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite, expirationDate: far });
      } catch {}
    }
    await ses.cookies.flushStore();
  } catch {}
}

// SONDA read-only: grava só as CHAVES de storage (NUNCA valores/token) pra eu ver como o jogo guarda o login
async function debugAuth(g) {
  try {
    const ses = g.view.webContents.session;
    const cookies = await ses.cookies.get({ domain: 'idleworld.online' });
    let ls = [], ss = [];
    try { const r = await g.view.webContents.executeJavaScript('({ls:Object.keys(localStorage||{}),ss:Object.keys(sessionStorage||{})})', true); ls = r.ls || []; ss = r.ss || []; } catch {}
    const info = {
      slot: g.slot, t: Date.now(), url: (g.view.webContents.getURL() || '').split('?')[0],
      cookies: cookies.map((c) => ({ name: c.name, session: !!c.session, secure: !!c.secure, httpOnly: !!c.httpOnly })),
      localStorage: ls, sessionStorage: ss,   // SÓ as chaves — valores nunca são gravados
    };
    fs.writeFileSync(path.join(__dirname, `auth-debug-acc${g.slot}.json`), JSON.stringify(info, null, 2));
  } catch {}
}

// LEMBRAR LOGIN: o jogo guarda a sessão em sessionStorage['pokeweb:tokens'], que some ao fechar.
// A gente salva esse token (CRIPTOGRAFADO, na userData — nunca na pasta compartilhada) e restaura ao abrir.
// Só o token do próprio usuário volta pro lugar dele; nenhuma ação de jogo é injetada.
const TOKEN_KEY = 'pokeweb:tokens';
let tokenDir = null;
let tokenVault = null;
async function saveToken(g) {
  try {
    if (!tokenVault) return;
    const tok = await g.view.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(TOKEN_KEY)})`, false);
    tokenVault.save(g.slot, tok);
  } catch {}
}
function loadToken(slot) {
  try { return tokenVault ? tokenVault.load(slot) : null; } catch { return null; }
}
function attachTokenRestore(g) {
  let tried = false;
  g.view.webContents.on('did-finish-load', async () => {
    if (tried) return;
    try {
      const has = await g.view.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(TOKEN_KEY)})`, false);
      if (has) return;   // já logado nesta sessão
      const saved = loadToken(g.slot);
      if (!saved) return;
      tried = true;
      await g.view.webContents.executeJavaScript(`sessionStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(saved)})`, false);
      g.view.webContents.reload();   // recarrega já com o token → entra logado, sem relogar
    } catch {}
  });
}

let win = null;
let dashView = null;
const games = [];          // { view, slot, state, recent, startTs, leaderLevelStart, _lastPush }
const seenNothing = {};
let selectedSlot = null;
let gameMode = 'grid';     // 'grid' | 'single'
let view = 'accounts';     // 'accounts' | 'captures'
let modalOpen = false;     // painel de config/notificações aberto → esconde as telas do jogo pra ele aparecer por cima
let overlayWin = null;
let diagOn = false;        // modo diagnóstico: grava os frames crus do WS pra realinhar o parser
let dumpPath = null;
const diagSeen = {};
// pra rodar a noite toda sem virar GB: capa só o RUÍDO repetido; guarda captura/eventos com folga; nunca descarta shiny.
const DIAG_CAP = { field: 15, 'field-kill': 400, 'catch-result': 400, 'poke-xp': 200, chat: 40, analyzer: 800, 'shiny-global': 400 };
const DIAG_DEFAULT_CAP = 3000;   // poke-delta (capturas), pokes, balls, inventory, events, field-init, profissão, tipos NOVOS...
function dumpFrame(slot, payload) {
  if (!dumpPath) return;
  try {
    let type = 'unknown'; try { const j = JSON.parse(payload); if (j && j.type) type = j.type; } catch {}
    if (!/"shiny":\s*true/.test(payload)) {                       // shiny nunca é descartado
      const cap = DIAG_CAP[type] != null ? DIAG_CAP[type] : DIAG_DEFAULT_CAP;
      diagSeen[type] = (diagSeen[type] || 0) + 1;
      if (diagSeen[type] > cap) return;
    }
    fs.appendFileSync(dumpPath, JSON.stringify({ slot, t: Date.now(), type, raw: payload }) + '\n');
  } catch {}
}
// diagnóstico: grava também a resposta de chamadas REST /api/ (ex.: mercado global, que pode não
// vir por WS). Só quando o modo diag está ligado. Redige qualquer token na querystring por segurança.
function dumpHttp(slot, url, body, b64) {
  if (!dumpPath) return;
  try {
    const clean = String(url).replace(/([?&](?:token|access_token|jwt|auth|refresh(?:Token)?)=)[^&]*/gi, '$1<redacted>');
    let raw = body; if (b64) { try { raw = Buffer.from(body, 'base64').toString('utf8'); } catch {} }
    if (raw && raw.length > 200000) raw = raw.slice(0, 200000) + '…[truncado]';   // teto por segurança
    fs.appendFileSync(dumpPath, JSON.stringify({ slot, t: Date.now(), kind: 'http', url: clean, raw }) + '\n');
  } catch {}
}

const activeSlots = () => games.map((g) => g.slot);
function nextFreeSlot() { for (let s = 1; s <= MAXV; s++) if (!activeSlots().includes(s)) return s; return null; }
function persistSlots() { try { store.setSettings({ activeSlots: activeSlots() }); } catch {} }
function charNameOf(slot) { const g = games.find((x) => x.slot === slot); return (g && g.state && g.state.charName) || null; }
// rótulo da conta: nome que o Antônio deu > nick do char (da REST) > "Conta N"
function realName(slot) { const n = (store.getSettings().accountNames || {})[String(slot)]; return n || charNameOf(slot) || null; }
function getName(slot) { return realName(slot) || `Conta ${slot}`; }
// grava o evento com o nome REAL da conta se já conhecido; o fallback "Conta N" nunca vai pro disco,
// só pra UI — assim o histórico ganha o nick retroativamente quando ele carregar
function appendEv(slot, obj) {
  const n = realName(slot);
  const ev = store.appendEvent(Object.assign({ account: `acc${slot}` }, n ? { accountName: n } : {}, obj));
  return ev.accountName ? ev : Object.assign({ accountName: getName(slot) }, ev);
}

// ---------------- layout ----------------
const GAP = 3;   // divisória fininha entre as telas
function _tiles(count, x, y, w, h) {
  if (count <= 1) return [{ x, y, width: w, height: h }];
  const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
  if (count === 2) return [{ x, y, width: hw, height: h }, { x: x + hw, y, width: w - hw, height: h }];
  if (count === 3) return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: w, height: h - hh }];
  return [{ x, y, width: hw, height: hh }, { x: x + hw, y, width: w - hw, height: hh }, { x, y: y + hh, width: hw, height: h - hh }, { x: x + hw, y: y + hh, width: w - hw, height: h - hh }];
}
function tileRects(count, x, y, w, h) {
  return _tiles(count, x, y, w, h).map((r) => ({ x: r.x + GAP, y: r.y + GAP, width: Math.max(r.width - GAP * 2, 20), height: Math.max(r.height - GAP * 2, 20) }));
}
// ⚠️ FOCO: esconder/mover/re-addChildView uma WebContentsView FOCADA rouba o foco OS do
// input do jogo (era o bug "input desfoca sozinho": o painel re-mandava view/modo em todo
// render e cada layout() redundante escondia/re-adicionava as telas). Por isso o layout é
// IDEMPOTENTE: calcula o alvo e só aplica a DIFERENÇA; não re-adiciona child view
// (a ordem z já fica certa desde a criação: painel primeiro, jogos por cima).
function setViewBounds(v, r) {
  try { const c = v.getBounds(); if (c.x === r.x && c.y === r.y && c.width === r.width && c.height === r.height) return; } catch {}
  v.setBounds(r);
}
function layout() {
  if (!win) return;
  const b = win.getContentBounds();
  setViewBounds(dashView, { x: 0, y: 0, width: b.width, height: b.height });   // a UI (app.html) ocupa a janela toda
  const target = new Map();   // slot -> rect das telas que devem estar VISÍVEIS
  // modalOpen: config/notif abertos → nenhuma tela visível, pra o painel (que fica ATRÁS na ordem z) aparecer
  if (view === 'game' && !modalOpen) {
    const x0 = SIDE_W, y0 = BAR, w = Math.max(b.width - x0, 100), h = Math.max(b.height - y0, 100);
    if (gameMode === 'grid') {                                             // GRADE: todas as telas do jogo em 2×2 (1–4)
      const rects = tileRects(games.length, x0, y0, w, h);
      games.forEach((g, i) => { if (rects[i]) target.set(g.slot, rects[i]); });
    } else if (selectedSlot != null) {                                     // FOCO: só a conta selecionada, tela cheia à direita
      if (games.some((x) => x.slot === selectedSlot)) target.set(selectedSlot, { x: x0, y: y0, width: w, height: h });
    }
  }
  games.forEach((g) => {
    const r = target.get(g.slot);
    if (r) { setViewBounds(g.view, r); if (g._shown !== true) { g.view.setVisible(true); g._shown = true; } }
    else if (g._shown !== false) { g.view.setVisible(false); g._shown = false; }
  });
}

// ---------------- injeção de UX no jogo (CSS reversível — nada de gameplay/DOM de dado) ----------------
// O jogo usa classes CSS legíveis. A gente injeta 1 folha de estilo que, sob html.pcz-clean,
// esconde o chat (foi pro painel do coletor) e deixa as barras que sobrepõem tudo (nav, dock,
// auto-helper, barra de pokémon) BEM apagadas, voltando ao normal no hover. Só declutter visual.
const GAME_UX_CSS = [
  'html.pcz-clean .msg-chat{display:none !important;}',                                                      /* chat foi pro painel do coletor */
  'html.pcz-clean .game-hud,html.pcz-clean .game-dock{opacity:.08 !important;transition:opacity .18s ease !important;}',   /* MENU: some e volta no hover */
  'html.pcz-clean .game-hud:hover,html.pcz-clean .game-dock:hover{opacity:1 !important;}',
  'html.pcz-clean .phud{top:82px !important;}',        /* barra de pokémon: NÃO some, só desce */
  'html.pcz-clean .ah-panel{top:74px !important;}',    /* auto-helper: NÃO some, só desce */
].join('\n');
function injectGameUX(g) {
  try {
    const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return;
    const clean = store.getSettings().gameClean !== false;
    const js = `(function(){try{var s=document.getElementById('pcz-ux');if(!s){s=document.createElement('style');s.id='pcz-ux';s.textContent=${JSON.stringify(GAME_UX_CSS)};(document.head||document.documentElement).appendChild(s);}document.documentElement.classList.toggle('pcz-clean', ${clean});}catch(e){}})()`;
    wc.executeJavaScript(js, false).catch(() => {});
  } catch {}
}

// ---------------- helper de UX injetado no jogo (seletor de nível no Mapa) ----------------
// NÃO automatiza gameplay nem lê dado da conta: adiciona um <select> de faixa de nível ao filtro
// do Mapa (mantém os inputs de/até, só preenche via setter React-aware).
const GAME_HELPERS_JS = `(function(){
  if(window.__pczHelpers) return; window.__pczHelpers=1;
  try{
    var nset=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    function setIn(i,v){ try{ nset.call(i,String(v)); i.dispatchEvent(new Event('input',{bubbles:true})); }catch(_){} }
    function enh(){ try{
      var lab=document.querySelector('label.map-filter-lvl'); if(!lab||lab.__pcz) return;
      var ins=lab.querySelectorAll('input[type=number]'); if(ins.length<2) return; lab.__pcz=1;
      var de=ins[0], ate=ins[1], s=document.createElement('select');
      s.title='Faixa de nível'; s.style.cssText='margin-left:6px;background:#182231;color:#e8edf5;border:1px solid #33405a;border-radius:6px;padding:2px 4px;font-size:12px;cursor:pointer';
      [['Nível…','',''],['1–20',1,20],['20–40',20,40],['40–60',40,60],['60–80',60,80],['80–100',80,100],['100–120',100,120],['120–140',120,140],['140+',140,'']].forEach(function(b){var o=document.createElement('option');o.value=b[1]+'|'+b[2];o.textContent=b[0];s.appendChild(o);});
      s.addEventListener('change',function(){var p=s.value.split('|');setIn(de,p[0]);setIn(ate,p[1]);});
      lab.appendChild(s);
    }catch(_){}}
    var mo=new MutationObserver(enh); mo.observe(document.documentElement,{childList:true,subtree:true}); enh();
  }catch(_){}
})();`;
function injectGameHelpers(g) {
  try { const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return; wc.executeJavaScript(GAME_HELPERS_JS, false).catch(() => {}); } catch {}
}

// ---------------- lista simplificada DENTRO do Mapa do jogo ----------------
// Quando o modal do Mapa abre, uma LISTA ordenável (tipo, Lv, XP, venda, loot, efetividade
// vs o SEU time) cobre a área do mapa; "Ver mapa do jogo" volta pro visual. Só UI: os dados
// vêm do catálogo público (creatures/items.json) + tipos do time (WS). Clicar numa linha NÃO
// inicia hunt — preenche a busca do próprio mapa (mesma técnica React-aware do seletor de
// nível) e mostra o mapa pra VOCÊ clicar na hunt.
const MAP_TC = calc.TYPE_CHART;   // fonte ÚNICA da tabela de efetividade (ver calc.js); o script do Mapa a serializa
const MAP_TP_PT = { NORMAL: 'Normal', FIRE: 'Fogo', WATER: 'Água', GRASS: 'Planta', ELECTRIC: 'Elétrico', ICE: 'Gelo', FIGHTING: 'Lutador', POISON: 'Veneno', GROUND: 'Terra', FLYING: 'Voador', PSYCHIC: 'Psíquico', BUG: 'Inseto', ROCK: 'Pedra', GHOST: 'Fantasma', DRAGON: 'Dragão', DARK: 'Sombrio', STEEL: 'Aço', FAIRY: 'Fada' };
const MAP_TP_COL = { NORMAL: '#A8A77A', FIRE: '#EE8130', WATER: '#6390F0', ELECTRIC: '#F7D02C', GRASS: '#7AC74C', ICE: '#96D9D6', FIGHTING: '#C22E28', POISON: '#A33EA1', GROUND: '#E2BF65', FLYING: '#A98FF3', PSYCHIC: '#F95587', BUG: '#A6B91A', ROCK: '#B6A136', GHOST: '#735797', DRAGON: '#6F35FC', DARK: '#705746', STEEL: '#B7B7CE', FAIRY: '#D685AD' };
const MAP_RAR_PT = { COMMON: 'Comum', UNCOMMON: 'Incomum', RARE: 'Rara', EPIC: 'Épica', LEGENDARY: 'Lendária', MYTHIC: 'Mythic' };

const GAME_MAPLIST_JS = `(function(){
  if (window.__pczMapList) return; window.__pczMapList = 1;
  var TC=${JSON.stringify(MAP_TC)}, TPT=${JSON.stringify(MAP_TP_PT)}, TCOL=${JSON.stringify(MAP_TP_COL)}, RPT=${JSON.stringify(MAP_RAR_PT)};
  var nset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  function setIn(i, v) { try { nset.call(i, String(v)); i.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
  function eff1(a, d) { var r = TC[a]; if (!r) return 1; var v = r[d]; return v == null ? 1 : v; }
  function effVs(a, d1, d2) { return eff1(a, d1) * (d2 ? eff1(a, d2) : 1); }   // dupla tipagem multiplica
  function best(team, d1, d2) { var b = null; (team || []).forEach(function (p) { [p.type1, p.type2].forEach(function (a) { if (!a) return; var m = effVs(a, d1, d2); if (!b || m > b.m) b = { m: m, t: a, n: p.name }; }); }); return b; }
  function effTxt(m) { return ('×' + m).replace('.', ','); }
  function effCol(m) { return m >= 4 ? '#f7cf4f' : m >= 2 ? '#56df89' : m === 0 ? '#66708a' : m < 1 ? '#ff6b7a' : '#e8edf5'; }
  function fmt(n) { return n == null ? '—' : Number(n).toLocaleString('pt-BR'); }
  function badge(t) { return t ? '<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9.5px;font-weight:700;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.35);margin-right:3px;background:' + (TCOL[t] || '#666') + '">' + (TPT[t] || t) + '</span>' : ''; }
  var S = { k: 'lv', d: 1, q: '', t: '', mn: '', mx: '' };
  function findSearch() { var ins = document.querySelectorAll('input'); for (var i = 0; i < ins.length; i++) { if (/buscar hunt/i.test(ins[i].getAttribute('placeholder') || '')) return ins[i]; } return null; }
  // acha o marcador da hunt no mapa do jogo: elemento "folha" cujo texto é exatamente o nome,
  // fora da nossa lista; sobe pro ancestral clicável (cursor:pointer) se houver
  function findMarker(name) {
    var ml = document.getElementById('pcz-ml');
    var root = (ml && ml.parentElement) ? ml.parentElement : document.body;
    var lo = String(name).toLowerCase(), all = root.querySelectorAll('*'), cand = null;
    for (var i = 0; i < all.length; i++) {   // querySelectorAll é ordem de documento: o último match é o mais PROFUNDO (rótulo, não contêiner)
      var el = all[i];
      if (ml && ml.contains(el)) continue;
      var t = (el.textContent || '').trim().toLowerCase();
      if (t !== lo && t.indexOf(lo + ' ') !== 0 && t.replace(/\\s*nv\\s*\\d+$/, '') !== lo) continue;
      if (cand && !cand.contains(el)) continue;   // só desce na MESMA cadeia (não pula pra outro marcador)
      cand = el;
    }
    if (!cand) return null;
    var e = cand, hops = 0;
    while (e && hops < 7) { try { if (getComputedStyle(e).cursor === 'pointer' || e.onclick) return e; } catch (_) {} e = e.parentElement; hops++; }
    return cand;
  }
  function fireClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (tp) {
      try { el.dispatchEvent(new MouseEvent(tp, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch (_) {}
    });
  }
  // teleporta pra hunt de uma espécie (chamado pelo botão Shiny Hunt da barra lateral, via IPC).
  // Se o mapa estiver aberto, filtra e clica no marcador; se não, tenta ABRIR o mapa primeiro.
  function openMapBtn() {
    // botão real do jogo (confirmado por sonda de DOM): <button class="dock-btn" aria-label="Mapa"> com <img src=".../icon_map.png">
    var el = document.querySelector('button.dock-btn[aria-label="Mapa" i], [aria-label="Mapa" i], img[src*="icon_map"]');
    if (el) {
      if (el.tagName === 'IMG') el = el.closest('button,[role=button],a') || el;   // clica no botão, não na imagem
      fireClick(el); return true;
    }
    // fallback: qualquer clicável rotulado "mapa"/"map" (caso o jogo mude a marcação num update)
    var cands = document.querySelectorAll('button,[role=button],a,img');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var lbl = ((c.getAttribute && (c.getAttribute('aria-label') || c.getAttribute('title') || c.getAttribute('alt'))) || '') + ' ' + (c.childElementCount === 0 ? (c.textContent || '') : '');
      if (/\bmapa?\b/i.test(lbl)) { fireClick(c.closest && c.tagName === 'IMG' ? (c.closest('button,[role=button],a') || c) : c); return true; }
    }
    return false;
  }
  window.__pczGotoHunt = function (name) {
    var weOpened = false, entering = false;
    function enter() {   // filtra o mapa e clica no marcador da hunt (tenta por ~3s até o marcador surgir)
      var inp = findSearch(); if (inp) setIn(inp, name);
      (function findLoop(t) {
        var el = findMarker(name);
        if (el) { fireClick(el); return; }
        if (t < 20) setTimeout(function () { findLoop(t + 1); }, 160);
      })(0);
    }
    (function waitOpen(tries) {
      if (entering) return;
      var inp = findSearch();
      if (inp) {                         // mapa está aberto
        entering = true;
        if (weOpened) {                  // FOMOS nós que abrimos → espera aleatório 1–3s antes de entrar
          setTimeout(enter, 1000 + Math.floor(Math.random() * 2000));
        } else { enter(); }              // já estava aberto → entra direto
        return;
      }
      if (!weOpened) { weOpened = true; openMapBtn(); }   // mapa fechado → clica no botão de mapa
      if (tries < 40) setTimeout(function () { waitOpen(tries + 1); }, 160);
    })(0);
  };
  // volta pra Cerulean: mira direto no botão dock-btn do HUD (sempre presente quando logado)
  window.__pczReturnCerulean = function () {
    var btn = document.querySelector('button.dock-btn[aria-label="Voltar para Cerulean" i]');
    if (!btn) {
      var img = document.querySelector('img[src*="/home.png" i]');
      if (img) btn = img.closest('button');
    }
    if (btn) fireClick(btn);
  };
  function render() {
    var b = document.getElementById('pcz-ml-b'); if (!b) return;
    var D = window.__pczMapData || { creatures: [], team: [] };
    var q = S.q.toLowerCase(), rows = [];
    (D.creatures || []).forEach(function (c) {
      if (q && c.name.toLowerCase().indexOf(q) < 0) return;
      if (S.t && c.type1 !== S.t && c.type2 !== S.t) return;
      if (S.mn !== '' && !(c.huntLevel >= +S.mn)) return;
      if (S.mx !== '' && !(c.huntLevel <= +S.mx)) return;
      rows.push({ c: c, b: best(D.team, c.type1, c.type2) });
    });
    var k = S.k, d = S.d;
    function val(r) { switch (k) { case 'name': return r.c.name.toLowerCase(); case 'lv': return r.c.huntLevel || 0; case 'xp': return r.c.xpKill || 0; case 'sell': return r.c.sellValue || 0; case 'loot': return r.c.lootGold || 0; case 'eff': return r.b ? r.b.m : -1; default: return 0; } }
    rows.sort(function (a, bb) { var x = val(a), y = val(bb); if (typeof x === 'string') return x.localeCompare(y) * d; return (x > y ? 1 : x < y ? -1 : 0) * d; });
    var n = document.getElementById('pcz-ml-n'); if (n) n.textContent = rows.length + ' hunts' + ((D.team || []).length ? '' : ' · time ainda carregando…');
    var hd = document.getElementById('pcz-ml-head');
    if (hd) Array.prototype.forEach.call(hd.querySelectorAll('th[data-k] span'), function (sp) { sp.textContent = sp.parentElement.getAttribute('data-k') === S.k ? (S.d < 0 ? ' ▾' : ' ▴') : ''; });
    b.innerHTML = rows.map(function (r) {
      var c = r.c, bb = r.b;
      return '<tr data-n="' + c.name + '" style="cursor:pointer;border-bottom:1px solid #1b2438">'
        + '<td style="padding:5px 9px;font-weight:600">' + c.name + '</td>'
        + '<td style="padding:5px 4px">' + badge(c.type1) + badge(c.type2) + '</td>'
        + '<td style="text-align:right;padding:5px 9px">' + (c.huntLevel || '') + '</td>'
        + '<td style="padding:5px 9px;color:#a8b3c7">' + (RPT[c.rarity] || c.rarity || '') + '</td>'
        + '<td style="text-align:right;padding:5px 9px">' + fmt(c.xpKill) + '</td>'
        + '<td style="text-align:right;padding:5px 9px;color:#56df89">' + fmt(c.sellValue) + '</td>'
        + '<td style="text-align:right;padding:5px 9px">' + (c.lootGold ? fmt(Math.round(c.lootGold)) : '—') + '</td>'
        + '<td style="padding:5px 9px">' + (bb ? '<b style="color:' + effCol(bb.m) + '">' + effTxt(bb.m) + '</b> <span style="color:#8791a4;font-size:10.5px">' + bb.n + ' · ' + (TPT[bb.t] || '') + '</span>' : '<span style="color:#66708a">—</span>') + '</td>'
        + '</tr>';
    }).join('');
    Array.prototype.forEach.call(b.querySelectorAll('tr'), function (tr) {
      tr.onclick = function () {
        var name = tr.getAttribute('data-n');
        var inp = findSearch(); if (inp) setIn(inp, name);   // filtra o mapa (feedback visual + fallback)
        var ov = document.getElementById('pcz-ml'), pill = document.getElementById('pcz-ml-pill');
        if (ov) ov.style.display = 'none'; if (pill) pill.style.display = 'block';
        // repassa O SEU clique pro marcador da hunt no mapa (1 clique → 1 clique; se não achar, fica o filtro)
        var tries = 0, tm = setInterval(function () {
          tries++;
          var el = findMarker(name);
          if (el) { clearInterval(tm); fireClick(el); }
          else if (tries > 20) clearInterval(tm);
        }, 150);
      };
    });
  }
  window.__pczMapRefresh = render;
  function build() {
    var inp = findSearch(); if (!inp || document.getElementById('pcz-ml')) return;
    var modal = null, e = inp;
    while (e && e !== document.body) { if (e.clientHeight > 380 && e.clientWidth > 420) { modal = e; break; } e = e.parentElement; }
    if (!modal) return;
    if (getComputedStyle(modal).position === 'static') modal.style.position = 'relative';
    var rM = modal.getBoundingClientRect(), rI = inp.getBoundingClientRect();
    var top = Math.max(0, Math.round(rI.bottom - rM.top) + 6);   // deixa header/abas/busca do jogo visíveis
    var inSt = 'background:#182231;color:#e8edf5;border:1px solid #33405a;border-radius:6px;padding:3px 7px;font-size:11.5px;outline:none';
    var ov = document.createElement('div'); ov.id = 'pcz-ml';
    ov.style.cssText = 'position:absolute;left:0;right:0;bottom:0;top:' + top + 'px;z-index:99999;background:#0c1320;color:#e8edf5;display:flex;flex-direction:column;font:12px/1.45 system-ui,sans-serif;overflow:hidden';
    ov.innerHTML = '<div style="display:flex;gap:6px;align-items:center;padding:7px 10px;border-bottom:1px solid #26304a;flex-wrap:wrap">'
      + '<b style="font-size:12.5px">📋 Lista de hunts</b>'
      + '<input id="pcz-ml-q" placeholder="nome…" style="width:110px;' + inSt + '">'
      + '<select id="pcz-ml-t" style="' + inSt + ';padding:3px 4px"><option value="">Todos os tipos</option>' + Object.keys(TPT).map(function (t) { return '<option value="' + t + '">' + TPT[t] + '</option>'; }).join('') + '</select>'
      + '<input id="pcz-ml-mn" type="number" placeholder="Lv mín" style="width:58px;' + inSt + '">'
      + '<input id="pcz-ml-mx" type="number" placeholder="Lv máx" style="width:58px;' + inSt + '">'
      + '<span id="pcz-ml-n" style="color:#8791a4;font-size:10.5px"></span>'
      + '<span style="flex:1"></span>'
      + '<button id="pcz-ml-map" style="' + inSt + ';cursor:pointer">🗺 Ver mapa do jogo</button>'
      + '</div>'
      + '<div style="flex:1;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr id="pcz-ml-head">'
      + [['name', 'Pokémon', 'left'], ['', 'Tipos', 'left'], ['lv', 'Lv', 'right'], ['', 'Raridade', 'left'], ['xp', 'XP/kill', 'right'], ['sell', 'Venda', 'right'], ['loot', 'Loot/kill', 'right'], ['eff', 'Melhor do time', 'left']].map(function (h) {
        return '<th ' + (h[0] ? 'data-k="' + h[0] + '"' : '') + ' style="position:sticky;top:0;background:#101a2b;text-align:' + h[2] + ';padding:6px 9px;color:#8791a4;font-size:10px;text-transform:uppercase;letter-spacing:.4px;' + (h[0] ? 'cursor:pointer' : '') + '">' + h[1] + '<span></span></th>';
      }).join('')
      + '</tr></thead><tbody id="pcz-ml-b"></tbody></table></div>'
      + '<div style="padding:5px 10px;color:#66708a;border-top:1px solid #26304a;font-size:10px">Clique numa hunt pra ENTRAR nela (se o jogo não abrir, ela fica filtrada no mapa pra você clicar). Efetividade considera as DUAS tipagens (ex.: Pedra em Fogo/Voador = ×4). Loot/kill = ouro estimado.</div>';
    modal.appendChild(ov);
    var pill = document.createElement('button'); pill.id = 'pcz-ml-pill'; pill.textContent = '📋 Lista';
    pill.style.cssText = 'position:absolute;right:14px;bottom:14px;z-index:99998;display:none;background:#182231;color:#e8edf5;border:1px solid #33405a;border-radius:16px;padding:6px 12px;cursor:pointer;font-size:12px';
    modal.appendChild(pill);
    pill.onclick = function () { ov.style.display = 'flex'; pill.style.display = 'none'; };
    ov.querySelector('#pcz-ml-map').onclick = function () { ov.style.display = 'none'; pill.style.display = 'block'; };
    var q = ov.querySelector('#pcz-ml-q'); q.oninput = function () { S.q = q.value; render(); };
    var t = ov.querySelector('#pcz-ml-t'); t.onchange = function () { S.t = t.value; render(); };
    var mn = ov.querySelector('#pcz-ml-mn'); mn.oninput = function () { S.mn = mn.value; render(); };
    var mx = ov.querySelector('#pcz-ml-mx'); mx.oninput = function () { S.mx = mx.value; render(); };
    Array.prototype.forEach.call(ov.querySelectorAll('th[data-k]'), function (th) {
      th.onclick = function () { var k = th.getAttribute('data-k'); S.d = (S.k === k) ? -S.d : -1; S.k = k; render(); };
    });
    render();
  }
  try { var mo = new MutationObserver(function () { build(); }); mo.observe(document.documentElement, { childList: true, subtree: true }); build(); } catch (_) {}
})();`;
// ouro esperado de loot por kill: chance (escala 100000) × qtd média × preço NPC do item (casado por nome)
function enrichedCreatures() {
  const priceByName = {};
  for (const it of Object.values(itemCatalog)) if (it.name) priceByName[it.name.toLowerCase()] = it.npcPrice || 0;
  return creatures.map((c) => Object.assign({}, c, {
    lootGold: +(c.loot || []).reduce((s, l) => s + (l.chance / 100000) * ((l.min + l.max) / 2) * (priceByName[(l.name || '').toLowerCase()] || 0), 0).toFixed(1),
  }));
}
// TOOLTIP DO JOGO (.inv-tip): quando o jogo mostra o tooltip de um poke, lemos o TEXTO dele
// (Nv, Qualidade ×Y, IV D/D — mesmo formato que o justpokedex parseia) e ANEXAMOS uma linha
// "💎 Potencial X% · Raridade". Só leitura do texto + append de 1 nó nosso; nada do jogo é alterado.
const GAME_TOOLTIP_JS = `(function(){
  if(window.__pczTip) return; window.__pczTip=1;
  function rar(q){ if(q==null) return null;
    if(q<1.0)return['Fraca','#8a93a6']; if(q<1.1)return['Comum','#b8c0cf']; if(q<1.3)return['Incomum','#63c77a'];
    if(q<1.5)return['Rara','#4aa3ff']; if(q<1.7)return['Épica','#b06cff']; if(q<2.0)return['Lendária','#f7cf4f'];
    if(q<3.0)return['Mythic','#ff7ab0']; if(q<4.0)return['Ancient','#ff9a4a']; return['Divine','#ff5a5a']; }
  function num(s){ if(s==null)return null; var n=parseFloat(String(s).replace(',','.')); return isNaN(n)?null:n; }
  function analyze(tip){
    try{
      var full=tip.innerText||'';
      var base=full.replace(/💎[^\\n]*/g,'').trim();          // ignora a NOSSA linha ao comparar
      var ex=tip.querySelector('.pcz-pot');
      if(!/(?:Nv|N[ií]vel|Lv)\\.?\\s*\\d+/i.test(base)){ if(ex)ex.remove(); tip.__pczSig=''; return; }   // não é card de poke
      if(tip.__pczSig===base) return;                          // mesmo poke → não refaz
      tip.__pczSig=base;
      if(ex)ex.remove();
      var ivM=base.match(/IV\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
      var qM=base.match(/(?:×|x)\\s*([\\d.,]+)/i);
      var iv=ivM?parseInt(ivM[1],10):null, ivMax=ivM?parseInt(ivM[2],10):192;
      var q=qM?num(qM[1]):null, r=rar(q);
      if(iv==null && q==null) return;                          // nada pra mostrar
      var parts=[];
      if(r) parts.push('<b style="color:'+r[1]+'">'+r[0]+'</b>'+(q!=null?' <span style="opacity:.65">×'+q+'</span>':''));
      if(iv!=null){ var pot=Math.round(iv/ivMax*100);
        var col=pot>=90?'#f7cf4f':pot>=75?'#56df89':pot>=50?'#e8edf5':'#ff8a95';
        parts.push('Potencial <b style="color:'+col+'">'+pot+'%</b> <span style="opacity:.65">('+iv+'/'+ivMax+')</span>'); }
      var el=document.createElement('div'); el.className='pcz-pot';
      el.style.cssText='margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.16);font:600 12px/1.35 system-ui,sans-serif;color:#e8edf5;white-space:nowrap;';
      el.innerHTML='💎 '+parts.join(' · ');
      tip.appendChild(el);
    }catch(e){}
  }
  var pending=false;
  function scan(){ pending=false; var tips=document.querySelectorAll('.inv-tip'); for(var i=0;i<tips.length;i++) analyze(tips[i]); }
  var mo=new MutationObserver(function(){ if(pending)return; pending=true; requestAnimationFrame(scan); });
  mo.observe(document.documentElement,{childList:true,subtree:true});
  scan();
})();`;
function injectTooltip(g) {
  try { const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return; wc.executeJavaScript(GAME_TOOLTIP_JS, false).catch(() => {}); } catch {}
}

// MERCADO GLOBAL (cards .mkt2-card): o jogo já mostra IV/raridade/quality no card; a gente ANEXA
// um badge de POTENCIAL % (IV/192) colorido pra bater o olho e achar os melhores. Só leitura do
// texto do card ("IV D/D") + append de 1 badge nosso. Estrutura confirmada por sonda de DOM.
const GAME_MARKET_JS = `(function(){
  if(window.__pczMkt) return; window.__pczMkt=1;
  function col(p){ return p>=90?'#f7cf4f':p>=75?'#56df89':p>=50?'#8fb3ff':'#ff8a95'; }
  function analyze(card){
    try{
      var meta=card.querySelector('.mkt2-card-meta'); if(!meta) return;
      var ivM=(meta.innerText||'').match(/IV\\s*(\\d+)\\s*\\/\\s*(\\d+)/i); if(!ivM) return;
      var iv=parseInt(ivM[1],10), ivMax=parseInt(ivM[2],10)||192, pot=Math.round(iv/ivMax*100);
      var ex=card.querySelector('.pcz-mkpot');
      if(ex){ if(card.__pczIv===iv) return; ex.remove(); }
      card.__pczIv=iv;
      var el=document.createElement('span'); el.className='pcz-mkpot';
      el.style.cssText='display:inline-block;margin-left:6px;padding:0 7px;border-radius:8px;font-weight:800;font-size:11px;line-height:17px;color:#0c1320;background:'+col(pot)+';';
      el.title='Potencial do IV (nosso)'; el.textContent=pot+'%';
      meta.appendChild(el);
    }catch(e){}
  }
  var pending=false;
  function scan(){ pending=false; var cs=document.querySelectorAll('.mkt2-card'); for(var i=0;i<cs.length;i++) analyze(cs[i]); }
  var mo=new MutationObserver(function(){ if(pending)return; pending=true; requestAnimationFrame(scan); });
  mo.observe(document.documentElement,{childList:true,subtree:true});
  scan();
})();`;
function injectMarket(g) {
  try { const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return; wc.executeJavaScript(GAME_MARKET_JS, false).catch(() => {}); } catch {}
}

// SONDA DE DOM (só leitura): captura o outerHTML do maior painel/modal aberto agora na tela do
// jogo, pra descobrir a estrutura real (classes, ids, data-attrs) antes de injetar UI. Não muda nada.
const DOM_PROBE_JS = `(function(){
  try{
    function desc(el){ var id=el.id?('#'+el.id):''; var cls=(typeof el.className==='string'&&el.className)?('.'+el.className.trim().split(/\\s+/).slice(0,3).join('.')):''; return el.tagName.toLowerCase()+id+cls; }
    var best=null,bestArea=0,cands=[];
    var all=document.querySelectorAll('div,section,dialog,[role=dialog]');
    for(var i=0;i<all.length;i++){ var el=all[i];
      if(el.id&&el.id.indexOf('pcz')===0) continue;
      if(el.closest&&el.closest('#pcz-ml')) continue;
      var s=getComputedStyle(el); if(s.position!=='fixed'&&s.position!=='absolute') continue;
      if(s.display==='none'||s.visibility==='hidden'||+s.opacity===0) continue;
      var r=el.getBoundingClientRect(); if(r.width<320||r.height<260) continue;
      var area=r.width*r.height; cands.push(desc(el)+' '+Math.round(r.width)+'x'+Math.round(r.height));
      if(area>bestArea){ bestArea=area; best=el; }
    }
    var target=best||document.body;
    var html=target.outerHTML||''; if(html.length>180000) html=html.slice(0,180000)+'<!--[truncado]-->';
    return { picked: desc(target), candidates: cands.slice(0,24), html: html };
  }catch(e){ return { picked:'(erro)', candidates:[String(e&&e.message)], html:'' }; }
})()`;
function injectMapList(g) {
  try { const wc = g.view.webContents; if (!wc || wc.isDestroyed()) return; wc.executeJavaScript(GAME_MAPLIST_JS, false).catch(() => {}); } catch {}
}
function pushMapList(g) {
  try {
    const wc = g.view.webContents; if (!wc || wc.isDestroyed() || !creatures.length) return;
    const data = {
      creatures: enrichedCreatures().map((c) => ({ name: c.name, type1: c.type1, type2: c.type2, huntLevel: c.huntLevel, rarity: c.rarity, xpKill: c.xpKill, sellValue: c.sellValue, lootGold: c.lootGold })),
      team: (g.state.team || []).filter((p) => p.team || p.leader).map((p) => ({ name: p.name, type1: p.type1 || null, type2: p.type2 || null })),
    };
    wc.executeJavaScript('window.__pczMapData=' + JSON.stringify(data) + ';window.__pczMapRefresh&&window.__pczMapRefresh();', false).catch(() => {});
  } catch {}
}

// ---------------- proteção de venda (bloqueia venda de raro via interceptação REST) ----------------
const SELL_PATTERNS = ['*/api/game/pokemon/sell', '*/api/game/shop/sell', '*/api/game/flint/sell'];
// devolve o motivo (string) se a venda inclui algo PROTEGIDO; senão null
function protectedInSell(state, url, body) {
  if (!body) return null;
  if (/pokemon\/sell/.test(url)) {                        // pokes: shiny ou lendário+
    const team = state.team || [];
    for (const pid of (body.pokeIds || [])) {
      const p = team.find((x) => x.id === pid); if (!p) continue;
      if (p.shiny) return `${p.name} ✨ shiny`;
      const r = gp.rarityFromQuality(p.quality);
      if (rarityIdx(r) >= rarityIdx('Lendária')) return `${p.name} (${r})`;
    }
    return null;
  }
  // itens: categoria 'card' (shiny cards) + Rare Pokémon Picture + Strange Pheromone
  const entries = Array.isArray(body.items) ? body.items : (body.itemId != null ? [{ itemId: body.itemId }] : []);
  for (const e of entries) {
    const iid = e && e.itemId != null ? e.itemId : e;
    const cat = itemCatalog[iid] || {}; const nm = cat.name || ('item ' + iid);
    if (cat.category === 'card') return nm;
    if (/pheromone|picture/i.test(nm)) return nm;
  }
  return null;
}
function handleSellIntercept(g, wc, params) {
  const id = params.requestId;
  const cont = () => { try { wc.debugger.sendCommand('Fetch.continueRequest', { requestId: id }).catch(() => {}); } catch {} };
  try {
    if (store.getSettings().sellProtect === false) return cont();
    const url = (params.request && params.request.url) || '';
    let body = null; try { body = JSON.parse((params.request && params.request.postData) || '{}'); } catch {}
    const prot = protectedInSell(g.state, url, body);
    if (prot) {   // BLOQUEIA a venda e avisa
      try { wc.debugger.sendCommand('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }).catch(() => {}); } catch {}
      fireAlert(g, 'sell_blocked', { what: prot });
      return;
    }
    return cont();
  } catch { return cont(); }   // fail-open: erro nunca trava o jogo
}

// ---------------- captura de rede (CDP) ----------------
function attachCapture(g) {
  const wc = g.view.webContents;
  const wsUrls = new Map();
  const httpReqs = new Map();   // requestId -> url das respostas /api/ a gravar (só no modo diag)
  try { wc.debugger.attach('1.3'); }
  catch (e) { console.error('[coletor] attach', g.slot, e && e.message); return; }
  wc.debugger.sendCommand('Network.enable').catch(() => {});
  wc.debugger.sendCommand('Fetch.enable', { patterns: SELL_PATTERNS.map((p) => ({ urlPattern: p, requestStage: 'Request' })) }).catch(() => {});   // pausa SÓ as vendas
  wc.debugger.on('message', (_e, method, params) => {
    try {
      if (method === 'Fetch.requestPaused') handleSellIntercept(g, wc, params);
      else if (method === 'Network.webSocketCreated') wsUrls.set(params.requestId, params.url);
      else if (method === 'Network.responseReceived') {   // diag: marca respostas REST /api/ pra gravar o corpo
        const url = params.response && params.response.url;
        if (diagOn && url && /\/api\//.test(url) && params.type !== 'WebSocket') httpReqs.set(params.requestId, url);
      }
      else if (method === 'Network.loadingFinished') {   // corpo já disponível → puxa e grava
        if (diagOn && httpReqs.has(params.requestId)) {
          const url = httpReqs.get(params.requestId); httpReqs.delete(params.requestId);
          wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then((res) => { if (res && res.body) dumpHttp(g.slot, url, res.body, res.base64Encoded); }).catch(() => {});
        } else if (httpReqs.has(params.requestId)) httpReqs.delete(params.requestId);
      }
      else if (method === 'Network.webSocketFrameReceived') {
        const r = params.response;
        if (r && r.opcode === 1 && r.payloadData) {
          g._lastFrameTs = Date.now();
          if (g._al && g._al.disc) { g._al.disc = false; fireAlert(g, 'reconnected', {}); }   // voltou a receber → religou
          if (diagOn) dumpFrame(g.slot, r.payloadData);   // modo diagnóstico ligado: grava o frame cru
          const msg = gp.parseFrame(r.payloadData);
          if (msg) handleMessage(g, msg);
        }
      }
    } catch { /* nunca derruba */ }
  });
}

// ---------------- coleta SERVIDOR (REST autoritativo, sob demanda) ----------------
// O jogo empurra `pokes`/`balls`/`pokedex` pelo WS só quando o painel abre DENTRO do jogo.
// A gente PUXA o mesmo dado da API REST (só GET, leitura pura) pra completar o painel sem
// abrir nada no jogo. IMPORTANTE (regras do jogo, seção 03): ferramentas que "performam
// ações repetidas automaticamente / simulam presença" são proibidas. Por isso NÃO há
// timer/metrônomo: o pull dispara só em EVENTOS REAIS do usuário — 1× ao logar/carregar a
// conta e quando ele clica "Atualizar" no painel. É equivalente a abrir o painel no jogo. Ver server-api.js.
let shapesDumped = false;       // grava 1x o JSON cru de cada endpoint pra calibrar os parsers

function dumpServerShapes(snap) {
  if (shapesDumped || !snap) return;
  try {
    const p = path.join(__dirname, 'server-shapes.json');
    fs.writeFileSync(p, JSON.stringify(snap, null, 2));
    shapesDumped = true;
    console.log('[coletor] server-shapes.json gravado (calibração)');
  } catch {}
}

async function pollServer(g) {
  if (!g || !g.view || g.view.webContents.isDestroyed()) return;
  let snap;
  try { snap = await api.pullSnapshot(g.view.webContents); } catch { return; }
  if (!snap || snap.__noauth || snap.__error) return;   // ainda não logou / falhou → mantém o WS
  dumpServerShapes(snap);
  const s = g.state;

  // BOLAS (com preço certo) — autoritativo, sem depender de abrir a bag no jogo
  const balls = api.normBalls(snap.balls);
  if (balls) {
    if (balls.catalog) s.ballCatalog = balls.catalog;
    if (balls.counts) s.balls = balls.counts;
  }

  // PROFILE = jackpot: nick, nível+XP, contagem AUTORITATIVA da pokédex, saldo, rank global
  const prof = api.normProfile(snap.profile);
  if (prof) {
    if (prof.level != null) s.trainer = { level: prof.level, xpInLevel: prof.xpInLevel, xpForNext: prof.xpForNext, rank: prof.rank, totalPlayers: prof.totalPlayers, totalCatches: prof.totalCatches };
    if (prof.gold != null) s.accountGold = prof.gold;
    if (prof.diamonds != null) s.diamonds = prof.diamonds;
    // NICK do char (rótulo da conta em vez de "Conta 1")
    if (prof.name && typeof prof.name === 'string') { const had = s.charName; s.charName = prof.name; if (!had && !store.getSettings().accountNames[String(g.slot)]) send(dashView, 'accounts', activeSlots()); }
  }

  // POKÉDEX: contagem AUTORITATIVA = profile.pokedexCount (o /pokedex.species é parcial). total = catálogo.
  const pk = api.normPokedex(snap.pokedex);
  const caughtCount = (prof && prof.pokedexCount != null) ? prof.pokedexCount : (pk ? pk.caught : null);
  if (caughtCount != null) s.serverPokedex = { caught: caughtCount, total: creatures.length || (pk && pk.total) || null, unlockKills: pk ? pk.unlockKills : null };

  // PROFISSÃO (Treinador de Prestígio): rank + progresso — resolve o painel que dependia de abrir no jogo
  const pf = api.normProfessions(snap.professions);
  if (pf) s.serverProfessions = pf;

  // STREAK: pontos + kills por espécie AUTORITATIVOS (pras metas Shiny Card / bônus pokédex)
  const streak = api.normStreak(snap.streak);
  if (streak) { s.serverStreak = streak; if (Object.keys(streak.killsByName).length) s.serverKillsByName = streak.killsByName; }

  // coleção inteira / offline / used-balls — guarda cru (uso futuro)
  s.serverAllPokes = snap.allPokes || s.serverAllPokes || null;
  s.serverOffline = snap.offline || s.serverOffline || null;
  s.serverUsedBalls = snap.usedBalls || s.serverUsedBalls || null;
  s._serverTs = Date.now();

  pushState(g);
}

// ---------------- eventos ----------------
// "notável" = quality >= qualityMin E IV >= ivMin (mesmo critério do alerta de captura e da Box)
function isRare(cap, st) {
  const q = +cap.quality || 0, iv = +cap.iv || 0;
  const qMin = st.qualityMin != null ? st.qualityMin : 1.73;
  const ivMin = st.ivMin != null ? st.ivMin : 110;
  return q >= qMin && iv >= ivMin;
}
// mapeia um poke cru (frame `pokes`/`poke-delta`) pro formato compacto persistido na Box
function boxPoke(p) {
  if (!p || p.id == null) return null;
  return {
    id: p.id, speciesId: p.speciesId, dex: resolveDex(p.speciesId, p.name), name: p.name,
    level: p.level, shiny: !!p.shiny, team: !!p.team, leader: !!p.leader,
    iv: p.ivTotal, ivMax: 192, quality: p.quality, rarity: gp.rarityFromQuality(p.quality), power: p.power,
    type1: p.type1 || null, type2: p.type2 || null, stats: p.stats || null, sellValue: p.sellValue,
  };
}

function handleMessage(g, msg) {
  if (msg.type === 'chat' && msg.msg) {   // chat do jogo → painel do coletor (o in-game fica oculto)
    const c = msg.msg;
    pushChat({ account: `acc${g.slot}`, accountName: getName(g.slot), channel: c.channel || 'world', from: c.fromName, level: c.level, vip: !!c.isVip, admin: !!c.isAdmin, body: c.body, at: c.at || new Date().toISOString() });
  }
  const evs = gp.applyMessage(g.state, msg);
  const st = store.getSettings();
  for (const e of evs) {
    if (e.type === 'capture' || e.type === 'shiny_capture') {
      const c = e.cap;
      const dex = resolveDex(c.speciesId, c.name);   // resolve sprite (outland casa pelo nome)
      const rec = { ts: Date.now(), name: c.name, dex, iv: c.iv, quality: c.quality, rarity: c.rarity, shiny: !!c.shiny };
      g.recent.push(rec); if (g.recent.length > 100) g.recent.shift();
      const kind = c.shiny ? 'shiny_capture' : (isRare(c, st) ? 'rare_capture' : 'capture');
      // campos extras (level/power/tipos/stats) alimentam o card do hover no painel de capturas
      const ev = appendEv(g.slot, {
        type: kind, name: c.name, dex, iv: c.iv, ivMax: 192, quality: c.quality, rarity: c.rarity,
        ball: c.ball, shiny: !!c.shiny, level: c.level, power: c.power,
        type1: c.type1 || null, type2: c.type2 || null, stats: c.stats || null, sellValue: c.sellValue,
      });
      const ui = ev;
      pushEvent(ui);
      // Box: registra a captura na hora (o frame `pokes` depois confirma/atualiza equipe e nível)
      if (c.id != null) try { store.upsertBox(`acc${g.slot}`, {
        id: c.id, speciesId: c.speciesId, dex, name: c.name, level: c.level, shiny: !!c.shiny,
        iv: c.iv, ivMax: 192, quality: c.quality, rarity: c.rarity, power: c.power,
        type1: c.type1 || null, type2: c.type2 || null, stats: c.stats || null, sellValue: c.sellValue,
      }); } catch {}
      if (kind !== 'capture') { alertUI(ui); if (kind === 'shiny_capture') { if (st.screenshotOnShiny) shoot(g, ev); postDiscordShiny(g, c); } }
    } else if (e.type === 'shiny_field') {
      // shiny APARECEU na tela (oportunidade de captura). Debounce: no máx 1 por 20s por conta,
      // porque um mesmo shiny pode reaparecer em frames após sair/voltar do campo de visão.
      const now = Date.now();
      if (!g._shinyFieldTs || now - g._shinyFieldTs > 20000) {
        g._shinyFieldTs = now;
        // o mob do frame `field` só traz speciesId (= dex nacional); o NOME vem do catálogo
        const dex = resolveDex(e.cap.speciesId, e.cap.name);
        const nm = e.cap.name || (creatures.find((c) => c.dex === dex) || {}).name || null;
        const ev = appendEv(g.slot, { type: 'shiny_field', name: nm, dex });
        pushEvent(ev); alertUI(ev);
      }
    } else if (e.type === 'shiny_wild') {
      const ev = appendEv(g.slot, { type: 'shiny_wild', name: e.cap.name, dex: resolveDex(e.cap.speciesId, e.cap.name) });
      pushEvent(ev); alertUI(ev);
    } else if (e.type === 'shiny_global') {
      // shiny de OUTROS players: ignorado de propósito (o usuário só quer os shinys das próprias contas)
    } else if (e.type === 'hunt-reset') {
      g.startTs = Date.now(); g.leaderLevelStart = null; g.recent = [];   // zera o cronômetro dos "por hora"
    } else if (e.type === 'disconnected') {
      if (!g._al || !g._al.disc) { (g._al = g._al || {}).disc = true; fireAlert(g, 'disconnected', { reason: e.reason || null }); }
    } else if (e.type === 'died') {
      fireAlert(g, 'died', { name: e.name || null });
    }
  }
  evalAlerts(g);
  evalGift(g);
  if (g.bot && g.bot.running) {
    if (msg.type === 'field-init') g.bot._onEvent('field-init');
    if (msg.type === 'profession-photo') g.bot._onEvent('profession_photo');
    for (const e of evs) {
      if (e.type === 'shiny_field') g.bot._onEvent('shiny_field');
      if (e.type === 'shiny_capture') g.bot._onEvent('shiny_capture');
    }
  }
  if (msg.type === 'pokes') {
    pushMapList(g);   // time mudou → atualiza a efetividade da lista do Mapa
    // Box: o frame `pokes` traz a coleção inteira → persiste tudo (merge por id, com nível/equipe atuais)
    try { store.saveBoxList(`acc${g.slot}`, (g.state.team || []).map(boxPoke).filter(Boolean)); } catch {}
  }
  if (msg.type !== 'field' && msg.type !== 'chat') pushState(g);
}

// ---------------- alertas (balls/potions acabando, morte, desconexão) ----------------
function fireAlert(g, type, extra) {
  const ev = appendEv(g.slot, Object.assign({ type }, extra || {}));
  pushEvent(ev); alertUI(ev);
}
// só aceita URL de webhook do PRÓPRIO Discord (evita mandar dado pra qualquer lugar por erro de digitação)
const DISCORD_WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i;
function discordMessage(cap, accName) {
  const iv = cap.iv != null ? `${cap.iv}/192 (${Math.round(cap.iv / 192 * 100)}%)` : '—';
  return `✨ **Shiny capturado!** ${cap.name || '?'} — conta **${accName}** · IV ${iv}${cap.quality ? ` · quality ${cap.quality}` : ''}`;
}
async function postDiscord(content) {
  const url = (store.getSettings().discordWebhook || '').trim();
  if (!DISCORD_WEBHOOK_RE.test(url)) return false;   // vazio ou não-Discord → não envia
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Poke Idle Launcher', content }) });
    return true;
  } catch { return false; }
}
function postDiscordShiny(g, cap) { postDiscord(discordMessage(cap, getName(g.slot))).catch(() => {}); }
// SÓ Ultra Ball conta pro alerta/aura: as outras bolas ficam paradas no inventário, é a Ultra que se gasta
function ultraBallsTotal(s) {
  if (!s.balls) return null;
  const ub = (s.ballCatalog || []).find((b) => /ultra/i.test(b.name || ''));
  if (!ub) return null;   // catálogo ainda não chegou → não alarma
  return s.balls[ub.id] || s.balls[String(ub.id)] || 0;
}
// total de potions (itens da categoria heal do inventário)
function potionsTotal(s) { if (!s.inventory) return null; let t = 0; for (const it of s.inventory) { const c = itemCatalog[it.itemId]; if (c && c.category === 'heal') t += it.quantity || 0; } return t; }
// total de revives (categoria revive: Revive + Max Revive)
function revivesTotal(s) { if (!s.inventory) return null; let t = 0; for (const it of s.inventory) { const c = itemCatalog[it.itemId]; if (c && c.category === 'revive') t += it.quantity || 0; } return t; }
// dispara alertas por LIMIAR com histerese (só refoga quando volta bem acima → não fica repetindo)
function evalAlerts(g) {
  const s = g.state, st = store.getSettings();
  g._al = g._al || {};
  const ballsThr = st.ballsAlert != null ? st.ballsAlert : 200;
  const potThr = st.potionsAlert != null ? st.potionsAlert : 30;
  const revThr = st.revivesAlert != null ? st.revivesAlert : 10;
  const bt = ultraBallsTotal(s);   // SÓ Ultra Ball (as outras não são gastas na prática)
  if (bt != null) {
    if (bt <= ballsThr && !g._al.balls) { g._al.balls = true; fireAlert(g, 'balls_low', { count: bt }); }
    else if (bt > ballsThr * 1.5) g._al.balls = false;
  }
  const pt = potionsTotal(s);
  if (pt != null) {
    if (pt <= 0 && !g._al.potOut) { g._al.potOut = true; fireAlert(g, 'potions_out', {}); }
    else if (pt > 0) g._al.potOut = false;
    if (pt > 0 && pt <= potThr && !g._al.pot) { g._al.pot = true; fireAlert(g, 'potions_low', { count: pt }); }
    else if (pt > potThr * 1.5) g._al.pot = false;
  }
  const rv = revivesTotal(s);
  if (rv != null) {
    if (rv <= revThr && !g._al.rev) { g._al.rev = true; fireAlert(g, 'revives_low', { count: rv }); }
    else if (rv > revThr * 1.5) g._al.rev = false;
  }
}

// PRESENTE DIÁRIO (Fase 2): o único sinal de rede é state.mail.gifts (nº de presentes no correio).
// - gifts>0  → há presente pra coletar → alerta 1× por leva (respeitando o toggle giftAlert).
// - gifts caiu p/ 0 → coletou tudo → marca o relógio; o painel mostra a contagem regressiva de 24h.
// Heurística calibrável: gifts do correio ≈ presente diário (o jogo não expõe um endpoint dedicado).
function evalGift(g) {
  const s = g.state, st = store.getSettings();
  const gifts = s.mail ? (s.mail.gifts || 0) : null;
  if (gifts == null) return;   // correio ainda não chegou
  const prev = g._prevGifts;
  g._prevGifts = gifts;
  if (prev != null && prev > 0 && gifts === 0) {   // transição p/ zero = coletou → inicia as 24h
    s.giftClaimedAt = Date.now();
    store.saveProgress(`acc${g.slot}`, { giftClaimedAt: s.giftClaimedAt });
  }
  if (gifts > 0) {
    if (st.giftAlert !== false && !g._giftAlerted) { g._giftAlerted = true; fireAlert(g, 'gift', { count: gifts }); }
  } else {
    g._giftAlerted = false;   // rearma pro próximo presente
  }
}

const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const titleCase = (s) => String(s || '').split(/\s+/).map(cap1).join(' ');
// info do que está caçando (dex + tipo) pra a cena e o preview PokeAPI.
// o slug vem com underscore ("enraged_typhlosion") — normaliza pra casar com o nome da criatura,
// e resolve o dex de sprite (outland tem pokeId>=10000, cai no resolveDex pelo nome).
function huntInfo(slug) {
  if (!slug) return null;
  const norm = String(slug).replace(/_/g, ' ').toLowerCase();
  const c = creatures.find((x) => x.name && x.name.toLowerCase() === norm);
  const type1 = c ? (c.type1 || null) : null, type2 = c ? (c.type2 || null) : null;
  return {
    slug, name: c ? c.name : titleCase(norm), dex: c ? resolveDex(c.dex, c.name) : resolveDex(null, norm),
    type: type1, type1, type2,
    defense: calc.defenseProfile(type1, type2),   // a que o ALVO é fraco → o que levar pra caçar (Fase 1)
  };
}

function compactState(g) {
  const s = g.state;
  const leader = (s.team || []).find((p) => p.leader) || (s.team || [])[0] || null;
  if (leader && g.leaderLevelStart == null) g.leaderLevelStart = leader.level;
  const now = Date.now();
  const hrs = Math.max((now - g.startTs) / 3600000, 1 / 3600);
  const L = s.live, a = s.analyzer;
  const hunt = huntInfo(s.hunt && s.hunt.slug);
  const captures = L.captures || 0;
  const cc = calc.catchCost(L, s.ballCatalog, s._lastBall);
  const shiny = calc.shinyStats(L, hrs);
  const gn = calc.goldNet(a);
  const xb = calc.xpBreakdown(L);
  const gl = calc.goals(s, hunt ? hunt.name : null);
  // OURO calculado por conta própria (não depende do analyzer aberto): loot×preço + venda das capturas − custo das balls
  const lootGold = Object.values(L.loot).reduce((sum, e) => sum + (e.qty || 0) * (((itemCatalog[e.itemId] || {}).npcPrice) || 0), 0);
  // loot detalhado com preço/ouro por item (pra tabela de loot do dashboard) — cópia, não mexe no estado
  const lootDetailed = {};
  for (const e of Object.values(L.loot)) {
    const cat = itemCatalog[e.itemId] || {};
    const price = cat.npcPrice || 0;
    lootDetailed[e.itemId] = { itemId: e.itemId, name: e.name, qty: e.qty, price, gold: (e.qty || 0) * price, icon: cat.icon || null };
  }
  const ballCost = Object.entries(L.ballsUsed || {}).reduce((sum, [bid, cnt]) => {
    const b = (s.ballCatalog || []).find((x) => String(x.id) === String(bid));
    return sum + cnt * (((b || {}).priceGold) || 0);
  }, 0);
  const captureGold = L.captureGold || 0;
  const netGoldCalc = lootGold + captureGold - ballCost;
  const goldPerHourCalc = Math.round(netGoldCalc / hrs);
  const caughtArr = store.getCaught(`acc${g.slot}`);
  // pokédex: prefere a contagem AUTORITATIVA do servidor; senão cai no acumulado do disco
  const sp = s.serverPokedex || null;
  const dexTotal = (sp && sp.total) || creatures.length || 0;
  const dexCaught = (sp && sp.caught != null) ? sp.caught : caughtArr.length;
  const ballList = (s.ballCatalog || []).map((b) => ({ id: b.id, name: b.name, qty: (s.balls || {})[b.id] || 0, icon: itemIconUrl(b.iconUrl) })).filter((b) => b.qty > 0);
  const live = {
    captures, shinyCaptures: L.shinyCaptures, kills: L.kills, xp: L.xp,
    xpPerHour: Math.round(L.xp / hrs), killsPerHour: Math.round(L.kills / hrs),
    attempts: L.attempts || 0, catchPct: L.attempts ? +(captures / L.attempts * 100).toFixed(2) : null,
    ballsPerCap: cc.ballsPerCap, goldPerCap: cc.goldPerCap,
    levelUps: L.levelUps,
    levelsPerHour: (g.leaderLevelStart != null && leader) ? +(Math.max(0, leader.level - g.leaderLevelStart) / hrs).toFixed(2) : null,
    byRarity: L.byRarity, sinceMs: now - g.startTs, loot: lootDetailed,
  };
  return {
    slot: g.slot, name: getName(g.slot),
    loggedIn: !!(s.hunt || a || (s.team && s.team.length) || L.kills > 0),
    hunt,
    leader: leader ? {
      name: leader.name, dex: resolveDex(leader.speciesId, leader.name), level: leader.level, iv: leader.ivTotal, ivMax: 192,
      quality: leader.quality, rarity: gp.rarityFromQuality(leader.quality), power: leader.power,
      shiny: !!leader.shiny, stats: leader.stats || null,
      type1: leader.type1 || null, type2: leader.type2 || null,
      defense: calc.defenseProfile(leader.type1, leader.type2),   // a que o líder é fraco/resiste/imune (Fase 1)
      evolvesTo: leader.evolvesToName || null, evolveNeedLevel: leader.evolveNeedLevel || null,
    } : null,
    teamCount: (s.team || []).filter((p) => p.team).length,   // pokes.list traz a coleção inteira; time = os com team:true
    // tipos do time (pro cálculo de efetividade no Mapa)
    team: (s.team || []).filter((p) => p.team || p.leader).map((p) => ({
      name: p.name, dex: resolveDex(p.speciesId, p.name), level: p.level, leader: !!p.leader,
      type1: p.type1 || null, type2: p.type2 || null,
    })),
    analyzer: a || null, live,
    // OURO/h = SEMPRE o nosso cálculo fiel (loot+capturas−balls), que reseta por hunt.
    // (não usar o goldPerHour do analyzer OFICIAL: só existe com o painel aberto e fica velho na troca de hunt)
    kpi: { netPerHour: goldPerHourCalc, xpPerHour: Math.round(L.xp / hrs), captures, shinyCaught: L.shinyCaught || 0, ballsPerCap: cc.ballsPerCap },
    goldNet: gn, goldCalc: { lootGold, captureGold, ballCost, net: netGoldCalc, perHour: goldPerHourCalc }, xpBreak: xb, shiny, goals: gl,
    prof: { photos: s.profession.photos || 0 }, mail: s.mail || null,
    dailyGift: (() => {   // Fase 2: presentes pendentes + contagem regressiva de 24h desde a última coleta
      const claimedAt = s.giftClaimedAt || null;
      const nextAt = claimedAt ? claimedAt + 24 * 3600 * 1000 : null;
      return { gifts: (s.mail && s.mail.gifts) || 0, claimedAt, nextAt, msLeft: nextAt ? Math.max(nextAt - now, 0) : null };
    })(),
    trainer: s.trainer || null, accountGold: s.accountGold != null ? s.accountGold : null, diamonds: s.diamonds != null ? s.diamonds : null,
    profession: s.serverProfessions || null,   // rank/rankName/pictures/nextStep (autoritativo da REST)
    pokedex: { caught: dexCaught, total: dexTotal, missing: dexTotal ? Math.max(dexTotal - dexCaught, 0) : null, source: sp ? 'server' : 'local' },
    balls: s.balls || null, ballList, bag: buildBag(s.inventory), caught: caughtArr,
    // suprimentos que importam (pro widget e pra aura vermelha do painel)
    supplies: { ultra: ultraBallsTotal(s), potions: potionsTotal(s), revives: revivesTotal(s) },
    boosts: (s.boosts || []).map((b) => ({ name: b.name, emoji: b.emoji, desc: b.desc, until: b.until, pct: b.pct })),
    bestCatch: s.bestCatch ? Object.assign({}, s.bestCatch, { dex: resolveDex(s.bestCatch.speciesId, s.bestCatch.name) }) : null,
    bot: g.bot ? g.bot.getStatus() : null,
    recent: g.recent.slice(-40).reverse(),
  };
}
function send(target, ch, payload) { try { if (target && !target.webContents.isDestroyed()) target.webContents.send(ch, payload); } catch {} }
function pushState(g) {
  const now = Date.now();
  if (now - (g._lastPush || 0) < 700) return;
  g._lastPush = now;
  store.addCaught(`acc${g.slot}`, [...g.state.caughtSpecies]);   // acumula a pokédex no disco
  store.saveProgress(`acc${g.slot}`, { analyzer: g.state.analyzer, profession: g.state.profession, mail: g.state.mail });   // persiste pra mostrar sem re-abrir
  const cs = compactState(g);
  store.setLatest(`acc${g.slot}`, cs);
  send(dashView, 'state', cs);
  if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'state', cs);
}
function pushEvent(ev) { send(dashView, 'event', ev); if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'event', ev); }
function pushChat(m) { send(dashView, 'chat', m); }
function alertUI(ev) { send(dashView, 'alert', ev); if (overlayWin && !overlayWin.isDestroyed()) send(overlayWin, 'alert', ev); }
function shoot(g, ev) {
  const wc = g.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.capturePage().then((img) => {
    const p = store.saveShot(`acc${g.slot}`, img.toPNG());
    if (p) pushEvent(appendEv(g.slot, { type: 'shot', shot: p, of: ev.type, name: ev.name || null }));
  }).catch(() => {});
}

// ---------------- telas ----------------
function seedFromCache(g) {   // preenche o estado com o que ficou salvo → painel aparece na hora, sem re-abrir pokédex/analyzer
  const acc = `acc${g.slot}`;
  try {
    const prog = store.getProgress(acc) || {};
    if (prog.analyzer) g.state.analyzer = prog.analyzer;
    if (prog.profession) g.state.profession = prog.profession;
    if (prog.mail) g.state.mail = prog.mail;
    if (prog.giftClaimedAt) g.state.giftClaimedAt = prog.giftClaimedAt;   // relógio de 24h do presente diário
    for (const id of store.getCaught(acc)) g.state.caughtSpecies.add(id);   // pokédex acumulada no disco
  } catch {}
}
function createGame(slot) {
  const view2 = new WebContentsView({
    webPreferences: { partition: `persist:acc${slot}`, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const g = { view: view2, slot, state: gp.newState(), recent: [], startTs: Date.now(), leaderLevelStart: null, _lastPush: 0 };
  g.bot = new ShinyHuntBot(g, () => pushState(g));
  seedFromCache(g);   // mostra o último analyzer/profissão/pokédex antes mesmo do login
  attachTokenRestore(g);   // "lembrar login": restaura o token salvo antes do jogo pedir login
  attachCapture(g);   // antes do load, pra pegar o WS desde o começo
  // assim que a página carrega: injeta o declutter da UI + (com folga pro token) puxa o snapshot REST
  g.view.webContents.on('did-finish-load', () => { injectGameUX(g); injectGameHelpers(g); injectMapList(g); injectTooltip(g); injectMarket(g); setTimeout(() => { pollServer(g).catch(() => {}); pushMapList(g); }, 3500); });
  g.view.webContents.loadURL(GAME_URL).catch((e) => console.error('[coletor] loadURL', slot, e && e.message));
  win.contentView.addChildView(g.view);   // única vez — layout() não re-adiciona (roubaria o foco)
  g.view.setVisible(false); g._shown = false;
  games.push(g);
  return g;
}
function addGame() {
  if (games.length >= MAXV) return activeSlots();
  const slot = nextFreeSlot(); if (!slot) return activeSlots();
  createGame(slot); if (selectedSlot == null) selectedSlot = slot;
  persistSlots(); layout(); send(dashView, 'accounts', activeSlots());
  return activeSlots();
}
function removeGame(slot) {
  const i = games.findIndex((g) => g.slot === slot);
  if (i < 0) return activeSlots();
  const g = games[i];
  if (g.bot) g.bot.stop();
  try { g.view.webContents.debugger.detach(); } catch {}
  try { win.contentView.removeChildView(g.view); } catch {}
  try { if (typeof g.view.webContents.close === 'function') g.view.webContents.close(); } catch {}
  games.splice(i, 1);
  if (selectedSlot === slot) selectedSlot = games[0] ? games[0].slot : null;
  persistSlots(); layout(); send(dashView, 'accounts', activeSlots());
  return activeSlots();
}

// ---------------- overlay ----------------
function toggleOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.close(); overlayWin = null; return false; }
  overlayWin = new BrowserWindow({
    width: 300, height: 190, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  games.forEach((g) => pushState(g));
  return true;
}

// ---------------- IPC ----------------
ipcMain.handle('addView', () => addGame());
ipcMain.handle('removeView', (_e, slot) => removeGame(slot));
// ⚠️ FOCO: os 3 handlers abaixo são NO-OP quando nada mudou — o painel re-manda o estado da
// UI em todo render (a cada 'state'), e um layout() redundante roubava o foco do jogo.
ipcMain.handle('selectAccount', (_e, slot) => { if (slot === selectedSlot) return selectedSlot; selectedSlot = slot; layout(); return selectedSlot; });
ipcMain.handle('setGameMode', (_e, m) => { const nm = m === 'single' ? 'single' : 'grid'; if (nm === gameMode) return gameMode; gameMode = nm; layout(); return gameMode; });
ipcMain.handle('setView', (_e, v, slot) => {
  const nv = (v === 'game') ? 'game' : (v === 'detail' ? 'detail' : 'accounts');
  const ns = slot != null ? slot : selectedSlot;
  if (nv === view && ns === selectedSlot) return view;
  view = nv; selectedSlot = ns; layout(); return view;
});
// painel de config/notificações aberto/fechado: em game view, esconde/reexibe as telas do jogo
// (elas ficam por cima na ordem z e tapavam o painel). layout() é idempotente e não rouba foco.
ipcMain.handle('setModalOpen', (_e, open) => { const nv = !!open; if (nv === modalOpen) return modalOpen; modalOpen = nv; layout(); return modalOpen; });
// abre o simulador PIW Tools (externo) já preenchido com os stats do poke. URL de host fixo (nada de
// abrir link arbitrário) e só leitura — nenhuma ação de jogo. Disparado por clique do usuário.
ipcMain.handle('openPiwTools', (_e, p) => {
  try {
    if (!p || !p.name) return false;
    const st = p.stats || {};
    const q = (k) => encodeURIComponent(st[k] != null ? st[k] : 0);
    const name = encodeURIComponent(String(p.name).toLowerCase().trim());
    const level = encodeURIComponent(p.level != null ? p.level : 1);
    const url = `https://piwtools.vercel.app/hunt?pokemon=${name}&level=${level}&hp=${q('hp')}&atk=${q('atk')}&def=${q('def')}&spatk=${q('spAtk')}&spdef=${q('spDef')}&speed=${q('speed')}&tab=route&routeTarget=300`;
    shell.openExternal(url);
    return true;
  } catch { return false; }
});
ipcMain.handle('setAccountName', (_e, slot, name) => {
  const s = store.getSettings(); const names = Object.assign({}, s.accountNames || {});
  if (name && name.trim()) names[String(slot)] = name.trim().slice(0, 20); else delete names[String(slot)];
  store.setSettings({ accountNames: names });
  games.forEach((g) => pushState(g)); send(dashView, 'accounts', activeSlots());
  return names;
});
ipcMain.handle('reloadGame', (_e, slot) => { const g = games.find((x) => x.slot === slot); if (g) g.view.webContents.reload(); });
// limpa SÓ o cache HTTP (mantém cookies + storage = NÃO desloga) e recarrega. Storage/cookies não são tocados de propósito.
ipcMain.handle('testDiscord', () => postDiscord('✅ Teste do Poke Idle Launcher — webhook configurado! Você vai receber aqui quando pegar um shiny. ✨'));
ipcMain.handle('returnCerulean', (_e, slot) => {
  const g = games.find((x) => x.slot === slot);
  if (!g || !g.view || g.view.webContents.isDestroyed()) return false;
  try { g.view.webContents.executeJavaScript('window.__pczReturnCerulean && window.__pczReturnCerulean()', false).catch(() => {}); } catch {}
  return true;
});
ipcMain.handle('clearGameCache', async (_e, slot) => {
  const g = games.find((x) => x.slot === slot);
  if (!g || !g.view || g.view.webContents.isDestroyed()) return false;
  try { await g.view.webContents.session.clearCache(); } catch {}
  try { g.view.webContents.reload(); } catch {}
  return true;
});
ipcMain.handle('viewsInfo', () => games.map((g) => ({ slot: g.slot, name: getName(g.slot), url: g.view.webContents.getURL() })));
ipcMain.handle('snapshotAll', () => { games.forEach((g) => pushState(g)); return activeSlots(); });
// pull REST autoritativo SOB DEMANDA (clique do usuário no "Atualizar") — nunca em timer
ipcMain.handle('refreshServer', async (_e, slot) => {
  const list = slot != null ? games.filter((g) => g.slot === slot) : games;
  await Promise.all(list.map((g) => pollServer(g).catch(() => {})));
  return true;
});
ipcMain.handle('getEvents', () => store.readEvents(50000).map((e) => e.accountName ? e : Object.assign({ accountName: getName(Number((e.account || '').replace('acc', ''))) }, e)));
ipcMain.handle('getDaily', () => store.getDaily());
ipcMain.handle('gotoHunt', (_e, slot, name) => {
  const g = games.find((x) => x.slot === slot);
  if (!g || !g.view || g.view.webContents.isDestroyed() || !name) return false;
  try { g.view.webContents.executeJavaScript('window.__pczGotoHunt && window.__pczGotoHunt(' + JSON.stringify(String(name)) + ')', false).catch(() => {}); } catch {}
  return true;
});
ipcMain.handle('startBot', (_e, slot, huntList) => {
  const g = games.find((x) => x.slot === slot);
  if (!g || !g.bot || !huntList || !huntList.length) return false;
  const ok = g.bot.start(huntList);
  if (ok) pushState(g);
  return ok;
});
ipcMain.handle('stopBot', (_e, slot) => {
  const g = games.find((x) => x.slot === slot);
  if (!g || !g.bot) return false;
  g.bot.stop();
  return true;
});
ipcMain.handle('getBotStatus', (_e, slot) => {
  const g = games.find((x) => x.slot === slot);
  return g && g.bot ? g.bot.getStatus() : null;
});
ipcMain.handle('getCreatures', () => enrichedCreatures());
// sonda de DOM: salva o HTML do painel aberto do jogo (dom-probe-<ts>.html) e abre no explorador
ipcMain.handle('probeGameDom', async (_e, slot) => {
  const g = games.find((x) => x.slot === slot) || games[0];
  if (!g || !g.view || g.view.webContents.isDestroyed()) return { error: 'sem tela do jogo' };
  try {
    const res = await g.view.webContents.executeJavaScript(DOM_PROBE_JS, true);
    if (!res) return { error: 'sem resultado' };
    const file = path.join(path.dirname(dumpPath), `dom-probe-${Date.now()}.html`);
    try { fs.writeFileSync(file, res.html || ''); shell.showItemInFolder(file); } catch {}
    return { picked: res.picked, candidates: res.candidates, file, len: (res.html || '').length };
  } catch (e) { return { error: e && e.message }; }
});
ipcMain.handle('getBox', () => store.getBox());   // Box Pokémon: coleção persistida por conta { acc: { id: poke } }
// Mercado Global (sob demanda): puxa /api/game/market rodando na página de uma conta LOGADA (herda o token).
// Enriquecemos cada listagem com dex (sprite) e rarity. Nada de ação de jogo — GET de leitura pura.
ipcMain.handle('getMarket', async (_e, slot, category) => {
  const g = games.find((x) => x.slot === slot && x.state && (x.state.hunt || (x.state.team && x.state.team.length)))
    || games.find((x) => x.state && (x.state.hunt || (x.state.team && x.state.team.length))) || games[0];
  if (!g) return { error: 'no-account' };
  const raw = await api.pullMarket(g.view.webContents, category || 'Pokemon');
  if (!raw) return { error: 'no-data' };
  if (raw.__noauth) return { error: 'noauth' };
  if (raw.__error) return { error: raw.__error };
  const norm = api.normMarket(raw);
  if (!norm) return { error: 'bad-shape' };
  norm.listings = norm.listings.map((x) => Object.assign(x, { dex: resolveDex(x.speciesId, x.name), rarity: gp.rarityFromQuality(x.quality) }));
  norm.fromSlot = g.slot;
  return norm;
});
ipcMain.handle('toggleOverlay', () => toggleOverlay());
ipcMain.handle('winMinimize', () => { if (win) win.minimize(); });
ipcMain.handle('winClose', () => { if (win) win.close(); });
ipcMain.handle('getSettings', () => store.getSettings());
ipcMain.handle('setSettings', (_e, patch) => {
  const s = store.setSettings(patch);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'gameClean')) games.forEach((g) => injectGameUX(g));   // re-aplica o declutter na hora
  return s;
});
ipcMain.handle('readShot', (_e, p) => store.readShotDataURL(p));
ipcMain.handle('setDiag', (_e, on) => {
  diagOn = !!on; store.setSettings({ diagDump: diagOn });
  if (diagOn && dumpPath) {
    try { fs.writeFileSync(dumpPath, ''); } catch {}
    Object.keys(diagSeen).forEach((k) => delete diagSeen[k]);
    games.forEach((g) => { try { g.view.webContents.reload(); } catch {} });   // recarrega (re-loga pelo cookie) pra capturar o estado inicial: time/líder/pokédex/bolas
  }
  return diagOn;
});
ipcMain.handle('openDumpFolder', () => { try { if (dumpPath && fs.existsSync(dumpPath)) shell.showItemInFolder(dumpPath); else shell.openPath(app.getPath('userData')); } catch {} });
ipcMain.handle('openLanding', () => shell.openExternal(LANDING_URL));

// ---------------- ciclo de vida ----------------
app.whenReady().then(() => {
  // EMPACOTADO (.exe): dados vão pra userData (a pasta do app é read-only no asar). DEV: no projeto (eu inspeciono).
  const dataDir = app.isPackaged ? app.getPath('userData') : __dirname;
  store.init(dataDir);
  dumpPath = path.join(dataDir, 'ws-dump.jsonl');
  diagOn = !!store.getSettings().diagDump;
  tokenDir = path.join(app.getPath('userData'), 'tokens');   // login criptografado fica AQUI (não compartilhado)
  try { fs.mkdirSync(tokenDir, { recursive: true }); } catch {}
  tokenVault = createTokenVault({ tokenDir, safeStorage, serverMode: SERVER_MODE });
  loadItemCatalog();   // catálogo de itens pra Bag (assíncrono, não bloqueia)
  loadCreatures();     // catálogo de espécies pra Pokédex
  win = new BaseWindow({ width: 1320, height: 880, frame: false, show: true, backgroundColor: '#0b0e14', title: 'Poke Idle Launcher' });
  dashView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  dashView.webContents.loadFile(path.join(__dirname, 'app.html'));
  win.contentView.addChildView(dashView);

  const saved = (store.getSettings().activeSlots || [1]).filter((s) => s >= 1 && s <= MAXV);
  (saved.length ? saved : [1]).forEach((slot) => createGame(slot));
  selectedSlot = games[0] ? games[0].slot : null;
  layout();
  dashView.webContents.on('did-finish-load', () => { send(dashView, 'accounts', activeSlots()); games.forEach((g) => pushState(g)); });
  win.on('resize', layout);
  win.on('close', () => games.forEach((g) => { persistCookies(g); saveToken(g); try { g.view.webContents.debugger.detach(); } catch {} }));
  setInterval(() => games.forEach((g) => { persistCookies(g); saveToken(g); }), 10000);   // salva login (cookies + token) a cada 10s
  // heartbeat: se uma conta estava recebendo frames e ficou 60s calada → provavelmente desconectou
  setInterval(() => {
    const now = Date.now();
    games.forEach((g) => {
      if (!g._lastFrameTs) return;   // ainda não logou/coletou → não é desconexão
      g._al = g._al || {};
      if (now - g._lastFrameTs > 60000 && !g._al.disc) { g._al.disc = true; fireAlert(g, 'disconnected', { reason: 'silêncio' }); pushState(g); }
    });
  }, 15000);

  if (SERVER_MODE) {
    const healthFile = path.join(app.getPath('userData'), 'server-health.json');
    const writeHealth = () => {
      const body = {
        ok: true, pid: process.pid, timestamp: new Date().toISOString(), platform: process.platform,
        arch: process.arch, display: process.env.DISPLAY || null, tokenVault: tokenVault.describe(),
        accounts: games.map((g) => ({ slot: g.slot, online: !!g._lastFrameTs, lastFrameAt: g._lastFrameTs || null })),
      };
      try { fs.writeFileSync(healthFile, JSON.stringify(body, null, 2), { mode: 0o600 }); } catch {}
    };
    writeHealth();
    setInterval(writeHealth, 30000);
  }

});
app.on('window-all-closed', () => app.quit());
