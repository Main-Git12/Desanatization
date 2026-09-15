import express from 'express';
import { verifyTypedData } from 'viem';

const app = express();
app.use(express.json());

const RECEIVING_WALLET = '0x8324a7cb4e8bfc8CfD0dEA921d4451324D4E1bda';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
    // Decode payment payload sent by client
    const decoded = JSON.parse(Buffer.from(authHeader, 'base64').toString('utf8'));
    const { signature, authorization } = decoded.payload;

    // Verify EIP-712 TransferWithAuthorization signature using viem
    const isValid = await verifyTypedData({
      address: authorization.from,
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453, // Base Mainnet
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

    // Validate payment terms (recipient, amount, and expiration)
    const matchesRecipient = authorization.to.toLowerCase() === RECEIVING_WALLET.toLowerCase();
    const hasEnoughAmount = BigInt(authorization.value) >= BigInt(10000);
    const notExpired = BigInt(authorization.validBefore) > BigInt(Math.floor(Date.now() / 1000));

    if (isValid && matchesRecipient && hasEnoughAmount && notExpired) {
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true })).toString('base64'));
      return res.json({
        success: true,
        message: 'Paid content unlocked on Base Mainnet!',
      });
    } else {
      return res.status(402).json({ error: 'Invalid payment details or signature' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Payment verification failed', details: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
