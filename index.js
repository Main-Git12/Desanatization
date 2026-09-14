import express from 'express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express'; // If using express middleware package

const app = express();
app.use(express.json());

// 1. Connect to the live public facilitator
const facilitatorUrl = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);

// 2. Define a monetized endpoint that charges $0.01 per request
app.get('/api/premium-data', 
  paymentMiddleware({
    accepts: {
      scheme: 'exact',
      price: '$0.01',
      network: 'eip155:8453', // Base Mainnet
      payTo: process.env.PAY_TO || '0xYourCryptoWalletAddress',
    },
    description: 'Access to premium monetization endpoint',
  }, server),
  (req, res) => {
    // This code only runs AFTER the client successfully pays!
    res.json({ 
      success: true, 
      message: 'Payment received! Here is your paid content.',
      data: { secret: 'Monetization pipeline is active and generating revenue.' }
    });
  }
);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'x402 micro-settlement server is live and ready for traffic.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
