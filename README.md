# മലയാളം AI സഹായി — Malayalam AI Helper

A ChatGPT-style website for Malayalam speakers who would rather **talk than type**.

```
Grandparent speaks Malayalam 🎤
   → Sarvam AI speech-to-text  → Malayalam text (shown in the chat)
   → Claude                     → answer in simple English
   → Claude                     → answer translated into Malayalam
   → Sarvam AI text-to-speech   → answer read aloud in Malayalam 🔊
```

## Features

- **Big 🎤 button.** Tap it, speak, and tap again to stop (the limit is about 30 seconds). Sarvam turns the speech into text, and the question goes to the AI automatically.
- **Spoken answers.** When a question was asked by voice, the Malayalam answer plays automatically in Sarvam's Malayalam voice. 🔊 replays it and ⏹ stops it.
- **Typing still works.** Family members can use the text box. Typed questions are not read aloud automatically.
- **Malayalam is shown first, in big text.** "English കാണുക" shows the English the AI originally wrote.
- **Easy to use:** the whole interface is in Malayalam, A− / A+ change the text size, there are sample questions to tap, and conversations are saved in the browser (＋ starts a new one).
- Works on phones and computers, with dark mode.
- An optional password protects your API keys.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer and two API keys:

- **Anthropic** (the AI): <https://console.anthropic.com>
- **Sarvam AI** (voice): <https://dashboard.sarvam.ai>

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... SARVAM_API_KEY=your-sarvam-key npm start
```

Open <http://localhost:3000>. Without `SARVAM_API_KEY` the site still works, but text-only: the 🎤 button is hidden and read-aloud falls back to the device's own Malayalam voice, if it has one.

> **The microphone only works over `https://` (or on `localhost`).** Browsers block the microphone on plain `http://` sites, so put the site behind HTTPS when you host it. Every host listed below provides HTTPS automatically.

### Settings (environment variables)

| Variable            | Default           | What it does |
| ------------------- | ----------------- | ------------ |
| `ANTHROPIC_API_KEY` | —                 | Required. Anthropic API key. |
| `SARVAM_API_KEY`    | —                 | Sarvam API key. Turns on voice input and Sarvam read-aloud. |
| `APP_PASSWORD`      | (none)            | If set, the site asks for this password once per device. |
| `PORT`              | `3000`            | Port to listen on. |
| `CLAUDE_MODEL`      | `claude-opus-5-5` | Claude model. |
| `SARVAM_LANGUAGE`   | `ml-IN`           | Spoken language. Use `unknown` to auto-detect, e.g. if they mix in English. |
| `SARVAM_STT_MODEL`  | `saaras:v3`       | Sarvam speech-to-text model. |
| `SARVAM_TTS_MODEL`  | `bulbul:v3`       | Sarvam text-to-speech model. |
| `SARVAM_SPEAKER`    | (model default)   | Voice for read-aloud, e.g. `kavitha`, `anand`, `ritu`. Names must suit the model. |
| `SARVAM_PACE`       | `0.9`             | Speaking speed (0.5–2.0). Lower is slower. |

**Set `APP_PASSWORD` before you put the site on the internet.** Without it, anyone who finds the link can spend your Anthropic and Sarvam credit.

## Put it online

The app is a single Node server (`server.js`) that also serves the page in `public/`. Any Node host works, for example Render, Railway, or Fly.io:

- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `ANTHROPIC_API_KEY`, `SARVAM_API_KEY`, `APP_PASSWORD`

## How it works

| Endpoint              | What it does |
| --------------------- | ------------ |
| `POST /api/transcribe` | Receives the recorded audio (WebM/MP4/OGG) and sends it to Sarvam `POST /speech-to-text` (`saaras:v3`, `mode=transcribe`, `language_code=ml-IN`). Returns `{ text }`. |
| `POST /api/chat`       | Streams Claude's English answer (`en` events), then Claude's Malayalam translation of it (`ml` events), as Server-Sent Events. |
| `POST /api/speak`      | Sends Malayalam text (up to 2,500 characters) to Sarvam `POST /text-to-speech` (`bulbul:v3`) and returns the audio. The page splits long answers into short pieces, so playback starts quickly. |

API keys stay on the server and are never sent to the browser.
