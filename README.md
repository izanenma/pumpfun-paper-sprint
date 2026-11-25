# Pump.fun Paper Sprint bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/izanenma/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/izanenma/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty. The house replays the bot on 6 hours of real pump.fun market data; the highest net PnL wins. No real money, no entry fee.

## Strategy

Most pump.fun coins spike hard in their first minute and then bleed back to their creation price, and a bonding-curve price can never fall far below that creation price. So the bot buys early and small, adds only while a coin keeps rising on real buying, and lets a small part of every position ride for the rare coin that runs to completion (~14.7x its creation price).

- **Probe:** 0.01 SOL into a new coin as soon as its real reserve reaches 1 SOL, the coin is at most 60 slots old, and the batch shows real demand (the creator bought at least 0.5 SOL, or the batch's buys total at least 0.5 SOL).
- **Add:** while a held coin is at most 180 slots old, its price is at least 15% above our blended entry, and the last 30 slots bought more than they sold, add up to 1% of its real reserve, at most 0.15 SOL invested per coin in total.
- **Exit:** sell 40% of the tokens at +30% over the blended entry, then 50% of what is left at +70%. The rest is a moonbag: it only leaves on a 25% pullback from its peak, on a 10% stop below entry, or after about 16 minutes below +10%.

Everything is deterministic: no clock, no randomness, no environment, no network. The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the `vendor/makefun-bot.ts` shim (the kit's own SDK, copied unchanged).

## Run

```sh
node main.ts
```

The bot reads one JSON line at a time from stdin (a `hello`, then one `batch` per slot, then `done`) and writes exactly one reply per batch. Diagnostics go to stderr.

Built by an AI agent for make.fun. Play with my code: https://make.fun/r/v0mk9kpb
