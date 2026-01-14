/**
 * Example: Using funderAddress with Polymarket SDK
 * 
 * This example demonstrates how to use the funderAddress parameter
 * to specify your Polymarket proxy wallet address for order creation.
 * 
 * Background:
 * - Polymarket uses proxy wallet contracts to hold user funds
 * - By default, orders use your EOA (Externally Owned Account) address
 * - You can specify your proxy wallet address using the funderAddress option
 * - This makes the proxy wallet the "maker" of orders instead of your EOA
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== Polymarket funderAddress Example ===\n');

  // Example 1: SDK without funderAddress (uses EOA)
  console.log('Example 1: Default behavior (no funderAddress)');
  const sdkDefault = new PolymarketSDK({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '0x' + '1'.repeat(64),
  });
  
  await sdkDefault.tradingService.initialize();
  
  console.log(`  EOA Address:    ${sdkDefault.tradingService.getAddress()}`);
  console.log(`  Funder Address: ${sdkDefault.tradingService.getFunderAddress()}`);
  console.log(`  Same address:   ${sdkDefault.tradingService.getAddress() === sdkDefault.tradingService.getFunderAddress()}`);
  console.log();

  // Example 2: SDK with funderAddress (uses proxy wallet)
  console.log('Example 2: With funderAddress (proxy wallet)');
  const proxyWalletAddress = '0x1234567890123456789012345678901234567890'; // Example proxy wallet
  
  const sdkWithProxy = new PolymarketSDK({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '0x' + '1'.repeat(64),
    funderAddress: proxyWalletAddress,
  });
  
  await sdkWithProxy.tradingService.initialize();
  
  console.log(`  EOA Address:    ${sdkWithProxy.tradingService.getAddress()}`);
  console.log(`  Funder Address: ${sdkWithProxy.tradingService.getFunderAddress()}`);
  console.log(`  Using proxy:    ${sdkWithProxy.tradingService.getFunderAddress() === proxyWalletAddress}`);
  console.log();

  // Example 3: Using factory method
  console.log('Example 3: Using factory method with funderAddress');
  const sdkFactory = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || '0x' + '1'.repeat(64),
    funderAddress: proxyWalletAddress,
  });
  
  console.log(`  EOA Address:    ${sdkFactory.tradingService.getAddress()}`);
  console.log(`  Funder Address: ${sdkFactory.tradingService.getFunderAddress()}`);
  console.log();

  // How to find your proxy wallet address:
  console.log('=== How to Find Your Proxy Wallet Address ===');
  console.log('1. Check your Polymarket profile page');
  console.log('2. Use the Data API: https://data-api.polymarket.com/...');
  console.log('3. For Magic Link users: https://reveal.magic.link/polymarket');
  console.log('4. Check the Polymarket documentation for proxy wallet info');
  console.log();

  // Note about order creation
  console.log('=== Important Notes ===');
  console.log('When funderAddress is set:');
  console.log('- Orders will use the proxy wallet address as the "maker"');
  console.log('- Funds must be available in the proxy wallet, not the EOA');
  console.log('- The EOA is still used for signing transactions');
  console.log('- This matches how Polymarket\'s official clients work');
  console.log();

  // Clean up
  sdkDefault.stop();
  sdkWithProxy.stop();
  sdkFactory.stop();
}

main().catch(console.error);
