const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

class MetaConverter {
  constructor(cookies, options = {}) {
    this.cookies = cookies;
    this.headless = options.headless !== false;
    this.retryAttempts = options.retryAttempts || 3;
    this.delayBetween = options.delayBetween || 10;

    this.browser = null;
    this.context = null;
    this.page = null;
    this._running = false;
    this._progressCallback = null;
    this._usedUrls = new Set(); // Track downloaded URLs to prevent re-downloading stale content
    this._startLock = null; // Prevents parallel start() race conditions
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

  // Map aspect ratio to Meta AI orientation value
  _getOrientationFromRatio(ratio) {
    const orientationMap = {
      '16:9': 'LANDSCAPE',
      '9:16': 'VERTICAL',
      '1:1': 'SQUARE'
    };
    return orientationMap[ratio] || 'VERTICAL';
  }

  // Set up request interception to inject orientation into GraphQL requests
  async _setupOrientationInterceptor(orientation) {
    console.log(`[META][INTERCEPT] Setting up orientation interceptor: ${orientation}`);

    try {
      await this.page.unroute('**/api/graphql');
    } catch (e) {
      // No existing route
    }

    await this.page.route('**/api/graphql', async (route, request) => {
      const postData = request.postData();

      if (postData && postData.includes('TEXT_TO_IMAGE')) {
        console.log('[META][INTERCEPT] Found TEXT_TO_IMAGE request, injecting orientation...');

        try {
          let body = JSON.parse(postData);
          let modified = false;

          const injectOrientation = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            if (obj.textToImageParams) {
              obj.textToImageParams.orientation = orientation;
              modified = true;
              return;
            }
            if (obj.imagineOperationRequest && obj.imagineOperationRequest.textToImageParams) {
              obj.imagineOperationRequest.textToImageParams.orientation = orientation;
              modified = true;
              return;
            }
            for (const key of Object.keys(obj)) {
              if (typeof obj[key] === 'object' && obj[key] !== null) {
                injectOrientation(obj[key]);
              }
            }
          };

          injectOrientation(body);

          if (modified) {
            console.log('[META][INTERCEPT] Orientation injected successfully');
          }

          await route.continue({ postData: JSON.stringify(body) });
          return;
        } catch (e) {
          console.log('[META][INTERCEPT] Failed to modify request:', e.message);
        }
      }

      await route.continue();
    });
  }

  async _removeOrientationInterceptor() {
    try {
      await this.page.unroute('**/api/graphql');
    } catch (e) {
      // Ignore
    }
  }

  async start(targetUrl = 'https://www.meta.ai') {
    if (this.browser && this.browser.isConnected()) return;

    // Prevent parallel start() calls from racing
    if (this._startLock) return this._startLock;
    this._startLock = this._doStart(targetUrl);
    try {
      await this._startLock;
    } finally {
      this._startLock = null;
    }
  }

  async _doStart(targetUrl) {
    console.log('[META] Starting browser...');

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

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const cookieList = [];
    for (const [name, value] of Object.entries(this.cookies)) {
      if (value) {
        cookieList.push({ name, value, domain: '.meta.ai', path: '/' });
      }
    }
    await this.context.addCookies(cookieList);

    // Create a temp page to verify login
    this.page = await this.context.newPage();

    console.log(`[META] Navigating to ${targetUrl}...`);
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForTimeout(2000);

    const currentUrl = this.page.url();
    console.log('[META] Current URL:', currentUrl);

    if (currentUrl.toLowerCase().includes('login') ||
        currentUrl.toLowerCase().includes('auth') ||
        currentUrl.toLowerCase().includes('facebook.com') ||
        currentUrl.toLowerCase().includes('checkpoint')) {
      throw new Error(`Not logged in. Redirected to: ${currentUrl}`);
    }

    // Check for guest state
    try {
      const guestIndicators = [
        'text="Log in"', 'text="Sign up"', 'text="Continue with Facebook"',
        '[aria-label="Log in"]', '[aria-label="Sign up"]'
      ];
      for (const selector of guestIndicators) {
        const element = this.page.locator(selector).first();
        if (await element.count() > 0 && await element.isVisible()) {
          throw new Error('Not logged in. Please provide valid cookies.');
        }
      }
      console.log('[META] Logged in state verified');
    } catch (e) {
      if (e.message.includes('Not logged in')) throw e;
    }

    // Close the login-check page — convert() will create its own tabs
    await this.page.close();
    this.page = null;

    console.log('[META] Ready!');
    this._running = true;
  }

  async stop() {
    this._running = false;
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (e) {
      console.error('[META] Error closing:', e);
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    console.log('[META] Closed.');
  }

  async validateSession() {
    try {
      await this.start();
      return true;
    } catch (e) {
      console.log('[META] Validation failed:', e.message);
      return false;
    } finally {
      await this.stop();
    }
  }

  async _goToHome() {
    console.log('[META] Returning to home...');
    try {
      await this.page.goto('https://www.meta.ai', { waitUntil: 'networkidle', timeout: 30000 });
      await this.page.waitForTimeout(1500);
    } catch (e) {
      await this.page.goto('https://www.meta.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(2000);
    }

    // Click "New chat" button to reset conversation state
    try {
      const newChatBtn = this.page.locator('[data-testid="new-chat-button"]').first();
      if (await newChatBtn.count() > 0) {
        await newChatBtn.click();
        await this.page.waitForTimeout(1500);
        console.log('[META] Clicked New Chat - fresh conversation');
      }
    } catch (e) {
      console.log('[META] Could not click New Chat button:', e.message);
    }
  }

  async _goToImageCreator() {
    console.log('[META] Going to image creator (meta.ai/media)...');
    await this.page.goto('https://www.meta.ai/media', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(3000);

    const inputSelectors = [
      'textarea[placeholder*="Describe"]', 'textarea[placeholder*="describe"]',
      'div[contenteditable="true"]', '[data-placeholder*="Describe"]', 'textarea'
    ];
    for (const selector of inputSelectors) {
      try {
        const input = this.page.locator(selector).first();
        if (await input.count() > 0 && await input.isVisible()) {
          await input.click();
          await this.page.waitForTimeout(1000);
          break;
        }
      } catch (e) { continue; }
    }
  }

  async _uploadImage(imagePath) {
    console.log(`[META] Uploading ${path.basename(imagePath)}...`);

    try {
      const fileInput = this.page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(imagePath);
        await this.page.waitForTimeout(1500);
        console.log('[META] Upload done via file input');
        return true;
      }
    } catch (e) {}

    const plusSelectors = [
      'div[aria-label="Add"]', 'button:has-text("+")',
      '[data-testid="add-button"]', 'div[role="button"]:has-text("+")'
    ];
    for (const selector of plusSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          await this.page.waitForTimeout(500);
          const fileInput = this.page.locator('input[type="file"]').first();
          await fileInput.setInputFiles(imagePath);
          await this.page.waitForTimeout(1500);
          return true;
        }
      } catch (e) { continue; }
    }

    return false;
  }

  async _clickVideoMode() {
    console.log('[META] Switching to Video...');
    const videoSelectors = [
      'text=Video', 'button:has-text("Video")',
      'div:has-text("Video"):not(:has(*))', '[aria-label*="Video"]'
    ];
    for (const selector of videoSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          await this.page.waitForTimeout(800);
          console.log('[META] Video mode selected');
          return true;
        }
      } catch (e) { continue; }
    }
    return false;
  }

  async _selectMediaMode(mode) {
    console.log(`[META] Selecting media mode: ${mode}...`);

    const buttons = this.page.locator('div[role="button"], button');
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      try {
        const btn = buttons.nth(i);
        const text = (await btn.textContent().catch(() => '')).trim();
        if (text !== 'Image' && text !== 'Video') continue;

        const box = await btn.boundingBox();
        if (!box || box.y < 500) continue; // Must be in bottom toolbar

        if (text === mode) {
          console.log(`[META] Already in ${mode} mode`);
          return true;
        }

        // Click to open dropdown
        await btn.click();
        await this.page.waitForTimeout(800);

        // Select target mode from dropdown
        const optionSelectors = [
          `div[role="menuitem"]:has-text("${mode}")`,
          `div[role="option"]:has-text("${mode}")`,
          `li:has-text("${mode}")`,
          `div:has-text("${mode}"):not(:has(*))`
        ];

        for (const optSel of optionSelectors) {
          try {
            const opt = this.page.locator(optSel).first();
            if (await opt.count() > 0 && await opt.isVisible()) {
              await opt.click();
              await this.page.waitForTimeout(800);
              console.log(`[META] ${mode} mode selected`);
              return true;
            }
          } catch (e) { continue; }
        }

        // Keyboard fallback
        try {
          await this.page.keyboard.press('ArrowDown');
          await this.page.waitForTimeout(300);
          await this.page.keyboard.press('Enter');
          await this.page.waitForTimeout(500);
          console.log(`[META] ${mode} mode selected (keyboard)`);
          return true;
        } catch (e) {}
      } catch (e) { continue; }
    }

    // Fallback: try clicking any element with exact text
    console.log(`[META] Could not find mode selector, trying direct text click...`);
    try {
      const target = this.page.locator(`text="${mode}"`).first();
      if (await target.count() > 0) {
        await target.click();
        await this.page.waitForTimeout(800);
        return true;
      }
    } catch (e) {}

    return false;
  }

  async _selectMediaAspectRatio(ratio) {
    console.log(`[META] Selecting aspect ratio: ${ratio}...`);

    const ratioValues = ['1:1', '9:16', '16:9'];
    const buttons = this.page.locator('div[role="button"], button');
    const count = await buttons.count();

    for (let i = 0; i < count; i++) {
      try {
        const btn = buttons.nth(i);
        const text = (await btn.textContent().catch(() => '')).trim();
        if (!ratioValues.includes(text)) continue;

        const box = await btn.boundingBox();
        if (!box || box.y < 500) continue; // Must be in bottom toolbar

        if (text === ratio) {
          console.log(`[META] Already set to ${ratio}`);
          return true;
        }

        // Click to open dropdown
        await btn.click();
        await this.page.waitForTimeout(800);

        // Select target ratio
        const optionSelectors = [
          `div[role="menuitem"]:has-text("${ratio}")`,
          `div[role="option"]:has-text("${ratio}")`,
          `li:has-text("${ratio}")`,
          `div:has-text("${ratio}"):not(:has(*))`
        ];

        for (const optSel of optionSelectors) {
          try {
            const opt = this.page.locator(optSel).first();
            if (await opt.count() > 0 && await opt.isVisible()) {
              await opt.click();
              await this.page.waitForTimeout(800);
              console.log(`[META] Aspect ratio ${ratio} selected`);
              return true;
            }
          } catch (e) { continue; }
        }

        // Keyboard fallback
        try {
          const targetIndex = ratioValues.indexOf(ratio);
          const currentIndex = ratioValues.indexOf(text);
          const steps = targetIndex - currentIndex;
          const key = steps > 0 ? 'ArrowDown' : 'ArrowUp';
          for (let s = 0; s < Math.abs(steps); s++) {
            await this.page.keyboard.press(key);
            await this.page.waitForTimeout(200);
          }
          await this.page.keyboard.press('Enter');
          await this.page.waitForTimeout(500);
          console.log(`[META] Aspect ratio ${ratio} selected (keyboard)`);
          return true;
        } catch (e) {}

        break; // Found the ratio button, don't keep searching
      } catch (e) { continue; }
    }

    console.log(`[META] Could not find aspect ratio selector`);
    return false;
  }

  async _uploadImageOnMediaPage(imagePath) {
    console.log(`[META] Uploading image on media page: ${path.basename(imagePath)}...`);

    // Priority 1: Direct file input
    try {
      const fileInput = this.page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(imagePath);
        await this.page.waitForTimeout(2000);
        console.log('[META] Upload done via file input');
        return true;
      }
    } catch (e) {}

    // Priority 2: Click "+" button in toolbar (position-filtered)
    const plusSelectors = [
      '[aria-label="Add"]', '[aria-label="Upload"]', '[aria-label="Attach"]',
      '[aria-label="add"]', '[aria-label="upload"]', '[aria-label="attach"]',
      'div[role="button"]:has-text("+")', 'button:has-text("+")'
    ];

    for (const selector of plusSelectors) {
      try {
        const btns = this.page.locator(selector);
        const btnCount = await btns.count();
        for (let i = 0; i < btnCount; i++) {
          const btn = btns.nth(i);
          const box = await btn.boundingBox();
          if (!box || box.y < 500) continue; // Must be in bottom toolbar

          // Try filechooser event
          try {
            const [fileChooser] = await Promise.all([
              this.page.waitForEvent('filechooser', { timeout: 5000 }),
              btn.click()
            ]);
            await fileChooser.setFiles(imagePath);
            await this.page.waitForTimeout(2000);
            console.log('[META] Upload done via filechooser event');
            return true;
          } catch (e) {
            // filechooser didn't fire, try file input that may have appeared
            try {
              const fileInput = this.page.locator('input[type="file"]').first();
              if (await fileInput.count() > 0) {
                await fileInput.setInputFiles(imagePath);
                await this.page.waitForTimeout(2000);
                console.log('[META] Upload done via revealed file input');
                return true;
              }
            } catch (e2) {}
          }
        }
      } catch (e) { continue; }
    }

    // Priority 3: Fall back to existing _uploadImage method
    console.log('[META] Falling back to _uploadImage()...');
    return await this._uploadImage(imagePath);
  }

  async _typePromptAndAnimate(prompt) {
    console.log(`[META] Prompt: ${prompt.substring(0, 40)}...`);

    const inputSelectors = [
      'textarea[placeholder*="animation" i]', 'textarea[placeholder*="Describe" i]',
      'input[placeholder*="animation" i]', 'div[contenteditable="true"]', 'textarea'
    ];
    for (const selector of inputSelectors) {
      try {
        const elem = this.page.locator(selector).first();
        if (await elem.count() > 0 && await elem.isVisible()) {
          await elem.fill(prompt);
          await this.page.waitForTimeout(500);
          break;
        }
      } catch (e) { continue; }
    }

    const animateSelectors = [
      '[aria-label="Send"]', 'button:has-text("Animate")',
      'div[role="button"]:has-text("Animate")', '[aria-label*="Animate" i]',
      'button[type="submit"]', 'button:has-text("Generate")', '[aria-label*="send" i]'
    ];

    for (const selector of animateSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          console.log(`[META] Started animation`);
          return true;
        }
      } catch (e) { continue; }
    }

    // Force click pass
    for (const selector of animateSelectors) {
      try {
        const btn = this.page.locator(selector).first();
        if (await btn.count() > 0) {
          try { await btn.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch (e) {}
          await this.page.waitForTimeout(300);
          await btn.click({ force: true, timeout: 5000 });
          return true;
        }
      } catch (e) { continue; }
    }

    // Enter key fallback
    try {
      await this.page.keyboard.press('Enter');
      return true;
    } catch (e) {}

    return false;
  }

  async _waitForVideo(timeout = 180, preAnimationMsgCount = 0, outputPath = null) {
    console.log(`[META] Waiting for video (max ${timeout}s, pre-animation msgs: ${preAnimationMsgCount})...`);

    const startTime = Date.now();
    let lastLog = 0;
    let messageContainerId = null;

    while ((Date.now() - startTime) / 1000 < timeout) {
      if (!this._running) return null;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      if (elapsed - lastLog >= 15) {
        console.log(`[META] ${elapsed}s elapsed...`);
        lastLog = elapsed;
      }

      // Minimum wait: 20 seconds for generation to start
      if (elapsed < 20) {
        await this.page.waitForTimeout(2000);
        continue;
      }

      // Find the NEW message container (after pre-animation count)
      if (!messageContainerId) {
        try {
          const allMsgs = this.page.locator('[data-message-id$="_assistant"]');
          const count = await allMsgs.count();
          if (count > preAnimationMsgCount) {
            const newMsg = allMsgs.nth(count - 1);
            messageContainerId = await newMsg.getAttribute('data-message-id');
            console.log(`[META] Tracking new message: ${messageContainerId} (total: ${count}, pre: ${preAnimationMsgCount})`);
          }
        } catch (e) {}
      }

      // PRIORITY 1: data-video-url attribute (scoped to new message)
      try {
        if (messageContainerId) {
          const container = this.page.locator(`[data-message-id="${messageContainerId}"]`);
          const videoElem = container.locator('[data-testid="generated-video"]');
          if (await videoElem.count() > 0) {
            const videoUrlAttr = await videoElem.getAttribute('data-video-url');
            if (videoUrlAttr && videoUrlAttr.includes('.mp4')) {
              const decodedUrl = videoUrlAttr.replace(/&amp;/g, '&');
              console.log(`[META] Found via data-video-url! (${elapsed}s)`);
              this._usedUrls.add(decodedUrl);
              await this.page.waitForTimeout(2000);
              return decodedUrl;
            }
          }
        }
      } catch (e) {}

      // PRIORITY 2: URL pattern in container HTML (scoped to new message)
      try {
        if (messageContainerId) {
          const container = this.page.locator(`[data-message-id="${messageContainerId}"]`);
          const containerHtml = await container.innerHTML();
          const videoUrlPattern = /https:\/\/video-[^.]+\.xx\.fbcdn\.net\/[^\s"'<>]+\.mp4[^\s"'<>]*/g;
          const matches = containerHtml.match(videoUrlPattern);
          if (matches && matches.length > 0) {
            const decodedUrl = matches[0].replace(/&amp;/g, '&');
            console.log(`[META] Found via URL pattern! (${elapsed}s)`);
            this._usedUrls.add(decodedUrl);
            await this.page.waitForTimeout(2000);
            return decodedUrl;
          }
        }
      } catch (e) {}

      // PRIORITY 3: Download button click (after 45s, scoped to new message)
      try {
        if (messageContainerId && elapsed > 45) {
          const container = this.page.locator(`[data-message-id="${messageContainerId}"]`);
          await container.hover();
          await this.page.waitForTimeout(500);

          const downloadBtn = container.locator('[aria-label="Download"]').first();
          if (await downloadBtn.count() > 0) {
            console.log(`[META] Found download button, clicking... (${elapsed}s)`);

            const [download] = await Promise.all([
              this.page.waitForEvent('download', { timeout: 10000 }),
              downloadBtn.click()
            ]);

            const url = download.url();
            console.log(`[META] Download URL type: ${url ? (url.startsWith('blob:') ? 'blob' : 'http') : 'none'} (${elapsed}s)`);

            if (url && url.startsWith('blob:')) {
              if (outputPath) {
                await download.saveAs(outputPath);
                console.log(`[META] Saved via blob download.saveAs (${elapsed}s)`);
                return 'DIRECT_SAVE:' + outputPath;
              }
              await download.cancel();
            } else if (url && url.includes('.mp4')) {
              this._usedUrls.add(url);
              await download.cancel();
              await this.page.waitForTimeout(2000);
              return url;
            } else {
              await download.cancel();
            }
          }
        }
      } catch (e) {
        if (elapsed > 50) {
          console.log('[META] Download button attempt failed:', e.message);
        }
      }

      await this.page.waitForTimeout(1500);
    }

    console.log('[META] Timeout!');
    return null;
  }

  /**
   * Snapshot all video URLs currently on the page (gallery content) before submitting.
   * Any URL in this set is pre-existing and must NOT be treated as new generation output.
   */
  async _captureExistingVideoUrls() {
    const existing = new Set();
    try {
      const urls = await this.page.evaluate(() => {
        const found = [];
        // data-video-url attributes
        document.querySelectorAll('[data-video-url]').forEach(el => {
          const u = el.getAttribute('data-video-url');
          if (u) found.push(u.replace(/&amp;/g, '&'));
        });
        // <video> element srcs
        document.querySelectorAll('video').forEach(v => {
          if (v.src && v.src.startsWith('http')) found.push(v.src);
          if (v.currentSrc && v.currentSrc.startsWith('http')) found.push(v.currentSrc);
          const source = v.querySelector('source');
          if (source && source.src && source.src.startsWith('http')) found.push(source.src);
        });
        // fbcdn video URLs in full HTML
        const html = document.documentElement.innerHTML;
        const pattern = /https:\/\/video-[^.]+\.xx\.fbcdn\.net\/[^\s"'<>]+\.mp4[^\s"'<>]*/g;
        const matches = html.match(pattern);
        if (matches) matches.forEach(m => found.push(m.replace(/&amp;/g, '&')));
        return found;
      });
      urls.forEach(u => existing.add(u));
    } catch (e) {
      console.log('[META][MEDIA] Warning: could not snapshot existing video URLs:', e.message);
    }
    console.log(`[META][MEDIA] Snapshotted ${existing.size} pre-existing video URLs`);
    return existing;
  }

  async _waitForVideoOnMediaPage(timeout = 180, outputPath = null, preExistingVideoUrls = new Set()) {
    console.log(`[META][MEDIA] Waiting for video on media page (max ${timeout}s, ${preExistingVideoUrls.size} pre-existing excluded)...`);

    const startTime = Date.now();
    let lastLog = 0;

    // Helper: is this URL stale (pre-existing gallery content or already downloaded)?
    const isStaleUrl = (url) => {
      if (this._usedUrls.has(url)) return true;
      if (preExistingVideoUrls.has(url)) return true;
      // Also check without query params — gallery URLs may appear with different cache-busting params
      const baseUrl = url.split('?')[0];
      for (const existing of preExistingVideoUrls) {
        if (existing.split('?')[0] === baseUrl) return true;
      }
      return false;
    };

    // Network interceptor — only accept URLs not in pre-existing snapshot
    let capturedVideoUrl = null;
    const responseHandler = (response) => {
      try {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if ((ct.includes('video') || url.includes('.mp4')) && url.startsWith('http')) {
          if (isStaleUrl(url)) {
            console.log(`[META][MEDIA] Network (pre-existing, skipped): ${url.substring(0, 80)}...`);
          } else {
            console.log(`[META][MEDIA] Network captured NEW video: ${url.substring(0, 120)}...`);
            capturedVideoUrl = url;
          }
        }
      } catch (e) {}
    };
    this.page.on('response', responseHandler);

    try {
      while ((Date.now() - startTime) / 1000 < timeout) {
        if (!this._running) return null;

        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        if (elapsed - lastLog >= 15) {
          console.log(`[META][MEDIA] ${elapsed}s elapsed...`);
          lastLog = elapsed;
        }

        if (elapsed < 15) {
          await this.page.waitForTimeout(2000);
          continue;
        }

        // PRIORITY 1: Network interceptor captured URL
        if (capturedVideoUrl && !isStaleUrl(capturedVideoUrl)) {
          console.log(`[META][MEDIA] Found via network interceptor! (${elapsed}s)`);
          this._usedUrls.add(capturedVideoUrl);
          await this.page.waitForTimeout(2000);
          return capturedVideoUrl;
        }

        // PRIORITY 2: DOM <video> elements and data-video-url attributes (filter against snapshot)
        try {
          const allVideoUrls = await this.page.evaluate(() => {
            const found = [];
            document.querySelectorAll('[data-video-url]').forEach(el => {
              const url = el.getAttribute('data-video-url');
              if (url && url.includes('.mp4')) found.push({ type: 'attr', url: url.replace(/&amp;/g, '&') });
            });
            document.querySelectorAll('video').forEach(v => {
              if (v.src && v.src.startsWith('http')) found.push({ type: 'video', url: v.src });
              if (v.currentSrc && v.currentSrc.startsWith('http')) found.push({ type: 'video', url: v.currentSrc });
              const source = v.querySelector('source');
              if (source && source.src && source.src.startsWith('http')) found.push({ type: 'source', url: source.src });
            });
            return found;
          }).catch(() => []);

          for (const entry of allVideoUrls) {
            if (!isStaleUrl(entry.url)) {
              console.log(`[META][MEDIA] Found NEW via DOM ${entry.type}! (${elapsed}s)`);
              this._usedUrls.add(entry.url);
              await this.page.waitForTimeout(2000);
              return entry.url;
            }
          }
        } catch (e) {}

        // PRIORITY 3: fbcdn.net URL regex on page content (filter against snapshot)
        try {
          const pageHtml = await this.page.content();
          const videoUrlPattern = /https:\/\/video-[^.]+\.xx\.fbcdn\.net\/[^\s"'<>]+\.mp4[^\s"'<>]*/g;
          const matches = pageHtml.match(videoUrlPattern);
          if (matches && matches.length > 0) {
            for (const match of matches) {
              const decodedUrl = match.replace(/&amp;/g, '&');
              if (!isStaleUrl(decodedUrl)) {
                console.log(`[META][MEDIA] Found NEW via URL pattern! (${elapsed}s)`);
                this._usedUrls.add(decodedUrl);
                await this.page.waitForTimeout(2000);
                return decodedUrl;
              }
            }
          }
        } catch (e) {}

        // PRIORITY 4: Download button click (after 60s — longer delay to avoid clicking gallery buttons)
        if (elapsed > 60) {
          try {
            const downloadBtn = this.page.locator('[aria-label="Download"]').first();
            if (await downloadBtn.count() > 0 && await downloadBtn.isVisible()) {
              console.log(`[META][MEDIA] Trying download button (${elapsed}s)`);

              try {
                const [download] = await Promise.all([
                  this.page.waitForEvent('download', { timeout: 10000 }),
                  downloadBtn.click()
                ]);

                const url = download.url();

                if (url && url.startsWith('blob:')) {
                  if (outputPath) {
                    await download.saveAs(outputPath);
                    console.log(`[META][MEDIA] Saved via blob download.saveAs (${elapsed}s)`);
                    return 'DIRECT_SAVE:' + outputPath;
                  }
                  await download.cancel();
                } else if (url && url.includes('.mp4')) {
                  if (!isStaleUrl(url)) {
                    this._usedUrls.add(url);
                    await download.cancel();
                    await this.page.waitForTimeout(2000);
                    return url;
                  }
                  await download.cancel();
                } else {
                  await download.cancel();
                }
              } catch (dlError) {
                console.log(`[META][MEDIA] Download event not triggered (${elapsed}s)`);

                try { await downloadBtn.click(); } catch (e) {}
                await this.page.waitForTimeout(3000);

                if (capturedVideoUrl && !isStaleUrl(capturedVideoUrl)) {
                  console.log(`[META][MEDIA] Network caught video after button click (${elapsed}s)`);
                  this._usedUrls.add(capturedVideoUrl);
                  return capturedVideoUrl;
                }

                const jsVideoUrl = await this.page.evaluate(() => {
                  const videos = document.querySelectorAll('video');
                  for (const v of videos) {
                    if (v.src && v.src.startsWith('http') && v.src.includes('.mp4')) return v.src;
                    if (v.currentSrc && v.currentSrc.startsWith('http')) return v.currentSrc;
                    const source = v.querySelector('source');
                    if (source && source.src) return source.src;
                  }
                  for (const v of videos) {
                    if (v.src && v.src.startsWith('blob:')) return v.src;
                  }
                  return null;
                }).catch(() => null);

                if (jsVideoUrl && jsVideoUrl.startsWith('blob:') && outputPath) {
                  console.log(`[META][MEDIA] Found blob video, downloading... (${elapsed}s)`);
                  const blobData = await this.page.evaluate(async (blobUrl) => {
                    try {
                      const resp = await fetch(blobUrl);
                      const blob = await resp.blob();
                      const reader = new FileReader();
                      return new Promise((resolve) => {
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.readAsDataURL(blob);
                      });
                    } catch (e) { return null; }
                  }, jsVideoUrl).catch(() => null);

                  if (blobData) {
                    const dir = path.dirname(outputPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(outputPath, Buffer.from(blobData, 'base64'));
                    console.log(`[META][MEDIA] Saved blob video via JS extraction (${elapsed}s)`);
                    return 'DIRECT_SAVE:' + outputPath;
                  }
                } else if (jsVideoUrl && jsVideoUrl.startsWith('http') && !isStaleUrl(jsVideoUrl)) {
                  console.log(`[META][MEDIA] Found video URL via JS extraction (${elapsed}s)`);
                  this._usedUrls.add(jsVideoUrl);
                  return jsVideoUrl;
                }
              }
            }
          } catch (e) {
            if (elapsed > 65) {
              console.log('[META][MEDIA] Download button attempt failed:', e.message);
            }
          }
        }

        await this.page.waitForTimeout(2000);
      }

      console.log('[META][MEDIA] Timeout!');
      return null;
    } finally {
      this.page.removeListener('response', responseHandler);
    }
  }

  async _downloadVideo(videoUrl, outputPath) {
    console.log(`[META] Downloading to ${path.basename(outputPath)}...`);

    try {
      const response = await this.page.request.get(videoUrl);
      if (response.ok()) {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const body = await response.body();
        fs.writeFileSync(outputPath, body);
        const sizeMb = body.length / (1024 * 1024);
        console.log(`[META] Downloaded (${sizeMb.toFixed(1)} MB)`);
        return true;
      }
    } catch (e) {
      console.log('[META] Download error:', e.message);
    }
    return false;
  }

  async _downloadWithRetry(videoUrl, outputPath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[META] Download attempt ${attempt}/${maxRetries}...`);
      if (await this._downloadVideo(videoUrl, outputPath)) return true;
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Image-to-Video conversion — parallel-safe (each call gets its own tab)
   */
  async convert(imagePath, outputPath, prompt, progressCallback, aspectRatio = '9:16') {
    const result = {
      success: false, videoUrl: null, outputPath, error: null, attempts: 0
    };
    const tag = `[META][${path.basename(imagePath, path.extname(imagePath)).substring(0, 20)}]`;

    const update = (stage, percent) => {
      if (progressCallback) progressCallback(stage, percent);
    };

    result.attempts = 1;
    let page = null;

    try {
      // Ensure browser + context are ready (lock-safe for parallel calls)
      if (!this.browser || !this.browser.isConnected()) {
        update('Starting browser...', 5);
        await this.start('https://www.meta.ai/media');
      }

      // Create a NEW tab for this job
      update('Opening media page...', 10);
      page = await this.context.newPage();
      console.log(`${tag} New tab opened, navigating to /media...`);
      await page.goto('https://www.meta.ai/media', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Wait for file input to be available (page fully loaded)
      try {
        await page.waitForSelector('input[type="file"]', { timeout: 10000 });
      } catch (e) {
        console.log(`${tag} File input not found, waiting more...`);
        await page.waitForTimeout(3000);
      }
      console.log(`${tag} Page ready: ${page.url()}`);

      // Step 1: Upload image
      update('Uploading image...', 30);
      console.log(`${tag} Uploading image...`);

      let uploaded = false;
      try {
        const fileInput = page.locator('input[type="file"]').first();
        if (await fileInput.count() > 0) {
          await fileInput.setInputFiles(imagePath);
          await page.waitForTimeout(2000);
          console.log(`${tag} Upload done via file input`);
          uploaded = true;
        }
      } catch (e) {
        console.log(`${tag} Direct file input failed: ${e.message}`);
      }

      if (!uploaded) {
        const plusSelectors = [
          '[aria-label="Add"]', '[aria-label="Upload"]', '[aria-label="Attach"]',
          '[aria-label="add"]', '[aria-label="upload"]', '[aria-label="attach"]',
          'div[role="button"]:has-text("+")', 'button:has-text("+")'
        ];
        for (const selector of plusSelectors) {
          if (uploaded) break;
          try {
            const btn = page.locator(selector).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
              try {
                const [fileChooser] = await Promise.all([
                  page.waitForEvent('filechooser', { timeout: 5000 }),
                  btn.click()
                ]);
                await fileChooser.setFiles(imagePath);
                await page.waitForTimeout(2000);
                uploaded = true;
              } catch (e) {
                const fileInput = page.locator('input[type="file"]').first();
                if (await fileInput.count() > 0) {
                  await fileInput.setInputFiles(imagePath);
                  await page.waitForTimeout(2000);
                  uploaded = true;
                }
              }
            }
          } catch (e) { continue; }
        }
      }

      if (!uploaded) throw new Error('Failed to upload image on media page');
      console.log(`${tag} Upload result: ${uploaded}`);

      // Step 2: Type prompt
      update('Typing prompt...', 40);
      const textbox = page.locator('div[role="textbox"]').first();
      if (await textbox.count() > 0) {
        await textbox.click();
        await page.waitForTimeout(300);
        await page.keyboard.type(prompt, { delay: 20 });
        await page.waitForTimeout(500);
        console.log(`${tag} Prompt typed`);
      } else {
        const fallbacks = [
          'textarea[placeholder*="Describe" i]', 'textarea[placeholder*="change" i]',
          'div[contenteditable="true"]', 'textarea'
        ];
        for (const sel of fallbacks) {
          try {
            const el = page.locator(sel).first();
            if (await el.count() > 0 && await el.isVisible()) {
              await el.click();
              await page.waitForTimeout(300);
              await page.keyboard.type(prompt, { delay: 20 });
              await page.waitForTimeout(500);
              break;
            }
          } catch (e) { continue; }
        }
      }

      // Step 3: Switch to Video mode
      update('Switching to Video...', 50);
      const combobox = page.locator('[role="combobox"]').first();
      if (await combobox.count() > 0) {
        await combobox.click();
        await page.waitForTimeout(800);
        const videoOption = page.locator('[role="option"]').filter({ hasText: 'Video' }).first();
        if (await videoOption.count() > 0) {
          await videoOption.click();
          await page.waitForTimeout(800);
          console.log(`${tag} Video mode selected`);
        } else {
          for (const sel of ['[role="menuitem"]:has-text("Video")', 'li:has-text("Video")']) {
            try {
              const opt = page.locator(sel).first();
              if (await opt.count() > 0 && await opt.isVisible()) {
                await opt.click();
                await page.waitForTimeout(800);
                break;
              }
            } catch (e) { continue; }
          }
        }
      }

      // Step 4: Click animate button
      update('Submitting...', 60);
      const animateBtn = page.locator('[data-testid="composer-animate-button"]').first();
      if (await animateBtn.count() > 0) {
        await animateBtn.click();
        console.log(`${tag} Animate button clicked`);
      }
      await page.waitForTimeout(3000);

      // Step 5: Wait for video URL
      update('Generating video...', 65);
      console.log(`${tag} Waiting for video...`);

      const maxWaitMs = 180000;
      const pollInterval = 3000;
      let videoUrl = null;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        try {
          const firstArticle = page.locator('[data-slot="flexbox"] > article').first();
          const vid = firstArticle.locator('[data-testid="generated-video"][data-video-url]').first();
          if (await vid.count() > 0) {
            videoUrl = await vid.getAttribute('data-video-url');
            if (videoUrl) {
              console.log(`${tag} Found video URL: ${videoUrl.substring(0, 80)}...`);
              break;
            }
          }
        } catch (e) {}

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 15 === 0) {
          console.log(`${tag} Still waiting... ${elapsed}s`);
          update(`Generating video... ${elapsed}s`, 65 + Math.min(20, elapsed / 5));
        }
        await page.waitForTimeout(pollInterval);
      }

      if (!videoUrl) throw new Error('Timeout — no video detected after 3 minutes');

      // Step 6: Download video
      update('Downloading video...', 90);
      console.log(`${tag} Downloading to ${path.basename(outputPath)}...`);

      let downloadOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await page.request.get(videoUrl);
          if (response.ok()) {
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const body = await response.body();
            fs.writeFileSync(outputPath, body);
            console.log(`${tag} Downloaded (${(body.length / (1024 * 1024)).toFixed(1)} MB)`);
            downloadOk = true;
            break;
          }
        } catch (e) {
          console.log(`${tag} Download attempt ${attempt} failed: ${e.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (downloadOk) {
        update('Complete!', 100);
        console.log(`${tag} COMPLETE`);
        result.success = true;
        result.videoUrl = videoUrl;
        result.downloadMethod = 'data-video-url';
        return result;
      } else {
        throw new Error('Failed to download video after retries');
      }

    } catch (e) {
      result.error = e.message;
      console.log(`${tag} Error: ${e.message}`);
      update(`Error: ${e.message}`, -1);
      return result;
    } finally {
      // Always close the tab when done (success or failure)
      if (page) {
        try { await page.close(); } catch (e) {}
      }
    }
  }

  // ============================================
  // Text-to-Image Methods
  // ============================================

  async _typeImagePrompt(prompt) {
    const inputSelectors = [
      'textarea[placeholder*="Describe" i]', 'textarea[placeholder*="image" i]',
      'div[contenteditable="true"]', 'textarea'
    ];
    for (const selector of inputSelectors) {
      try {
        const elem = this.page.locator(selector).first();
        if (await elem.count() > 0 && await elem.isVisible()) {
          await elem.fill(prompt);
          await this.page.waitForTimeout(500);
          return true;
        }
      } catch (e) { continue; }
    }
    return false;
  }

  async _submitImagePrompt() {
    const submitSelectors = [
      'button[aria-label="Send"]', 'button[aria-label*="send" i]',
      'div[role="button"][aria-label*="send" i]', 'button[type="submit"]'
    ];
    for (const selector of submitSelectors) {
      try {
        const btn = this.page.locator(selector).last();
        if (await btn.count() > 0 && await btn.isVisible()) {
          await btn.click();
          return true;
        }
      } catch (e) { continue; }
    }

    try {
      await this.page.keyboard.press('Enter');
      return true;
    } catch (e) {
      return false;
    }
  }

  async _captureExistingImageUrls() {
    const existingUrls = new Set();
    const selectors = ['img[src*="scontent"]', 'img[src*="fbcdn.net"]', 'img[src*="lookaside"]'];
    for (const selector of selectors) {
      try {
        const images = this.page.locator(selector);
        const count = await images.count();
        for (let i = 0; i < count; i++) {
          const src = await images.nth(i).getAttribute('src');
          if (src) existingUrls.add(src.split('?')[0]);
        }
      } catch (e) {}
    }
    return existingUrls;
  }

  async _waitForImage(timeout = 120, existingUrls = new Set()) {
    console.log(`[META] Waiting for image (max ${timeout}s)...`);

    const startTime = Date.now();
    let lastLog = 0;

    while ((Date.now() - startTime) / 1000 < timeout) {
      if (!this._running) return null;

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (elapsed - lastLog >= 15) {
        console.log(`[META] ${elapsed}s elapsed...`);
        lastLog = elapsed;
      }

      if (elapsed < 10) {
        await this.page.waitForTimeout(2000);
        continue;
      }

      const imageSelectors = ['img[src*="scontent"]', 'img[src*="fbcdn.net"]', 'img[src*="lookaside"]'];
      for (const selector of imageSelectors) {
        try {
          const images = this.page.locator(selector);
          const count = await images.count();
          for (let i = 0; i < count; i++) {
            const img = images.nth(i);
            const src = await img.getAttribute('src');
            if (!src) continue;
            const baseUrl = src.split('?')[0];
            if (existingUrls.has(baseUrl)) continue;

            // Also skip URLs we've already downloaded in previous jobs
            if (this._usedUrls.has(baseUrl)) continue;

            const dimensions = await img.evaluate(el => ({
              width: el.naturalWidth || el.width,
              height: el.naturalHeight || el.height
            }));

            if (dimensions.width > 400 && dimensions.height > 400) {
              this._usedUrls.add(baseUrl);
              console.log(`[META] Found image: ${dimensions.width}x${dimensions.height}`);
              await this.page.waitForTimeout(1500);
              return src;
            }
          }
        } catch (e) { continue; }
      }

      await this.page.waitForTimeout(2000);
    }

    return null;
  }

  async _downloadImage(imageUrl, outputPath) {
    try {
      const response = await this.page.request.get(imageUrl);
      if (response.ok()) {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const body = await response.body();
        fs.writeFileSync(outputPath, body);
        return true;
      }
    } catch (e) {
      console.log('[META] Image download error:', e.message);
    }
    return false;
  }

  /**
   * Text-to-Image generation — parallel-safe (each call gets its own tab)
   */
  async textToImage(prompt, outputPath, options = {}) {
    const { aspectRatio = '16:9', progressCallback } = options;
    const tag = `[META][TXT2IMG][${prompt.substring(0, 20)}]`;

    const result = {
      success: false, imageUrl: null, outputPath, error: null, attempts: 0
    };

    const update = (stage, percent) => {
      if (progressCallback) progressCallback(stage, percent);
    };

    result.attempts = 1;
    let page = null;

    try {
      // Ensure browser + context are ready
      if (!this.browser || !this.browser.isConnected()) {
        update('Starting browser...', 5);
        await this.start('https://www.meta.ai/media');
      }

      // Create a NEW tab for this job
      update('Opening media page...', 10);
      page = await this.context.newPage();
      console.log(`${tag} New tab, navigating to /media...`);
      await page.goto('https://www.meta.ai/media', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Wait for page to be ready
      try {
        await page.waitForSelector('div[role="textbox"]', { timeout: 10000 });
      } catch (e) {
        await page.waitForTimeout(3000);
      }
      console.log(`${tag} Page ready: ${page.url()}`);

      // Step 1: Type prompt
      update('Entering prompt...', 30);
      const textbox = page.locator('div[role="textbox"]').first();
      if (await textbox.count() > 0) {
        await textbox.click();
        await page.waitForTimeout(300);
        await page.keyboard.type(prompt, { delay: 20 });
        await page.waitForTimeout(500);
        console.log(`${tag} Prompt typed`);
      } else {
        throw new Error('Could not find textbox');
      }

      // Step 2: Verify Image mode (first combobox)
      const comboboxes = page.locator('[role="combobox"]');
      const comboCount = await comboboxes.count();

      if (comboCount > 0) {
        const modeCombo = comboboxes.first();
        const comboText = await modeCombo.textContent();
        if (comboText && comboText.trim().toLowerCase().includes('video')) {
          await modeCombo.click();
          await page.waitForTimeout(800);
          const imgOption = page.locator('[role="option"]').filter({ hasText: 'Image' }).first();
          if (await imgOption.count() > 0) {
            await imgOption.click();
            await page.waitForTimeout(800);
          }
          console.log(`${tag} Switched to Image mode`);
        }
      }

      // Step 2b: Select aspect ratio (second combobox)
      // Map: '16:9' → 'LANDSCAPE' label shows "16:9", '9:16' → "9:16", '1:1' → "1:1"
      if (comboCount > 1) {
        const ratioCombo = comboboxes.nth(1);
        const currentRatio = (await ratioCombo.textContent()).trim();
        const targetRatio = aspectRatio || '16:9';

        if (!currentRatio.includes(targetRatio)) {
          console.log(`${tag} Changing aspect ratio from ${currentRatio} to ${targetRatio}...`);
          await ratioCombo.click();
          await page.waitForTimeout(800);

          // Select target ratio from dropdown
          const ratioOption = page.locator('[role="option"]').filter({ hasText: targetRatio }).first();
          if (await ratioOption.count() > 0) {
            await ratioOption.click();
            await page.waitForTimeout(800);
            console.log(`${tag} Aspect ratio set to ${targetRatio}`);
          } else {
            console.log(`${tag} WARNING: Could not find ratio option ${targetRatio}`);
            // Try clicking away to close dropdown
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
          }
        } else {
          console.log(`${tag} Aspect ratio already ${targetRatio}`);
        }
      }

      // Step 3: Click create/submit button
      update('Generating image...', 45);
      const submitBtn = page.locator('[data-testid="composer-create-button"]').first();
      if (await submitBtn.count() > 0) {
        await submitBtn.click();
        console.log(`${tag} Create button clicked`);
      } else {
        // Fallback: try Enter key or other submit buttons
        const fallbacks = [
          'button[aria-label="Send"]', 'button[aria-label*="send" i]',
          'button[type="submit"]', '[data-testid="composer-animate-button"]'
        ];
        let clicked = false;
        for (const sel of fallbacks) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
              await btn.click();
              clicked = true;
              console.log(`${tag} Submit via: ${sel}`);
              break;
            }
          } catch (e) { continue; }
        }
        if (!clicked) {
          await page.keyboard.press('Enter');
          console.log(`${tag} Submit via Enter key`);
        }
      }
      await page.waitForTimeout(3000);

      // Step 4: Wait for generated image in first article
      console.log(`${tag} Waiting for image...`);

      const maxWaitMs = 120000; // 2 minutes
      const pollInterval = 3000;
      let imageUrl = null;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        try {
          // Look for generated image in first article
          const firstArticle = page.locator('[data-slot="flexbox"] > article').first();
          const imgs = firstArticle.locator('img[src*="scontent"], img[src*="fbcdn.net"]');
          const count = await imgs.count();
          for (let i = 0; i < count; i++) {
            const img = imgs.nth(i);
            const src = await img.getAttribute('src');
            if (!src) continue;
            const dims = await img.evaluate(el => ({
              w: el.naturalWidth || el.width,
              h: el.naturalHeight || el.height
            }));
            if (dims.w > 400 && dims.h > 400) {
              imageUrl = src;
              console.log(`${tag} Found image: ${dims.w}x${dims.h} — ${src.substring(0, 80)}...`);
              break;
            }
          }
          if (imageUrl) break;
        } catch (e) {}

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (elapsed % 15 === 0) {
          console.log(`${tag} Still waiting... ${elapsed}s`);
          update(`Generating image... ${elapsed}s`, 45 + Math.min(35, elapsed / 3));
        }
        await page.waitForTimeout(pollInterval);
      }

      if (!imageUrl) throw new Error('Timeout — no image detected after 2 minutes');

      // Step 5: Download image
      update('Downloading image...', 90);
      console.log(`${tag} Downloading to ${path.basename(outputPath)}...`);

      try {
        const response = await page.request.get(imageUrl);
        if (response.ok()) {
          const dir = path.dirname(outputPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const body = await response.body();
          fs.writeFileSync(outputPath, body);
          console.log(`${tag} Downloaded (${(body.length / (1024 * 1024)).toFixed(1)} MB)`);
          update('Complete!', 100);
          result.success = true;
          result.imageUrl = imageUrl;
          return result;
        }
      } catch (e) {
        console.log(`${tag} Download failed: ${e.message}`);
      }

      throw new Error('Failed to download image');

    } catch (e) {
      result.error = e.message;
      console.log(`${tag} Error: ${e.message}`);
      update(`Error: ${e.message}`, -1);
      return result;
    } finally {
      if (page) {
        try { await page.close(); } catch (e) {}
      }
    }
  }

  // ============================================
  // Text-to-Video (pipeline: text→image→video)
  // ============================================

  /**
   * Text-to-Video generation — chains textToImage() → convert()
   * Each phase opens its own tab (parallel-safe).
   */
  async textToVideo(prompt, outputPath, options = {}) {
    const { aspectRatio = '9:16', animationPrompt = '', progressCallback } = options;
    const videoPrompt = animationPrompt || prompt;
    const tag = `[META][TXT2VID][${prompt.substring(0, 20)}]`;

    const result = {
      success: false, videoUrl: null, outputPath, error: null, attempts: 0
    };

    const update = (stage, percent) => {
      if (progressCallback) progressCallback(stage, percent);
    };

    result.attempts = 1;
    // Temp image path: same dir as output, prefixed with _tmp_
    const tempImagePath = path.join(
      path.dirname(outputPath),
      '_tmp_' + path.basename(outputPath, path.extname(outputPath)) + '.jpg'
    );

    try {
      console.log(`${tag} Phase 1: Generating image from prompt...`);
      update('Phase 1: Generating image...', 5);

      // Phase 1: text → image
      const imgResult = await this.textToImage(prompt, tempImagePath, {
        aspectRatio,
        progressCallback: (stage, percent) => {
          // Scale phase 1 progress to 0-45%
          if (percent >= 0) {
            update(`Phase 1: ${stage}`, Math.round(percent * 0.45));
          } else {
            update(stage, percent);
          }
        }
      });

      if (!imgResult.success) {
        throw new Error(`Phase 1 failed: ${imgResult.error || 'Image generation failed'}`);
      }

      console.log(`${tag} Phase 1 complete — image saved to ${path.basename(tempImagePath)}`);
      console.log(`${tag} Animation prompt: "${videoPrompt.substring(0, 60)}..."`);
      update('Phase 2: Animating image...', 50);

      // Phase 2: image → video (uses animation prompt)
      console.log(`${tag} Phase 2: Animating image to video...`);
      const vidResult = await this.convert(
        tempImagePath, outputPath, videoPrompt,
        (stage, percent) => {
          // Scale phase 2 progress to 50-100%
          if (percent >= 0) {
            update(`Phase 2: ${stage}`, 50 + Math.round(percent * 0.5));
          } else {
            update(stage, percent);
          }
        }
      );

      if (!vidResult.success) {
        throw new Error(`Phase 2 failed: ${vidResult.error || 'Video generation failed'}`);
      }

      console.log(`${tag} Phase 2 complete — video saved to ${path.basename(outputPath)}`);
      update('Complete!', 100);

      result.success = true;
      result.videoUrl = vidResult.videoUrl;
      result.imageUrl = imgResult.imageUrl;
      return result;

    } catch (e) {
      result.error = e.message;
      console.log(`${tag} Error: ${e.message}`);
      update(`Error: ${e.message}`, -1);
      return result;
    } finally {
      // Clean up temp image
      try {
        if (fs.existsSync(tempImagePath)) {
          fs.unlinkSync(tempImagePath);
          console.log(`${tag} Temp image cleaned up`);
        }
      } catch (e) {
        console.log(`${tag} Could not delete temp image: ${e.message}`);
      }
    }
  }
}

module.exports = { MetaConverter };
