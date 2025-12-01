const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Handles WebSocket messages from clients
 */
class MessageHandler {
  constructor(deviceManager, calibrationManager) {
    this.deviceManager = deviceManager;
    this.calibrationManager = calibrationManager;
  }

  async handle(message) {
    const { type, requestId } = message;

    try {
      switch (type) {
        case 'device:status':
          return await this.handleDeviceStatus(requestId);

        case 'device:list':
          return await this.handleDeviceList(requestId);

        case 'calibration:start':
          return await this.handleCalibrationStart(requestId);

        case 'measurement:trigger':
          return await this.handleMeasurementTrigger(message);

        case 'bridge:info':
          return this.handleBridgeInfo(requestId);

        default:
          return {
            type: 'error',
            requestId,
            error: {
              code: 'UNKNOWN_MESSAGE_TYPE',
              message: `Unknown message type: ${type}`
            }
          };
      }
    } catch (error) {
      logger.error(`Error handling ${type}:`, error);
      return {
        type: 'error',
        requestId,
        error: {
          code: error.message.includes('DEVICE_NOT') ? error.message.split(':')[0] : 'INTERNAL_ERROR',
          message: error.message
        }
      };
    }
  }

  async handleDeviceStatus(requestId) {
    const device = this.deviceManager.getActiveDevice();

    if (!device) {
      return {
        type: 'device:status:response',
        requestId,
        device: {
          connected: false
        }
      };
    }

    const status = device.getStatus();

    return {
      type: 'device:status:response',
      requestId,
      device: {
        connected: true,
        ...status
      }
    };
  }

  async handleDeviceList(requestId) {
    const devices = this.deviceManager.getAllDevices();

    return {
      type: 'device:list:response',
      requestId,
      devices
    };
  }

  async handleCalibrationStart(requestId) {
    const device = this.deviceManager.getActiveDevice();

    if (!device) {
      throw new Error('DEVICE_NOT_CONNECTED: No device available');
    }

    // Start calibration asynchronously
    device.calibrate()
      .then((result) => {
        // Broadcast success
        logger.info('Calibration complete:', result);
      })
      .catch((error) => {
        logger.error('Calibration failed:', error);
      });

    return {
      type: 'calibration:started',
      requestId,
      message: 'Calibration started - place device on white calibration tile'
    };
  }

  async handleMeasurementTrigger(message) {
    const { requestId, measurementType = 'spot', modes = ['M0', 'M1', 'M2'] } = message;

    const device = this.deviceManager.getActiveDevice();

    if (!device) {
      throw new Error('DEVICE_NOT_CONNECTED: No device available');
    }

    // Check calibration
    const status = device.getStatus();
    if (!status.calibration.calibrated) {
      throw new Error('DEVICE_NOT_CALIBRATED: Device requires calibration');
    }

    try {
      const result = await device.measure({ measurementType, modes });

      return {
        type: 'measurement:result',
        requestId,
        source: 'software',
        ...result
      };
    } catch (error) {
      logger.error('Measurement failed:', error);
      throw error;
    }
  }

  /**
   * Get hardware measurement handler for broadcasting to WebSocket clients
   * Call this to set up the listener after WebSocket server is ready
   */
  setupHardwareMeasurementBroadcast(broadcastFn) {
    this.deviceManager.on('measurement:completed', (data) => {
      if (data.source === 'hardware') {
        logger.info('Broadcasting hardware-triggered measurement to WebSocket clients');
        broadcastFn({
          type: 'measurement:completed',
          ...data
        });
      }
    });
  }

  handleBridgeInfo(requestId) {
    return {
      type: 'bridge:info:response',
      requestId,
      bridge: {
        version: '1.0.0',
        supportedDevices: ['X-Rite i1Pro', 'X-Rite i1Pro2', 'X-Rite i1Pro3'],
        supportedModes: ['M0', 'M1', 'M2'],
        capabilities: {
          multiModeMeasurement: true,
          scanning: true
        }
      }
    };
  }
}

module.exports = { MessageHandler };
