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
   * Detect already-connected devices using spotread enumeration
   * This doesn't hold USB handles like getDeviceList() does
   */
  async detectDevicesWithSpotread() {
    logger.info('Detecting devices using spotread enumeration');
    
    const argyllPath = config.getArgyllPath();
    if (!argyllPath) {
      logger.warn('No ArgyllCMS path configured, skipping initial device detection');
      return;
    }
    
    const spotreadPath = path.join(argyllPath, 'spotread');
    
    return new Promise((resolve) => {
      // Start spotread and kill after 3 seconds to capture initial device output
      // macOS doesn't have timeout command, use exec with setTimeout kill
      const child = exec(`"${spotreadPath}" -c 1 2>&1`, { timeout: 5000 }, (error, stdout, stderr) => {
        const output = stdout + (stderr || '');
        
        logger.info('=== spotread detection output ===');
        logger.info(output.substring(0, 2000));
        
        // Parse serial number from calibration prompt: "S/N 1000294"
        const serialMatch = output.match(/S\/N\s+(\d+)/i);
        const serialNumber = serialMatch ? serialMatch[1] : null;
        
        if (serialNumber) {
          logger.info(`Detected serial number: ${serialNumber}`);
        }
        
        // Check if this is an i1Pro device
        if (output.includes('reflective white reference') || 
            output.includes('i1 Pro') || 
            output.includes('i1Pro')) {
          
          logger.info(`Detected i1Pro device, serial: ${serialNumber || 'unknown'}`);
          
          this.emit('device:attached', {
            vendorId: 0x0971,
            productId: 0x2001, // i1Pro2
            deviceAddress: 1,
            serialNumber: serialNumber
          });
        } else {
          logger.info('No supported devices found via spotread');
        }
        
        resolve();
      });
      
      // Kill spotread after 3 seconds - device info appears immediately
      setTimeout(() => {
        if (!child.killed) {
          logger.info('Killing spotread detection process after 3s');
          child.kill('SIGTERM');
        }
      }, 3000);
    });
  }
  
  /**
   * Helper to emit i1Pro device if detected
   */
  emitI1ProDevice(deviceName, portNumber = 1) {
    const nameLower = deviceName.toLowerCase();
    if (nameLower.includes('i1 pro') || nameLower.includes('i1pro')) {
      let productId = 0x2001; // Default i1Pro2
      if (nameLower.includes('pro 3')) {
        productId = 0x2007;
      } else if (nameLower === 'i1 pro' || nameLower.match(/i1\s*pro$/)) {
        productId = 0x2000;
      }
      
      logger.info(`Emitting device:attached for ${deviceName}`);
      this.emit('device:attached', {
        vendorId: 0x0971,
        productId,
        deviceAddress: portNumber
      });
      return true;
    }
    return false;
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
