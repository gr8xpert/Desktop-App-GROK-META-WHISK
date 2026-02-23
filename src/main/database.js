const fs = require('fs');
const path = require('path');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath.replace('.db', '.json');
    this.data = { jobs: [] };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const content = fs.readFileSync(this.dbPath, 'utf8');
        this.data = JSON.parse(content);
        if (!this.data.jobs) this.data.jobs = [];
      }
    } catch (e) {
      console.error('[DB] Failed to load:', e.message);
      this.data = { jobs: [] };
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[DB] Failed to save:', e.message);
    }
  }

  addJob(job) {
    const entry = {
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      provider: job.provider,
      type: job.type,
      prompt: job.prompt || '',
      imagePath: job.imagePath || null,
      outputPath: job.outputPath || null,
      status: job.status || 'pending',
      error: job.error || null,
      attempts: job.attempts || 0,
      options: job.options || {},
      batchId: job.batchId || null,
      videoUrl: job.videoUrl || null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      duration: null
    };

    this.data.jobs.unshift(entry);

    // Keep last 2000 entries
    if (this.data.jobs.length > 2000) {
      this.data.jobs = this.data.jobs.slice(0, 2000);
    }

    this._save();
    return entry;
  }

  updateJob(id, updates) {
    const job = this.data.jobs.find(j => j.id === id);
    if (job) {
      Object.assign(job, updates);
      if (updates.status === 'success' || updates.status === 'failed') {
        job.completedAt = new Date().toISOString();
        if (job.createdAt) {
          job.duration = Math.round((new Date(job.completedAt) - new Date(job.createdAt)) / 1000);
        }
      }
      this._save();
    }
    return job;
  }

  getJobs(options = {}) {
    const { limit = 100, offset = 0, status, provider, search, batchId } = options;

    let filtered = this.data.jobs;

    if (status && status !== 'all') {
      filtered = filtered.filter(j => j.status === status);
    }

    if (provider && provider !== 'all') {
      filtered = filtered.filter(j => j.provider === provider);
    }

    if (batchId) {
      filtered = filtered.filter(j => j.batchId === batchId);
    }

    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(j =>
        (j.prompt && j.prompt.toLowerCase().includes(s)) ||
        (j.outputPath && j.outputPath.toLowerCase().includes(s)) ||
        (j.provider && j.provider.toLowerCase().includes(s))
      );
    }

    return filtered.slice(offset, offset + limit);
  }

  getJob(id) {
    return this.data.jobs.find(j => j.id === id) || null;
  }

  getStats() {
    const jobs = this.data.jobs;
    return {
      total: jobs.length,
      success: jobs.filter(j => j.status === 'success').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      pending: jobs.filter(j => j.status === 'pending').length,
      running: jobs.filter(j => j.status === 'running').length,
      byProvider: {
        meta: jobs.filter(j => j.provider === 'meta').length,
        grok: jobs.filter(j => j.provider === 'grok').length,
        whisk: jobs.filter(j => j.provider === 'whisk').length,
        imagefx: jobs.filter(j => j.provider === 'imagefx').length
      }
    };
  }

  deleteJob(id) {
    const idx = this.data.jobs.findIndex(j => j.id === id);
    if (idx !== -1) {
      this.data.jobs.splice(idx, 1);
      this._save();
      return true;
    }
    return false;
  }

  clear() {
    this.data.jobs = [];
    this._save();
    return true;
  }

  close() {
    // No-op for JSON storage
  }
}

module.exports = { Database };
