#!/usr/bin/env node
// ============================================================================
// USDC Watch — Monitor Base mainnet for incoming USDC to the pay-to address
//
// Polls the Base mainnet via a public RPC until USDC arrives, then notifies
// (currently just logs + exits 0). Intended to run as a gate before the
// end-to-end test purchase can execute.
//
// Usage:
//   node scripts/monitor-usdc.mjs
//   WAIT_WALLET=0x... node scripts/monitor-usdc.mjs
//   MIN_USDC=0.01 node scripts/monitor-usdc.mjs
// ============================================================================

import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import { base } from 'viem/chains';

const WALLET = (process.env.WAIT_WALLET || '0xfE278cCC898768A162eC07989d56bA579B78E902');
const MIN_USDC = parseFloat(process.env.MIN_USDC || '0.005');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');

const USDC_CONTRACT = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const USDC_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { type: 'address', name: 'from', indexed: true },
      { type: 'address', name: 'to', indexed: true },
      { type: 'uint256', name: 'value' },
    ],
  },
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarnic.com',
  'https://rpc.ankr.com/base',
  'https://base-api.infura.io/v1/pagged/cotribute-payment-upstream-fallback',
];

let rpcIndex = 0;
const client = createPublicClient({
  chain: base,
  transport: http(RPCS[0], { timeout: 15_000 }),
});

/**
 * Try a JSON-RPC call, rotating through backup RPC providers on failure.
 * @param {() => Promise<any>} fn - Call to retry
 * @returns {Promise<any>}
 */
async function withFallback(fn) {
  const startIndex = rpcIndex;
  for (let attempt = 0; attempt < RPCS.length; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      const next = (rpcIndex + 1) % RPCS.length;
      if (next === startIndex) {
        throw error;
      }
      rpcIndex = next;
      console.error(`RPC ${RPCS[rpcIndex]} failed, trying next...`, error.message || error);
    }
  }
  throw new Error('All RPC providers exhausted');
}

/**
 * Check the wallet's USDC balance.
 * @returns {Promise<number>} USDC balance in human-readable units
 */
async function getBalance() {
  return withFallback(async () => {
    const bal = await client.readContract({
      address: USDC_CONTRACT,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [getAddress(WALLET)],
    });
    return parseFloat(formatUnits(bal, 6));
  });
}

/**
 * Get the current block number.
 * @returns {Promise<bigint>}
 */
async function getBlockNumber() {
  return withFallback(async () => client.getBlockNumber());
}

/**
 * Main polling loop: log balance every interval until USDC >= MIN_USDC.
 */
async function main() {
  console.log(`USDC Watch`);
  console.log(`  Wallet: ${WALLET}`);
  console.log(`  Minimum: ${MIN_USDC} USDC`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log('');

  let balance = await getBalance();
  console.log(`[${new Date().toISOString()}] Balance: ${balance.toFixed(6)} USDC`);

  if (balance >= MIN_USDC) {
    console.log(`✓ Sufficient USDC detected (${balance.toFixed(6)} >= ${MIN_USDC}). Proceed with payment test.`);
    process.exit(0);
  }

  console.log(`Balance below threshold. Monitoring for incoming transfers...`);
  console.log('');

  let lastNotified = 0;

  while (true) {
    try {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      balance = await getBalance();
      const now = Date.now();

      if (balance > lastNotified || balance >= MIN_USDC) {
        console.log(`[${new Date().toISOString()}] Balance: ${balance.toFixed(6)} USDC`);
        lastNotified = balance;
      }

      if (balance >= MIN_USDC) {
        console.log('');
        console.log(`✓ Sufficient USDC detected (${balance.toFixed(6)} >= ${MIN_USDC}). Proceed with payment test.`);
        process.exit(0);
      }
    } catch (error) {
      console.error('Polling error:', error.message || error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

main().catch((error) => {
  console.error('USDC watch failed:', error.message || error);
  process.exit(1);
});
