const fs = require('fs');
const path = require('path');

/**
 * ImageFX Converter - Google ImageFX API-based converter
 * Uses @rohitaryal/imagefx-api (ESM package, loaded via dynamic import)
 * Supports: Text-to-Image only (Imagen 3.5)
 */
class ImageFXConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies; // { cookies: 'google auth cookie string' }
    this.retryAttempts = options.retryAttempts || 3;
    this._running = false;
    this._imagefx = null;     // Lazy-loaded ImageFX instance
    this._PromptClass = null; // Prompt class for structured prompts
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
    const mod = await import('@rohitaryal/imagefx-api');
    this._PromptClass = mod.Prompt;
    this._imagefx = new mod.ImageFX(this.cookies.cookies);
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
    this._PromptClass = null;
    console.log('[IMAGEFX] Stopped');
  }

  async validateSession() {
    try {
      const client = await this._getClient();
      // Refresh session to verify cookies are valid (doesn't consume a generation)
      await client.account.refreshSession();
      console.log('[IMAGEFX] Session valid');
      return true;
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
   * Text-to-Image using ImageFX (Imagen 3.5)
   */
  async textToImage(prompt, outputPath, options = {}) {
    const { aspectRatio = '1:1', progressCallback } = options;
    const result = { success: false, imageUrl: null, outputPath, error: null, attempts: 0 };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    // Map aspect ratios to ImageFX format
    const ratioMap = {
      '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
      '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT'
    };
    const fxRatio = ratioMap[aspectRatio] || 'IMAGE_ASPECT_RATIO_SQUARE';

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        update('Submitting to ImageFX...', 20);
        const client = await this._getClient();
        const Prompt = this._PromptClass;

        // Create structured prompt with aspect ratio
        const promptObj = new Prompt({
          prompt,
          aspectRatio: fxRatio,
          numberOfImages: 1,
          generationModel: 'IMAGEN_3_5'
        });

        update('Generating image...', 40);
        const images = await client.generateImage(promptObj);

        if (!images || images.length === 0) {
          throw new Error('No images returned from ImageFX');
        }

        update('Downloading image...', 80);

        // Ensure output directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Image.encodedImage is base64 string
        const image = images[0];
        const imageBuffer = Buffer.from(image.encodedImage, 'base64');
        fs.writeFileSync(outputPath, imageBuffer);

        const sizeMb = imageBuffer.length / (1024 * 1024);
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
