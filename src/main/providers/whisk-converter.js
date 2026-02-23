const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

// Max base64 size ~4MB to stay within tRPC JSON limits
const MAX_BASE64_SIZE = 4 * 1024 * 1024;

/**
 * Whisk Converter - Google Whisk API-based converter
 * Uses @rohitaryal/whisk-api (ESM package, loaded via dynamic import)
 * Supports: Image-to-Video (Veo 3.1), Text-to-Image (Imagen 3.5)
 */
class WhiskConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies;           // { cookies: 'google cookie string' }
    this.retryAttempts = options.retryAttempts || 3;
    this._running = false;
    this._whisk = null;               // Lazy-loaded Whisk instance
    this._WhiskClass = null;          // The Whisk class reference (for static methods)
    this._MediaClass = null;          // The Media class reference (for direct construction)
  }

  isRunning() {
    return this._running;
  }

  isBrowserAlive() {
    // Whisk doesn't use a browser
    return this._running;
  }

  /**
   * Compress image to fit within tRPC JSON payload limits.
   * Uses Electron's nativeImage to resize and convert to JPEG.
   */
  _compressImage(imagePath) {
    const img = nativeImage.createFromPath(imagePath);
    const { width, height } = img.getSize();
    let base64 = img.toJPEG(85).toString('base64');

    // If still too large, progressively resize down
    let scale = 1;
    while (base64.length > MAX_BASE64_SIZE && scale > 0.2) {
      scale -= 0.15;
      const newW = Math.round(width * scale);
      const newH = Math.round(height * scale);
      const resized = img.resize({ width: newW, height: newH, quality: 'good' });
      base64 = resized.toJPEG(80).toString('base64');
      console.log(`[WHISK] Compressed image to ${newW}x${newH} (${(base64.length / 1024 / 1024).toFixed(1)}MB base64)`);
    }

    return base64;
  }

  async _getClient() {
    if (this._whisk) return this._whisk;

    // Dynamic import for ESM package in CJS context
    const mod = await import('@rohitaryal/whisk-api');
    this._WhiskClass = mod.Whisk;
    this._MediaClass = mod.Media;
    this._whisk = new mod.Whisk(this.cookies.cookies);
    return this._whisk;
  }

  async start() {
    if (!this.cookies || !this.cookies.cookies) {
      throw new Error('No Google cookies provided for Whisk');
    }
    await this._getClient();
    this._running = true;
    console.log('[WHISK] Ready (API mode)');
  }

  async stop() {
    this._running = false;
    this._whisk = null;
    this._WhiskClass = null;
    console.log('[WHISK] Stopped');
  }

  async validateSession() {
    try {
      const client = await this._getClient();
      await client.account.refresh();
      console.log('[WHISK] Session valid');
      return true;
    } catch (e) {
      console.log('[WHISK] Validation failed:', e.message);
      return false;
    }
  }

  /**
   * Image-to-Video using Whisk Animate (Veo 3.1)
   * Note: Only landscape images can be animated
   */
  async convert(imagePath, outputPath, prompt, progressCallback) {
    const result = { success: false, videoUrl: null, outputPath, error: null, attempts: 0 };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        update('Reading image...', 10);
        if (!fs.existsSync(imagePath)) {
          throw new Error(`Image file not found: ${imagePath}`);
        }
        const imageBase64 = this._compressImage(imagePath);
        console.log(`[WHISK] Image base64 size: ${(imageBase64.length / 1024 / 1024).toFixed(1)}MB`);

        update('Preparing...', 20);
        const client = await this._getClient();
        const MediaClass = this._MediaClass;

        // Create a project for this animation job
        const project = await client.newProject();

        // Construct Media object directly from the local image
        // animate() only needs: encodedMedia, prompt, workflowId, aspectRatio, account
        const media = new MediaClass({
          seed: 0,
          prompt: prompt || 'Animate this image',
          workflowId: project.projectId,
          encodedMedia: imageBase64,
          mediaGenerationId: `local-${Date.now()}`,
          aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          mediaType: 'IMAGE',
          model: 'UPLOADED',
          account: client.account
        });

        update('Generating video...', 40);
        console.log('[WHISK] Starting video generation...');

        // Animate the image — returns a new Media object with video
        const videoMedia = await media.animate(prompt || 'Animate this image with subtle motion', 'VEO_3_1_I2V_12STEP');

        update('Downloading video...', 85);

        // Ensure output directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Extract base64 video data and write to file
        const videoBase64 = videoMedia.encodedMedia;
        if (!videoBase64) {
          throw new Error('No video data returned from Whisk');
        }
        const videoBuffer = Buffer.from(videoBase64, 'base64');
        fs.writeFileSync(outputPath, videoBuffer);

        const sizeMb = videoBuffer.length / (1024 * 1024);
        console.log(`[WHISK] Downloaded video (${sizeMb.toFixed(1)} MB)`);

        // Cleanup the project
        try { await project.delete(); } catch (e) { /* ignore cleanup errors */ }

        update('Complete!', 100);
        result.success = true;
        return result;

      } catch (e) {
        result.error = e.message;
        console.log(`[WHISK] Error: ${e.message}`);
        // Don't retry auth failures or server-side generation failures (wastes Flow tokens)
        if (e.message.includes('Authentication') || e.message.includes('401') || e.message.includes('403')) break;
        if (e.message.includes('HIGH_TRAFFIC')) {
          result.error = 'Whisk servers are experiencing high traffic. Please try again later. (Flow token was consumed)';
          break;
        }
        if (e.message.includes('GENERATION_STATUS_FAILED')) {
          result.error = 'Video generation failed on Whisk servers. (Flow token was consumed)';
          break;
        }
        if (attempt < this.retryAttempts) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    update(`Failed after ${result.attempts} attempts`, -1);
    return result;
  }

  /**
   * Text-to-Image using Whisk (Imagen 3.5)
   */
  async textToImage(prompt, outputPath, options = {}) {
    const { aspectRatio = '1:1', progressCallback } = options;
    const result = { success: false, imageUrl: null, outputPath, error: null, attempts: 0 };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    // Map aspect ratios to Whisk format
    const ratioMap = {
      '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
      '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT'
    };
    const whiskRatio = ratioMap[aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        update('Submitting to Whisk...', 20);
        const client = await this._getClient();

        update('Generating image...', 40);
        const images = await client.generateImage({
          prompt,
          aspectRatio: whiskRatio
        }, 1);

        if (!images || images.length === 0) {
          throw new Error('No images returned from Whisk');
        }

        update('Downloading image...', 80);

        // Ensure output directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // Extract base64 image data and write to file
        const media = images[0];
        const imageBase64 = media.encodedMedia;
        if (!imageBase64) {
          throw new Error('No image data returned from Whisk');
        }
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        fs.writeFileSync(outputPath, imageBuffer);

        const sizeMb = imageBuffer.length / (1024 * 1024);
        console.log(`[WHISK] Generated image (${sizeMb.toFixed(2)} MB)`);

        update('Complete!', 100);
        result.success = true;
        return result;

      } catch (e) {
        result.error = e.message;
        console.log(`[WHISK] Error: ${e.message}`);
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

module.exports = { WhiskConverter };
