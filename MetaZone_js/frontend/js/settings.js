const apiTabs = document.getElementById('apiTabs');
const apiKeyList = document.getElementById('apiKeyList');
const keyCardTemplate = document.getElementById('keyCardTemplate');

let providersCache = [];
let activeProvider = null;

// v0.9.x (Part 21): validate_key_live() now returns immediately with a
// request_id and delivers the real ok/message pair later as a
// "key_validated" event (see bridge.py) -- this wraps that back into a
// Promise so call sites below can keep the exact same
// `const res = await requestValidateKey(...)` shape they had when the
// call was synchronous. pendingValidations maps request_id -> resolve,
// one shared listener handles every in-flight validation regardless of
// which key/button triggered it.
const pendingValidations = new Map();
BackendEvents.on('key_validated', (p) => {
  const resolve = pendingValidations.get(p.request_id);
  if (!resolve) return;
  pendingValidations.delete(p.request_id);
  resolve({ ok: p.ok, message: p.message });
});
function requestValidateKey(provider, key) {
  return new Promise(async (resolve) => {
    const started = await pywebview.api.validate_key_live(provider, key);
    if (!started.request_id) { resolve({ ok: false, message: 'Could not start validation' }); return; }
    pendingValidations.set(started.request_id, resolve);
  });
}

// v0.9.4 (item 15): registered once at module scope, not inside
// renderProvider() (which re-runs on every tab switch/loadProviders
// call) -- a per-render registration with no matching unsubscribe
// would leave a growing pile of stale listeners, each still firing on
// every future Test All completion.
BackendEvents.on('test_all_completed', (res) => {
  if (res.provider !== activeProvider) return;
  const btn = document.getElementById('btnTestAll');
  if (btn) { btn.disabled = false; btn.textContent = '🧪 Test All'; }
  Toast.show(`Tested ${res.total} key(s) for ${res.provider}`, { type: 'info' });
  loadProviders();
});

async function loadProviders() {
  const res = await pywebview.api.get_provider_summary();
  providersCache = res.providers;
  if (!activeProvider) activeProvider = providersCache[0]?.provider;
  renderTabs();
  renderProvider();
}

function renderTabs() {
  apiTabs.innerHTML = providersCache.map(p =>
    `<button class="api-tab ${p.provider === activeProvider ? 'active' : ''}" data-provider="${p.provider}">
       ${p.provider} <span class="api-tab-count">●${p.active_count}</span>
     </button>`
  ).join('');
  apiTabs.querySelectorAll('.api-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeProvider = btn.dataset.provider; renderTabs(); renderProvider(); });
  });
}

function renderProvider() {
  const p = providersCache.find(x => x.provider === activeProvider);
  if (!p) return;

  document.getElementById('apiProviderName').textContent = p.provider;
  document.getElementById('apiGetKeyBtn').onclick = () => window.open(p.key_url, '_blank');
  document.getElementById('applyAllCount').textContent = p.keys.length;

  const modelSel = document.getElementById('apiModelSelect');
  modelSel.innerHTML = p.models.map(([label, id]) => `<option value="${id}">${label}</option>`).join('');
  modelSel.value = p.current_model;
  modelSel.onchange = async () => { await pywebview.api.set_provider_model(p.provider, modelSel.value); };

  document.getElementById('btnApplyModelAll').onclick = async () => {
    await pywebview.api.set_provider_model(p.provider, modelSel.value);
    loadProviders();
  };

  document.getElementById('apiSaveKeyBtn').onclick = async () => {
    const input = document.getElementById('apiNewKeyInput');
    const val = input.value.trim();
    if (!val) return;
    const res = await pywebview.api.add_api_key(p.provider, val);
    const status = document.getElementById('apiKeyValidateStatus');
    if (!res.ok) { status.textContent = res.error || 'Could not save.'; return; }
    input.value = ''; status.textContent = '';
    loadProviders();
  };

  // Live validation on blur -- informational only, never blocks Save
  // (matches the original's FocusOut-triggered check).
  document.getElementById('apiNewKeyInput').onblur = async (e) => {
    const val = e.target.value.trim();
    const status = document.getElementById('apiKeyValidateStatus');
    if (val.length < 8) { status.textContent = ''; return; }
    status.textContent = '⟳ Checking…';
    const res = await requestValidateKey(p.provider, val);
    status.textContent = res.ok ? '✓ Valid' : `✗ ${res.message || 'Invalid'}`;
  };

  document.getElementById('btnActivateAll').onclick = async () => {
    await pywebview.api.set_all_keys_active(p.provider, true); loadProviders();
  };
  document.getElementById('btnDeactivateAll').onclick = async () => {
    await pywebview.api.set_all_keys_active(p.provider, false); loadProviders();
  };

  // v0.9.4 (item 15): Test All -- tests every stored key for this
  // provider one at a time (see bridge.py's test_all_keys), reflecting
  // results live via the same key_validated event each card's own Test
  // button already listens to indirectly through loadProviders() on
  // completion. Button stays disabled for the duration so a second
  // click can't start an overlapping batch.
  const testAllBtn = document.getElementById('btnTestAll');
  testAllBtn.onclick = async () => {
    if (!p.keys.length) return;
    testAllBtn.disabled = true;
    testAllBtn.textContent = `⟳ Testing 0/${p.keys.length}…`;
    let done = 0;
    const total = p.keys.length;
    const onResult = () => {
      done++;
      testAllBtn.textContent = `⟳ Testing ${done}/${total}…`;
      if (done >= total) BackendEvents.off('key_validated', onResult);
    };
    BackendEvents.on('key_validated', onResult);
    await pywebview.api.test_all_keys(p.provider);
  };
  document.getElementById('btnActivateValid').onclick = async () => {
    const untested = p.keys.filter(k => !k.last_test).length;
    const res = await pywebview.api.activate_valid_keys(p.provider);
    if (res.ok) {
      Toast.show(`${res.changed} key(s) updated${untested ? ` — ${untested} untested key(s) left as-is` : ''}`, { type: 'success' });
      loadProviders();
    }
  };

  apiKeyList.innerHTML = '';
  if (!p.keys.length) {
    apiKeyList.innerHTML = '<div class="hint-text">No keys saved yet.</div>';
    return;
  }
  p.keys.forEach((k, idx) => {
    const card = keyCardTemplate.content.firstElementChild.cloneNode(true);
    card.classList.toggle('key-card-active', k.active);
    const maskedEl = card.querySelector('.key-masked');
    maskedEl.textContent = k.masked;
    card.querySelector('.key-active-pill').style.display = k.active ? '' : 'none';

    // v0.9.4 (item 15): nickname, click-to-rename (same contenteditable
    // pattern P2P's prompt cards already use, rather than a jarring
    // native prompt() dialog that can't be styled to match the rest of
    // the app).
    const nickEl = card.querySelector('.key-nickname');
    nickEl.textContent = k.nickname || '(unnamed key)';
    nickEl.classList.toggle('key-nickname-empty', !k.nickname);
    nickEl.addEventListener('click', () => {
      nickEl.setAttribute('contenteditable', 'true');
      nickEl.textContent = k.nickname || '';
      nickEl.focus();
      document.execCommand('selectAll', false, null);
    });
    nickEl.addEventListener('blur', async () => {
      nickEl.setAttribute('contenteditable', 'false');
      const val = nickEl.textContent.trim();
      await pywebview.api.set_key_nickname(p.provider, idx, val);
      loadProviders();
    });
    nickEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nickEl.blur(); }
      if (e.key === 'Escape') { nickEl.textContent = k.nickname || '(unnamed key)'; nickEl.blur(); }
    });

    // v0.9.4 (item 15): status badge -- real, persisted last_test
    // result (see settings.py's record_key_test), never a color-only
    // indicator. A key that's never been tested honestly shows
    // UNKNOWN rather than a fabricated default.
    setStatusBadge(card.querySelector('.key-status-badge'), k.last_test);
    const metaEl = card.querySelector('.key-card-meta');
    metaEl.textContent = k.last_test ? `Last tested ${relativeTime(k.last_test.at)} — ${k.last_test.message}` : 'Never tested';

    let shown = false;
    card.querySelector('.key-eye-btn').addEventListener('click', () => {
      shown = !shown;
      maskedEl.textContent = shown ? k.key : k.masked;
    });
    card.querySelector('.key-copy-btn').addEventListener('click', async (e) => {
      await copyText(k.key);
      flashCopied(e.currentTarget);
    });
    const testBtn = card.querySelector('.key-test-btn');
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testBtn.textContent = '⟳…';
      const res = await requestValidateKey(p.provider, k.key);
      testBtn.disabled = false;
      testBtn.textContent = res.ok ? '✓ OK' : '✗ Bad';
      // Reflects immediately rather than waiting for a manual refresh
      // -- record_key_test already persisted this server-side by the
      // time requestValidateKey's promise resolves (bridge.py records
      // it before emitting key_validated).
      setStatusBadge(card.querySelector('.key-status-badge'),
        { status: res.ok ? 'valid' : (res.message || '').startsWith('Invalid key') ? 'invalid' : 'error', message: res.message, at: Date.now() / 1000 });
      metaEl.textContent = `Last tested just now — ${res.message}`;
    });

    const toggleBtn = card.querySelector('.key-toggle-btn');
    toggleBtn.textContent = k.active ? 'Deactivate' : 'Activate';
    toggleBtn.addEventListener('click', async () => {
      await pywebview.api.set_key_active(p.provider, idx, !k.active);
      loadProviders();
    });

    card.querySelector('.key-delete-btn').addEventListener('click', async () => {
      await pywebview.api.delete_api_key(p.provider, idx);
      loadProviders();
    });

    apiKeyList.appendChild(card);
  });
}

// v0.9.4 (item 15): shared status-badge renderer -- text label always
// present (never color-only, per the spec), color is a secondary cue.
function setStatusBadge(el, lastTest) {
  const status = lastTest ? lastTest.status : 'unknown';
  const labels = { valid: 'VALID', invalid: 'INVALID', error: 'ERROR', unknown: 'UNKNOWN' };
  el.textContent = labels[status] || 'UNKNOWN';
  el.className = `key-status-badge key-status-${status}`;
}

function relativeTime(unixSeconds) {
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

document.querySelector('[data-page="settings"]').addEventListener('click', loadProviders);
onPywebviewReady(loadProviders);
