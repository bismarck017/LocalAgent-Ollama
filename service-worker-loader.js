// Local-Agent Ollama — background service worker
// (loaded as module for Chrome compatibility with cached registration)

let OLLAMA = 'http://127.0.0.1:11434';
const pendingAgentDecisions = {};

async function getOllamaHost() {
  const { ollamaHost } = await chrome.storage.local.get('ollamaHost');
  if (ollamaHost) {
    OLLAMA = ollamaHost.replace(/\/+$/, '');
    return OLLAMA;
  }
  for (const base of ['http://localhost:11434', 'http://127.0.0.1:11434']) {
    try {
      const r = await fetch(`${base}/api/tags`);
      if (r.ok) { OLLAMA = base; return base; }
    } catch {}
  }
  return OLLAMA;
}

async function findOllama() {
  return getOllamaHost();
}

// ── Ollama helpers ────────────────────────────────────────────────────────

async function ollamaModels() {
  const base = await getOllamaHost();
  const r = await fetch(`${base}/api/tags`);
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const d = await r.json();
  return d.models || [];
}

async function ollamaPing() {
  try {
    const base = await getOllamaHost();
    const r = await fetch(`${base}/api/tags`);
    return r.ok;
  } catch {
    return false;
  }
}

function ollamaError(status) {
  if (status === 403) return `Ollama blocked the request (403).\n\nFix: quit Ollama, then run it with:\n\n  OLLAMA_ORIGINS="*" ollama serve\n\nOr set it permanently in terminal and restart Ollama.`;
  return `Ollama returned ${status}`;
}

/** Streaming chat with Ollama */
async function ollamaChat(model, messages, onChunk) {
  const base = await getOllamaHost();
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true })
  });
  if (!r.ok) throw new Error(ollamaError(r.status));

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const token = d.message?.content || '';
        if (token) { full += token; onChunk?.(token); }
        if (d.done) return full;
      } catch {}
    }
  }
  return full;
}

// ── OpenRouter helpers ────────────────────────────────────────────────────

async function openrouterChat(model, messages, onChunk, apiKey) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://localagent-ollama',
      'X-Title': 'LocalAgent Ollama'
    },
    body: JSON.stringify({ model, messages, stream: true })
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenRouter returned ${r.status}`);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = dec.decode(value).split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') return full;
      try {
        const d = JSON.parse(dataStr);
        const token = d.choices?.[0]?.delta?.content || '';
        if (token) {
          full += token;
          onChunk?.(token);
        }
      } catch {}
    }
  }
  return full;
}

// ── Tab helpers ───────────────────────────────────────────────────────────

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, favIconUrl: t.favIconUrl || '' }));
}

async function extractTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return '[Tab not found]'; }

  const url = tab.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:') || url.startsWith('data:'))
    return '[Cannot access this page]';

  // Try content script first
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'extractContent' });
    if (res?.success && res.data?.content?.length > 200)
      return `Title: ${res.data.title}\nURL: ${res.data.url}\n\n${res.data.content}`;
  } catch {}

  // Fallback: inject extraction script
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selectors = ['article','main','[role="main"]','.article-body','.article-content','.post-content','#article-body','#main-content','#content'];
        let el = null;
        for (const s of selectors) { el = document.querySelector(s); if (el) break; }
        if (!el) el = document.body;
        let content = (el.innerText || el.textContent || '')
          .replace(/\t/g,' ').replace(/ {2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
        if (content.length > 10000) content = content.slice(0, 10000) + '\n[…truncated]';
        return { title: document.title, url: location.href, content };
      }
    });
    const data = results?.[0]?.result;
    if (data?.content?.length > 200)
      return `Title: ${data.title}\nURL: ${data.url}\n\n${data.content}`;
  } catch {}

  return '[Could not extract page content]';
}

// ── Model Aggregator ──────────────────────────────────────────────────────

async function getAllAvailableModels() {
  const models = [];

  // 1. Ollama models
  try {
    const oModels = await ollamaModels();
    oModels.forEach(m => {
      models.push({
        name: m.name,
        provider: 'ollama',
        size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)}GB` : ''
      });
    });
  } catch {}

  // 2. OpenRouter models
  try {
    const { openrouterEnabled, openrouterApiKey, openrouterModel, openrouterModels } = await chrome.storage.local.get([
      'openrouterEnabled',
      'openrouterApiKey',
      'openrouterModel',
      'openrouterModels'
    ]);

    if (openrouterEnabled && openrouterApiKey) {
      const orList = Array.isArray(openrouterModels) && openrouterModels.length
        ? [...openrouterModels]
        : [];

      if (openrouterModel && !orList.includes(openrouterModel)) {
        orList.unshift(openrouterModel);
      }

      // Default presets if user has not added any custom models yet
      if (!orList.length) {
        orList.push(
          'anthropic/claude-3.5-sonnet',
          'openai/gpt-4o',
          'google/gemini-2.0-flash-exp:free'
        );
      }

      orList.forEach(name => {
        if (!models.some(m => m.name === name && m.provider === 'openrouter')) {
          models.push({ name, provider: 'openrouter', size: 'Cloud' });
        }
      });
    }
  } catch {}

  return models;
}

// ── Message routing ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((req, _sender, respond) => {

  if (req.action === 'getModels') {
    getAllAvailableModels()
      .then(models => respond({ success: true, models }))
      .catch(e => respond({ success: false, error: e.message, models: [] }));
    return true;
  }

  if (req.action === 'checkConnection') {
    ollamaPing()
      .then(connected => respond({ connected }))
      .catch(() => respond({ connected: false }));
    return true;
  }

  if (req.action === 'getTabs') {
    getAllTabs()
      .then(tabs => respond({ success: true, tabs }))
      .catch(() => respond({ success: false, tabs: [] }));
    return true;
  }

  if (req.action === 'queryStream') {
    handleStreamQuery(req.data).catch(console.error);
    respond({ success: true });
    return true;
  }

  if (req.action === 'agentTask') {
    handleAgentTask(req.data).catch(console.error);
    respond({ success: true });
    return true;
  }

  if (req.action === 'agentDecision') {
    const resolver = pendingAgentDecisions[req.messageId];
    if (resolver) {
      resolver(req);
      delete pendingAgentDecisions[req.messageId];
    }
    respond({ success: true });
    return true;
  }
});

// ── Streaming chat handler ────────────────────────────────────────────────

async function handleStreamQuery(data) {
  const { query, model, mentionedTabs = [], history = [], messageId } = data;

  const send = (action, extra) =>
    chrome.runtime.sendMessage({ action, messageId, ...extra }).catch(() => {});

  try {
    let system = 'You are a helpful assistant.';
    let userContent = query;

    if (mentionedTabs.length) {
      const pages = await Promise.all(mentionedTabs.map(t => extractTab(t.id)));
      const ctx = pages.map((p, i) => `=== ${mentionedTabs[i].title} ===\n${p}`).join('\n\n---\n\n');
      system = 'You are a helpful assistant. Use only the page content provided to answer. Do not invent information not found in the content.';
      userContent = `${ctx}\n\n---\nQuestion: ${query}`;
    }

    const messages = [{ role: 'system', content: system }];
    for (const h of history) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
    }
    messages.push({ role: 'user', content: userContent });

    const { openrouterEnabled, openrouterApiKey } = await chrome.storage.local.get([
      'openrouterEnabled',
      'openrouterApiKey'
    ]);

    const isOpenRouter = (model && model.includes('/')) || (openrouterEnabled && !model.includes(':'));

    if (isOpenRouter && openrouterApiKey) {
      let full = '';
      await openrouterChat(model, messages, token => {
        full += token;
        send('streamChunk', { chunk: token, fullText: full });
      }, openrouterApiKey);
      send('streamComplete', { text: full });
    } else {
      let full = '';
      await ollamaChat(model, messages, token => {
        full += token;
        send('streamChunk', { chunk: token, fullText: full });
      });
      send('streamComplete', { text: full });
    }
  } catch (e) {
    send('streamError', { error: e.message });
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseAction(text) {
  const s = text.replace(/```[\s\S]*?```/g, '').trim();

  let m;
  m = s.match(/^CLICK(?:\s+on)?\s+(ref_\d+)/im);
  if (m) return { name: 'click', args: { refId: m[1] } };

  m = s.match(/^TYPE\s+(ref_\d+)\s+([\s\S]+)/im);
  if (m) return { name: 'type', args: { refId: m[1], text: m[2].trim() } };

  m = s.match(/^SCROLL\s+(down|up)/im);
  if (m) return { name: 'scroll', args: { direction: m[1].toLowerCase() } };

  m = s.match(/^KEY\s+(\S+)/im);
  if (m) return { name: 'key', args: { key: m[1] } };

  m = s.match(/^NAVIGATE\s+(https?:\/\/\S+)/im);
  if (m) return { name: 'navigate', args: { url: m[1] } };

  m = s.match(/^DONE\s+([\s\S]+)/im);
  if (m) return { name: 'done', args: { result: m[1].trim() } };

  return null;
}

async function getTree(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { action: 'getTree' });
    if (res?.success) return res.tree;
  } catch {}
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab ? `Page: ${tab.title}\nURL: ${tab.url}\n(Could not read elements — try refreshing)` : '(no tab)';
}

async function waitLoad(tabId, ms = 8000) {
  await sleep(400);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') { await sleep(500); return; }
    await sleep(300);
  }
}

const agentTools = [
  { type: 'function', function: { name: 'click',    description: 'Click an element on the page', parameters: { type: 'object', properties: { refId: { type: 'string', description: 'ref ID from page, e.g. ref_3' } }, required: ['refId'] } } },
  { type: 'function', function: { name: 'type',     description: 'Type text into an input or textarea', parameters: { type: 'object', properties: { refId: { type: 'string' }, text: { type: 'string' } }, required: ['refId', 'text'] } } },
  { type: 'function', function: { name: 'key',      description: 'Press a keyboard key (Enter, Tab, Escape, etc.)', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'scroll',   description: 'Scroll up or down', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'navigate', description: 'Navigate to a URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'read',     description: 'Read the visible text content of the page', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'done',     description: 'Task complete — return final answer', parameters: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] } } }
];

async function callAgentLLM(model, messages) {
  const { openrouterEnabled, openrouterApiKey } = await chrome.storage.local.get([
    'openrouterEnabled',
    'openrouterApiKey'
  ]);

  const isOpenRouter = (model && model.includes('/')) || (openrouterEnabled && !model.includes(':'));

  if (isOpenRouter && openrouterApiKey) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openrouterApiKey}`,
        'HTTP-Referer': 'https://localagent-ollama',
        'X-Title': 'LocalAgent Ollama'
      },
      body: JSON.stringify({ model, messages, tools: agentTools, stream: false })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenRouter ${r.status}`);
    }
    const data = await r.json();
    return data.choices?.[0]?.message;
  } else {
    const base = await getOllamaHost();
    const r = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: agentTools, stream: false })
    });
    if (!r.ok) throw new Error(ollamaError(r.status));
    return (await r.json()).message;
  }
}

async function handleAgentTask(data) {
  const { task, model, messageId } = data;

  const storageData = await chrome.storage.local.get(['maxSteps', 'stepIncrement']);
  let maxSteps = Number(storageData.maxSteps) || 20;
  const defaultIncrement = Number(storageData.stepIncrement) || 10;

  const step = (type, content) =>
    chrome.runtime.sendMessage({ action: 'agentStep', messageId, type, content }).catch(() => {});
  const done = text =>
    chrome.runtime.sendMessage({ action: 'agentComplete', messageId, text }).catch(() => {});

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) { done('No active tab found.'); return; }
  const tabId = activeTab.id;

  const tree = await getTree(tabId);
  const snippet = tree.length > 3500 ? tree.slice(0, 3500) + '\n…[truncated]' : tree;

  const messages = [
    { role: 'system', content: `You are a browser automation agent. Use the provided tools to complete tasks step by step. Call done() when you have the final answer.

Rules:
- Ref IDs change after every action. Never reuse an old ref ID.
- Elements marked [editable] or role=textbox are typeable.
- After navigating to read information, call read(), then call done() with the answer.` },
    { role: 'user', content: `TASK: ${task}\n\nCURRENT PAGE:\n${snippet}` }
  ];

  let i = 1;
  while (true) {
    // Check if maxSteps limit reached — ask user rather than auto-terminating!
    if (i > maxSteps) {
      step('thinking', `Reached step limit (${maxSteps} steps).`);
      chrome.runtime.sendMessage({
        action: 'agentMaxStepsReached',
        messageId,
        currentSteps: i - 1,
        maxSteps,
        suggestedIncrement: defaultIncrement
      }).catch(() => {});

      const userChoice = await new Promise(resolve => {
        pendingAgentDecisions[messageId] = resolve;
      });

      if (!userChoice || userChoice.decision !== 'continue') {
        done(`Task ended after ${i - 1} steps.`);
        return;
      }

      const added = Number(userChoice.additionalSteps) || defaultIncrement;
      maxSteps += added;
      step('action', `Authorized +${added} more steps (limit now ${maxSteps}).`);
    }

    step('thinking', `Step ${i} of ${maxSteps}…`);

    let msg;
    try {
      msg = await callAgentLLM(model, messages);
    } catch (e) {
      step('error', `Model error: ${e.message}`);
      done('Agent stopped due to an error.');
      return;
    }

    const toolCalls = msg?.tool_calls;

    if (!toolCalls?.length) {
      const content = msg?.content?.trim() || '';
      const action = parseAction(content);
      if (action?.name === 'done') { done(action.args.result); return; }
      done(content || 'Task complete.');
      return;
    }

    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args = tc.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }

      if (name === 'done') { done(args.result); return; }

      const desc = {
        click:    `Click ${args.refId}`,
        type:     `Type "${String(args.text || '').slice(0, 40)}" into ${args.refId}`,
        key:      `Press ${args.key}`,
        scroll:   `Scroll ${args.direction}`,
        navigate: `Navigate to ${String(args.url || '').slice(0, 50)}`
      }[name] || name;
      step('action', desc);

      let toolResult = '';
      try {
        if (name === 'navigate') {
          await chrome.tabs.update(tabId, { url: args.url });
          await waitLoad(tabId);
          toolResult = 'Navigated.';
        } else if (name === 'read') {
          const text = await extractTab(tabId);
          toolResult = text;
        } else {
          const result = await chrome.tabs.sendMessage(tabId, { action: 'executeTool', tool: name, args });
          if (result?.success === false) {
            step('error', result.error);
            toolResult = `Error: ${result.error}`;
          } else {
            toolResult = 'Action completed.';
            await sleep(1500);
          }
        }
      } catch (e) {
        step('error', `Action failed: ${e.message}`);
        toolResult = `Error: ${e.message}`;
      }

      const newTree = await getTree(tabId);
      const newSnippet = newTree.length > 3000 ? newTree.slice(0, 3000) + '\n…[truncated]' : newTree;
      messages.push({ role: 'tool', content: `${toolResult}\n\nUpdated page:\n${newSnippet}` });
    }

    i++;
  }
}

// ── Open side panel on icon click ────────────────────────────────────────

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});

console.log('[Local-Agent Ollama] background ready');
