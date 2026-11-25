// Pump.fun Paper Sprint bot: probe + pyramid momentum sniper.
//
// The harness sends a hello first, then one batch per slot; every batch
// carries events and fills, and we answer with orders. The whole game is
// the first minute after a coin is created: most coins spike hard in their
// first slots and then bleed back to their creation price, and the price
// can never fall far below that creation price (a bonding curve only gives
// back what buyers put in), so the edge is to buy early and small, add
// only while the coin keeps rising on real buying, and let a small part
// of every position ride for the rare coin that runs to completion.
//
// Rules, all deterministic (no clock, no randomness, no environment):
//   - Probe: 0.01 SOL into a new coin as soon as its real reserve reaches
//     1 SOL (the size cap then allows a 0.01 SOL buy), the coin is at most
//     60 slots old, and the batch shows real demand (the creator bought at
//     least 0.5 SOL, or the batch's buys total at least 0.5 SOL).
//   - Add: while a held coin is at most 180 slots old, its price is at
//     least 15% above our blended entry, and the last 30 slots bought more
//     than they sold, add up to 1% of its real reserve, at most 0.15 SOL
//     invested per coin in total. We scale into strength, never into a fall.
//   - Exit: sell 40% of the tokens at +30% over the blended entry, then
//     50% of what is left at +70%. The rest is a moonbag: it only leaves
//     on a 25% pullback from its peak, on a 10% stop below entry, or after
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
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL: the smallest round trip that counts
const MAX_PER_MINT_LAMPORTS = 150_000_000n; // 0.15 SOL invested per coin, at most
const PROBE_MAX_AGE_SLOTS = 60;
const ADD_MAX_AGE_SLOTS = 180;
const ADD_MIN_GAIN_BPS = 1500; // add only 15% above our blended entry
const WINDOW_SLOTS = 30; // momentum window for adds
const TP1_BPS = 3000; // +30%: sell 40% of the tokens held
const TP2_BPS = 7000; // +70%: sell 50% of the tokens still held
const STOP_BPS = 1000; // -10% below the blended entry: sell everything
const TRAIL_BPS = 2500; // 25% below the peak: sell the moonbag
const TIMEOUT_SLOTS = 2400; // about 16 minutes: sell a stale position
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 5000;
const CREATOR_PROBE_LAMPORTS = 500_000_000n; // 0.5 SOL of creator buying
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
  creatorBuyLamports: bigint;
  probed: boolean;
  investedLamports: bigint;
  peakPrice: number;
  tp1Done: boolean;
  tp2Done: boolean;
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
        coins.set(event.mint, {
          mint: event.mint,
          createdSlot: event.slot,
          creator: event.creator,
          creatorBuyLamports: 0n,
          probed: false,
          investedLamports: 0n,
          peakPrice: 0,
          tp1Done: false,
          tp2Done: false,
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
    if (fill.status !== "filled" || fill.side !== "buy") continue;
    const coin = coins.get(fill.mint);
    if (coin !== undefined) {
      coin.investedLamports += BigInt(fill.quote_lamports);
    }
  }
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

    if (!coin.tp1Done && price >= (entry * (10000 + TP1_BPS)) / 10000) {
      const amount = (tokens * 40n) / 100n;
      if (amount > 0n) {
        orders.push({ side: "sell", mint, token_amount: amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        coin.tp1Done = true;
      }
      continue;
    }
    if (coin.tp1Done && !coin.tp2Done && price >= (entry * (10000 + TP2_BPS)) / 10000) {
      const amount = (tokens * 50n) / 100n;
      if (amount > 0n) {
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
      orders.push({ side: "sell", mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      sellingAll.add(mint);
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
  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return;
  for (const coin of coins.values()) {
    if (coin.probed) continue;
    if (state.positions.has(coin.mint)) continue;
    const curve = state.curves.get(coin.mint);
    if (curve === undefined || curve.complete) continue;
    const age = batch.slot - coin.createdSlot;
    if (age < 0 || age > PROBE_MAX_AGE_SLOTS) continue;
    if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
    const flow = batchFlow.get(coin.mint);
    const batchBuys = flow === undefined ? 0n : flow.buy;
    if (coin.creatorBuyLamports < CREATOR_PROBE_LAMPORTS && batchBuys < BATCH_PROBE_LAMPORTS) continue;
    const cap = state.maxBuyLamports(coin.mint);
    let size = PROBE_LAMPORTS < cap ? PROBE_LAMPORTS : cap;
    const free = state.freeCashLamports() - state.txFeeLamports();
    if (size > free) size = free;
    if (size < PROBE_LAMPORTS) continue;
    orders.push({ side: "buy", mint: coin.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
    coin.probed = true;
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
