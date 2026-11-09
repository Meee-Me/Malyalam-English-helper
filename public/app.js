// Front end for Malayalam AI Helper.
//
// Voice flow: tap 🎤 → speak → tap again → Sarvam turns the speech into
// Malayalam text → that text is sent to the AI automatically → the server
// streams the English answer ("en" events) and its Malayalam translation
// ("ml" events) → the Malayalam answer is read aloud with Sarvam's voice.

const $ = (sel) => document.querySelector(sel);
const chatEl = $("#chat");
const welcomeEl = $("#welcome");
const form = $("#form");
const input = $("#input");
const sendBtn = $("#send");
const micBtn = $("#mic");
const recStatus = $("#recStatus");

const STORE_KEY = "ml-helper-chat-v1";
const SCALE_KEY = "ml-helper-font-scale";
const PW_KEY = "ml-helper-password";
const MAX_RECORD_SECONDS = 29; // Sarvam's quick speech-to-text takes clips under 30 seconds

const ERRORS = {
  auth: "സെർവറിൽ AI കീ ശരിയല്ല. ഇത് സജ്ജമാക്കിയ ആളെ അറിയിക്കുക.",
  sarvam_key: "ശബ്ദ സേവനത്തിന്റെ (Sarvam) കീ ശരിയല്ല. ഇത് സജ്ജമാക്കിയ ആളെ അറിയിക്കുക.",
  busy: "സെർവർ ഇപ്പോൾ തിരക്കിലാണ്. അൽപ്പം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.",
  network: "ഇന്റർനെറ്റ് കണക്ഷൻ പ്രശ്നം. വീണ്ടും ശ്രമിക്കുക.",
  refusal: "ക്ഷമിക്കണം, ഈ ചോദ്യത്തിന് മറുപടി നൽകാൻ കഴിയില്ല.",
  password: "പാസ്‌വേഡ് തെറ്റാണ്.",
  voice: "ശബ്ദം മനസ്സിലാക്കാൻ കഴിഞ്ഞില്ല. വീണ്ടും ശ്രമിക്കുക.",
  too_long: "റെക്കോർഡിംഗ് വളരെ നീളമുള്ളതാണ്. ചെറുതായി പറയുക.",
  server: "എന്തോ പിശക് സംഭവിച്ചു. വീണ്ടും ശ്രമിക്കുക.",
};

// ---------- Safe storage ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// Conversation: [{role:"user", content, voice?}, {role:"assistant", content: <English>, ml: <Malayalam>}]
let history = store.get(STORE_KEY, []);
let busy = false;
let password = store.get(PW_KEY, "");
let sarvamVoice = false; // set from /api/config

function authHeaders(extra = {}) {
  return password ? { ...extra, "x-app-password": password } : extra;
}

// ---------- Text rendering (tiny, safe Markdown subset) ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
}
function render(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  let html = "";
  let list = null; // "ul" | "ol"
  let para = [];
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inline).join("<br>")}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const num = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (list !== type) {
        closeList();
        html += num ? `<ol start="${num[1]}">` : "<ul>";
        list = type;
      }
      html += `<li>${inline(bullet ? bullet[1] : num[2])}</li>`;
    } else if (!line) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.replace(/^#+\s*/, ""));
    }
  }
  flushPara();
  closeList();
  return html;
}

// ---------- Read aloud ----------
// Uses Sarvam's Malayalam voice when the server has a Sarvam key, otherwise
// the device's own Malayalam voice (if it has one).

function plainForSpeech(text) {
  return text
    .replace(/\*\*|__|[*#`>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Split into pieces of at most `max` characters, at sentence or line breaks,
// so the first piece can start playing while the next one is fetched.
function splitForSpeech(text, max = 450) {
  const sentences = text.match(/[^.!?।\n]+[.!?।]*\s*|\n+/g) || [text];
  const parts = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > max && cur.trim()) {
      parts.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max).trim());
    } else {
      cur += s;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

let playback = null; // { stop(), btn }

function stopSpeaking() {
  if (playback) playback.stop();
  playback = null;
  window.speechSynthesis?.cancel();
}

function setSpeakingButton(btn, on) {
  if (!btn) return;
  btn.classList.toggle("active", on);
  btn.textContent = on ? "⏹ നിർത്തുക" : "🔊 കേൾക്കുക";
}

async function fetchSpeech(text) {
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.audio) throw new Error(data.error || "voice");
  // WAV data starts with "RIFF" ("UklGR" in base64); otherwise it is MP3.
  const type = data.audio.startsWith("UklGR") ? "audio/wav" : "audio/mpeg";
  return `data:${type};base64,${data.audio}`;
}

function speakWithSarvam(text, btn) {
  const parts = splitForSpeech(plainForSpeech(text));
  let stopped = false;
  const audio = new Audio();
  const state = {
    btn,
    stop() {
      stopped = true;
      audio.pause();
      setSpeakingButton(btn, false);
    },
  };
  playback = state;
  setSpeakingButton(btn, true);

  (async () => {
    let next = parts.length ? fetchSpeech(parts[0]) : null;
    for (let i = 0; i < parts.length && !stopped; i++) {
      let src;
      try {
        src = await next;
      } catch (err) {
        if (!stopped) setRecStatus(ERRORS[err.message] || ERRORS.voice, "error", 4000);
        break;
      }
      next = i + 1 < parts.length ? fetchSpeech(parts[i + 1]) : null;
      next?.catch(() => {}); // handled when awaited
      if (stopped) break;
      audio.src = src;
      try {
        await audio.play();
      } catch {
        break; // autoplay blocked; the 🔊 button still works
      }
      await new Promise((resolve) => {
        audio.onended = audio.onerror = audio.onpause = resolve;
      });
    }
    if (playback === state) {
      playback = null;
      setSpeakingButton(btn, false);
    }
  })();
}

function speakWithDevice(text, btn) {
  if (!("speechSynthesis" in window)) {
    alert("ഈ ഉപകരണത്തിൽ വായിച്ചു കേൾപ്പിക്കാനുള്ള സൗകര്യം ഇല്ല.");
    return;
  }
  const voice = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith("ml"));
  if (!voice) {
    alert(
      "ഈ ഫോണിൽ/കമ്പ്യൂട്ടറിൽ മലയാളം ശബ്ദം ഇൻസ്റ്റാൾ ചെയ്തിട്ടില്ല.\n" +
        "Settings → Language → Text-to-speech ൽ മലയാളം ചേർക്കുക.",
    );
    return;
  }
  const u = new SpeechSynthesisUtterance(plainForSpeech(text));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.9;
  const state = { btn, stop: () => speechSynthesis.cancel() };
  playback = state;
  setSpeakingButton(btn, true);
  u.onend = u.onerror = () => {
    if (playback === state) playback = null;
    setSpeakingButton(btn, false);
  };
  speechSynthesis.speak(u);
}

function speak(text, btn) {
  const wasThis = playback?.btn === btn;
  stopSpeaking();
  if (wasThis) return; // second tap = stop
  if (sarvamVoice) speakWithSarvam(text, btn);
  else speakWithDevice(text, btn);
}

// ---------- Message elements ----------
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addUser(text, voice) {
  const row = document.createElement("div");
  row.className = "msg user";
  const html = render(text);
  row.innerHTML = `<div class="bubble">${voice ? html.replace(/^<(p|ul|ol)([^>]*)>/, '<$1$2><span class="voice-note" title="ശബ്ദത്തിൽ ചോദിച്ചത്">🎤</span>') : html}</div>`;
  chatEl.appendChild(row);
  return row;
}

function toolButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function addBot() {
  const row = document.createElement("div");
  row.className = "msg bot";
  row.innerHTML = `
    <div class="bubble">
      <div class="status"><span class="dots"><span></span><span></span><span></span></span><span class="status-text">ആലോചിക്കുന്നു…</span></div>
      <div class="ml" hidden></div>
      <div class="en" hidden><div class="en-label">English</div><div class="en-body"></div></div>
      <div class="tools" hidden></div>
    </div>`;
  chatEl.appendChild(row);
  return {
    row,
    status: row.querySelector(".status"),
    statusText: row.querySelector(".status-text"),
    ml: row.querySelector(".ml"),
    en: row.querySelector(".en"),
    enBody: row.querySelector(".en-body"),
    tools: row.querySelector(".tools"),
  };
}

function finishBot(el, english, malayalam) {
  el.status.hidden = true;
  el.ml.hidden = false;
  el.ml.innerHTML = render(malayalam);
  el.enBody.innerHTML = render(english);
  el.en.hidden = true;
  el.tools.hidden = false;
  const speakBtn = toolButton("🔊 കേൾക്കുക", (b) => speak(malayalam, b));
  el.tools.replaceChildren(
    speakBtn,
    toolButton("English കാണുക", (b) => {
      el.en.hidden = !el.en.hidden;
      b.classList.toggle("active", !el.en.hidden);
    }),
    toolButton("📋 പകർത്തുക", async (b) => {
      try {
        await navigator.clipboard.writeText(malayalam);
        b.textContent = "✔ പകർത്തി";
        setTimeout(() => (b.textContent = "📋 പകർത്തുക"), 1500);
      } catch {}
    }),
  );
  return speakBtn;
}

function showError(el, code, retry) {
  el.status.hidden = true;
  el.ml.hidden = false;
  el.ml.innerHTML = `<p class="error">⚠️ ${escapeHtml(ERRORS[code] || ERRORS.server)}</p>`;
  el.tools.hidden = false;
  el.tools.replaceChildren(toolButton("🔄 വീണ്ടും ശ്രമിക്കുക", retry));
}

function renderAll() {
  chatEl.querySelectorAll(".msg").forEach((m) => m.remove());
  welcomeEl.hidden = history.length > 0;
  for (const m of history) {
    if (m.role === "user") addUser(m.content, m.voice);
    else finishBot(addBot(), m.content, m.ml || m.content);
  }
  if (history.length) scrollToBottom();
  else chatEl.scrollTop = 0;
}

// ---------- Talking to the AI ----------
async function ask({ autoSpeak = false } = {}) {
  busy = true;
  updateControls();
  welcomeEl.hidden = true;
  const el = addBot();
  scrollToBottom();

  let english = "";
  let malayalam = "";
  let errorCode = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        password,
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
    });
    if (res.status === 401) {
      errorCode = "password";
    } else if (!res.ok || !res.body) {
      errorCode = "server";
    } else {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6));
          if (ev.type === "en") {
            english += ev.text;
            el.en.hidden = false;
            el.enBody.innerHTML = render(english);
          } else if (ev.type === "en_done") {
            el.statusText.textContent = "മലയാളത്തിലേക്ക് മാറ്റുന്നു…";
          } else if (ev.type === "ml") {
            malayalam += ev.text;
            el.en.hidden = true;
            el.ml.hidden = false;
            el.ml.innerHTML = render(malayalam);
          } else if (ev.type === "error") {
            errorCode = ev.code;
          }
          scrollToBottom();
        }
      }
      if (!errorCode && !malayalam) errorCode = "server";
    }
  } catch {
    errorCode = "network";
  }

  if (errorCode) {
    showError(el, errorCode, async () => {
      el.row.remove();
      if (errorCode === "password") await requestPassword();
      ask({ autoSpeak });
    });
  } else {
    history.push({ role: "assistant", content: english, ml: malayalam });
    store.set(STORE_KEY, history);
    const speakBtn = finishBot(el, english, malayalam);
    // Asked by voice → answer by voice.
    if (autoSpeak) speak(malayalam, speakBtn);
  }
  busy = false;
  updateControls();
  scrollToBottom();
}

function send(text, { voice = false } = {}) {
  text = text.trim();
  if (!text || busy) return;
  stopSpeaking();
  // If the last turn failed, drop the unanswered question before adding a new one.
  if (history.length && history[history.length - 1].role === "user") {
    history.pop();
    renderAll();
  }
  history.push(voice ? { role: "user", content: text, voice: true } : { role: "user", content: text });
  store.set(STORE_KEY, history);
  addUser(text, voice);
  if (!voice) {
    input.value = "";
    autoGrow();
  }
  ask({ autoSpeak: voice });
}

// ---------- Password ----------
function requestPassword() {
  return new Promise((resolve) => {
    const dlg = $("#pwDialog");
    const pw = $("#pwInput");
    pw.value = "";
    dlg.showModal();
    dlg.addEventListener(
      "close",
      () => {
        password = pw.value;
        store.set(PW_KEY, password);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------- Voice input (record → Sarvam speech-to-text → send) ----------
let statusTimer = null;
function setRecStatus(text, kind = "", clearAfterMs = 0) {
  clearTimeout(statusTimer);
  recStatus.hidden = !text;
  recStatus.textContent = text || "";
  recStatus.className = `rec-status ${kind}`;
  if (clearAfterMs) statusTimer = setTimeout(() => setRecStatus(""), clearAfterMs);
}

let recorder = null; // { mr, stream, timer, started }
let transcribing = false;

function pickMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
}

async function startRecording() {
  stopSpeaking();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setRecStatus("മൈക്രോഫോൺ ഉപയോഗിക്കാൻ അനുമതി നൽകുക.", "error", 6000);
    return;
  }
  const mimeType = pickMimeType();
  const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const seconds = (Date.now() - recorder.started) / 1000;
    clearInterval(recorder.timer);
    recorder = null;
    micBtn.classList.remove("listening");
    micBtn.textContent = "🎤";
    if (seconds < 0.8) {
      setRecStatus("ബട്ടൺ അമർത്തി സംസാരിക്കുക, പറഞ്ഞു കഴിഞ്ഞ് വീണ്ടും അമർത്തുക.", "", 5000);
      updateControls();
      return;
    }
    transcribe(new Blob(chunks, { type: mr.mimeType || mimeType || "audio/webm" }));
  };

  recorder = { mr, stream, started: Date.now(), timer: null };
  mr.start();
  micBtn.classList.add("listening");
  micBtn.textContent = "⏹";
  const tick = () => {
    const s = Math.floor((Date.now() - recorder.started) / 1000);
    const left = MAX_RECORD_SECONDS - s;
    setRecStatus(`കേൾക്കുന്നു… ${s} സെ. — നിർത്താൻ ⏹ അമർത്തുക`, "recording");
    if (left <= 0) stopRecording();
  };
  tick();
  recorder.timer = setInterval(tick, 500);
}

function stopRecording() {
  if (recorder && recorder.mr.state !== "inactive") recorder.mr.stop();
}

async function transcribe(blob) {
  transcribing = true;
  updateControls();
  setRecStatus("നിങ്ങൾ പറഞ്ഞത് എഴുതുന്നു…");
  let errorCode = null;
  let text = "";
  try {
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: authHeaders({ "content-type": blob.type || "audio/webm" }),
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) errorCode = data.error || "voice";
    else text = (data.text || "").trim();
  } catch {
    errorCode = "network";
  }
  transcribing = false;

  if (errorCode === "password") {
    setRecStatus("");
    updateControls();
    await requestPassword();
    return transcribe(blob);
  }
  if (errorCode) {
    setRecStatus(ERRORS[errorCode] || ERRORS.voice, "error", 6000);
  } else if (!text) {
    setRecStatus("ഒന്നും കേട്ടില്ല. ദയവായി വീണ്ടും പറയുക.", "error", 5000);
  } else {
    setRecStatus("");
    send(text, { voice: true });
    return;
  }
  updateControls();
}

micBtn.addEventListener("click", () => {
  if (recorder) stopRecording();
  else if (!busy && !transcribing) startRecording();
});

// ---------- Composer & controls ----------
function autoGrow() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 4 + "px";
}
function updateControls() {
  sendBtn.disabled = busy || transcribing || !input.value.trim();
  micBtn.disabled = !recorder && (busy || transcribing);
}

input.addEventListener("input", () => {
  autoGrow();
  updateControls();
});
input.addEventListener("keydown", (e) => {
  // Enter sends on desktop; Shift+Enter adds a new line.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    send(input.value);
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));

$("#newChat").addEventListener("click", () => {
  if (busy || recorder || transcribing) return;
  if (history.length && !confirm("പുതിയ സംഭാഷണം തുടങ്ങട്ടെ? പഴയത് മായ്ക്കപ്പെടും.")) return;
  stopSpeaking();
  history = [];
  store.set(STORE_KEY, history);
  renderAll();
});

let scale = store.get(SCALE_KEY, 1);
function applyScale() {
  document.documentElement.style.setProperty("--font-scale", scale);
  store.set(SCALE_KEY, scale);
}
$("#bigger").addEventListener("click", () => {
  scale = Math.min(1.6, +(scale + 0.1).toFixed(2));
  applyScale();
});
$("#smaller").addEventListener("click", () => {
  scale = Math.max(0.8, +(scale - 0.1).toFixed(2));
  applyScale();
});

// ---------- Start ----------
// A saved conversation that ended on an unanswered question: put it back in the box.
if (history.length && history[history.length - 1].role === "user") {
  input.value = history.pop().content;
  store.set(STORE_KEY, history);
}
applyScale();
renderAll();
autoGrow();
updateControls();

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    sarvamVoice = Boolean(cfg.voice);
    const canRecord = sarvamVoice && window.MediaRecorder && navigator.mediaDevices?.getUserMedia;
    micBtn.hidden = !canRecord;
    document.body.classList.toggle("has-voice", Boolean(canRecord));
    if (cfg.needsPassword && !password) requestPassword();
  })
  .catch(() => {});
