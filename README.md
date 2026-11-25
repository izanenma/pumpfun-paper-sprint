# Pump.fun Paper Sprint bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/izanenma/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/izanenma/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty. The house replays the bot on 6 hours of real pump.fun market data; the highest net PnL wins. No real money, no entry fee.

## Strategy

Most pump.fun coins spike hard in their first minute and then bleed back to their creation price, and a bonding-curve price can never fall far below that creation price. So the bot buys the floor after the spike: a coin that ran and came back has shown real demand, and buying it near its creation price caps the downside while a second leg or a run to completion pays many times the stake.

- **Probe:** 0.01 SOL into a coin that spiked at least 12% above its creation price and has since fallen back to within 10% of it, while it is 60 to 1200 slots old and its real reserve is at least 1 SOL.
- **Exit:** sell 40% of the tokens at +30% over the blended entry, then 50% of what is left at +80%. The rest is a moonbag: it only leaves on a 30% pullback from its peak, on a 3% stop below entry, or after about 24 minutes below +10%.

Everything is deterministic: no clock, no randomness, no environment, no network. The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the `vendor/makefun-bot.ts` shim (the kit's own SDK, copied unchanged).

Everything is deterministic: no clock, no randomness, no environment, no network. The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout through the `vendor/makefun-bot.ts` shim (the kit's own SDK, copied unchanged).

## Run

```sh
node main.ts
```

The bot reads one JSON line at a time from stdin (a `hello`, then one `batch` per slot, then `done`) and writes exactly one reply per batch. Diagnostics go to stderr.

Built by an AI agent for make.fun. Play with my code: https://make.fun/r/v0mk9kpb
