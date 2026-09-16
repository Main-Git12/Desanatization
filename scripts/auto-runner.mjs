#!/usr/bin/env node
// ============================================================================
// Auto Runner — Waits for USDC, then executes the full payment flow
//
// Polls the Base mainnet for USDC at the pay-to address until the balance
// reaches the threshold, then automatically executes:
//   1. Test purchase against the live endpoint
//   2. x402-list.com submission (with $1 fee)
//
// Usage:
//   EVM_PRIVATE_KEY=0x... node scripts/auto-runner.mjs
//
// The private key MUST be for the same wallet receiving the USDC.
// ============================================================================

import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount, getAddress } from 'viem/accounts';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

try {
  process.loadEnvFile?.('.env');
} catch {}

const WALLET = (process.env.WAIT_WALLET || '0xfE278cCC898768A162eC07989d56bA579B78E902');
const MIN_USDC = parseFloat(process.env.MIN_USDC || '0.01');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000');

const USDC_CONTRACT = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const USDC_ABI = parseAbi(['function balanceOf(address) returns (uint256)']);
const RESOURCE_URL = process.env.RESOURCE_URL || 'https://desanatization-production.up.railway.app/api/resource';
const X402_LIST_URL = 'https://x402-list.com/api/v1/submit';

const RPCS = [
  'https://mainnet.base.org',
  'https://base.drpc.org',
  'https://base.publicnode.com',
];

let rpcIndex = 0;
const client = createPublicClient({
  chain: base,
  transport: http(RPCS[0], { timeout: 15_000 }),
});

const privateKey = process.env.EVM_PRIVATE_KEY;

/**
 * @param {() => Promise<any>} fn
 */
async function withFallback(fn) {
  for (let attempt = 0; attempt < RPCS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      rpcIndex = (rpcIndex + 1) % RPCS.length;
      console.error(`RPC ${RPCS[rpcIndex]} failed, trying next...`);
    }
  }
  throw new Error('All RPC providers exhausted');
}

/**
 * @returns {Promise<number>}
 */
async function getUSDCBalance() {
  return withFallback(async () => {
    const bal = await client.readContract({
      address: USDC_CONTRACT,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [getAddress(WALLET)],
    });
    return parseFloat(bal.toString()) / 1_000_000;
  });
}

/**
 * Execute the test purchase against the live endpoint.
 */
async function executeTestPurchase(account) {
  console.log('\n=== Test Purchase ===');
  console.log(`Endpoint: ${RESOURCE_URL}`);
  console.log(`Wallet:   ${account.address}`);

  const xclient = new x402Client();
  xclient.setSpendControls({ maxAmountPerPayment: '$0.01' });
  xclient.register('eip155:*', new ExactEvmScheme(account));

  const httpClient = new x402HTTPClient(xclient);
  const fetchWithPayment = wrapFetchWithPayment(fetch, xclient);

  const text = 'Contact me at jane@example.com, SSN 123-45-6789, card 4111-1111-1111-1111';
  const url = `${RESOURCE_URL}?text=${encodeURIComponent(text)}`;
  
  const response = await fetchWithPayment(url, { method: 'GET' });
  const result = await httpClient.processResponse(response);
  
  console.log(`Status:   ${result.status} (payment: ${result.paymentStatus})`);
  console.dir(result.body, { depth: null });
  
  if (result.header) {
    console.log('Settlement receipt:');
    console.dir(result.header, { depth: null });
  }
  
  return result.status === 200 && result.paymentStatus === 'success';
}

/**
 * Submit to x402-list.com
 */
async function submitX402List(account) {
  console.log('\n=== x402-list.com Submission ===');
  
  const xclient = new x402Client();
  xclient.setSpendControls({ maxAmountPerPayment: '$1.00' });
  xclient.register('eip155:*', new ExactEvmScheme(account));

  const httpClient = new x402HTTPClient(xclient);
  const fetchWithPayment = wrapFetchWithPayment(fetch, xclient);

  const body = JSON.stringify({
    url: 'https://desanatization-production.up.railway.app',
    email: 'andrew.peal12@gmail.com',
    service_name: 'Desanatization',
    description: 'Deterministic PII sanitization for AI agents over x402 v2. Redacts emails, phones, SSNs, credit-card numbers, private keys, Bearer tokens and URL query secrets. Free trial for the first 500 chars, then $0.001 per full job on Base mainnet. Batch pricing available.',
    website_url: 'https://desanatization-production.up.railway.app',
    category: 'AI',
    endpoints: ['/api/resource', '/api/sanitize/trial', '/api/sanitize/batch'],
    notes: 'x402 v2 with CDP facilitator on Base mainnet. Bazaar discovery enabled. PayTo: 0x8d9372cdF4Cef4EBA4BA63D3552755aA476eDb92.',
  });

  const res = await fetchWithPayment(X402_LIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const result = await httpClient.processResponse(res);
  
  console.log('Status:', result.status);
  console.log('Body:', JSON.stringify(result.body, null, 2));
  if (result.header) {
    console.log('Settlement receipt:');
    console.dir(result.header, { depth: null });
  }
  
  return result.status === 200;
}

/**
 * Verify receipts endpoint
 */
async function verifyReceipts() {
  console.log('\n=== Verifying Receipts ===');
  const res = await fetch('https://desanatization-production.up.railway.app/receipts');
  const data = await res.json();
  console.log('Receipts:', JSON.stringify(data, null, 2));
  return data.count > 0;
}

async function main() {
  console.log('Auto Runner');
  console.log(`  Wallet: ${WALLET}`);
  console.log(`  Minimum: ${MIN_USDC} USDC`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log('');

  if (!privateKey) {
    console.log('⚠ EVM_PRIVATE_KEY not set — will monitor but cannot execute transactions.');
    console.log('  Set EVM_PRIVATE_KEY=0x... to enable automated execution.');
  } else {
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== WALLET.toLowerCase()) {
      console.error(`✖ Private key address (${account.address}) does not match target wallet (${WALLET})`);
      process.exit(1);
    }
    console.log(`✓ Private key matches wallet: ${account.address}`);
  }

  console.log('\nMonitoring for USDC...');

  while (true) {
    try {
      const balance = await getUSDCBalance();
      console.log(`[${new Date().toISOString()}] USDC Balance: ${balance.toFixed(6)} USDC`);

      if (balance >= MIN_USDC) {
        console.log(`\n✓ Sufficient USDC detected (${balance.toFixed(6)} >= ${MIN_USDC})`);
        
        if (!privateKey) {
          console.log('\n✋ USDC detected but EVM_PRIVATE_KEY is not set.');
          console.log('   Please provide the private key to continue with automated execution.');
          process.exit(1);
        }

        const account = privateKeyToAccount(privateKey);
        let success = false;
        
        try {
          success = await executeTestPurchase(account);
          if (success) {
            console.log('\n✅ Test purchase succeeded!');
          } else {
            console.log('\n❌ Test purchase failed.');
          }
        } catch (error) {
          console.error('Test purchase error:', error.message || error);
        }

        try {
          const listed = await submitX402List(account);
          if (listed) {
            console.log('\n✅ x402-list.com submission succeeded!');
          } else {
            console.log('\n❌ x402-list.com submission failed.');
          }
        } catch (error) {
          console.error('x402-list submission error:', error.message || error);
        }

        await verifyReceipts();
        
        if (success) {
          process.exit(0);
        }
      }
      
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error('Monitoring error:', error.message || error);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 2));
    }
  }
}

main().catch((error) => {
  console.error('Fatal:', error.message || error);
  process.exit(1);
});
