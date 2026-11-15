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

## 3. Deploy to Vercel (so it works on your phone)

1. On vercel.com: **Add New > Project**, import `todoist-input` from GitHub.
2. Leave Framework Preset as **Other** and the build settings as they are (`vercel.json` handles them).
3. Under **Environment Variables**, add `TODOIST_API_TOKEN`, `LLM_API_KEY` and `APP_PASSCODE`
   (plus any other values from `.env.example` you changed). Click **Deploy**.
4. Open the `https://….vercel.app` URL on your phone, enter the passcode, then
   **Add to Home Screen** (Safari share menu on iPhone, ⋮ menu in Chrome on Android).

After that, every push to `main` redeploys automatically. If you change an environment variable, redeploy
from the Vercel dashboard (Deployments > ⋯ > Redeploy) for it to take effect.

How it maps onto Vercel: `public/` is served as static files and `api/*.js` become serverless functions
that reuse the code in `server.js`. Vercel caps uploads at 4.5 MB, so the app records at a low bitrate,
which allows roughly 15 minutes per note.

Any other Node host works too (Render, Railway, Fly.io): start command `node server.js`.

### Launching it fast on Android (Pixel)

- Install it from Chrome's ⋮ menu > **Install app** (not just "Add to Home screen"), so it becomes a real app.
- **Voice:** "Hey Google, open Jotter".
- **Volume button:** a button-remapping app such as Button Mapper can map a long-press of volume down to "Open app > Jotter".
- **Long-press the icon** for "Record" and "Type" shortcuts, which can be dragged onto the home screen.
- Opening it, or switching back to it, always starts a fresh recording.

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
- **Priority**: none by default. p1/p2/p3 only when the note explicitly says how urgent or important it is.
- **Due date**: a natural phrase like "tomorrow 5pm" or "every friday", parsed by Todoist in your timezone.
  If Todoist can't parse it, the task is still created with the phrase in its description.

The prompt lives in `buildPrompt()` in `server.js` if you want to tune it.

## Test

`node test.js` runs the full flow against mocked Todoist and AI services.
