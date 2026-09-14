// ============================================================================
// Configuration Loader
// Loads and validates environment variables
// ============================================================================

export function loadConfig() {
  const requiredEnvVars = [
    'FACILITATOR_URL',
    'PAY_TO_ADDRESS',
  ];

  const missingVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}\n` +
      'Please check your .env file or environment configuration.'
    );
  }

  const config = {
    // Server
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '0.0.0.0',
    environment: process.env.NODE_ENV || 'development',

    // CORS
    allowedOrigins: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
      : '*',

    // x402 Configuration
    facilitatorUrl: process.env.FACILITATOR_URL,
    payToAddress: process.env.PAY_TO_ADDRESS,
    network: process.env.NETWORK || 'eip155:84532',
    price: process.env.PRICE || '1000000',

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

// ============================================================================
// Configuration Validation
// ============================================================================

function validateConfig(config) {
  // Validate port
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid PORT: ${config.port}. Must be between 1 and 65535.`);
  }

  // Validate Ethereum address format
  if (!isValidEthereumAddress(config.payToAddress)) {
    throw new Error(
      `Invalid PAY_TO_ADDRESS: ${config.payToAddress}. ` +
      'Must be a valid Ethereum address (0x...)'
    );
  }

  // Validate URL format
  try {
    new URL(config.facilitatorUrl);
  } catch (error) {
    throw new Error(
      `Invalid FACILITATOR_URL: ${config.facilitatorUrl}. Must be a valid URL.`
    );
  }

  // Validate price is a positive number
  if (isNaN(config.price) || Number(config.price) < 0) {
    throw new Error(`Invalid PRICE: ${config.price}. Must be a positive number.`);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function isValidEthereumAddress(address) {
  if (!address) return false;
  // Check if it matches Ethereum address format: 0x followed by 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
