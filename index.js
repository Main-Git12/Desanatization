import express from 'express';

const app = express();
app.use(express.json());

// Express route implementing the /api/v1/resource endpoint with x402 payment challenge
app.post('/api/v1/resource', (req, res) => {
  const { service_name, endpoint_url, protocol, network, currency, pricing_per_request } = req.body;

  // Validate incoming broadcast payload
  if (!service_name || !endpoint_url || !protocol || !network || !currency || !pricing_per_request) {
    return res.status(400).json({
      success: false,
      message: "Invalid request: missing required broadcast fields."
    });
  }

  // Check for settlement headers (x402 protocol)
  const paymentHeader = req.headers['authorization'] || req.headers['x-payment'];
  if (!paymentHeader) {
    return res.status(402)
      .setHeader('PAYMENT-REQUIRED', JSON.stringify({
        network,
        currency,
        amount: pricing_per_request,
        payTo: process.env.WALLET_ADDRESS || "0xYourWalletAddress"
      }))
      .json({
        success: false,
        payment_required: true,
        payment_network: network,
        payment_currency: currency,
        message: "402 Payment Required: Settle micro-transaction via Base Mainnet USDC."
      });
  }

  // Process successful authenticated request
  return res.status(200).json({
    success: true,
    message: "Broadcast accepted and agent routing index updated.",
    resource_id: `res_${Date.now()}`,
    payment_required: false,
    payment_network: network,
    payment_currency: currency
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
