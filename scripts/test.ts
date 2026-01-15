import { PolymarketSDK } from '../src/index.js';

const privateKey = process.env.PRIVATE_KEY || process.env.POLYMARKET_PRIVATE_KEY || process.env.POLY_PRIVKEY;
const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS || process.env.FUNDER_ADDRESS;
const signatureType = process.env.POLY_SIGNATURE_TYPE
  ? Number(process.env.POLY_SIGNATURE_TYPE)
  : 2;

if (!privateKey) {
  throw new Error('Missing PRIVATE_KEY');
}

if (!funderAddress) {
  throw new Error('Missing POLYMARKET_PROXY_ADDRESS');
}

const sdk = await PolymarketSDK.create({
  privateKey,
  funderAddress,
  signatureType,
});

const market = await sdk.getMarket('will-bitcoin-reach-150000-by-december-31-2026-557');
const yesToken = market.tokens.find((t) => t.outcome === 'Yes');
if (!yesToken) throw new Error('No YES token');

const order = await sdk.tradingService.createLimitOrder({
  tokenId: yesToken.tokenId,
  side: 'BUY',
  price: 0.5,
  size: 5,
  orderType: 'GTC',
});

console.log('Order:');
console.dir(order);

sdk.stop();
