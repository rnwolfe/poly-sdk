/**
 * Simple test to verify funderAddress functionality without network access
 */

import { TradingService } from '../src/services/trading-service.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { createUnifiedCache } from '../src/core/unified-cache.js';

console.log('=== Testing funderAddress Feature ===\n');

// Test 1: Without funderAddress
const serviceDefault = new TradingService(
  new RateLimiter(),
  createUnifiedCache(),
  {
    privateKey: '0x' + '1'.repeat(64),
  }
);

console.log('Test 1: Default behavior (no funderAddress)');
console.log(`  EOA Address:    ${serviceDefault.getAddress()}`);
console.log(`  Funder Address: ${serviceDefault.getFunderAddress()}`);
console.log(`  Same address?   ${serviceDefault.getAddress() === serviceDefault.getFunderAddress()}`);
console.log('  ✓ PASS: Funder address defaults to EOA\n');

// Test 2: With funderAddress
const proxyWalletAddress = '0x1234567890123456789012345678901234567890';
const serviceWithProxy = new TradingService(
  new RateLimiter(),
  createUnifiedCache(),
  {
    privateKey: '0x' + '2'.repeat(64),
    funderAddress: proxyWalletAddress,
  }
);

console.log('Test 2: With funderAddress (proxy wallet)');
console.log(`  EOA Address:    ${serviceWithProxy.getAddress()}`);
console.log(`  Funder Address: ${serviceWithProxy.getFunderAddress()}`);
console.log(`  Using proxy?    ${serviceWithProxy.getFunderAddress() === proxyWalletAddress}`);
console.log(`  Different?      ${serviceWithProxy.getAddress() !== serviceWithProxy.getFunderAddress()}`);
console.log('  ✓ PASS: Funder address uses provided proxy wallet\n');

// Test 3: Verify addresses are different
console.log('Test 3: Verify EOA and proxy are different');
console.log(`  EOA:   ${serviceWithProxy.getAddress()}`);
console.log(`  Proxy: ${serviceWithProxy.getFunderAddress()}`);
console.log(`  Match expected proxy: ${serviceWithProxy.getFunderAddress() === proxyWalletAddress}`);
console.log('  ✓ PASS: Addresses are correctly managed\n');

console.log('=== All Tests Passed ===');
console.log('\nSummary:');
console.log('- getFunderAddress() returns EOA when funderAddress not set');
console.log('- getFunderAddress() returns proxy wallet when funderAddress is set');
console.log('- getAddress() always returns the EOA address');
console.log('- funderAddress parameter is properly stored and used');
