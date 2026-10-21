/** The five agents' mandates, for one owner and one expiry; sizes in USD, spreads in basis points. */
export function profiles({ owner, expiry, subAccounts = {} }) {
  const base = (agentId, strike, midnight, risk) => ({
    owner, agentId,
    strike: { subAccountId: subAccounts[agentId] ?? null, markets: ["BTC-USD"], maxLeverage: 3, builderFeeBps: 0, ...strike },
    midnight: { pairs: ["tBTC/tUSD"], quoteTtlSec: 300, ...midnight },
    risk: { hedgeWithinSec: 30, dailyLossStopPct: 10, maxActionsPerMin: 12, ...risk },
    expiry, onBreach: "block",
  });
  return {
    "mm-rule": base("mm-rule", { maxPositionUsd: 300, priceBandPct: 2 }, { maxQuoteUsd: 150, minSpreadBps: 10, maxSpreadBps: 100, maxOpenQuotes: 4 }, { maxNetDeltaUsd: 150 }),
    "mm-claude": base("mm-claude", { maxPositionUsd: 300, priceBandPct: 2 }, { maxQuoteUsd: 150, minSpreadBps: 10, maxSpreadBps: 150, maxOpenQuotes: 4 }, { maxNetDeltaUsd: 150 }),
    "citizen-a": base("citizen-a", { maxPositionUsd: 0, priceBandPct: 0, markets: [] }, { maxQuoteUsd: 150, minSpreadBps: 0, maxSpreadBps: 10_000, maxOpenQuotes: 0 }, { maxNetDeltaUsd: 1000 }),
    "citizen-b": base("citizen-b", { maxPositionUsd: 0, priceBandPct: 0, markets: [] }, { maxQuoteUsd: 150, minSpreadBps: 0, maxSpreadBps: 10_000, maxOpenQuotes: 0 }, { maxNetDeltaUsd: 1000 }),
    rogue: base("rogue", { maxPositionUsd: 150, priceBandPct: 2 }, { maxQuoteUsd: 50, minSpreadBps: 10, maxSpreadBps: 100, maxOpenQuotes: 2 }, { maxNetDeltaUsd: 50 }),
  };
}
