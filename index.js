import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

// 1. Connect to the official x402 facilitator client
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator', // or your chosen facilitator endpoint
});

// 2. Initialize the resource server and register the EVM scheme
const server = new x402ResourceServer(facilitatorClient);
server.register('eip155:*', new ExactEvmScheme());

// 3. Define monetization rules for Base Mainnet
const paymentConfig = {
  amount: '10000', // 0.01 USDC (6 decimals)
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet USDC
  payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
  network: 'eip155:8453', // Base Mainnet
  maxTimeoutSeconds: 300,
};

// 4. Protect your endpoint with the payment middleware
app.get('/api/premium-data', paymentMiddleware(server, paymentConfig), (req, res) => {
  res.json({
    success: true,
    message: 'Paid content unlocked on Base Mainnet!',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
