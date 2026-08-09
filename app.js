/* PhilosopherChat — vanilla SPA, no build step. */
(function () {
  "use strict";

  var config = window.PHILOSOPHER_CHAT_CONFIG || {};
  var apiBase = (config.apiBase || "").replace(/\/$/, "");

  var LAST_READ_KEY = "philosopher_chat_last_read";
  var BACKOFFS = [2000, 5000, 10000];
  var LIST_POLL_MS = 15000;

  var state = {
    roster: [], // [{id, name, era, tradition, emoji, color, doctrine, style, relationships, known_for}]
    rosterById: {},
    threads: [], // summaries
    activeId: null,
    activeView: null, // %{thread: {...}, duplicate?} thread view
    eventSource: null,
    backoffIndex: 0,
    lastSeq: 0, // last event_seq seen on the active stream
    epoch: null, // server process generation; changes when the backend restarts
    pendingTemp: [], // optimistic messages not yet confirmed
    lastRead: loadLastRead(),
    listPoll: null
  };

  // -- DOM shortcuts --

  function $(id) { return document.getElementById(id); }

  var els = {
    app: $("app"),
    sidebar: $("sidebar"),
    newThreadBtn: $("new-thread-btn"),
    threadList: $("thread-list"),
    threadPane: $("thread-pane"),
    threadEmpty: $("thread-empty"),
    threadView: $("thread-view"),
    backBtn: $("back-btn"),
    threadName: $("thread-name"),
    memberChips: $("member-chips"),
    pauseBtn: $("pause-btn"),
    messages: $("messages"),
    typingIndicator: $("typing-indicator"),
    pausedNote: $("paused-note"),
    composer: $("composer"),
    composerInput: $("composer-input"),
    drawerBackdrop: $("drawer-backdrop"),
    personaDrawer: $("persona-drawer"),
    drawerIdentity: $("drawer-identity"),
    drawerBody: $("drawer-body"),
    drawerClose: $("drawer-close"),
    modalBackdrop: $("modal-backdrop"),
    modalClose: $("modal-close"),
    newThreadForm: $("new-thread-form"),
    newThreadName: $("new-thread-name"),
    newThreadPace: $("new-thread-pace"),
    newThreadError: $("new-thread-error"),
    rosterList: $("roster-list"),
    toasts: $("toasts")
  };

  // -- helpers --

  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeColor(color) {
    return /^#[0-9a-fA-F]{3,8}$/.test(color || "") ? color : "#9aa1b2";
  }

  function loadLastRead() {
    try {
      return JSON.parse(localStorage.getItem(LAST_READ_KEY) || "{}") || {};
    } catch (_e) {
      return {};
    }
  }

  function saveLastRead() {
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(state.lastRead));
  }

  function toast(text, kind) {
    var el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " error" : "");
    el.textContent = text;
    els.toasts.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  function personaFor(id) {
    return state.rosterById[id] || null;
  }

  function displayName(id) {
    if (id === "you") return "You";
    var p = personaFor(id);
    return p ? p.name : id;
  }

  function avatarHtml(id, cls) {
    var p = personaFor(id);
    var emoji = id === "you" ? "🙂" : p ? p.emoji : "❔";
    var color = id === "you" ? "#4caf9d" : p ? p.color : "#555";
    return '<span class="' + cls + '" style="background:' + safeColor(color) + '33;border:1px solid ' +
      safeColor(color) + '">' + esc(emoji) + "</span>";
  }

  function formatTime(atMs) {
    if (!atMs) return "";
    var d = new Date(atMs);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function newClientMsgId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "cm-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  // -- API client --

  async function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };

    var res = await fetch(apiBase + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });

    var data = null;
    try { data = await res.json(); } catch (_e) { /* no body */ }

    if (!res.ok) {
      var err = new Error((data && data.error) || "Request failed");
      err.status = res.status;
      throw err;
    }

    return data;
  }

  // -- boot --

  async function boot() {
    try {
      var rosterData = await api("/api/chat/roster");
      state.roster = rosterData.contacts || [];
      state.rosterById = {};
      state.roster.forEach(function (c) { state.rosterById[c.id] = c; });

      renderRosterList();
      await refreshThreads();
      renderThreadList();

      clearInterval(state.listPoll);
      state.listPoll = setInterval(async function () {
        try {
          await refreshThreads();
          renderThreadList();
        } catch (_e) { /* keep polling */ }
      }, LIST_POLL_MS);
    } catch (_e) {
      toast("Could not reach the server.", "error");
    }
  }

  async function refreshThreads() {
    var data = await api("/api/chat/threads");
    state.threads = data.threads || [];
  }

  // -- thread list --

  function unreadCount(summary) {
    var last = summary.last_message;
    if (!last || typeof last.seq !== "number") return 0;
    var read = state.lastRead[summary.id] || 0;
    return Math.max(0, last.seq - read);
  }

  function renderThreadList() {
    if (!state.threads.length) {
      els.threadList.innerHTML = '<div class="thread-list-empty">No conversations yet.</div>';
      return;
    }

    els.threadList.innerHTML = state.threads.map(function (t) {
      var emojis = (t.member_ids || [])
        .filter(function (id) { return id !== "you"; })
        .map(function (id) {
          var p = personaFor(id);
          return p ? p.emoji : "";
        })
        .join(" ");

      var preview = t.last_message
        ? displayName(t.last_message.author) + ": " + t.last_message.text
        : "No messages yet";

      var badge = unreadCount(t);
      var statusNote = t.status !== "active" ? " · " + t.status : "";

      return (
        '<button class="thread-item' + (t.id === state.activeId ? " active" : "") +
        '" data-thread-id="' + esc(t.id) + '">' +
        '<span class="thread-item-top">' +
        '<span class="thread-item-name">' + esc(t.name) + "</span>" +
        (badge > 0 ? '<span class="unread-badge">' + badge + "</span>" : "") +
        "</span>" +
        '<span class="thread-item-top">' +
        '<span class="thread-item-emoji">' + esc(emojis + statusNote) + "</span>" +
        "</span>" +
        '<span class="thread-item-preview">' + esc(preview) + "</span>" +
        "</button>"
      );
    }).join("");
  }

  els.threadList.addEventListener("click", function (ev) {
    var item = ev.target.closest("[data-thread-id]");
    if (item) openThread(item.getAttribute("data-thread-id"));
  });

  // -- thread view --

  async function openThread(id) {
    state.activeId = id;
    state.pendingTemp = [];
    state.lastSeq = 0;
    state.backoffIndex = 0;

    els.threadEmpty.classList.add("hidden");
    els.threadView.classList.remove("hidden");

    try {
      var data = await api("/api/chat/threads/" + encodeURIComponent(id));
      state.activeView = data.thread;
      state.epoch = data.thread.epoch;
      els.app.classList.add("thread-open");
      renderThreadView();
      markRead();
      renderThreadList();
      connectStream();
    } catch (_e) {
      els.app.classList.remove("thread-open");
      toast("Could not load the thread.", "error");
    }
  }

  function renderThreadView() {
    var view = state.activeView;
    if (!view) return;

    els.threadName.textContent = view.name || "";
    renderMemberChips(view);
    renderMessages(view, true);
    renderStatus(view);
    renderTyping(view.typing);
  }

  function renderMemberChips(view) {
    els.memberChips.innerHTML = (view.members || []).map(function (m) {
      var chip =
        '<span class="avatar" style="background:' + safeColor(m.color || "#555") + '33;border:1px solid ' +
        safeColor(m.color || "#555") + '">' + esc(m.emoji || "🙂") + "</span>" + esc(m.name);

      if (m.is_user) {
        return '<span class="member-chip">' + chip + "</span>";
      }

      return '<button class="member-chip" data-agent-id="' + esc(m.id) + '" title="About ' +
        esc(m.name) + '">' + chip + "</button>";
    }).join("");
  }

  els.memberChips.addEventListener("click", function (ev) {
    var chip = ev.target.closest("[data-agent-id]");
    if (chip) openPersonaDrawer(chip.getAttribute("data-agent-id"));
  });

  function renderMessages(view, force) {
    var messages = (view.messages || []).concat(state.pendingTemp);
    var html = "";
    var prevAuthor = null;

    messages.forEach(function (m) {
      var isUser = m.author === "you";
      var grouped = m.author === prevAuthor;
      prevAuthor = m.author;

      var cls = "msg-row " + (isUser ? "user" : "agent") +
        (grouped ? " grouped" : "") + (m.pending ? " pending" : "");

      var avatar = isUser
        ? ""
        : grouped
          ? '<span class="msg-avatar-spacer"></span>'
          : avatarHtml(m.author, "msg-avatar");

      var author = !isUser && !grouped
        ? '<div class="msg-author" style="color:' + safeColor((personaFor(m.author) || {}).color || "#9aa1b2") +
          '">' + esc(displayName(m.author)) + "</div>"
        : "";

      html +=
        '<div class="' + cls + '">' + avatar +
        '<div class="msg-bubble">' + author + esc(m.text) +
        '<span class="msg-time">' + esc(formatTime(m.at_ms)) + "</span>" +
        "</div></div>";
    });

    var atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
    els.messages.innerHTML = html;
    if (atBottom || force) {
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }

  function renderStatus(view) {
    var paused = view.status !== "active";
    els.pauseBtn.textContent = view.status === "paused" ? "Resume" : "Pause";
    els.pausedNote.classList.toggle("hidden", !paused);
    els.composerInput.disabled = paused;
    els.composer.querySelector("button[type=submit]").disabled = paused;
  }

  function renderTyping(agentId) {
    if (!agentId) {
      els.typingIndicator.classList.add("hidden");
      els.typingIndicator.innerHTML = "";
      return;
    }

    els.typingIndicator.innerHTML =
      esc(displayName(agentId)) + ' is thinking<span class="typing-dots"></span>';
    els.typingIndicator.classList.remove("hidden");
  }

  function markRead() {
    var view = state.activeView;
    if (!view || !state.activeId) return;

    var maxSeq = (view.messages || []).reduce(function (acc, m) {
      return typeof m.seq === "number" ? Math.max(acc, m.seq) : acc;
    }, 0);

    if (maxSeq > (state.lastRead[state.activeId] || 0)) {
      state.lastRead[state.activeId] = maxSeq;
      saveLastRead();
    }
  }

  els.backBtn.addEventListener("click", function () {
    closeStream();
    state.activeId = null;
    state.activeView = null;
    els.app.classList.remove("thread-open");
    els.threadView.classList.add("hidden");
    els.threadEmpty.classList.remove("hidden");
    renderThreadList();
  });

  els.pauseBtn.addEventListener("click", async function () {
    if (!state.activeId || !state.activeView) return;
    var action = state.activeView.status === "paused" ? "resume" : "pause";

    try {
      var data = await api("/api/chat/threads/" + encodeURIComponent(state.activeId) + "/" + action, {
        method: "POST"
      });
      state.activeView.status = data.status;
      renderStatus(state.activeView);
      await refreshThreads();
      renderThreadList();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  // -- composer --

  function autoGrow() {
    els.composerInput.style.height = "auto";
    els.composerInput.style.height = Math.min(els.composerInput.scrollHeight, 140) + "px";
  }

  els.composerInput.addEventListener("input", autoGrow);

  els.composerInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.composer.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (!state.activeId || !state.activeView || state.activeView.status !== "active") return;

    var text = els.composerInput.value.trim();
    if (!text) return;

    els.composerInput.value = "";
    autoGrow();

    var clientMsgId = newClientMsgId();
    var temp = {
      seq: "temp-" + clientMsgId,
      author: "you",
      text: text,
      at_ms: Date.now(),
      pending: true
    };

    state.pendingTemp.push(temp);
    renderMessages(state.activeView);

    try {
      var data = await api("/api/chat/threads/" + encodeURIComponent(state.activeId) + "/messages", {
        method: "POST",
        body: { text: text, client_msg_id: clientMsgId }
      });

      state.pendingTemp = state.pendingTemp.filter(function (m) { return m.seq !== temp.seq; });
      state.activeView = data.thread;
      renderMessages(state.activeView);
      markRead();
      await refreshThreads();
      renderThreadList();
    } catch (e) {
      state.pendingTemp = state.pendingTemp.filter(function (m) { return m.seq !== temp.seq; });
      renderMessages(state.activeView);
      toast(e.message, "error");
    }
  });

  // -- SSE stream --

  function closeStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function connectStream() {
    closeStream();
    if (!state.activeId) return;

    var url = apiBase + "/api/chat/threads/" + encodeURIComponent(state.activeId) +
      "/stream?since=" + state.lastSeq;

    var es = new EventSource(url);
    state.eventSource = es;

    es.onopen = function () {
      state.backoffIndex = 0;
    };

    es.onmessage = function (ev) {
      var payload;
      try { payload = JSON.parse(ev.data); } catch (_e) { return; }
      if (typeof payload.event_seq === "number") {
        state.lastSeq = Math.max(state.lastSeq, payload.event_seq);
      }
      handleStreamEvent(payload);
    };

    es.onerror = function () {
      if (state.eventSource !== es) return; // superseded
      closeStream();

      var delay = BACKOFFS[Math.min(state.backoffIndex, BACKOFFS.length - 1)];
      state.backoffIndex += 1;

      setTimeout(async function () {
        if (!state.activeId) return;

        // Catch up on anything missed while disconnected.
        try {
          var data = await api("/api/chat/threads/" + encodeURIComponent(state.activeId));
          state.activeView = data.thread;
          if (data.thread.epoch !== state.epoch) {
            state.lastSeq = 0; // server restarted; replay everything
            state.epoch = data.thread.epoch;
          }
          renderThreadView();
          markRead();
          await refreshThreads();
          renderThreadList();
          connectStream();
        } catch (_e) {
          connectStream();
        }
      }, delay);
    };
  }

  function handleStreamEvent(payload) {
    if (!payload || !payload.type || payload.type === "ping") return;
    if (!state.activeView) return;

    switch (payload.type) {
      case "message":
        var msg = payload.message;
        if (!msg) return;

        var exists = (state.activeView.messages || []).some(function (m) {
          return m.seq === msg.seq;
        });

        if (!exists) {
          state.activeView.messages = (state.activeView.messages || []).concat([msg]);
        }

        if (msg.author === "you") {
          for (var t = 0; t < state.pendingTemp.length; t++) {
            if (state.pendingTemp[t].text === msg.text) {
              state.pendingTemp.splice(t, 1);
              break;
            }
          }
        }

        if (state.activeView.typing === msg.author) {
          state.activeView.typing = null;
          renderTyping(null);
        }

        renderMessages(state.activeView);

        if (document.visibilityState === "visible") {
          markRead();
        }

        refreshThreads().then(renderThreadList).catch(function () {});
        break;

      case "typing":
        state.activeView.typing = payload.agent_id || null;
        renderTyping(state.activeView.typing);
        break;

      case "status":
        state.activeView.status = payload.status;
        renderStatus(state.activeView);
        refreshThreads().then(renderThreadList).catch(function () {});
        break;

      case "agent_error":
        toast(displayName(payload.agent_id) + " failed to respond.", "error");
        break;

      case "agent_stalled":
        if (state.activeView.typing === payload.agent_id) {
          state.activeView.typing = null;
          renderTyping(null);
        }
        toast(displayName(payload.agent_id) + " " + (payload.reason || "has gone quiet."), "error");
        break;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.activeId) {
      markRead();
      renderThreadList();
    }
  });

  // -- persona drawer --

  async function openPersonaDrawer(agentId) {
    var p = personaFor(agentId);
    if (!p || !state.activeId) return;

    els.drawerIdentity.innerHTML =
      avatarHtml(agentId, "avatar") +
      "<div>" +
      '<div class="drawer-name">' + esc(p.name) + "</div>" +
      '<div class="drawer-era">' + esc(p.era || "") + "</div>" +
      "</div>";

    els.drawerBody.innerHTML =
      section("Tradition", p.tradition) +
      section("Known for", p.known_for) +
      section("Doctrine", p.doctrine) +
      section("Voice", p.style) +
      '<div class="drawer-section"><h3>What they think</h3><p class="opinion">Loading…</p></div>';

    els.personaDrawer.classList.remove("hidden");
    els.drawerBackdrop.classList.remove("hidden");

    try {
      var data = await api(
        "/api/chat/threads/" + encodeURIComponent(state.activeId) +
          "/memories/" + encodeURIComponent(agentId)
      );

      var files = (data.memories && data.memories.files) || [];
      var opinions = files.filter(function (f) {
        return f.path.indexOf("opinions/") === 0 && f.content.trim() !== "";
      });

      var html;
      if (opinions.length) {
        html = opinions.map(function (f) {
          return '<div class="opinion"><span class="opinion-path">' + esc(f.path) + "</span>" +
            esc(f.content) + "</div>";
        }).join("");
      } else {
        html = '<p class="opinion">No written opinions yet.</p>';
      }

      setDrawerOpinions(html);
    } catch (_e) {
      setDrawerOpinions('<p class="opinion">Could not load memories.</p>');
    }
  }

  function section(title, text) {
    if (!text) return "";
    return '<div class="drawer-section"><h3>' + esc(title) + "</h3><p>" + esc(text) + "</p></div>";
  }

  function setDrawerOpinions(html) {
    var sections = els.drawerBody.querySelectorAll(".drawer-section");
    var last = sections[sections.length - 1];
    if (last) last.innerHTML = "<h3>What they think</h3>" + html;
  }

  function closeDrawer() {
    els.personaDrawer.classList.add("hidden");
    els.drawerBackdrop.classList.add("hidden");
  }

  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerBackdrop.addEventListener("click", closeDrawer);

  // -- new thread modal --

  function renderRosterList() {
    els.rosterList.innerHTML = state.roster.map(function (c) {
      return (
        '<label class="roster-item" data-roster-id="' + esc(c.id) + '">' +
        '<input type="checkbox" value="' + esc(c.id) + '">' +
        '<span class="avatar" style="background:' + safeColor(c.color) + '33;border:1px solid ' +
        safeColor(c.color) + '">' + esc(c.emoji) + "</span>" +
        '<span class="roster-item-name">' + esc(c.name) + "</span>" +
        "</label>"
      );
    }).join("");
  }

  els.rosterList.addEventListener("change", function (ev) {
    var item = ev.target.closest(".roster-item");
    if (!item) return;
    item.classList.toggle("selected", ev.target.checked);
  });

  function openModal() {
    els.newThreadError.classList.add("hidden");
    els.newThreadForm.reset();
    els.rosterList.querySelectorAll(".roster-item").forEach(function (el) {
      el.classList.remove("selected");
    });
    els.modalBackdrop.classList.remove("hidden");
    els.newThreadName.focus();
  }

  function closeModal() {
    els.modalBackdrop.classList.add("hidden");
  }

  els.newThreadBtn.addEventListener("click", openModal);
  els.modalClose.addEventListener("click", closeModal);
  els.modalBackdrop.addEventListener("click", function (ev) {
    if (ev.target === els.modalBackdrop) closeModal();
  });

  els.newThreadForm.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    els.newThreadError.classList.add("hidden");

    var memberIds = Array.prototype.map.call(
      els.rosterList.querySelectorAll("input:checked"),
      function (input) { return input.value; }
    );

    try {
      var data = await api("/api/chat/threads", {
        method: "POST",
        body: {
          name: els.newThreadName.value,
          member_ids: memberIds,
          pace: els.newThreadPace.value
        }
      });

      closeModal();
      await refreshThreads();
      renderThreadList();
      openThread(data.thread_id);
    } catch (e) {
      els.newThreadError.textContent = e.message;
      els.newThreadError.classList.remove("hidden");
    }
  });

  // -- start --

  boot();
})();
