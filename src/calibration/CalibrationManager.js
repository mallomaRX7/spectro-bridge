const { CalibrationStore } = require('./calibrationStore');
const { logger } = require('../utils/logger');

/**
 * Manages calibration state for devices
 */
class CalibrationManager {
  constructor() {
    this.store = new CalibrationStore();
    this.calibrations = new Map(); // deviceId -> calibration data
    this.loadCalibrations();
  }

  loadCalibrations() {
    const stored = this.store.getAll();
    for (const [deviceId, calibration] of Object.entries(stored)) {
      this.calibrations.set(deviceId, calibration);
    }
    logger.info(`Loaded ${this.calibrations.size} calibration records from storage`);
  }

  setCalibration(deviceId, calibrationData) {
    const calibration = {
      calibrated: true,
      timestamp: calibrationData.timestamp,
      expiresAt: calibrationData.expiresAt
    };

    this.calibrations.set(deviceId, calibration);
    this.store.set(deviceId, calibration);
    
    logger.info(`Calibration set for device ${deviceId}`, calibration);
  }

  getCalibrationStatus(deviceId) {
    const calibration = this.calibrations.get(deviceId);
    
    if (!calibration) {
      return {
        calibrated: false,
        timestamp: null,
        expiresAt: null
      };
    }

    // Check if calibration has expired
    const now = new Date();
    const expiresAt = new Date(calibration.expiresAt);
    
    if (now > expiresAt) {
      return {
        calibrated: false,
        timestamp: calibration.timestamp,
        expiresAt: calibration.expiresAt,
        expired: true
      };
    }

    return {
      calibrated: true,
      timestamp: calibration.timestamp,
      expiresAt: calibration.expiresAt
    };
  }

  clearCalibration(deviceId) {
    this.calibrations.delete(deviceId);
    this.store.delete(deviceId);
    logger.info(`Calibration cleared for device ${deviceId}`);
  }

  clearAllCalibrations() {
    this.calibrations.clear();
    this.store.clear();
    logger.info('All calibrations cleared');
  }
}

module.exports = { CalibrationManager };
