import express from 'express';
import { verifyTypedData, createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base } from 'viem/chains';

const app = express();
app.use(express.json());

const RECEIVING_WALLET = '0x8324a7cb4e8bfc8CfD0dEA921d4451324D4E1bda';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// In-memory nonce cache for replay protection
const usedNonces = new Set();

// Safely handle private key: use env var if present, otherwise generate or warn
let serverPrivateKey = process.env.SERVER_PRIVATE_KEY;
if (!serverPrivateKey || serverPrivateKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
  console.warn('WARNING: SERVER_PRIVATE_KEY not set or invalid. On-chain settlement will fail until funded/configured.');
  serverPrivateKey = generatePrivateKey(); // fallback to prevent startup crash
}

const serverAccount = privateKeyToAccount(serverPrivateKey);
const serverClient = createWalletClient({
  account: serverAccount,
  chain: base,
  transport: http('https://mainnet.base.org'),
}).extend(publicActions);

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

const paymentConfig = {
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000', // 0.01 USDC (6 decimals)
      asset: USDC_ADDRESS,
      payTo: RECEIVING_WALLET,
      extra: {
        name: 'USD Coin',
        version: '2',
      },
    },
  ],
};

const createPaymentRequiredHeader = (config) => {
  const payload = {
    x402Version: 2,
    paymentRequirements: config.accepts,
    accepts: config.accepts,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

app.get('/api/premium-data', async (req, res) => {
  const authHeader = req.headers['payment-signature'] || req.headers['x-402-payment'] || req.headers['authorization'];

  if (!authHeader) {
    const base64Requirements = createPaymentRequiredHeader(paymentConfig);
    res.setHeader('PAYMENT-REQUIRED', base64Requirements);
    return res.status(402).json({
      x402Version: 2,
      paymentRequirements: paymentConfig.accepts,
      accepts: paymentConfig.accepts,
    });
  }

  try {
    const decoded = JSON.parse(Buffer.from(authHeader, 'base64').toString('utf8'));
    const { signature, authorization } = decoded.payload;

    // 1. Replay Protection Check
    if (usedNonces.has(authorization.nonce)) {
      return res.status(400).json({ error: 'Nonce already used (replay attack prevented)' });
    }

    // 2. Cryptographic Signature Verification
    const isValid = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: USDC_ADDRESS,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature: signature,
    });

    const matchesRecipient = authorization.to.toLowerCase() === RECEIVING_WALLET.toLowerCase();
    const hasEnoughAmount = BigInt(authorization.value) >= BigInt(10000);
    const notExpired = BigInt(authorization.validBefore) > BigInt(Math.floor(Date.now() / 1000));

    if (!isValid || !matchesRecipient || !hasEnoughAmount || !notExpired) {
      return res.status(402).json({ error: 'Invalid payment details or signature' });
    }

    // 3. Execute On-Chain Settlement (Pull USDC into your wallet)
    console.log(`Executing on-chain settlement for nonce ${authorization.nonce}...`);
    const hash = await serverClient.writeContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: 'receiveWithAuthorization',
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        authorization.v,
        authorization.r,
        authorization.s,
      ],
    });

    await serverClient.waitForTransactionReceipt({ hash });
    console.log(`Settlement successful! Tx Hash: ${hash}`);

    // Mark nonce as used
    usedNonces.add(authorization.nonce);

    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, txHash: hash })).toString('base64'));
    return res.json({
      success: true,
      message: 'Paid content unlocked & USDC settled on Base Mainnet!',
      txHash: hash,
    });
  } catch (err) {
    console.error('Payment processing error:', err);
    return res.status(500).json({ error: 'Payment settlement failed', details: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Production x402 Payment Server running on port ${PORT}`);
});
