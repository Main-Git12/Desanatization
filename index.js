import express from 'express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

const evmScheme = new ExactEvmScheme();

// Explicitly use your verified public receiving wallet address
const RECEIVING_WALLET = '0x8324a7cb4e8bfc8CfD0dEA921d4451324D4E1bda';

const createPaymentRequiredHeader = (config) => {
  const payload = {
    x402Version: 2,
    paymentRequirements: config.accepts,
    accepts: config.accepts,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
};

const paymentConfig = {
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000', // 0.01 USDC (6 decimals)
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC Contract
      payTo: RECEIVING_WALLET,
    },
  ],
};

app.get('/api/premium-data', async (req, res) => {
  const paymentSignature = req.headers['payment-signature'] || req.headers['x-402-payment'] || req.headers['authorization'];

  if (!paymentSignature) {
    const base64Requirements = createPaymentRequiredHeader(paymentConfig);
    res.setHeader('PAYMENT-REQUIRED', base64Requirements);
    return res.status(402).json({
      x402Version: 2,
      paymentRequirements: paymentConfig.accepts,
      accepts: paymentConfig.accepts,
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
