const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, dialog } = require('electron');
const { logger } = require('./logger');

/**
 * Certificate installer utility for macOS
 * Automatically trusts the localhost SSL certificate on first run
 */
class CertificateInstaller {
  constructor() {
    this.platform = os.platform();
  }

  /**
   * Get the path to the localhost certificate
   */
  getCertPath() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'certs', 'localhost.crt');
    }
    return path.join(__dirname, '../../certs/localhost.crt');
  }

  /**
   * Check if certificate file exists
   */
  certExists() {
    const certPath = this.getCertPath();
    return fs.existsSync(certPath);
  }

  /**
   * Check if certificate is already trusted (macOS only)
   */
  async isCertTrusted() {
    if (this.platform !== 'darwin') {
      return true; // Skip on non-macOS
    }

    const certPath = this.getCertPath();
    
    return new Promise((resolve) => {
      exec(`security verify-cert -c "${certPath}" 2>&1`, (error, stdout, stderr) => {
        // If verify-cert succeeds or shows cert is trusted, return true
        const output = stdout + stderr;
        if (!error || output.includes('CSSMERR_TP_NOT_TRUSTED') === false) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * Install certificate to system keychain (macOS only)
   * Returns true if installed, false if user cancelled
   */
  async installCertificate() {
    if (this.platform !== 'darwin') {
      logger.info('Certificate auto-install only supported on macOS');
      return true;
    }

    if (!this.certExists()) {
      logger.error('Certificate file not found');
      return false;
    }

    const certPath = this.getCertPath();
    logger.info(`Installing certificate from: ${certPath}`);

    // Show dialog explaining what we're about to do
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'SSL Certificate Installation',
      message: 'Spectro Bridge needs to install a local SSL certificate',
      detail: 'This allows secure WebSocket connections from your browser.\n\nYou may be prompted for your administrator password.\n\nThis is a one-time setup.',
      buttons: ['Install Certificate', 'Skip (Manual Setup Required)'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 1) {
      logger.info('User skipped certificate installation');
      return false;
    }

    return new Promise((resolve) => {
      // Use osascript to get admin privileges for adding to System Keychain
      const command = `osascript -e 'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \\"${certPath}\\"" with administrator privileges'`;
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          logger.error('Certificate installation failed:', error.message);
          logger.error('stderr:', stderr);
          
          // Show error dialog with manual instructions
          dialog.showMessageBox({
            type: 'error',
            title: 'Certificate Installation Failed',
            message: 'Could not automatically install the certificate',
            detail: `Please install manually:\n\n1. Open Keychain Access\n2. Drag this file to System keychain:\n${certPath}\n3. Double-click the certificate\n4. Set "Trust" to "Always Trust"`,
            buttons: ['OK']
          });
          
          resolve(false);
        } else {
          logger.info('Certificate installed successfully');
          dialog.showMessageBox({
            type: 'info',
            title: 'Certificate Installed',
            message: 'SSL certificate installed successfully',
            detail: 'You can now connect securely from your browser.',
            buttons: ['OK']
          });
          resolve(true);
        }
      });
    });
  }

  /**
   * Check and install certificate if needed
   * Call this during app initialization
   */
  async ensureCertificateTrusted() {
    if (this.platform !== 'darwin') {
      logger.info('Skipping certificate check on non-macOS platform');
      return true;
    }

    logger.info('Checking if SSL certificate is trusted...');
    
    const isTrusted = await this.isCertTrusted();
    
    if (isTrusted) {
      logger.info('Certificate is already trusted');
      return true;
    }

    logger.info('Certificate not trusted, attempting installation...');
    return await this.installCertificate();
  }
}

module.exports = { CertificateInstaller };
