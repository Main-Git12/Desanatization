import express from 'express';
import { x402HTTPResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

// 1. Define routes with explicit empty extensions object
const routes = {
  '/api/resource': {
    price: config.price,
    network: config.network,
    extensions: {}, // Required by x402 route validation
  },
};

// 2. Instantiate server passing routes into constructor configuration
const server = new x402HTTPResourceServer({
  schemes: config.schemes,
  paywall: config.paywall,
  routes: routes,
});

app.get('/api/resource', paymentMiddleware(server, routes), (req, res) => {
  res.json({
    status: 'success',
    message: 'Payment verified! Access granted to protected resource.',
    timestamp: new Date().toISOString(),
  });
});

// 3. Bind explicitly to process.env.PORT and 0.0.0.0 for Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});