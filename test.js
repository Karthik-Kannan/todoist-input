// End-to-end test with mocked Todoist + AI provider. Run: node test.js
'use strict';
const http = require('http');
const assert = require('assert');

const created = [], deleted = [];
let llmRequest, noId = false;
const mock = http.createServer((req, res) => {
  let body = []; req.on('data', (c) => body.push(c)); req.on('end', () => {
    body = Buffer.concat(body);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith('/todoist/projects')) {
      if (!req.url.includes('cursor')) return json(200, { results: [{ id: 'inbox1', name: 'Inbox', inbox_project: true }, { id: 'work1', name: 'Work' }], next_cursor: 'c2' });
      return json(200, { results: [{ id: 'home1', name: 'Home' }, { id: 'old', name: 'Old', is_archived: true }], next_cursor: null });
    }
    if (req.url === '/todoist/tasks' && req.method === 'POST') {
      const t = JSON.parse(body); if (t.due_string === 'gibberish') return json(400, { error: 'bad due' });
      if (noId) return json(200, { results: [] });
      created.push(t); return json(200, { id: 't' + created.length, ...t, due: t.due_string ? { string: t.due_string } : null });
    }
    if (req.url.startsWith('/todoist/tasks/') && req.method === 'DELETE') { deleted.push(req.url.split('/').pop()); res.writeHead(204); return res.end(); }
    if (req.url === '/ai/audio/transcriptions') {
      assert(body.includes('whisper-large-v3-turbo') && body.includes('note.webm'));
      return json(200, { text: 'Email Sarah the Q3 deck by Friday, it is urgent. Also buy milk tomorrow and fix the leaky tap.' });
    }
    if (req.url === '/ai/chat/completions') {
      llmRequest = JSON.parse(body);
      const content = '```json\n' + JSON.stringify({ tasks: [
        { content: 'Email Sarah the Q3 deck', description: '', project_id: 'work1', priority: 'p1', due_string: 'friday' },
        { content: 'Buy milk', project_id: 'home1', priority: 'none', due_string: 'tomorrow' },
        { content: 'Fix the leaky tap', project_id: 'nonexistent', priority: 'p3', due_string: 'gibberish' },
      ] }) + '\n```';
      return json(200, { choices: [{ message: { content } }] });
    }
    json(404, { error: req.url });
  });
});

mock.listen(0, async () => {
  const base = `http://localhost:${mock.address().port}`;
  Object.assign(process.env, { TODOIST_API_TOKEN: 'x', TODOIST_API_URL: base + '/todoist', LLM_BASE_URL: base + '/ai', LLM_API_KEY: 'k', APP_PASSCODE: 'secret' });
  const { server } = require('./server');
  server.listen(0, async () => {
    const app = `http://localhost:${server.address().port}`;
    try {
      assert.strictEqual((await fetch(app + '/api/jot', { method: 'POST' })).status, 401, 'passcode enforced');
      assert.strictEqual((await fetch(app + '/')).status, 200, 'serves the app');

      const r = await fetch(app + '/api/jot', { method: 'POST', headers: { 'X-Passcode': 'secret', 'Content-Type': 'audio/webm', 'X-Timezone': 'Asia/Kolkata' }, body: Buffer.from('fakeaudio') });
      const data = await r.json();
      assert.strictEqual(r.status, 200, JSON.stringify(data));
      assert.strictEqual(data.tasks.length, 3);
      assert(llmRequest.messages[0].content.includes('id=home1 | Home'), 'projects from page 2 sent to LLM');
      assert(!llmRequest.messages[0].content.includes('Old'), 'archived projects excluded');
      assert(llmRequest.messages[0].content.includes('Asia/Kolkata'));
      assert.deepStrictEqual(created[0], { content: 'Email Sarah the Q3 deck', project_id: 'work1', priority: 4, due_string: 'friday', due_lang: 'en' });
      assert.strictEqual(created[1].priority, 1);
      assert.strictEqual(created[2].project_id, 'inbox1', 'unknown project falls back to Inbox');
      assert.strictEqual(created[2].priority, 2);
      assert(created[2].description.includes('Due: gibberish'), 'unparseable due date kept in description');
      assert.deepStrictEqual(data.tasks.map((t) => t.project), ['Work', 'Home', 'Inbox']);

      const t = await fetch(app + '/api/jot', { method: 'POST', headers: { 'X-Passcode': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'call mom' }) });
      assert.strictEqual(t.status, 200, 'typed notes work');

      const u = await fetch(app + '/api/undo', { method: 'POST', headers: { 'X-Passcode': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['t1', 't2'] }) });
      assert.strictEqual(u.status, 200); assert.deepStrictEqual(deleted, ['t1', 't2']);
      assert(data.tasks[0].url.endsWith('/task/t1'), 'task link returned');

      // A 200 without a task id (e.g. a redirected request) must be reported as a failure, not success.
      noId = true;
      const bad = await fetch(app + '/api/jot', { method: 'POST', headers: { 'X-Passcode': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
      assert.strictEqual(bad.status, 500, 'missing task id is an error');
      console.log('All tests passed');
    } catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
    server.close(); mock.close();
  });
});
