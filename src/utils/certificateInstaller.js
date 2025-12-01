const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, dialog, shell } = require('electron');
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
   * Verifies both that the cert exists in keychain AND is set to Always Trust
   */
  async isCertTrusted() {
    if (this.platform !== 'darwin') {
      return true; // Skip on non-macOS
    }

    const certPath = this.getCertPath();
    
    return new Promise((resolve) => {
      // First check if cert exists in System keychain
      exec(`security find-certificate -c localhost /Library/Keychains/System.keychain 2>&1`, (error, stdout, stderr) => {
        if (error) {
          logger.info('Certificate not found in System keychain');
          resolve(false);
          return;
        }
        
        // Cert exists, now verify it's trusted
        exec(`security verify-cert -c "${certPath}" 2>&1`, (verifyError, verifyStdout, verifyStderr) => {
          const output = verifyStdout + verifyStderr;
          
          // Check for trust errors
          if (output.includes('CSSMERR_TP_NOT_TRUSTED') || 
              output.includes('CSSMERR_TP_CERT_NOT_VALID_YET') ||
              output.includes('CSSMERR_TP_CERT_EXPIRED')) {
            logger.info('Certificate exists but is not trusted');
            resolve(false);
          } else {
            logger.info('Certificate is trusted');
            resolve(true);
          }
        });
      });
    });
  }

  /**
   * Remove existing localhost certificate from System keychain
   */
  async removeExistingCertificate() {
    if (this.platform !== 'darwin') return;
    
    logger.info('Removing any existing localhost certificates...');
    
    return new Promise((resolve) => {
      // Use osascript with admin privileges to remove cert
      // The exit 0 ensures we don't fail if cert doesn't exist
      const removeCmd = `osascript -e 'do shell script "security delete-certificate -c localhost /Library/Keychains/System.keychain 2>/dev/null; exit 0" with administrator privileges'`;
      
      exec(removeCmd, (error, stdout, stderr) => {
        if (error) {
          // User cancelled or other error - that's OK, continue anyway
          logger.info('Certificate removal skipped or no existing cert');
        } else {
          logger.info('Existing certificate removed');
        }
        resolve();
      });
    });
  }

  /**
   * Install certificate to system keychain (macOS only)
   * Always removes existing certificate first to ensure clean install
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
      detail: 'This allows secure WebSocket connections from your browser.\n\nYou will be prompted for your administrator password to install and trust the certificate.\n\nThis is a one-time setup.',
      buttons: ['Install Certificate', 'Skip (Manual Setup Required)'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 1) {
      logger.info('User skipped certificate installation');
      return false;
    }

    // Step 1: Remove any existing localhost certificate
    logger.info('Removing any existing localhost certificates...');
    await new Promise((resolve) => {
      const removeCmd = `osascript -e 'do shell script "security delete-certificate -c localhost /Library/Keychains/System.keychain 2>/dev/null || true" with administrator privileges'`;
      exec(removeCmd, { timeout: 30000 }, () => resolve());
    });

    // Step 2: Add certificate with trust settings
    logger.info('Installing certificate with Always Trust...');
    return new Promise((resolve) => {
      const addCmd = `osascript -e 'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \\"${certPath}\\"" with administrator privileges'`;
      
      exec(addCmd, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          logger.error('Certificate installation failed:', error.message);
          logger.error('stderr:', stderr);
          
          dialog.showMessageBox({
            type: 'error',
            title: 'Certificate Installation Failed',
            message: 'Could not automatically install the certificate',
            detail: `Please install manually:\n\n1. Open Keychain Access\n2. Drag this file to System keychain:\n${certPath}\n3. Double-click the certificate\n4. Set "Trust" to "Always Trust"`,
            buttons: ['OK']
          });
          
          resolve(false);
        } else {
          logger.info('Certificate installed successfully with Always Trust');
          
          dialog.showMessageBox({
            type: 'info',
            title: 'Certificate Installed',
            message: 'SSL certificate installed successfully',
            detail: 'The certificate has been installed and set to Always Trust.\n\nA browser window will open shortly to complete the setup.',
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
   * Always ensures fresh certificate installation for reliability
   */
  async ensureCertificateTrusted() {
    if (this.platform !== 'darwin') {
      logger.info('Skipping certificate check on non-macOS platform');
      return true;
    }

    logger.info('Ensuring SSL certificate is properly installed...');
    
    const certPath = this.getCertPath();
    if (!this.certExists()) {
      logger.error('Certificate file not found');
      return false;
    }
    
    // Always try to install/update the certificate for reliability
    const installed = await this.installCertificate();
    
    if (installed) {
      // Open browser to establish first-visit trust
      logger.info('Opening browser for certificate acceptance...');
      setTimeout(() => {
        shell.openExternal('https://localhost:9876');
      }, 2000);
    }
    
    return installed;
  }
}

module.exports = { CertificateInstaller };
