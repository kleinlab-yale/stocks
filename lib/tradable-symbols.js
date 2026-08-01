const COMMON_CRYPTO_NAMES = new Map([
  ["BTC", "Bitcoin"],
  ["ETH", "Ethereum"],
  ["SOL", "Solana"],
  ["XRP", "XRP"],
  ["DOGE", "Dogecoin"],
  ["ADA", "Cardano"],
  ["AVAX", "Avalanche"],
  ["DOT", "Polkadot"],
  ["LINK", "Chainlink"],
  ["LTC", "Litecoin"],
  ["BCH", "Bitcoin Cash"],
  ["UNI", "Uniswap"],
  ["AAVE", "Aave"],
  ["XLM", "Stellar"],
  ["ATOM", "Cosmos"],
  ["NEAR", "NEAR Protocol"],
  ["ETC", "Ethereum Classic"],
  ["HBAR", "Hedera"],
  ["SUI", "Sui"],
  ["POL", "Polygon Ecosystem Token"],
  ["USDC", "USD Coin"],
]);

const CRYPTO_NAME_ALIASES = new Map([
  ["BITCOIN", "BTC"],
  ["ETHEREUM", "ETH"],
  ["DOGECOIN", "DOGE"],
  ["CARDANO", "ADA"],
  ["SOLANA", "SOL"],
]);

export const COMMON_CRYPTO_SYMBOLS = [...COMMON_CRYPTO_NAMES.keys()];

export function isCryptoPair(symbol) {
  return /^[A-Z0-9]{2,10}-USD$/.test(String(symbol ?? "").toUpperCase());
}

export function normalizeTradableSymbol(symbol) {
  const normalized = String(symbol ?? "").trim().toUpperCase();
  if (isCryptoPair(normalized)) return normalized;
  const aliased = CRYPTO_NAME_ALIASES.get(normalized) ?? normalized;
  return COMMON_CRYPTO_NAMES.has(aliased)
    ? `${aliased}-USD`
    : normalized;
}

export function cryptoBaseSymbol(symbol) {
  const normalized = String(symbol ?? "").toUpperCase();
  return isCryptoPair(normalized) ? normalized.slice(0, -4) : normalized;
}

export function cryptoDisplayName(symbol) {
  const base = cryptoBaseSymbol(symbol);
  return COMMON_CRYPTO_NAMES.get(base) ?? base;
}
