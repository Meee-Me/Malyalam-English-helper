// Front end for Malayalam AI Helper.
// The server streams the English answer ("en" events), then its Malayalam
// translation ("ml" events). Malayalam is shown big; English is tucked away.

const $ = (sel) => document.querySelector(sel);
const chatEl = $("#chat");
const welcomeEl = $("#welcome");
const form = $("#form");
const input = $("#input");
const sendBtn = $("#send");
const micBtn = $("#mic");

const STORE_KEY = "ml-helper-chat-v1";
const SCALE_KEY = "ml-helper-font-scale";
const PW_KEY = "ml-helper-password";

const ERRORS = {
  auth: "സെർവറിൽ API കീ ശരിയല്ല. ഇത് സജ്ജമാക്കിയ ആളെ അറിയിക്കുക.",
  busy: "സെർവർ ഇപ്പോൾ തിരക്കിലാണ്. അൽപ്പം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.",
  network: "ഇന്റർനെറ്റ് കണക്ഷൻ പ്രശ്നം. വീണ്ടും ശ്രമിക്കുക.",
  refusal: "ക്ഷമിക്കണം, ഈ ചോദ്യത്തിന് മറുപടി നൽകാൻ കഴിയില്ല.",
  password: "പാസ്‌വേഡ് തെറ്റാണ്.",
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

// Conversation: [{role:"user", content}, {role:"assistant", content: <English>, ml: <Malayalam>}]
let history = store.get(STORE_KEY, []);
let busy = false;
let password = store.get(PW_KEY, "");

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
let mlVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  mlVoice = voices.find((v) => v.lang?.toLowerCase().startsWith("ml")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}
function speak(text, btn) {
  if (!("speechSynthesis" in window)) {
    alert("ഈ ഉപകരണത്തിൽ വായിച്ചു കേൾപ്പിക്കാനുള്ള സൗകര്യം ഇല്ല.");
    return;
  }
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();
    document.querySelectorAll(".tool.speaking").forEach((b) => b.classList.remove("speaking", "active"));
    if (btn.dataset.wasSpeaking === "1") {
      btn.dataset.wasSpeaking = "0";
      return;
    }
  }
  pickVoice();
  if (!mlVoice) {
    alert(
      "ഈ ഫോണിൽ/കമ്പ്യൂട്ടറിൽ മലയാളം ശബ്ദം ഇൻസ്റ്റാൾ ചെയ്തിട്ടില്ല.\n" +
        "Settings → Language → Text-to-speech ൽ മലയാളം ചേർക്കുക.",
    );
    return;
  }
  const u = new SpeechSynthesisUtterance(text.replace(/[*#]/g, ""));
  u.voice = mlVoice;
  u.lang = mlVoice.lang;
  u.rate = 0.9;
  btn.classList.add("speaking", "active");
  btn.dataset.wasSpeaking = "1";
  u.onend = u.onerror = () => {
    btn.classList.remove("speaking", "active");
    btn.dataset.wasSpeaking = "0";
  };
  speechSynthesis.speak(u);
}

// ---------- Message elements ----------
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addUser(text) {
  const row = document.createElement("div");
  row.className = "msg user";
  row.innerHTML = `<div class="bubble">${render(text)}</div>`;
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
  const el = {
    row,
    status: row.querySelector(".status"),
    statusText: row.querySelector(".status-text"),
    ml: row.querySelector(".ml"),
    en: row.querySelector(".en"),
    enBody: row.querySelector(".en-body"),
    tools: row.querySelector(".tools"),
  };
  return el;
}

function finishBot(el, english, malayalam) {
  el.status.hidden = true;
  el.ml.hidden = false;
  el.ml.innerHTML = render(malayalam);
  el.enBody.innerHTML = render(english);
  el.en.hidden = true;
  el.tools.hidden = false;
  el.tools.replaceChildren(
    toolButton("🔊 കേൾക്കുക", (b) => speak(malayalam, b)),
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
    if (m.role === "user") addUser(m.content);
    else finishBot(addBot(), m.content, m.ml || m.content);
  }
  if (history.length) scrollToBottom();
  else chatEl.scrollTop = 0;
}

// ---------- Talking to the server ----------
async function ask() {
  busy = true;
  updateSend();
  welcomeEl.hidden = true;
  const el = addBot();
  scrollToBottom();

  let english = "";
  let malayalam = "";
  let errorCode = null;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password,
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
    });
    if (res.status === 401) {
      errorCode = "password";
      password = "";
      store.set(PW_KEY, "");
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
    showError(el, errorCode, () => {
      el.row.remove();
      if (errorCode === "password") requestPassword().then(ask);
      else ask();
    });
  } else {
    history.push({ role: "assistant", content: english, ml: malayalam });
    store.set(STORE_KEY, history);
    finishBot(el, english, malayalam);
  }
  busy = false;
  updateSend();
  scrollToBottom();
}

function send(text) {
  text = text.trim();
  if (!text || busy) return;
  // If the last turn failed, drop the dangling user message before adding a new one.
  if (history.length && history[history.length - 1].role === "user") {
    history.pop();
    renderAll();
  }
  history.push({ role: "user", content: text });
  store.set(STORE_KEY, history);
  addUser(text);
  input.value = "";
  autoGrow();
  ask();
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

// ---------- Voice input ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
if (!Recognition) {
  micBtn.hidden = true;
} else {
  micBtn.addEventListener("click", () => {
    if (recognizer) {
      recognizer.stop();
      return;
    }
    recognizer = new Recognition();
    recognizer.lang = "ml-IN";
    recognizer.interimResults = true;
    recognizer.continuous = false;
    const before = input.value ? input.value.trimEnd() + " " : "";
    recognizer.onresult = (e) => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      input.value = before + text;
      autoGrow();
      updateSend();
    };
    recognizer.onerror = (e) => {
      if (e.error === "not-allowed") alert("മൈക്രോഫോൺ ഉപയോഗിക്കാൻ അനുമതി നൽകുക.");
    };
    recognizer.onend = () => {
      micBtn.classList.remove("listening");
      recognizer = null;
    };
    micBtn.classList.add("listening");
    recognizer.start();
  });
}

// ---------- Composer & controls ----------
function autoGrow() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 4 + "px";
}
function updateSend() {
  sendBtn.disabled = busy || !input.value.trim();
}

input.addEventListener("input", () => {
  autoGrow();
  updateSend();
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
  if (busy) return;
  if (history.length && !confirm("പുതിയ സംഭാഷണം തുടങ്ങട്ടെ? പഴയത് മായ്ക്കപ്പെടും.")) return;
  window.speechSynthesis?.cancel();
  history = [];
  store.set(STORE_KEY, history);
  renderAll();
  input.focus();
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
updateSend();

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.needsPassword && !password) requestPassword();
  })
  .catch(() => {});
