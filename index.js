import express from 'express';
import { x402ResourceServer } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

// 1. Define routes using the HTTP method prefix and 'accepts' block
const routes = {
  'GET /api/resource': {
    accepts: {
      scheme: 'exact',
      price: config.price || '$0.001',
      network: config.network || 'base-sepolia',
      payTo: config.payToAddress,
    },
    description: 'Protected API Resource',
    mimeType: 'application/json',
  },
};

// 2. Initialize the underlying resource server and the HTTP server wrapper
const resourceServer = new x402ResourceServer();
const httpServer = new x402HTTPResourceServer(resourceServer, routes);

// 3. Attach payment middleware
app.get('/api/resource', paymentMiddleware(httpServer, routes), (req, res) => {
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