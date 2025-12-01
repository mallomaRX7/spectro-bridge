const { logger } = require('../utils/logger');

/**
 * Parse spotread spectral output file (.sp format)
 * @param {string} fileContent - Content of .sp file
 * @param {string} consoleOutput - Console output from spotread
 * @returns {Object} Parsed spectral data
 */
function parseSpectralOutput(fileContent, consoleOutput) {
  try {
    const spectral = {};
    const lines = fileContent.split('\n');
    
    let spectralSection = false;
    let wavelengths = [];
    let values = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (trimmed.startsWith('#') || trimmed === '') continue;
      
      // Look for spectral data section
      if (trimmed.startsWith('SPECTRAL_BANDS')) {
        spectralSection = true;
        continue;
      }
      
      if (spectralSection) {
        // Parse wavelength and value pairs
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const wavelength = parseFloat(parts[0]);
          const value = parseFloat(parts[1]);
          
          if (!isNaN(wavelength) && !isNaN(value)) {
            wavelengths.push(wavelength);
            values.push(value);
            spectral[wavelength.toString()] = value;
          }
        }
      }
    }
    
    // Parse Lab values from console output
    let Lab = null;
    let XYZ = null;
    
    const labMatch = consoleOutput.match(/D50\s+Lab:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/i);
    if (labMatch) {
      Lab = {
        L: parseFloat(labMatch[1]),
        a: parseFloat(labMatch[2]),
        b: parseFloat(labMatch[3])
      };
    }
    
    const xyzMatch = consoleOutput.match(/XYZ:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/i);
    if (xyzMatch) {
      XYZ = {
        X: parseFloat(xyzMatch[1]),
        Y: parseFloat(xyzMatch[2]),
        Z: parseFloat(xyzMatch[3])
      };
    }
    
    if (Object.keys(spectral).length === 0) {
      throw new Error('No spectral data found in output');
    }
    
    logger.info(`Parsed spectral data: ${wavelengths.length} wavelengths from ${wavelengths[0]}nm to ${wavelengths[wavelengths.length-1]}nm`);
    
    return {
      spectral,
      Lab,
      XYZ,
      wavelengthRange: {
        start: wavelengths[0],
        end: wavelengths[wavelengths.length - 1],
        count: wavelengths.length
      }
    };
  } catch (error) {
    logger.error('Failed to parse spectral output:', error);
    throw error;
  }
}

/**
 * Parse spotread output directly from console (when -O flag is not used)
 * @param {string} consoleOutput - Full console output from spotread (stdout + stderr)
 * @returns {Object} Parsed spectral data with Lab, XYZ, and spectral values
 */
function parseConsoleOutput(consoleOutput) {
  try {
    // DEBUG: Log raw console output to see what we're parsing
    logger.info('=== PARSER INPUT START ===');
    logger.info(consoleOutput.substring(0, 2000));
    logger.info('=== PARSER INPUT END ===');
    
    const spectral = {};
    const wavelengths = [];
    const values = [];
    
    // Parse Lab values - "D50 Lab: L a b"
    let Lab = null;
    const labMatch = consoleOutput.match(/D50\s+Lab:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/i);
    if (labMatch) {
      Lab = {
        L: parseFloat(labMatch[1]),
        a: parseFloat(labMatch[2]),
        b: parseFloat(labMatch[3])
      };
    }
    
    // Parse XYZ values - "XYZ: X Y Z" or "Result is XYZ: X Y Z"
    let XYZ = null;
    const xyzMatch = consoleOutput.match(/XYZ:\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/i);
    if (xyzMatch) {
      XYZ = {
        X: parseFloat(xyzMatch[1]),
        Y: parseFloat(xyzMatch[2]),
        Z: parseFloat(xyzMatch[3])
      };
    }
    
    // Parse spectral values - various formats:
    // Format 1: "380 nm = 0.123" or "380nm, 0.123" or "  380nm:  0.123"
    const spectralPattern = /(\d{3})\s*nm\s*[=:,]\s*([\d.]+)/gi;
    let match;
    while ((match = spectralPattern.exec(consoleOutput)) !== null) {
      const wavelength = parseInt(match[1]);
      const value = parseFloat(match[2]);
      if (!isNaN(wavelength) && !isNaN(value)) {
        wavelengths.push(wavelength);
        values.push(value);
        spectral[wavelength.toString()] = value;
      }
    }
    
    // Format 2: "Spectral reflectance:\n 380:  0.123\n 390:  0.456"
    if (Object.keys(spectral).length === 0) {
      const altPattern = /^\s*(\d{3})\s*:\s*([\d.]+)/gm;
      while ((match = altPattern.exec(consoleOutput)) !== null) {
        const wavelength = parseInt(match[1]);
        const value = parseFloat(match[2]);
        if (!isNaN(wavelength) && !isNaN(value) && wavelength >= 380 && wavelength <= 730) {
          wavelengths.push(wavelength);
          values.push(value);
          spectral[wavelength.toString()] = value;
        }
      }
    }
    
    // Format 3: Decimal wavelengths "380.0 nm = 0.0123" or "380.0nm:0.0123"
    if (Object.keys(spectral).length === 0) {
      const decimalPattern = /(\d{3,4}\.?\d*)\s*nm\s*[=:]\s*([\d.]+)/gi;
      while ((match = decimalPattern.exec(consoleOutput)) !== null) {
        const wavelength = Math.round(parseFloat(match[1]));
        const value = parseFloat(match[2]);
        if (!isNaN(wavelength) && !isNaN(value) && wavelength >= 380 && wavelength <= 730) {
          wavelengths.push(wavelength);
          values.push(value);
          spectral[wavelength.toString()] = value;
        }
      }
    }
    
    // Format 4: Spectrum block - space-separated values after "Spectrum:" or "Spectral:"
    if (Object.keys(spectral).length === 0) {
      const spectrumBlockMatch = consoleOutput.match(/Spectr(?:um|al)[:\s]+([0-9.\s]+)/i);
      if (spectrumBlockMatch) {
        const values_raw = spectrumBlockMatch[1].trim().split(/\s+/);
        // Assume 10nm steps from 380-730nm (36 values)
        let wl = 380;
        for (const val of values_raw) {
          const value = parseFloat(val);
          if (!isNaN(value) && wl <= 730) {
            wavelengths.push(wl);
            values.push(value);
            spectral[wl.toString()] = value;
            wl += 10;
          }
        }
      }
    }
    
    // Format 5: Tab or space-separated columns (wavelength, value)
    if (Object.keys(spectral).length === 0) {
      const lines = consoleOutput.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Match lines like "380\t0.123" or "380  0.123"
        const colMatch = trimmed.match(/^(\d{3,4})\s+(\d+\.?\d*)/);
        if (colMatch) {
          const wavelength = parseInt(colMatch[1]);
          const value = parseFloat(colMatch[2]);
          if (!isNaN(wavelength) && !isNaN(value) && wavelength >= 380 && wavelength <= 730) {
            wavelengths.push(wavelength);
            values.push(value);
            spectral[wavelength.toString()] = value;
          }
        }
      }
    }
    
    // Format 6: spotread -s output - "Spectrum from X to Y nm in N steps" header
    // followed by comma-separated values on next line(s)
    // Example: "Spectrum from 380.000 to 730.000 nm in 36 steps\n1.87554, 1.89404, ..."
    if (Object.keys(spectral).length === 0) {
      const headerMatch = consoleOutput.match(/Spectrum from\s+([\d.]+)\s+to\s+([\d.]+)\s+nm\s+in\s+(\d+)\s+steps/i);
      if (headerMatch) {
        const startWl = Math.round(parseFloat(headerMatch[1]));
        const endWl = Math.round(parseFloat(headerMatch[2]));
        const numSteps = parseInt(headerMatch[3]);
        
        logger.info(`Found spectral header: ${startWl}-${endWl}nm in ${numSteps} steps`);
        
        // Find comma-separated values after the header
        const headerIndex = consoleOutput.indexOf(headerMatch[0]);
        const afterHeader = consoleOutput.substring(headerIndex + headerMatch[0].length);
        
        // Match comma-separated numbers (possibly spanning multiple lines before "Peak value" or other text)
        const valuesMatch = afterHeader.match(/^\s*([\d.,\s\n]+?)(?=\s*Peak|\s*Result|\s*Place|\s*$)/is);
        if (valuesMatch) {
          const valuesStr = valuesMatch[1].trim();
          // Split by comma or whitespace, filter valid numbers
          const valuesArr = valuesStr.split(/[,\s]+/).filter(v => v && !isNaN(parseFloat(v)));
          
          logger.info(`Found ${valuesArr.length} comma-separated values`);
          
          if (valuesArr.length > 0) {
            // Calculate step size from the header info
            const step = numSteps > 1 ? Math.round((endWl - startWl) / (numSteps - 1)) : 10;
            let wl = startWl;
            
            for (const val of valuesArr) {
              const value = parseFloat(val);
              if (!isNaN(value) && wl <= endWl) {
                wavelengths.push(wl);
                values.push(value);
                spectral[wl.toString()] = value;
                wl += step;
              }
            }
            
            logger.info(`Parsed ${Object.keys(spectral).length} spectral values from comma-separated format (${startWl}-${endWl}nm, step=${step}nm)`);
          }
        }
      }
    }
    
    if (Object.keys(spectral).length === 0 && !Lab && !XYZ) {
      logger.error('Console output:', consoleOutput);
      throw new Error('No measurement data found in output');
    }
    
    logger.info(`Parsed from console: ${wavelengths.length} wavelengths, Lab=${Lab ? 'yes' : 'no'}, XYZ=${XYZ ? 'yes' : 'no'}`);
    logger.info(`Spectral object keys: ${Object.keys(spectral).length}`);
    if (Object.keys(spectral).length > 0) {
      logger.info(`First 3 spectral values: ${JSON.stringify(Object.entries(spectral).slice(0, 3))}`);
    }
    
    return {
      spectral,
      Lab,
      XYZ,
      wavelengthRange: wavelengths.length > 0 ? {
        start: Math.min(...wavelengths),
        end: Math.max(...wavelengths),
        count: wavelengths.length
      } : null
    };
  } catch (error) {
    logger.error('Failed to parse console output:', error);
    throw error;
  }
}

module.exports = { parseSpectralOutput, parseConsoleOutput };
