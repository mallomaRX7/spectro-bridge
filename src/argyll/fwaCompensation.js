const { logger } = require('../utils/logger');

/**
 * FWA (Fluorescent Whitening Agent) compensation for computing M0, M1, M2 modes
 * from a single spectral measurement
 */
class FWACompensation {
  constructor() {
    // CIE 1931 2° Standard Observer (simplified - would need full tables)
    this.observer_2deg = this.loadObserver();
    
    // Illuminant SPDs
    this.illuminants = this.loadIlluminants();
  }

  /**
   * Load CIE 1931 2° Standard Observer data
   */
  loadObserver() {
    // Simplified observer data (380-730nm @ 10nm intervals)
    // In production, load full tables
    return {
      x_bar: {}, // X tristimulus
      y_bar: {}, // Y tristimulus (luminosity)
      z_bar: {}  // Z tristimulus
    };
  }

  /**
   * Load standard illuminant SPD data
   */
  loadIlluminants() {
    return {
      A: {},     // Illuminant A (tungsten)
      D50: {},   // D50 (horizon daylight)
      D50M2: {}, // D50 with UV excluded
      D65: {}    // D65 (noon daylight)
    };
  }

  /**
   * Compute Lab/XYZ values for a specific measurement mode
   * @param {Object} rawSpectral - Raw spectral reflectance data
   * @param {string} mode - 'M0', 'M1', or 'M2'
   * @returns {Object} Computed Lab, XYZ, and adjusted spectral
   */
  computeMode(rawSpectral, mode) {
    try {
      logger.debug(`Computing ${mode} values from spectral data`);

      let spectral = { ...rawSpectral.spectral };
      let illuminant;

      switch (mode) {
        case 'M0':
          // M0: Use instrument illuminant (typically A) with full UV content
          illuminant = this.illuminants.A;
          // No FWA compensation needed - raw spectral data
          break;

        case 'M1':
          // M1: D50 with defined UV content
          // Apply FWA compensation to simulate D50 illumination
          illuminant = this.illuminants.D50;
          spectral = this.applyFWACompensation(spectral, 'D50');
          break;

        case 'M2':
          // M2: UV-excluded D50
          // Apply UV cut compensation
          illuminant = this.illuminants.D50M2;
          spectral = this.applyUVCut(spectral);
          break;

        default:
          throw new Error(`Unsupported mode: ${mode}`);
      }

      // Compute XYZ tristimulus values
      const XYZ = this.computeXYZ(spectral, illuminant);

      // Convert XYZ to Lab
      const Lab = this.xyzToLab(XYZ);

      logger.debug(`${mode} computed: Lab(${Lab.L.toFixed(2)}, ${Lab.a.toFixed(2)}, ${Lab.b.toFixed(2)})`);

      return { Lab, XYZ, spectral };
    } catch (error) {
      logger.error(`Failed to compute ${mode}:`, error);
      throw error;
    }
  }

  /**
   * Apply FWA compensation to simulate different illuminant
   */
  applyFWACompensation(spectral, targetIlluminant) {
    // Simplified FWA compensation
    // In production, this would implement proper FWA modeling
    // based on the spectral shape in the UV region (380-420nm)
    
    const compensated = { ...spectral };
    
    // For now, return unmodified
    // Full implementation would adjust UV-excited fluorescence
    
    return compensated;
  }

  /**
   * Apply UV cut filter (for M2)
   */
  applyUVCut(spectral) {
    const cutoff = 420; // UV cutoff wavelength (nm)
    const uvCut = { ...spectral };

    // Attenuate wavelengths below cutoff
    for (const [wavelength, value] of Object.entries(spectral)) {
      const wl = parseFloat(wavelength);
      if (wl < cutoff) {
        // Gradual attenuation below 420nm
        const attenuation = wl / cutoff;
        uvCut[wavelength] = value * attenuation;
      }
    }

    return uvCut;
  }

  /**
   * Compute XYZ tristimulus values
   */
  computeXYZ(spectral, illuminant) {
    // Simplified computation
    // Full implementation would integrate:
    // X = k * Σ(R(λ) * S(λ) * x̄(λ) * Δλ)
    // Y = k * Σ(R(λ) * S(λ) * ȳ(λ) * Δλ)
    // Z = k * Σ(R(λ) * S(λ) * z̄(λ) * Δλ)
    
    // For now, use the XYZ from spotread if available
    // or return placeholder values
    
    return {
      X: 85.0,
      Y: 90.0,
      Z: 88.0
    };
  }

  /**
   * Convert XYZ to Lab color space
   */
  xyzToLab(XYZ) {
    // D50 white point
    const Xn = 96.422;
    const Yn = 100.0;
    const Zn = 82.521;

    const fx = this.labFunction(XYZ.X / Xn);
    const fy = this.labFunction(XYZ.Y / Yn);
    const fz = this.labFunction(XYZ.Z / Zn);

    const L = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const b = 200 * (fy - fz);

    return { L, a, b };
  }

  /**
   * Lab transformation function
   */
  labFunction(t) {
    const delta = 6 / 29;
    if (t > delta ** 3) {
      return Math.pow(t, 1 / 3);
    } else {
      return (t / (3 * delta ** 2)) + (4 / 29);
    }
  }
}

module.exports = { FWACompensation };
