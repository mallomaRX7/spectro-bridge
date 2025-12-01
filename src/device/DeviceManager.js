const EventEmitter = require('events');
const { DeviceDetector } = require('./DeviceDetector');
const { I1ProAdapter } = require('../adapters/I1ProAdapter');
const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Manages device lifecycle and adapter instances
 */
class DeviceManager extends EventEmitter {
  constructor(calibrationManager) {
    super();
    this.calibrationManager = calibrationManager;
    this.detector = new DeviceDetector();
    this.devices = new Map(); // deviceId -> adapter instance
    this.activeDeviceId = null;
    this.pendingConnections = new Set(); // Track devices currently being connected
    this.recentlyDetached = new Map(); // Track recently detached devices for debouncing
  }

  async startDetection() {
    console.log('DeviceManager.startDetection() called');
    logger.info('=== DeviceManager: Starting device detection ===');

    this.detector.on('device:attached', async (usbDevice) => {
      console.log('DeviceManager: device:attached event received:', usbDevice);
      logger.info('USB device attached:', usbDevice);
      await this.handleDeviceAttached(usbDevice);
    });

    this.detector.on('device:detached', (usbDevice) => {
      console.log('DeviceManager: device:detached event received:', usbDevice);
      logger.info('USB device detached:', usbDevice);
      this.handleDeviceDetached(usbDevice);
    });

    console.log('DeviceManager: Calling detector.start()...');
    await this.detector.start();
    console.log('DeviceManager: detector.start() completed');
    logger.info('=== DeviceManager: Device detection started ===');
  }

  async stopDetection() {
    logger.info('Stopping device detection...');
    await this.detector.stop();
    
    // Disconnect all devices
    for (const [deviceId, adapter] of this.devices.entries()) {
      await adapter.disconnect();
    }
    this.devices.clear();
  }

  /**
   * Generate a calibration key based on device identity (not USB address)
   * This ensures calibration persists across reconnects
   */
  getCalibrationKey(deviceInfo) {
    // Use serial number if available, otherwise use make_model
    const serial = deviceInfo.serialNumber && deviceInfo.serialNumber !== 'Unknown' 
      ? deviceInfo.serialNumber 
      : '';
    return `${deviceInfo.make}_${deviceInfo.model}_${serial}`.replace(/\s+/g, '_');
  }

  async handleDeviceAttached(usbDevice) {
    try {
      const deviceKey = `${usbDevice.vendorId}_${usbDevice.productId}_${usbDevice.deviceAddress}`;
      
      // Debounce: Ignore if this device was recently detached (within 3 seconds)
      const lastDetached = this.recentlyDetached.get(deviceKey);
      if (lastDetached && Date.now() - lastDetached < 3000) {
        logger.info(`DeviceManager: Ignoring rapid re-attach for ${deviceKey}`);
        this.recentlyDetached.delete(deviceKey);
        return;
      }
      
      // Skip if already connecting or connected
      if (this.pendingConnections.has(deviceKey)) {
        logger.info(`DeviceManager: Connection already in progress for ${deviceKey}`);
        return;
      }
      
      if (this.devices.has(deviceKey)) {
        logger.info(`DeviceManager: Device ${deviceKey} already connected`);
        return;
      }
      
      this.pendingConnections.add(deviceKey);
      
      logger.info('DeviceManager: handleDeviceAttached called with:', usbDevice);
      
      // Identify device type and create appropriate adapter
      const deviceInfo = this.identifyDevice(usbDevice);
      logger.info('DeviceManager: identifyDevice returned:', deviceInfo);
      
      if (!deviceInfo) {
        logger.debug('DeviceManager: Unknown device (VID: 0x' + usbDevice.vendorId.toString(16) + ', PID: 0x' + usbDevice.productId.toString(16) + '), ignoring');
        this.pendingConnections.delete(deviceKey);
        return;
      }

      logger.info(`DeviceManager: Identified device: ${deviceInfo.make} ${deviceInfo.model}`);

      let adapter;
      
      switch (deviceInfo.make) {
        case 'X-Rite':
          adapter = new I1ProAdapter(deviceInfo);
          break;
        default:
          logger.warn(`No adapter available for ${deviceInfo.make} ${deviceInfo.model}`);
          this.pendingConnections.delete(deviceKey);
          return;
      }

      logger.info(`Connecting to ${deviceInfo.make} ${deviceInfo.model}...`);
      await adapter.connect();
      logger.info(`Successfully connected to ${deviceInfo.make} ${deviceInfo.model}`);
      
      // Use USB-address-based ID for internal device tracking
      const deviceId = `${deviceInfo.make}_${deviceInfo.model}_${usbDevice.deviceAddress}`;
      this.devices.set(deviceId, adapter);
      
      // Set up listener for hardware-triggered measurements
      adapter.on('measurement:hardware-triggered', (data) => {
        logger.info('DeviceManager: Forwarding hardware-triggered measurement');
        this.emit('measurement:completed', {
          ...data,
          deviceId,
          source: 'hardware'
        });
      });
      
      // Remove from pending after successful connection
      this.pendingConnections.delete(deviceKey);
      
      // Set as active device if no active device
      if (!this.activeDeviceId) {
        this.activeDeviceId = deviceId;
      }

      // Check for existing calibration using serial-based key
      const calibrationKey = this.getCalibrationKey(deviceInfo);
      const calibrationStatus = this.calibrationManager.getCalibrationStatus(calibrationKey);
      
      // If there's a valid stored calibration, restore it to the adapter
      if (calibrationStatus.calibrated && !calibrationStatus.expired) {
        logger.info(`Found existing calibration for ${calibrationKey}, restoring...`);
        adapter.calibrationTimestamp = calibrationStatus.timestamp;
        adapter.calibrationExpiresAt = calibrationStatus.expiresAt;
        // Note: The actual spotread session will need to be re-established on first measurement
        // but the calibration state is preserved for UI display
      }
      
      this.emit('device:connected', {
        deviceId,
        adapter,
        getInfo: () => adapter.getInfo(),
        getStatus: () => ({
          ...adapter.getStatus(),
          calibration: calibrationStatus
        })
      });
    } catch (error) {
      logger.error('Failed to handle device attachment:', error);
      // Remove from pending on error
      const deviceKey = `${usbDevice.vendorId}_${usbDevice.productId}_${usbDevice.deviceAddress}`;
      this.pendingConnections.delete(deviceKey);
    }
  }

  handleDeviceDetached(usbDevice) {
    const deviceKey = `${usbDevice.vendorId}_${usbDevice.productId}_${usbDevice.deviceAddress}`;
    
    // Track when this device was detached for debouncing
    this.recentlyDetached.set(deviceKey, Date.now());
    
    // Clean up old entries after 5 seconds
    setTimeout(() => this.recentlyDetached.delete(deviceKey), 5000);
    
    // Find and remove the device
    for (const [deviceId, adapter] of this.devices.entries()) {
      // Match by USB address or serial number
      if (adapter.deviceInfo.usbAddress === usbDevice.deviceAddress) {
        adapter.disconnect();
        this.devices.delete(deviceId);
        
        if (this.activeDeviceId === deviceId) {
          this.activeDeviceId = null;
        }
        
        this.emit('device:disconnected', deviceId);
        break;
      }
    }
  }

  identifyDevice(usbDevice) {
    const { vendorId, productId, serialNumber } = usbDevice;

    // X-Rite devices
    if (vendorId === 0x0971) {
      switch (productId) {
        case 0x2000:
          return {
            make: 'X-Rite',
            model: 'i1Pro',
            serialNumber: serialNumber || 'Unknown',
            firmwareVersion: 'Unknown',
            usbAddress: usbDevice.deviceAddress
          };
        case 0x2001:
          return {
            make: 'X-Rite',
            model: 'i1Pro2',
            serialNumber: serialNumber || 'Unknown',
            firmwareVersion: 'Unknown',
            usbAddress: usbDevice.deviceAddress
          };
        case 0x2007:
          return {
            make: 'X-Rite',
            model: 'i1Pro3',
            serialNumber: serialNumber || 'Unknown',
            firmwareVersion: 'Unknown',
            usbAddress: usbDevice.deviceAddress
          };
        default:
          return null;
      }
    }

    return null;
  }

  getActiveDevice() {
    if (!this.activeDeviceId) return null;
    
    const adapter = this.devices.get(this.activeDeviceId);
    if (!adapter) return null;

    const self = this;

    return {
      deviceId: this.activeDeviceId,
      adapter,
      getInfo: () => adapter.getInfo(),
      getStatus: () => {
        const calibrationKey = this.getCalibrationKey(adapter.deviceInfo);
        const calibrationStatus = this.calibrationManager.getCalibrationStatus(calibrationKey);
        return {
          ...adapter.getStatus(),
          calibration: calibrationStatus
        };
      },
      calibrate: async () => {
        // Pause USB monitoring to release device for spotread
        this.detector.pause();
        
        // Wait for USB handles to be released on macOS
        // Increased to 3s for more reliable release
        logger.info('Waiting 3s for USB handles to release...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        try {
          const result = await adapter.calibrate();
          
          // Store calibration using serial-based key (persists across reconnects)
          const calibrationKey = this.getCalibrationKey(adapter.deviceInfo);
          this.calibrationManager.setCalibration(calibrationKey, result);
          
          return result;
        } finally {
          // Always resume monitoring, even on error
          // Small delay to ensure spotread has fully released device
          await new Promise(resolve => setTimeout(resolve, 500));
          this.detector.resume();
        }
      },
      measure: async (options) => {
        // Check calibration before measurement
        const calibrationKey = this.getCalibrationKey(adapter.deviceInfo);
        const calibrationStatus = this.calibrationManager.getCalibrationStatus(calibrationKey);
        if (!calibrationStatus.calibrated) {
          throw new Error('DEVICE_NOT_CALIBRATED: Device requires calibration');
        }
        
        // Pause USB monitoring to release device for spotread
        this.detector.pause();
        
        // Wait for USB handles to be released on macOS
        // Increased to 3s for more reliable release
        logger.info('Waiting 3s for USB handles to release...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        try {
          const result = await adapter.measure(options);
          
          // Emit measurement:completed event for push notifications to web clients
          self.emit('measurement:completed', {
            measurementId: result.measurementId || uuidv4(),
            timestamp: result.timestamp || new Date().toISOString(),
            deviceId: self.activeDeviceId,
            measurementType: options.measurementType || 'spot',
            results: result.results
          });
          
          return result;
        } finally {
          await new Promise(resolve => setTimeout(resolve, 500));
          this.detector.resume();
        }
      }
    };
  }

  getAllDevices() {
    const devices = [];
    for (const [deviceId, adapter] of this.devices.entries()) {
      const calibrationKey = this.getCalibrationKey(adapter.deviceInfo);
      const calibrationStatus = this.calibrationManager.getCalibrationStatus(calibrationKey);
      devices.push({
        deviceId,
        ...adapter.getInfo(),
        capabilities: adapter.getCapabilities(),
        calibration: calibrationStatus,
        isActive: deviceId === this.activeDeviceId
      });
    }
    return devices;
  }

  setActiveDevice(deviceId) {
    if (this.devices.has(deviceId)) {
      this.activeDeviceId = deviceId;
      logger.info(`Active device set to: ${deviceId}`);
      return true;
    }
    return false;
  }
}

module.exports = { DeviceManager };
