#!/usr/bin/env node
// Purchase Monitor — polls /health and /receipts, attempts test purchase
import { createPublicClient, http, formatUnits, getAddress, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE_URL = 'https://desanatization-production.up.railway.app';
const USDC_CONTRACT = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const USDC_ABI = parseAbi(['function balanceOf(address) returns (uint256)']);
const RPCS = ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base.publicnode.com'];

let rpcIndex = 0;
const client = createPublicClient({ chain: base, transport: http(RPCS[0], { timeout: 15_000 }) });

async function withFallback(fn) {
  const startIndex = rpcIndex;
  for (let attempt = 0; attempt < RPCS.length; attempt++) {
    try { return await fn(); }
    catch { rpcIndex = (rpcIndex + 1) % RPCS.length; }
  }
  throw new Error('All RPC providers exhausted');
}

async function getUSDCBalance(walletHex) {
  return withFallback(async () => {
    const bal = await client.readContract({
      address: USDC_CONTRACT, abi: USDC_ABI, functionName: 'balanceOf',
      args: [getAddress(walletHex)],
    });
    return parseFloat(formatUnits(bal, 6));
  });
}

function loadEnvFile(path) {
  const content = readFileSync(path, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

let PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || null;
let SENDER_WALLET = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY).address : null;

function nowISO() { return new Date().toISOString(); }
function fmtMs(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}m ${s % 60}s`; }

const startTime = Date.now();
const POLL_MS = 60_000;
const PURCHASE_AFTER = 5 * 60_000;
const STATUS_EVERY = 3 * 60_000;
const MAX_MS = 15 * 60_000;
const PRICE_ATOMIC = 1000; // $0.001 USDC = 1000 atomic units
const RECEIVER = '0x8d9372cdF4Cef4EBA4BA63D3552755aA476eDb92';

let lastStatus = 0, purchaseAttempted = false, purchaseResult = null, purchaseDetail = '', receiptsCount = 0, healthOk = false, paywallReady = false;

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json() };
}

function runPurchase() {
  return new Promise((resolve) => {
    console.log(`[${nowISO()}] Spawning fetch-client.mjs…`);
    const child = spawn('node', ['clients/fetch-client.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, EVM_PRIVATE_KEY: PRIVATE_KEY || '', RESOURCE_URL: `${BASE_URL}/api/resource` },
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code));
    child.on('error', (err) => resolve(1));
  });
}

async function attemptPurchase() {
  if (purchaseAttempted) return;
  purchaseAttempted = true;
  console.log(`\n[${nowISO()}] === PURCHASE ATTEMPT ===`);

  if (!PRIVATE_KEY) {
    console.log(`[${nowISO()}] EVM_PRIVATE_KEY not set — cannot execute purchase.`);
    purchaseResult = 'no-private-key';
    purchaseDetail = 'EVM_PRIVATE_KEY missing from environment.';
    return;
  }

  // Step a: Check USDC balance
  console.log(`[${nowISO()}] Checking sender wallet USDC balance…`);
  console.log(`[${nowISO()}] Sender: ${SENDER_WALLET}`);
  let senderBal = 0;
  try {
    senderBal = await getUSDCBalance(SENDER_WALLET);
    console.log(`[${nowISO()}] Sender balance: ${senderBal.toFixed(6)} USDC`);
  } catch (e) {
    console.log(`[${nowISO()}] Balance check failed: ${e.message}`);
    purchaseResult = 'error';
    purchaseDetail = `Balance check failed: ${e.message}`;
    return;
  }

  try {
    const recvBal = await getUSDCBalance(RECEIVER);
    console.log(`[${nowISO()}] Receiver balance: ${recvBal.toFixed(6)} USDC`);
  } catch (e) {
    console.log(`[${nowISO()}] Receiver balance check failed: ${e.message}`);
  }

  // Step b: Execute purchase if sufficient
  if (senderBal * 1_000_000 >= PRICE_ATOMIC) {
    console.log(`[${nowISO()}] Sufficient USDC. Executing purchase flow…`);
    const code = await runPurchase();
    if (code === 0) {
      purchaseResult = 'success';
      purchaseDetail = 'fetch-client.mjs exited cleanly.';
    } else {
      purchaseResult = 'failed';
      purchaseDetail = `fetch-client.mjs exited with code ${code}.`;
    }
  } else {
    const shortfall = Math.max(0, 0.001 - senderBal);
    console.log(`[${nowISO()}] INSUFFICIENT USDC at sender.`);
    console.log(`[${nowISO()}] Sender: ${senderBal.toFixed(6)} USDC, need 0.001 USDC.`);
    console.log(`[${nowISO()}] Funding shortfall: ${shortfall.toFixed(6)} USDC. Cannot create money.`);
    purchaseResult = 'insufficient-funds';
    purchaseDetail = `Sender ${senderBal.toFixed(6)} USDC, need 0.001. Shortfall ${shortfall.toFixed(6)} USDC.`;
  }
}

async function main() {
  // Load .env.production values if present (only for missing env vars)
  try { loadEnvFile('.env.production'); } catch { /* ignore */ }
  // Re-check private key after loading env
  const pk = process.env.EVM_PRIVATE_KEY || null;
  if (pk) {
    PRIVATE_KEY = pk;
    SENDER_WALLET = privateKeyToAccount(pk).address;
  }

  console.log('');
  console.log('════════════════════════════════════════════════════');
  console.log('  PURCHASE MONITOR — Desanatization');
  console.log(`  Start: ${nowISO()}`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Poll: 60s | Purchase check: 5min | Status: 3min | Max: 15min`);
  console.log(`  Sender wallet: ${SENDER_WALLET ?? 'NOT SET'}`);
  console.log('════════════════════════════════════════════════════');

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= MAX_MS) {
      console.log(`\n[${nowISO()}] 15 minutes elapsed. Stopping.`);
      if (!purchaseResult) { purchaseResult = 'timeout'; purchaseDetail = 'Max duration reached.'; }
      break;
    }

    if (elapsed - lastStatus >= STATUS_EVERY) {
      lastStatus = elapsed;
      const mins = Math.floor(elapsed / 60_000);
      console.log(`\n[${nowISO()}] ── STATUS (${mins}m) ──`);
      console.log(`  Health: ${healthOk ? 'PASS' : 'FAIL'} paywallReady=${paywallReady} receipts=${receiptsCount}`);
      if (purchaseAttempted) console.log(`  Purchase: ${purchaseResult} — ${purchaseDetail}`);
      else console.log(`  Purchase: pending (in ${Math.round((PURCHASE_AFTER - elapsed) / 1000)}s)`);
      console.log(`  Remaining: ${Math.max(0, (MAX_MS - elapsed) / 1000).toFixed(0)}s`);
    }

    try {
      const h = await getJSON(`${BASE_URL}/health`);
      healthOk = h.status === 200;
      paywallReady = h.body?.paywallReady === true;
      console.log(`[${nowISO()}] HEALTH: HTTP ${h.status} paywallReady=${paywallReady} network=${h.body?.network}`);
    } catch (e) { console.log(`[${nowISO()}] HEALTH ERR: ${e.message}`); }

    try {
      const r = await getJSON(`${BASE_URL}/receipts`);
      receiptsCount = r.body?.count ?? 0;
      console.log(`[${nowISO()}] RECEIPTS: HTTP ${r.status} count=${receiptsCount}`);
      if (receiptsCount > 0) {
        console.log(`\n[${nowISO()}] === PURCHASE CONFIRMED ===`);
        console.log(JSON.stringify(r.body, null, 2));
        purchaseResult = 'confirmed';
        purchaseDetail = `${receiptsCount} receipt(s) in receipts endpoint.`;
        break;
      }
    } catch (e) { console.log(`[${nowISO()}] RECEIPTS ERR: ${e.message}`); }

    if (elapsed >= PURCHASE_AFTER && !purchaseAttempted) {
      await attemptPurchase();
      console.log(`\n[${nowISO()}] Purchase result: ${purchaseResult}`);
      if (purchaseDetail) console.log(`[${nowISO()}] ${purchaseDetail}`);
      break;
    }

    const wait = Math.min(POLL_MS, MAX_MS - elapsed);
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Duration: ${fmtMs(Date.now() - startTime)}`);
  console.log(`  Health: ${healthOk ? 'PASS' : 'FAIL'} (paywallReady=${paywallReady})`);
  console.log(`  Receipts: ${receiptsCount}`);
  console.log(`  Purchase: ${purchaseResult ?? 'none'}`);
  if (purchaseDetail) console.log(`  Detail: ${purchaseDetail}`);
  console.log('════════════════════════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
