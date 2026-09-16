import { createCdpAuthHeaders } from './cdp-auth.js';

const keyId = process.env.CDP_API_KEY_ID;
const keySecret = process.env.CDP_API_KEY_SECRET;
const headers = await createCdpAuthHeaders({ keyId, keySecret, baseUrl: 'https://api.cdp.coinbase.com/platform/v2/x402' });

// 1. Bazaar - list our resources
const bazaar = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/bazaar', { headers: headers.bazaar });
const bz = await bazaar.json();
console.log('Bazaar status:', bazaar.status);
console.log('Bazaar:', JSON.stringify(bz, null, 2).substring(0, 1500));

// 2. List wallets via CDP API
const wallets = await fetch('https://api.cdp.coinbase.com/platform/v1/wallets', { headers: headers.bazaar });
const w = await wallets.text();
console.log('\nWallets status:', wallets.status);
console.log('Wallets:', w.substring(0, 1500));