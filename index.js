import express from 'express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

const evmScheme = new ExactEvmScheme();

// Middleware that matches the protocol's expected 402 challenge structure
const x402ChallengeMiddleware = (config) => {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-402-payment'] || req.headers['authorization'];
    
    if (!paymentHeader) {
      // Return the official x402 protocol specification payload for 402
      return res.status(402).json({
        x402Version: 1,
        accepts: config.accepts,
      });
    }

    try {
      const isValid = await evmScheme.verify(paymentHeader, config);
      if (isValid) {
        return next();
      } else {
        return res.status(402).json({ error: 'Invalid payment signature' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Payment verification failed', details: err.message });
    }
  };
};

// Base Mainnet configuration matching client requirements
const paymentConfig = {
  accepts: [
    {
      scheme: 'exact',
      price: '$0.01',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
    },
  ],
  amount: '10000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
  network: 'eip155:8453',
};

app.get('/api/premium-data', x402ChallengeMiddleware(paymentConfig), (req, res) => {
  res.json({
    success: true,
    message: 'Paid content unlocked on Base Mainnet!',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
