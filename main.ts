// Pump.fun Paper Sprint bot: probe + pyramid momentum sniper.
//
// The harness sends a hello first, then one batch per slot; every batch
// carries events and fills, and we answer with orders. Most coins spike
// hard in their first minute and then bleed back to their creation price,
// and the price can never fall far below that creation price (a bonding
// curve only gives back what buyers put in), so the edge is to buy the
// floor after the spike: a coin that ran and came back has shown real
// demand, and buying it near its creation price caps the downside while
// a second leg or a run to completion pays many times the stake.
//
// Rules, all deterministic (no clock, no randomness, no environment):
//   - Probe: 0.01 SOL into a coin that spiked at least 15% above its
//     creation price and has since fallen back to within 8% of it, while
//     it is 60 to 900 slots old and its real reserve is at least 1 SOL.
//   - Exit: sell 50% of the tokens at +15% over the blended entry, then
//     50% of what is left at +40%. The rest is a moonbag: it only leaves
//     on a 30% pullback from its peak, on a 3% stop below entry, or after
//     2400 slots (about 16 minutes) below +10%. A coin that completes is
//     closed by the harness itself at roughly 14.7x its creation price.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL: the smallest round trip that counts (v4c's scaled probe made the slightly negative per-coin edge worse in total)
const MAX_PER_MINT_LAMPORTS = 10_000_000n; // probe only, no adds (adds bought the top of spikes and made the bleed worse)
const PROBE_MIN_AGE_SLOTS = 60; // v4e: wait for the spike to dump back first
const PROBE_MAX_AGE_SLOTS = 1200; // v4e: about 8 minutes after creation (middle ground: enough coins for the 20-mint bar, fewer fees than v4b)
const DUMP_MAX_BPS = 1000; // v4e: buy back within 10% of the creation price
const SPIKE_MIN_BPS = 1200; // v4e: the coin must have spiked at least 12% first
const ADD_MAX_AGE_SLOTS = 180;
const ADD_MIN_GAIN_BPS = 1500; // add only 15% above our blended entry
const WINDOW_SLOTS = 30; // momentum window for adds
const TP1_BPS = 3000; // v4d: +30%: sell 40% of the tokens held (hold more for the second leg)
const TP2_BPS = 8000; // v4d: +80%: sell 50% of the tokens still held
const STOP_BPS = 300; // -3% below the blended entry: sell everything
const TRAIL_BPS = 3000; // 30% below the peak: sell the moonbag
const TIMEOUT_SLOTS = 3600; // v4d: about 24 minutes: give the second leg more time
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 5000;
const CREATOR_PROBE_LAMPORTS = 500_000_000n; // 0.5 SOL of creator buying (v5: back to the wide filter, more coins for completions)
const BATCH_PROBE_LAMPORTS = 500_000_000n; // 0.5 SOL of buys in one batch
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // 1 SOL of real reserve

interface SlotFlow {
  slot: number;
  buy: bigint;
  sell: bigint;
}

interface Coin {
  mint: string;
  createdSlot: number;
  creator: string;
  createPrice: number;
  creatorBuyLamports: bigint;
  probed: boolean;
  investedLamports: bigint;
  peakPrice: number;
  tp1Done: boolean;
  tp2Done: boolean;
  lastSellRejectSlot: number;
  flows: SlotFlow[];
}

const coins = new Map<string, Coin>();

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

function coinPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

function entryPrice(state: BotState, mint: string): number {
  const holding = state.positions.get(mint);
  if (holding === undefined || holding.token_amount === 0n) return 0;
  return Number(holding.cost_lamports) / Number(holding.token_amount);
}

function netBuyLastWindow(coin: Coin, nowSlot: number): bigint {
  let net = 0n;
  for (const flow of coin.flows) {
    if (flow.slot > nowSlot - WINDOW_SLOTS) net += flow.buy - flow.sell;
  }
  return net;
}

function pruneFlows(coin: Coin, nowSlot: number): void {
  while (coin.flows.length > 0 && coin.flows[0]!.slot <= nowSlot - WINDOW_SLOTS) {
    coin.flows.shift();
  }
}

function noteEvents(state: BotState, batch: Batch): Map<string, { buy: bigint; sell: bigint }> {
  const batchFlow = new Map<string, { buy: bigint; sell: bigint }>();
  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      if (!coins.has(event.mint)) {
        const createPrice = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        coins.set(event.mint, {
          mint: event.mint,
          createdSlot: event.slot,
          creator: event.creator,
          createPrice,
          creatorBuyLamports: 0n,
          probed: false,
          investedLamports: 0n,
          peakPrice: createPrice,
          tp1Done: false,
          tp2Done: false,
          lastSellRejectSlot: -1000000,
          flows: [],
        });
      }
    } else if (event.event === "TradeEvent") {
      const coin = coins.get(event.mint);
      const flow = batchFlow.get(event.mint) ?? { buy: 0n, sell: 0n };
      const amount = BigInt(event.sol_amount);
      if (event.is_buy) flow.buy += amount;
      else flow.sell += amount;
      batchFlow.set(event.mint, flow);
      if (coin !== undefined) {
        if (event.is_buy && event.user === coin.creator) {
          coin.creatorBuyLamports += amount;
        }
        const tradePrice = priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves));
        if (tradePrice > coin.peakPrice) coin.peakPrice = tradePrice;
        const last = coin.flows[coin.flows.length - 1];
        if (last !== undefined && last.slot === event.slot) {
          if (event.is_buy) last.buy += amount;
          else last.sell += amount;
        } else {
          coin.flows.push({
            slot: event.slot,
            buy: event.is_buy ? amount : 0n,
            sell: event.is_buy ? 0n : amount,
          });
        }
        pruneFlows(coin, event.slot);
      }
    } else {
      const coin = coins.get(event.mint);
      if (coin !== undefined) {
        // The curve completed: the harness closes any position in it.
        coin.probed = true;
      }
    }
  }
  return batchFlow;
}

function noteFills(state: BotState, batch: Batch): void {
  for (const fill of batch.fills) {
    const coin = coins.get(fill.mint);
    if (coin === undefined) continue;
    if (fill.status === "filled" && fill.side === "buy") {
      coin.investedLamports += BigInt(fill.quote_lamports);
    }
    if (fill.status === "rejected" && fill.side === "sell") {
      // A sell the harness refused (dust, slippage, or too many tokens for
      // what we still hold): do not hammer it again next batch.
      coin.lastSellRejectSlot = batch.slot;
    }
  }
}

// A sell whose proceeds would not cover the transaction fee is dust: the
// harness rejects it as zero_amount, so sending it every batch only adds
// rejected orders. Value is tokens times the current price in lamports.
function sellIsDust(state: BotState, mint: string, tokenAmount: bigint, price: number): boolean {
  if (price <= 0) return true;
  const value = Number(tokenAmount) * price;
  const txFee = Number(state.txFeeLamports());
  return value * 0.9875 - txFee <= 0;
}

function decideExits(state: BotState, batch: Batch, orders: OrderInput[]): Set<string> {
  const sellingAll = new Set<string>();
  for (const [mint, holding] of state.positions) {
    const coin = coins.get(mint);
    if (coin === undefined) continue;
    const price = coinPrice(state, mint);
    const entry = entryPrice(state, mint);
    if (price <= 0 || entry <= 0) continue;
    if (coin.peakPrice < price) coin.peakPrice = price;
    const tokens = holding.token_amount;
    if (tokens <= 0n) continue;
    // A sell refused a few slots ago gets a short cooldown instead of a
    // retry every batch; the price will have moved by then or not at all.
    if (batch.slot - coin.lastSellRejectSlot < 10) continue;

    if (!coin.tp1Done && price >= (entry * (10000 + TP1_BPS)) / 10000) {
      const amount = (tokens * 40n) / 100n;
      if (amount > 0n && !sellIsDust(state, mint, amount, price)) {
        orders.push({ side: "sell", mint, token_amount: amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        coin.tp1Done = true;
      }
      continue;
    }
    if (coin.tp1Done && !coin.tp2Done && price >= (entry * (10000 + TP2_BPS)) / 10000) {
      const amount = (tokens * 50n) / 100n;
      if (amount > 0n && !sellIsDust(state, mint, amount, price)) {
        orders.push({ side: "sell", mint, token_amount: amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        coin.tp2Done = true;
      }
      continue;
    }
    const age = batch.slot - coin.createdSlot;
    const stopHit = price <= (entry * (10000 - STOP_BPS)) / 10000;
    const trailHit =
      coin.tp1Done && coin.peakPrice > 0 && price <= (coin.peakPrice * (10000 - TRAIL_BPS)) / 10000;
    const timedOut = age > TIMEOUT_SLOTS && price < (entry * 11000) / 10000;
    if (stopHit || trailHit || timedOut) {
      if (!sellIsDust(state, mint, tokens, price)) {
        orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
        sellingAll.add(mint);
      }
    }
  }
  return sellingAll;
}

function decideAdds(state: BotState, batch: Batch, orders: OrderInput[], sellingAll: Set<string>): void {
  // Adds never open a new position, so the position cap does not apply here.
  for (const [mint, holding] of state.positions) {
    if (sellingAll.has(mint)) continue;
    const coin = coins.get(mint);
    if (coin === undefined) continue;
    const age = batch.slot - coin.createdSlot;
    if (age > ADD_MAX_AGE_SLOTS) continue;
    let pendingBuys = 0n;
    for (const pending of state.pending.values()) {
      if (pending.order.mint === mint && pending.order.side === "buy") {
        pendingBuys += BigInt(pending.order.quote_lamports);
      }
    }
    if (coin.investedLamports + pendingBuys >= MAX_PER_MINT_LAMPORTS) continue;
    const price = coinPrice(state, mint);
    const entry = entryPrice(state, mint);
    if (price <= 0 || entry <= 0) continue;
    if (price < (entry * (10000 + ADD_MIN_GAIN_BPS)) / 10000) continue;
    pruneFlows(coin, batch.slot);
    if (netBuyLastWindow(coin, batch.slot) <= 0n) continue;
    const room = MAX_PER_MINT_LAMPORTS - coin.investedLamports - pendingBuys;
    const cap = state.maxBuyLamports(mint);
    let size = room < cap ? room : cap;
    const free = state.freeCashLamports() - state.txFeeLamports();
    if (size > free) size = free;
    if (size < PROBE_LAMPORTS) continue;
    orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
  }
}

function decideProbes(
  state: BotState,
  batch: Batch,
  batchFlow: Map<string, { buy: bigint; sell: bigint }>,
  orders: OrderInput[],
): void {
  // Never send more probes in one batch than the free position slots: the
  // extras would all be rejected for max_open_positions.
  let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (freeSlots <= 0) return;
  for (const coin of coins.values()) {
    if (freeSlots <= 0) return;
    if (coin.probed) continue;
    if (state.positions.has(coin.mint)) continue;
    const curve = state.curves.get(coin.mint);
    if (curve === undefined || curve.complete) continue;
    const age = batch.slot - coin.createdSlot;
    if (age < PROBE_MIN_AGE_SLOTS || age > PROBE_MAX_AGE_SLOTS) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
    if (coin.createPrice <= 0) continue;
    // Buy the floor after the spike: the coin ran at least 15% above its
    // creation price and has since fallen back to within 8% of it.
    const price = coinPrice(state, coin.mint);
    if (price <= 0) continue;
    if (coin.peakPrice < (coin.createPrice * (10000 + SPIKE_MIN_BPS)) / 10000) continue;
    if (price > (coin.createPrice * (10000 + DUMP_MAX_BPS)) / 10000) continue;
    const cap = state.maxBuyLamports(coin.mint);
    let size = PROBE_LAMPORTS < cap ? PROBE_LAMPORTS : cap;
    const free = state.freeCashLamports() - state.txFeeLamports();
    if (size > free) size = free;
    if (size < PROBE_LAMPORTS) continue;
    orders.push({ side: "buy", mint: coin.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    coin.probed = true;
    freeSlots -= 1;
  }
}

function pruneCoins(state: BotState, batch: Batch): void {
  for (const [mint, coin] of coins) {
    const age = batch.slot - coin.createdSlot;
    if (age <= 6000 || state.positions.has(mint)) continue;
    let pending = false;
    for (const order of state.pending.values()) {
      if (order.order.mint === mint) {
        pending = true;
        break;
      }
    }
    if (!pending) coins.delete(mint);
  }
}

await runBot({
  onHello(state) {
    console.error(
      `hello: capital ${state.cash} lamports, max ${state.hello.caps.max_open_positions} positions, ` +
        `latency ${state.hello.latency_slots} slots`,
    );
  },
  onBatch(state, batch) {
    const batchFlow = noteEvents(state, batch);
    noteFills(state, batch);
    const orders: OrderInput[] = [];
    const sellingAll = decideExits(state, batch, orders);
    decideAdds(state, batch, orders, sellingAll);
    decideProbes(state, batch, batchFlow, orders);
    pruneCoins(state, batch);
    return orders.slice(0, state.hello.caps.max_orders_per_batch);
  },
  onDone(state, done) {
    const start = BigInt(state.hello.capital.lamports);
    const pnl = state.cash - start;
    console.error(
      `done: ${done.reason}, final cash ${state.cash} lamports, ` +
        `net PnL ${pnl >= 0n ? "+" : ""}${pnl} lamports`,
    );
  },
});
