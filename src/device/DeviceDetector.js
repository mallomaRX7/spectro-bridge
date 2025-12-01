const EventEmitter = require('events');
const { usb, getDeviceList } = require('usb');
const { logger } = require('../utils/logger');

/**
 * Detects USB device connection/disconnection events
 * 
 * IMPORTANT: This class is careful to NOT hold references to USB Device objects
 * from getDeviceList(). Holding these references prevents spotread from accessing
 * the device exclusively on macOS.
 */
class DeviceDetector extends EventEmitter {
  constructor() {
    super();
    this.monitoring = false;
    this.paused = false;
    
    // Bind handlers so they can be removed/re-added
    this._onAttach = this._handleAttach.bind(this);
    this._onDetach = this._handleDetach.bind(this);
  }
  
  _handleAttach(device) {
    const vendorId = device.deviceDescriptor.idVendor;
    const productId = device.deviceDescriptor.idProduct;
    
    logger.debug('USB device attached:', {
      vendorId: `0x${vendorId.toString(16)}`,
      productId: `0x${productId.toString(16)}`
    });
    
    if (this.isSupportedDevice(vendorId, productId)) {
      // Emit only the minimal data, not the device object
      this.emit('device:attached', {
        vendorId,
        productId,
        deviceAddress: device.deviceAddress
      });
    }
  }
  
  _handleDetach(device) {
    const vendorId = device.deviceDescriptor.idVendor;
    const productId = device.deviceDescriptor.idProduct;
    
    logger.debug('USB device detached:', {
      vendorId: `0x${vendorId.toString(16)}`,
      productId: `0x${productId.toString(16)}`
    });
    
    this.emit('device:detached', {
      vendorId,
      productId,
      deviceAddress: device.deviceAddress
    });
  }

  async start() {
    console.log('DeviceDetector.start() called');
    
    if (this.monitoring) {
      console.log('DeviceDetector: Already monitoring, returning');
      logger.warn('Device detector already monitoring');
      return;
    }

    console.log('DeviceDetector: Starting USB device monitoring...');
    logger.info('Starting USB device monitoring...');
    logger.info('node-usb loaded successfully');
    
    // Set up USB event listeners for hotplug
    usb.on('attach', this._onAttach);
    usb.on('detach', this._onDetach);

    this.monitoring = true;
    
    // Perform initial device scan with immediate handle release
    // This allows detecting devices connected before app startup
    await this._initialDeviceScan();
    
    logger.info('USB monitoring started - ready for device connections');
  }

  /**
   * Scan for already-connected devices at startup
   * Uses a "scan and forget" approach - enumerate, emit events, release handles immediately
   */
  async _initialDeviceScan() {
    logger.info('Performing initial device scan...');
    
    try {
      // Small delay to let USB subsystem stabilize
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Temporarily disable hotplug to avoid double events
      usb.removeListener('attach', this._onAttach);
      
      // Get list of connected devices
      const devices = getDeviceList();
      logger.info(`Found ${devices.length} USB devices`);
      
      const supportedDevices = [];
      
      for (const device of devices) {
        const vendorId = device.deviceDescriptor.idVendor;
        const productId = device.deviceDescriptor.idProduct;
        
        if (this.isSupportedDevice(vendorId, productId)) {
          supportedDevices.push({
            vendorId,
            productId,
            deviceAddress: device.deviceAddress
          });
        }
      }
      
      logger.info(`Found ${supportedDevices.length} supported spectrophotometer(s)`);
      
      // CRITICAL: Release USB handles immediately to prevent conflicts with spotread
      // unrefHotplugEvents releases internal libusb handles
      if (typeof usb.unrefHotplugEvents === 'function') {
        usb.unrefHotplugEvents();
      }
      
      // Wait for handles to be released on macOS
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Re-enable hotplug events
      if (typeof usb.refHotplugEvents === 'function') {
        usb.refHotplugEvents();
      }
      
      // Re-add attach listener
      usb.on('attach', this._onAttach);
      
      // Now emit events for found devices (after handles are released)
      for (const deviceInfo of supportedDevices) {
        logger.info(`Emitting device:attached for ${deviceInfo.vendorId.toString(16)}:${deviceInfo.productId.toString(16)}`);
        this.emit('device:attached', deviceInfo);
      }
      
    } catch (error) {
      logger.error('Initial device scan failed:', error);
      // Ensure listener is re-added even on error
      if (!this._onAttach) return;
      usb.removeListener('attach', this._onAttach);
      usb.on('attach', this._onAttach);
    }
  }

  async stop() {
    if (!this.monitoring) return;
    
    logger.info('Stopping USB device monitoring...');
    usb.removeListener('attach', this._onAttach);
    usb.removeListener('detach', this._onDetach);
    
    // Allow Node.js to exit by unreferencing USB polling
    if (typeof usb.unrefHotplugEvents === 'function') {
      usb.unrefHotplugEvents();
    }
    
    this.monitoring = false;
  }

  /**
   * Pause USB monitoring to release device handles
   * Call this before running spotread
   */
  pause() {
    if (!this.monitoring || this.paused) return;
    
    logger.info('Pausing USB device monitoring (releasing USB handles)...');
    usb.removeListener('attach', this._onAttach);
    usb.removeListener('detach', this._onDetach);
    
    // Unref hotplug events to release libusb handles
    if (typeof usb.unrefHotplugEvents === 'function') {
      usb.unrefHotplugEvents();
    }
    
    this.paused = true;
  }

  /**
   * Resume USB monitoring after spotread completes
   */
  resume() {
    if (!this.monitoring || !this.paused) return;
    
    logger.info('Resuming USB device monitoring...');
    
    // Re-register hotplug events
    if (typeof usb.refHotplugEvents === 'function') {
      usb.refHotplugEvents();
    }
    
    // Re-add event listeners
    usb.on('attach', this._onAttach);
    usb.on('detach', this._onDetach);
    
    this.paused = false;
  }

  isSupportedDevice(vendorId, productId) {
    // X-Rite devices
    if (vendorId === 0x0971) {
      // i1Pro, i1Pro2, i1Pro3
      if ([0x2000, 0x2001, 0x2007].includes(productId)) {
        return true;
      }
    }

    // Add other vendors as support is added:
    // Techkon: 0x085C
    // etc.

    return false;
  }
}

module.exports = { DeviceDetector };
