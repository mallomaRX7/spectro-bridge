const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { logger } = require('../utils/logger');
const { MessageHandler } = require('./handlers');

/**
 * WebSocket server for browser communication with SSL support
 */
class SpectroWebSocketServer {
  constructor(port, deviceManager, calibrationManager) {
    this.port = port;
    this.deviceManager = deviceManager;
    this.calibrationManager = calibrationManager;
    this.wss = null;
    this.httpsServer = null;
    this.clients = new Set();
    this.messageHandler = new MessageHandler(deviceManager, calibrationManager);
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        // Try to load SSL certificates for WSS support
        // In packaged app, certs are in Resources/certs via extraResources
        // In development, certs are relative to source location
        const certPath = app.isPackaged 
          ? path.join(process.resourcesPath, 'certs')
          : path.join(__dirname, '../../certs');
        
        logger.info(`App is packaged: ${app.isPackaged}`);
        logger.info(`Looking for certificates in: ${certPath}`);
        
        const keyFile = path.join(certPath, 'localhost.key');
        const certFile = path.join(certPath, 'localhost.crt');

        if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
          // Use HTTPS/WSS with SSL certificates
          logger.info('SSL certificates found, starting secure WebSocket server (wss://)');
          
          this.httpsServer = https.createServer({
            key: fs.readFileSync(keyFile),
            cert: fs.readFileSync(certFile)
          }, (req, res) => {
            // Handle regular HTTP requests (for certificate trust in Safari)
            res.writeHead(200, { 
              'Content-Type': 'text/html',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Spectro Bridge</title></head>
              <body style="font-family: -apple-system, sans-serif; padding: 40px; text-align: center;">
                <h1>✅ Spectro Bridge is Running</h1>
                <p>The SSL certificate has been accepted.</p>
                <p>You can now close this tab and return to the ColorScores app.</p>
                <p style="color: #666; font-size: 14px;">WebSocket server: wss://localhost:9876</p>
              </body>
              </html>
            `);
          });

          this.wss = new WebSocket.Server({ server: this.httpsServer });

          this.httpsServer.listen(this.port, () => {
            logger.info(`Secure WebSocket server (wss://) listening on port ${this.port}`);
            resolve();
          });

          this.httpsServer.on('error', (error) => {
            logger.error('HTTPS server error:', error);
            reject(error);
          });
        } else {
          // Fall back to plain WebSocket (ws://) - works for local HTTP development
          logger.warn('SSL certificates not found, starting plain WebSocket server (ws://)');
          logger.warn(`Generate certificates by running: node scripts/generate-cert.js`);
          
          this.wss = new WebSocket.Server({ port: this.port });

          this.wss.on('listening', () => {
            logger.info(`WebSocket server (ws://) listening on port ${this.port}`);
            resolve();
          });
        }

        this.wss.on('connection', (ws, req) => {
          const clientIp = req.socket.remoteAddress;
          logger.info(`Client connected from ${clientIp}`);
          
          this.clients.add(ws);

          ws.on('message', async (data) => {
            try {
              const message = JSON.parse(data.toString());
              logger.debug('Received message:', message);

              const response = await this.messageHandler.handle(message);
              
              if (response) {
                ws.send(JSON.stringify(response));
              }
            } catch (error) {
              logger.error('Error handling message:', error);
              ws.send(JSON.stringify({
                type: 'error',
                error: {
                  code: 'INVALID_MESSAGE',
                  message: error.message
                }
              }));
            }
          });

          ws.on('close', () => {
            logger.info(`Client disconnected from ${clientIp}`);
            this.clients.delete(ws);
          });

          ws.on('error', (error) => {
            logger.error('WebSocket error:', error);
            this.clients.delete(ws);
          });

          // Send initial connection success
          ws.send(JSON.stringify({
            type: 'connection:success',
            message: 'Connected to Spectro Bridge'
          }));
        });

        // Set up hardware measurement broadcasting
        this.messageHandler.setupHardwareMeasurementBroadcast((message) => {
          this.broadcast(message);
        });

        this.wss.on('error', (error) => {
          logger.error('WebSocket server error:', error);
          reject(error);
        });
      } catch (error) {
        logger.error('Failed to start WebSocket server:', error);
        reject(error);
      }
    });
  }

  async stop() {
    if (!this.wss) return;

    return new Promise((resolve) => {
      // Close all client connections
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();

      // Close WebSocket server
      this.wss.close(() => {
        logger.info('WebSocket server stopped');
        
        // Also close HTTPS server if it exists
        if (this.httpsServer) {
          this.httpsServer.close(() => {
            logger.info('HTTPS server stopped');
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}

module.exports = { SpectroWebSocketServer };
