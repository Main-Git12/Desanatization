import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, getAddress, parseAbi, formatUnits } = require('viem');
const { baseSepolia } = require('viem/chains');
const { CdpClient } = require('@coinbase/cdp-sdk');
const { x402Client, x402HTTPClient, wrapFetchWithPayment } = require('@x402/fetch');
const { ExactEvmScheme } = require('@x402/evm/exact/client');

const API_KEY_ID = '7cf18579-62ee-40ab-87e9-9f4199e4ec42';
const API_KEY_SECRET = 'xEKp9BAFkgprZaLnx5N7c4AEkZ2TZq/ZjufvXcwgyGR9ns56/rbcho8dCARm7UuMUyJGHZfKtKvgeLvoRHXTjA=';

const cdp = new CdpClient({ apiKeyId: API_KEY_ID, apiKeySecret: API_KEY_SECRET });

// Generate a new EOA
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
const walletAddr = account.address;

console.log('=== New Wallet ===');
console.log('Address:', walletAddr);
console.log('Private key:', privateKey);

// Request test USDC from CDP faucet for this wallet
console.log('\n=== Requesting test USDC ===');
try {
  const r = await cdp.evm.requestFaucet({
    token: 'usdc',
    network: 'base-sepolia',
    address: walletAddr,
  });
  console.log('Faucet tx:', r.transactionHash);
} catch (e) {
  console.log('Faucet error:', e.message);
}

// Check balance
console.log('\n=== Checking balances ===');
const client = createPublicClient({ chain: baseSepolia, transport: http() });

const USDC_ADDR = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

try {
  await new Promise(r => setTimeout(r, 15000)); // Wait for tx to be mined
  const [bal, dec] = await Promise.all([
    client.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddr] }),
    client.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  console.log(`USDC: ${formatUnits(bal, Number(dec))} USDC`);
} catch(e) { console.log('USDC check error:', e.message); }

try {
  const ethBal = await client.getBalance({ address: walletAddr });
  console.log(`ETH: ${formatUnits(ethBal, 18)} ETH`);
} catch(e) { console.log('ETH check error:', e.message); }

// Now make the x402 payment
console.log('\n=== x402 Payment to test server ===');
const resourceUrl = 'http://localhost:3001/api/resource';
const text = 'Contact me at test@example.com, SSN 078-05-1120, card 4111-1111-1111-1111';
const url = `${resourceUrl}?text=${encodeURIComponent(text)}`;

try {
  // Create x402 client
  const xClient = new x402Client();
  xClient.setSpendControls({ maxAmountPerPayment: '$0.10' });
  xClient.register('eip155:*', new ExactEvmScheme(account));

  const fetchWithPayment = wrapFetchWithPayment(fetch, xClient);
  const httpClient = new x402HTTPClient(xClient);

  console.log('Making payment...');
  const response = await fetchWithPayment(url, { method: 'GET' });
  const result = await httpClient.processResponse(response);
  console.log('Status:', result.status);
  console.log('Payment:', result.paymentStatus);
  console.log('Body:', JSON.stringify(result.body).substring(0, 500));
  if (result.header) {
    console.log('Receipt:', JSON.stringify(result.header, null, 2));
  }
} catch (e) {
  console.log('Payment error:', e.message || e);
  if (e.cause) console.log('Cause:', e.cause.message);
}
