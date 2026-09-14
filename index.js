import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { 
  x402HTTPResourceServer, 
  x402ResourceServer, 
  HTTPFacilitatorClient 
} from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createLogger } from './logger.js';
import { loadConfig } from './config.js';

dotenv.config();

const logger = createLogger('x402-server');
const config = loadConfig();
const app = express();

// ============================================================================
// Middleware
// ============================================================================

app.use(cors({
  origin: config.allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ============================================================================
// Health Check Endpoint
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============================================================================
// Initialize x402 Server
// ============================================================================

const startServer = async () => {
  let resourceServer;
  let httpServer;

  try {
    // 1. Initialize the facilitator and resource server
    logger.info('Initializing facilitator client...');
    const facilitatorClient = new HTTPFacilitatorClient({ 
      url: config.facilitatorUrl 
    });
    
    resourceServer = new x402ResourceServer(facilitatorClient);

    // Register payment scheme
    logger.info('Registering EVM payment scheme...');
    resourceServer.register('eip155:*', new ExactEvmScheme());

    await resourceServer.initialize();
    logger.info('Resource server initialized successfully');

    // 2. Define routes with payment configuration
    const routes = {
      'GET /api/resource': {
        accepts: [
          {
            scheme: 'exact',
            network: config.network,
            price: config.price,
            payTo: config.payToAddress,
          },
        ],
        description: 'Protected paid endpoint requiring x402 payment',
      },
    };

    // 3. Create HTTP server and bind payment middleware to Express
    httpServer = new x402HTTPResourceServer(resourceServer, routes);
    app.use(paymentMiddlewareFromHTTPServer(httpServer));

    // Protected resource endpoint
    app.get('/api/resource', (req, res, next) => {
      try {
        res.json({ 
          success: true, 
          data: 'Protected content accessed successfully!',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        next(error);
      }
    });

    // ========================================================================
    // Error Handling Middleware
    // ========================================================================

    app.use((err, req, res, next) => {
      logger.error(`Error: ${err.message}`, err);
      
      const statusCode = err.statusCode || 500;
      const message = config.environment === 'production' 
        ? 'Internal server error' 
        : err.message;

      res.status(statusCode).json({
        error: message,
        requestId: req.id,
        timestamp: new Date().toISOString()
      });
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ 
        error: 'Not found',
        path: req.path 
      });
    });

    // ========================================================================
    // Start Server
    // ========================================================================

    const server = app.listen(config.port, config.host, () => {
      logger.info(`x402 payment server running on ${config.host}:${config.port}`);
      logger.info(`Environment: ${config.environment}`);
      logger.info(`Facilitator: ${config.facilitatorUrl}`);
    });

    // ========================================================================
    // Graceful Shutdown
    // ========================================================================

    const gracefulShutdown = (signal) => {
      logger.info(`${signal} signal received: closing HTTP server`);
      
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start x402 server', error);
    process.exit(1);
  }
};

// Start the server
startServer();
