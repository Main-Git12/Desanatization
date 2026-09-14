import express from 'express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

// Initialize the exact EVM scheme handler directly
const evmScheme = new ExactEvmScheme();

// Custom lightweight middleware that validates the payment header locally
const localPaymentMiddleware = (config) => {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-402-payment'] || req.headers['authorization'];
    
    if (!paymentHeader) {
      // Return 402 Payment Required with the structured requirements for the client
      return res.status(402).json({
        error: 'Payment Required',
        accepts: config.accepts,
      });
    }

    try {
      // Verify payment details locally on-chain/via scheme
      const isValid = await evmScheme.verify(paymentHeader, config);
      if (isValid) {
        return next();
      } else {
        return res.status(402).json({ error: 'Invalid payment signature or amount' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Payment verification failed', details: err.message });
    }
  };
};

// Define payment configuration for Base Mainnet
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

// Protect the endpoint using our direct local validator
app.get('/api/premium-data', localPaymentMiddleware(paymentConfig), (req, res) => {
  res.json({
    success: true,
    message: 'Paid content unlocked on Base Mainnet!',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
