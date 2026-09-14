import express from 'express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';

const app = express();
app.use(express.json());

// Initialize the facilitator client pointing to your live facilitator URL
// (Defaults to environment variable or standard remote facilitator endpoint)
const facilitatorUrl = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Initialize the core x402 resource server
const server = new x402ResourceServer(facilitatorClient);

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'x402 micro-settlement server is active',
    facilitator: facilitatorUrl 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
