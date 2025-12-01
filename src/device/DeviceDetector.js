const EventEmitter = require('events');
const { usb } = require('usb');
const { exec } = require('child_process');
const path = require('path');
const { logger } = require('../utils/logger');
const config = require('../utils/config');

/**
 * Detects USB device connection/disconnection events
 * 
 * Uses two detection methods:
 * 1. spotread -? at startup to detect already-connected devices
 * 2. USB hotplug events for devices connected after startup
 * 
 * This avoids getDeviceList() which creates USB handles that conflict
 * with spotread's exclusive device access on macOS.
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

  /**
   * Detect already-connected devices using spotread -?
   * This doesn't hold USB handles like getDeviceList() does
   */
  async detectDevicesWithSpotread() {
    logger.info('Detecting devices using spotread -?');
    
    const argyllPath = config.getArgyllPath();
    if (!argyllPath) {
      logger.warn('No ArgyllCMS path configured, skipping initial device detection');
      return;
    }
    
    const spotreadPath = path.join(argyllPath, 'spotread');
    
    return new Promise((resolve) => {
      // spotread -? lists available devices
      exec(`"${spotreadPath}" -? 2>&1`, { timeout: 10000 }, (error, stdout, stderr) => {
        const output = stdout + stderr;
        
        // Parse device list from output
        // Format: "N = 'usbXX: (Device Name)'" 
        // Example: "1 = 'usb17: (X-Rite i1 Pro 2)'"
        const devicePattern = /(\d+)\s*=\s*'[^']*\(([^)]+)\)'/g;
        let match;
        let foundDevices = 0;
        
        while ((match = devicePattern.exec(output)) !== null) {
          const portNumber = parseInt(match[1]);
          const deviceName = match[2];
          
          logger.info(`Found device via spotread: ${deviceName} (port ${portNumber})`);
          
          // Check if it's an i1Pro device
          if (deviceName.toLowerCase().includes('i1 pro') || 
              deviceName.toLowerCase().includes('i1pro')) {
            
            // Determine product ID from name
            let productId = 0x2001; // Default i1Pro2
            if (deviceName.includes('Pro 3') || deviceName.includes('Pro3')) {
              productId = 0x2007;
            } else if (deviceName === 'i1 Pro' || deviceName === 'i1Pro') {
              productId = 0x2000; // Original i1Pro
            }
            
            foundDevices++;
            logger.info(`Emitting device:attached for ${deviceName}`);
            this.emit('device:attached', {
              vendorId: 0x0971, // X-Rite vendor ID
              productId,
              deviceAddress: portNumber
            });
          }
        }
        
        if (foundDevices === 0) {
          logger.info('No supported devices found via spotread');
        } else {
          logger.info(`Found ${foundDevices} supported device(s)`);
        }
        
        resolve();
      });
    });
  }

  async start() {
    if (this.monitoring) {
      logger.warn('Device detector already monitoring');
      return;
    }

    logger.info('Starting USB device monitoring...');
    logger.info('node-usb loaded successfully');
    
    // Set up USB event listeners for hotplug events
    usb.on('attach', this._onAttach);
    usb.on('detach', this._onDetach);

    this.monitoring = true;
    
    // Detect already-connected devices using spotread
    // This doesn't hold USB handles like getDeviceList()
    await this.detectDevicesWithSpotread();
    
    logger.info('USB monitoring started');
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
