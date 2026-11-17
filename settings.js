// Local-Agent Ollama — Settings Controller

const ollamaHostInput      = document.getElementById('ollama-host');
const testOllamaBtn        = document.getElementById('test-ollama-btn');
const ollamaStatusBadge    = document.getElementById('ollama-status-badge');
const openrouterEnabled    = document.getElementById('openrouter-enabled');
const openrouterFields     = document.getElementById('openrouter-fields');
const openrouterKeyInput       = document.getElementById('openrouter-key');
const openrouterModelInput     = document.getElementById('openrouter-model');
const addOpenrouterModelBtn    = document.getElementById('add-openrouter-model-btn');
const addModelStatus           = document.getElementById('add-model-status');
const openrouterModelsContainer = document.getElementById('openrouter-models-container');
const openrouterModelsList     = document.getElementById('openrouter-models-list');
const verifyOpenrouterBtn      = document.getElementById('verify-openrouter-btn');
const toggleKeyBtn         = document.getElementById('toggle-key-btn');
const maxStepsSlider       = document.getElementById('max-steps-slider');
const maxStepsDisplay      = document.getElementById('max-steps-display');
const stepIncrementSelect  = document.getElementById('step-increment');
const exportHistoryBtn     = document.getElementById('export-history-btn');
const clearHistoryBtn      = document.getElementById('clear-history-btn');
const themeBtn             = document.getElementById('theme-btn');
const toastEl              = document.getElementById('toast');
const toastMsg             = document.getElementById('toast-msg');

let toastTimer = null;
let connectedOpenrouterModels = [];

function esc(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMsg.textContent = msg;
  toastEl.style.display = 'block';
  toastTimer = setTimeout(() => {
    toastEl.style.display = 'none';
  }, 2200);
}

function renderOpenrouterModels() {
  if (!connectedOpenrouterModels.length) {
    openrouterModelsContainer.style.display = 'none';
    openrouterModelsList.innerHTML = '';
    return;
  }

  openrouterModelsContainer.style.display = 'flex';
  openrouterModelsList.innerHTML = '';

  connectedOpenrouterModels.forEach(modelName => {
    const chip = document.createElement('div');
    chip.className = 'connected-model-chip';
    chip.innerHTML = `
      <span class="chip-dot"></span>
      <span class="chip-name">${esc(modelName)}</span>
      <button class="chip-remove-btn" type="button" title="Remove model">×</button>
    `;

    chip.querySelector('.chip-remove-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      connectedOpenrouterModels = connectedOpenrouterModels.filter(m => m !== modelName);
      await chrome.storage.local.set({ openrouterModels: connectedOpenrouterModels });
      renderOpenrouterModels();
      showToast(`Removed ${modelName}`);
    });

    openrouterModelsList.appendChild(chip);
  });
}

// ── Storage Helpers ───────────────────────────────────────────────────────

async function saveSettings() {
  const activeProvider = document.querySelector('input[name="activeProvider"]:checked')?.value || 'ollama';
  const ollamaHost = ollamaHostInput.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  const openrouterKey = openrouterKeyInput.value.trim();
  const openrouterModel = openrouterModelInput.value.trim() || 'anthropic/claude-3.5-sonnet';
  const isOREnabled = openrouterEnabled.checked;
  const maxSteps = parseInt(maxStepsSlider.value, 10) || 20;
  const stepIncrement = parseInt(stepIncrementSelect.value, 10) || 10;

  await chrome.storage.local.set({
    activeProvider,
    ollamaHost,
    openrouterApiKey: openrouterKey,
    openrouterModel,
    openrouterModels: connectedOpenrouterModels,
    openrouterEnabled: isOREnabled,
    maxSteps,
    stepIncrement
  });

  showToast('Settings saved');
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'activeProvider',
    'ollamaHost',
    'openrouterApiKey',
    'openrouterModel',
    'openrouterModels',
    'openrouterEnabled',
    'maxSteps',
    'stepIncrement'
  ]);

  if (data.activeProvider) {
    const radio = document.querySelector(`input[name="activeProvider"][value="${data.activeProvider}"]`);
    if (radio) radio.checked = true;
  }

  if (data.ollamaHost) {
    ollamaHostInput.value = data.ollamaHost;
  }

  if (data.openrouterApiKey) {
    openrouterKeyInput.value = data.openrouterApiKey;
  }

  if (data.openrouterModel) {
    openrouterModelInput.value = data.openrouterModel;
  }

  if (Array.isArray(data.openrouterModels) && data.openrouterModels.length) {
    connectedOpenrouterModels = [...data.openrouterModels];
  } else if (data.openrouterModel && data.openrouterApiKey) {
    connectedOpenrouterModels = [data.openrouterModel];
  } else {
    connectedOpenrouterModels = [];
  }
  renderOpenrouterModels();

  if (data.openrouterEnabled !== undefined) {
    openrouterEnabled.checked = data.openrouterEnabled;
  }

  const steps = data.maxSteps || 20;
  maxStepsSlider.value = steps;
  maxStepsDisplay.textContent = `${steps} steps`;

  if (data.stepIncrement) {
    stepIncrementSelect.value = data.stepIncrement;
  }

  testOllama();
}

// ── Test Connections ──────────────────────────────────────────────────────

async function testOllama() {
  const host = ollamaHostInput.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  const dot = ollamaStatusBadge.querySelector('.status-dot');
  const text = ollamaStatusBadge.querySelector('.status-text');

  dot.className = 'status-dot';
  text.textContent = 'Testing…';

  try {
    const res = await fetch(`${host}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      const count = data.models?.length || 0;
      dot.className = 'status-dot connected';
      text.textContent = `Connected (${count} model${count === 1 ? '' : 's'})`;
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = `Error ${res.status}`;
    }
  } catch {
    dot.className = 'status-dot disconnected';
    text.textContent = 'Offline';
  }
}

async function verifyOpenrouter() {
  const key = openrouterKeyInput.value.trim();
  if (!key) {
    alert('Please enter an OpenRouter API key first.');
    return;
  }

  verifyOpenrouterBtn.textContent = 'Checking…';
  verifyOpenrouterBtn.disabled = true;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: {
        'Authorization': `Bearer ${key}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      const limit = data.data?.limit ? `$${data.data.limit}` : 'Active';
      alert(`OpenRouter Key Verified!\n\nStatus: Valid\nLabel: ${data.data?.label || 'API Key'}`);
      saveSettings();
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`OpenRouter verification failed: ${err.error?.message || res.statusText}`);
    }
  } catch (e) {
    alert(`Could not reach OpenRouter: ${e.message}`);
  } finally {
    verifyOpenrouterBtn.textContent = 'Verify';
    verifyOpenrouterBtn.disabled = false;
  }
}

async function addOpenrouterModel() {
  const key = openrouterKeyInput.value.trim();
  const rawModel = openrouterModelInput.value.trim();

  if (!key) {
    addModelStatus.style.display = 'block';
    addModelStatus.className = 'model-status-text error';
    addModelStatus.textContent = 'Please enter an OpenRouter API key above first.';
    openrouterKeyInput.focus();
    return;
  }

  if (!rawModel) {
    addModelStatus.style.display = 'block';
    addModelStatus.className = 'model-status-text error';
    addModelStatus.textContent = 'Please specify a model identifier (e.g. anthropic/claude-3.5-sonnet).';
    openrouterModelInput.focus();
    return;
  }

  addOpenrouterModelBtn.disabled = true;
  addOpenrouterModelBtn.textContent = 'Checking…';
  addModelStatus.style.display = 'block';
  addModelStatus.className = 'model-status-text loading';
  addModelStatus.textContent = `Verifying connection for "${rawModel}"…`;

  try {
    // 1. Verify key
    const keyRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (!keyRes.ok) {
      const err = await keyRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Invalid API Key');
    }

    // 2. Check model catalog on OpenRouter
    let modelName = rawModel;
    try {
      const modelsRes = await fetch('https://openrouter.ai/api/v1/models');
      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        const found = mData.data?.find(m => m.id.toLowerCase() === rawModel.toLowerCase());
        if (found) {
          modelName = found.id;
        }
      }
    } catch {}

    if (!connectedOpenrouterModels.includes(modelName)) {
      connectedOpenrouterModels.push(modelName);
    }

    openrouterEnabled.checked = true;
    openrouterModelInput.value = modelName;

    await chrome.storage.local.set({
      openrouterEnabled: true,
      openrouterApiKey: key,
      openrouterModel: modelName,
      openrouterModels: connectedOpenrouterModels
    });

    addModelStatus.className = 'model-status-text success';
    addModelStatus.textContent = `✓ Model verified and connected: ${modelName}`;
    renderOpenrouterModels();
    showToast(`Connected ${modelName}`);
  } catch (err) {
    addModelStatus.className = 'model-status-text error';
    addModelStatus.textContent = `✗ Verification failed: ${err.message}`;
  } finally {
    addOpenrouterModelBtn.disabled = false;
    addOpenrouterModelBtn.textContent = 'Add';
  }
}

// ── Export & Clear History ────────────────────────────────────────────────

async function exportChat() {
  const { chatHistory } = await chrome.storage.local.get('chatHistory');
  if (!chatHistory?.length) {
    alert('No conversation history to export.');
    return;
  }

  let out = '# Local-Agent Ollama Conversation\n\n';
  chatHistory.forEach(m => {
    out += `**${m.role === 'user' ? 'You' : 'Agent'}** _(${new Date(m.timestamp || Date.now()).toLocaleString()})_\n\n${m.text}\n\n---\n\n`;
  });

  const url = URL.createObjectURL(new Blob([out], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `local-agent-export-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

async function clearChatHistory() {
  if (confirm('Are you sure you want to delete all saved conversations? This cannot be undone.')) {
    await chrome.storage.local.remove('chatHistory');
    showToast('Conversation history cleared');
  }
}

// ── Event Listeners ───────────────────────────────────────────────────────

document.querySelectorAll('input[name="activeProvider"]').forEach(radio => {
  radio.addEventListener('change', saveSettings);
});

ollamaHostInput.addEventListener('change', () => {
  saveSettings();
  testOllama();
});
testOllamaBtn.addEventListener('click', testOllama);

openrouterEnabled.addEventListener('change', saveSettings);
openrouterKeyInput.addEventListener('change', saveSettings);
openrouterModelInput.addEventListener('change', saveSettings);
verifyOpenrouterBtn.addEventListener('click', verifyOpenrouter);
addOpenrouterModelBtn.addEventListener('click', addOpenrouterModel);
openrouterModelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addOpenrouterModel();
  }
});

toggleKeyBtn.addEventListener('click', () => {
  openrouterKeyInput.type = openrouterKeyInput.type === 'password' ? 'text' : 'password';
});

maxStepsSlider.addEventListener('input', () => {
  maxStepsDisplay.textContent = `${maxStepsSlider.value} steps`;
});
maxStepsSlider.addEventListener('change', saveSettings);
stepIncrementSelect.addEventListener('change', saveSettings);

exportHistoryBtn.addEventListener('click', exportChat);
clearHistoryBtn.addEventListener('click', clearChatHistory);

themeBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-mode') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-mode', current);
  localStorage.setItem('la-theme', current);
});

loadSettings();
