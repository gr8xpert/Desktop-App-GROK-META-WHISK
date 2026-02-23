const fs = require('fs');
const path = require('path');

/**
 * Whisk Converter - Google Whisk API-based converter
 * Uses direct API calls (no Playwright browser needed)
 * Supports: Image-to-Video (Veo 2/3), Text-to-Image (Imagen 3.5)
 */
class WhiskConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies; // Google auth cookies string
    this.retryAttempts = options.retryAttempts || 3;
    this._running = false;
    this._baseUrl = 'https://aisandbox-pa.googleapis.com';
    this._whiskUrl = 'https://whisk.google.com';
  }

  isRunning() {
    return this._running;
  }

  isBrowserAlive() {
    // Whisk doesn't use a browser
    return this._running;
  }

  async start() {
    if (!this.cookies || !this.cookies.cookies) {
      throw new Error('No Google cookies provided for Whisk');
    }
    this._running = true;
    console.log('[WHISK] Ready (API mode)');
  }

  async stop() {
    this._running = false;
    console.log('[WHISK] Stopped');
  }

  _getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Cookie': this.cookies.cookies,
      'Origin': this._whiskUrl,
      'Referer': `${this._whiskUrl}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
  }

  async _fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);
        if (response.ok) return response;

        const text = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Authentication failed (${response.status}). Please update your Google cookies.`);
        }
        if (response.status === 429) {
          if (attempt < maxRetries) {
            const delay = attempt * 5000;
            console.log(`[WHISK] Rate limited, waiting ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw new Error('Rate limited by Whisk API. Please try again later.');
        }
        if (attempt === maxRetries) {
          throw new Error(`API error ${response.status}: ${text.substring(0, 200)}`);
        }
      } catch (e) {
        if (e.message.includes('Authentication') || e.message.includes('Rate limited')) throw e;
        if (attempt === maxRetries) throw e;
        console.log(`[WHISK] Request attempt ${attempt} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async validateSession() {
    try {
      // Test auth by fetching the whisk page
      const response = await fetch(`${this._whiskUrl}/api/user`, {
        headers: this._getHeaders()
      });
      if (response.ok) {
        console.log('[WHISK] Session valid');
        return true;
      }
      console.log('[WHISK] Session invalid:', response.status);
      return false;
    } catch (e) {
      console.log('[WHISK] Validation failed:', e.message);
      return false;
    }
  }

  /**
   * Image-to-Video using Whisk Animate (Veo 2/3)
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
        const imageBuffer = fs.readFileSync(imagePath);
        const imageBase64 = imageBuffer.toString('base64');
        const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

        update('Submitting to Whisk...', 20);

        // Submit animation request
        const submitResponse = await this._fetchWithRetry(
          `${this._whiskUrl}/api/animate`,
          {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
              image: { data: imageBase64, mimeType },
              prompt: prompt || 'Animate this image with subtle motion',
              model: 'VEO_2'
            })
          }
        );

        const submitData = await submitResponse.json();
        const operationId = submitData.operationId || submitData.name;

        if (!operationId) {
          throw new Error('No operation ID returned from Whisk API');
        }

        console.log(`[WHISK] Operation started: ${operationId}`);

        // Poll for completion
        update('Generating video...', 30);
        const videoUrl = await this._pollForResult(operationId, 120, (percent) => {
          update('Generating video...', 30 + Math.floor(percent * 0.5));
        });

        if (!videoUrl) {
          throw new Error('Video generation timed out');
        }

        result.videoUrl = videoUrl;
        update('Downloading video...', 85);

        // Download the video
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const videoResponse = await this._fetchWithRetry(videoUrl, {
          headers: this._getHeaders()
        });
        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
        fs.writeFileSync(outputPath, videoBuffer);

        const sizeMb = videoBuffer.length / (1024 * 1024);
        console.log(`[WHISK] Downloaded (${sizeMb.toFixed(1)} MB)`);

        update('Complete!', 100);
        result.success = true;
        return result;

      } catch (e) {
        result.error = e.message;
        console.log(`[WHISK] Error: ${e.message}`);
        if (e.message.includes('Authentication')) break; // Don't retry auth failures
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
    const ratioMap = { '1:1': 'SQUARE', '16:9': 'LANDSCAPE', '9:16': 'PORTRAIT' };
    const whiskRatio = ratioMap[aspectRatio] || 'SQUARE';

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        update('Submitting to Whisk...', 20);

        const submitResponse = await this._fetchWithRetry(
          `${this._whiskUrl}/api/generate`,
          {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify({
              prompt,
              aspectRatio: whiskRatio,
              model: 'IMAGEN_3_5'
            })
          }
        );

        const submitData = await submitResponse.json();
        const operationId = submitData.operationId || submitData.name;

        if (!operationId) {
          // Some responses include the image directly
          if (submitData.imageUrl || submitData.image) {
            const imageUrl = submitData.imageUrl || submitData.image;
            result.imageUrl = imageUrl;
            update('Downloading image...', 80);

            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            if (submitData.image && submitData.image.startsWith('data:')) {
              // Base64 data URI
              const base64Data = submitData.image.split(',')[1];
              fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
            } else {
              const imgResponse = await this._fetchWithRetry(imageUrl, { headers: this._getHeaders() });
              fs.writeFileSync(outputPath, Buffer.from(await imgResponse.arrayBuffer()));
            }

            update('Complete!', 100);
            result.success = true;
            return result;
          }
          throw new Error('No operation ID or image returned');
        }

        update('Generating image...', 30);
        const imageUrl = await this._pollForResult(operationId, 60, (percent) => {
          update('Generating image...', 30 + Math.floor(percent * 0.5));
        });

        if (!imageUrl) throw new Error('Image generation timed out');

        result.imageUrl = imageUrl;
        update('Downloading image...', 85);

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const imgResponse = await this._fetchWithRetry(imageUrl, { headers: this._getHeaders() });
        fs.writeFileSync(outputPath, Buffer.from(await imgResponse.arrayBuffer()));

        update('Complete!', 100);
        result.success = true;
        return result;

      } catch (e) {
        result.error = e.message;
        console.log(`[WHISK] Error: ${e.message}`);
        if (e.message.includes('Authentication')) break;
        if (attempt < this.retryAttempts) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    update(`Failed after ${result.attempts} attempts`, -1);
    return result;
  }

  async _pollForResult(operationId, timeoutSeconds = 120, onProgress) {
    const startTime = Date.now();
    let lastLog = 0;

    while ((Date.now() - startTime) / 1000 < timeoutSeconds) {
      if (!this._running) return null;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastLog >= 10) {
        console.log(`[WHISK] Polling: ${elapsed}s...`);
        lastLog = elapsed;
      }

      if (onProgress) {
        onProgress(Math.min(elapsed / timeoutSeconds, 0.95));
      }

      try {
        const response = await fetch(
          `${this._whiskUrl}/api/operations/${operationId}`,
          { headers: this._getHeaders() }
        );

        if (response.ok) {
          const data = await response.json();

          if (data.done || data.status === 'COMPLETED') {
            const resultUrl = data.result?.videoUrl || data.result?.imageUrl ||
                             data.response?.videoUrl || data.response?.imageUrl ||
                             data.videoUrl || data.imageUrl;
            if (resultUrl) return resultUrl;
          }

          if (data.error || data.status === 'FAILED') {
            throw new Error(`Generation failed: ${data.error?.message || 'Unknown error'}`);
          }
        }
      } catch (e) {
        if (e.message.includes('Generation failed')) throw e;
        console.log(`[WHISK] Poll error: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    return null;
  }
}

module.exports = { WhiskConverter };
