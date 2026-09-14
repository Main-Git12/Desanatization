import express from 'express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

const evmScheme = new ExactEvmScheme();

// Helper to encode payment requirements into the v2 PAYMENT-REQUIRED base64 header
const createPaymentRequiredHeader = (config) => {
  const payload = {
    x402Version: 2,
    accepts: config.accepts,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

// Properly structured payment requirements for @x402/fetch v2 client
const paymentConfig = {
  accepts: [
    {
      scheme: 'exact',
      price: '$0.01',
      network: 'eip155:8453',
      amount: '10000', // Explicit atomic unit string for 0.01 USDC (6 decimals)
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
    },
  ],
  amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
  network: 'eip155:8453',
};

app.get('/api/premium-data', async (req, res) => {
  const paymentSignature = req.headers['payment-signature'] || req.headers['x-402-payment'] || req.headers['authorization'];

  if (!paymentSignature) {
    const base64Requirements = createPaymentRequiredHeader(paymentConfig);
    res.setHeader('PAYMENT-REQUIRED', base64Requirements);
    return res.status(402).json({
      error: 'Payment Required',
      message: 'Please provide a valid payment signature via the PAYMENT-SIGNATURE header.'
    });
  }

  try {
    const isValid = await evmScheme.verify(paymentSignature, paymentConfig);
    if (isValid) {
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true })).toString('base64'));
      return res.json({
        success: true,
        message: 'Paid content unlocked on Base Mainnet!',
      });
    } else {
      return res.status(402).json({ error: 'Invalid payment signature' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Payment verification failed', details: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
