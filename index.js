import express from 'express';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

// 1. Define the correct v2 route structure
const routes = {
  'GET /api/resource': {
    accepts: [
      {
        scheme: 'exact',
        price: config.price || '$0.001',
        network: config.network || 'base-sepolia',
        payTo: config.payToAddress,
      }
    ],
    description: 'Protected API Resource',
    mimeType: 'application/json',
  }
};

// 2. Initialize the base resource server
const resourceServer = new x402ResourceServer();

// 3. Let paymentMiddleware handle the HTTP wrapper natively
app.get('/api/resource', paymentMiddleware(resourceServer, routes), (req, res) => {
  res.json({
    status: 'success',
    message: 'Payment verified! Access granted to protected resource.',
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});