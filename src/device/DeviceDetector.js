const EventEmitter = require('events');
const { usb } = require('usb');
const { logger } = require('../utils/logger');

/**
 * Detects USB device connection/disconnection events
 * 
 * IMPORTANT: This class uses hotplug events ONLY - no initial device enumeration.
 * getDeviceList() creates persistent USB handles that conflict with spotread's
 * exclusive device access on macOS. Users must connect devices AFTER app launch
 * or unplug/reconnect if already connected.
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
    if (this.monitoring) {
      logger.warn('Device detector already monitoring');
      return;
    }

    logger.info('Starting USB device monitoring (hotplug only)...');
    logger.info('node-usb loaded successfully');
    
    // Set up USB event listeners for hotplug ONLY
    // NOTE: No initial device scan - devices must be connected AFTER app starts
    // or unplugged and reconnected if already connected.
    // This is REQUIRED to avoid USB handle conflicts with spotread on macOS.
    usb.on('attach', this._onAttach);
    usb.on('detach', this._onDetach);

    this.monitoring = true;
    
    logger.info('USB monitoring started - connect/reconnect device to detect');
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
