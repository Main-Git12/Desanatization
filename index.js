import express from 'express';
import { x402ResourceServer } from '@x402/core/server';
import { ExactPaymentScheme } from '@x402/schemes/exact';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

// 1. Initialize base resource server and register exact payment scheme
const resourceServer = new x402ResourceServer();

// Register Exact scheme for base-sepolia
resourceServer.registerScheme(
  'base-sepolia',
  'exact',
  new ExactPaymentScheme({
    payTo: config.payToAddress,
  })
);

// 2. Define route structure with array in accepts
const routes = {
  'GET /api/resource': {
    accepts: [
      {
        scheme: 'exact',
        price: config.price || '$0.001',
        network: config.network || 'base-sepolia',
        payTo: config.payToAddress,
      },
    ],
    description: 'Protected API Resource',
    mimeType: 'application/json',
  },
};

// 3. Attach paymentMiddleware with registered resourceServer
app.use(paymentMiddleware(resourceServer, routes));

app.get('/api/resource', (req, res) => {
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