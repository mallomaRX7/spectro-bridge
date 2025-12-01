const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { logger } = require('../utils/logger');
const { parseSpectralOutput, parseConsoleOutput } = require('./parser');
const config = require('../utils/config');

/**
 * Wrapper for ArgyllCMS spotread command-line tool
 * Maintains a persistent spotread process after calibration for fast measurements
 * Supports both software-triggered and hardware button-triggered measurements
 */
class SpotreadWrapper extends EventEmitter {
  constructor() {
    super();
    this.spotreadPath = this.findSpotread();
    this.tempDir = path.join(os.tmpdir(), 'spectro-bridge');
    
    // Persistent process state
    this.expectProcess = null;
    this.isCalibrated = false;
    this.outputBuffer = '';
    this.pendingResolve = null;
    this.pendingReject = null;
    this.scriptPath = null;
    this.measurementPending = false;
    this.hardwareMeasurementPending = false;
    
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Find spotread executable using configured ArgyllCMS path
   */
  findSpotread() {
    const argyllPath = config.getArgyllPath();
    
    if (!argyllPath) {
      logger.warn('No ArgyllCMS path configured, trying system PATH');
      return 'spotread';
    }

    const isWindows = os.platform() === 'win32';
    const executable = isWindows ? 'spotread.exe' : 'spotread';
    const spotreadPath = path.join(argyllPath, executable);

    logger.info(`Using ArgyllCMS path: ${spotreadPath}`);
    return spotreadPath;
  }

  /**
   * Test if spotread executable is installed and accessible
   */
  async testConnection() {
    try {
      logger.info('SpotreadWrapper: Checking if spotread executable exists');
      logger.info(`SpotreadWrapper: Checking path: ${this.spotreadPath}`);
      
      fs.accessSync(this.spotreadPath, fs.constants.X_OK);
      
      logger.info('SpotreadWrapper: spotread executable found and is executable');
      return true;
    } catch (error) {
      logger.error(`SpotreadWrapper: spotread not found at: ${this.spotreadPath}`);
      logger.error(`SpotreadWrapper: Error: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if we have an active calibrated session
   */
  hasActiveSession() {
    return this.expectProcess !== null && this.isCalibrated;
  }

  /**
   * Generate expect script for persistent session with hardware button monitoring
   * Uses fileevent for reliable stdin handling instead of non-blocking polling
   */
  generatePersistentExpectScript() {
    return `#!/usr/bin/expect -f
set timeout 60
log_user 1

# Start spotread
spawn ${this.spotreadPath} -c 1 -s

# Wait for calibration prompt
expect {
  -re "hit any key|Place instrument|press any key|any key to continue|calibration position|white reference" {
    puts "CALIBRATION_PROMPT_DETECTED"
    send "\\r"
  }
  timeout {
    puts "EXPECT_TIMEOUT: waiting for calibration prompt"
    exit 1
  }
}

# Wait for calibration to complete
expect {
  -re "Calibration complete" {
    puts "CALIBRATION_COMPLETE"
  }
  -re "Calibration failed|Hardware Failure" {
    puts "CALIBRATION_FAILED"
    exit 1
  }
  timeout {
    puts "EXPECT_TIMEOUT: waiting for calibration complete"
    exit 1
  }
}

# Wait for ready to measure prompt
expect {
  -re "Place instrument on spot|any other key to take a reading|key to read" {
    puts "READY_FOR_MEASUREMENT"
  }
  timeout {
    puts "EXPECT_TIMEOUT: waiting for measurement ready"
    exit 1
  }
}

# Track if software triggered the measurement
set software_triggered 0

# Handler for stdin commands - using fileevent for reliable reading
proc handle_stdin {} {
  global software_triggered spawn_id
  
  if {[eof stdin]} {
    puts "STDIN_CLOSED"
    send "q"
    expect eof
    exit 0
  }
  
  gets stdin cmd
  set cmd [string trim \$cmd]
  
  if {\$cmd eq "MEASURE"} {
    puts "SOFTWARE_TRIGGERING_MEASUREMENT"
    set software_triggered 1
    send "\\r"
  } elseif {\$cmd eq "QUIT"} {
    puts "QUITTING"
    send "q"
    expect eof
    exit 0
  }
}

# Set up event-driven stdin reading
fconfigure stdin -blocking 0 -buffering line
fileevent stdin readable handle_stdin

# Background pattern matching for measurement results
expect_background {
  -re "(Result is XYZ:\\s*\[0-9.\\-\\]+\\s+\[0-9.\\-\\]+\\s+\[0-9.\\-\\]+.*?D50 Lab:\\s*\[0-9.\\-\\]+\\s+\[0-9.\\-\\]+\\s+\[0-9.\\-\\]+)" {
    global software_triggered
    
    if {\$software_triggered} {
      puts "SOFTWARE_MEASUREMENT_DETECTED"
      set software_triggered 0
    } else {
      puts "HARDWARE_MEASUREMENT_DETECTED"
    }
    puts "MEASUREMENT_RESULT_START"
    puts \$expect_out(1,string)
    
    # Continue matching for spectral data
    exp_continue
  }
  
  -re "(Spectrum from.*?)\\n(.*?)\\n\\s*(any other key|key to read|Place instrument)" {
    puts "SPECTRAL_DATA:"
    puts \$expect_out(1,string)
    puts \$expect_out(2,string)
    puts "MEASUREMENT_RESULT_END"
    puts "READY_FOR_MEASUREMENT"
  }
  
  -re "(any other key|key to read|Place instrument on spot)" {
    # Ready prompt without spectral (might be after result)
    if {[string match "*Result is*" \$expect_out(buffer)]} {
      puts "MEASUREMENT_RESULT_END"
    }
    puts "READY_FOR_MEASUREMENT"
  }
}

# Keep the script running with event loop
vwait forever
`;
  }

  /**
   * Start persistent spotread session and calibrate
   */
  async startSessionAndCalibrate() {
    if (this.expectProcess) {
      logger.warn('Session already exists, stopping it first');
      await this.stopSession();
    }

    logger.info('Starting persistent spotread session with hardware button monitoring');

    return new Promise((resolve, reject) => {
      // Write expect script to temp file
      this.scriptPath = path.join(this.tempDir, `spotread_persistent_${Date.now()}.exp`);
      
      try {
        fs.writeFileSync(this.scriptPath, this.generatePersistentExpectScript(), { mode: 0o755 });
        logger.info(`Created persistent expect script: ${this.scriptPath}`);
      } catch (err) {
        reject(new Error(`Failed to write expect script: ${err.message}`));
        return;
      }

      this.outputBuffer = '';
      this.isCalibrated = false;
      let serialNumber = null;
      let calibrationComplete = false;
      let readyForMeasurement = false;

      this.expectProcess = spawn('/usr/bin/expect', ['-f', this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timeoutId = setTimeout(() => {
        if (!calibrationComplete) {
          logger.error('Calibration timeout');
          this.stopSession();
          reject(new Error('Calibration timeout'));
        }
      }, 60000);

      this.expectProcess.stdout.on('data', (data) => {
        const text = data.toString();
        this.outputBuffer += text;
        logger.info(`expect stdout: ${text.substring(0, 500)}`);

        // Parse serial number from spotread output
        const serialMatch = text.match(/(?:Serial|S\/N)[:\s]+([A-Z0-9-]+)/i);
        if (serialMatch) {
          serialNumber = serialMatch[1];
          logger.info(`Parsed serial number: ${serialNumber}`);
        }

        // Check for calibration complete
        if (text.includes('CALIBRATION_COMPLETE')) {
          calibrationComplete = true;
          logger.info('Calibration complete detected');
        }

        // Check for ready for measurement
        if (text.includes('READY_FOR_MEASUREMENT') && !readyForMeasurement) {
          readyForMeasurement = true;
          this.isCalibrated = true;
          clearTimeout(timeoutId);
          logger.info('Session ready for measurements');
          
          // Start continuous monitoring for hardware button presses
          this.startHardwareButtonMonitoring();
          
          resolve({
            success: true,
            deviceInfo: { serialNumber }
          });
        }

        // Check for hardware-triggered measurement
        if (text.includes('HARDWARE_MEASUREMENT_DETECTED')) {
          logger.info('Hardware button press detected!');
          this.handleHardwareMeasurement();
        }

        // Handle measurement results (both software and hardware triggered)
        this.handleMeasurementOutput(text);
      });

      this.expectProcess.stderr.on('data', (data) => {
        const text = data.toString();
        this.outputBuffer += text;
        logger.info(`expect stderr: ${text.substring(0, 300)}`);
      });

      this.expectProcess.on('error', (error) => {
        clearTimeout(timeoutId);
        logger.error(`Process error: ${error.message}`);
        this.cleanup();
        reject(error);
      });

      this.expectProcess.on('close', (code) => {
        clearTimeout(timeoutId);
        logger.info(`Persistent process exited with code ${code}`);
        
        if (!readyForMeasurement) {
          const hasTimeout = this.outputBuffer.includes('EXPECT_TIMEOUT');
          this.cleanup();
          
          if (hasTimeout) {
            reject(new Error('Calibration failed: timeout waiting for prompt'));
          } else {
            reject(new Error(`Calibration failed: process exited with code ${code}`));
          }
        } else {
          this.cleanup();
        }
      });
    });
  }

  /**
   * Start monitoring for hardware button presses
   */
  startHardwareButtonMonitoring() {
    logger.info('Hardware button monitoring active');
    // The expect script handles this continuously via expect_background
  }

  /**
   * Handle hardware-triggered measurement
   */
  handleHardwareMeasurement() {
    // Will be parsed when MEASUREMENT_RESULT_END is detected
    this.hardwareMeasurementPending = true;
  }

  /**
   * Handle measurement output from expect script
   */
  handleMeasurementOutput(text) {
    // Track hardware vs software measurement
    if (text.includes('HARDWARE_MEASUREMENT_DETECTED')) {
      logger.info('=== Hardware button press detected ===');
      this.hardwareMeasurementPending = true;
    }
    if (text.includes('SOFTWARE_MEASUREMENT_DETECTED')) {
      logger.info('=== Software measurement detected ===');
      this.hardwareMeasurementPending = false;
    }

    // Check if this is the end of a measurement result
    if (text.includes('MEASUREMENT_RESULT_END')) {
      const isHardware = this.hardwareMeasurementPending;
      this.hardwareMeasurementPending = false;
      
      // Find the measurement data in the buffer between START and END markers
      const resultStartIndex = this.outputBuffer.lastIndexOf('MEASUREMENT_RESULT_START');
      const resultEndIndex = this.outputBuffer.lastIndexOf('MEASUREMENT_RESULT_END');
      
      if (resultStartIndex >= 0 && resultEndIndex > resultStartIndex) {
        const measurementOutput = this.outputBuffer.substring(resultStartIndex, resultEndIndex);
        
        logger.info('=== RAW MEASUREMENT OUTPUT ===');
        logger.info(measurementOutput);
        logger.info('=== END RAW OUTPUT ===');
        
        // Parse the spectral data
        const spectralData = parseConsoleOutput(measurementOutput);
        
        logger.info('=== PARSED SPECTRAL DATA ===');
        logger.info(`XYZ: ${JSON.stringify(spectralData?.XYZ)}`);
        logger.info(`Lab: ${JSON.stringify(spectralData?.Lab)}`);
        logger.info(`Spectral points: ${spectralData?.spectral ? Object.keys(spectralData.spectral).length : 0}`);
        
        if (isHardware) {
          // Emit event for hardware-triggered measurement
          logger.info('Emitting hardware-triggered measurement event');
          this.emit('hardware-measurement', spectralData);
        } else if (this.pendingResolve) {
          // Resolve software-triggered measurement promise
          logger.info('Resolving software measurement promise');
          this.pendingResolve(spectralData);
          this.pendingResolve = null;
          this.pendingReject = null;
          this.measurementPending = false;
        }
      } else {
        logger.warn('Could not find measurement markers in buffer');
        logger.info(`Buffer length: ${this.outputBuffer.length}`);
        logger.info(`Last 500 chars: ${this.outputBuffer.slice(-500)}`);
      }
    }
  }

  /**
   * Perform a measurement using the existing calibrated session
   */
  async measure(type = 'spot') {
    if (!this.hasActiveSession()) {
      throw new Error('No active calibrated session. Call calibrate() first.');
    }

    if (this.measurementPending) {
      throw new Error('Measurement already in progress');
    }

    logger.info('Triggering software measurement in persistent session');

    return new Promise((resolve, reject) => {
      this.measurementPending = true;
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      
      const measurementStartIndex = this.outputBuffer.length;

      const timeoutId = setTimeout(() => {
        if (this.measurementPending) {
          this.measurementPending = false;
          this.pendingResolve = null;
          this.pendingReject = null;
          logger.error('Measurement timeout');
          reject(new Error('Measurement timeout'));
        }
      }, 60000);

      // Set up fallback result checker
      const checkForResult = () => {
        if (!this.measurementPending) {
          clearTimeout(timeoutId);
          return;
        }
        
        const newOutput = this.outputBuffer.substring(measurementStartIndex);
        
        // Check for measurement result (fallback if handleMeasurementOutput didn't catch it)
        if (newOutput.includes('MEASUREMENT_RESULT_END') || 
            (newOutput.includes('Result is') && newOutput.includes('READY_FOR_MEASUREMENT'))) {
          
          if (this.measurementPending) {
            this.measurementPending = false;
            clearTimeout(timeoutId);
            
            logger.info('=== MEASUREMENT OUTPUT ===');
            logger.info(newOutput);
            
            const spectralData = parseConsoleOutput(newOutput);
            
            if (this.pendingResolve) {
              this.pendingResolve(spectralData);
              this.pendingResolve = null;
              this.pendingReject = null;
            }
          }
          return;
        }

        // Check for timeout marker
        if (newOutput.includes('MEASUREMENT_TIMEOUT')) {
          this.measurementPending = false;
          clearTimeout(timeoutId);
          if (this.pendingReject) {
            this.pendingReject(new Error('Measurement timeout from spotread'));
            this.pendingResolve = null;
            this.pendingReject = null;
          }
          return;
        }

        // Keep checking
        setTimeout(checkForResult, 100);
      };

      // Send MEASURE command to stdin
      if (this.expectProcess && this.expectProcess.stdin) {
        this.expectProcess.stdin.write('MEASURE\n');
        logger.info('Sent MEASURE command');
        
        // Start checking for result
        setTimeout(checkForResult, 500);
      } else {
        clearTimeout(timeoutId);
        this.measurementPending = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        reject(new Error('Process stdin not available'));
      }
    });
  }

  /**
   * Calibrate the device - starts a new session
   */
  async calibrate() {
    logger.info('Starting calibration (new persistent session)');
    return this.startSessionAndCalibrate();
  }

  /**
   * Stop the persistent session
   */
  async stopSession() {
    if (!this.expectProcess) {
      logger.info('No session to stop');
      return;
    }

    logger.info('Stopping persistent session');

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        logger.warn('Force killing process');
        if (this.expectProcess) {
          this.expectProcess.kill('SIGKILL');
        }
        this.cleanup();
        resolve();
      }, 5000);

      this.expectProcess.on('close', () => {
        clearTimeout(timeoutId);
        this.cleanup();
        resolve();
      });

      // Send QUIT command
      if (this.expectProcess.stdin) {
        this.expectProcess.stdin.write('QUIT\n');
        logger.info('Sent QUIT command');
      } else {
        this.expectProcess.kill();
      }
    });
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.expectProcess = null;
    this.isCalibrated = false;
    this.outputBuffer = '';
    this.measurementPending = false;
    this.hardwareMeasurementPending = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    
    // Clean up script file
    if (this.scriptPath) {
      try {
        fs.unlinkSync(this.scriptPath);
        logger.info(`Cleaned up script: ${this.scriptPath}`);
      } catch (e) {}
      this.scriptPath = null;
    }
  }
}

module.exports = { SpotreadWrapper };
