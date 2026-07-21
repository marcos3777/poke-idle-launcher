'use strict';

// Camada SERVIDOR do Poke Idle Launcher. O jogo tem uma API REST autenticada (Bearer) que
// devolve o estado AUTORITATIVO — pokédex, coleção inteira, bolas+preços, nível do
// treinador, profissões, ganhos offline — a QUALQUER momento, sem depender de o
// jogador abrir o painel dentro do jogo. Isso mata a "dependência da tela": em vez de
// esperar o WebSocket empurrar um `pokes`/`balls` só quando o painel abre, a gente
// PUXA do servidor num timer.
//
// SEGURANÇA: tudo é GET (leitura pura, os mesmos endpoints que os botões de "atualizar"
// do jogo chamam) — nenhuma ação de jogo, nada de DOM, nada escrito no jogo. As chamadas
// rodam DENTRO da página do jogo (executeJavaScript) usando o token que já está lá, então
// herdam a sessão/origin do browser (sem risco de WAF) e o token nunca sai da página.

const ORIGIN = 'https://poke.idleworld.online';

// GETs de leitura pura que compõem o snapshot autoritativo. Chave => caminho.
// (nunca inclui POST / nada que mude estado do jogo)
const ENDPOINTS = {
  pokedex: '/api/game/pokedex',       // { unlockKills, species:[...] } — pokédex autoritativa
  allPokes: '/api/game/all-pokes',    // { entries:[...] } — coleção inteira (IV/quality)
  balls: '/api/game/balls',           // { catalog:[{id,name,priceGold,catchRate,iconUrl}], counts:{id:qtd} }
  usedBalls: '/api/game/used-balls',  // bolas gastas (autoritativo -> custo real)
  profile: '/api/game/profile',       // { level, ... } — nível do treinador
  professions: '/api/game/professions',
  offline: '/api/game/offline',       // { report } — ganhos enquanto esteve fora
  streak: '/api/game/streak',
  character: '/api/characters/me',    // { character:{...} }
};

// Snippet que roda DENTRO da página do jogo: lê o token, dispara todos os GETs em
// paralelo (com refresh 1x em 401) e devolve { key: json|null }. Puramente assíncrono.
function buildPullScript(endpoints) {
  const map = JSON.stringify(endpoints);
  return `(async () => {
    try {
      const EP = ${map};
      const readTok = () => { try {
        const s = sessionStorage.getItem('pokeweb:tokens') || localStorage.getItem('pokeweb:tokens');
        return s ? JSON.parse(s) : null;
      } catch { return null; } };
      let tok = readTok();
      if (!tok || !tok.accessToken) return { __noauth: true };
      const refresh = async () => {
        try {
          if (!tok || !tok.refreshToken) return false;
          const r = await fetch('/api/auth/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ refreshToken: tok.refreshToken }) });
          if (!r.ok) return false;
          const j = await r.json();
          if (!j || !j.accessToken) return false;
          tok = j; try { sessionStorage.setItem('pokeweb:tokens', JSON.stringify(j)); } catch {}
          return true;
        } catch { return false; }
      };
      const get = async (path) => {
        const call = () => fetch(path, { headers: { Authorization: 'Bearer ' + tok.accessToken } });
        let res = await call();
        if (res.status === 401 && await refresh()) res = await call();
        if (!res.ok) return null;
        try { return await res.json(); } catch { return null; }
      };
      const keys = Object.keys(EP);
      const settled = await Promise.allSettled(keys.map(k => get(EP[k])));
      const out = {};
      keys.forEach((k, i) => { out[k] = settled[i].status === 'fulfilled' ? settled[i].value : null; });
      return out;
    } catch (e) { return { __error: String(e && e.message || e) }; }
  })()`;
}

// Puxa o snapshot autoritativo do servidor rodando na página do jogo `wc`.
// Retorna { pokedex, allPokes, balls, ... } ou { __noauth:true } se ainda não logou.
async function pullSnapshot(wc, only) {
  if (!wc || wc.isDestroyed()) return null;
  const eps = {};
  for (const k of Object.keys(ENDPOINTS)) if (!only || only.includes(k)) eps[k] = ENDPOINTS[k];
  try {
    const res = await wc.executeJavaScript(buildPullScript(eps), true);
    return res || null;
  } catch (e) {
    return { __error: e && e.message };
  }
}

// ---- normalização: extrai só o que a gente usa, tolerante a variações de campo ----

// pokédex autoritativa. `species` é a grade inteira do dex; cada item pode marcar se foi
// obtida com um boolean (caught/have/unlocked/owned/captured/discovered). Devolve ids
// capturados + kills por espécie (pro objetivo Shiny Card / bônus pokédex).
function normPokedex(pk) {
  if (!pk || !Array.isArray(pk.species)) return null;
  const caughtIds = [], killsById = {};
  const CAUGHT_FLAGS = ['caught', 'have', 'owned', 'captured', 'unlocked', 'discovered', 'obtained'];
  let sawFlag = false;
  for (const s of pk.species) {
    if (!s || s.id == null) continue;
    let isCaught = null;
    for (const f of CAUGHT_FLAGS) if (typeof s[f] === 'boolean') { isCaught = s[f]; sawFlag = true; break; }
    if (isCaught === true) caughtIds.push(s.id);
    const kills = s.kills != null ? s.kills : (s.killCount != null ? s.killCount : null);
    if (kills != null) killsById[s.id] = kills;
  }
  return {
    unlockKills: pk.unlockKills != null ? pk.unlockKills : null,
    total: pk.species.length,
    // se NÃO houver flag de "capturado" no item, não dá pra contar por aqui -> null (o app cai no fallback do WS)
    caughtIds: sawFlag ? caughtIds : null,
    caught: sawFlag ? caughtIds.length : null,
    killsById,
    raw: undefined,
  };
}

// bolas autoritativas (mesmo shape do WS: catalog + counts). Preço vem certo daqui.
function normBalls(b) {
  if (!b) return null;
  const catalog = Array.isArray(b.catalog) ? b.catalog : null;
  const counts = b.counts && typeof b.counts === 'object' ? b.counts : null;
  if (!catalog && !counts) return null;
  return { catalog, counts };
}

// profile = jackpot: nick, nível+XP do treinador, contagem AUTORITATIVA da pokédex, saldo, rank global
function normProfile(p) {
  if (!p) return null;
  return {
    name: p.name || null,
    level: p.level != null ? p.level : (p.trainerLevel != null ? p.trainerLevel : null),
    xpInLevel: p.xpInLevel != null ? p.xpInLevel : null,
    xpForNext: p.xpForNext != null ? p.xpForNext : null,
    gold: p.gold != null ? p.gold : null,
    diamonds: p.diamonds != null ? p.diamonds : null,
    pokedexCount: p.pokedexCount != null ? p.pokedexCount : null,   // capturados (autoritativo)
    totalCatches: p.totalCatches != null ? p.totalCatches : null,
    rank: p.rank != null ? p.rank : null,
    totalPlayers: p.totalPlayers != null ? p.totalPlayers : null,
  };
}

// profissão (Treinador de Prestígio): rank + progresso pro próximo — o WS não manda, só a REST
function normProfessions(pr) {
  if (!pr) return null;
  return {
    profession: pr.profession || null, rank: pr.rank, rankKey: pr.rankKey || null, rankName: pr.rankName || null,
    maxRank: pr.maxRank != null ? pr.maxRank : null, speciesCount: pr.speciesCount != null ? pr.speciesCount : null,
    pictures: pr.pictures != null ? pr.pictures : null, catchBonusPct: pr.catchBonusPct != null ? pr.catchBonusPct : null,
    nextStep: pr.nextStep || null,
  };
}

// streak: pontos + kills por espécie AUTORITATIVOS (pro Shiny Card 15k e bônus pokédex)
function normStreak(s) {
  if (!s) return null;
  const killsByName = {};
  if (Array.isArray(s.kills)) for (const k of s.kills) if (k && k.name) killsByName[String(k.name).toLowerCase()] = k.kills || 0;
  return {
    totalKills: s.totalKills != null ? s.totalKills : null, killsPerPoint: s.killsPerPoint || 1000,
    earned: s.earned != null ? s.earned : null, spent: s.spent != null ? s.spent : null,
    available: s.available != null ? s.available : null, toNext: s.toNext != null ? s.toNext : null,
    bonusPct: s.bonusPct || null, killsByName,
  };
}

module.exports = { ORIGIN, ENDPOINTS, pullSnapshot, normPokedex, normBalls, normProfile, normProfessions, normStreak };
