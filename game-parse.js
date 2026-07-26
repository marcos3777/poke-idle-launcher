'use strict';

// Parser da REDE do Poke Idle World. O jogo manda tudo por WebSocket como JSON
// com `type`. NÃO se lê DOM — só dado estruturado. A tela (capturePage) só serve
// pra print de shiny MEU. Schema provado contra dump real (419k frames) — ver docs/WS_SCHEMA.md.

// Raridade pela TABELA OFICIAL do jogo (pokepedia /systems/quality). A captura
// selvagem capa em 1.8; Mythic+ só vem de shiny/bred.
function rarityFromQuality(q) {
  if (q == null) return null;
  if (q < 1.0) return 'Fraca';
  if (q < 1.1) return 'Comum';
  if (q < 1.3) return 'Incomum';
  if (q < 1.5) return 'Rara';
  if (q < 1.7) return 'Épica';
  if (q < 2.0) return 'Lendária';
  if (q < 3.0) return 'Mythic';
  if (q < 4.0) return 'Ancient';
  return 'Divine';
}
const RARITY_ORDER = ['Fraca', 'Comum', 'Incomum', 'Rara', 'Épica', 'Lendária', 'Mythic', 'Ancient', 'Divine'];

// "Melhor catch": a QUALITY manda (um Lendário, quality >= 1.7, vale mais que IV alto),
// mas um IV quase perfeito dá um bônus que deixa um Épico (quality < 1.7) com IV ~180+
// competir de igual pra igual com um Lendário. Shiny sempre no topo. Usado no painel
// geral, na melhor captura da sessão e no agregado do dia — fonte única do critério.
const NEAR_PERFECT_IV = 180;   // limiar do "IV beirando perfeito" (de 192)
function catchScore(x) {
  if (!x) return -Infinity;
  const q = +x.quality || 0;
  const iv = +(x.iv != null ? x.iv : x.ivTotal) || 0;
  return (x.shiny ? 100 : 0) + q + Math.max(0, iv - 150) / 42 * 0.20;
}
// Merece card no hover: Lendária+ (quality >= 1.7), Épica com IV quase perfeito, ou shiny.
function isNotableCatch(x) {
  if (!x) return false;
  const q = +x.quality || 0;
  const iv = +(x.iv != null ? x.iv : x.ivTotal) || 0;
  return !!x.shiny || q >= 1.7 || (q >= 1.5 && iv >= NEAR_PERFECT_IV);
}

function parseFrame(payload) { try { return JSON.parse(payload); } catch { return null; } }

function emptyLive() {
  return {
    attempts: 0, captures: 0, shinyCaptures: 0, kills: 0, xp: 0, levelUps: 0, byRarity: {},
    xpParts: { base: 0, boost: 0, vip: 0, streak: 0, event: 0 },  // decomposição do XP do treinador
    loot: {},                    // itemId -> {itemId, name, qty} (loot acumulado — base pra calcular ouro)
    ballsUsed: {},               // ballId -> qtd de balls gastas (base pra custo)
    captureGold: 0,              // soma do sellValue das capturas (ouro estimado das vendas)
    shinyCaught: 0, shinyLost: 0, ballsOnShiny: 0,   // caça ao shiny (correlação com o field)
  };
}

function newState() {
  return {
    team: [], hunt: null, analyzer: null, balls: null, ballCatalog: null, inventory: null, boosts: [], mail: null, _lastBall: null,
    pokeIds: new Set(),         // ids que já são seus — evita contar update como captura
    caughtSpecies: new Set(),   // dex dos que ele tem/capturou (pokédex)
    killsBySpecies: {},         // nome da espécie -> kills (base de Shiny Card 15k e bônus Pokédex 100)
    profession: { photos: 0 },  // Treinador de Prestígio: fotos de shiny tiradas (Rare Pokémon Picture)
    shinyOnField: false,        // há um shiny selvagem na tela agora? (pra contar bolas gastas nele)
    bestCatch: null,            // melhor captura da sessão por Quality (desempate IV) — capturas são low-level, Power não serve
    live: emptyLive(),
  };
}

function applyMessage(state, m) {
  const events = [];
  if (!m || !m.type) return events;
  switch (m.type) {
    case 'field-init': {
      const changed = state.hunt && state.hunt.huntKey && state.hunt.huntKey !== m.huntKey;
      state.hunt = { slug: m.slug, huntKey: m.huntKey };
      if (changed) {   // trocou/saiu da hunt → zera a SESSÃO inteira (killsBySpecies é longo prazo, não zera)
        state.live = emptyLive();
        state.bestPower = null; state.shinyOnField = false;
        state.bestCatch = null;   // melhor captura é DA SESSÃO → some na troca de hunt
        state.analyzer = null;    // analyzer OFICIAL do jogo é da hunt anterior → limpa (o painel usa o NOSSO cálculo, sempre fresco)
        events.push({ type: 'hunt-reset' });
      }
      break;
    }
    case 'field':   // ruído de movimento; só olhamos se há shiny selvagem na tela
      if (Array.isArray(m.mobs)) {
        const shinyMob = m.mobs.find((x) => x && x.shiny && !x.dead);
        const was = state.shinyOnField;
        state.shinyOnField = !!shinyMob;
        if (shinyMob && !was) {   // BORDA (false→true): shiny apareceu na tela AGORA — não repete a cada frame
          events.push({ type: 'shiny_field', cap: { name: shinyMob.speciesName || shinyMob.name || null, speciesId: shinyMob.speciesId || shinyMob.dex || shinyMob.pokeId || null } });
        }
      }
      break;
    case 'pokes': {
      state.team = m.list || [];
      for (const p of state.team) { state.pokeIds.add(p.id); if (p.speciesId) state.caughtSpecies.add(p.speciesId); }
      // MORTE: o líder do time desmaiou (hp 0). Debounce por estado pra não repetir a cada update.
      const lead = state.team.find((p) => p.leader) || state.team.find((p) => p.team) || null;
      const fainted = !!(lead && lead.maxHp > 0 && (lead.hp || 0) <= 0);
      if (fainted && !state._leadFainted) { state._leadFainted = true; events.push({ type: 'died', name: lead.name || null }); }
      else if (!fainted) state._leadFainted = false;
      break;
    }
    case 'poke-xp': {
      const p = state.team.find((x) => x.id === m.id);
      if (p) { p.xp = m.xp; p.level = m.level; }
      break;
    }
    case 'catch-result':
      state.live.attempts++;
      if (m.ballId != null) state.live.ballsUsed[m.ballId] = (state.live.ballsUsed[m.ballId] || 0) + 1;   // bolas gastas por tipo (custo)
      if (state.shinyOnField) state.live.ballsOnShiny++;   // bola jogada com shiny na tela
      if (m.success === true) state._lastBall = m.ballName || null;
      break;
    case 'poke-delta': {
      const p = m.poke;
      if (!p) break;
      // Se o poke já é seu (time/líder ou id conhecido), é só ATUALIZAÇÃO (ex.: líder subiu de nível) — NÃO é captura.
      const known = state.pokeIds.has(p.id) || p.team === true || p.leader === true;
      if (known) {
        const t = state.team.find((x) => x.id === p.id);
        if (t) Object.assign(t, p);
        state.pokeIds.add(p.id);
        break;
      }
      state.pokeIds.add(p.id);
      if (p.speciesId) state.caughtSpecies.add(p.speciesId);
      const cap = {
        id: p.id, name: p.name, speciesId: p.speciesId, level: p.level, iv: p.ivTotal, ivMax: 192,
        quality: p.quality, power: p.power, shiny: !!p.shiny, rarity: rarityFromQuality(p.quality),
        ball: state._lastBall || null, sellValue: p.sellValue,
        type1: p.type1 || null, type2: p.type2 || null,
        evolvesTo: p.evolvesToName || null, evolveNeedLevel: p.evolveNeedLevel || null,
        hasEvolution: !!p.hasEvolution, stats: p.stats || null,
      };
      events.push({ type: p.shiny ? 'shiny_capture' : 'capture', cap });
      state.live.captures++;
      state.live.captureGold += (p.sellValue || 0);   // ouro estimado se vender a captura
      if (p.shiny) { state.live.shinyCaptures++; state.live.shinyCaught++; }
      if (cap.rarity) state.live.byRarity[cap.rarity] = (state.live.byRarity[cap.rarity] || 0) + 1;
      if (p.quality != null && (!state.bestCatch || catchScore(cap) > catchScore(state.bestCatch))) state.bestCatch = cap;
      break;
    }
    case 'field-kill': {
      state.live.kills++;
      state.live.xp += (m.xpGained || m.totalXp || 0);
      const parts = m.xpParts || {};
      for (const k of ['base', 'boost', 'vip', 'streak', 'event']) state.live.xpParts[k] += (parts[k] || 0);
      if (m.leveledUp) state.live.levelUps++;
      if (m.speciesName) state.killsBySpecies[m.speciesName] = (state.killsBySpecies[m.speciesName] || 0) + 1;
      for (const l of (m.loot || [])) if (l && l.itemId != null) { const e = state.live.loot[l.itemId] || (state.live.loot[l.itemId] = { itemId: l.itemId, name: l.name, qty: 0 }); e.qty += (l.qty || 1); }
      if (m.shiny) { state.live.shinyLost++; events.push({ type: 'shiny_wild', cap: { name: m.speciesName, shiny: true } }); }
      break;
    }
    case 'analyzer':
      state.analyzer = {
        kills: m.kills, seconds: m.seconds, xpGained: m.xpGained, lootItems: m.lootItems,
        lootGold: m.lootGold, ballsUsed: m.ballsUsed, potionsUsed: m.potionsUsed, captures: m.captures,
        shinyCaptures: m.shinyCaptures, capturesGold: m.capturesGold, supplyGold: m.supplyGold,
        balance: m.balance, goldPerHour: m.goldPerHour, xpPerHour: m.xpPerHour, killsPerHour: m.killsPerHour,
        drops: m.drops || [],
      };
      break;
    case 'balls':
      if (m.counts) state.balls = m.counts;         // FIX: o jogo manda `counts` (não `count`)
      if (m.catalog) state.ballCatalog = m.catalog; // id -> {name, catchRate, priceGold, iconUrl}
      break;
    case 'inventory':
      state.inventory = m.items || null;
      break;
    case 'events':
      if (Array.isArray(m.events) && m.events.length) state.boosts = m.events;   // legado (vazio no protocolo atual); só usa se vier populado
      break;
    case 'profession-photo':   // fotografa shiny na hunt. `pictures`=total acumulado (autoridade); `ok`=se a foto prestou
      if (m.pictures != null) state.profession.photos = m.pictures;
      else if (m.ok) state.profession.photos = (state.profession.photos || 0) + 1;
      if (m.ok) events.push({ type: 'profession_photo', name: m.itemName || null, speciesId: m.speciesId || null });
      break;
    case 'shiny-global':
      events.push({ type: 'shiny_global', global: { player: m.playerName, name: m.pokemonName, dexId: m.dexId, tier: m.tier } });
      break;
    case 'boosts':
      if (Array.isArray(m.boosts)) state.boosts = m.boosts;   // fonte oficial de boosts ativos (VIP/XP/etc.)
      break;
    case 'announce':
      if (m.text) events.push({ type: 'announce', text: m.text, until: m.until || null });
      break;
    case 'mail-badge':
      state.mail = { count: m.count || 0, unread: m.unread || 0, gifts: m.gifts || 0 };
      break;
    case 'session-replaced':   // logou em outro lugar → a sessão daqui caiu
      events.push({ type: 'disconnected', reason: 'session-replaced' });
      break;
    default:
      break;
  }
  return events;
}

// dex nacional -> sprites do PokeAPI
function spriteUrl(dexId) { return dexId ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${dexId}.png` : null; }
function animatedSpriteUrl(dexId) { return dexId ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${dexId}.gif` : null; }

module.exports = {
  rarityFromQuality, RARITY_ORDER, catchScore, isNotableCatch, NEAR_PERFECT_IV,
  parseFrame, applyMessage, newState, emptyLive,
  spriteUrl, animatedSpriteUrl,
};
