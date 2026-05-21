/* ════════════════════════════════════════════════════════════════
   Chat · WebSocket client + streaming render
   ════════════════════════════════════════════════════════════════ */

(function () {
  const F = window.FALAK;

  const body  = document.getElementById("chatBody");
  const form  = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSend");
  const statusDot = document.getElementById("wsStatus");
  const contextEl = document.getElementById("chatContext");
  const contextLabel = document.getElementById("contextLabel");
  const suggestionEls = document.querySelectorAll(".suggestion");

  let ws = null;
  let cellStats = null;
  let streamingMsgEl = null;
  let streamingBuffer = "";
  let thinkingEl = null;
  let reconnectAttempt = 0;

  // ─── WebSocket lifecycle ─────────────────────────────────────
  function connect() {
    ws = new WebSocket(F.wsUrl);
    statusDot.title = "Connecting…";
    statusDot.className = "status-dot";

    ws.onopen = () => {
      reconnectAttempt = 0;
      statusDot.className = "status-dot online";
      statusDot.title = "Connected to Suv";
    };

    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handle(data);
    };

    ws.onerror = () => {
      statusDot.className = "status-dot offline";
      statusDot.title = "Connection error";
    };

    ws.onclose = () => {
      statusDot.className = "status-dot offline";
      statusDot.title = "Disconnected — retrying";
      const delay = Math.min(8000, 800 * Math.pow(2, reconnectAttempt++));
      setTimeout(connect, delay);
    };
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  // ─── Incoming message handling ──────────────────────────────
  function handle(data) {
    if (data.type === "ai_chunk") {
      if (!streamingMsgEl) startStreamingMessage();
      streamingBuffer += data.text;
      const html = formatMarkdownLite(streamingBuffer);
      streamingMsgEl.querySelector(".msg-bubble").innerHTML = html;
      scrollToBottom();
    } else if (data.type === "ai_done") {
      streamingMsgEl = null;
      streamingBuffer = "";
      sendBtn.disabled = false;
      removeThinking();
    } else if (data.type === "system") {
      // first system message carries gemini_configured
      if ("gemini_configured" in data && !data.gemini_configured) {
        addSystemNotice("⚠️ Gemini API key not configured — running in demo mode. Replies are local placeholders.");
      }
    } else if (data.type === "error") {
      removeThinking();
      addError(data.message);
      sendBtn.disabled = false;
    }
  }

  function startStreamingMessage() {
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = `<div class="msg-bubble"></div>`;
    body.appendChild(el);
    streamingMsgEl = el;
    streamingBuffer = "";
    scrollToBottom();
  }

  function appendUserMessage(text) {
    const el = document.createElement("div");
    el.className = "msg msg-user";
    el.innerHTML = `<div class="msg-bubble"></div>`;
    el.querySelector(".msg-bubble").textContent = text;
    body.appendChild(el);
    scrollToBottom();
  }

  function addThinking() {
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-ai thinking";
    el.innerHTML = `<div class="msg-bubble"><span></span><span></span><span></span></div>`;
    body.appendChild(el);
    thinkingEl = el;
    scrollToBottom();
  }
  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function addError(msg) {
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = `<div class="msg-bubble" style="border-color: rgba(239,68,68,0.4); color: #fca5a5;">⚠️ ${escapeHtml(msg)}</div>`;
    body.appendChild(el);
    scrollToBottom();
  }
  function addSystemNotice(text) {
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = `<div class="msg-bubble" style="font-size:12.5px;color:var(--text-3);font-style:italic;background:transparent;border-color:rgba(250,204,21,0.25);">${escapeHtml(text)}</div>`;
    body.appendChild(el);
    scrollToBottom();
  }

  // ─── Send / submit ───────────────────────────────────────────
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    if (!send({ type: "user_message", text })) {
      addError("Not connected.");
      return;
    }
    appendUserMessage(text);
    input.value = "";
    autosize();
    sendBtn.disabled = true;
    addThinking();
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  input.addEventListener("input", autosize);
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(120, input.scrollHeight) + "px";
  }

  suggestionEls.forEach((btn) => {
    btn.addEventListener("click", () => {
      input.value = btn.textContent;
      input.focus();
      autosize();
    });
  });

  // ─── Cell context ────────────────────────────────────────────
  function setCellContext(stats) {
    cellStats = stats;
    send({ type: "select_cell", stats });
    contextEl.classList.add("active");
    contextLabel.innerHTML =
      `Cell <code style="font-family:var(--font-mono);font-size:11px;color:var(--water-0)">${stats.id}</code> ` +
      `· ${stats.district} · ${stats.dominant_crop} ` +
      `· IRI <b>${stats.iri_score.toFixed(2)}</b> (${stats.stress_class})`;
  }

  // ─── Utilities ───────────────────────────────────────────────
  function scrollToBottom() { body.scrollTop = body.scrollHeight; }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  }

  // Minimal markdown: **bold**, `code`, ### headings, - bullets, line breaks
  function formatMarkdownLite(s) {
    let html = escapeHtml(s);
    html = html.replace(/^### (.+)$/gm, '<h4 style="margin:6px 0 2px;font-size:13.5px;color:var(--water-0);">$1</h4>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/(?:^|\n)- (.+)/g, "<br>• $1");
    html = html.replace(/```json[\s\S]+?```/g, "");
    html = html.replace(/```([^`]+)```/g, '<pre style="background:var(--bg-1);padding:8px 10px;border-radius:6px;font-size:12px;overflow-x:auto;">$1</pre>');
    html = html.replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
    return html;
  }

  // boot
  connect();

  window.FalakChat = { setCellContext };
})();
