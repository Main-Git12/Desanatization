import express from 'express';
import { paymentMiddleware } from '@x402/express';

const app = express();
app.use(express.json());

app.use(
  paymentMiddleware(
    process.env.WALLET_ADDRESS, // Use a valid environment variable identifier here
    {
      'POST /api/v1/resource': {
        accepts: [
          {
            scheme: 'exact',
            price: '$0.01',
            network: 'eip155:8453',
            currency: 'usdc'
          }
        ]
      }
    },
    {
      url: process.env.FACILITATOR_URL
    }
  )
);

app.post('/api/v1/resource', (req, res) => {
  const { service_name, endpoint_url, protocol, network, currency } = req.body;

  if (!service_name || !endpoint_url) {
    return res.status(400).json({
      success: false,
      message: "Missing required payload fields."
    });
  }

  return res.status(200).json({
    success: true,
    message: "Payment verified successfully on Base Mainnet.",
    resource_id: `res_${Date.now()}`,
    payment_required: false,
    payment_network: network || "eip155:8453",
    payment_currency: currency || "usdc"
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
