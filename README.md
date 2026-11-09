# മലയാളം AI സഹായി — Malayalam AI Helper

A ChatGPT-style website for Malayalam speakers. You ask a question (in Malayalam, English, or Manglish), the AI (Claude) writes the answer in **English**, and the site then **translates it into Malayalam** and shows it in large, easy-to-read text.

## Features

- **English answer → Malayalam translation.** Both stream live, so you see it working.
- **Malayalam is shown first**, in big text. Tap **"English കാണുക"** to see the original English.
- **🎤 Voice input** in Malayalam (Chrome / Android).
- **🔊 Read aloud** in Malayalam, if the phone or computer has a Malayalam voice installed.
- **A− / A+** to change text size. The setting is remembered.
- The whole interface is in Malayalam, with sample questions to tap.
- The conversation is saved in the browser. **＋** starts a new one.
- Works on phones and computers, and supports dark mode.
- Optional password so other people can't use up your API credit.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer and an Anthropic API key from <https://console.anthropic.com>.

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Then open <http://localhost:3000>.

### Settings (environment variables)

| Variable            | Default            | What it does                                   |
| ------------------- | ------------------ | ---------------------------------------------- |
| `ANTHROPIC_API_KEY` | —                  | Required. Your Anthropic API key.              |
| `APP_PASSWORD`      | (none)             | If set, the site asks for this password once.  |
| `PORT`              | `3000`             | Port to listen on.                             |
| `CLAUDE_MODEL`      | `claude-opus-5-5`  | Claude model to use.                           |

**Set `APP_PASSWORD` before you put the site on the internet.** Without it, anyone who finds the link can use your API key.

## Put it online

The app is a single Node server (`server.js`) that also serves the web page from `public/`. Any host that runs Node works, for example Render, Railway, Fly.io, or a small VPS:

- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `ANTHROPIC_API_KEY` and `APP_PASSWORD`

## How it works

1. The browser sends the conversation to `POST /api/chat`.
2. The server asks Claude for an answer in simple English. The system prompt tells it to use short sentences and avoid idioms, so the translation reads well.
3. The server sends that English answer back to Claude with a translation prompt and gets natural, respectful Malayalam.
4. Both steps stream to the browser as Server-Sent Events (`en` chunks, then `ml` chunks).

The English answers are kept as the conversation history, so follow-up questions keep their context.

## Read-aloud on a phone

If 🔊 says no Malayalam voice is installed:

- **Android:** Settings → System → Languages → Text-to-speech → Google speech engine → install **Malayalam**.
- **iPhone/iPad:** Malayalam voices depend on the iOS version. Check Settings → Accessibility → Spoken Content → Voices.
