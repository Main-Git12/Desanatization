import express from 'express';
import { x402Server, paymentMiddleware } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

// 1. Initialize the x402 payment server framework
const x402 = new x402Server({
  // Register the exact EVM payment scheme
  schemes: {
    exact: new ExactEvmScheme(),
  },
});

// 2. Define your monetization rules for the premium route
const paymentConfig = {
  // Required payment amount (e.g., 0.01 USDC = 10000 units with 6 decimals)
  amount: '10000', 
  // Official Base Mainnet USDC Contract Address
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 
  // Your live mainnet wallet address to receive funds
  payTo: '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3', 
  // Target network: Base Mainnet
  network: 'eip155:8453', 
  maxTimeoutSeconds: 300,
};

// 3. Protect your endpoint with the x402 payment middleware
app.get('/api/premium-data', paymentMiddleware(x402, paymentConfig), (req, res) => {
  res.json({
    success: true,
    message: 'Paid content unlocked on Base Mainnet!',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
