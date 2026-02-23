const fs = require('fs');
const path = require('path');

class Config {
  constructor(configPath) {
    this.configPath = configPath;
    this.data = this._defaults();
    this._load();
  }

  _defaults() {
    return {
      cookies: {
        meta: { datr: '', abra_sess: '' },
        grok: { sso: '', 'sso-rw': '' },
        whisk: { cookies: '' },
        imagefx: { cookies: '' }
      },
      settings: {
        outputFolder: '',
        retryAttempts: 3,
        delayBetween: 10,
        namingPattern: '{provider}_{index}_{timestamp}',
        preWarmBrowsers: false,
        headless: true
      },
      providerStatus: {
        meta: 'unconfigured',
        grok: 'unconfigured',
        whisk: 'unconfigured',
        imagefx: 'unconfigured'
      }
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf8');
        const saved = JSON.parse(content);
        // Deep merge with defaults
        this.data = this._merge(this._defaults(), saved);
      }
    } catch (e) {
      console.error('[CONFIG] Failed to load:', e.message);
      this.data = this._defaults();
    }
  }

  _merge(defaults, saved) {
    const result = { ...defaults };
    for (const key of Object.keys(saved)) {
      if (saved[key] && typeof saved[key] === 'object' && !Array.isArray(saved[key])) {
        result[key] = this._merge(defaults[key] || {}, saved[key]);
      } else {
        result[key] = saved[key];
      }
    }
    return result;
  }

  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[CONFIG] Failed to save:', e.message);
    }
  }

  get(key) {
    const keys = key.split('.');
    let value = this.data;
    for (const k of keys) {
      if (value == null) return undefined;
      value = value[k];
    }
    return value;
  }

  set(key, value) {
    const keys = key.split('.');
    let target = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]] || typeof target[keys[i]] !== 'object') {
        target[keys[i]] = {};
      }
      target = target[keys[i]];
    }
    target[keys[keys.length - 1]] = value;
    this.save();
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.data));
  }

  getCookies(provider) {
    return this.data.cookies[provider] || {};
  }

  setCookies(provider, cookies) {
    this.data.cookies[provider] = cookies;
    this.save();
  }

  getSettings() {
    return { ...this.data.settings };
  }

  setProviderStatus(provider, status) {
    this.data.providerStatus[provider] = status;
    this.save();
  }

  getProviderStatus(provider) {
    return this.data.providerStatus[provider] || 'unconfigured';
  }
}

module.exports = { Config };
