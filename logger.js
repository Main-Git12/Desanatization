// ============================================================================
// Logger Utility
// Provides structured logging for the application
// ============================================================================

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function createLogger(namespace) {
  const logLevel = process.env.LOG_LEVEL || 'info';
  const currentLogLevel = LOG_LEVELS[logLevel] ?? LOG_LEVELS.info;

  const formatTimestamp = () => new Date().toISOString();

  const formatMessage = (level, message) => {
    return `[${formatTimestamp()}] [${level.toUpperCase()}] [${namespace}] ${message}`;
  };

  return {
    error: (message, error = null) => {
      if (currentLogLevel >= LOG_LEVELS.error) {
        console.error(formatMessage('error', message));
        if (error) {
          console.error(error);
        }
      }
    },

    warn: (message) => {
      if (currentLogLevel >= LOG_LEVELS.warn) {
        console.warn(formatMessage('warn', message));
      }
    },

    info: (message) => {
      if (currentLogLevel >= LOG_LEVELS.info) {
        console.log(formatMessage('info', message));
      }
    },

    debug: (message, data = null) => {
      if (currentLogLevel >= LOG_LEVELS.debug) {
        console.debug(formatMessage('debug', message));
        if (data) {
          console.debug(data);
        }
      }
    },
  };
}
