#!/usr/bin/env npx tsx
/**
 * DipArb Auto Trading - 15m Crypto Markets
 *
 * 策略原理：
 * 1. 检测 10 秒内 5% 以上的瞬时暴跌
 * 2. 买入暴跌侧 (Leg1)
 * 3. 等待对侧价格下降，满足 sumTarget 后买入 (Leg2)
 * 4. 双持仓锁定利润：UP + DOWN = $1
 *
 * 日志：每个市场单独一个日志文件，存放在 /tmp/dip-arb-logs/
 *
 * Run with:
 *   npx tsx scripts/dip-arb/auto-trade.ts --eth
 *   npx tsx scripts/dip-arb/auto-trade.ts --btc
 *   npx tsx scripts/dip-arb/auto-trade.ts --sol
 *   npx tsx scripts/dip-arb/auto-trade.ts --xrp
 */

import * as fs from 'fs';
import * as path from 'path';
import { PolymarketSDK } from '../../src/index.js';

// ========================================
// Parse Command Line Arguments
// ========================================

type CoinType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

interface CliArgs {
  coin: CoinType;
  dipThreshold: number;      // 跌幅阈值 (0.30 = 30%)
  slidingWindowMs: number;   // 滑动窗口 (毫秒)
  leg2TimeoutSeconds: number; // 止损时间 (秒)
  sumTarget: number;         // 总成本目标
  allocation: number;
  balanceUtilization: number;
  dryRun: boolean;
  singleRound: boolean;
  monitorMinutes: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // 解析币种
  let coin: CoinType = 'ETH';
  if (args.includes('--btc') || args.includes('-b')) coin = 'BTC';
  else if (args.includes('--eth') || args.includes('-e')) coin = 'ETH';
  else if (args.includes('--sol') || args.includes('-s')) coin = 'SOL';
  else if (args.includes('--xrp') || args.includes('-x')) coin = 'XRP';

  // 解析数值参数
  const getArgValue = (name: string, defaultVal: number): number => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    if (arg) {
      const val = parseFloat(arg.split('=')[1]);
      return isNaN(val) ? defaultVal : val;
    }
    return defaultVal;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  // 币种默认参数
  const coinDefaults: Record<CoinType, Partial<CliArgs>> = {
    XRP: { dipThreshold: 0.40, slidingWindowMs: 3000, leg2TimeoutSeconds: 60, sumTarget: 0.85 },
    SOL: { dipThreshold: 0.40, slidingWindowMs: 3000, leg2TimeoutSeconds: 60, sumTarget: 0.85 },
    ETH: { dipThreshold: 0.30, slidingWindowMs: 5000, leg2TimeoutSeconds: 60, sumTarget: 0.93 },
    BTC: { dipThreshold: 0.20, slidingWindowMs: 5000, leg2TimeoutSeconds: 60, sumTarget: 0.95 },
  };

  const defaults = coinDefaults[coin];

  return {
    coin,
    dipThreshold: getArgValue('dip', defaults.dipThreshold!),
    slidingWindowMs: getArgValue('window', defaults.slidingWindowMs!),
    leg2TimeoutSeconds: getArgValue('timeout', defaults.leg2TimeoutSeconds!),
    sumTarget: getArgValue('target', defaults.sumTarget!),
    allocation: getArgValue('alloc', 0.2),
    balanceUtilization: getArgValue('util', 0.8),
    dryRun: hasFlag('--dry-run'),
    singleRound: hasFlag('--single-round'),
    monitorMinutes: getArgValue('duration', 60),
  };
}

const CLI_ARGS = parseArgs();
const SELECTED_COIN = CLI_ARGS.coin;

// Config
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.POLYMARKET_PRIVATE_KEY || process.env.POLY_PRIVKEY || '';
const FUNDER_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || process.env.FUNDER_ADDRESS;
const SIGNATURE_TYPE = process.env.POLY_SIGNATURE_TYPE ? Number(process.env.POLY_SIGNATURE_TYPE) : undefined;
const MONITOR_DURATION_MS = CLI_ARGS.monitorMinutes * 60 * 1000;
const LOG_DIR = '/tmp/dip-arb-logs';

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  process.exit(1);
}

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ========================================
// Per-Market Logging
// ========================================

let currentMarketSlug: string | null = null;
let currentLogs: string[] = [];
let currentLogPath: string | null = null;

function getLogFilename(marketSlug: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
  return path.join(LOG_DIR, `${date}_${time}_${marketSlug}.log`);
}

function log(msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  currentLogs.push(line);
}

function sdkLogHandler(message: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  currentLogs.push(line);
}

function saveCurrentLog(suffix?: string) {
  if (currentLogs.length === 0) return;

  const logPath = currentLogPath || path.join(LOG_DIR, `unknown_${Date.now()}.log`);
  const finalPath = suffix ? logPath.replace('.log', `_${suffix}.log`) : logPath;

  fs.writeFileSync(finalPath, currentLogs.join('\n'));
  console.log(`📁 Log saved: ${finalPath} (${currentLogs.length} lines)`);
}

function startNewMarketLog(marketSlug: string) {
  // Save previous market log if exists
  if (currentLogs.length > 0 && currentMarketSlug) {
    saveCurrentLog();
  }

  // Start new log
  currentMarketSlug = marketSlug;
  currentLogs = [];
  currentLogPath = getLogFilename(marketSlug);

  log(`📝 New log file: ${currentLogPath}`);
}

// ========================================
// Main
// ========================================

async function main() {
  // ========================================
  // Configuration
  // ========================================
  const config = {
    // 交易参数 (支持命令行覆盖)
    shares: 5,
    sumTarget: CLI_ARGS.sumTarget,

    // 订单拆分参数
    splitOrders: 1,          // 单笔下单，避免份额不匹配
    orderIntervalMs: 500,    // 订单间隔 500ms (仅在 splitOrders > 1 时使用)

    // 信号检测参数 (支持命令行覆盖)
    slidingWindowMs: CLI_ARGS.slidingWindowMs,  // --window=10000 (毫秒)
    dipThreshold: CLI_ARGS.dipThreshold,        // --dip=0.30 (30%)
    windowMinutes: 14,       // 轮次开始后 14 分钟内可交易

    // 执行参数
    maxSlippage: 0.02,       // 2% 滑点
    autoExecute: !CLI_ARGS.dryRun,
    executionCooldown: 500,  // 冷却时间 500ms

    // 其他
    enableSurge: false,      // 禁用暴涨检测
    autoMerge: true,         // 自动 merge
    leg2TimeoutSeconds: CLI_ARGS.leg2TimeoutSeconds,  // --timeout=60 (秒)

    debug: true,             // 调试日志

    // 日志处理器 - 将 SDK 日志也写入当前 market 的 logs 数组
    logHandler: sdkLogHandler,
  };

  // 计算预期利润率
  const expectedProfit = ((1 - config.sumTarget) / config.sumTarget * 100).toFixed(1);

  // Start initial log
  startNewMarketLog('init');

  // Initialize SDK
  log('Initializing SDK...');
  const sdkConfig: { privateKey: string; funderAddress?: string; signatureType?: number } = {
    privateKey: PRIVATE_KEY,
  };

  if (FUNDER_ADDRESS) {
    sdkConfig.funderAddress = FUNDER_ADDRESS;
  }

  if (SIGNATURE_TYPE !== undefined) {
    sdkConfig.signatureType = SIGNATURE_TYPE;
  }

  const sdk = new PolymarketSDK(sdkConfig);

  if (FUNDER_ADDRESS && SIGNATURE_TYPE === undefined) {
    log('Error: POLY_SIGNATURE_TYPE is required when POLYMARKET_PROXY_ADDRESS is set');
    saveCurrentLog('missing-signature-type');
    return;
  }

  const balanceResult = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
  const balanceUsd = parseFloat(balanceResult.balance) / 1e6;
  const allowanceUsd = balanceResult.allowance === 'unlimited'
    ? Number.POSITIVE_INFINITY
    : parseFloat(balanceResult.allowance) / 1e6;

  if (CLI_ARGS.allocation <= 0 || CLI_ARGS.allocation > 1) {
    log('Error: --alloc must be within (0, 1]');
    saveCurrentLog('invalid-allocation');
    return;
  }

  if (CLI_ARGS.balanceUtilization <= 0 || CLI_ARGS.balanceUtilization > 1) {
    log('Error: --util must be within (0, 1]');
    saveCurrentLog('invalid-utilization');
    return;
  }

  const effectiveAllocation = Math.min(CLI_ARGS.allocation, CLI_ARGS.balanceUtilization);
  const minShares = 5;
  const maxBudget = balanceUsd * CLI_ARGS.balanceUtilization;
  const targetBudget = balanceUsd * effectiveAllocation;
  const maxShares = Math.floor(maxBudget / config.sumTarget);
  const targetShares = Math.floor(targetBudget / config.sumTarget);
  const recommendedMinBalance = (minShares * config.sumTarget) / effectiveAllocation;

  log(`Balance: $${balanceUsd.toFixed(2)} | Allowance: ${allowanceUsd === Number.POSITIVE_INFINITY ? 'Unlimited' : `$${allowanceUsd.toFixed(2)}`} | Allocation: ${(effectiveAllocation * 100).toFixed(0)}% | Utilization: ${(CLI_ARGS.balanceUtilization * 100).toFixed(0)}%`);

  if (!CLI_ARGS.dryRun && maxShares < minShares) {
    log(`Insufficient balance for minimum trade size. Recommended >= $${recommendedMinBalance.toFixed(2)}`);
    saveCurrentLog('insufficient-balance');
    return;
  }

  const shares = Math.max(targetShares, minShares);
  config.shares = shares;

  const expectedCost = config.shares * config.sumTarget;

  if (!CLI_ARGS.dryRun && allowanceUsd < expectedCost) {
    log(`Insufficient allowance for expected cost $${expectedCost.toFixed(2)}`);
    saveCurrentLog('insufficient-allowance');
    return;
  }

  sdk.dipArb.updateConfig(config);

  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log(`║           DipArb Auto Trading - ${SELECTED_COIN} Markets              ║`);
  log('╠══════════════════════════════════════════════════════════╣');
  log(`║  Dip Threshold:   ${(config.dipThreshold * 100).toFixed(0)}% in ${config.slidingWindowMs / 1000}s window                    ║`);
  log(`║  Sum Target:      ${config.sumTarget} (profit >= ${expectedProfit}%)                   ║`);
  log(`║  Stop Loss:       ${config.leg2TimeoutSeconds}s after Leg1                             ║`);
  log(`║  Shares/Trade:    ${config.shares}                                          ║`);
  log(`║  Allocation:      ${(effectiveAllocation * 100).toFixed(0)}%                                      ║`);
  log(`║  Utilization:     ${(CLI_ARGS.balanceUtilization * 100).toFixed(0)}%                                      ║`);
  log(`║  Min Balance:     $${recommendedMinBalance.toFixed(2)}                                   ║`);
  log(`║  Order Type:      Market Order (Leg1 + Leg2 + Exit)              ║`);
  log(`║  Dry Run:         ${CLI_ARGS.dryRun ? 'ON' : 'OFF'}                                     ║`);
  log(`║  Single Round:    ${CLI_ARGS.singleRound ? 'ON' : 'OFF'}                                     ║`);
  log(`║  Duration:        ${CLI_ARGS.monitorMinutes}m                                         ║`);
  log(`║  Log Directory:   ${LOG_DIR}`);
  log('╚══════════════════════════════════════════════════════════╝');
  log('');
  log('Usage: npx tsx auto-trade.ts --xrp [--dip=0.40] [--window=3000] [--timeout=60] [--target=0.95] [--alloc=0.20] [--util=0.80] [--duration=60] [--dry-run] [--single-round]');
  log('');

  // ========================================
  // Event Listeners
  // ========================================

  sdk.dipArb.on('started', (market) => {
    // Start new log for this market
    startNewMarketLog(market.slug || market.conditionId.slice(0, 20));

    log('');
    log('┌──────────────────────────────────────────────────────────┐');
    log('│                    MARKET STARTED                        │');
    log('├──────────────────────────────────────────────────────────┤');
    log(`│ ${market.name.slice(0, 56)}`);
    log(`│ ${market.underlying} ${market.durationMinutes}m`);
    log(`│ End Time: ${market.endTime.toISOString()}`);
    log(`│ Condition: ${market.conditionId.slice(0, 30)}...`);
    log('└──────────────────────────────────────────────────────────┘');
  });

  sdk.dipArb.on('stopped', () => {
    log('>>> SERVICE STOPPED');
  });

  sdk.dipArb.on('newRound', (event) => {
    const sum = event.upOpen + event.downOpen;
    log(`>>> NEW ROUND | UP: ${event.upOpen.toFixed(3)} | DOWN: ${event.downOpen.toFixed(3)} | Sum: ${sum.toFixed(3)}`);
  });

  sdk.dipArb.on('signal', (signal) => {
    log('');
    log('╔══════════════════════════════════════════════════════════╗');
    if (signal.type === 'leg1') {
      log(`║  LEG1 SIGNAL: Buy ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)}`);
      log(`║  Drop: ${(signal.dropPercent * 100).toFixed(1)}% | Opposite: ${signal.oppositeAsk.toFixed(4)}`);
    } else {
      log(`║  LEG2 SIGNAL: Buy ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
      log(`║  Total Cost: ${signal.totalCost.toFixed(4)} | Profit: ${(signal.expectedProfitRate * 100).toFixed(2)}%`);
    }
    log('╚══════════════════════════════════════════════════════════╝');
  });

  sdk.dipArb.on('execution', (result) => {
    if (result.success) {
      log(`✅ ${result.leg.toUpperCase()} FILLED: ${result.side} @ ${result.price?.toFixed(4)} x${result.shares}`);
    } else {
      log(`❌ ${result.leg.toUpperCase()} FAILED: ${result.error}`);
    }
  });

  sdk.dipArb.on('roundComplete', async (result) => {
    log('');
    log('┌──────────────────────────────────────────────────────────┐');
    log(`│  ROUND ${result.status.toUpperCase()}`);
    if (result.profit !== undefined) {
      log(`│  Profit: $${result.profit.toFixed(4)} (${(result.profitRate! * 100).toFixed(2)}%)`);
    }
    log('└──────────────────────────────────────────────────────────┘');

    if (CLI_ARGS.singleRound) {
      log('Single-round mode complete. Stopping.');
      saveCurrentLog('single-round');
      await sdk.dipArb.stop();
      sdk.stop();
      process.exit(0);
    }
  });

  sdk.dipArb.on('rotate', (event) => {
    // Save current market log before rotation
    log('');
    log('╔══════════════════════════════════════════════════════════╗');
    log(`║  🔄 MARKET ROTATION                                      ║`);
    log(`║  Reason: ${event.reason}`);
    log(`║  Previous: ${event.previousMarket?.slice(0, 40) || 'none'}...`);
    log(`║  New: ${event.newMarket.slice(0, 40)}...`);
    log('╚══════════════════════════════════════════════════════════╝');

    // Save old log and start new one
    // Note: 'started' event will be triggered after rotate, which will start new log
  });

  sdk.dipArb.on('settled', (result) => {
    log(`>>> SETTLED: ${result.strategy} | Success: ${result.success}`);
    if (result.amountReceived) {
      log(`    Amount: $${result.amountReceived.toFixed(2)}`);
    }
    if (result.error) {
      log(`    Error: ${result.error}`);
    }
  });

  sdk.dipArb.on('error', (error) => {
    log(`[ERROR] ${error.message}`);
  });

  // ========================================
  // Scan and Start
  // ========================================

  log(`Scanning for ${SELECTED_COIN} 15m markets...`);
  const markets = await sdk.dipArb.scanUpcomingMarkets({
    coin: SELECTED_COIN,
    duration: '15m',
    limit: 5,
  });

  log(`Found ${markets.length} markets:`);
  for (const m of markets) {
    const endIn = Math.round((m.endTime.getTime() - Date.now()) / 60000);
    const status = endIn <= 0 ? '(ENDED)' : `(ends in ${endIn}m)`;
    log(`  - ${m.name.slice(0, 50)} ${status}`);
    log(`    Condition: ${m.conditionId.slice(0, 30)}...`);
    log(`    End: ${m.endTime.toISOString()}`);
  }

  if (markets.length === 0) {
    log('No markets found. Exiting.');
    saveCurrentLog('no-markets');
    return;
  }

  // Filter out already ended markets
  const activeMarkets = markets.filter(m => m.endTime.getTime() > Date.now());
  if (activeMarkets.length === 0) {
    log('All markets have ended. Waiting for new markets...');
  } else {
    log(`Active markets: ${activeMarkets.length}`);
  }

  // Start
  const market = await sdk.dipArb.findAndStart({
    coin: SELECTED_COIN,
    preferDuration: '15m',
  });

  if (!market) {
    log('Failed to start. Exiting.');
    saveCurrentLog('failed');
    return;
  }

  log(`Selected market ends at: ${market.endTime.toISOString()}`);
  const timeUntilEnd = Math.round((market.endTime.getTime() - Date.now()) / 1000);
  log(`Time until market end: ${timeUntilEnd}s (${Math.round(timeUntilEnd / 60)}m)`);

  // Enable auto-rotate with redeem strategy
  if (!CLI_ARGS.singleRound) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: [SELECTED_COIN],
      duration: '15m',
      settleStrategy: 'redeem',  // 等待市场结算后赎回 (5分钟后)
      autoSettle: true,
      preloadMinutes: 2,
      redeemWaitMinutes: 5,       // 市场结束后等待 5 分钟再赎回
      redeemRetryIntervalSeconds: 30,  // 每 30 秒检查一次
    });
    log(`Auto-rotate enabled for ${SELECTED_COIN} (with background redemption)`);
  } else {
    log('Auto-rotate disabled in single-round mode');
  }

  log('');
  log('═══════════════════════════════════════════════════════════');
  log('  AUTO TRADING ACTIVE - Press Ctrl+C to stop');
  log('═══════════════════════════════════════════════════════════');
  log('');

  // Status update every 30 seconds (more frequent to catch rotation)
  let statusCount = 0;
  const statusInterval = setInterval(() => {
    const stats = sdk.dipArb.getStats();
    const round = sdk.dipArb.getCurrentRound();
    const currentMarket = sdk.dipArb.getMarket();
    statusCount++;

    // Check if market has ended
    if (currentMarket) {
      const timeLeft = Math.round((currentMarket.endTime.getTime() - Date.now()) / 1000);
      const timeLeftStr = timeLeft > 0 ? `${timeLeft}s left` : `ENDED ${-timeLeft}s ago`;
      log(`[Status #${statusCount}] Market: ${currentMarket.underlying} | ${timeLeftStr} | Signals: ${stats.signalsDetected} | L1: ${stats.leg1Filled} | L2: ${stats.leg2Filled}`);
    } else {
      log(`[Status #${statusCount}] No market active | Signals: ${stats.signalsDetected}`);
    }

    // Show current position
    if (round) {
      if (round.phase === 'leg1_filled' && round.leg1) {
        log(`  📊 Position: ${round.leg1.shares}x ${round.leg1.side} @ ${round.leg1.price.toFixed(4)} | Waiting for Leg2...`);
      } else if (round.phase === 'completed' && round.leg1 && round.leg2) {
        const totalCost = round.leg1.price + round.leg2.price;
        const profit = (1 - totalCost) * round.leg1.shares;
        log(`  📊 Position: ${round.leg1.shares}x UP + ${round.leg2.shares}x DOWN | Cost: ${totalCost.toFixed(4)} | Profit: $${profit.toFixed(2)}`);
      } else if (round.phase === 'waiting') {
        log(`  📊 Position: None (waiting for signal)`);
      }
    }
  }, 30000);

  // Wait
  await new Promise(resolve => setTimeout(resolve, MONITOR_DURATION_MS));

  // Cleanup
  clearInterval(statusInterval);

  // Final stats
  const stats = sdk.dipArb.getStats();
  log('');
  log('╔══════════════════════════════════════════════════════════╗');
  log('║                     FINAL STATS                          ║');
  log('╠══════════════════════════════════════════════════════════╣');
  log(`║ Running Time:     ${Math.round(stats.runningTimeMs / 1000)}s`);
  log(`║ Rounds Monitored: ${stats.roundsMonitored}`);
  log(`║ Signals Detected: ${stats.signalsDetected}`);
  log(`║ Leg1 Filled:      ${stats.leg1Filled}`);
  log(`║ Leg2 Filled:      ${stats.leg2Filled}`);
  log(`║ Total Profit:     $${stats.totalProfit.toFixed(2)}`);
  log('╚══════════════════════════════════════════════════════════╝');

  await sdk.dipArb.stop();
  sdk.stop();

  // Save final log
  saveCurrentLog('final');
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
  log('');
  log('Interrupted. Saving logs...');
  saveCurrentLog('interrupted');
  process.exit(0);
});

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(err);
  saveCurrentLog('error');
  process.exit(1);
});
