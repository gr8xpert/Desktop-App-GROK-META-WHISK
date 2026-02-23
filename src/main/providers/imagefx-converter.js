const fs = require('fs');
const path = require('path');

/**
 * ImageFX Converter - Google ImageFX API-based converter
 * Uses @rohitaryal/imagefx-api (ESM package, loaded via dynamic import)
 * Supports: Text-to-Image only (Imagen 3 / 3.5 / 4)
 */
class ImageFXConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies; // { cookies: 'google auth cookie string' }
    this.retryAttempts = options.retryAttempts || 3;
    this._running = false;
    this._imagefx = null; // Lazy-loaded ESM module instance
  }

  isRunning() {
    return this._running;
  }

  isBrowserAlive() {
    // ImageFX doesn't use a browser
    return this._running;
  }

  async _getClient() {
    if (this._imagefx) return this._imagefx;

    // Dynamic import for ESM package in CJS context
    const { ImageFX } = await import('@rohitaryal/imagefx-api');
    this._imagefx = new ImageFX(this.cookies.cookies);
    return this._imagefx;
  }

  async start() {
    if (!this.cookies || !this.cookies.cookies) {
      throw new Error('No Google cookies provided for ImageFX');
    }
    await this._getClient();
    this._running = true;
    console.log('[IMAGEFX] Ready (API mode)');
  }

  async stop() {
    this._running = false;
    this._imagefx = null;
    console.log('[IMAGEFX] Stopped');
  }

  async validateSession() {
    try {
      const client = await this._getClient();
      // Generate a tiny test to confirm auth works
      const results = await client.generate('test image', { numImages: 1 });
      const valid = results && results.length > 0;
      console.log('[IMAGEFX] Session', valid ? 'valid' : 'invalid');
      return valid;
    } catch (e) {
      console.log('[IMAGEFX] Validation failed:', e.message);
      return false;
    }
  }

  /**
   * Image-to-Video — NOT supported by ImageFX
   */
  async convert() {
    throw new Error('ImageFX does not support video generation. Use text-to-image instead.');
  }

  /**
   * Text-to-Image using ImageFX (Imagen models)
   */
  async textToImage(prompt, outputPath, options = {}) {
    const { aspectRatio = '1:1', model = 'IMAGEN_3_5', progressCallback } = options;
    const result = { success: false, imageUrl: null, outputPath, error: null, attempts: 0 };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    // Map aspect ratios to ImageFX format
    const ratioMap = {
      '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
      '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT'
    };
    const fxRatio = ratioMap[aspectRatio] || 'IMAGE_ASPECT_RATIO_SQUARE';

    // Map model names to ImageFX enum
    const modelMap = {
      'IMAGEN_3': 'IMAGEN_3',
      'IMAGEN_3_5': 'IMAGEN_3_5',
      'IMAGEN_4': 'IMAGEN_4'
    };
    const fxModel = modelMap[model] || 'IMAGEN_3_5';

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        update('Submitting to ImageFX...', 20);
        const client = await this._getClient();

        const generateOptions = {
          aspectRatio: fxRatio,
          model: fxModel,
          numImages: 1
        };

        update('Generating image...', 40);
        const images = await client.generate(prompt, generateOptions);

        if (!images || images.length === 0) {
          throw new Error('No images returned from ImageFX');
        }

        update('Downloading image...', 80);

        // Ensure output directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // The API returns image data (Buffer or base64)
        const imageData = images[0];
        if (Buffer.isBuffer(imageData)) {
          fs.writeFileSync(outputPath, imageData);
        } else if (typeof imageData === 'string') {
          // Base64 string
          const base64Clean = imageData.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(outputPath, Buffer.from(base64Clean, 'base64'));
        } else if (imageData.data) {
          // Object with data property
          const data = Buffer.isBuffer(imageData.data)
            ? imageData.data
            : Buffer.from(imageData.data, 'base64');
          fs.writeFileSync(outputPath, data);
        } else if (imageData.url) {
          // URL-based response
          result.imageUrl = imageData.url;
          const response = await fetch(imageData.url);
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(outputPath, buffer);
        } else {
          throw new Error('Unexpected image data format from ImageFX');
        }

        const sizeMb = fs.statSync(outputPath).size / (1024 * 1024);
        console.log(`[IMAGEFX] Generated image (${sizeMb.toFixed(2)} MB)`);

        update('Complete!', 100);
        result.success = true;
        return result;

      } catch (e) {
        result.error = e.message;
        console.log(`[IMAGEFX] Error: ${e.message}`);
        if (e.message.includes('Authentication') || e.message.includes('401') || e.message.includes('403')) break;
        if (attempt < this.retryAttempts) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    update(`Failed after ${result.attempts} attempts`, -1);
    return result;
  }
}

module.exports = { ImageFXConverter };
