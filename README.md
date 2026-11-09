# മലയാളം AI സഹായി — Malayalam AI Helper

A ChatGPT-style website for Malayalam speakers who would rather **talk than type**.

```
Grandparent speaks Malayalam 🎤
   → Sarvam speech-to-text   → Malayalam text (shown in the chat)
   → ChatGPT                  → answer in simple English
   → ChatGPT                  → answer translated into Malayalam
   → Sarvam text-to-speech    → answer read aloud in Malayalam 🔊
```

It uses only two services: **ChatGPT (OpenAI)** and **Sarvam AI**. Voice input and voice output are always Malayalam.

## Features

- **ChatGPT-style layout:** a sidebar with past chats (＋ new chat, 🗑 delete), a centered conversation, and a rounded message box. On a phone, ☰ opens the chat list.
- **Big green 🎤 button.** Tap it, speak, and tap again to stop (up to about 30 seconds). The question is sent automatically.
- **Spoken answers.** When a question was asked by voice, the answer plays aloud in Sarvam's Malayalam voice. 🔊 replays it and ⏹ stops it.
- **Malayalam answers in big text.** "English കാണുക" shows ChatGPT's original English.
- Typing works too. The text size can be changed (A− / A+), chats are saved in the browser, and dark mode is supported.

---

## Step 1 — Get the two keys

1. **ChatGPT key:** <https://platform.openai.com/api-keys> → *Create new secret key*. It starts with `sk-`.
   You also need some credit under *Billing* on that site. A ChatGPT Plus subscription is separate from API credit and does not cover this.
2. **Sarvam key:** <https://dashboard.sarvam.ai> → *API Keys*.

## Step 2 — Put the keys in a `.env` file

In the project folder (next to `server.js`), copy `.env.example` to a new file named **`.env`** and paste the keys in:

```
OPENAI_API_KEY=sk-...your ChatGPT key...
SARVAM_API_KEY=...your Sarvam key...
APP_PASSWORD=pick-a-family-password
```

Rules for keeping the keys safe:

- ✅ Keys go **only** in `.env` on your computer, or in your hosting site's "Environment variables" settings.
- ❌ Never put them in the `public/` folder, in the HTML or JavaScript, or in a GitHub commit. `.env` is already in `.gitignore`, so git skips it.
- ❌ Don't paste them into chats or screenshots. If a key leaks, delete it on the OpenAI or Sarvam website and make a new one.

## Step 3 — Run it

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. If a key is missing, the page shows a note saying which one.

## Step 4 — Put it online (so grandpa can use it on his phone)

Use any Node host, such as **Render**, **Railway**, or **Fly.io**:

- Connect this GitHub repo.
- Build command: `npm install`. Start command: `npm start`.
- Under **Environment variables**, add `OPENAI_API_KEY`, `SARVAM_API_KEY` and `APP_PASSWORD`. The host stores them privately; you don't upload `.env`.

The site must use **https://** for the microphone to work. These hosts provide it automatically. Then open the link on grandpa's phone and use *Add to Home screen*, so it works like an app.

**Always set `APP_PASSWORD` for an online site.** Otherwise anyone who finds the link can spend your OpenAI and Sarvam credit.

---

## Optional settings (in `.env`)

| Variable         | Default   | What it does |
| ---------------- | --------- | ------------ |
| `OPENAI_MODEL`   | `gpt-5.5` | ChatGPT model. A cheaper option is `gpt-5.4-mini`. |
| `SARVAM_SPEAKER` | (default) | Reading voice, e.g. `kavitha`, `anand`, `ritu`. |
| `SARVAM_PACE`    | `0.9`     | Speaking speed (0.5–2.0). Lower is slower. |
| `PORT`           | `3000`    | Port to listen on. |

## How it works

| Endpoint               | What it does |
| ---------------------- | ------------ |
| `POST /api/transcribe` | Recorded audio → Sarvam `POST /speech-to-text` (`saaras:v3`, `mode=transcribe`, `language_code=ml-IN`) → `{ text }`. |
| `POST /api/chat`       | Streams ChatGPT's English answer (`en` events), then ChatGPT's Malayalam translation (`ml` events), as Server-Sent Events. |
| `POST /api/speak`      | Malayalam text → Sarvam `POST /text-to-speech` (`bulbul:v3`, `ml-IN`) → audio. Long answers are split into short pieces, so playback starts quickly. |

The keys are only ever used inside `server.js`. The browser never sees them.
