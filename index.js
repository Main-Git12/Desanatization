import express from 'express';
import { x402HTTPResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

const routeConfig = {
  price: config.price || '$0.001',
  network: config.network || 'base-sepolia',
  payTo: config.payToAddress,
  extensions: {},
};

const routes = {
  '/api/resource': routeConfig,
};

const server = new x402HTTPResourceServer({
  schemes: config.schemes || [],
  paywall: {
    payTo: config.payToAddress,
    routes: routes,
  },
  routes: routes,
});

app.get('/api/resource', paymentMiddleware(server, routes), (req, res) => {
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