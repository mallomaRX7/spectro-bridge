const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Get proper logs directory in user data folder
const logsDir = path.join(app.getPath('userData'), 'logs');

// Ensure logs directory exists
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch (err) {
  console.error('Failed to create logs directory:', err);
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (stack) {
      log += `\n${stack}`;
    }
    return log;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'spectro-bridge.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'errors.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    })
  ]
});

module.exports = { logger };
