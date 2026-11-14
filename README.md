# Todoist Jotter

Open the app and it starts recording. Tap when you're done. Your note is transcribed, split into
one or more tasks, each task gets a priority, a due date (if you mentioned timing) and the best-matching
Todoist project, and the tasks are created. An Undo button removes the batch if it got something wrong.
You can also type a note instead of speaking.

It's a small web app (installable to your phone's home screen) with a tiny Node server that holds your keys.
No dependencies to install.

## 1. Get your keys (you fill these in yourself, never paste them in chat)

| Variable | Where to get it |
|---|---|
| `TODOIST_API_TOKEN` | Todoist > Settings > Integrations > Developer > API token |
| `LLM_API_KEY` | Free Groq key: https://console.groq.com/keys (covers transcription and the AI step) |
| `APP_PASSCODE` | Make one up. The app asks for it once per device. |

## 2. Run it locally (to try it on your computer)

```bash
cp .env.example .env     # then edit .env and fill in the three values above
node server.js           # needs Node 18+
```

Open http://localhost:3000. Browsers allow the microphone on localhost; on a phone you need HTTPS, so deploy it.

## 3. Deploy (so it works on your phone)

Any host that runs Node works. Easiest free option is **Render**:

1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > pick the repo. Build command: *(empty)*. Start command: `node server.js`.
3. Under Environment, add `TODOIST_API_TOKEN`, `LLM_API_KEY`, `APP_PASSCODE`.
4. Open the `https://…onrender.com` URL on your phone, enter the passcode, then
   **Add to Home Screen** (Safari share menu on iPhone, ⋮ menu in Chrome on Android).

Note: Render's free tier sleeps after ~15 min idle, so the first open after a break can take ~30-50 s.
A paid tier, Railway, Fly.io, or a home machine behind Tailscale avoids that.

## 4. Switching the AI model

The AI step talks to any OpenAI-compatible API, so switching is just three env vars:

```
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4   # Zhipu GLM
LLM_MODEL=glm-4.5-flash
LLM_API_KEY=<your Zhipu key>
```

See `.env.example` for Kimi (Moonshot), OpenRouter free models and local Ollama. Model names change
often, so check the provider's model list. GLM and Kimi don't offer speech-to-text, so when you switch,
uncomment the `STT_` lines and keep transcription on your Groq key.
If a provider rejects JSON mode, set `LLM_JSON_MODE=false`.

## How it decides

- **Projects**: fetched live from Todoist (cached 5 min), sub-projects shown as `Parent / Child`.
  If nothing fits, the task goes to your Inbox. Naming projects clearly helps.
- **Priority**: p1 only for urgent/critical wording, otherwise p4 unless urgency is implied.
- **Due date**: a natural phrase like "tomorrow 5pm" or "every friday", parsed by Todoist in your timezone.
  If Todoist can't parse it, the task is still created with the phrase in its description.

The prompt lives in `buildPrompt()` in `server.js` if you want to tune it.

## Test

`node test.js` runs the full flow against mocked Todoist and AI services.
