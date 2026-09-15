import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// Server-side wallet setup for executing the transaction (needs a small amount of ETH on Base for gas)
const serverAccount = privateKeyToAccount(process.env.SERVER_PRIVATE_KEY);
const serverClient = createWalletClient({
  account: serverAccount,
  chain: base,
  transport: http('https://mainnet.base.org'),
}).extend(publicActions);

// USDC ABI snippet for receiveWithAuthorization
const usdcAbi = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'receiveWithAuthorization',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];
