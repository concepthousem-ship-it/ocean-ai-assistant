# Ocean build plan (summary)

The full plan lives in the Claude doc "Personal AI Assistant Build Plan". This file tracks progress in the code.

## Decisions

- Name: Ocean
- Laptop: Windows, GTX 1650 (4 GB). Local brain is limited to small models.
- Setup: hybrid. Cloud brain over a free OpenAI-compatible API, local brain via Ollama.
- Ways in: installable Windows app, browser, and phone (installable web app on Android). Address: https://ocean.digivireo.com (the old railway.app address was flagged by Google Safe Browsing).
- Browser control: Ocean Chrome extension, built from the start.
- Hosting: Railway. Code: private GitHub repository.
- Heavy coding: handed to the official Claude Code app on the laptop, signed in with the Max plan (no API billing).

## Cloud brain providers (set up 2026-11-19)

Tried in this order. Chats are private by default and never go to a provider that is not client-safe.

| Order | Provider | Model | Free limits | Client-safe | Notes |
|---|---|---|---|---|---|
| 1 | Groq | openai/gpt-oss-120b | 30 per minute, 1,000 per day, 200K tokens per day | Yes | Main brain |
| 2 | OpenRouter | baidu/ernie-5.5-flash-preview:free | 50 free requests per day | Yes | Training on free endpoints switched off |
| 3 | Cloudflare Workers AI | @cf/meta/llama-3.3-70b-instruct-fp8-fast | 10,000 units per day | Yes | Cloudflare does not train on Workers AI content |
| 4 | NVIDIA NIM | nvidia/nemotron-3-ultra-550b-a55b | About 40 per minute (community figure) | No | Terms forbid confidential or personal data; only non-private chats |

Not used: Cerebras (needs a payment method), GitHub Models (retired July 2026), Google AI Studio (may train on prompts outside the EU), Mistral free tier (requires training opt-in).

## Phases

| Phase | Work | Status |
|---|---|---|
| 1 | Foundations: accounts, Python, Ollama, API key | In progress (GitHub, Railway, Groq, OpenRouter, Cloudflare, NVIDIA done; Ollama on laptop next) |
| 2 | Basic assistant: core server, brain switch, interface, database, deploy | Done: chat screen, saved conversations, usage tracker, Postgres on Railway |
| 3 | Web search and agents | Done: agent loop, web search (Tavily, Exa), page reading, pictures (Cloudflare FLUX.1 schnell), proper login |
| 4 | Voice, uploads and new interface | Done: speech to text (Groq Whisper), file uploads (PDF, Word, Excel, CSV, text), chat search, copy/retry/edit, light interface with logo B, South African personality and research formatting |
| 5 | Desktop and browser control (Windows app, Chrome extension) | Built: Chrome extension (side panel, read page, fill forms, click and type with approval) and Windows app (Electron: window, tray, Ctrl+Shift+O, allowed folders, read and save files with approval, open apps and links, Claude Code handoff, laptop brain via Ollama) |
| 6 | Installer and phone app | Done: Windows installer (per-user, Start menu and desktop shortcuts, Ocean icon, uninstaller, start-with-Windows option) built with NSIS; phone app as an installable web app (manifest, icons, service worker) |
| 7 | Automatic updates for the Windows app | Done: updater checks updates.digivireo.com (cPanel subdomain), downloads in parts, verifies SHA-512, installs on restart or quit |
| 8 | Polish and portfolio write-up | Done: README with architecture and screenshots, 1-minute demo video, public copy at github.com/concepthousem-ship-it/ocean-ai-assistant, case study page |
| 9 | Voice mode and a stronger personality | Built: hands-free voice mode (Whisper in, Deepgram Aura on Cloudflare out, device voice as backup), spoken-style replies, witty and cheeky South African personality, no em or en dashes in replies |
| 10 | Client memory | Built: client profiles, project notes and facts about Gudani; saved straight away when he says "remember", otherwise a Save or Skip card; Memory panel to add, edit and delete; client notes only used in private chats; passwords, keys, card and ID numbers refused |
| 11 | Gmail and Google Calendar | Built: Sign in with Google (read email, save drafts, calendar events); search and read email, drafts land in Gmail Drafts and are never sent, calendar listing, suggested events added only when Gudani taps Add; private chats only; refresh token encrypted. Needs the Google Cloud OAuth client set in Railway |
