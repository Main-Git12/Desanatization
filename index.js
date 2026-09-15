import express from 'express';
import { x402HTTPResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = express();
app.use(express.json());

// Initialize the resource server with schemes
const server = new x402HTTPResourceServer({
  schemes: config.schemes,
  paywall: config.paywall,
});

// Explicit route definition with empty extensions object required by x402 core validation
const routeConfig = {
  price: config.price,
  network: config.network,
  extensions: {},
};

const routes = {
  '/api/resource': routeConfig,
};

// Register route explicitly with the server instance
server.register('/api/resource', routeConfig);

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