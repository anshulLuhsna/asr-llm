const DEFAULT_SYSTEM_PROMPT =
  "You are a fast voice assistant. The user's messages are live speech transcripts, so tolerate small transcription errors. " +
  "Answer directly and concisely in plain text, with no markdown and no preamble.";

// The two Deepgram speech-to-text models that can be compared from the header toggle.
const ASR = {
  flux: {
    label: "Flux",
    url: "wss://api.deepgram.com/v2/listen",
    // Model-native turn detection, with eager end-of-turn for speculative answers.
    params: { model: "flux-general-en", eot_threshold: "0.7", eager_eot_threshold: "0.5", eot_timeout_ms: "3000" },
  },
  nova: {
    label: "Nova-3",
    url: "wss://api.deepgram.com/v1/listen",
    // Turn end = silence-based endpointing (speech_final), with UtteranceEnd as the fallback.
    params: { model: "nova-3", interim_results: "true", endpointing: "300", utterance_end_ms: "1000", smart_format: "true" },
  },
};
const SAMPLE_RATES = [8000, 16000, 24000, 44100, 48000];
const STORE = {
  chats: "voicechat.chats.v1", active: "voicechat.active", prompt: "voicechat.systemPrompt", asr: "voicechat.asr",
  password: "voicechat.password",
};

const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"), chatList: $("chatList"), chatTitle: $("chatTitle"), status: $("status"),
  mic: $("mic"), micLabel: $("micLabel"), error: $("error"), settings: $("settings"), prompt: $("systemPrompt"),
};

// ---------- Local storage (the only persistence) ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    showError(`Could not save to browser storage: ${e.message}`);
  }
}

// POST to this app's own API. If the deployment is password-protected, ask
// once, remember the answer in this browser, and retry.
async function api(path, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path, {
      ...init,
      method: "POST",
      headers: { ...init.headers, "x-app-password": load(STORE.password, "") },
    });
    if (res.status !== 401 || attempt) return res;
    const entered = prompt("This app is password-protected. Enter the app password:");
    if (!entered) return res;
    save(STORE.password, entered);
  }
}

let chats = load(STORE.chats, []);
let systemPrompt = load(STORE.prompt, DEFAULT_SYSTEM_PROMPT);
let asr = load(STORE.asr, "flux") in ASR ? load(STORE.asr, "flux") : "flux";
let chat = chats.find((c) => c.id === load(STORE.active, null)) || newChatObject();

function newChatObject() {
  return { id: crypto.randomUUID(), title: "New chat", createdAt: Date.now(), messages: [] };
}
// A chat is only written to storage once it has a message, so empty chats never pile up.
function persistChat() {
  if (!chats.includes(chat)) chats.unshift(chat);
  save(STORE.chats, chats);
  save(STORE.active, chat.id);
}

// ---------- Rendering ----------

function bubble(role, text, extraClass = "", meta = "") {
  const row = document.createElement("div");
  row.className = `msg ${role} ${extraClass}`.trim();
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  row.append(b);
  if (meta) setMeta(row, meta);
  return row;
}
function setMeta(row, meta) {
  const m = row.querySelector(".meta") || row.appendChild(document.createElement("div"));
  m.className = "meta";
  m.textContent = meta;
}
function setText(row, text) {
  row.firstChild.textContent = text;
}
function append(row) {
  els.messages.querySelector(".empty")?.remove();
  const stick = nearBottom();
  els.messages.append(row);
  if (stick) scrollDown();
}
const nearBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;
const scrollDown = () => (els.messages.scrollTop = els.messages.scrollHeight);

function renderMessages() {
  els.messages.replaceChildren(...chat.messages.map((m) => bubble(m.role, m.content, "", m.meta)));
  if (!chat.messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing here yet. Unmute and start talking.";
    els.messages.append(empty);
  }
  els.chatTitle.textContent = chat.title;
  scrollDown();
}

function renderChatList() {
  els.chatList.replaceChildren(
    ...chats.map((c) => {
      const item = document.createElement("div");
      item.className = "chat-item" + (c === chat ? " active" : "");
      const open = document.createElement("button");
      open.className = "open";
      open.textContent = c.title;
      open.title = c.title;
      open.onclick = () => switchChat(c);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Delete chat: ${c.title}`);
      del.onclick = () => deleteChat(c);
      item.append(open, del);
      return item;
    }),
  );
}

function showError(msg) {
  els.error.textContent = msg || "";
  els.error.hidden = !msg;
}
function setStatus(state, label) {
  els.status.dataset.state = state;
  els.status.textContent = label;
  const on = state !== "muted" && state !== "error";
  els.mic.setAttribute("aria-pressed", String(on));
  els.micLabel.textContent = on ? "Mute" : "Unmute";
}

// ---------- Chats ----------

function switchChat(next) {
  dropLiveTurn();
  chat = next;
  if (chats.includes(chat)) save(STORE.active, chat.id);
  renderMessages();
  renderChatList();
  document.body.classList.remove("sidebar-open");
}
function deleteChat(c) {
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
  chats = chats.filter((x) => x !== c);
  save(STORE.chats, chats);
  if (c === chat) switchChat(newChatObject());
  else renderChatList();
}

// ---------- Answers (Groq via /api/chat, streamed) ----------

// The live turn: `userRow` shows the in-progress transcript, `answer` is the
// (possibly speculative) completion started for it.
let userRow = null;
let answer = null;
let saveTimer = 0;

function startAnswer(transcript) {
  // A new utterance supersedes whatever is still streaming.
  if (answer) stopAnswer(answer, !answer.committed);
  const a = {
    transcript,
    text: "",
    done: false,
    committed: false,
    msg: null,
    ctrl: new AbortController(),
    row: bubble("assistant", "", "streaming"),
    chat,
  };
  answer = a;
  append(a.row);
  const messages = [...chat.messages.filter((m) => m.content), { role: "user", content: transcript }];
  streamCompletion(a, messages).catch((e) => {
    if (a.ctrl.signal.aborted) return;
    a.failed = true;
    a.row.classList.add("error");
    setText(a.row, e.message);
  }).finally(() => {
    a.done = true;
    a.row.classList.remove("streaming");
    if (a.committed) finalizeAnswer(a);
  });
}

async function streamCompletion(a, messages) {
  const res = await api("/api/chat", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system: systemPrompt, messages }),
    signal: a.ctrl.signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    let added = "";
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(chunk.error.message || "Groq stream error");
      added += chunk.choices?.[0]?.delta?.content || "";
    }
    if (added) {
      if (!a.text) {
        a.firstAt = performance.now();
        updateMeta(a);
      }
      a.text += added;
      const stick = nearBottom();
      setText(a.row, a.text);
      if (stick) scrollDown();
      if (a.committed) {
        a.msg.content = a.text;
        saveTimer ||= setTimeout(() => { saveTimer = 0; save(STORE.chats, chats); }, 500);
      }
    }
  }
}

// Latency line under each answer, measured from the end of the last spoken word:
// how long the speech model took to call the turn over, and when the first token landed.
function updateMeta(a) {
  if (!a.committed || !a.firstAt) return;
  const { asr: label, eotMs } = a.stats;
  const parts = [label];
  if (eotMs != null) {
    parts.push(`turn end +${Math.round(eotMs)} ms`);
    parts.push(`first token +${Math.round(Math.max(0, eotMs + a.firstAt - a.eotAt))} ms`);
  } else {
    parts.push(`first token ${Math.round(Math.max(0, a.firstAt - a.eotAt))} ms after turn end`);
  }
  a.msg.meta = parts.join(" · ");
  setMeta(a.row, a.msg.meta);
}

function finalizeAnswer(a) {
  if (a.failed || !a.text) a.chat.messages = a.chat.messages.filter((m) => m !== a.msg);
  else a.msg.content = a.text;
  save(STORE.chats, chats);
  if (answer === a) answer = null;
}

// Stops a stream. `discard` removes it entirely (cancelled speculation);
// otherwise whatever has been written so far is kept.
function stopAnswer(a, discard) {
  a.ctrl.abort();
  a.row.classList.remove("streaming");
  if (discard) a.row.remove();
  else if (a.committed) finalizeAnswer(a);
  if (answer === a) answer = null;
}

function commitTurn(transcript, stats) {
  if (!answer || answer.committed || answer.transcript !== transcript) startAnswer(transcript);
  const a = answer;
  userRow?.remove();
  const finalRow = bubble("user", transcript);
  a.row.before(finalRow);
  userRow = null;

  if (!chat.messages.length) chat.title = transcript.length > 48 ? transcript.slice(0, 48) + "…" : transcript;
  a.msg = { role: "assistant", content: a.text };
  chat.messages.push({ role: "user", content: transcript }, a.msg);
  a.committed = true;
  a.stats = stats;
  a.eotAt = performance.now();
  updateMeta(a);
  persistChat();
  els.chatTitle.textContent = chat.title;
  renderChatList();
  if (a.done) finalizeAnswer(a);
}

function dropLiveTurn() {
  if (answer) stopAnswer(answer, !answer.committed);
  userRow?.remove();
  userRow = null;
}

// ---------- Deepgram turn events ----------

function showInterim(transcript) {
  if (!userRow) {
    userRow = bubble("user", transcript, "interim");
    append(userRow);
  } else setText(userRow, transcript);
  // Keep the transcript above a speculative answer.
  if (answer && !answer.committed) answer.row.before(userRow);
}
// Open the server's connection to Groq while the user is still talking.
const warm = () => api("/api/warm").catch(() => {});

// Delay between the end of the last word and the model declaring the turn over,
// using the amount of audio sent so far as the clock.
function turnStats(s, lastWordEnd) {
  const eotMs = (s.sentSec - lastWordEnd) * 1000;
  return { asr: ASR[s.asr].label, eotMs: Number.isFinite(eotMs) && eotMs >= 0 ? eotMs : null };
}

// Flux (/v2/listen): TurnInfo events carry the whole turn's transcript.
function onFlux(msg, s) {
  if (msg.type === "Error") return showError(`Deepgram: ${msg.description || msg.code}`);
  if (msg.type !== "TurnInfo") return;
  const transcript = (msg.transcript || "").trim();
  if (msg.event !== "EndOfTurn" && transcript) showInterim(transcript);

  switch (msg.event) {
    case "StartOfTurn":
      warm();
      break;
    case "EagerEndOfTurn":
      // Speculate: start answering before the turn is confirmed over.
      if (transcript) startAnswer(transcript);
      break;
    case "TurnResumed":
      if (answer && !answer.committed) stopAnswer(answer, true);
      break;
    case "EndOfTurn":
      if (transcript) commitTurn(transcript, turnStats(s, msg.words?.at(-1)?.end));
      else dropLiveTurn();
      break;
  }
}

// Nova-3 (/v1/listen): finalized segments are concatenated until speech_final
// (or UtteranceEnd) marks the end of the utterance.
function onNova(msg, s) {
  if (msg.type === "UtteranceEnd") return endNovaTurn(s);
  if (msg.type !== "Results") return;
  const alt = msg.channel?.alternatives?.[0];
  const text = (alt?.transcript || "").trim();
  if (text) {
    if (!s.finals && !userRow) warm();
    const soFar = `${s.finals} ${text}`.trim();
    if (msg.is_final) {
      s.finals = soFar;
      s.lastWordEnd = alt.words?.at(-1)?.end ?? msg.start + msg.duration;
    }
    showInterim(soFar);
  }
  if (msg.speech_final) endNovaTurn(s);
}
function endNovaTurn(s) {
  if (!s.finals) return;
  const transcript = s.finals;
  s.finals = "";
  commitTurn(transcript, turnStats(s, s.lastWordEnd));
}

// ---------- Microphone + Deepgram WebSocket ----------

let session = null; // non-null while unmuted (or connecting)

async function unmute() {
  showError("");
  setStatus("connecting", "Connecting…");
  const s = { asr, ws: null, ctx: null, stream: null, queue: [], openedAt: 0, sentSec: 0, finals: "", lastWordEnd: 0 };
  session = s;
  try {
    s.ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    const rate = s.ctx.sampleRate;
    if (!SAMPLE_RATES.includes(rate)) throw new Error(`Unsupported microphone sample rate: ${rate} Hz`);

    // Token, mic permission and worklet load all run in parallel; audio captured
    // before the socket opens is queued so the first words are not lost.
    const tokenP = api("/api/deepgram-token").then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Token request failed (${r.status})`);
      return body.access_token;
    });
    const micP = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const workletP = s.ctx.audioWorklet.addModule("/pcm-worklet.js");
    micP.catch(() => {});
    workletP.catch(() => {});

    const token = await tokenP;
    if (session !== s) return closeSession(s);
    const model = ASR[s.asr];
    const params = new URLSearchParams({ ...model.params, encoding: "linear16", sample_rate: String(rate) });
    const ws = new WebSocket(`${model.url}?${params}`, ["bearer", token]);
    s.ws = ws;
    const sendAudio = (chunk) => {
      ws.send(chunk);
      s.sentSec += chunk.byteLength / 2 / rate;
    };
    ws.onopen = () => {
      s.openedAt = Date.now();
      s.queue.forEach(sendAudio);
      s.queue = [];
      if (session === s) setStatus("listening", "Listening");
      holdScreen();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") (s.asr === "flux" ? onFlux : onNova)(JSON.parse(e.data), s);
    };
    ws.onclose = (e) => {
      if (s.asr === "nova") endNovaTurn(s); // answer whatever was flushed on mute
      if (session !== s) return;
      // Dropped mid-session: reconnect once it has proven it can stay up.
      const stable = s.openedAt && Date.now() - s.openedAt > 5000;
      closeSession(s);
      session = null;
      if (stable) return unmute();
      setStatus("error", "Disconnected");
      showError(`Deepgram connection closed${e.reason ? `: ${e.reason}` : ` (code ${e.code})`}. Check the API key and ${ASR[s.asr].label} access.`);
    };

    s.stream = await micP;
    await workletP;
    if (session !== s) return closeSession(s);
    const node = new AudioWorkletNode(s.ctx, "pcm-worklet", { numberOfOutputs: 0 });
    node.port.onmessage = (e) => {
      if (ws.readyState === WebSocket.OPEN) sendAudio(e.data);
      else if (ws.readyState === WebSocket.CONNECTING && s.queue.length < 100) s.queue.push(e.data);
    };
    s.ctx.createMediaStreamSource(s.stream).connect(node);
    await s.ctx.resume();
  } catch (e) {
    if (session !== s) return;
    closeSession(s);
    session = null;
    setStatus("error", "Mic off");
    showError(e.name === "NotAllowedError" ? "Microphone permission was denied." : e.message);
  }
}

function closeSession(s) {
  s.stream?.getTracks().forEach((t) => t.stop());
  s.ctx?.close().catch(() => {});
  const ws = s.ws;
  if (!ws || ws.readyState > WebSocket.OPEN) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close();
    return;
  }
  // Finish the sentence in flight so muting mid-thought still gets an answer,
  // then let Deepgram flush and close. The timer is a backstop.
  if (s.asr === "nova") ws.send(JSON.stringify({ type: "Finalize" }));
  else if (userRow) ws.send(JSON.stringify({ type: "ForceEndTurn" }));
  ws.send(JSON.stringify({ type: "CloseStream" }));
  setTimeout(() => ws.close(), 2000);
}

// Keep the phone screen on while listening; a sleeping screen stops the mic.
let wakeLock = null;
async function holdScreen() {
  if (!session || wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
    wakeLock?.addEventListener("release", () => (wakeLock = null));
    if (!session) releaseScreen();
  } catch {}
}
function releaseScreen() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener("visibilitychange", holdScreen);

function mute() {
  releaseScreen();
  const s = session;
  session = null;
  if (s) closeSession(s);
  setStatus("muted", "Muted");
}

// ---------- Wiring ----------

els.mic.onclick = () => (session ? mute() : unmute());
for (const input of document.querySelectorAll('input[name="asr"]')) {
  input.checked = input.value === asr;
  input.onchange = () => {
    asr = input.value;
    save(STORE.asr, asr);
    // Switch models on the fly: finish the current stream and reconnect.
    if (session) {
      mute();
      unmute();
    }
  };
}
$("newChat").onclick = () => {
  if (chat.messages.length || userRow || answer) switchChat(newChatObject());
  document.body.classList.remove("sidebar-open");
};
$("toggleSidebar").onclick = () => document.body.classList.toggle("sidebar-open");
$("messages").onclick = () => document.body.classList.remove("sidebar-open");
$("openSettings").onclick = () => {
  els.prompt.value = systemPrompt;
  els.settings.showModal();
};
$("resetPrompt").onclick = () => (els.prompt.value = DEFAULT_SYSTEM_PROMPT);
els.settings.onclose = () => {
  if (els.settings.returnValue !== "save") return;
  systemPrompt = els.prompt.value;
  save(STORE.prompt, systemPrompt);
};

renderMessages();
renderChatList();
