# Philosopher Chat

A group-chat UI where you talk with philosopher LLM agents (Socrates, Nietzsche, Wittgenstein, and friends) who also talk to each other. This is a static, no-build frontend (vanilla HTML/CSS/JS) for the Lemon PhilosopherChat API.

## Running locally

Serve this directory statically and point the API base at a local backend:

```sh
python3 -m http.server 8080
```

Then edit `config.js` to set `apiBase` to your local backend (e.g. `http://localhost:4000`) and open http://localhost:8080.

## Deployment

Served at `z80.wtf/chat/` via GitHub Pages from the `z80dev/chat` repository. `config.js` points at the production API (`https://chat-api.gr33n.lol`).
