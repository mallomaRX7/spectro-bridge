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
      detail: 'This allows secure WebSocket connections from your browser.\n\nYou will be prompted for your administrator password twice:\n1. To remove any old certificate\n2. To install and trust the new certificate\n\nThis is a one-time setup.',
      buttons: ['Install Certificate', 'Skip (Manual Setup Required)'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response === 1) {
      logger.info('User skipped certificate installation');
      return false;
    }

    // Step 1: Remove any existing localhost certificate
    await this.removeExistingCertificate();

    // Step 2: Install the new certificate with trust
    return new Promise((resolve) => {
      // Use osascript to get admin privileges for adding to System Keychain with trust
      const command = `osascript -e 'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \\"${certPath}\\"" with administrator privileges'`;
      
      exec(command, async (error, stdout, stderr) => {
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
          
          // Step 3: Open browser to establish first-visit trust
          logger.info('Opening browser for initial certificate acceptance...');
          
          // Wait a moment for the server to be ready
          await new Promise(r => setTimeout(r, 1000));
          
          // Open the localhost URL in default browser
          shell.openExternal('https://localhost:9876');
          
          dialog.showMessageBox({
            type: 'info',
            title: 'Certificate Installed',
            message: 'SSL certificate installed successfully',
            detail: 'A browser window has opened to complete the setup.\n\nIf you see a security warning, click "Advanced" and "Proceed to localhost".\n\nYou can now connect securely from your browser.',
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
