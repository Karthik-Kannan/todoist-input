// Todoist quick jotter: record a voice note, turn it into Todoist tasks.
// Zero dependencies. Needs Node 18+ (built-in fetch, FormData, Blob).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const cfg = {
  port: Number(process.env.PORT || 3000),
  passcode: process.env.APP_PASSCODE || '',
  todoistToken: process.env.TODOIST_API_TOKEN || '',
  todoistBase: (process.env.TODOIST_API_URL || 'https://api.todoist.com/api/v1').replace(/\/$/, ''),
  // Any OpenAI-compatible chat endpoint (Groq, OpenRouter, Zhipu GLM, Moonshot Kimi, Ollama...)
  llmBase: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  llmKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
  llmJsonMode: (process.env.LLM_JSON_MODE || 'true') !== 'false',
  // Any OpenAI-compatible /audio/transcriptions endpoint (Groq Whisper by default)
  sttBase: (process.env.STT_BASE_URL || process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  sttKey: process.env.STT_API_KEY || process.env.LLM_API_KEY || '',
  sttModel: process.env.STT_MODEL || 'whisper-large-v3-turbo',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.css': 'text/css', '.png': 'image/png' };

// ---------- Todoist ----------
let projectCache = { at: 0, list: [] };

async function todoist(method, p, body) {
  const res = await fetch(cfg.todoistBase + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.todoistToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Todoist ${method} ${p} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function getProjects() {
  if (Date.now() - projectCache.at < 5 * 60 * 1000 && projectCache.list.length) return projectCache.list;
  const list = [];
  let cursor = null;
  do {
    const data = await todoist('GET', '/projects' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
    const page = Array.isArray(data) ? data : data.results || [];
    list.push(...page);
    cursor = Array.isArray(data) ? null : data.next_cursor;
  } while (cursor);
  const parents = Object.fromEntries(list.map((p) => [p.id, p.name]));
  projectCache = {
    at: Date.now(),
    list: list
      .filter((p) => !p.is_archived && !p.is_deleted)
      .map((p) => ({
        id: p.id,
        name: p.parent_id && parents[p.parent_id] ? `${parents[p.parent_id]} / ${p.name}` : p.name,
        inbox: !!(p.inbox_project || p.is_inbox_project),
      })),
  };
  return projectCache.list;
}

// ---------- Speech to text ----------
async function transcribe(buf, mime) {
  const ext = mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') ? 'm4a'
    : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `note.${ext}`);
  form.append('model', cfg.sttModel);
  form.append('response_format', 'json');
  const res = await fetch(cfg.sttBase + '/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.sttKey}` }, body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
  return ((await res.json()).text || '').trim();
}

// ---------- LLM: note -> tasks ----------
function buildPrompt(projects, nowLocal, tz) {
  const plist = projects.map((p) => `- id=${p.id} | ${p.name}${p.inbox ? ' (Inbox, use when nothing fits)' : ''}`).join('\n');
  return `You turn a spoken voice note into Todoist tasks.

Current local date/time: ${nowLocal} (timezone: ${tz}).

The user's Todoist projects:
${plist}

Rules:
- Split the note into separate, actionable tasks. One task per distinct action. Don't invent tasks that weren't said.
- "content": short imperative title (max ~12 words). Put any extra detail from the note in "description" (or "").
- "project_id": the id of the best-matching project from the list above. If nothing clearly fits, use the Inbox id.
- "priority": 1 = urgent/critical, 2 = high, 3 = medium, 4 = normal (default 4 unless urgency is implied).
- "due_string": a short English due phrase Todoist understands, e.g. "today", "tomorrow 5pm", "next monday", "every friday", "Dec 3". Use "" if no timing is stated or implied. "ASAP"/"urgent" means "today".
Reply with JSON only, no prose, exactly in this shape:
{"tasks":[{"content":"...","description":"...","project_id":"...","priority":4,"due_string":"..."}]}`;
}

async function extractTasks(note, projects, nowLocal, tz) {
  const body = {
    model: cfg.llmModel,
    temperature: 0.1,
    messages: [
      { role: 'system', content: buildPrompt(projects, nowLocal, tz) },
      { role: 'user', content: note },
    ],
  };
  if (cfg.llmJsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(cfg.llmBase + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.llmKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM failed: ${res.status} ${await res.text()}`);
  const text = (await res.json()).choices?.[0]?.message?.content || '';
  const json = parseJsonLoose(text);
  const tasks = Array.isArray(json) ? json : json?.tasks;
  if (!Array.isArray(tasks)) throw new Error('LLM did not return a task list: ' + text.slice(0, 300));

  const inbox = projects.find((p) => p.inbox) || projects[0];
  const ids = new Set(projects.map((p) => String(p.id)));
  return tasks
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .map((t) => {
      const p = Math.min(4, Math.max(1, parseInt(t.priority, 10) || 4));
      return {
        content: t.content.trim(),
        description: typeof t.description === 'string' ? t.description.trim() : '',
        project_id: ids.has(String(t.project_id)) ? String(t.project_id) : inbox && String(inbox.id),
        userPriority: p, // 1 = urgent (shown as p1 in Todoist)
        due_string: typeof t.due_string === 'string' ? t.due_string.trim() : '',
      };
    });
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(cleaned.slice(s, e + 1)); } catch {} }
  return null;
}

async function createTasks(tasks, projects) {
  const names = Object.fromEntries(projects.map((p) => [String(p.id), p.name]));
  const out = [];
  for (const t of tasks) {
    const payload = { content: t.content, project_id: t.project_id, priority: 5 - t.userPriority };
    if (t.description) payload.description = t.description;
    if (t.due_string) { payload.due_string = t.due_string; payload.due_lang = 'en'; }
    let created;
    try {
      created = await todoist('POST', '/tasks', payload);
    } catch (err) {
      if (!payload.due_string) throw err;
      // Todoist couldn't parse the due phrase; keep the task, put the phrase in the description.
      delete payload.due_string; delete payload.due_lang;
      payload.description = [payload.description, `Due: ${t.due_string}`].filter(Boolean).join('\n');
      created = await todoist('POST', '/tasks', payload);
    }
    out.push({
      id: created?.id,
      content: t.content,
      project: names[t.project_id] || 'Inbox',
      priority: `p${t.userPriority}`,
      due: created?.due?.string || created?.due?.date || t.due_string || '',
    });
  }
  return out;
}

// ---------- HTTP ----------
// 4.5 MB matches Vercel's request body limit.
function readBody(req, limit = 4.5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Recording too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleJot(req, res) {
  const type = (req.headers['content-type'] || '').toLowerCase();
  const tz = String(req.headers['x-timezone'] || process.env.TZ || 'UTC');
  const nowLocal = String(req.headers['x-local-time'] || new Date().toString());
  const body = await readBody(req);

  let note;
  if (type.startsWith('application/json')) {
    note = String(JSON.parse(body.toString('utf8') || '{}').text || '').trim();
  } else {
    if (!body.length) return send(res, 400, { error: 'No audio received' });
    note = await transcribe(body, type || 'audio/webm');
  }
  if (!note) return send(res, 422, { error: "Couldn't hear anything in that note." });

  const projects = await getProjects();
  const tasks = await extractTasks(note, projects, nowLocal, tz);
  if (!tasks.length) return send(res, 422, { error: 'No tasks found in the note.', transcript: note });
  const created = await createTasks(tasks, projects);
  send(res, 200, { transcript: note, tasks: created });
}

// API router. Used by the local server below and by the Vercel functions in api/.
async function handleApi(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    if (cfg.passcode && req.headers['x-passcode'] !== cfg.passcode) return send(res, 401, { error: 'Wrong passcode' });
    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/jot') return await handleJot(req, res);
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const { ids = [] } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      for (const id of ids) await todoist('DELETE', `/tasks/${encodeURIComponent(id)}`);
      return send(res, 200, { deleted: ids.length });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  // static files
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (require.main === module) {
  const missing = ['TODOIST_API_TOKEN', 'LLM_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) console.warn('Missing env vars:', missing.join(', '), '(see .env.example)');
  if (!cfg.passcode) console.warn('APP_PASSCODE is not set: anyone with the URL can add tasks to your Todoist.');
  server.listen(cfg.port, () => console.log(`Jotter running on http://localhost:${cfg.port}  (LLM: ${cfg.llmModel} @ ${cfg.llmBase})`));
}

module.exports = { server, handleApi, parseJsonLoose };
