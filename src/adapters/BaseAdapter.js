const EventEmitter = require('events');

/**
 * Base adapter interface for spectrophotometer devices
 * All device adapters must extend this class and implement the required methods
 */
class BaseAdapter extends EventEmitter {
  constructor(deviceInfo) {
    super();
    this.deviceInfo = deviceInfo;
    this.connected = false;
  }

  /**
   * Connect to the device
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from the device
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Calibrate the device
   * @returns {Promise<Object>} Calibration result
   */
  async calibrate() {
    throw new Error('calibrate() must be implemented by subclass');
  }

  /**
   * Perform a measurement
   * @param {Object} options - Measurement options
   * @param {string} options.measurementType - 'spot' or 'scan'
   * @param {string[]} options.modes - Array of measurement modes ['M0', 'M1', 'M2']
   * @returns {Promise<Object>} Measurement results
   */
  async measure(options) {
    throw new Error('measure() must be implemented by subclass');
  }

  /**
   * Get device capabilities
   * @returns {Object} Device capabilities
   */
  getCapabilities() {
    throw new Error('getCapabilities() must be implemented by subclass');
  }

  /**
   * Get device information
   * @returns {Object} Device info
   */
  getInfo() {
    return {
      make: this.deviceInfo.make,
      model: this.deviceInfo.model,
      serialNumber: this.deviceInfo.serialNumber,
      firmwareVersion: this.deviceInfo.firmwareVersion
    };
  }

  /**
   * Get device connection status
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Check if device is currently busy
   * @returns {boolean}
   */
  isBusy() {
    return this.busy || false;
  }
}

module.exports = { BaseAdapter };
