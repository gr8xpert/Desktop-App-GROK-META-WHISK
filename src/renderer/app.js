// ============================================
// AI Video Generator - Frontend Logic
// ============================================

// State
let currentTab = 'generate';
let selectedProvider = 'meta';
let selectedType = 'image-to-video';
let selectedImages = [];
let providerCapabilities = null;
let activeProgressItems = {};
let activeBatchTab = 'meta';
let bulkMode = false;
let bulkPrompts = {}; // maps image path → prompt string
let imageJobMap = {}; // maps image path → jobId for status tracking
let bulkPromptMode = false; // bulk mode for text-to-image prompts
let bulkPromptLinesTxt = []; // raw lines from .txt for text-to-image bulk
let t2vBulkMode = false; // bulk mode for text-to-video
let t2vBulkImagePrompts = []; // image generation prompts from .txt
let t2vBulkAnimPrompts = []; // animation prompts from .txt

// ============ Initialization ============

document.addEventListener('DOMContentLoaded', async () => {
  // Load capabilities
  providerCapabilities = await window.api.getProviderCapabilities();

  // Load config and populate settings
  await loadSettings();
  await loadProviderStatus();

  // Setup event handlers
  setupTabNavigation();
  setupProviderSelection();
  setupTypeSelection();
  setupImageUpload();
  setupBatchTabs();
  setupWindowControls();
  setupButtons();
  setupBulkMode();
  setupBulkPromptMode();
  setupT2vBulkMode();
  setupGrokPremiumHint();
  setupIPCListeners();
  updateTypeAvailability();
  updatePromptContext();

  // Check if first run (no cookies configured)
  const status = await window.api.getCookieStatus();
  const allUnconfigured = Object.values(status).every(s => s === 'unconfigured');
  if (allUnconfigured) {
    switchTab('settings');
  }
});

// ============ Tab Navigation ============

function setupTabNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tabName) {
  currentTab = tabName;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${tabName}"]`).classList.add('active');

  // Update pages
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // Load history when switching to history tab
  if (tabName === 'history') {
    loadHistory();
  }
}

// ============ Provider Selection ============

function setupProviderSelection() {
  document.querySelectorAll('.provider-option').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.provider-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedProvider = opt.dataset.provider;
      updateTypeAvailability();
      updateModelVisibility();
    });
  });
}

function updateTypeAvailability() {
  const pills = document.querySelectorAll('.type-pill');
  const caps = providerCapabilities || {};

  pills.forEach(pill => {
    const type = pill.dataset.type;

    {
      const providerCaps = caps[selectedProvider];
      if (providerCaps && !providerCaps.types.includes(type)) {
        pill.disabled = true;
        if (pill.classList.contains('selected')) {
          pill.classList.remove('selected');
          // Select first available
          const firstAvailable = document.querySelector('.type-pill:not(:disabled)');
          if (firstAvailable) {
            firstAvailable.classList.add('selected');
            selectedType = firstAvailable.dataset.type;
          }
        }
      } else {
        pill.disabled = false;
      }
    }
  });

  updateUploadVisibility();
  updatePromptContext();
}

function updateModelVisibility() {
  const modelGroup = document.getElementById('model-group');
  if (selectedProvider === 'imagefx') {
    modelGroup.classList.add('visible');
  } else {
    modelGroup.classList.remove('visible');
  }
}

// ============ Type Selection ============

function setupTypeSelection() {
  document.querySelectorAll('.type-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      if (pill.disabled) return;
      document.querySelectorAll('.type-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      selectedType = pill.dataset.type;
      updateUploadVisibility();
      updatePromptContext();
    });
  });
}

function updateUploadVisibility() {
  const uploadCard = document.getElementById('upload-card');
  const aspectGroup = document.getElementById('aspect-ratio-group');
  const durationGroup = document.getElementById('video-duration-group');
  const resolutionGroup = document.getElementById('video-resolution-group');

  // Hide aspect ratio for image-to-video (not supported by any provider in this mode)
  if (aspectGroup) {
    aspectGroup.style.display = (selectedType === 'image-to-video') ? 'none' : 'block';
  }

  // Grok-only video controls: show when provider=grok AND type includes "video"
  const isGrokVideo = selectedProvider === 'grok' && (selectedType === 'image-to-video' || selectedType === 'text-to-video');
  if (durationGroup) durationGroup.style.display = isGrokVideo ? 'block' : 'none';
  if (resolutionGroup) resolutionGroup.style.display = isGrokVideo ? 'block' : 'none';
  updateGrokPremiumHint();

  // Manage aspect ratio options: Grok supports 5 ratios, others only 3
  const grokRatioOptions = document.querySelectorAll('#aspect-ratio option.grok-ratio');
  grokRatioOptions.forEach(opt => {
    opt.style.display = (selectedProvider === 'grok') ? '' : 'none';
    // Reset to default if a grok-only ratio is selected when switching away
    if (selectedProvider !== 'grok' && document.getElementById('aspect-ratio').value === opt.value) {
      document.getElementById('aspect-ratio').value = '9:16';
    }
  });

  if (selectedType === 'image-to-video') {
    uploadCard.style.display = 'block';
  } else {
    uploadCard.style.display = 'none';
    // Reset bulk mode when switching away from image-to-video
    if (bulkMode) {
      bulkMode = false;
      bulkPrompts = {};
      bulkPromptLines = [];
      const toggle = document.getElementById('bulk-toggle');
      if (toggle) toggle.classList.remove('active');
      document.getElementById('bulk-panel').style.display = 'none';
      document.getElementById('prompt-card').style.display = 'block';
    }
  }
}

// ============ Grok Premium Hint ============

function setupGrokPremiumHint() {
  document.getElementById('video-duration').addEventListener('change', updateGrokPremiumHint);
  document.getElementById('video-resolution').addEventListener('change', updateGrokPremiumHint);
}

function updateGrokPremiumHint() {
  const hint = document.getElementById('grok-premium-hint');
  if (!hint) return;
  const duration = document.getElementById('video-duration').value;
  const resolution = document.getElementById('video-resolution').value;
  const isPremium = duration === '10s' || resolution === '720p';
  const isGrokVideo = selectedProvider === 'grok' && (selectedType === 'image-to-video' || selectedType === 'text-to-video');
  hint.style.display = (isGrokVideo && isPremium) ? 'block' : 'none';
}

// ============ Image Upload ============

function setupImageUpload() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) {
      alert('Please drop image files (JPG, PNG, WebP)');
      return;
    }
    addImages(files);
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    addImages(files);
    fileInput.value = '';
  });
}

function addImages(files) {
  const newPaths = files.map(f => f.path);
  if (bulkMode && selectedImages.length > 0) {
    // In bulk mode, append new images instead of replacing
    selectedImages = [...selectedImages, ...newPaths];
  } else {
    selectedImages = newPaths;
  }
  updateDropPreview();
  if (bulkMode) {
    refreshBulkUI();
  }
}

function updateDropPreview() {
  const preview = document.getElementById('drop-preview');
  preview.innerHTML = '';

  selectedImages.forEach(imgPath => {
    const wrapper = document.createElement('div');
    wrapper.className = 'thumb-wrapper';
    wrapper.dataset.imagePath = imgPath;

    const img = document.createElement('img');
    img.src = `file://${imgPath}`;
    img.title = imgPath.split(/[/\\]/).pop();
    wrapper.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'thumb-status';
    wrapper.appendChild(overlay);

    preview.appendChild(wrapper);
  });
}

// ============ Buttons ============

function setupButtons() {
  // Start Generation
  document.getElementById('btn-start').addEventListener('click', startGeneration);

  // Output folder — persist immediately on selection
  document.getElementById('btn-select-folder').addEventListener('click', async () => {
    const folder = await window.api.selectFolder();
    if (folder) {
      document.getElementById('output-folder').value = folder;
      document.getElementById('settings-output-folder').value = folder;
      await window.api.saveConfig({ outputFolder: folder });
    }
  });

  // Settings folder
  document.getElementById('btn-settings-folder').addEventListener('click', async () => {
    const folder = await window.api.selectFolder();
    if (folder) document.getElementById('settings-output-folder').value = folder;
  });

  // Save settings
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // Validate buttons
  document.getElementById('btn-validate-meta').addEventListener('click', () => doValidateProvider('meta'));
  document.getElementById('btn-validate-grok').addEventListener('click', () => doValidateProvider('grok'));
  document.getElementById('btn-validate-whisk').addEventListener('click', () => doValidateProvider('whisk'));
  document.getElementById('btn-validate-imagefx').addEventListener('click', () => doValidateProvider('imagefx'));

  // Run batch (merge all tabs)
  document.getElementById('btn-run-batch').addEventListener('click', mergeBatchAndSubmit);

  // Cancel batch
  document.getElementById('btn-cancel-batch').addEventListener('click', async () => {
    await window.api.cancelAll();
  });

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (confirm('Clear all generation history?')) {
      await window.api.clearHistory();
      loadHistory();
    }
  });

  // History search/filter
  document.getElementById('history-search').addEventListener('input', loadHistory);
  document.getElementById('history-filter').addEventListener('change', loadHistory);
}

// ============ Start Generation ============

async function startGeneration() {
  const prompt = document.getElementById('gen-prompt').value.trim();
  const outputFolder = document.getElementById('output-folder').value;
  const aspectRatio = document.getElementById('aspect-ratio').value;

  // For Meta text-to-video, grab both prompts (Grok uses single prompt)
  let t2vImagePrompt = '';
  let t2vAnimationPrompt = '';
  if (selectedType === 'text-to-video' && selectedProvider === 'meta') {
    if (t2vBulkMode) {
      if (t2vBulkImagePrompts.length === 0) {
        alert('Please load an image prompts file for bulk mode');
        return;
      }
    } else {
      t2vImagePrompt = document.getElementById('t2v-image-prompt').value.trim();
      t2vAnimationPrompt = document.getElementById('t2v-animation-prompt').value.trim();
      if (!t2vImagePrompt) {
        alert('Please enter an image generation prompt');
        return;
      }
    }
  }

  // Validation
  if (selectedType !== 'image-to-video' && !(selectedType === 'text-to-video' && selectedProvider === 'meta') && !prompt && !bulkPromptMode) {
    alert('Please enter a prompt');
    return;
  }

  if (bulkPromptMode && bulkPromptLinesTxt.length === 0) {
    alert('Please load a prompts file for bulk mode');
    return;
  }

  // Check for multiple prompts in single prompt mode (text-to-image only)
  if (!bulkPromptMode && selectedType === 'text-to-image' && prompt) {
    const lines = prompt.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 1) {
      alert('Only one prompt is allowed in single mode.\nUse Bulk Mode to submit multiple prompts at once.');
      return;
    }
  }

  if (selectedType === 'image-to-video' && selectedImages.length === 0) {
    alert('Please select an image');
    return;
  }

  if (!outputFolder) {
    alert('Please select an output folder');
    return;
  }

  const btn = document.getElementById('btn-start');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  // Build options
  const jobOptions = { aspectRatio };
  if (selectedProvider === 'imagefx') {
    jobOptions.model = document.getElementById('imagefx-model').value;
  }
  // Grok video-specific options
  if (selectedProvider === 'grok' && (selectedType === 'image-to-video' || selectedType === 'text-to-video')) {
    jobOptions.duration = document.getElementById('video-duration').value;
    jobOptions.resolution = document.getElementById('video-resolution').value;
  }

  try {
    imageJobMap = {}; // Reset mapping for new batch
    if (selectedType === 'image-to-video') {
      // Submit one job per image
      for (const imagePath of selectedImages) {
        // In bulk mode, use per-image prompt; otherwise use the shared prompt
        let jobPrompt;
        if (bulkMode) {
          jobPrompt = getBulkPromptForImage(imagePath) || 'Animate this image';
        } else {
          jobPrompt = prompt || 'Animate this image';
        }
        const result = await window.api.submitJob({
          provider: selectedProvider,
          type: selectedType,
          prompt: jobPrompt,
          image: imagePath,
          options: jobOptions,
          outputFolder
        });
        if (!result.success) {
          alert('Errors:\n' + result.errors.join('\n'));
          break;
        }
        // Map image to jobId for status overlay
        if (result.jobId) {
          imageJobMap[result.jobId] = imagePath;
          updateImageStatus(imagePath, 'pending');
        }
      }
    } else if (bulkPromptMode && bulkPromptLinesTxt.length > 0) {
      // Bulk text-to-image: one job per prompt line
      for (let i = 0; i < bulkPromptLinesTxt.length; i++) {
        const linePrompt = bulkPromptLinesTxt[i];
        const result = await window.api.submitJob({
          provider: selectedProvider,
          type: selectedType,
          prompt: linePrompt,
          options: jobOptions,
          outputFolder
        });
        if (!result.success) {
          alert('Errors:\n' + result.errors.join('\n'));
          break;
        }
      }
    } else if (selectedType === 'text-to-video' && selectedProvider === 'meta' && t2vBulkMode) {
      // Meta bulk text-to-video: one job per prompt pair
      for (let i = 0; i < t2vBulkImagePrompts.length; i++) {
        const imgPrompt = t2vBulkImagePrompts[i];
        const animPrompt = t2vBulkAnimPrompts[i] || imgPrompt;
        const result = await window.api.submitJob({
          provider: selectedProvider,
          type: selectedType,
          prompt: imgPrompt,
          options: { ...jobOptions, animationPrompt: animPrompt },
          outputFolder
        });
        if (!result.success) {
          alert('Errors:\n' + result.errors.join('\n'));
          break;
        }
      }
    } else if (selectedType === 'text-to-video' && selectedProvider === 'meta') {
      // Meta single text-to-video: dual prompts (image gen + animation)
      const result = await window.api.submitJob({
        provider: selectedProvider,
        type: selectedType,
        prompt: t2vImagePrompt,
        options: { ...jobOptions, animationPrompt: t2vAnimationPrompt || t2vImagePrompt },
        outputFolder
      });
      if (!result.success) {
        alert('Errors:\n' + result.errors.join('\n'));
      }
    } else if (selectedType === 'text-to-video' && bulkPromptMode && bulkPromptLinesTxt.length > 0) {
      // Grok (and others): bulk text-to-video — one job per prompt line
      for (let i = 0; i < bulkPromptLinesTxt.length; i++) {
        const linePrompt = bulkPromptLinesTxt[i];
        const result = await window.api.submitJob({
          provider: selectedProvider,
          type: selectedType,
          prompt: linePrompt,
          options: jobOptions,
          outputFolder
        });
        if (!result.success) {
          alert('Errors:\n' + result.errors.join('\n'));
          break;
        }
      }
    } else if (selectedType === 'text-to-video') {
      // Grok (and others): single prompt text-to-video
      if (!prompt) {
        alert('Please enter a video prompt');
        return;
      }
      const result = await window.api.submitJob({
        provider: selectedProvider,
        type: selectedType,
        prompt,
        options: jobOptions,
        outputFolder
      });
      if (!result.success) {
        alert('Errors:\n' + result.errors.join('\n'));
      }
    } else {
      const result = await window.api.submitJob({
        provider: selectedProvider,
        type: selectedType,
        prompt,
        options: jobOptions,
        outputFolder
      });
      if (!result.success) {
        alert('Errors:\n' + result.errors.join('\n'));
      }
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }

  btn.disabled = false;
  btn.textContent = 'Start Generation';
}

// ============ Contextual Prompt Hints ============

function updatePromptContext() {
  const titleEl = document.getElementById('prompt-title');
  const hintEl = document.getElementById('prompt-hint');
  const textareaEl = document.getElementById('gen-prompt');
  const bulkPromptToggle = document.getElementById('bulk-prompt-toggle');

  if (!titleEl || !hintEl || !textareaEl) return;

  // Show bulk prompt toggle for text-to-image OR Grok text-to-video (single-prompt bulk)
  const showBulkPromptToggle = selectedType === 'text-to-image' ||
    (selectedType === 'text-to-video' && selectedProvider !== 'meta');
  if (bulkPromptToggle) {
    bulkPromptToggle.style.display = showBulkPromptToggle ? '' : 'none';
    // Reset bulk prompt mode when switching away
    if (!showBulkPromptToggle && bulkPromptMode) {
      bulkPromptMode = false;
      bulkPromptLinesTxt = [];
      bulkPromptToggle.classList.remove('active');
      document.getElementById('single-prompt-panel').style.display = 'block';
      document.getElementById('bulk-prompt-panel').style.display = 'none';
    }
  }

  const t2vPanel = document.getElementById('t2v-prompt-panel');
  const singlePanel = document.getElementById('single-prompt-panel');
  const t2vBulkToggle = document.getElementById('t2v-bulk-toggle');

  // Show t2v bulk toggle only for text-to-video with Meta (Grok uses single prompt)
  const isMetaT2v = selectedProvider === 'meta' && selectedType === 'text-to-video';
  if (t2vBulkToggle) {
    t2vBulkToggle.style.display = isMetaT2v ? '' : 'none';
    // Reset t2v bulk mode when switching away from Meta t2v
    if (!isMetaT2v && t2vBulkMode) {
      t2vBulkMode = false;
      t2vBulkImagePrompts = [];
      t2vBulkAnimPrompts = [];
      t2vBulkToggle.classList.remove('active');
    }
  }

  if (selectedType === 'text-to-video' && selectedProvider === 'meta') {
    // Meta text-to-video: dual-prompt panel (image gen + animation)
    titleEl.textContent = 'Video Prompts';
    if (singlePanel) singlePanel.style.display = 'none';
    if (t2vPanel) t2vPanel.style.display = 'block';
    if (document.getElementById('bulk-prompt-panel')) {
      document.getElementById('bulk-prompt-panel').style.display = 'none';
    }
  } else if (selectedType === 'text-to-video') {
    // Grok (and others): single prompt for direct text-to-video
    titleEl.textContent = 'Video Prompt';
    hintEl.textContent = 'Describe the video you want to generate.';
    textareaEl.placeholder = 'e.g. A white honda civic driving through a neon-lit city at night...';
    if (t2vPanel) t2vPanel.style.display = 'none';
    if (!bulkPromptMode && singlePanel) singlePanel.style.display = 'block';
    if (document.getElementById('bulk-prompt-panel')) {
      document.getElementById('bulk-prompt-panel').style.display = 'none';
    }
  } else {
    // Hide dual-prompt panel, show single prompt (unless bulk mode is active)
    if (t2vPanel) t2vPanel.style.display = 'none';
    if (!bulkPromptMode && singlePanel) singlePanel.style.display = 'block';

    switch (selectedType) {
      case 'image-to-video':
        titleEl.textContent = 'Animation Prompt (Optional)';
        hintEl.textContent = 'Describe how to animate the image \u2014 this custom prompt will be applied to all images.';
        textareaEl.placeholder = 'e.g. Slow zoom in with cinematic lighting...';
        break;
      case 'text-to-image':
        titleEl.textContent = 'Image Prompt';
        hintEl.textContent = 'Describe the image you want to generate.';
        textareaEl.placeholder = 'e.g. A cyberpunk street scene at night...';
        break;
    }
  }
}

// ============ Bulk Mode ============

let bulkPromptLines = []; // raw lines from .txt file

function setupBulkMode() {
  const toggle = document.getElementById('bulk-toggle');
  const bulkDropImages = document.getElementById('bulk-drop-images');
  const bulkDropPrompts = document.getElementById('bulk-drop-prompts');

  toggle.addEventListener('click', toggleBulkMode);

  // Left column: click to browse images
  bulkDropImages.addEventListener('click', () => document.getElementById('file-input').click());

  // Left column: drag & drop images
  bulkDropImages.addEventListener('dragover', (e) => {
    e.preventDefault();
    bulkDropImages.style.borderColor = 'var(--accent)';
    bulkDropImages.style.background = 'var(--accent-dim)';
  });
  bulkDropImages.addEventListener('dragleave', () => {
    bulkDropImages.style.borderColor = '';
    bulkDropImages.style.background = '';
  });
  bulkDropImages.addEventListener('drop', (e) => {
    e.preventDefault();
    bulkDropImages.style.borderColor = '';
    bulkDropImages.style.background = '';
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) addImages(files);
  });

  // Right column: click to load .txt
  bulkDropPrompts.addEventListener('click', loadBulkPromptsFromTxt);
}

function toggleBulkMode() {
  bulkMode = !bulkMode;
  const toggle = document.getElementById('bulk-toggle');
  const panel = document.getElementById('bulk-panel');
  const promptCard = document.getElementById('prompt-card');
  const dropZone = document.getElementById('drop-zone');

  toggle.classList.toggle('active', bulkMode);

  if (bulkMode) {
    panel.style.display = 'block';
    dropZone.style.display = 'none';
    updateBulkLayout();
    refreshBulkUI();
  } else {
    panel.style.display = 'none';
    promptCard.style.display = 'block';
    dropZone.style.display = 'block';
    bulkPrompts = {};
    bulkPromptLines = [];
  }
}

function refreshBulkUI() {
  refreshBulkImages();
  refreshBulkPromptList();
  refreshBulkMappingPreview();
}

function refreshBulkImages() {
  const dropZone = document.getElementById('bulk-drop-images');
  const thumbs = document.getElementById('bulk-thumbs');
  const countEl = document.getElementById('bulk-img-count');

  countEl.textContent = `${selectedImages.length} file${selectedImages.length !== 1 ? 's' : ''}`;

  if (selectedImages.length === 0) {
    dropZone.classList.remove('has-content');
    dropZone.innerHTML = `
      <div class="bulk-drop-icon">&#128194;</div>
      <div class="bulk-drop-text">Drop images or click to browse</div>
      <div class="bulk-drop-hint">JPG, PNG, WebP</div>
    `;
    thumbs.innerHTML = '';
    return;
  }

  dropZone.classList.add('has-content');
  dropZone.innerHTML = `<div class="bulk-drop-text">+ Add more images</div>`;

  thumbs.innerHTML = '';
  selectedImages.forEach(imgPath => {
    const wrapper = document.createElement('div');
    wrapper.className = 'thumb-wrapper';
    wrapper.dataset.imagePath = imgPath;

    const img = document.createElement('img');
    img.src = `file://${imgPath}`;
    img.title = imgPath.split(/[/\\]/).pop();
    wrapper.appendChild(img);

    const overlay = document.createElement('div');
    overlay.className = 'thumb-status';
    wrapper.appendChild(overlay);

    thumbs.appendChild(wrapper);
  });
}

function refreshBulkPromptList() {
  const dropZone = document.getElementById('bulk-drop-prompts');
  const list = document.getElementById('bulk-prompt-list');
  const countEl = document.getElementById('bulk-prompt-count');

  countEl.textContent = `${bulkPromptLines.length} line${bulkPromptLines.length !== 1 ? 's' : ''}`;

  if (bulkPromptLines.length === 0) {
    dropZone.classList.remove('has-content');
    dropZone.innerHTML = `
      <div class="bulk-drop-icon">&#128221;</div>
      <div class="bulk-drop-text">Click to load prompts file</div>
      <div class="bulk-drop-hint">.txt &mdash; one prompt per line</div>
    `;
    list.innerHTML = '';
    return;
  }

  dropZone.classList.add('has-content');
  dropZone.innerHTML = `<div class="bulk-drop-text">+ Load different file</div>`;

  list.innerHTML = '';
  bulkPromptLines.forEach((line, i) => {
    const item = document.createElement('div');
    item.className = 'bulk-prompt-item';
    item.innerHTML = `
      <span class="prompt-num">${i + 1}</span>
      <span class="prompt-text" title="${escapeHtml(line)}">${escapeHtml(line)}</span>
    `;
    list.appendChild(item);
  });
}

function refreshBulkMappingPreview() {
  const preview = document.getElementById('bulk-mapping-preview');

  if (selectedImages.length === 0 && bulkPromptLines.length === 0) {
    preview.innerHTML = '';
    return;
  }

  // Pair images with prompts
  const count = Math.max(selectedImages.length, bulkPromptLines.length);
  if (count === 0) { preview.innerHTML = ''; return; }

  // Also update bulkPrompts map from lines
  selectedImages.forEach((imgPath, i) => {
    if (i < bulkPromptLines.length) {
      bulkPrompts[imgPath] = bulkPromptLines[i];
    }
  });

  let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500;">Mapping Preview</div>';
  for (let i = 0; i < Math.min(selectedImages.length, 20); i++) {
    const imgPath = selectedImages[i];
    const filename = imgPath.split(/[/\\]/).pop();
    const prompt = bulkPromptLines[i] || '';
    html += `
      <div class="bulk-map-row">
        <img src="file://${imgPath}" alt="${escapeHtml(filename)}">
        <span class="bulk-map-arrow">&rarr;</span>
        <span class="bulk-map-prompt ${prompt ? '' : 'empty'}">${prompt ? escapeHtml(prompt) : 'Default animation'}</span>
      </div>
    `;
  }
  if (selectedImages.length > 20) {
    html += `<div style="text-align:center;font-size:12px;color:var(--text-muted);padding:8px;">+${selectedImages.length - 20} more...</div>`;
  }
  preview.innerHTML = html;
}

function getBulkPromptForImage(imagePath) {
  const prompt = (bulkPrompts[imagePath] || '').trim();
  return prompt || '';
}

async function loadBulkPromptsFromTxt() {
  const content = await window.api.selectTxtFile();
  if (!content) return;

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    alert('No prompts found in file (file is empty or all lines are blank)');
    return;
  }

  bulkPromptLines = lines;

  // Fill bulkPrompts map: line 1 → image 1, etc.
  selectedImages.forEach((imgPath, i) => {
    if (i < lines.length) {
      bulkPrompts[imgPath] = lines[i];
    }
  });

  refreshBulkUI();
}

// ============ Bulk Prompt Mode (Text-to-Image) ============

function setupBulkPromptMode() {
  const toggle = document.getElementById('bulk-prompt-toggle');
  const dropZone = document.getElementById('bulk-drop-prompts-txt');

  toggle.addEventListener('click', toggleBulkPromptMode);
  dropZone.addEventListener('click', loadBulkPromptsForTextToImage);
}

function toggleBulkPromptMode() {
  bulkPromptMode = !bulkPromptMode;
  const toggle = document.getElementById('bulk-prompt-toggle');
  const singlePanel = document.getElementById('single-prompt-panel');
  const bulkPanel = document.getElementById('bulk-prompt-panel');

  toggle.classList.toggle('active', bulkPromptMode);

  if (bulkPromptMode) {
    singlePanel.style.display = 'none';
    bulkPanel.style.display = 'block';
    refreshBulkPromptListTxt();
  } else {
    singlePanel.style.display = 'block';
    bulkPanel.style.display = 'none';
    bulkPromptLinesTxt = [];
  }
}

async function loadBulkPromptsForTextToImage() {
  const content = await window.api.selectTxtFile();
  if (!content) return;

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    alert('No prompts found in file');
    return;
  }

  bulkPromptLinesTxt = lines;
  refreshBulkPromptListTxt();
}

function refreshBulkPromptListTxt() {
  const dropZone = document.getElementById('bulk-drop-prompts-txt');
  const list = document.getElementById('bulk-prompt-list-txt');
  const countEl = document.getElementById('bulk-prompt-count-txt');

  countEl.textContent = `${bulkPromptLinesTxt.length} line${bulkPromptLinesTxt.length !== 1 ? 's' : ''}`;

  if (bulkPromptLinesTxt.length === 0) {
    dropZone.classList.remove('has-content');
    dropZone.innerHTML = `
      <div class="bulk-drop-icon">&#128221;</div>
      <div class="bulk-drop-text">Click to load prompts file</div>
      <div class="bulk-drop-hint">.txt &mdash; one prompt per line</div>
    `;
    list.innerHTML = '';
    return;
  }

  dropZone.classList.add('has-content');
  dropZone.innerHTML = `<div class="bulk-drop-text">+ Load different file</div>`;

  list.innerHTML = '';
  bulkPromptLinesTxt.forEach((line, i) => {
    const item = document.createElement('div');
    item.className = 'bulk-prompt-item';
    item.innerHTML = `
      <span class="prompt-num">${i + 1}</span>
      <span class="prompt-text" title="${escapeHtml(line)}">${escapeHtml(line)}</span>
    `;
    list.appendChild(item);
  });
}

// ============ T2V Bulk Mode (Text-to-Video) ============

function setupT2vBulkMode() {
  const toggle = document.getElementById('t2v-bulk-toggle');
  const dropImg = document.getElementById('t2v-bulk-drop-img-prompts');
  const dropAnim = document.getElementById('t2v-bulk-drop-anim-prompts');

  toggle.addEventListener('click', toggleT2vBulkMode);
  dropImg.addEventListener('click', loadT2vBulkImagePrompts);
  dropAnim.addEventListener('click', loadT2vBulkAnimPrompts);
}

function toggleT2vBulkMode() {
  t2vBulkMode = !t2vBulkMode;
  const toggle = document.getElementById('t2v-bulk-toggle');
  const singlePanel = document.getElementById('t2v-single-panel');
  const bulkPanel = document.getElementById('t2v-bulk-panel');

  toggle.classList.toggle('active', t2vBulkMode);

  if (t2vBulkMode) {
    singlePanel.style.display = 'none';
    bulkPanel.style.display = 'block';
    refreshT2vBulkUI();
  } else {
    singlePanel.style.display = 'block';
    bulkPanel.style.display = 'none';
    t2vBulkImagePrompts = [];
    t2vBulkAnimPrompts = [];
  }
}

async function loadT2vBulkImagePrompts() {
  const content = await window.api.selectTxtFile();
  if (!content) return;

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    alert('No prompts found in file');
    return;
  }

  t2vBulkImagePrompts = lines;
  refreshT2vBulkUI();
}

async function loadT2vBulkAnimPrompts() {
  const content = await window.api.selectTxtFile();
  if (!content) return;

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    alert('No prompts found in file');
    return;
  }

  t2vBulkAnimPrompts = lines;
  refreshT2vBulkUI();
}

function refreshT2vBulkUI() {
  // Image prompts column
  const dropImg = document.getElementById('t2v-bulk-drop-img-prompts');
  const imgList = document.getElementById('t2v-bulk-img-list');
  const imgCount = document.getElementById('t2v-bulk-img-count');

  imgCount.textContent = `${t2vBulkImagePrompts.length} line${t2vBulkImagePrompts.length !== 1 ? 's' : ''}`;

  if (t2vBulkImagePrompts.length === 0) {
    dropImg.classList.remove('has-content');
    dropImg.innerHTML = `
      <div class="bulk-drop-icon">&#128221;</div>
      <div class="bulk-drop-text">Click to load image prompts</div>
      <div class="bulk-drop-hint">.txt &mdash; one prompt per line</div>
    `;
    imgList.innerHTML = '';
  } else {
    dropImg.classList.add('has-content');
    dropImg.innerHTML = `<div class="bulk-drop-text">+ Load different file</div>`;
    imgList.innerHTML = '';
    t2vBulkImagePrompts.forEach((line, i) => {
      const item = document.createElement('div');
      item.className = 'bulk-prompt-item';
      item.innerHTML = `
        <span class="prompt-num">${i + 1}</span>
        <span class="prompt-text" title="${escapeHtml(line)}">${escapeHtml(line)}</span>
      `;
      imgList.appendChild(item);
    });
  }

  // Animation prompts column
  const dropAnim = document.getElementById('t2v-bulk-drop-anim-prompts');
  const animList = document.getElementById('t2v-bulk-anim-list');
  const animCount = document.getElementById('t2v-bulk-anim-count');

  animCount.textContent = `${t2vBulkAnimPrompts.length} line${t2vBulkAnimPrompts.length !== 1 ? 's' : ''}`;

  if (t2vBulkAnimPrompts.length === 0) {
    dropAnim.classList.remove('has-content');
    dropAnim.innerHTML = `
      <div class="bulk-drop-icon">&#128221;</div>
      <div class="bulk-drop-text">Click to load animation prompts</div>
      <div class="bulk-drop-hint">.txt &mdash; one prompt per line</div>
    `;
    animList.innerHTML = '';
  } else {
    dropAnim.classList.add('has-content');
    dropAnim.innerHTML = `<div class="bulk-drop-text">+ Load different file</div>`;
    animList.innerHTML = '';
    t2vBulkAnimPrompts.forEach((line, i) => {
      const item = document.createElement('div');
      item.className = 'bulk-prompt-item';
      item.innerHTML = `
        <span class="prompt-num">${i + 1}</span>
        <span class="prompt-text" title="${escapeHtml(line)}">${escapeHtml(line)}</span>
      `;
      animList.appendChild(item);
    });
  }

  // Mapping preview
  refreshT2vBulkMapping();
}

function refreshT2vBulkMapping() {
  const preview = document.getElementById('t2v-bulk-mapping-preview');

  if (t2vBulkImagePrompts.length === 0) {
    preview.innerHTML = '';
    return;
  }

  let html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-weight:500;">Mapping Preview</div>';
  const count = Math.min(t2vBulkImagePrompts.length, 20);

  for (let i = 0; i < count; i++) {
    const imgPrompt = t2vBulkImagePrompts[i];
    const animPrompt = t2vBulkAnimPrompts[i] || '';
    html += `
      <div class="bulk-map-row">
        <span class="bulk-map-prompt" style="flex:1;" title="${escapeHtml(imgPrompt)}">${escapeHtml(imgPrompt)}</span>
        <span class="bulk-map-arrow">&rarr;</span>
        <span class="bulk-map-prompt ${animPrompt ? '' : 'empty'}" style="flex:1;" title="${escapeHtml(animPrompt || 'Same as image prompt')}">${animPrompt ? escapeHtml(animPrompt) : 'Same as image prompt'}</span>
      </div>
    `;
  }

  if (t2vBulkImagePrompts.length > 20) {
    html += `<div style="text-align:center;font-size:12px;color:var(--text-muted);padding:8px;">+${t2vBulkImagePrompts.length - 20} more...</div>`;
  }

  preview.innerHTML = html;
}

// ============ Batch / JSON (Per-Provider Tabs) ============

function setupBatchTabs() {
  const allProviders = ['meta', 'grok', 'whisk', 'imagefx'];

  // Sub-tab switching
  document.querySelectorAll('.batch-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.batchProvider;
      switchBatchTab(provider);
    });
  });

  // Per-provider JSON editor validation on input
  allProviders.forEach(provider => {
    const editor = document.getElementById(`json-editor-${provider}`);
    if (editor) {
      editor.addEventListener('input', () => validateProviderJson(provider));
    }
  });

  // Per-provider template buttons
  document.querySelectorAll('.btn-batch-templates').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const provider = btn.dataset.batchProvider;
      const menu = document.getElementById(`template-menu-${provider}`);
      // Close all other menus
      document.querySelectorAll('.template-menu').forEach(m => {
        if (m !== menu) m.classList.remove('open');
      });
      menu.classList.toggle('open');
    });
  });

  // Close template menus on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.template-menu').forEach(m => m.classList.remove('open'));
  });

  // Template item clicks
  document.querySelectorAll('.template-item').forEach(item => {
    item.addEventListener('click', () => {
      const provider = item.dataset.provider;
      const template = getBatchTemplate(item.dataset.template);
      const editor = document.getElementById(`json-editor-${provider}`);
      if (editor) {
        editor.value = JSON.stringify(template, null, 2);
        validateProviderJson(provider);
      }
      // Close menu
      document.querySelectorAll('.template-menu').forEach(m => m.classList.remove('open'));
    });
  });

  // Load Prompts (.txt) buttons
  document.querySelectorAll('.btn-load-prompts').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      await loadPromptsFromTxt(provider);
    });
  });

  // Load JSON buttons (per-provider)
  document.querySelectorAll('.btn-load-json-provider').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const content = await window.api.selectJsonFile();
      if (content) {
        const editor = document.getElementById(`json-editor-${provider}`);
        if (editor) {
          editor.value = content;
          validateProviderJson(provider);
        }
      }
    });
  });
}

function switchBatchTab(provider) {
  activeBatchTab = provider;

  // Update tab buttons
  document.querySelectorAll('.batch-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.batch-tab-btn[data-batch-provider="${provider}"]`).classList.add('active');

  // Update tab content
  document.querySelectorAll('.batch-tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`batch-tab-${provider}`).classList.add('active');
}

// Provider-specific templates (no provider field needed in JSON)
function getBatchTemplate(name) {
  const templates = {
    // Meta
    'meta-i2v': [
      { type: 'image-to-video', prompt: 'Cinematic zoom with dramatic lighting', image: 'C:/path/to/image.jpg' }
    ],
    'meta-t2i': [
      { type: 'text-to-image', prompt: 'A cyberpunk street scene at night', options: { aspectRatio: '16:9' } }
    ],
    'meta-t2v': [
      { type: 'text-to-video', prompt: 'A majestic eagle on a cliff at sunset', options: { animationPrompt: 'Eagle spreads wings and takes flight', aspectRatio: '16:9' } }
    ],
    'meta-multi': [
      { type: 'text-to-image', prompt: 'A blue rose in morning light' },
      { type: 'text-to-video', prompt: 'A red sunset over the ocean', options: { animationPrompt: 'Slow zoom out with waves crashing' } },
      { type: 'image-to-video', prompt: 'Slow zoom with bokeh', image: 'C:/path/to/image.jpg' }
    ],
    // Grok
    'grok-t2v': [
      { type: 'text-to-video', prompt: 'Eagle soaring over mountains at sunset', options: { aspectRatio: '16:9' } }
    ],
    'grok-t2i': [
      { type: 'text-to-image', prompt: 'An ancient temple in fog' }
    ],
    'grok-multi': [
      { type: 'text-to-video', prompt: 'Waves crashing on rocks', options: { aspectRatio: '9:16' } },
      { type: 'text-to-image', prompt: 'A magical forest at dawn' },
      { type: 'text-to-image', prompt: 'Futuristic city skyline' }
    ],
    // Whisk
    'whisk-i2v': [
      { type: 'image-to-video', prompt: 'Slow camera pan across scene', image: 'C:/path/to/image.jpg' }
    ],
    'whisk-t2i': [
      { type: 'text-to-image', prompt: 'A serene lake at sunset', options: { aspectRatio: '16:9' } }
    ],
    'whisk-multi': [
      { type: 'text-to-image', prompt: 'A magical forest at dawn' },
      { type: 'image-to-video', prompt: 'Pan left to right', image: 'C:/path/to/image.jpg' }
    ],
    // ImageFX
    'imagefx-t2i': [
      { type: 'text-to-image', prompt: 'A photorealistic portrait in golden hour light', options: { model: 'IMAGEN_3_5' } }
    ],
    'imagefx-multi': [
      { type: 'text-to-image', prompt: 'A cyberpunk street scene', options: { model: 'IMAGEN_4' } },
      { type: 'text-to-image', prompt: 'A serene lake at sunset', options: { aspectRatio: '16:9' } },
      { type: 'text-to-image', prompt: 'An abstract geometric pattern', options: { aspectRatio: '1:1' } }
    ]
  };
  return templates[name] || [];
}

function validateProviderJson(provider) {
  const editor = document.getElementById(`json-editor-${provider}`);
  const validation = document.getElementById(`json-validation-${provider}`);
  const text = editor.value.trim();

  if (!text) {
    validation.className = 'json-validation empty';
    validation.textContent = 'Enter jobs or load prompts to validate';
    return;
  }

  const capabilityMap = {
    meta: ['image-to-video', 'text-to-image', 'text-to-video'],
    grok: ['image-to-video', 'text-to-video', 'text-to-image'],
    whisk: ['image-to-video', 'text-to-image'],
    imagefx: ['text-to-image']
  };
  const validTypes = ['image-to-video', 'text-to-video', 'text-to-image'];
  const providerCaps = capabilityMap[provider] || [];

  try {
    let parsed = JSON.parse(text);

    // Accept single object or array
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    if (parsed.length === 0) {
      validation.className = 'json-validation invalid';
      validation.textContent = 'Must contain at least 1 job';
      return;
    }

    const allErrors = [];
    parsed.forEach((job, i) => {
      const prefix = parsed.length > 1 ? `Job ${i + 1}: ` : '';
      if (!job.type) {
        allErrors.push(`${prefix}Missing "type"`);
      } else if (!validTypes.includes(job.type)) {
        allErrors.push(`${prefix}Unknown type "${job.type}"`);
      } else if (!providerCaps.includes(job.type)) {
        allErrors.push(`${prefix}${provider} does not support ${job.type}. Supported: ${providerCaps.join(', ')}`);
      }
      if (job.type === 'image-to-video' && !job.image) {
        allErrors.push(`${prefix}Missing "image" path for image-to-video`);
      }
      if (job.type && job.type !== 'image-to-video' && !job.prompt) {
        allErrors.push(`${prefix}Missing "prompt"`);
      }
    });

    if (allErrors.length > 0) {
      validation.className = 'json-validation invalid';
      validation.textContent = allErrors[0] + (allErrors.length > 1 ? ` (+${allErrors.length - 1} more)` : '');
    } else {
      const types = [...new Set(parsed.map(j => j.type))];
      validation.className = 'json-validation valid';
      validation.textContent = `Valid: ${parsed.length} job${parsed.length > 1 ? 's' : ''} (${types.join(', ')})`;
    }
  } catch (e) {
    validation.className = 'json-validation invalid';
    validation.textContent = `Invalid JSON: ${e.message}`;
  }
}

async function loadPromptsFromTxt(provider) {
  const content = await window.api.selectTxtFile();
  if (!content) return;

  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    alert('No prompts found in file (file is empty or all lines are blank)');
    return;
  }

  // Generate batch JSON — default to text-to-image for each line
  const jobs = lines.map(line => ({
    type: 'text-to-image',
    prompt: line
  }));

  const editor = document.getElementById(`json-editor-${provider}`);
  if (editor) {
    editor.value = JSON.stringify(jobs, null, 2);
    validateProviderJson(provider);
  }
}

async function mergeBatchAndSubmit() {
  const allProviders = ['meta', 'grok', 'whisk', 'imagefx'];
  const allJobs = [];

  for (const provider of allProviders) {
    const editor = document.getElementById(`json-editor-${provider}`);
    const text = editor.value.trim();
    if (!text) continue;

    try {
      let parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) parsed = [parsed];

      // Auto-inject provider field
      for (const job of parsed) {
        job.provider = provider;
        allJobs.push(job);
      }
    } catch (e) {
      alert(`Invalid JSON in ${provider} tab: ${e.message}`);
      switchBatchTab(provider);
      return;
    }
  }

  if (allJobs.length === 0) {
    alert('No jobs to run. Enter jobs in at least one provider tab.');
    return;
  }

  const outputFolder = document.getElementById('output-folder').value ||
                       document.getElementById('settings-output-folder').value;

  const batch = {
    batch: true,
    jobs: allJobs,
    globalOptions: { outputFolder }
  };

  try {
    const result = await window.api.submitBatch(batch);
    if (!result.success) {
      alert('Validation errors:\n' + result.errors.join('\n'));
      return;
    }

    // Show batch progress
    document.getElementById('batch-progress-card').style.display = 'block';
    document.getElementById('batch-total').textContent = result.total || 0;
    document.getElementById('batch-completed').textContent = '0';
    document.getElementById('batch-failed').textContent = '0';
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ============ Progress / IPC ============

function setupIPCListeners() {
  window.api.onJobProgress((data) => {
    if (data.event === 'batch:start') {
      document.getElementById('batch-progress-card').style.display = 'block';
      document.getElementById('batch-total').textContent = data.total;
      return;
    }

    if (data.event === 'batch:progress') {
      document.getElementById('batch-completed').textContent = data.completed;
      document.getElementById('batch-failed').textContent = data.failed;
      return;
    }

    if (data.event === 'batch:complete') {
      document.getElementById('batch-completed').textContent = data.completed;
      document.getElementById('batch-failed').textContent = data.failed;
      return;
    }

    if (data.event === 'batch:job-start') {
      addProgressItem(data.jobId, data.provider, `Starting... (${data.index}/${data.total})`);
      updateImageStatusByJobId(data.jobId, 'running');
      return;
    }

    // Regular job progress — also mark image as running
    if (data.jobId && data.stage !== undefined) {
      updateProgressItem(data.jobId, data.provider, data.stage, data.percent);
      if (imageJobMap[data.jobId]) updateImageStatus(imageJobMap[data.jobId], 'running');
    }

    if (data.event === 'complete') {
      completeProgressItem(data.jobId, true);
      updateImageStatusByJobId(data.jobId, 'success');
    }

    if (data.event === 'failed') {
      completeProgressItem(data.jobId, false, data.error);
      updateImageStatusByJobId(data.jobId, 'failed');
    }

    if (data.event === 'cancelled') {
      completeProgressItem(data.jobId, false, 'Cancelled');
      updateImageStatusByJobId(data.jobId, 'failed');
    }
  });

  window.api.onJobComplete((data) => {
    completeProgressItem(data.jobId, true);
    updateImageStatusByJobId(data.jobId, 'success');
    loadHistory();
  });

  window.api.onJobFailed((data) => {
    completeProgressItem(data.jobId, false, data.error);
    updateImageStatusByJobId(data.jobId, 'failed');
    loadHistory();
  });
}

function addProgressItem(jobId, provider, stage) {
  const container = currentTab === 'batch'
    ? document.getElementById('batch-jobs-progress')
    : document.getElementById('gen-progress');

  container.classList.add('active');

  const item = document.createElement('div');
  item.className = 'progress-item';
  item.id = `progress-${jobId}`;
  item.innerHTML = `
    <div class="progress-header">
      <span class="progress-provider ${provider}">${provider.toUpperCase()}</span>
      <span class="progress-percent">0%</span>
    </div>
    <div class="progress-stage">${stage}</div>
    <div class="progress-bar">
      <div class="progress-bar-fill" style="width: 0%"></div>
    </div>
  `;
  container.appendChild(item);
  activeProgressItems[jobId] = item;
}

function updateProgressItem(jobId, provider, stage, percent) {
  let item = activeProgressItems[jobId];
  if (!item) {
    addProgressItem(jobId, provider, stage);
    item = activeProgressItems[jobId];
  }

  const stageEl = item.querySelector('.progress-stage');
  const percentEl = item.querySelector('.progress-percent');
  const barFill = item.querySelector('.progress-bar-fill');

  if (stageEl) stageEl.textContent = stage;
  if (percent >= 0) {
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (barFill) barFill.style.width = `${percent}%`;
  }
}

function completeProgressItem(jobId, success, error) {
  const item = activeProgressItems[jobId];
  if (!item) return;

  const stageEl = item.querySelector('.progress-stage');
  const percentEl = item.querySelector('.progress-percent');
  const barFill = item.querySelector('.progress-bar-fill');

  if (success) {
    if (stageEl) stageEl.textContent = 'Complete!';
    if (percentEl) percentEl.textContent = '100%';
    if (barFill) barFill.style.width = '100%';
    item.style.borderColor = 'rgba(34, 197, 94, 0.3)';
  } else {
    if (stageEl) stageEl.textContent = error || 'Failed';
    item.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }

  // Fade then remove after a delay
  setTimeout(() => {
    if (item.parentNode) {
      item.style.opacity = '0.5';
      setTimeout(() => {
        if (item.parentNode) {
          item.parentNode.removeChild(item);
        }
        delete activeProgressItems[jobId];
      }, 10000);
    }
  }, 5000);
}

// ============ Image Status Overlays ============

function updateImageStatus(imagePath, status) {
  // Find all thumb-wrappers matching this image path
  const wrappers = document.querySelectorAll(`.thumb-wrapper[data-image-path="${CSS.escape(imagePath)}"]`);
  wrappers.forEach(wrapper => {
    const overlay = wrapper.querySelector('.thumb-status');
    if (!overlay) return;
    wrapper.classList.remove('status-pending', 'status-running', 'status-success', 'status-failed');
    wrapper.classList.add(`status-${status}`);
    if (status === 'success') {
      overlay.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    } else if (status === 'failed') {
      overlay.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    } else if (status === 'running') {
      overlay.innerHTML = '<div class="thumb-spinner"></div>';
    } else {
      overlay.innerHTML = '';
    }
  });
}

function updateImageStatusByJobId(jobId, status) {
  const imagePath = imageJobMap[jobId];
  if (imagePath) updateImageStatus(imagePath, status);
}

// ============ History ============

async function loadHistory() {
  const search = document.getElementById('history-search')?.value || '';
  const status = document.getElementById('history-filter')?.value || 'all';
  const list = document.getElementById('history-list');

  try {
    const jobs = await window.api.getHistory({ search, status, limit: 100 });

    if (!jobs || jobs.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#128247;</div>
          <div class="empty-state-title">No generations yet</div>
          <div class="empty-state-desc">Start generating to see your history here</div>
        </div>
      `;
      return;
    }

    list.innerHTML = jobs.map(job => `
      <div class="history-item" data-id="${job.id}">
        <span class="history-badge ${job.status}">${job.status}</span>
        <div class="history-info">
          <div class="history-prompt">${escapeHtml(job.prompt || 'No prompt')}</div>
          <div class="history-meta">
            <span>${job.provider}</span>
            <span>${job.type}</span>
            <span>${formatDate(job.createdAt)}</span>
            ${job.duration ? `<span>${job.duration}s</span>` : ''}
          </div>
        </div>
        <div class="history-actions">
          ${job.status === 'success' ? `
            <button class="btn btn-secondary btn-icon" data-action="open-file" data-path="${escapeAttr(job.outputPath)}" title="Open file">&#128194;</button>
            <button class="btn btn-secondary btn-icon" data-action="open-folder" data-path="${escapeAttr(job.outputPath)}" title="Open folder">&#128193;</button>
          ` : ''}
          ${job.status === 'failed' ? `
            <button class="btn btn-secondary btn-icon" data-action="retry" data-job-id="${job.id}" title="Retry">&#8635;</button>
          ` : ''}
          <button class="btn btn-icon" data-action="delete" data-job-id="${job.id}" title="Delete" style="color: var(--text-muted);">&#128465;</button>
        </div>
      </div>
    `).join('');

    // Attach event listener via delegation (use named reference to avoid duplicates)
    list.removeEventListener('click', handleHistoryAction);
    list.addEventListener('click', handleHistoryAction);

  } catch (e) {
    console.error('Failed to load history:', e);
  }
}

// ============ Settings ============

async function loadSettings() {
  try {
    const config = await window.api.loadConfig();
    if (!config) return;

    // Populate cookie fields
    if (config.cookies) {
      if (config.cookies.meta) {
        document.getElementById('cookie-meta-datr').value = config.cookies.meta.datr || '';
        document.getElementById('cookie-meta-abra_sess').value = config.cookies.meta.abra_sess || '';
      }
      if (config.cookies.grok) {
        document.getElementById('cookie-grok-sso').value = config.cookies.grok.sso || '';
        document.getElementById('cookie-grok-sso-rw').value = config.cookies.grok['sso-rw'] || '';
      }
      if (config.cookies.whisk) {
        document.getElementById('cookie-whisk-cookies').value = config.cookies.whisk.cookies || '';
      }
      if (config.cookies.imagefx) {
        document.getElementById('cookie-imagefx-cookies').value = config.cookies.imagefx.cookies || '';
      }
    }

    // Populate settings
    if (config.settings) {
      document.getElementById('settings-output-folder').value = config.settings.outputFolder || '';
      document.getElementById('output-folder').value = config.settings.outputFolder || '';
      document.getElementById('settings-retry').value = config.settings.retryAttempts || 3;
      document.getElementById('settings-delay').value = config.settings.delayBetween || 10;
      document.getElementById('settings-naming').value = config.settings.namingPattern || '{provider}_{index}_{timestamp}';
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettings() {
  // Save cookies
  await window.api.saveCookies('meta', {
    datr: document.getElementById('cookie-meta-datr').value,
    abra_sess: document.getElementById('cookie-meta-abra_sess').value
  });

  await window.api.saveCookies('grok', {
    sso: document.getElementById('cookie-grok-sso').value,
    'sso-rw': document.getElementById('cookie-grok-sso-rw').value
  });

  await window.api.saveCookies('whisk', {
    cookies: document.getElementById('cookie-whisk-cookies').value
  });

  await window.api.saveCookies('imagefx', {
    cookies: document.getElementById('cookie-imagefx-cookies').value
  });

  // Save global settings
  await window.api.saveConfig({
    outputFolder: document.getElementById('settings-output-folder').value,
    retryAttempts: parseInt(document.getElementById('settings-retry').value),
    delayBetween: parseInt(document.getElementById('settings-delay').value),
    namingPattern: document.getElementById('settings-naming').value
  });

  // Sync output folder to generate tab
  document.getElementById('output-folder').value = document.getElementById('settings-output-folder').value;

  // Refresh status dots immediately
  await loadProviderStatus();

  alert('Settings saved!');
}

async function loadProviderStatus() {
  try {
    const status = await window.api.getCookieStatus();
    for (const [provider, state] of Object.entries(status)) {
      const dot = document.getElementById(`status-${provider}`);
      if (dot) {
        dot.className = `status-dot ${state}`;
      }
    }
  } catch (e) {}
}

async function doValidateProvider(provider) {
  console.log(`[UI] Validating ${provider}...`);
  const resultEl = document.getElementById(`validate-${provider}`);
  resultEl.className = 'validate-result';

  const isApiProvider = (provider === 'whisk' || provider === 'imagefx');
  const waitMsg = isApiProvider
    ? 'Validating... (testing API, may take a few seconds)'
    : 'Validating... (launching browser, may take 15-30s)';
  resultEl.innerHTML = `<span class="spinner"></span> ${waitMsg}`;

  // Save cookies first
  await saveProviderCookies(provider);
  await loadProviderStatus(); // Show yellow dot immediately

  try {
    const valid = await window.api.validateCookies(provider);
    console.log(`[UI] ${provider} validation result:`, valid);
    if (valid) {
      resultEl.className = 'validate-result valid';
      resultEl.textContent = 'Valid - session active';
    } else {
      resultEl.className = 'validate-result invalid';
      resultEl.textContent = 'Invalid - cookies expired or incorrect';
    }
  } catch (e) {
    console.error(`[UI] ${provider} validation error:`, e);
    resultEl.className = 'validate-result invalid';
    resultEl.textContent = `Error: ${e.message}`;
  }
  await loadProviderStatus();
}

async function saveProviderCookies(provider) {
  let cookies;
  switch (provider) {
    case 'meta':
      cookies = {
        datr: document.getElementById('cookie-meta-datr').value,
        abra_sess: document.getElementById('cookie-meta-abra_sess').value
      };
      break;
    case 'grok':
      cookies = {
        sso: document.getElementById('cookie-grok-sso').value,
        'sso-rw': document.getElementById('cookie-grok-sso-rw').value
      };
      break;
    case 'whisk':
      cookies = {
        cookies: document.getElementById('cookie-whisk-cookies').value
      };
      break;
    case 'imagefx':
      cookies = {
        cookies: document.getElementById('cookie-imagefx-cookies').value
      };
      break;
  }
  await window.api.saveCookies(provider, cookies);
}

// ============ Window Controls ============

function setupWindowControls() {
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimizeWindow());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximizeWindow());
  document.getElementById('btn-close').addEventListener('click', () => window.api.closeWindow());
}

// ============ History Action Handler (event delegation) ============

async function handleHistoryAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const filePath = btn.dataset.path;
  const jobId = btn.dataset.jobId;

  switch (action) {
    case 'open-file':
      if (filePath) await window.api.openFile(filePath);
      break;
    case 'open-folder':
      if (filePath) await window.api.openFolder(filePath);
      break;
    case 'retry':
      if (jobId) {
        await window.api.retryJob(jobId);
        loadHistory();
      }
      break;
    case 'delete':
      if (jobId) {
        await window.api.deleteJob(jobId);
        loadHistory();
      }
      break;
  }
}

// ============ Utilities ============

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/\\/g, '/').replace(/'/g, "\\'");
}

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}
