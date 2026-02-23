const path = require('path');
const fs = require('fs');
const { MetaConverter } = require('./providers/meta-converter');
const { GrokConverter } = require('./providers/grok-converter');
const { WhiskConverter } = require('./providers/whisk-converter');
const { ImageFXConverter } = require('./providers/imagefx-converter');

// Simple concurrency limiter
class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      this.queue.shift()();
    }
  }
}

// Provider capability matrix
const CAPABILITIES = {
  meta: {
    name: 'Meta AI',
    types: ['image-to-video', 'text-to-video', 'text-to-image'],
    method: 'playwright',
    timeout: 300
  },
  grok: {
    name: 'Grok AI',
    types: ['image-to-video', 'text-to-video', 'text-to-image'],
    method: 'playwright',
    timeout: 180
  },
  whisk: {
    name: 'Google Whisk',
    types: ['image-to-video', 'text-to-image'],
    method: 'api',
    timeout: 60
  },
  imagefx: {
    name: 'Google ImageFX',
    types: ['text-to-image'],
    method: 'api',
    timeout: 60
  }
};

// JSON schema validation
const VALID_PROVIDERS = ['meta', 'grok', 'whisk', 'imagefx'];
const VALID_TYPES = ['image-to-video', 'text-to-video', 'text-to-image'];

class Orchestrator {
  constructor(config, database, emitProgress) {
    this.config = config;
    this.db = database;
    this.emitProgress = emitProgress; // Function to send events to renderer

    // Provider instances (persistent for pre-warming)
    this.converters = {
      meta: null,
      grok: null,
      whisk: null,
      imagefx: null
    };

    // Per-provider job queues
    this.queues = {
      meta: [],
      grok: [],
      whisk: [],
      imagefx: []
    };

    // Running state
    this._running = false;
    this._activeJobs = new Map(); // jobId -> { provider, cancel: fn }
    this._batchId = null;

    // Per-provider concurrency limiters (max 4 parallel tabs)
    this._providerSemaphores = {
      meta: new Semaphore(4),
      grok: new Semaphore(4),
      whisk: new Semaphore(4),
      imagefx: new Semaphore(4)
    };

    // Track pending+active job counts per provider for cleanup
    this._providerJobCounts = { meta: 0, grok: 0, whisk: 0, imagefx: 0 };
  }

  getCapabilities() {
    return CAPABILITIES;
  }

  // ============================================
  // Job Validation
  // ============================================

  validateJob(job) {
    const errors = [];

    if (!job.provider) {
      errors.push('Missing required field "provider"');
    } else if (!VALID_PROVIDERS.includes(job.provider)) {
      errors.push(`Unknown provider "${job.provider}". Valid: ${VALID_PROVIDERS.join(', ')}`);
    }

    if (!job.type) {
      errors.push('Missing required field "type"');
    } else if (!VALID_TYPES.includes(job.type)) {
      errors.push(`Unknown type "${job.type}". Valid: ${VALID_TYPES.join(', ')}`);
    }

    if (!job.prompt && job.type !== 'image-to-video') {
      errors.push('Missing required field "prompt"');
    }

    // Provider-type compatibility
    if (job.provider && job.type && CAPABILITIES[job.provider]) {
      if (!CAPABILITIES[job.provider].types.includes(job.type)) {
        errors.push(`${CAPABILITIES[job.provider].name} does not support ${job.type}. Supported: ${CAPABILITIES[job.provider].types.join(', ')}`);
      }
    }

    // Image required for image-to-video
    if (job.type === 'image-to-video') {
      if (!job.image) {
        errors.push('Image path required for image-to-video');
      } else if (!fs.existsSync(job.image)) {
        errors.push(`Image file not found: ${job.image}`);
      }
    }

    return errors;
  }

  validateBatch(batch) {
    const errors = [];

    if (!batch.jobs || !Array.isArray(batch.jobs)) {
      return ['Batch must contain a "jobs" array'];
    }

    if (batch.jobs.length === 0) {
      return ['Batch must contain at least 1 job'];
    }

    // Validate output folder if specified
    if (batch.globalOptions?.outputFolder) {
      const folder = batch.globalOptions.outputFolder;
      try {
        if (!fs.existsSync(folder)) {
          fs.mkdirSync(folder, { recursive: true });
        }
        // Test write access
        const testFile = path.join(folder, '.write-test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
      } catch (e) {
        errors.push(`Cannot write to output folder: ${folder}`);
      }
    }

    // Validate each job
    batch.jobs.forEach((job, index) => {
      const jobErrors = this.validateJob(job);
      jobErrors.forEach(err => {
        errors.push(`Job ${index + 1}: ${err}`);
      });
    });

    return errors;
  }

  // ============================================
  // Converter Management (Pre-warming)
  // ============================================

  async _getConverter(provider) {
    const cookies = this.config.getCookies(provider);
    const settings = this.config.getSettings();

    if (this.converters[provider] && this.converters[provider].isBrowserAlive()) {
      return this.converters[provider];
    }

    const options = {
      headless: settings.headless,
      retryAttempts: settings.retryAttempts || 3,
      delayBetween: settings.delayBetween || 10
    };

    switch (provider) {
      case 'meta':
        this.converters[provider] = new MetaConverter(cookies, options);
        break;
      case 'grok':
        this.converters[provider] = new GrokConverter(cookies, options);
        break;
      case 'whisk':
        this.converters[provider] = new WhiskConverter(cookies, options);
        break;
      case 'imagefx':
        this.converters[provider] = new ImageFXConverter(cookies, options);
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }

    return this.converters[provider];
  }

  async preWarmProvider(provider) {
    try {
      console.log(`[ORCH] Pre-warming ${provider}...`);
      const converter = await this._getConverter(provider);
      await converter.start();
      console.log(`[ORCH] ${provider} warmed up`);
      return true;
    } catch (e) {
      console.log(`[ORCH] Pre-warm failed for ${provider}: ${e.message}`);
      return false;
    }
  }

  async preWarmAll() {
    const providers = ['meta', 'grok', 'whisk', 'imagefx'];
    const results = {};
    await Promise.allSettled(
      providers.map(async (p) => {
        const cookies = this.config.getCookies(p);
        const hasCookies = (p === 'whisk' || p === 'imagefx')
          ? cookies.cookies
          : Object.values(cookies).some(v => v);
        if (hasCookies) {
          results[p] = await this.preWarmProvider(p);
        } else {
          results[p] = false;
        }
      })
    );
    return results;
  }

  // ============================================
  // Single Job Execution
  // ============================================

  async submitJob(jobDef) {
    const errors = this.validateJob(jobDef);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const settings = this.config.getSettings();
    const outputFolder = jobDef.outputFolder || settings.outputFolder || path.join(process.cwd(), 'storage', 'output');

    // Ensure output folder exists
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Generate output path
    const outputPath = this._generateOutputPath(jobDef, outputFolder, 1);

    // Add to database
    const dbJob = this.db.addJob({
      provider: jobDef.provider,
      type: jobDef.type,
      prompt: jobDef.prompt || '',
      imagePath: jobDef.image || null,
      outputPath,
      status: 'running',
      options: jobDef.options || {}
    });

    // Queue execution with concurrency limit (max 4 parallel per provider)
    const provider = jobDef.provider;
    const sem = this._providerSemaphores[provider];
    // Fire-and-forget with semaphore guard
    this._providerJobCounts[provider]++;
    (async () => {
      await sem.acquire();
      try {
        await this._executeJob(dbJob, jobDef);
      } finally {
        sem.release();
        this._providerJobCounts[provider]--;
        // Close browser if no more pending/active jobs for this provider
        this._maybeCloseProvider(provider);
      }
    })();

    return { success: true, jobId: dbJob.id };
  }

  async _executeJob(dbJob, jobDef) {
    const jobId = dbJob.id;
    let cancelled = false;

    // Register for cancellation
    this._activeJobs.set(jobId, {
      provider: jobDef.provider,
      cancel: () => { cancelled = true; }
    });

    try {
      const converter = await this._getConverter(jobDef.provider);

      if (!converter.isBrowserAlive() || jobDef.provider === 'whisk' || jobDef.provider === 'imagefx') {
        // For Meta jobs, go directly to /media page (skip double navigation)
        const startUrl = (jobDef.provider === 'meta')
          ? 'https://www.meta.ai/media' : undefined;
        await converter.start(startUrl);
      }

      const progressCallback = (stage, percent) => {
        if (cancelled) return;
        this.emitProgress({
          jobId, provider: jobDef.provider, stage, percent,
          type: jobDef.type, prompt: jobDef.prompt
        });
      };

      let result;

      switch (jobDef.type) {
        case 'image-to-video':
          result = await converter.convert(
            jobDef.image, dbJob.outputPath, jobDef.prompt || 'Animate this image',
            progressCallback, jobDef.options?.aspectRatio || '9:16',
            { duration: jobDef.options?.duration, resolution: jobDef.options?.resolution }
          );
          break;

        case 'text-to-video':
          if (jobDef.provider === 'meta') {
            result = await converter.textToVideo(
              jobDef.prompt, dbJob.outputPath, {
                aspectRatio: jobDef.options?.aspectRatio || '9:16',
                animationPrompt: jobDef.options?.animationPrompt || '',
                progressCallback
              }
            );
          } else if (jobDef.provider === 'grok') {
            result = await converter.textToVideo(
              jobDef.prompt,
              path.dirname(dbJob.outputPath),
              {
                namingPattern: path.basename(dbJob.outputPath, path.extname(dbJob.outputPath)),
                aspectRatio: jobDef.options?.aspectRatio || '9:16',
                duration: jobDef.options?.duration,
                resolution: jobDef.options?.resolution
              },
              progressCallback
            );
            if (result.videoPath) {
              dbJob.outputPath = result.videoPath;
            }
          } else {
            throw new Error(`${jobDef.provider} does not support text-to-video`);
          }
          break;

        case 'text-to-image':
          if (jobDef.provider === 'grok') {
            result = await converter.generateImage(jobDef.prompt, dbJob.outputPath, {
              aspectRatio: jobDef.options?.aspectRatio || '1:1',
              progressCallback
            });
          } else if (jobDef.provider === 'whisk') {
            result = await converter.textToImage(jobDef.prompt, dbJob.outputPath, {
              aspectRatio: jobDef.options?.aspectRatio || '1:1',
              progressCallback
            });
          } else if (jobDef.provider === 'imagefx') {
            result = await converter.textToImage(jobDef.prompt, dbJob.outputPath, {
              aspectRatio: jobDef.options?.aspectRatio || '1:1',
              model: jobDef.options?.model || 'IMAGEN_3_5',
              progressCallback
            });
          } else {
            // Meta
            result = await converter.textToImage(jobDef.prompt, dbJob.outputPath, {
              aspectRatio: jobDef.options?.aspectRatio || '16:9',
              progressCallback
            });
          }
          break;

        default:
          throw new Error(`Unknown job type: ${jobDef.type}`);
      }

      if (cancelled) {
        this.db.updateJob(jobId, { status: 'cancelled' });
        this.emitProgress({ jobId, event: 'cancelled' });
        return;
      }

      if (result.success) {
        this.db.updateJob(jobId, {
          status: 'success',
          outputPath: result.videoPath || result.imagePath || dbJob.outputPath,
          videoUrl: result.videoUrl || result.imageUrl || null,
          attempts: result.attempts || 1
        });
        this.emitProgress({ jobId, event: 'complete', outputPath: dbJob.outputPath });
      } else {
        this.db.updateJob(jobId, {
          status: 'failed',
          error: result.error,
          videoUrl: result.videoUrl || null,
          attempts: result.attempts || 1
        });
        this.emitProgress({ jobId, event: 'failed', error: result.error });
      }

    } catch (e) {
      console.log(`[ORCH] Job ${jobId} error: ${e.message}`);
      this.db.updateJob(jobId, { status: 'failed', error: e.message });
      this.emitProgress({ jobId, event: 'failed', error: e.message });
    } finally {
      this._activeJobs.delete(jobId);
    }
  }

  // ============================================
  // Batch Execution (Parallel Cross-Provider)
  // ============================================

  async submitBatch(batch) {
    const errors = this.validateBatch(batch);
    if (errors.length > 0) {
      return { success: false, errors };
    }

    const batchId = `batch_${Date.now()}`;
    const settings = this.config.getSettings();
    const outputFolder = batch.globalOptions?.outputFolder || settings.outputFolder ||
                          path.join(process.cwd(), 'storage', 'output');

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // Create database entries for all jobs
    const jobs = batch.jobs.map((jobDef, index) => {
      const outputPath = this._generateOutputPath(jobDef, outputFolder, index + 1, batch.globalOptions?.namingPattern);

      const dbJob = this.db.addJob({
        provider: jobDef.provider,
        type: jobDef.type,
        prompt: jobDef.prompt || '',
        imagePath: jobDef.image || null,
        outputPath,
        status: 'pending',
        options: jobDef.options || {},
        batchId
      });

      return { dbJob, jobDef };
    });

    // Distribute jobs into per-provider queues
    const providerQueues = { meta: [], grok: [], whisk: [], imagefx: [] };
    for (const job of jobs) {
      providerQueues[job.jobDef.provider].push(job);
    }

    // Track batch progress
    const batchState = {
      id: batchId,
      total: jobs.length,
      completed: 0,
      failed: 0,
      running: 0
    };

    this._running = true;

    this.emitProgress({
      event: 'batch:start',
      batchId,
      total: jobs.length,
      providers: Object.fromEntries(
        Object.entries(providerQueues).map(([k, v]) => [k, v.length]).filter(([, v]) => v > 0)
      )
    });

    // Run provider queues in parallel
    const providerPromises = Object.entries(providerQueues)
      .filter(([, queue]) => queue.length > 0)
      .map(([provider, queue]) =>
        this._processProviderQueue(provider, queue, batchState, settings)
      );

    await Promise.allSettled(providerPromises);

    this._running = false;

    this.emitProgress({
      event: 'batch:complete',
      batchId,
      completed: batchState.completed,
      failed: batchState.failed,
      total: batchState.total
    });

    return {
      success: true,
      batchId,
      total: batchState.total,
      completed: batchState.completed,
      failed: batchState.failed
    };
  }

  async _processProviderQueue(provider, queue, batchState, settings) {
    console.log(`[ORCH] Starting ${provider} queue (${queue.length} jobs)`);

    for (let i = 0; i < queue.length; i++) {
      if (!this._running && batchState.completed + batchState.failed > 0) {
        // Allow cancellation during batch
        break;
      }

      const { dbJob, jobDef } = queue[i];

      // Update status
      this.db.updateJob(dbJob.id, { status: 'running' });
      batchState.running++;

      this.emitProgress({
        event: 'batch:job-start',
        batchId: batchState.id,
        jobId: dbJob.id,
        provider,
        index: i + 1,
        total: queue.length,
        batchTotal: batchState.total,
        batchCompleted: batchState.completed
      });

      // Execute the job
      await this._executeJob(dbJob, jobDef);

      batchState.running--;
      const updatedJob = this.db.getJob(dbJob.id);
      if (updatedJob && updatedJob.status === 'success') {
        batchState.completed++;
      } else {
        batchState.failed++;
      }

      this.emitProgress({
        event: 'batch:progress',
        batchId: batchState.id,
        completed: batchState.completed,
        failed: batchState.failed,
        total: batchState.total,
        provider
      });

      // Delay between jobs within same provider (avoid rate limits)
      if (i < queue.length - 1) {
        const delay = (settings.delayBetween || 10) * 1000;
        console.log(`[ORCH] ${provider}: waiting ${delay / 1000}s before next job`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    console.log(`[ORCH] ${provider} queue complete`);
  }

  // ============================================
  // Job Control
  // ============================================

  cancelJob(jobId) {
    const active = this._activeJobs.get(jobId);
    if (active) {
      active.cancel();
      this._activeJobs.delete(jobId);
      this.db.updateJob(jobId, { status: 'cancelled' });
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const [jobId, active] of this._activeJobs.entries()) {
      active.cancel();
      this.db.updateJob(jobId, { status: 'cancelled' });
    }
    this._activeJobs.clear();
    this._running = false;

    // Stop all converters
    for (const provider of Object.keys(this.converters)) {
      if (this.converters[provider]) {
        this.converters[provider].stop().catch(() => {});
        this.converters[provider] = null;
      }
    }
  }

  async retryJob(jobId) {
    const job = this.db.getJob(jobId);
    if (!job) return { success: false, errors: ['Job not found'] };

    const jobDef = {
      provider: job.provider,
      type: job.type,
      prompt: job.prompt,
      image: job.imagePath,
      options: job.options || {},
      outputFolder: path.dirname(job.outputPath)
    };

    // Update existing job status
    this.db.updateJob(jobId, { status: 'running', error: null });

    const dbJob = { ...job, id: jobId };
    this._executeJob(dbJob, jobDef);

    return { success: true, jobId };
  }

  // ============================================
  // Helpers
  // ============================================

  _maybeCloseProvider(provider) {
    // Check if any pending or active jobs remain for this provider
    if (this._providerJobCounts[provider] > 0) return;
    // Also skip if a batch is running (batch handles its own lifecycle)
    if (this._running) return;

    // No pending/active jobs and not in batch mode — close the browser
    const converter = this.converters[provider];
    if (converter && converter.isBrowserAlive()) {
      console.log(`[ORCH] No more jobs for ${provider}, closing browser`);
      converter.stop().catch(() => {});
      this.converters[provider] = null;
    }
  }

  _generateOutputPath(jobDef, outputFolder, index, namingPattern) {
    const pattern = namingPattern || this.config.getSettings().namingPattern || '{provider}_{index}_{timestamp}';
    const timestamp = Date.now();
    const safePrompt = (jobDef.prompt || 'unnamed').substring(0, 30)
      .replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/_$/, '');

    const ext = jobDef.type === 'text-to-image' ? '.png' : '.mp4';

    const baseName = pattern
      .replace('{provider}', jobDef.provider)
      .replace('{index}', String(index).padStart(3, '0'))
      .replace('{timestamp}', timestamp)
      .replace('{prompt}', safePrompt)
      .replace('{type}', jobDef.type);

    return path.join(outputFolder, baseName + ext);
  }

  async shutdown() {
    this.cancelAll();
    for (const provider of Object.keys(this.converters)) {
      if (this.converters[provider]) {
        try {
          await this.converters[provider].stop();
        } catch (e) {}
        this.converters[provider] = null;
      }
    }
  }

  // Validate cookies for a provider
  async validateProvider(provider) {
    try {
      const converter = await this._getConverter(provider);
      const valid = await converter.validateSession();
      this.config.setProviderStatus(provider, valid ? 'valid' : 'invalid');
      return valid;
    } catch (e) {
      this.config.setProviderStatus(provider, 'invalid');
      return false;
    }
  }
}

module.exports = { Orchestrator, CAPABILITIES };
