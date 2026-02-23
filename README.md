# AI Video Generator

A multi-provider desktop application for AI-powered image and video generation. Built with Electron and Playwright, it automates Meta AI, Grok AI, Google Whisk, and Google ImageFX — all from a single interface.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-28-green)

## Features

### Providers
| Provider | Text-to-Image | Text-to-Video | Image-to-Video | Method |
|----------|:---:|:---:|:---:|--------|
| **Meta AI** | Yes | Yes (2-phase) | Yes | Playwright |
| **Grok AI** | Yes | Yes (direct) | Yes | Playwright |
| **Google Whisk** | Yes | - | Yes | API |
| **Google ImageFX** | Yes | - | - | API |

### Generation Modes
- **Single Mode** — One prompt, one output
- **Bulk Mode** — Load a `.txt` file (one prompt per line) for batch generation
- **JSON Batch** — Per-provider JSON editors with templates and schema validation
- **Cross-provider parallelism** — Run Meta, Grok, Whisk, and ImageFX jobs simultaneously

### Grok AI Controls
- **Aspect Ratio** — 9:16, 16:9, 1:1, 2:3, 3:2
- **Video Duration** — 6 seconds / 10 seconds (10s requires SuperGrok)
- **Video Resolution** — 480p / 720p (720p requires SuperGrok)

### Meta AI Controls
- **Text-to-Video** — Dual prompt system: image generation prompt + animation prompt
- **Aspect Ratio** — 9:16, 16:9, 1:1

### UI
- Dark glassmorphic theme
- Frameless window with custom titlebar
- Real-time progress tracking per job
- Status overlays on image thumbnails (spinner/checkmark/X)
- Generation history with search and filtering

## Setup

### Prerequisites
- [Google Chrome](https://google.com/chrome) installed (required for Playwright automation)
- Windows 10/11

### Running from Source
```bash
npm install
npx electron .
```

### Building Portable .exe
```bash
npm run build
```
Output: `dist/AI Video Generator-1.0.0-portable.exe` (~67MB)

## Authentication

Each provider requires cookies from an active browser session:

| Provider | Cookies Required |
|----------|-----------------|
| **Meta AI** | `datr` + `abra_sess` from meta.ai |
| **Grok AI** | `sso` + `sso-rw` from grok.com |
| **Google Whisk** | Full cookie string from whisk.google.com |
| **Google ImageFX** | Full cookie string from labs.google/fx |

Go to **Settings** tab in the app to enter cookies and validate sessions.

## Usage

1. **Select Provider** — Choose Meta AI, Grok AI, Whisk, or ImageFX
2. **Select Type** — Image-to-Video, Text-to-Video, or Text-to-Image
3. **Configure Options** — Aspect ratio, duration, resolution (varies by provider)
4. **Enter Prompt** — Single prompt or load bulk prompts from `.txt`
5. **Select Output Folder** — Where generated files will be saved
6. **Start Generation** — Monitor progress in real-time

### Batch / JSON Mode
Switch to the **Batch / JSON** tab for advanced batch processing:
- Per-provider JSON editors with syntax validation
- Template buttons for quick job setup
- Load prompts from `.txt` files
- Run jobs across multiple providers simultaneously

## Tech Stack

- **Electron 28** — Desktop framework
- **Playwright** — Browser automation for Meta AI and Grok AI
- **electron-builder** — Packaging and distribution
- **Vanilla HTML/CSS/JS** — Frontend (no framework dependencies)

## Project Structure

```
src/
  main/
    main.js              # Electron main process
    orchestrator.js       # Parallel job engine with per-provider semaphores
    providers/
      meta-converter.js   # Meta AI automation
      grok-converter.js   # Grok AI automation
      whisk-converter.js  # Google Whisk API
      imagefx-converter.js # Google ImageFX API
  renderer/
    index.html           # App UI
    app.js               # Frontend logic
    styles.css           # Dark glassmorphic theme
```

## License

Private — All rights reserved.
