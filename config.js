export function loadConfig() {
  const payToAddress = process.env.PAY_TO_ADDRESS;
  if (!payToAddress) {
    throw new Error('Missing required environment variables: PAY_TO_ADDRESS');
  }

  return {
    port: process.env.PORT || 3000,
    price: '$0.001',
    network: 'base-sepolia',
    payToAddress: payToAddress,
    schemes: [],
    paywall: {
      routes: {
        '/api/resource': {
          price: '$0.001',
          network: 'base-sepolia',
          extensions: {},
        },
      },
    },
  };
}