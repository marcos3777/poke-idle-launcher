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

module.exports = {
  goldNet, xpBreakdown, shinyStats, goals, catchCost,
  SHINY_CARD_KILLS, POKEDEX_BONUS_KILLS, STREAK_KILLS,
};
