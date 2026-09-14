# Desanatization - x402 Payment Server

A production-ready Express.js server that implements the x402 payment protocol for protecting resources behind blockchain-based payments.

## Features

- 🔐 **Blockchain Payment Integration**: Uses x402 protocol for Ethereum-based payments
- ⚡ **Express Middleware**: Seamless integration with Express.js
- 🛡️ **CORS Support**: Configurable CORS for cross-origin requests
- 📊 **Structured Logging**: Comprehensive logging with multiple levels
- ✅ **Configuration Validation**: Automatic validation of environment variables
- 🔄 **Graceful Shutdown**: Proper cleanup on process termination
- 🚀 **Production Ready**: Error handling, health checks, and signal handling

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Access to an x402 facilitator server
- An Ethereum wallet address for receiving payments

### Installation

1. Clone the repository:
```bash
git clone https://github.com/pealar12/Desanatization.git
cd Desanatization
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your actual values
```

4. Start the server:
```bash
npm start          # Production mode
npm run dev        # Development mode with auto-reload
```

## Configuration

All configuration is managed through environment variables in the `.env` file:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `HOST` | No | 0.0.0.0 | Server host |
| `NODE_ENV` | No | development | Environment (development/production) |
| `LOG_LEVEL` | No | info | Logging level (error/warn/info/debug) |
| `ALLOWED_ORIGINS` | No | * | Comma-separated CORS origins |
| `FACILITATOR_URL` | **Yes** | - | URL to x402 facilitator server |
| `NETWORK` | No | eip155:84532 | Ethereum network identifier |
| `PRICE` | No | 1000000 | Payment amount in Wei |
| `PAY_TO_ADDRESS` | **Yes** | - | Ethereum address to receive payments |

### Network Identifiers

Common Ethereum network identifiers (EIP-155):
- `eip155:1` - Ethereum Mainnet
- `eip155:11155111` - Ethereum Sepolia Testnet
- `eip155:84531` - Base Goerli Testnet
- `eip155:84532` - Base Sepolia Testnet
- `eip155:137` - Polygon Mainnet
- `eip155:80001` - Polygon Mumbai Testnet

## API Endpoints

### Health Check

```http
GET /health
```

Returns server status and uptime.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-09-14T21:30:00.000Z",
  "uptime": 120.5
}
```

### Protected Resource

```http
GET /api/resource
Authorization: Bearer <x402-payment-proof>
```

Access protected content after payment verification.

**Response (Success):**
```json
{
  "success": true,
  "data": "Protected content accessed successfully!",
  "timestamp": "2026-09-14T21:30:00.000Z"
}
```

**Response (Payment Required - 402):**
```json
{
  "error": "Payment required",
  "requestId": "req-123",
  "timestamp": "2026-09-14T21:30:00.000Z"
}
```

## Development

### Running Tests

```bash
npm test
```

Tests cover:
- Health check endpoint
- Protected resource access
- Payment validation
- Error handling
- Configuration validation

### Logging

Set `LOG_LEVEL` environment variable to control verbosity:

```bash
LOG_LEVEL=debug npm run dev
```

### Linting

```bash
npm run lint
```

## Deployment

### Docker

A Dockerfile can be used for containerized deployment. Key considerations:

1. Set `NODE_ENV=production`
2. Configure all required environment variables
3. Ensure the facilitator server is reachable
4. Set appropriate CORS origins

### Environment-Specific Configuration

**Development:**
- `NODE_ENV=development`
- `LOG_LEVEL=debug`
- `ALLOWED_ORIGINS=*` (for local testing)

**Production:**
- `NODE_ENV=production`
- `LOG_LEVEL=warn`
- `ALLOWED_ORIGINS=https://your-domain.com`
- Enable HTTPS
- Use strong Ethereum addresses

## Error Handling

The server implements comprehensive error handling:

- **Configuration Errors**: Server exits with clear error messages
- **HTTP Errors**: Returns appropriate status codes (400, 402, 404, 500)
- **Unhandled Rejections**: Logged and process exits cleanly
- **Uncaught Exceptions**: Logged and process exits immediately

## Graceful Shutdown

The server responds to:
- `SIGTERM` - Graceful shutdown with 10-second timeout
- `SIGINT` - Graceful shutdown with 10-second timeout

All in-flight requests are allowed to complete before shutdown.

## Security Considerations

1. **Always use HTTPS in production**
2. **Restrict CORS origins** to trusted domains
3. **Validate all inputs** before processing
4. **Keep dependencies updated** regularly
5. **Use environment variables** for sensitive data
6. **Monitor payment transactions** on-chain
7. **Implement rate limiting** for production

## Troubleshooting

### Server won't start

1. Check all required environment variables are set
2. Verify the facilitator server is running and reachable
3. Ensure the port is not already in use
4. Check logs for detailed error messages

### Payments not processing

1. Verify `PAY_TO_ADDRESS` is a valid Ethereum address
2. Check the `NETWORK` matches your payment network
3. Confirm the facilitator URL is correct
4. Review logs for payment processing errors

### CORS errors

1. Verify client origin is in `ALLOWED_ORIGINS`
2. Check that CORS middleware is properly configured
3. Ensure the client sends correct headers

## License

MIT

## Support

For issues and questions:
1. Check the troubleshooting section
2. Review server logs with `LOG_LEVEL=debug`
3. Open an issue on GitHub
