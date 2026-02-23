const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

class GrokConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies;
    this.headless = options.headless !== false;
    this.retryAttempts = options.retryAttempts || 3;
    this.delayBetween = options.delayBetween || 5;

    this.browser = null;
    this.context = null;
    this.page = null;
    this._running = false;
    this._progressCallback = null;
    this._tempDownloadDir = null;
    this._usedUrls = new Set(); // Track downloaded URLs to prevent re-downloading stale content
  }

  onProgress(callback) {
    this._progressCallback = callback;
  }

  isRunning() {
    return this._running;
  }

  isBrowserAlive() {
    return this.browser !== null && this.browser.isConnected();
  }

  async start() {
    if (this.browser && this.browser.isConnected()) return;

    console.log('[GROK] Starting browser...');

    try {
      this.browser = await chromium.launch({
        headless: this.headless,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled']
      });
    } catch (e) {
      if (e.message.includes('Executable doesn\'t exist') || e.message.includes('executable')) {
        throw new Error('Google Chrome is not installed. Please install Chrome from https://google.com/chrome');
      }
      throw e;
    }

    const os = require('os');
    const tempDownloadDir = path.join(os.tmpdir(), 'aivg-grok-downloads');
    if (!fs.existsSync(tempDownloadDir)) {
      fs.mkdirSync(tempDownloadDir, { recursive: true });
    }
    this._tempDownloadDir = tempDownloadDir;

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: true
    });

    const cookieList = [];
    const grokCookies = ['sso', 'sso-rw', 'x-userid', 'i18nextLng'];
    for (const name of grokCookies) {
      if (this.cookies[name]) {
        cookieList.push({ name, value: this.cookies[name], domain: '.grok.com', path: '/' });
      }
    }

    if (this.cookies['sso_xai']) {
      cookieList.push({ name: 'sso', value: this.cookies['sso_xai'], domain: '.x.ai', path: '/' });
    }
    if (this.cookies['sso-rw_xai']) {
      cookieList.push({ name: 'sso-rw', value: this.cookies['sso-rw_xai'], domain: '.x.ai', path: '/' });
    }

    if (cookieList.length === 0) {
      throw new Error('No valid Grok cookies provided. Please provide sso and sso-rw cookies from grok.com');
    }

    await this.context.addCookies(cookieList);
    console.log(`[GROK] Added ${cookieList.length} cookies`);

    this.page = await this.context.newPage();

    console.log('[GROK] Navigating to grok.com/imagine...');
    await this.page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForTimeout(2000);

    const currentUrl = this.page.url();
    console.log('[GROK] Current URL:', currentUrl);

    if (currentUrl.toLowerCase().includes('login') ||
        currentUrl.toLowerCase().includes('auth') ||
        currentUrl.toLowerCase().includes('x.com/i/flow')) {
      throw new Error(`Not logged in. Redirected to: ${currentUrl}`);
    }

    // Verify logged in
    try {
      await this.page.waitForTimeout(2000);
      const inputSelectors = [
        'textarea[placeholder*="imagine" i]', 'textarea[placeholder*="type" i]',
        'div[contenteditable="true"]', '[data-placeholder]'
      ];
      let foundInput = false;
      for (const selector of inputSelectors) {
        if (await this.page.locator(selector).first().count() > 0) {
          foundInput = true;
          break;
        }
      }
      if (!foundInput) {
        const loginIndicators = ['text="Sign in"', 'text="Log in"', 'text="Sign up"'];
        for (const selector of loginIndicators) {
          const el = this.page.locator(selector).first();
          if (await el.count() > 0 && await el.isVisible()) {
            throw new Error('Not logged in. Please provide valid cookies.');
          }
        }
      }
    } catch (e) {
      if (e.message.includes('Not logged in')) throw e;
    }

    console.log('[GROK] Ready!');
    this._running = true;
  }

  async stop() {
    this._running = false;
    try {
      // Close all pages in context (handles orphaned tabs)
      if (this.context) {
        const pages = this.context.pages();
        for (const p of pages) {
          await p.close().catch(() => {});
        }
      }
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {
      console.error('[GROK] Error closing:', e);
    }

    if (this._tempDownloadDir && fs.existsSync(this._tempDownloadDir)) {
      try {
        const files = fs.readdirSync(this._tempDownloadDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this._tempDownloadDir, file));
        }
      } catch (e) {}
    }

    this.page = null;
    this.context = null;
    this.browser = null;
    console.log('[GROK] Closed.');
  }

  async validateSession() {
    try {
      await this.start();
      return true;
    } catch (e) {
      console.log('[GROK] Validation failed:', e.message);
      return false;
    } finally {
      await this.stop();
    }
  }

  async _navigateToImagine() {
    console.log('[GROK] Opening fresh /imagine tab...');
    try {
      const newPage = await this.context.newPage();
      if (this.page) await this.page.close().catch(() => {});
      this.page = newPage;
      await this.page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);
    } catch (e) {
      await this.page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);
    }
  }

  async _uploadImage(imagePath) {
    console.log(`[GROK] Uploading: ${path.basename(imagePath)}...`);

    // Method 1: Direct file input
    try {
      const fileInput = this.page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(imagePath);
        await this.page.waitForTimeout(2000);
        console.log('[GROK] Upload done via file input');
        await this._clickGenerateButton();
        return true;
      }
    } catch (e) {}

    // Method 2: Image button -> Upload menu
    const triggerSelectors = [
      'button:has-text("Image")', '[aria-haspopup="menu"]',
      'button[aria-expanded]', 'button:has(svg[viewBox])'
    ];

    for (const selector of triggerSelectors) {
      try {
        const triggers = this.page.locator(selector);
        const count = await triggers.count();
        for (let i = 0; i < count; i++) {
          const trigger = triggers.nth(i);
          if (await trigger.isVisible()) {
            await trigger.click();
            await this.page.waitForTimeout(800);

            const menu = this.page.locator('[role="menu"]');
            if (await menu.count() > 0 && await menu.isVisible()) {
              if (await this._clickUploadOption()) {
                const [fileChooser] = await Promise.all([
                  this.page.waitForEvent('filechooser', { timeout: 5000 })
                ]).catch(() => [null]);

                if (fileChooser) {
                  await fileChooser.setFiles(imagePath);
                  await this.page.waitForTimeout(2000);
                  await this._clickGenerateButton();
                  return true;
                }

                const fileInput = this.page.locator('input[type="file"]').first();
                if (await fileInput.count() > 0) {
                  await fileInput.setInputFiles(imagePath);
                  await this.page.waitForTimeout(2000);
                  await this._clickGenerateButton();
                  return true;
                }
              }
            }
          }
        }
      } catch (e) { continue; }
    }

    // Method 3: Generic
    try {
      await this.page.setInputFiles('input[type="file"]', imagePath);
      await this.page.waitForTimeout(2000);
      await this._clickGenerateButton();
      return true;
    } catch (e) {}

    return false;
  }

  async _clickUploadOption() {
    await this.page.waitForTimeout(500);
    const uploadSelectors = [
      '[role="menuitem"]:has-text("Upload")', '[role="menuitem"]:first-child',
      'div:has-text("Upload a file")', 'text="Upload a file"'
    ];
    for (const selector of uploadSelectors) {
      try {
        const item = this.page.locator(selector).first();
        if (await item.count() > 0 && await item.isVisible()) {
          await item.click();
          await this.page.waitForTimeout(500);
          return true;
        }
      } catch (e) { continue; }
    }
    return false;
  }

  async _selectVideoMode() {
    console.log('[GROK] Selecting Video mode...');

    try {
      const dropdownSelectors = [
        'button:has-text("Image"):near(textarea)',
        'button:has-text("Image")',
        '[aria-expanded]:has-text("Image")'
      ];

      let dropdownClicked = false;
      for (const selector of dropdownSelectors) {
        try {
          const dropdowns = this.page.locator(selector);
          const count = await dropdowns.count();
          for (let i = 0; i < count; i++) {
            const dropdown = dropdowns.nth(i);
            if (await dropdown.isVisible()) {
              const box = await dropdown.boundingBox();
              if (box && box.y > 300) {
                await dropdown.click();
                dropdownClicked = true;
                await this.page.waitForTimeout(1000);
                break;
              }
            }
          }
          if (dropdownClicked) break;
        } catch (e) { continue; }
      }

      if (!dropdownClicked) return false;

      await this.page.waitForTimeout(500);

      const videoSelectors = [
        'div:has(> span:text-is("Video"))',
        'label:has-text("Video"):has-text("Generate")',
        'div:has-text("VideoGenerate a video")',
        'input[type="radio"][value*="video" i]',
        'span:text-is("Video")'
      ];

      for (const selector of videoSelectors) {
        try {
          const elements = this.page.locator(selector);
          const count = await elements.count();
          for (let i = 0; i < count; i++) {
            const el = elements.nth(i);
            if (await el.isVisible()) {
              const text = await el.textContent().catch(() => '');
              if (text.includes('browser does not support')) continue;
              await el.click();
              console.log('[GROK] Video mode selected');
              await this.page.waitForTimeout(500);
              return true;
            }
          }
        } catch (e) { continue; }
      }

      // Keyboard fallback
      await this.page.keyboard.press('ArrowUp');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(500);
      return false;

    } catch (e) {
      console.log('[GROK] Error selecting video mode:', e.message);
      return false;
    }
  }

  async _openSettingsPopup() {
    console.log('[GROK] Opening settings popup...');
    try {
      // The bottom bar has a mode button ("Video" or "Image") that opens the settings popup
      const modeButtonSelectors = [
        'button:has-text("Video")',
        'button:has-text("Image")'
      ];

      for (const sel of modeButtonSelectors) {
        try {
          const buttons = this.page.locator(sel);
          const count = await buttons.count();
          for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i);
            if (await btn.isVisible()) {
              const box = await btn.boundingBox();
              // Target the bottom bar button (y > 500), not any other "Image"/"Video" text
              if (box && box.y > 500) {
                await btn.click();
                await this.page.waitForTimeout(800);
                console.log('[GROK] Settings popup opened');
                return true;
              }
            }
          }
        } catch (e) { continue; }
      }

      console.log('[GROK] Could not find bottom bar mode button');
      return false;
    } catch (e) {
      console.log('[GROK] Error opening settings popup:', e.message);
      return false;
    }
  }

  async _closeSettingsPopup() {
    try {
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(300);
    } catch (e) {}
  }

  async _selectAspectRatio(ratio) {
    console.log(`[GROK] Selecting aspect ratio: ${ratio}`);

    try {
      await this.page.waitForTimeout(500);

      // Open settings popup (works in both Image and Video mode)
      const opened = await this._openSettingsPopup();
      if (!opened) {
        console.log('[GROK] Could not open settings popup for aspect ratio');
        return false;
      }

      // Try direct aria-label match first
      const button = this.page.locator(`[aria-label="${ratio}"]`).first();
      if (await button.count() > 0 && await button.isVisible()) {
        await button.click({ force: true });
        console.log(`[GROK] Aspect ratio ${ratio} selected via aria-label`);
        await this._closeSettingsPopup();
        return true;
      }

      // Fallback: text content matching
      const textSelectors = [
        `button:has-text("${ratio}")`, `span:text-is("${ratio}")`, `div:text-is("${ratio}")`
      ];
      for (const sel of textSelectors) {
        try {
          const el = this.page.locator(sel).first();
          if (await el.count() > 0 && await el.isVisible()) {
            await el.click();
            console.log(`[GROK] Aspect ratio ${ratio} selected via text`);
            await this._closeSettingsPopup();
            return true;
          }
        } catch (e) { continue; }
      }

      await this._closeSettingsPopup();
      return false;
    } catch (e) {
      console.log('[GROK] Error selecting aspect ratio:', e.message);
      await this._closeSettingsPopup();
      return false;
    }
  }

  async _selectVideoDuration(duration) {
    if (!duration) return false;
    console.log(`[GROK] Selecting video duration: ${duration}`);

    try {
      const opened = await this._openSettingsPopup();
      if (!opened) return false;

      // Look for duration button by text (e.g. "6s" or "10s")
      const selectors = [
        `button:has-text("${duration}")`,
        `span:text-is("${duration}")`,
        `div:text-is("${duration}")`,
        `[aria-label="${duration}"]`
      ];

      for (const sel of selectors) {
        try {
          const elements = this.page.locator(sel);
          const count = await elements.count();
          for (let i = 0; i < count; i++) {
            const el = elements.nth(i);
            if (await el.isVisible()) {
              await el.click();
              console.log(`[GROK] Video duration ${duration} selected`);
              await this._closeSettingsPopup();
              return true;
            }
          }
        } catch (e) { continue; }
      }

      await this._closeSettingsPopup();
      return false;
    } catch (e) {
      console.log('[GROK] Error selecting video duration:', e.message);
      await this._closeSettingsPopup();
      return false;
    }
  }

  async _selectVideoResolution(resolution) {
    if (!resolution) return false;
    console.log(`[GROK] Selecting video resolution: ${resolution}`);

    try {
      const opened = await this._openSettingsPopup();
      if (!opened) return false;

      // Look for resolution button by text (e.g. "480p" or "720p")
      const selectors = [
        `button:has-text("${resolution}")`,
        `span:text-is("${resolution}")`,
        `div:text-is("${resolution}")`,
        `[aria-label="${resolution}"]`
      ];

      for (const sel of selectors) {
        try {
          const elements = this.page.locator(sel);
          const count = await elements.count();
          for (let i = 0; i < count; i++) {
            const el = elements.nth(i);
            if (await el.isVisible()) {
              await el.click();
              console.log(`[GROK] Video resolution ${resolution} selected`);
              await this._closeSettingsPopup();
              return true;
            }
          }
        } catch (e) { continue; }
      }

      await this._closeSettingsPopup();
      return false;
    } catch (e) {
      console.log('[GROK] Error selecting video resolution:', e.message);
      await this._closeSettingsPopup();
      return false;
    }
  }

  async _typePrompt(prompt) {
    console.log(`[GROK] Typing prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Wait for page to have a textarea in the DOM (up to 20s)
    try {
      await this.page.waitForSelector('textarea', { timeout: 20000 });
      console.log('[GROK] Textarea found in DOM');
    } catch (e) {
      // Log page diagnostics to understand what's on screen
      const diag = await this.page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        textareas: document.querySelectorAll('textarea').length,
        inputs: document.querySelectorAll('input').length,
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        bodyText: document.body?.innerText?.substring(0, 300) || ''
      })).catch(() => ({ url: '?', title: '?', textareas: 0, inputs: 0, editables: 0, bodyText: '' }));
      console.log(`[GROK] No textarea after 20s! URL: ${diag.url} | Title: ${diag.title}`);
      console.log(`[GROK] DOM: ${diag.textareas} textareas, ${diag.inputs} inputs, ${diag.editables} editables`);
      console.log(`[GROK] Page text: ${diag.bodyText.substring(0, 200)}`);
    }

    // Try React native setter directly via evaluate (bypasses Playwright visibility check)
    const reactSet = await this.page.evaluate((text) => {
      // Find the first textarea on the page
      const ta = document.querySelector('textarea');
      if (!ta) return { ok: false, reason: 'no textarea' };
      try {
        ta.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: ta.value === text, reason: 'set' };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }, prompt).catch(e => ({ ok: false, reason: e.message }));

    if (reactSet.ok) {
      console.log('[GROK] Prompt set via React native setter (direct)');
      await this.page.waitForTimeout(500);
      return true;
    }
    console.log(`[GROK] Direct React setter failed: ${reactSet.reason}`);

    // Fallback: try specific selectors with Playwright interaction (no visibility check)
    const inputSelectors = [
      'textarea[placeholder="Type to imagine"]',
      'textarea[aria-label="Ask Grok anything"]',
      'textarea[placeholder*="imagine" i]',
      'textarea[placeholder*="type" i]',
      'textarea[placeholder*="customiz" i]',
      'textarea',
      'div[contenteditable="true"]'
    ];

    for (const selector of inputSelectors) {
      try {
        const input = this.page.locator(selector).first();
        if (await input.count() > 0) {
          // Try click + keyboard type
          try {
            await input.click({ force: true, timeout: 3000 });
          } catch (e) {
            await input.focus().catch(() => {});
          }
          await this.page.waitForTimeout(300);
          await this.page.keyboard.press('Control+a');
          await this.page.keyboard.press('Backspace');
          await this.page.waitForTimeout(200);
          await this.page.keyboard.type(prompt, { delay: 30 });
          console.log(`[GROK] Prompt typed via keyboard (${selector})`);
          await this.page.waitForTimeout(500);
          return true;
        }
      } catch (e) { continue; }
    }

    return false;
  }

  async _clickGenerateButton() {
    console.log('[GROK] Looking for generate button...');
    await this.page.waitForTimeout(1000);

    const generateSelectors = [
      'button[type="submit"]', 'button:has-text("Make video")',
      'button:has-text("Generate")', 'button:has-text("Send")',
      'button:has-text("Create")', 'button:has-text("Redo")',
      '[aria-label*="send" i]', '[aria-label*="submit" i]',
      '[aria-label*="generate" i]', 'button:has(svg[viewBox="0 0 24 24"])',
      'form button:last-child'
    ];

    for (const selector of generateSelectors) {
      try {
        const buttons = this.page.locator(selector);
        const count = await buttons.count();
        for (let i = 0; i < count; i++) {
          const btn = buttons.nth(i);
          if (await btn.isVisible() && await btn.isEnabled()) {
            await btn.click();
            console.log(`[GROK] Clicked generate button`);
            await this.page.waitForTimeout(2000);
            return true;
          }
        }
      } catch (e) { continue; }
    }

    // Enter fallback
    try {
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(2000);
      return true;
    } catch (e) {}

    return false;
  }

  async _waitForVideoGeneration(timeout = 180, resolution = null) {
    console.log(`[GROK] Waiting for video (max ${timeout}s)...`);

    const startTime = Date.now();
    let lastLog = 0;
    let videoUrl = null;
    const MIN_WAIT = 5;

    // Collect initial video URLs + merge previously downloaded URLs
    const initialVideoUrls = new Set();
    try {
      const videos = this.page.locator('video');
      const count = await videos.count();
      for (let i = 0; i < count; i++) {
        const src = await videos.nth(i).getAttribute('src').catch(() => null);
        if (src) initialVideoUrls.add(src);
      }
    } catch (e) {}
    // Add all previously downloaded URLs to the exclusion set
    for (const url of this._usedUrls) initialVideoUrls.add(url);
    console.log(`[GROK] Excluding ${initialVideoUrls.size} known video URLs`);

    const responseHandler = async (response) => {
      const url = response.url();
      if (url.includes('generated_video.mp4') || (url.includes('.mp4') && url.includes('grok'))) {
        // Only accept URLs not previously downloaded
        if (!this._usedUrls.has(url)) {
          videoUrl = url;
        } else {
          console.log(`[GROK] Ignoring previously downloaded video URL from network`);
        }
      }
    };
    this.page.on('response', responseHandler);

    try {
      while ((Date.now() - startTime) / 1000 < timeout) {
        if (!this._running) return null;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        if (elapsed - lastLog >= 15) {
          console.log(`[GROK] ${elapsed}s elapsed...`);
          lastLog = elapsed;
        }

        if (videoUrl && elapsed >= MIN_WAIT) {
          this._usedUrls.add(videoUrl);
          console.log(`[GROK] Video URL captured! (${elapsed}s): ${videoUrl.substring(0, 120)}...`);
          // Wait for CDN to fully make the video available before attempting download
          await this.page.waitForTimeout(5000);
          return videoUrl;
        }

        if (elapsed >= MIN_WAIT) {
          // Check Grok's specific video elements first (#sd-video / #hd-video)
          // Prefer HD when 720p selected, SD otherwise
          try {
            const videoIds = resolution === '720p'
              ? ['#hd-video', '#sd-video']
              : ['#sd-video', '#hd-video'];
            for (const id of videoIds) {
              const vid = this.page.locator(id);
              if (await vid.count() > 0) {
                const src = await vid.getAttribute('src').catch(() => null);
                if (src && src.includes('.mp4') && !initialVideoUrls.has(src)) {
                  this._usedUrls.add(src);
                  console.log(`[GROK] Video found via ${id}: ${src.substring(0, 100)}...`);
                  await this.page.waitForTimeout(5000);
                  return src;
                }
              }
            }
          } catch (e) {}

          // Fallback: generic video element selectors
          try {
            const videoSelectors = ['video[src*=".mp4"]', 'video source[src*=".mp4"]', '[data-video-url]', 'video'];
            for (const selector of videoSelectors) {
              const videos = this.page.locator(selector);
              const count = await videos.count();
              for (let i = 0; i < count; i++) {
                const video = videos.nth(i);
                let src = await video.getAttribute('src').catch(() => null);
                if (!src) src = await video.getAttribute('data-video-url').catch(() => null);
                if (!src) {
                  const source = video.locator('source').first();
                  if (await source.count() > 0) src = await source.getAttribute('src').catch(() => null);
                }
                if (src && src.includes('.mp4') && !initialVideoUrls.has(src)) {
                  this._usedUrls.add(src);
                  videoUrl = src;
                  await this.page.waitForTimeout(5000);
                  return videoUrl;
                }
              }
            }
          } catch (e) {}

          // Check page content
          try {
            const pageContent = await this.page.content();
            const videoPattern = /https?:\/\/[^\s"'<>]+generated_video\.mp4[^\s"'<>]*/g;
            const matches = pageContent.match(videoPattern);
            if (matches && matches.length > 0) {
              for (const m of matches) {
                const newUrl = m.replace(/&amp;/g, '&');
                if (!initialVideoUrls.has(newUrl)) {
                  this._usedUrls.add(newUrl);
                  videoUrl = newUrl;
                  await this.page.waitForTimeout(5000);
                  return videoUrl;
                }
              }
            }
          } catch (e) {}

          // Download button
          try {
            const downloadBtn = this.page.locator('button:has-text("Download"), [aria-label*="download" i], a[download]').first();
            if (await downloadBtn.count() > 0 && await downloadBtn.isVisible()) {
              const href = await downloadBtn.getAttribute('href').catch(() => null);
              if (href && href.includes('.mp4')) return href;

              try {
                const [download] = await Promise.all([
                  this.page.waitForEvent('download', { timeout: 10000 }),
                  downloadBtn.click()
                ]);
                if (download) {
                  const downloadUrl = download.url();
                  await download.cancel();
                  if (downloadUrl.startsWith('blob:')) {
                    if (elapsed >= 35) return downloadUrl;
                  } else {
                    return downloadUrl;
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        }

        await this.page.waitForTimeout(2000);
      }

      return null;
    } finally {
      this.page.off('response', responseHandler);
    }
  }

  async _downloadVideo(videoUrl, outputPath) {
    console.log(`[GROK] Downloading to ${path.basename(outputPath)}...`);

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Handle blob URLs
    if (videoUrl.startsWith('blob:')) {
      try {
        const videoData = await this.page.evaluate(async (blobUrl) => {
          try {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            return Array.from(new Uint8Array(arrayBuffer));
          } catch (e) { return null; }
        }, videoUrl);

        if (videoData && videoData.length > 500000) {
          const buffer = Buffer.from(videoData);
          fs.writeFileSync(outputPath, buffer);
          console.log(`[GROK] Downloaded via blob (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`);
          return true;
        }
      } catch (e) {}
      return false;
    }

    console.log(`[GROK] Video URL to download: ${videoUrl.substring(0, 150)}`);

    // Method 1: Browser-context fetch (uses page's full cookie jar — avoids 403)
    try {
      console.log('[GROK] Trying Method 1: Browser fetch...');
      const videoData = await this.page.evaluate(async (url) => {
        try {
          const response = await fetch(url, { credentials: 'include' });
          if (!response.ok) return { error: `${response.status} ${response.statusText}` };
          const blob = await response.blob();
          if (blob.size < 500000) return { error: `too small (${blob.size} bytes)` };
          const arrayBuffer = await blob.arrayBuffer();
          return { data: Array.from(new Uint8Array(arrayBuffer)), size: blob.size };
        } catch (e) { return { error: e.message }; }
      }, videoUrl);

      if (videoData && videoData.data) {
        const buffer = Buffer.from(videoData.data);
        fs.writeFileSync(outputPath, buffer);
        console.log(`[GROK] Downloaded via browser fetch (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`);
        return true;
      } else {
        console.log(`[GROK] Method 1 (fetch) failed: ${videoData?.error || 'no data'}`);
      }
    } catch (e) {
      console.log(`[GROK] Method 1 (fetch) failed: ${e.message}`);
    }

    // Method 2: Browser anchor click download
    try {
      console.log('[GROK] Trying Method 2: Browser anchor click...');
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: 30000 }),
        this.page.evaluate((url) => {
          const a = document.createElement('a');
          a.href = url;
          a.download = 'video.mp4';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }, videoUrl)
      ]);
      if (download) {
        await download.saveAs(outputPath);
        const stats = fs.statSync(outputPath);
        if (stats.size < 500000) {
          console.log(`[GROK] Anchor download too small (${stats.size} bytes), removing`);
          fs.unlinkSync(outputPath);
          return false;
        }
        console.log(`[GROK] Downloaded via anchor (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);
        return true;
      }
    } catch (e) {
      console.log(`[GROK] Method 2 (anchor) failed: ${e.message}`);
    }

    // Method 3: Use Grok's download button if visible
    try {
      console.log('[GROK] Trying Method 3: Download button...');
      const dlBtn = this.page.locator('button:has-text("Download"), [aria-label*="download" i], a[download]').first();
      if (await dlBtn.count() > 0 && await dlBtn.isVisible()) {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 15000 }),
          dlBtn.click()
        ]).catch(() => [null]);
        if (download) {
          await download.saveAs(outputPath);
          const stats = fs.statSync(outputPath);
          if (stats.size >= 500000) {
            console.log(`[GROK] Downloaded via button (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);
            return true;
          }
          fs.unlinkSync(outputPath);
        }
      }
    } catch (e) {
      console.log(`[GROK] Method 3 (button) failed: ${e.message}`);
    }

    return false;
  }

  async _downloadWithRetry(videoUrl, outputPath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[GROK] Download attempt ${attempt}/${maxRetries}...`);
      if (await this._downloadVideo(videoUrl, outputPath)) return true;
      if (attempt < maxRetries) {
        console.log(`[GROK] Download attempt ${attempt} failed, waiting 2s before retry...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log(`[GROK] All ${maxRetries} download attempts failed`);
    return false;
  }

  /**
   * Image-to-Video conversion
   */
  async convert(imagePath, outputPath, prompt, progressCallback, aspectRatio = '9:16', options = {}) {
    if (typeof prompt === 'function') {
      progressCallback = prompt;
      prompt = '';
    }

    const { duration, resolution } = options;
    const result = { success: false, videoUrl: null, outputPath, error: null, attempts: 0 };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      if (!this._running) break;
      result.attempts = attempt;

      try {
        if (attempt > 1) update(`Retry ${attempt}/${this.retryAttempts}...`, 5);

        if (!this.browser || !this.browser.isConnected()) {
          update('Starting browser...', 5);
          await this.start();
        } else {
          update('Opening fresh tab...', 5);
          await this._navigateToImagine();
        }

        update('Selecting video mode...', 10);
        await this._selectVideoMode();

        if (aspectRatio && aspectRatio !== '9:16') {
          update('Selecting aspect ratio...', 12);
          await this._selectAspectRatio(aspectRatio);
        }

        if (duration) {
          update('Selecting video duration...', 14);
          await this._selectVideoDuration(duration);
        }

        if (resolution) {
          update('Selecting video resolution...', 16);
          await this._selectVideoResolution(resolution);
        }

        update('Uploading image...', 20);
        if (!await this._uploadImage(imagePath)) {
          throw new Error('Failed to upload image');
        }

        update('Generating video...', 40);
        const videoUrl = await this._waitForVideoGeneration(180, resolution);

        if (!videoUrl) throw new Error('Video generation timed out');

        result.videoUrl = videoUrl;
        update('Downloading video...', 85);
        const downloadSuccess = await this._downloadWithRetry(videoUrl, outputPath);

        if (downloadSuccess) {
          update('Complete!', 100);
          result.success = true;
          return result;
        } else {
          result.downloadFailed = true;
          result.error = 'Download failed after retries';
          return result;
        }

      } catch (e) {
        result.error = e.message;
        console.log(`[GROK] Error: ${e.message}`);
        if (attempt < this.retryAttempts) {
          await this.page.waitForTimeout(2000);
          try { await this._navigateToImagine(); } catch (e) {}
        }
      }
    }

    update(`Failed after ${this.retryAttempts} attempts`, -1);
    return result;
  }

  /**
   * Text-to-Video generation (unique to Grok)
   */
  async textToVideo(prompt, outputDir, options = {}, progressCallback) {
    const { namingPattern = '{prompt}', aspectRatio = '9:16', duration, resolution } = options;
    const result = { success: false, videoPath: null, videoUrl: null, error: null };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    try {
      const safePrompt = prompt.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
      const timestamp = Date.now();
      let baseName = namingPattern
        .replace('{prompt}', safePrompt)
        .replace('{timestamp}', timestamp)
        .replace(/\.(mp4|png|jpg|jpeg)$/i, '');
      const videoPath = path.join(outputDir, `${baseName}.mp4`);

      if (!this.browser || !this.browser.isConnected()) {
        update('Starting browser...', 5);
        await this.start();
      } else {
        update('Opening fresh tab...', 5);
        await this._navigateToImagine();
      }

      update('Selecting video mode...', 10);
      await this._selectVideoMode();

      if (aspectRatio && aspectRatio !== '9:16') {
        update('Selecting aspect ratio...', 12);
        await this._selectAspectRatio(aspectRatio);
      }

      if (duration) {
        update('Selecting video duration...', 13);
        await this._selectVideoDuration(duration);
      }

      if (resolution) {
        update('Selecting video resolution...', 14);
        await this._selectVideoResolution(resolution);
      }

      update('Entering prompt...', 15);
      if (!await this._typePrompt(prompt)) {
        throw new Error('Could not find text input field');
      }

      update('Starting generation...', 20);
      await this._clickGenerateButton();

      update('Generating video...', 30);
      const videoUrl = await this._waitForVideoGeneration(180, resolution);

      if (!videoUrl) throw new Error('Video generation timed out');

      result.videoUrl = videoUrl;
      update('Downloading video...', 85);
      const downloadSuccess = await this._downloadWithRetry(videoUrl, videoPath);

      if (downloadSuccess) {
        update('Complete!', 100);
        result.success = true;
        result.videoPath = videoPath;
      } else {
        result.downloadFailed = true;
        result.error = 'Download failed after retries';
      }

    } catch (e) {
      result.error = e.message;
      console.log(`[GROK] Text-to-video error: ${e.message}`);
    }

    return result;
  }

  /**
   * Text-to-Image generation
   */
  async generateImage(prompt, outputPath, options = {}) {
    const { aspectRatio = '1:1', progressCallback } = typeof options === 'function'
      ? { progressCallback: options } : options;
    const result = { success: false, imagePath: null, error: null };
    const update = (stage, percent) => { if (progressCallback) progressCallback(stage, percent); };

    try {
      if (!this.browser || !this.browser.isConnected()) {
        update('Starting browser...', 5);
        await this.start();
      } else {
        update('Opening fresh tab...', 5);
        await this._navigateToImagine();
      }

      // Use the React-compatible _typePrompt method (fill() doesn't work with React)
      update('Entering prompt...', 15);
      if (!await this._typePrompt(prompt)) {
        throw new Error('Could not find text input');
      }

      // Select aspect ratio if not default
      if (aspectRatio && aspectRatio !== '1:1') {
        update('Setting aspect ratio...', 20);
        await this._selectAspectRatio(aspectRatio);
      }

      update('Generating image...', 25);
      // Try clicking generate button first
      const clicked = await this._clickGenerateButton();
      if (!clicked) {
        // Fallback: focus textarea and press Enter
        console.log('[GROK] Generate button not found, trying Enter on textarea');
        const ta = this.page.locator('textarea').first();
        if (await ta.count() > 0) {
          await ta.focus();
          await this.page.keyboard.press('Enter');
        }
      }

      await this.page.waitForTimeout(2000);

      update('Waiting for image...', 40);
      const imageInfo = await this._waitForImageGeneration(120);

      if (!imageInfo) {
        throw new Error('Image generation timed out');
      }

      update('Opening full resolution...', 70);
      const fullResUrl = await this._getFullResImage(imageInfo);

      update('Downloading image...', 85);
      const downloadUrl = fullResUrl || imageInfo.src;
      const downloadSuccess = await this._downloadImageFile(downloadUrl, outputPath);

      if (downloadSuccess) {
        update('Complete!', 100);
        result.success = true;
        result.imagePath = outputPath;
      } else {
        throw new Error('Failed to download image');
      }
    } catch (e) {
      result.error = e.message;
      console.log(`[GROK] Image generation error: ${e.message}`);
    }

    return result;
  }

  async _waitForImageGeneration(timeout = 120) {
    const startTime = Date.now();
    let lastLog = 0;
    let imageUrl = null;

    // Snapshot ALL image srcs on page before generation
    // For data: URIs, use length + middle sample as fingerprint (first bytes are identical for all JPEGs)
    const initialImageFingerprints = await this.page.evaluate(() => {
      const fps = new Set();
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || '';
        if (src.startsWith('data:')) {
          const mid = Math.floor(src.length / 2);
          fps.add('d:' + src.length + ':' + src.substring(mid, mid + 30));
        } else if (src.length > 5) {
          fps.add(src);
        }
      });
      return Array.from(fps);
    }).catch(() => []);
    const initialSet = new Set(initialImageFingerprints);
    // Merge previously-used image fingerprints to prevent stale re-downloads
    for (const fp of this._usedUrls) {
      initialSet.add(fp);
    }
    console.log(`[GROK] Snapshot: ${initialSet.size} unique image fingerprints (incl ${this._usedUrls.size} previously used)`);

    // Listen for image responses from Grok's servers
    const responseHandler = async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      const isImageResponse = contentType.includes('image') || url.match(/\.(png|jpg|jpeg|webp)(\?|$)/i);
      const isGrokImage = url.includes('/generated/') || url.includes('assets.grok') ||
                          url.includes('grok.com') || url.includes('x.ai');
      if (isImageResponse && isGrokImage && !url.includes('video') && !initialSet.has(url) && !this._usedUrls.has(url)) {
        console.log(`[GROK] Captured image response: ${url.substring(0, 100)}...`);
        this._usedUrls.add(url);
        imageUrl = url;
      }
    };
    this.page.on('response', responseHandler);

    try {
      while ((Date.now() - startTime) / 1000 < timeout) {
        if (!this._running) return null;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        if (elapsed - lastLog >= 10) {
          // Diagnostic: log current page URL + generated image count
          const diagInfo = await this.page.evaluate(() => {
            const genImgs = document.querySelectorAll('img[alt="Generated image"]');
            const allImgs = document.querySelectorAll('img');
            return {
              url: window.location.href,
              genCount: genImgs.length,
              totalImgs: allImgs.length
            };
          }).catch(() => ({ url: '?', genCount: -1, totalImgs: -1 }));
          console.log(`[GROK] Image wait: ${elapsed}s | URL: ${diagInfo.url} | Generated imgs: ${diagInfo.genCount} | Total imgs: ${diagInfo.totalImgs}`);
          lastLog = elapsed;
        }

        // If we captured a URL-based image from network, use it
        if (imageUrl) {
          await this.page.waitForTimeout(2000);
          this._usedUrls.add(imageUrl);
          return { src: imageUrl, isDataUri: false, index: -1 };
        }

        // After short wait, check DOM for new images
        if (elapsed >= 3) {
          // Scan ALL images on page, find any that weren't in our initial snapshot
          const newImage = await this.page.evaluate((knownFingerprints) => {
            const known = new Set(knownFingerprints);
            const allImgs = document.querySelectorAll('img');
            for (const img of allImgs) {
              const src = img.src || '';
              const w = img.naturalWidth || img.width || 0;
              const h = img.naturalHeight || img.height || 0;
              if (w < 100 || h < 100) continue; // skip tiny images

              // Create fingerprint the same way as initial snapshot
              let fp;
              if (src.startsWith('data:')) {
                const mid = Math.floor(src.length / 2);
                fp = 'd:' + src.length + ':' + src.substring(mid, mid + 30);
              } else if (src.length > 5) {
                fp = src;
              } else {
                continue;
              }

              if (!known.has(fp)) {
                // This is a NEW image not in the initial snapshot
                const alt = img.alt || '';
                const parentClass = (img.closest('div[class*="group"]') || {}).className || '';
                return {
                  src: src,
                  width: w,
                  height: h,
                  alt: alt,
                  parentClass: parentClass.substring(0, 80),
                  isDataUri: src.startsWith('data:')
                };
              }
            }
            return null;
          }, initialImageFingerprints).catch(() => null);

          if (newImage && newImage.src) {
            console.log(`[GROK] NEW image detected! ${newImage.width}x${newImage.height} alt="${newImage.alt}" isDataUri=${newImage.isDataUri} parent="${newImage.parentClass}"`);
            // Track fingerprint to prevent stale re-downloads
            let fp;
            if (newImage.isDataUri) {
              const mid = Math.floor(newImage.src.length / 2);
              fp = 'd:' + newImage.src.length + ':' + newImage.src.substring(mid, mid + 30);
            } else {
              fp = newImage.src;
            }
            this._usedUrls.add(fp);
            await this.page.waitForTimeout(1000);
            return newImage;
          }
        }

        await this.page.waitForTimeout(2000);
      }
      console.log('[GROK] Image generation timeout!');
      return null;
    } finally {
      this.page.off('response', responseHandler);
    }
  }

  async _getFullResImage(imageInfo) {
    console.log('[GROK] Attempting to get full-res image...');

    try {
      // Click on the generated image thumbnail to open the full-res viewer
      const clicked = await this.page.evaluate((info) => {
        // Find the new image by matching its fingerprint
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          if (!src) continue;

          // Match by data URI fingerprint or URL
          let match = false;
          if (info.isDataUri && src.startsWith('data:')) {
            const mid = Math.floor(src.length / 2);
            const fp = 'd:' + src.length + ':' + src.substring(mid, mid + 30);
            const infoMid = Math.floor(info.src.length / 2);
            const infoFp = 'd:' + info.src.length + ':' + info.src.substring(infoMid, infoMid + 30);
            match = (fp === infoFp);
          } else if (!info.isDataUri) {
            match = (src === info.src);
          }

          if (match) {
            img.click();
            return true;
          }
        }
        return false;
      }, imageInfo);

      if (!clicked) {
        console.log('[GROK] Could not find image to click');
        return null;
      }

      console.log('[GROK] Clicked thumbnail, waiting for full-res viewer...');
      await this.page.waitForTimeout(2000);

      // Look for full-res image in the viewer/modal
      // Strategy 1: Look for download button and get its URL
      const downloadUrl = await this.page.evaluate(() => {
        // Check for download button/link
        const downloadBtns = document.querySelectorAll('a[download], a[href*="download"], button[aria-label*="download" i], button[aria-label*="Download" i]');
        for (const btn of downloadBtns) {
          const href = btn.href || btn.getAttribute('href');
          if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
            return href;
          }
        }
        return null;
      }).catch(() => null);

      if (downloadUrl) {
        console.log(`[GROK] Found download URL: ${downloadUrl.substring(0, 80)}...`);
        return downloadUrl;
      }

      // Strategy 2: Find the largest image in the modal/overlay (full-res version)
      const fullResResult = await this.page.evaluate(() => {
        // Look for overlay/modal images — typically a large image on top of the page
        const candidates = [];
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w < 200 || h < 200) continue;

          // Check if this image is in an overlay/modal-like container
          const rect = img.getBoundingClientRect();
          const isOverlay = rect.width > window.innerWidth * 0.4;
          const isLarge = (w * h) > 500000;

          if (isOverlay || isLarge) {
            candidates.push({
              src,
              width: w,
              height: h,
              displayWidth: Math.round(rect.width),
              isDataUri: src.startsWith('data:'),
              size: src.length
            });
          }
        }

        // Sort by actual pixel count (naturalWidth * naturalHeight), take largest
        candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));

        // Prefer non-data: URLs (actual full-res URLs) over data: URIs
        const urlCandidate = candidates.find(c => !c.isDataUri);
        if (urlCandidate) return urlCandidate.src;

        // Otherwise take the largest data: URI (bigger base64 = higher quality)
        if (candidates.length > 0) {
          candidates.sort((a, b) => b.size - a.size);
          return candidates[0].src;
        }

        return null;
      }).catch(() => null);

      if (fullResResult && fullResResult !== imageInfo.src) {
        const isHigher = fullResResult.length > imageInfo.src.length;
        console.log(`[GROK] Found full-res candidate (${isHigher ? 'higher' : 'same'} quality): ${fullResResult.substring(0, 80)}...`);
        return fullResResult;
      }

      // Strategy 3: Try clicking the download icon directly
      try {
        const dlBtn = this.page.locator('button:has-text("Download"), [aria-label*="download" i], [aria-label*="Download"]').first();
        if (await dlBtn.count() > 0 && await dlBtn.isVisible()) {
          console.log('[GROK] Found download button, clicking...');
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 10000 }),
            dlBtn.click()
          ]).catch(() => [null]);

          if (download) {
            const dlUrl = download.url();
            console.log(`[GROK] Download triggered: ${dlUrl.substring(0, 80)}...`);
            await download.cancel();
            return dlUrl || '__use_download_event__';
          }
        }
      } catch (e) {
        console.log('[GROK] No download button found');
      }

      console.log('[GROK] Could not find higher resolution, using original');
      return null;

    } catch (e) {
      console.log(`[GROK] Full-res attempt error: ${e.message}`);
      return null;
    }
  }

  async _downloadImageFile(imageUrl, outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Method 1: Try using Grok's download button (we already opened the viewer in _getFullResImage)
    try {
      const dlBtn = this.page.locator('a[download], a[href*="/generated/"][href*="download"], button:has-text("Download"), [aria-label*="ownload"]').first();
      if (await dlBtn.count() > 0 && await dlBtn.isVisible()) {
        console.log('[GROK] Using download button...');
        const href = await dlBtn.getAttribute('href').catch(() => null);
        if (href && href.startsWith('http')) {
          // Direct download link
          const response = await this.page.request.get(href, {
            headers: { 'Referer': 'https://grok.com/' }
          });
          if (response.ok()) {
            const body = await response.body();
            if (body.length > 10000) {
              fs.writeFileSync(outputPath, body);
              console.log(`[GROK] Saved via download link (${(body.length / 1024).toFixed(0)} KB)`);
              return true;
            }
          }
        }

        // Click download button to trigger browser download
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 15000 }),
          dlBtn.click()
        ]).catch(() => [null]);
        if (download) {
          await download.saveAs(outputPath);
          const stats = fs.statSync(outputPath);
          console.log(`[GROK] Saved via download button (${(stats.size / 1024).toFixed(0)} KB)`);
          if (stats.size > 10000) return true;
        }
      }
    } catch (e) {
      console.log(`[GROK] Download button method failed: ${e.message}`);
    }

    // Method 2: Handle base64 data URI (low-quality thumbnail fallback)
    if (imageUrl.startsWith('data:')) {
      try {
        const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
          const base64Data = matches[2];
          const buffer = Buffer.from(base64Data, 'base64');
          const actualPath = outputPath.replace(/\.\w+$/, `.${ext}`);
          fs.writeFileSync(actualPath, buffer);
          console.log(`[GROK] Saved base64 image (${(buffer.length / 1024).toFixed(0)} KB) to ${path.basename(actualPath)}`);
          return true;
        }
      } catch (e) {
        console.log(`[GROK] Base64 decode error: ${e.message}`);
      }
      return false;
    }

    // Method 3: URL-based image — fetch directly
    try {
      const response = await this.page.request.get(imageUrl, {
        headers: { 'Accept': 'image/*,*/*', 'Referer': 'https://grok.com/' }
      });
      if (response.ok()) {
        const body = await response.body();
        if (body.length > 10000) {
          fs.writeFileSync(outputPath, body);
          console.log(`[GROK] Saved via direct fetch (${(body.length / 1024).toFixed(0)} KB)`);
          return true;
        }
      }
    } catch (e) {}

    // Method 4: Browser anchor download
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 15000 }),
          this.page.evaluate((url) => {
            const a = document.createElement('a');
            a.href = url;
            a.download = 'image.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }, imageUrl)
        ]);
        if (download) {
          await download.saveAs(outputPath);
          console.log(`[GROK] Saved via browser download`);
          return true;
        }
      } catch (e) {
        if (attempt < 3) await this.page.waitForTimeout(2000);
      }
    }

    return false;
  }
}

module.exports = { GrokConverter };
