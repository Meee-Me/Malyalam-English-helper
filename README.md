# മലയാളം AI സഹായി — Malayalam AI Helper

A ChatGPT-style website for Malayalam speakers who would rather **talk than type**.

```
Grandparent speaks Malayalam 🎤
   → Sarvam speech-to-text   → Malayalam text (shown in the chat)
   → Gemini                   → answer in simple English
   → Gemini                   → answer translated into Malayalam
   → Sarvam text-to-speech    → answer read aloud in Malayalam 🔊
```

It uses only two services: **Google Gemini** and **Sarvam AI**. Voice input and voice output are always Malayalam.

## Features

- **ChatGPT-style layout:** a sidebar with past chats (＋ new chat, 🗑 delete), a centered conversation, and a rounded message box. On a phone, ☰ opens the chat list.
- **Big green 🎤 button.** Tap it, speak, and tap again to stop (up to about 30 seconds). The question is sent automatically.
- **Spoken answers.** When a question was asked by voice, the answer plays aloud in Sarvam's Malayalam voice. 🔊 replays it and ⏹ stops it.
- **Malayalam answers in big text.** "English കാണുക" shows Gemini's original English.
- Typing works too. The text size can be changed (A− / A+), chats are saved in the browser, and dark mode is supported.

---

## Step 1 — Get the two keys

1. **Gemini key:** <https://aistudio.google.com/apikey> → *Create API key*. Sign in with any Google account. The free tier is enough for everyday family use, with no card needed.
2. **Sarvam key:** <https://dashboard.sarvam.ai> → *API Keys*.

## Step 2 — Put the keys on Vercel (the live website)

The site runs on **Vercel**. Your keys are stored there, never in the code:

1. Open the project on <https://vercel.com> → **Settings** → **Environment Variables**.
2. Add these, ticking **Production** and **Preview** for each:

   | Name             | Value |
   | ---------------- | ----- |
   | `GEMINI_API_KEY` | your Gemini key |
   | `SARVAM_API_KEY` | your Sarvam key |
   | `APP_PASSWORD`   | a password the family types once (strongly recommended) |

3. Go to **Deployments**, open the ⋯ menu on the latest one, and choose **Redeploy**. New keys only take effect after a redeploy.

Then open the site link on grandpa's phone, allow the microphone, and use *Add to Home screen* so it works like an app. If a key is missing, the page shows a note saying which one.

Keeping the keys safe:

- ✅ Keys go **only** in Vercel's Environment Variables, or in a `.env` file on your own computer.
- ❌ Never put them in the `public/` folder, in the HTML or JavaScript, or in a GitHub commit. `.env` is already in `.gitignore`.
- ❌ Don't paste them into chats or screenshots. If a key leaks, delete it on the Google AI Studio or Sarvam website and make a new one.

**Always set `APP_PASSWORD`.** Otherwise anyone who finds the link can use up your Gemini and Sarvam allowance.

Every push to the `main` branch on GitHub redeploys the site automatically.

## Run it on your own computer (optional)

You need [Node.js](https://nodejs.org) 22. Copy `.env.example` to `.env`, paste in your keys, then:

```bash
npm install
npm start
```

Open <http://localhost:3000>.

## Optional settings (Vercel Environment Variables or `.env`)

| Variable         | Default   | What it does |
| ---------------- | --------- | ------------ |
| `GEMINI_MODEL`   | (automatic) | Gemini model to try first. By default the app asks Google which models your key can use and picks the newest Flash-Lite, then Flash. |
| `SARVAM_SPEAKER` | (default) | Reading voice, e.g. `kavitha`, `anand`, `ritu`. |
| `SARVAM_PACE`    | `0.9`     | Speaking speed (0.5–2.0). Lower is slower. |
| `PORT`           | `3000`    | Port for `npm start` on your computer. |

## How it works

| File / endpoint                            | What it does |
| ------------------------------------------ | ------------ |
| `public/`                                  | The web page (HTML, CSS, JavaScript). |
| `api/transcribe.js` → `POST /api/transcribe` | Recorded audio → Sarvam `POST /speech-to-text` (`saaras:v3`, `mode=transcribe`, `language_code=ml-IN`) → `{ text }`. |
| `api/chat.js` → `POST /api/chat`           | Streams Gemini's English answer (`en` events), then Gemini's Malayalam translation (`ml` events), as Server-Sent Events. |
| `api/speak.js` → `POST /api/speak`         | Malayalam text → Sarvam `POST /text-to-speech` (`bulbul:v3`, `ml-IN`) → audio. Long answers are split into short pieces, so playback starts quickly. |
| `lib/app.js`                               | The shared code behind all of the above. |
| `dev-server.js`                            | Runs everything locally for `npm start`. Vercel doesn't use it. |

The keys are only ever read on the server side. The browser never sees them.
