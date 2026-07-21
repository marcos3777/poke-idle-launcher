# Poke Idle World — schema do WebSocket

Fonte de verdade da coleta. O jogo abre `wss://poke.idleworld.online/ws12?token=<JWT>`
(⚠️ o token identifica a conta — nunca gravar/compartilhar) e manda JSON com `type`.
Confirmado num dump real de 3729 frames (18/07/2026).

## Mensagens (por frequência numa hunt)

| type | o que é | campos-chave |
|---|---|---|
| `field` | posição/tiles (movimento) — **ruído, ignorar** | — |
| `chat` | chat do mundo | `msg{fromName,level,body,channel,at}` |
| `analyzer` | **stats da sessão** (a cada ~90s) | `kills, seconds, xpGained, lootItems, lootGold, ballsUsed, captures, shinyCaptures, capturesGold, balance, goldPerHour, xpPerHour, killsPerHour, drops[{itemId,name,qty,gold}]` |
| `balls` | estoque + catálogo de bolas | `count{ballId:qty}`, `catalog[{id,name,catchRate,priceGold,iconUrl}]` (nem toda msg tem `count`) |
| `field-kill` | pokémon selvagem derrotado | `xpGained, level, speciesName, shiny, loot[], xpParts` |
| `poke-xp` | ganho de XP de um poke do time | `id, speciesId, xpGained, xp, level, leveledUp` |
| `catch-result` | tentativa de captura | `success(bool), speciesName, ballName, ballId, auto` |
| `inventory` | inventário | `items[{itemId,quantity}]` |
| `events` | boosts ativos | `events[{key,name,desc,pct,emoji,until}]` (ex: `lucky-shine` +50% shiny) |
| `pokes` | **time/coleção** | `list[{id,speciesId,name,level,shiny,team,leader,ivTotal,quality,power,hp,maxHp,type1,type2,stats,sellValue}]` |
| `poke-delta` | **poke novo na coleção = 1 captura** | `poke{speciesId,name,level,shiny,ivTotal,quality,power,sellValue,evolvesToName}` |
| `field-init` | início da hunt | `slug` (o que está caçando), `huntKey`, `grid` (ignorar) |
| `shiny-global` | **shiny capturado por QUALQUER player (broadcast)** | `playerName, pokemonName, dexId, spriteId, tier` |
| `session-replaced` | login em outro lugar derrubou a sessão | — |

## Regras de derivação

- **`speciesId` / `dexId` = número da Pokédex nacional** → PokeAPI direto
  (`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/{dex}.png`;
  animado gen-5 em `.../versions/generation-v/black-white/animated/{dex}.gif`).
- **Captura** = `poke-delta` (tem IV/quality/shiny). A bola vem do `catch-result{success:true}`
  imediatamente anterior.
- **IV** = `ivTotal` (0–192). **Raridade tem só o `quality`** na rede; o **nome do tier
  (Fraca/Comum/…/Épica) o jogo calcula no cliente** → derivamos por faixas de `quality`
  (aproximado, calibrar). `shiny-global.tier` usa letras (A/S/…), sistema à parte.
- **Shiny meu** = `poke-delta.shiny===true`. **Shiny selvagem** = `field-kill.shiny===true`.
  **Shiny de outros** = `shiny-global`.
- **Print (única coisa que usa a tela):** `capturePage()` no momento de `poke-delta.shiny`
  (meu) e de `shiny-global` (o banner que aparece pra todos).

## Prova

`node scratchpad/test-parse.js` reconstruiu do dump real: hunt=dratini, líder Vileplume(45),
analyzer (58 capturas, 685k XP/h, drops), 4 capturas em tempo real com IV/quality, o
`shiny-global` de outro treinador, 1 shiny selvagem e os boosts. Ver `game-parse.js`.
