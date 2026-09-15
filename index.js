import express from 'express';
import { x402HTTPResourceServer, x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const app = express();

const startServer = async () => {
  // Use the exact server private key directly so it NEVER changes or generates a random one
  // (Paste your 66-character hex private key here)
  const serverPrivateKey = process.env.PRIVATE_KEY || 'YOUR_HARDCODED_66_CHAR_PRIVATE_KEY_HERE';

  // 1. Initialize the facilitator and resource server
  const facilitatorClient = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' });
  const resourceServer = new x402ResourceServer(facilitatorClient);

  // Register your payment scheme with the persistent private key
  resourceServer.register('eip155:*', new ExactEvmScheme({
    privateKey: serverPrivateKey,
  }));

  await resourceServer.initialize();

  // 2. Define routes properly with the required 'network' and 'scheme' fields
  const routes = {
    'GET /api/resource': {
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          price: '1000000', // 1 USDC
          payTo: '0x0da67e4e8d7e631f1acc39d1e92da67a9e6226c3', // Your payout address
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

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`x402 payment server running on port ${port}`);
  });
};

startServer().catch((error) => {
  console.error('Failed to start x402 server:', error);
  process.exit(1);
});
