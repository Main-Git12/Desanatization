#!/usr/bin/env node
/**
 * Test x402 purchase on Base mainnet using a 12-word recovery phrase.
 *
 * The phrase is read from the command line ONLY — it is never written to disk,
 * logged, or stored anywhere. Clear shell history after running.
 *
 * Usage:
 *   node scripts/test-purchase.mjs "test test test test test test test test test test test test"
 */

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { mnemonicToAccount } from 'viem/accounts';
import { createPublicClient, http, parseEther, formatEther, erc20Abi } from 'viem';
import { base } from 'viem/chains';

const phrase = process.argv[2];

if (!phrase || phrase.split(' ').length !== 12) {
  console.error('Usage: node scripts/test-purchase.mjs "<12-word recovery phrase>"');
  console.error('The phrase is used in-memory only and never logged.');
  process.exit(1);
}

const account = mnemonicToAccount(phrase);
console.log(`Wallet: ${account.address}`);

const resourceUrl = 'https://desanatization-production-e133.up.railway.app/api/resource';

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

const ethBalance = await publicClient.getBalance({ address: account.address });
console.log(`ETH balance: ${formatEther(ethBalance)} ETH`);

if (ethBalance < parseEther('0.0005')) {
  console.error('Insufficient ETH for gas on Base mainnet. Need at least 0.0005 ETH.');
  console.error('Top up from a CEX or bridge: https://bridge.base.org');
  process.exit(1);
}

const USDC = '0x83c583D8eF1D4bCe5e8d8eC4dD0a7d78c3f4B9c5'.toLowerCase();
const usdcAbi = [
  ...erc20Abi.filter(f => f.name === 'balanceOf' || f.name === 'decimals'),
];

let usdcBalance;
try {
  const balanceRaw = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [account.address],
  });
  const decimals = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'decimals',
    args: [],
  });
  usdcBalance = Number(balanceRaw) / Math.pow(10, decimals);
} catch (e) {
  console.error('Could not read USDC balance — using Coinbase default USDC address.');
  console.error('USDC contract error:', e.message);
}

console.log(`USDC balance: ${usdcBalance ?? 'unknown'} USDC (need $0.001)`);

if (typeof usdcBalance === 'number' && usdcBalance < 0.001) {
  console.error('Insufficient USDC for payment. Need at least $0.001 USDC on Base mainnet.');
  process.exit(1);
}

const x402ClientInstance = new x402Client();
x402ClientInstance.setSpendControls({ maxAmountPerPayment: '$1.00' });
x402ClientInstance.register('eip155:*', new ExactEvmScheme(account));

const httpClient = new x402HTTPClient(x402ClientInstance);
const fetchWithPayment = wrapFetchWithPayment(fetch, x402ClientInstance);

const text = 'Test x402 micro-purchase via recovery phrase';
const url = `${resourceUrl}?text=${encodeURIComponent(text)}`;

const started = performance.now();
console.log(`\nRequesting: ${url}`);
const response = await fetchWithPayment(url, { method: 'GET' });
const elapsed = ((performance.now() - started) / 1000).toFixed(3);

const result = await httpClient.processResponse(response);
console.log(`\nStatus:  ${result.status}`);
console.log(`Payment: ${result.paymentStatus}`);
console.dir(result.body, { depth: null });

if (result.header) {
  console.log('\nSettlement receipt:');
  console.dir(result.header, { depth: null });
}

console.log(`\nCompleted in ${elapsed}s`);

if (result.paymentStatus === 'success') {
  console.log('\n✅ Payment settled! Receipt should now appear at /receipts');
} else {
  console.log('\n❌ Payment did not settle.');
}
