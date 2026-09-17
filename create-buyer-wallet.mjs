import { CdpClient } from '@coinbase/cdp-sdk';

const client = new CdpClient({
  apiKeyId: '7cf18579-62ee-40ab-87e9-9f4199e4ec42',
  apiKeySecret: 'xEKp9BAFkgprZaLnx5N7c4AEkZ2TZq/ZjufvXcwgyGR9ns56/rbcho8dCARm7UuMUyJGHZfKtKvgeLvoRHXTjA=',
});

console.log('1. Listing accounts...');
try {
  const accounts = await client.accounts.listAccounts();
  console.log('Accounts:', JSON.stringify(accounts, null, 2));

  if (accounts?.accounts && accounts.accounts.length > 0) {
    for (const acc of accounts.accounts) {
      console.log(`\nAccount: ${acc.id} (${acc.name || 'unnamed'})`);
      console.log('Address:', acc.address?.address || 'N/A');
      console.log('Blockchain:', acc.address?.blockchain || 'N/A');

      const balances = await client.accounts.listBalances(acc.id);
      console.log('Balances:', JSON.stringify(balances, null, 2));
    }
  } else {
    console.log('No accounts found. Creating one...');
    const newAccount = await client.evm.createAccount({
      name: 'x402-buyer-base',
      blockchain: 'base',
    });
    console.log('New account:', JSON.stringify(newAccount, null, 2));
  }
} catch (e) {
  console.log('Error listing accounts:', e.message || e);
}

// Try EVM accounts
console.log('\n2. Listing EVM accounts...');
try {
  const evmAccounts = await client.evm.listAccounts();
  console.log('EVM accounts:', JSON.stringify(evmAccounts, null, 2));
} catch (e) {
  console.log('Error listing EVM accounts:', e.message || e);
}

// Try requesting testnet faucet (won't work for mainnet but worth checking)
console.log('\n3. Requesting faucet...');
try {
  const faucet = await client.evm.requestFaucet({
    token: 'usdc',
    blockchain: 'base',
  });
  console.log('Faucet response:', JSON.stringify(faucet, null, 2));
} catch (e) {
  console.log('Faucet error:', e.message || e);
}
