import express from 'express';
import { x402HTTPResourceServer, x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();

// 1. Initialize the facilitator and resource server
const facilitatorClient = new HTTPFacilitatorClient({ url: 'https://facilitator.x402.org' });
const resourceServer = new x402ResourceServer(facilitatorClient);

// Register your payment scheme (e.g., EVM network family)
resourceServer.register('eip155:*', new ExactEvmScheme());

// 2. Define routes properly with the required 'network' and 'scheme' fields
const routes = {
  'GET /api/resource': {
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453', // Ensure network is explicitly defined here
        price: '1000000',       // Price in atomic units (e.g., USDC smallest unit)
        payTo: '0xYourWalletAddressHere',
      },
    ],
    description: 'Protected paid endpoint',
  },
};

// 3. Bind to Express
const httpServer = new x402HTTPResourceServer(resourceServer, routes);
app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get('/api/resource', (req, res) => {
  res.json({ success: true, data: 'Protected content accessed successfully!' });
});

app.listen(3000, () => {
  console.log('x402 payment server running on port 3000');
});
