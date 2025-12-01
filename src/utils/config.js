const Store = require('electron-store');
const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Application configuration
 */
class Config {
  constructor() {
    this.store = new Store({
      name: 'config',
      defaults: {
        argyll: {
          path: this.detectArgyllPath()
        },
        server: {
          port: 9876
        },
        calibration: {
          expiryHours: 8
        }
      }
    });
  }

  detectArgyllPath() {
    const platform = os.platform();
    
    switch (platform) {
      case 'darwin': {
        // Check for common ArgyllCMS versions (newest first)
        const versions = [
          'Argyll_V3.4.1', 'Argyll_V3.4.0', 'Argyll_V3.3.0', 
          'Argyll_V3.2.0', 'Argyll_V3.1.0', 'Argyll_V3.0.0',
          'Argyll_V2.3.1', 'ArgyllCMS'
        ];
        for (const ver of versions) {
          const testPath = `/Applications/${ver}/bin`;
          if (fs.existsSync(testPath)) {
            return testPath;
          }
        }
        // Try to find any Argyll folder dynamically
        try {
          const apps = fs.readdirSync('/Applications');
          const argyllFolder = apps.find(f => f.toLowerCase().startsWith('argyll'));
          if (argyllFolder) {
            const testPath = `/Applications/${argyllFolder}/bin`;
            if (fs.existsSync(testPath)) {
              return testPath;
            }
          }
        } catch (e) {
          // Ignore errors reading /Applications
        }
        return '';
      }
      case 'win32': {
        const versions = [
          'Argyll_V3.4.1', 'Argyll_V3.4.0', 'Argyll_V3.3.0',
          'Argyll_V3.2.0', 'Argyll_V3.1.0', 'Argyll_V3.0.0'
        ];
        for (const ver of versions) {
          const testPath = `C:\\Program Files\\${ver}\\bin`;
          if (fs.existsSync(testPath)) {
            return testPath;
          }
        }
        return '';
      }
      case 'linux':
        return '/usr/bin';
      default:
        return '';
    }
  }

  get(key) {
    return this.store.get(key);
  }

  set(key, value) {
    this.store.set(key, value);
  }

  getArgyllPath() {
    const cachedPath = this.get('argyll.path');
    // Re-detect if cached path doesn't exist
    if (cachedPath && !fs.existsSync(cachedPath)) {
      const newPath = this.detectArgyllPath();
      this.setArgyllPath(newPath);
      return newPath;
    }
    return cachedPath;
  }

  setArgyllPath(path) {
    this.set('argyll.path', path);
  }

  getServerPort() {
    return this.get('server.port');
  }

  getCalibrationExpiryHours() {
    return this.get('calibration.expiryHours');
  }
}

module.exports = new Config();
