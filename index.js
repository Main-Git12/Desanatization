import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();
app.use(express.json());

// 1. Initialize core ResourceServer directly without HTTP facilitator validation wrappers
const server = new ResourceServer();
server.register('eip155:8453', new ExactEvmScheme());

// 2. Protect your endpoint with route-mapped payment requirements
app.get(
  '/api/premium-data',
  paymentMiddleware(
    {
      'GET /api/premium-data': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.01',
            network: 'eip155:8453',
            payTo: process.env.WALLET_ADDRESS || '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3',
          },
        ],
        description: 'Premium Data API Access',
        mimeType: 'application/json',
      },
    },
    server
  ),
  (req, res) => {
    res.json({
      success: true,
      message: 'Paid content unlocked on Base Mainnet!',
    });
  }
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`x402 Payment Server running on port ${PORT}`);
});
