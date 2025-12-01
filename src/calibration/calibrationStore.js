const Store = require('electron-store');

/**
 * Persistent storage for calibration data
 */
class CalibrationStore {
  constructor() {
    this.store = new Store({
      name: 'calibrations',
      defaults: {
        calibrations: {}
      }
    });
  }

  set(deviceId, calibrationData) {
    const calibrations = this.store.get('calibrations');
    calibrations[deviceId] = calibrationData;
    this.store.set('calibrations', calibrations);
  }

  get(deviceId) {
    const calibrations = this.store.get('calibrations');
    return calibrations[deviceId] || null;
  }

  getAll() {
    return this.store.get('calibrations');
  }

  delete(deviceId) {
    const calibrations = this.store.get('calibrations');
    delete calibrations[deviceId];
    this.store.set('calibrations', calibrations);
  }

  clear() {
    this.store.set('calibrations', {});
  }
}

module.exports = { CalibrationStore };
