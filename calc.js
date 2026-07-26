'use strict';

// Derivações e projeções em cima do estado do game-parse. Funções puras (o "cérebro").

const SHINY_CARD_KILLS = 15000;   // kills da MESMA espécie (Kanto) = 1 Shiny Card
const POKEDEX_BONUS_KILLS = 100;  // kills/espécie = +25% XP permanente naquela espécie
const STREAK_KILLS = 1000;        // kills totais = 1 Streak Point

// gold LÍQUIDO a partir do analyzer (ganho − gasto em suprimentos)
function goldNet(a) {
  if (!a) return null;
  const gain = (a.lootGold || 0) + (a.capturesGold || 0);
  const spent = (a.supplyGold || 0);
  const net = gain - spent;
  const hrs = a.seconds ? a.seconds / 3600 : null;
  return {
    gain, spent, net,
    gainPerHour: hrs ? Math.round(gain / hrs) : null,
    spentPerHour: hrs ? Math.round(spent / hrs) : null,
    // o próprio jogo já entrega o líquido/h certo (goldPerHour = balance/tempo); nosso cálculo é fallback
    netPerHour: (a.goldPerHour != null) ? a.goldPerHour : (hrs ? Math.round(net / hrs) : null),
  };
}

// decomposição do XP do treinador em % por fonte (base/boost/vip/streak/event)
function xpBreakdown(live) {
  const p = (live && live.xpParts) || {};
  const keys = ['base', 'boost', 'vip', 'streak', 'event'];
  const total = keys.reduce((s, k) => s + (p[k] || 0), 0) || 1;
  const pct = {};
  for (const k of keys) pct[k] = Math.round((p[k] || 0) / total * 100);
  return { parts: p, total, pct };
}

// caça ao shiny: apareceram/capturados/perdidos + por hora + bolas por shiny
function shinyStats(live, hrs) {
  const caught = live.shinyCaught || 0, lost = live.shinyLost || 0, found = caught + lost;
  return {
    found, caught, lost, ballsOnShiny: live.ballsOnShiny || 0,
    foundPerHour: hrs ? +(found / hrs).toFixed(2) : null,
    ballsPerShiny: caught ? Math.round((live.ballsOnShiny || 0) / caught) : null,
  };
}

// metas de longo prazo. Prefere os kills/streak AUTORITATIVOS do servidor (state.serverKillsByName /
// state.serverStreak); só cai no acumulado parcial do WS (killsBySpecies) se o servidor ainda não veio.
function goals(state, huntSpeciesName) {
  const serverKills = state.serverKillsByName || null;
  const kills = state.killsBySpecies || {};
  const nameKey = (huntSpeciesName || '').toLowerCase();
  const sp = serverKills ? (serverKills[nameKey] || 0) : ((huntSpeciesName && kills[huntSpeciesName]) || 0);
  const ss = state.serverStreak || null;
  let streak;
  if (ss) {
    const per = ss.killsPerPoint || STREAK_KILLS;
    const into = ss.toNext != null ? Math.max(per - ss.toNext, 0) : ((ss.totalKills || 0) % per);
    streak = { kills: into, target: per, points: ss.earned || 0, available: ss.available, pct: per ? into / per * 100 : 0 };
  } else {
    const totalKills = Object.values(kills).reduce((a, b) => a + b, 0);
    streak = { kills: totalKills % STREAK_KILLS, target: STREAK_KILLS, points: Math.floor(totalKills / STREAK_KILLS), pct: (totalKills % STREAK_KILLS) / STREAK_KILLS * 100 };
  }
  return {
    shinyCard: { species: huntSpeciesName, kills: sp, target: SHINY_CARD_KILLS, pct: Math.min(sp / SHINY_CARD_KILLS * 100, 100) },
    pokedexBonus: { species: huntSpeciesName, kills: Math.min(sp, POKEDEX_BONUS_KILLS), target: POKEDEX_BONUS_KILLS, done: sp >= POKEDEX_BONUS_KILLS, pct: Math.min(sp / POKEDEX_BONUS_KILLS * 100, 100) },
    streak,
  };
}

// custo médio por captura: bolas por captura e, com o catálogo, o gold gasto
function catchCost(live, ballCatalog, lastBallName) {
  const caps = live.captures || 0;
  const ballsPerCap = caps ? +((live.attempts || 0) / caps).toFixed(1) : null;
  let goldPerCap = null;
  if (ballsPerCap && Array.isArray(ballCatalog) && lastBallName) {
    const b = ballCatalog.find((x) => x.name === lastBallName);
    if (b && b.priceGold) goldPerCap = Math.round(ballsPerCap * b.priceGold);
  }
  return { ballsPerCap, goldPerCap };
}

// ---------------------------------------------------------------------------
// FASE 1 — efetividade de tipos (fonte ÚNICA da tabela; o script do Mapa em main.js
// serializa este mesmo TYPE_CHART). ATAQUE = quanto um tipo bate; DEFESA = a que um
// poke é fraco/resiste/imune (matriz que o justpokedex expõe e que ainda faltava aqui).
// ---------------------------------------------------------------------------

// tabela oficial de efetividade (18 tipos, PokeAPI); ausente = 1×. Chaves em MAIÚSCULO
// porque é como o jogo (WS) e o creatures.json entregam type1/type2.
const TYPE_CHART = {
  NORMAL: { ROCK: .5, STEEL: .5, GHOST: 0 },
  FIRE: { BUG: 2, STEEL: 2, GRASS: 2, ICE: 2, ROCK: .5, FIRE: .5, WATER: .5, DRAGON: .5 },
  WATER: { GROUND: 2, ROCK: 2, FIRE: 2, WATER: .5, GRASS: .5, DRAGON: .5 },
  GRASS: { GROUND: 2, ROCK: 2, WATER: 2, FLYING: .5, POISON: .5, BUG: .5, STEEL: .5, FIRE: .5, GRASS: .5, DRAGON: .5 },
  ELECTRIC: { FLYING: 2, WATER: 2, GRASS: .5, ELECTRIC: .5, DRAGON: .5, GROUND: 0 },
  ICE: { FLYING: 2, GROUND: 2, GRASS: 2, DRAGON: 2, STEEL: .5, FIRE: .5, WATER: .5, ICE: .5 },
  FIGHTING: { NORMAL: 2, ROCK: 2, STEEL: 2, ICE: 2, DARK: 2, FLYING: .5, POISON: .5, BUG: .5, PSYCHIC: .5, FAIRY: .5, GHOST: 0 },
  POISON: { GRASS: 2, FAIRY: 2, POISON: .5, GROUND: .5, ROCK: .5, GHOST: .5, STEEL: 0 },
  GROUND: { POISON: 2, ROCK: 2, STEEL: 2, FIRE: 2, ELECTRIC: 2, BUG: .5, GRASS: .5, FLYING: 0 },
  FLYING: { FIGHTING: 2, BUG: 2, GRASS: 2, ROCK: .5, STEEL: .5, ELECTRIC: .5 },
  PSYCHIC: { FIGHTING: 2, POISON: 2, STEEL: .5, PSYCHIC: .5, DARK: 0 },
  BUG: { GRASS: 2, PSYCHIC: 2, DARK: 2, FIGHTING: .5, FLYING: .5, POISON: .5, GHOST: .5, STEEL: .5, FIRE: .5, FAIRY: .5 },
  ROCK: { FLYING: 2, BUG: 2, FIRE: 2, ICE: 2, FIGHTING: .5, GROUND: .5, STEEL: .5 },
  GHOST: { GHOST: 2, PSYCHIC: 2, DARK: .5, NORMAL: 0 },
  DRAGON: { DRAGON: 2, STEEL: .5, FAIRY: 0 },
  DARK: { GHOST: 2, PSYCHIC: 2, FIGHTING: .5, DARK: .5, FAIRY: .5 },
  STEEL: { ROCK: 2, ICE: 2, FAIRY: 2, STEEL: .5, FIRE: .5, WATER: .5, ELECTRIC: .5 },
  FAIRY: { FIGHTING: 2, DRAGON: 2, DARK: 2, POISON: .5, STEEL: .5, FIRE: .5 },
};
const TYPE_LIST = Object.keys(TYPE_CHART);
const _up = (t) => (t == null ? null : String(t).toUpperCase());

// multiplicador de UM tipo atacante contra UM tipo defensor (1× se não listado)
function attackMult(atk, def) {
  const row = TYPE_CHART[_up(atk)];
  if (!row) return 1;
  const v = row[_up(def)];
  return v == null ? 1 : v;
}
// atacante contra um defensor de dupla tipagem (multiplica as duas — ex.: Pedra em Fogo/Voador = ×4)
function dualAttackMult(atk, d1, d2) {
  return attackMult(atk, d1) * (d2 ? attackMult(atk, d2) : 1);
}
// PERFIL DEFENSIVO de um poke: a que ele é fraco / resiste / é imune (agregando as 18 tipagens
// atacantes contra as SUAS type1/type2). É a matriz nova estilo justpokedex.
function defenseProfile(t1, t2) {
  if (!t1 && !t2) return null;
  const weakTo = [], resists = [], immuneTo = [];
  for (const atk of TYPE_LIST) {
    const m = dualAttackMult(atk, t1, t2);
    if (m === 0) immuneTo.push({ type: atk, mult: 0 });
    else if (m > 1) weakTo.push({ type: atk, mult: m });
    else if (m < 1) resists.push({ type: atk, mult: m });
  }
  weakTo.sort((a, b) => b.mult - a.mult);      // ×4 antes de ×2
  resists.sort((a, b) => a.mult - b.mult);     // ×0.25 antes de ×0.5
  return { weakTo, resists, immuneTo };
}
// melhor resposta OFENSIVA do time contra um defensor (consolida o best() do script do Mapa):
// varre as tipagens de cada poke e devolve a de maior multiplicador. `team` = [{name,type1,type2}].
function bestTeamMatchup(team, d1, d2) {
  let b = null;
  for (const p of team || []) {
    for (const atk of [p.type1, p.type2]) {
      if (!atk) continue;
      const m = dualAttackMult(atk, d1, d2);
      if (!b || m > b.mult) b = { mult: m, type: _up(atk), name: p.name || null };
    }
  }
  return b;
}

// ---------------------------------------------------------------------------
// FASE 3 — IV estimado a partir dos stats FINAIS (fórmula reversa do jogo).
// O jogo calcula: S = round((B + 2·IV) · (L/100) · Q^e), onde B=base (PokeAPI),
// IV∈[0,32] por stat (0–192 total), L=nível, Q=quality (raridade) e o expoente e
// é 0.95 pra HP/Velocidade e 0.80 pros demais. Invertendo dá o IV. Serve pra pokes
// que NÃO mandam ivTotal na rede (mercado, outros players, selvagem) — quando temos o
// ivTotal autoritativo (poke-delta/REST), use aquele, não isto.
// ---------------------------------------------------------------------------

const IV_MAX_PER_STAT = 32;
const IV_MAX_TOTAL = 192;   // 6 stats × 32
const IV_LOW_LEVEL = 15;    // abaixo disso o arredondamento da fórmula torna a estimativa instável

// nomes canônicos + apelidos comuns → canônico. HP/Velocidade usam expoente 0.95; resto 0.80.
const STAT_EXP = { hp: 0.95, attack: 0.80, defense: 0.80, spAttack: 0.80, spDefense: 0.80, speed: 0.95 };
const STAT_ALIAS = {
  hp: 'hp', health: 'hp',
  attack: 'attack', atk: 'attack', at: 'attack',
  defense: 'defense', def: 'defense', df: 'defense',
  spattack: 'spAttack', spatk: 'spAttack', spa: 'spAttack', specialattack: 'spAttack',
  spdefense: 'spDefense', spdef: 'spDefense', spd: 'spDefense', specialdefense: 'spDefense',
  speed: 'speed', spe: 'speed', spd_: 'speed',
};
function _canonStat(key) {
  const k = String(key).replace(/[\s._-]/g, '').toLowerCase();
  return STAT_ALIAS[k] || (STAT_EXP[k] ? k : null);
}
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// stat final a partir de um IV (fórmula direta do jogo) — usado pra conferir a inversa
function statFromIV(base, iv, level, quality, exp) {
  return Math.round((base + 2 * iv) * (level / 100) * Math.pow(quality, exp));
}
// IV de UM stat a partir do stat final (inversa), preso em [0,32]
function ivFromStat(stat, base, level, quality, exp) {
  const denom = (level / 100) * Math.pow(quality, exp);
  if (!denom) return null;
  const iv = ((stat / denom) - base) / 2;
  return _clamp(Math.round(iv), 0, IV_MAX_PER_STAT);
}
// Estima o IV de um exemplar. `base` e `stat` são objetos com as chaves dos 6 stats
// (aceita apelidos: atk/def/spa/spd/spe…). Devolve IV por stat, total (0–192) e potencial %.
function estimateIV({ base, stat, level, quality }) {
  if (!base || !stat || !level) return null;
  const q = quality || 1;
  const perStat = {};
  let total = 0, counted = 0;
  for (const rawKey of Object.keys(stat)) {
    const key = _canonStat(rawKey);
    if (!key) continue;
    const b = base[rawKey] != null ? base[rawKey] : base[key];
    const s = stat[rawKey];
    if (b == null || s == null) continue;
    const iv = ivFromStat(s, b, level, q, STAT_EXP[key]);
    if (iv == null) continue;
    perStat[key] = iv; total += iv; counted++;
  }
  if (!counted) return null;
  return {
    perStat, ivTotal: total, ivMax: IV_MAX_TOTAL,
    pct: +(total / IV_MAX_TOTAL * 100).toFixed(1),
    stats: counted,                          // quantos stats deram pra estimar (6 = completo)
    lowLevel: level < IV_LOW_LEVEL,          // abaixo do nível 15 a estimativa é pouco confiável
  };
}

module.exports = {
  goldNet, xpBreakdown, shinyStats, goals, catchCost,
  SHINY_CARD_KILLS, POKEDEX_BONUS_KILLS, STREAK_KILLS,
  // Fase 1 — tipos
  TYPE_CHART, TYPE_LIST, attackMult, dualAttackMult, defenseProfile, bestTeamMatchup,
  // Fase 3 — IV reverso
  STAT_EXP, IV_MAX_TOTAL, IV_LOW_LEVEL, statFromIV, ivFromStat, estimateIV,
};
