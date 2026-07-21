(function attachPortfolioTools(root) {
  "use strict";

  function finite(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function totalShares(holding) {
    return (holding?.lots || []).reduce((sum, lot) => sum + (finite(lot.shares) || 0), 0);
  }

  function pricedShares(holding) {
    return (holding?.lots || []).reduce((sum, lot) => {
      const shares = finite(lot.shares);
      const price = finite(lot.price);
      return sum + (shares > 0 && price > 0 ? shares : 0);
    }, 0);
  }

  function costBasis(holding) {
    return (holding?.lots || []).reduce((sum, lot) => {
      const shares = finite(lot.shares);
      const price = finite(lot.price);
      return sum + (shares > 0 && price > 0 ? shares * price : 0);
    }, 0);
  }

  function summarizeHolding(holding, currentPrice) {
    const shares = totalShares(holding);
    const coveredShares = pricedShares(holding);
    const basis = costBasis(holding);
    const market = finite(currentPrice);
    const marketValue = market === null ? null : shares * market;
    const coveredMarketValue = market === null ? null : coveredShares * market;
    const unrealized = coveredMarketValue === null || !coveredShares ? null : coveredMarketValue - basis;
    const returnPercent = unrealized === null || basis <= 0 ? null : (unrealized / basis) * 100;
    return {
      shares,
      pricedShares: coveredShares,
      costBasis: basis,
      averageCost: coveredShares ? basis / coveredShares : null,
      marketValue,
      unrealized,
      returnPercent,
      complete: shares > 0 && Math.abs(shares - coveredShares) < 1e-9,
    };
  }

  function normalizeHoldings(saved, symbols, makeId) {
    const bySymbol = new Map();
    const hasSavedPortfolio = Array.isArray(saved);
    const source = hasSavedPortfolio ? saved : [];
    source.forEach((item) => {
      const symbol = String(item?.symbol || "").trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return;
      const rawLots = Array.isArray(item.lots) ? item.lots : [{ shares: item.shares, price: item.price ?? item.buyPrice }];
      const lots = rawLots.map((lot) => {
        const shares = finite(lot?.shares);
        const price = finite(lot?.price ?? lot?.buyPrice);
        if (!shares || shares <= 0) return null;
        return {
          id: String(lot?.id || makeId()),
          shares,
          price: price && price > 0 ? price : null,
        };
      }).filter(Boolean);
      if (!lots.length) return;
      if (bySymbol.has(symbol)) bySymbol.get(symbol).lots.push(...lots);
      else bySymbol.set(symbol, { symbol, lots });
    });

    if (!bySymbol.size && !hasSavedPortfolio) {
      (symbols || []).forEach((item) => {
        const symbol = String(item?.symbol || "").trim().toUpperCase();
        if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
          bySymbol.set(symbol, { symbol, lots: [{ id: String(makeId()), shares: 1, price: null }] });
        }
      });
    }
    return [...bySymbol.values()];
  }

  const api = { finite, totalShares, pricedShares, costBasis, summarizeHolding, normalizeHoldings };
  root.TickerQuestPortfolio = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
