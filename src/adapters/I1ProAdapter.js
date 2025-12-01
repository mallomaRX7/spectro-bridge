const { BaseAdapter } = require('./BaseAdapter');
const { SpotreadWrapper } = require('../argyll/spotread');
const { FWACompensation } = require('../argyll/fwaCompensation');
const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Adapter for X-Rite i1Pro/i1Pro2/i1Pro3 devices using ArgyllCMS
 * Maintains a persistent spotread session after calibration for fast measurements
 * Supports both software-triggered and hardware button-triggered measurements
 */
class I1ProAdapter extends BaseAdapter {
  constructor(deviceInfo) {
    super(deviceInfo);
    this.spotread = new SpotreadWrapper();
    this.fwaCompensation = new FWACompensation();
    this.busy = false;
    this.calibrationTimestamp = null;
    this.calibrationExpiresAt = null;
    
    // Set up hardware measurement listener
    this.spotread.on('hardware-measurement', (spectralData) => {
      this.handleHardwareMeasurement(spectralData);
    });
  }

  /**
   * Handle hardware-triggered measurement (device button press)
   */
  handleHardwareMeasurement(spectralData) {
    logger.info('Processing hardware-triggered measurement');
    
    try {
      // Compute Lab/XYZ for all modes using FWA compensation
      const modes = ['M0', 'M1', 'M2'];
      const results = {};
      
      for (const mode of modes) {
        const computed = this.fwaCompensation.computeMode(spectralData, mode);
        results[mode] = {
          Lab: computed.Lab,
          XYZ: computed.XYZ,
          spectral: computed.spectral
        };
      }

      // Emit event for hardware-triggered measurement
      this.emit('measurement:hardware-triggered', {
        success: true,
        measurementId: uuidv4(),
        timestamp: new Date().toISOString(),
        measurementType: 'spot',
        source: 'hardware',
        results
      });
      
      logger.info('Hardware measurement processed and emitted');
    } catch (error) {
      logger.error('Failed to process hardware measurement:', error);
      this.emit('measurement:hardware-error', {
        error: error.message
      });
    }
  }

  async connect() {
    try {
      logger.info('I1ProAdapter: Checking spotread availability...');
      logger.info(`I1ProAdapter: Device info: ${JSON.stringify(this.deviceInfo)}`);
      
      // Test if spotread executable is available
      const isAvailable = await this.spotread.testConnection();
      
      if (!isAvailable) {
        throw new Error('ArgyllCMS spotread not found. Please install ArgyllCMS.');
      }
      
      this.connected = true;
      logger.info('I1ProAdapter: Successfully initialized - ready for calibration');
      this.emit('connected');
      
    } catch (error) {
      logger.error(`I1ProAdapter: Failed to initialize: ${error.message}`);
      throw error;
    }
  }

  async disconnect() {
    // Stop any active spotread session
    if (this.spotread.hasActiveSession()) {
      logger.info('I1ProAdapter: Stopping active spotread session');
      await this.spotread.stopSession();
    }
    
    this.connected = false;
    this.calibrationTimestamp = null;
    this.calibrationExpiresAt = null;
    logger.info(`Disconnected from ${this.deviceInfo.model}`);
    this.emit('disconnected');
  }

  /**
   * Check if calibration is still valid
   */
  isCalibrationValid() {
    if (!this.spotread.hasActiveSession()) {
      return false;
    }
    if (!this.calibrationExpiresAt) {
      return false;
    }
    return new Date() < new Date(this.calibrationExpiresAt);
  }

  async calibrate() {
    if (!this.connected) {
      throw new Error('Device not connected');
    }

    if (this.busy) {
      throw new Error('Device is busy');
    }

    try {
      this.busy = true;
      logger.info('Starting calibration...');
      
      this.emit('calibration:progress', { message: 'Place device on white calibration tile' });

      // Start new persistent session with calibration
      const result = await this.spotread.calibrate();
      
      // Update device info with serial number from spotread output
      if (result.deviceInfo?.serialNumber) {
        this.deviceInfo.serialNumber = result.deviceInfo.serialNumber;
        logger.info(`Updated device serial number: ${this.deviceInfo.serialNumber}`);
      }
      
      // Set calibration timestamps
      this.calibrationTimestamp = new Date().toISOString();
      this.calibrationExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8 hours
      
      logger.info('Calibration complete - session ready for measurements');
      return {
        success: true,
        serialNumber: this.deviceInfo.serialNumber,
        timestamp: this.calibrationTimestamp,
        expiresAt: this.calibrationExpiresAt
      };
    } catch (error) {
      logger.error('Calibration failed:', error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async measure(options) {
    if (!this.connected) {
      throw new Error('Device not connected');
    }

    if (this.busy) {
      throw new Error('Device is busy');
    }

    // Check for active calibrated session
    if (!this.spotread.hasActiveSession()) {
      throw new Error('Device not calibrated. Please calibrate before measuring.');
    }

    const { measurementType = 'spot', modes = ['M0', 'M1', 'M2'] } = options;

    try {
      this.busy = true;
      logger.info(`Starting ${measurementType} measurement for modes: ${modes.join(', ')}`);

      this.emit('measurement:progress', { message: 'Place device on sample' });

      // Perform measurement using existing calibrated session
      const spectralData = await this.spotread.measure(measurementType);

      // Compute Lab/XYZ for each requested mode using FWA compensation
      const results = {};
      
      for (const mode of modes) {
        if (mode === 'M3') {
          logger.warn('M3 mode requires physical polarizing filter - skipping');
          continue;
        }

        const computed = this.fwaCompensation.computeMode(spectralData, mode);
        results[mode] = {
          Lab: computed.Lab,
          XYZ: computed.XYZ,
          spectral: computed.spectral
        };
      }

      logger.info('Measurement complete');

      return {
        success: true,
        measurementId: uuidv4(),
        timestamp: new Date().toISOString(),
        measurementType,
        source: 'software',
        results
      };
    } catch (error) {
      logger.error('Measurement failed:', error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  getCapabilities() {
    const isDualPass = this.deviceInfo.model.includes('i1Pro2') || 
                       this.deviceInfo.model.includes('i1Pro3');

    return {
      supportedModes: ['M0', 'M1', 'M2'],
      hasDualPass: isDualPass,
      hasPhysicalFilters: false,
      spectralRange: {
        start: 380,
        end: 730,
        interval: 10
      },
      canMultiMode: true,
      supportsScanning: true,
      supportsHardwareButton: true
    };
  }

  getStatus() {
    return {
      connected: this.connected,
      calibrated: this.spotread.hasActiveSession(),
      calibrationTimestamp: this.calibrationTimestamp,
      calibrationExpiresAt: this.calibrationExpiresAt,
      ...this.getInfo(),
      capabilities: this.getCapabilities(),
      busy: this.busy
    };
  }
}

module.exports = { I1ProAdapter };
