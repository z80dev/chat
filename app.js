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
    listPoll: null,
    openToken: 0, // guards against out-of-order thread loads
    drawerAgentId: null, // guards against out-of-order persona loads
    reconnectTimer: null,
    seenSeqs: {}, // message seqs already painted, so only arrivals animate
    memberSummary: "", // header subtitle shown when nobody is typing
  };

  var MAX_MEMBERS = 6;
  var HEADER_AVATARS = 3; // before the "+N" chip
  var GROUP_GAP_MS = 5 * 60 * 1000; // a pause this long starts a new bubble run
  var DAY_MS = 24 * 60 * 60 * 1000;

  // -- DOM shortcuts --

  function $(id) {
    return document.getElementById(id);
  }

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
    threadStatus: $("thread-status"),
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
    toasts: $("toasts"),
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
    setTimeout(function () {
      el.remove();
    }, 4500);
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
    return (
      '<span class="' +
      cls +
      '" style="background:' +
      safeColor(color) +
      "33;border:1px solid " +
      safeColor(color) +
      '">' +
      esc(emoji) +
      "</span>"
    );
  }

  function formatTime(atMs) {
    if (!atMs) return "";
    var d = new Date(atMs);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Midnight of the day `atMs` falls on, in local time — the unit both the
  // day dividers and the sidebar timestamps compare on.
  function startOfDay(atMs) {
    var d = new Date(atMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function sameDay(a, b) {
    if (!a || !b) return false;
    return startOfDay(a) === startOfDay(b);
  }

  // Days between `atMs` and today, so "yesterday" survives month boundaries.
  function daysAgo(atMs) {
    return Math.round((startOfDay(Date.now()) - startOfDay(atMs)) / DAY_MS);
  }

  function dayLabel(atMs) {
    if (!atMs) return "";
    var delta = daysAgo(atMs);
    if (delta <= 0) return "Today";
    if (delta === 1) return "Yesterday";
    var d = new Date(atMs);
    if (delta < 7) return d.toLocaleDateString([], { weekday: "long" });
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: delta > 300 ? "numeric" : undefined,
    });
  }

  // Sidebar stamps stay short: time today, weekday this week, date beyond.
  function formatListTime(atMs) {
    if (!atMs) return "";
    var delta = daysAgo(atMs);
    if (delta <= 0) return formatTime(atMs);
    if (delta === 1) return "Yesterday";
    var d = new Date(atMs);
    if (delta < 7) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
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
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    var data = null;
    try {
      data = await res.json();
    } catch (_e) {
      /* no body */
    }

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
      state.roster.forEach(function (c) {
        state.rosterById[c.id] = c;
      });

      renderRosterList();
      await refreshThreads();
      renderThreadList();

      clearInterval(state.listPoll);
      state.listPoll = setInterval(async function () {
        try {
          await refreshThreads();
          renderThreadList();
        } catch (_e) {
          /* keep polling */
        }
      }, LIST_POLL_MS);
    } catch (_e) {
      toast("Could not reach the server.", "error");
      renderBootError();
    }
  }

  // Boot failed before the sidebar had anything to show — offer a way back in.
  function renderBootError() {
    els.threadList.innerHTML =
      '<div class="thread-list-empty">Could not reach the server.<br>' +
      '<button id="boot-retry" class="btn btn-small retry-btn">Retry</button></div>';
    var retry = $("boot-retry");
    if (retry) retry.addEventListener("click", boot);
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

  // Previews live on one line; collapse newlines and cap the string so a wall
  // of text never bloats the list markup.
  function previewText(t) {
    if (!t.last_message) return "No messages yet";
    var body = String(t.last_message.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (body.length > 140) body = body.slice(0, 140) + "…";
    return displayName(t.last_message.author) + ": " + body;
  }

  // A thread's face in the list: the first philosopher's emoji, with a second
  // one tucked into the corner so group chats read as groups at a glance.
  function threadAvatarHtml(t) {
    var agents = (t.member_ids || []).filter(function (id) {
      return id !== "you";
    });

    var html = '<span class="thread-avatar">' + avatarHtml(agents[0], "avatar");
    if (agents.length > 1) {
      html += avatarHtml(agents[1], "avatar avatar-sub");
    }
    return html + "</span>";
  }

  function renderThreadList() {
    var scrollTop = els.threadList.scrollTop;

    if (!state.threads.length) {
      els.threadList.innerHTML =
        '<div class="thread-list-empty">' +
        '<span class="empty-emoji" aria-hidden="true">🗨️</span>' +
        "No conversations yet.<br>Invite a few philosophers and get started." +
        '<br><button class="btn btn-primary btn-small btn-pill" type="button" ' +
        'data-action="new-thread">New conversation</button></div>';
      return;
    }

    els.threadList.innerHTML = state.threads
      .map(function (t) {
        var badge = unreadCount(t);
        var last = t.last_message;
        var stamp = last ? formatListTime(last.at_ms) : "";

        return (
          '<button class="thread-item' +
          (t.id === state.activeId ? " active" : "") +
          (badge > 0 ? " unread" : "") +
          '" data-thread-id="' +
          esc(t.id) +
          '">' +
          threadAvatarHtml(t) +
          '<span class="thread-item-body">' +
          '<span class="thread-item-top">' +
          '<span class="thread-item-name">' +
          esc(t.name) +
          "</span>" +
          (stamp
            ? '<span class="thread-item-time">' + esc(stamp) + "</span>"
            : "") +
          "</span>" +
          '<span class="thread-item-bottom">' +
          '<span class="thread-item-preview">' +
          esc(previewText(t)) +
          "</span>" +
          (t.status !== "active"
            ? '<span class="thread-item-status">' + esc(t.status) + "</span>"
            : "") +
          (badge > 0 ? '<span class="unread-badge">' + badge + "</span>" : "") +
          "</span>" +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    // Re-rendering wholesale on every poll/event would otherwise jump the list
    // back to the top while the reader is scrolled down it.
    els.threadList.scrollTop = scrollTop;
  }

  els.threadList.addEventListener("click", function (ev) {
    var item = ev.target.closest("[data-thread-id]");
    if (item) openThread(item.getAttribute("data-thread-id"));
  });

  // Empty-state CTAs live inside markup that gets replaced wholesale, so they
  // are wired by delegation rather than by direct listener.
  document.addEventListener("click", function (ev) {
    if (ev.target.closest('[data-action="new-thread"]')) openModal();
  });

  // -- thread view --

  // Adopt a thread snapshot as the active view. `latest_seq` is the event-log
  // cursor the snapshot was taken at, so the stream only has to replay what
  // happened after it — starting from 0 would re-deliver stale typing events.
  function adoptThread(thread) {
    state.activeView = thread;
    var latest =
      typeof thread.latest_seq === "number" ? thread.latest_seq : null;

    if (thread.epoch && thread.epoch !== state.epoch) {
      // New server generation: its event log restarted, so take its cursor as-is.
      state.epoch = thread.epoch;
      state.lastSeq = latest == null ? 0 : latest;
    } else if (latest != null) {
      state.lastSeq = Math.max(state.lastSeq, latest);
    }
  }

  function showEmptyPane() {
    els.app.classList.remove("thread-open");
    els.threadView.classList.add("hidden");
    els.threadEmpty.classList.remove("hidden");
  }

  async function openThread(id) {
    var token = ++state.openToken;

    closeStream();
    state.activeId = id;
    state.activeView = null;
    state.pendingTemp = [];
    state.lastSeq = 0;
    state.backoffIndex = 0;
    state.seenSeqs = {};
    state.memberSummary = "";

    // Show the pane straight away so a tap on mobile feels immediate.
    els.threadEmpty.classList.add("hidden");
    els.threadView.classList.remove("hidden");
    els.app.classList.add("thread-open");
    els.threadName.textContent = "";
    els.threadStatus.textContent = "";
    els.memberChips.innerHTML = "";
    els.messages.innerHTML = '<div class="messages-loading">Loading…</div>';
    renderTyping(null);

    try {
      var data = await api("/api/chat/threads/" + encodeURIComponent(id));
      if (token !== state.openToken) return; // a newer open won

      adoptThread(data.thread);
      renderThreadView();
      markRead();
      renderThreadList();
      connectStream();
      focusComposer();
    } catch (_e) {
      if (token !== state.openToken) return;
      state.activeId = null;
      showEmptyPane();
      renderThreadList();
      toast("Could not load the thread.", "error");
    }
  }

  // Keyboards on small screens cover the thread, so only pull focus on wide ones.
  function focusComposer() {
    if (window.matchMedia && window.matchMedia("(max-width: 700px)").matches) {
      return;
    }
    if (!els.composerInput.disabled) els.composerInput.focus();
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

  // The header shows an overlapping avatar stack of the philosophers (the user
  // is implied, as in every group chat) and lists the names underneath.
  function renderMemberChips(view) {
    var agents = (view.members || []).filter(function (m) {
      return !m.is_user;
    });

    var html = agents
      .slice(0, HEADER_AVATARS)
      .map(function (m) {
        var color = safeColor(m.color || "#555");
        return (
          '<button class="member-avatar" data-agent-id="' +
          esc(m.id) +
          '" title="About ' +
          esc(m.name) +
          '" aria-label="About ' +
          esc(m.name) +
          '"><span class="avatar" style="background:' +
          color +
          "33;border:1px solid " +
          color +
          '">' +
          esc(m.emoji || "🙂") +
          "</span></button>"
        );
      })
      .join("");

    if (agents.length > HEADER_AVATARS) {
      html +=
        '<span class="member-more">+' +
        (agents.length - HEADER_AVATARS) +
        "</span>";
    }

    els.memberChips.innerHTML = html;

    var names = agents.map(function (m) {
      return m.name;
    });
    names.push("You");
    state.memberSummary = names.join(", ");
  }

  // Subtitle under the thread name: whoever is thinking, else the member list.
  function setHeaderStatus(typingText) {
    els.threadStatus.textContent = typingText || state.memberSummary;
    els.threadStatus.classList.toggle("is-typing", !!typingText);
  }

  els.memberChips.addEventListener("click", function (ev) {
    var chip = ev.target.closest("[data-agent-id]");
    if (chip) openPersonaDrawer(chip.getAttribute("data-agent-id"));
  });

  // Two consecutive messages share a bubble run when the same author sent them
  // on the same day without a long pause between.
  function sameRun(a, b) {
    if (!a || !b || a.author !== b.author) return false;
    if (a.at_ms && b.at_ms) {
      if (!sameDay(a.at_ms, b.at_ms)) return false;
      if (b.at_ms - a.at_ms > GROUP_GAP_MS) return false;
    }
    return true;
  }

  // "Close enough to the bottom" — a reader inside this margin should be
  // carried along by new content; anyone further up is reading history.
  function isScrolledToBottom() {
    return (
      els.messages.scrollHeight -
        els.messages.scrollTop -
        els.messages.clientHeight <
      40
    );
  }

  function scrollMessagesToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderMessages(view, force) {
    if (!view) return;
    var messages = (view.messages || []).concat(state.pendingTemp);
    var html = "";

    messages.forEach(function (m, i) {
      var prev = messages[i - 1];
      var next = messages[i + 1];
      var isUser = m.author === "you";
      var startsRun = !sameRun(prev, m);
      var endsRun = !sameRun(m, next);

      if (m.at_ms && (!prev || !prev.at_ms || !sameDay(prev.at_ms, m.at_ms))) {
        html += '<div class="day-divider">' + esc(dayLabel(m.at_ms)) + "</div>";
      }

      // Only messages that were not on screen last render get the entry
      // animation — otherwise every repaint would replay the whole thread.
      var key = m.seq == null ? null : String(m.seq);
      var isNew = key != null && !state.seenSeqs[key];
      if (key != null) state.seenSeqs[key] = true;

      var cls =
        "msg-row " +
        (isUser ? "user" : "agent") +
        (startsRun ? " starts-group" : "") +
        (endsRun ? " ends-group" : "") +
        (isNew && !force ? " is-new" : "") +
        (m.pending ? " pending" : "");

      // The avatar hangs off the last bubble of a run, so a burst of messages
      // reads as one speaker rather than a column of repeated faces.
      var avatar = isUser
        ? ""
        : endsRun
          ? avatarHtml(m.author, "msg-avatar")
          : '<span class="msg-avatar-spacer"></span>';

      var author =
        !isUser && startsRun
          ? '<span class="msg-author" style="color:' +
            safeColor((personaFor(m.author) || {}).color || "#9aa1b2") +
            '">' +
            esc(displayName(m.author)) +
            "</span>"
          : "";

      html +=
        '<div class="' +
        cls +
        '">' +
        avatar +
        '<div class="msg-bubble">' +
        author +
        esc(m.text) +
        '<span class="msg-time">' +
        esc(formatTime(m.at_ms)) +
        "</span>" +
        "</div></div>";
    });

    var atBottom = isScrolledToBottom();
    els.messages.innerHTML = html;
    if (atBottom || force) scrollMessagesToBottom();
  }

  function renderStatus(view) {
    var paused = view.status !== "active";
    els.pauseBtn.textContent = view.status === "paused" ? "Resume" : "Pause";
    els.pauseBtn.title =
      view.status === "paused"
        ? "Let the philosophers talk again"
        : "Stop the philosophers from replying";
    els.pausedNote.classList.toggle("hidden", !paused);
    els.composerInput.disabled = paused;
    els.composer.querySelector("button[type=submit]").disabled = paused;
    if (paused) renderTyping(null);
  }

  function renderTyping(agentId) {
    // Nobody is thinking while the thread is paused.
    if (state.activeView && state.activeView.status !== "active")
      agentId = null;

    // Showing/hiding the bubble resizes the message list; keep a reader who was
    // already at the bottom pinned there instead of drifting up a row.
    var wasAtBottom = isScrolledToBottom();

    if (!agentId) {
      els.typingIndicator.classList.add("hidden");
      els.typingIndicator.innerHTML = "";
      setHeaderStatus(null);
      if (wasAtBottom) scrollMessagesToBottom();
      return;
    }

    var name = displayName(agentId);
    var color = safeColor((personaFor(agentId) || {}).color || "#9aa1b2");

    // The visible bubble is decorative; the live region announces the sentence.
    els.typingIndicator.innerHTML =
      '<span class="sr-only">' +
      esc(name) +
      " is thinking…</span>" +
      '<span class="typing-avatar" aria-hidden="true">' +
      avatarHtml(agentId, "msg-avatar") +
      "</span>" +
      '<span class="typing-bubble" aria-hidden="true">' +
      '<span class="typing-name" style="color:' +
      color +
      '">' +
      esc(name) +
      "</span>" +
      '<span class="typing-dots"><i></i><i></i><i></i></span>' +
      "</span>";
    els.typingIndicator.classList.remove("hidden");
    setHeaderStatus(name + " is thinking…");
    if (wasAtBottom) scrollMessagesToBottom();
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
    state.openToken += 1; // cancel any in-flight open
    closeStream();
    state.activeId = null;
    state.activeView = null;
    state.pendingTemp = [];
    renderTyping(null);
    showEmptyPane();
    renderThreadList();
  });

  els.pauseBtn.addEventListener("click", async function () {
    if (!state.activeId || !state.activeView) return;
    var threadId = state.activeId;
    var action = state.activeView.status === "paused" ? "resume" : "pause";

    els.pauseBtn.disabled = true;
    try {
      var data = await api(
        "/api/chat/threads/" + encodeURIComponent(threadId) + "/" + action,
        {
          method: "POST",
        },
      );
      if (state.activeId !== threadId || !state.activeView) return;
      state.activeView.status = data.status;
      renderStatus(state.activeView);
      await refreshThreads();
      renderThreadList();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      els.pauseBtn.disabled = false;
    }
  });

  // -- composer --

  function autoGrow() {
    els.composerInput.style.height = "auto";
    els.composerInput.style.height =
      Math.min(els.composerInput.scrollHeight, 140) + "px";
  }

  els.composerInput.addEventListener("input", autoGrow);

  els.composerInput.addEventListener("keydown", function (ev) {
    // isComposing: don't steal Enter while an IME candidate is being chosen.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.composer.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (
      !state.activeId ||
      !state.activeView ||
      state.activeView.status !== "active"
    )
      return;

    var text = els.composerInput.value.trim();
    if (!text) return;

    var threadId = state.activeId;
    els.composerInput.value = "";
    autoGrow();

    var clientMsgId = newClientMsgId();
    var temp = {
      seq: "temp-" + clientMsgId,
      author: "you",
      text: text,
      at_ms: Date.now(),
      pending: true,
    };

    state.pendingTemp.push(temp);
    renderMessages(state.activeView);

    try {
      var data = await api(
        "/api/chat/threads/" + encodeURIComponent(threadId) + "/messages",
        {
          method: "POST",
          body: { text: text, client_msg_id: clientMsgId },
        },
      );

      // The reader may have moved on to another thread while this was in flight.
      if (state.activeId !== threadId) return;

      dropTemp(temp);
      adoptThread(data.thread);
      renderMessages(state.activeView);
      markRead();
      await refreshThreads();
      renderThreadList();
    } catch (e) {
      if (state.activeId !== threadId) return;
      dropTemp(temp);
      renderMessages(state.activeView);
      // Give the text back rather than silently losing what was typed.
      if (!els.composerInput.value.trim()) {
        els.composerInput.value = text;
        autoGrow();
      }
      toast(e.message, "error");
    }
  });

  function dropTemp(temp) {
    state.pendingTemp = state.pendingTemp.filter(function (m) {
      return m.seq !== temp.seq;
    });
  }

  // -- SSE stream --

  function closeStream() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function connectStream() {
    closeStream();
    if (!state.activeId) return;

    var threadId = state.activeId;
    var url =
      apiBase +
      "/api/chat/threads/" +
      encodeURIComponent(threadId) +
      "/stream?since=" +
      state.lastSeq;

    var es = new EventSource(url);
    state.eventSource = es;

    es.onopen = function () {
      state.backoffIndex = 0;
    };

    es.onmessage = function (ev) {
      var payload;
      try {
        payload = JSON.parse(ev.data);
      } catch (_e) {
        return;
      }
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

      state.reconnectTimer = setTimeout(async function () {
        state.reconnectTimer = null;
        if (state.activeId !== threadId) return; // moved on to another thread

        // Catch up on anything missed while disconnected.
        try {
          var data = await api(
            "/api/chat/threads/" + encodeURIComponent(threadId),
          );
          if (state.activeId !== threadId) return;
          adoptThread(data.thread);
          renderThreadView();
          markRead();
          await refreshThreads();
          if (state.activeId !== threadId) return;
          renderThreadList();
          connectStream();
        } catch (_e) {
          if (state.activeId === threadId) connectStream();
        }
      }, delay);
    };
  }

  // Keep messages ordered by seq — a replayed or late event can arrive out of
  // order, and appending blindly would show it in the wrong place.
  function insertMessage(msg) {
    var list = state.activeView.messages || [];
    var i = list.length;
    while (
      i > 0 &&
      typeof list[i - 1].seq === "number" &&
      typeof msg.seq === "number" &&
      list[i - 1].seq > msg.seq
    ) {
      i -= 1;
    }
    list.splice(i, 0, msg);
    state.activeView.messages = list;
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

        if (!exists) insertMessage(msg);

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

        refreshThreads()
          .then(renderThreadList)
          .catch(function () {});
        break;

      case "typing":
        state.activeView.typing = payload.agent_id || null;
        renderTyping(state.activeView.typing);
        break;

      case "status":
        state.activeView.status = payload.status;
        if (payload.status !== "active") state.activeView.typing = null;
        renderStatus(state.activeView);
        refreshThreads()
          .then(renderThreadList)
          .catch(function () {});
        break;

      case "agent_error":
        // Otherwise "X is thinking…" hangs there for a reply that never comes.
        if (state.activeView.typing === payload.agent_id) {
          state.activeView.typing = null;
          renderTyping(null);
        }
        toast(displayName(payload.agent_id) + " failed to respond.", "error");
        break;

      case "agent_stalled":
        if (state.activeView.typing === payload.agent_id) {
          state.activeView.typing = null;
          renderTyping(null);
        }
        toast(
          displayName(payload.agent_id) +
            " " +
            (payload.reason || "has gone quiet."),
          "error",
        );
        break;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    if (state.activeId) markRead();
    // A backgrounded tab may have missed a poll; catch the list up right away.
    refreshThreads().then(renderThreadList).catch(renderThreadList);
  });

  // Don't leave a stream half-open when the page goes away.
  window.addEventListener("pagehide", closeStream);

  // -- persona drawer --

  async function openPersonaDrawer(agentId) {
    var p = personaFor(agentId);
    if (!p || !state.activeId) return;

    var threadId = state.activeId;
    state.drawerAgentId = agentId;

    els.drawerIdentity.innerHTML =
      avatarHtml(agentId, "avatar") +
      "<div>" +
      '<div class="drawer-name">' +
      esc(p.name) +
      "</div>" +
      '<div class="drawer-era">' +
      esc(p.era || "") +
      "</div>" +
      "</div>";

    els.drawerBody.innerHTML =
      section("About", p.bio) +
      section("Tradition", p.tradition) +
      section("Known for", p.known_for) +
      section("Doctrine", p.doctrine) +
      sectionList("Key works", p.works) +
      sectionList("In their words", p.quotes) +
      section("Voice", p.style) +
      '<div class="drawer-section"><h3>What they think</h3><p class="opinion">Loading…</p></div>';

    els.personaDrawer.classList.remove("hidden");
    els.drawerBackdrop.classList.remove("hidden");

    try {
      var data = await api(
        "/api/chat/threads/" +
          encodeURIComponent(threadId) +
          "/memories/" +
          encodeURIComponent(agentId),
      );

      // Opening a second persona while this was in flight must win.
      if (state.drawerAgentId !== agentId) return;

      var files = (data.memories && data.memories.files) || [];
      var opinions = files.filter(function (f) {
        return (
          f &&
          String(f.path || "").indexOf("opinions/") === 0 &&
          String(f.content || "").trim() !== ""
        );
      });

      var html;
      if (opinions.length) {
        html = opinions
          .map(function (f) {
            return (
              '<div class="opinion"><span class="opinion-path">' +
              esc(f.path) +
              "</span>" +
              esc(f.content) +
              "</div>"
            );
          })
          .join("");
      } else {
        html = '<p class="opinion">No written opinions yet.</p>';
      }

      setDrawerOpinions(html);
    } catch (_e) {
      if (state.drawerAgentId !== agentId) return;
      setDrawerOpinions('<p class="opinion">Could not load memories.</p>');
    }
  }

  function section(title, text) {
    if (!text) return "";
    return (
      '<div class="drawer-section"><h3>' +
      esc(title) +
      "</h3><p>" +
      esc(text) +
      "</p></div>"
    );
  }

  // List-shaped sections (key works, signature quotes) render as bullets and
  // disappear entirely when the API didn't include the field.
  function sectionList(title, items) {
    if (!Array.isArray(items) || !items.length) return "";
    return (
      '<div class="drawer-section"><h3>' +
      esc(title) +
      '</h3><ul class="drawer-list">' +
      items
        .map(function (item) {
          return "<li>" + esc(item) + "</li>";
        })
        .join("") +
      "</ul></div>"
    );
  }

  function setDrawerOpinions(html) {
    var sections = els.drawerBody.querySelectorAll(".drawer-section");
    var last = sections[sections.length - 1];
    if (last) last.innerHTML = "<h3>What they think</h3>" + html;
  }

  function closeDrawer() {
    state.drawerAgentId = null;
    els.personaDrawer.classList.add("hidden");
    els.drawerBackdrop.classList.add("hidden");
  }

  function drawerIsOpen() {
    return !els.personaDrawer.classList.contains("hidden");
  }

  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerBackdrop.addEventListener("click", closeDrawer);

  // -- new thread modal --

  function renderRosterList() {
    els.rosterList.innerHTML = state.roster
      .map(function (c) {
        return (
          '<label class="roster-item" data-roster-id="' +
          esc(c.id) +
          '">' +
          '<input type="checkbox" value="' +
          esc(c.id) +
          '">' +
          '<span class="avatar" style="background:' +
          safeColor(c.color) +
          "33;border:1px solid " +
          safeColor(c.color) +
          '">' +
          esc(c.emoji) +
          "</span>" +
          '<span class="roster-item-name">' +
          esc(c.name) +
          "</span>" +
          "</label>"
        );
      })
      .join("");
  }

  function selectedRosterIds() {
    return Array.prototype.map.call(
      els.rosterList.querySelectorAll("input:checked"),
      function (input) {
        return input.value;
      },
    );
  }

  function syncRosterHint() {
    var count = selectedRosterIds().length;
    var hint = $("roster-count");
    if (hint) {
      hint.textContent =
        count === 0
          ? "(pick 1–" + MAX_MEMBERS + ")"
          : "(" + count + " of " + MAX_MEMBERS + " picked)";
    }
  }

  els.rosterList.addEventListener("change", function (ev) {
    var item = ev.target.closest(".roster-item");
    if (!item) return;

    // Hard-stop at the member ceiling instead of letting the server reject it.
    if (ev.target.checked && selectedRosterIds().length > MAX_MEMBERS) {
      ev.target.checked = false;
      toast(
        "Up to " + MAX_MEMBERS + " philosophers per conversation.",
        "error",
      );
      return;
    }

    item.classList.toggle("selected", ev.target.checked);
    syncRosterHint();
  });

  function openModal() {
    els.newThreadError.classList.add("hidden");
    els.newThreadForm.reset();
    els.rosterList.querySelectorAll(".roster-item").forEach(function (el) {
      el.classList.remove("selected");
    });
    syncRosterHint();
    els.modalBackdrop.classList.remove("hidden");
    els.newThreadName.focus();
  }

  function closeModal() {
    els.modalBackdrop.classList.add("hidden");
  }

  function modalIsOpen() {
    return !els.modalBackdrop.classList.contains("hidden");
  }

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    if (drawerIsOpen()) closeDrawer();
    else if (modalIsOpen()) closeModal();
  });

  els.newThreadBtn.addEventListener("click", openModal);
  els.modalClose.addEventListener("click", closeModal);
  els.modalBackdrop.addEventListener("click", function (ev) {
    if (ev.target === els.modalBackdrop) closeModal();
  });

  els.newThreadForm.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    els.newThreadError.classList.add("hidden");

    var name = els.newThreadName.value.trim();
    var memberIds = selectedRosterIds();

    if (!name) return showModalError("Give the conversation a name.");
    if (!memberIds.length) {
      return showModalError("Pick at least one philosopher.");
    }
    if (memberIds.length > MAX_MEMBERS) {
      return showModalError("Pick at most " + MAX_MEMBERS + " philosophers.");
    }

    var submitBtn = els.newThreadForm.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      var data = await api("/api/chat/threads", {
        method: "POST",
        body: {
          name: name,
          member_ids: memberIds,
          pace: els.newThreadPace.value,
        },
      });

      closeModal();
      await refreshThreads();
      renderThreadList();
      openThread(data.thread_id);
    } catch (e) {
      showModalError(e.message);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function showModalError(message) {
    els.newThreadError.textContent = message;
    els.newThreadError.classList.remove("hidden");
  }

  // -- start --

  boot();
})();
