const FLOW_URL = 'https://flow.google.com/';
const DEFAULTS = {
  wsUrl: '', authKey: '', clientName: 'Chrome', enabled: false,
  proxyScheme: '', proxyHost: '', proxyPort: '', proxyUser: '', proxyPass: '',
};
let settings = { ...DEFAULTS };
let socket = null;
let generation = 0;
let authenticated = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let connecting = false;
let authListenerInstalled = false;
let pool = [];
let poolInit = null;
let refreshInterval = 2;
let solveQueue = Promise.resolve();
let stats = { solved: 0, errors: 0 };
const logs = [];
const authAttempts = new Map();

function addLog(message) {
  logs.push({ time: new Date().toLocaleTimeString(), message });
  if (logs.length > 80) logs.shift();
}

async function loadConfig() {
  settings = { ...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS)) };
}

function validateConfig(config) {
  const endpoint = new URL(config.wsUrl);
  if (endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new Error('Use WSS, or WS on localhost for testing');
  }
  if (endpoint.username || endpoint.password || !config.authKey.trim()) {
    throw new Error('A dedicated solver key is required');
  }
  if (config.proxyScheme) {
    if (!['http', 'socks5'].includes(config.proxyScheme) ||
        !config.proxyHost.trim() || /[\s/@?#]/.test(config.proxyHost) ||
        !/^\d+$/.test(String(config.proxyPort)) ||
        Number(config.proxyPort) < 1 || Number(config.proxyPort) > 65535) {
      throw new Error('Invalid proxy host or port');
    }
    if (config.proxyScheme === 'socks5' && (config.proxyUser || config.proxyPass)) {
      throw new Error('Authenticated SOCKS5 is not supported; use an HTTP proxy');
    }
  }
}

async function updateStatus() {
  await chrome.action.setBadgeText({ text: authenticated ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: authenticated ? '#16845b' : '#aa3344' });
}

async function proxyAuth(details, callback) {
  await startup;
  const configuredHost = settings.proxyHost.replace(/^\[|\]$/g, '').toLowerCase();
  const challengerHost = String(details.challenger?.host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!settings.enabled || settings.proxyScheme !== 'http' || !details.isProxy ||
      challengerHost !== configuredHost || Number(details.challenger?.port) !== Number(settings.proxyPort) ||
      !(settings.proxyUser || settings.proxyPass)) {
    callback({});
    return;
  }
  if (authAttempts.has(details.requestId)) {
    callback({ cancel: true });
    addLog('Proxy authentication rejected; check credentials');
    return;
  }
  authAttempts.set(details.requestId, true);
  callback({ authCredentials: { username: settings.proxyUser, password: settings.proxyPass } });
}

function installProxyAuth() {
  if (authListenerInstalled) return;
  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => { proxyAuth(details, callback).catch(() => callback({ cancel: true })); },
    { urls: ['<all_urls>'] }, ['asyncBlocking'],
  );
  const complete = details => authAttempts.delete(details.requestId);
  chrome.webRequest.onCompleted.addListener(complete, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(complete, { urls: ['<all_urls>'] });
  authListenerInstalled = true;
}

async function clearProxy() {
  if (!await chrome.permissions.contains({ permissions: ['proxy'] })) return;
  const current = await chrome.proxy.settings.get({ incognito: false });
  if (current.levelOfControl === 'controlled_by_this_extension') {
    await chrome.proxy.settings.clear({ scope: 'regular' });
  }
  authAttempts.clear();
}

async function applyProxy() {
  if (!settings.proxyScheme) {
    await clearProxy();
    return;
  }
  if (!await chrome.permissions.contains({ permissions: ['proxy'] })) {
    throw new Error('Proxy permission is not granted');
  }
  const current = await chrome.proxy.settings.get({ incognito: false });
  if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(current.levelOfControl)) {
    throw new Error('Proxy settings are controlled by another extension or policy');
  }
  if (settings.proxyUser || settings.proxyPass) {
    if (!await chrome.permissions.contains({
      permissions: ['webRequest', 'webRequestAuthProvider'], origins: ['<all_urls>'],
    })) throw new Error('Proxy authentication permission is not granted');
    installProxyAuth();
  }
  const bypassList = [
    'localhost', '127.0.0.1', '[::1]', '<local>',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    new URL(settings.wsUrl).hostname,
  ];
  await chrome.proxy.settings.set({ scope: 'regular', value: {
    mode: 'fixed_servers', rules: {
      singleProxy: { scheme: settings.proxyScheme, host: settings.proxyHost, port: Number(settings.proxyPort) },
      bypassList,
    },
  } });
  addLog('Browser profile proxy applied');
}

function stopSocket() {
  generation++;
  authenticated = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  reconnectTimer = null;
  heartbeatTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  updateStatus();
}

function scheduleReconnect() {
  if (!settings.enabled || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => addLog('Reconnect failed'));
  }, 5000);
}

async function connect() {
  if (!settings.enabled || connecting || socket && socket.readyState <= 1) return;
  connecting = true;
  const epoch = generation;
  try {
    validateConfig(settings);
    await applyProxy();
    if (!settings.enabled || epoch !== generation) return;
    const endpoint = new URL(settings.wsUrl);
    endpoint.searchParams.set('name', settings.clientName.slice(0, 80));
    const connection = new WebSocket(endpoint.href);
    socket = connection;
    connection.onopen = () => {
      if (connection !== socket || epoch !== generation) return;
      connection.send(JSON.stringify({ type: 'auth', key: settings.authKey }));
    };
    connection.onmessage = event => {
      if (connection !== socket || epoch !== generation) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'auth_fail') {
          settings.enabled = false;
          chrome.storage.local.set({ enabled: false });
          stopSocket();
          clearProxy();
          addLog('Solver key rejected');
        } else if (message.type === 'auth_ok') {
          authenticated = true;
          updateStatus();
          addLog('Authenticated');
          heartbeatTimer = setInterval(() => {
            if (connection === socket && connection.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify({ type: 'ping' }));
            }
          }, 25000);
          ensurePool().catch(() => addLog('Flow tabs are unavailable'));
        } else if (authenticated && message.type === 'config') {
          if (Number.isInteger(message.refreshInterval) && message.refreshInterval >= 1) {
            refreshInterval = message.refreshInterval;
          }
        } else if (authenticated && message.type === 'solve') {
          const expiresAt = Date.now() + Math.min(45000, Math.max(100, Number(message.timeoutMs) || 25000));
          solveQueue = solveQueue.catch(() => {}).then(() => processSolve(message, connection, epoch, expiresAt));
        }
      } catch (_) {
        addLog('Invalid server message');
      }
    };
    connection.onclose = () => {
      if (connection !== socket) return;
      stopSocket();
      scheduleReconnect();
    };
    connection.onerror = () => addLog('WebSocket connection failed');
  } catch (error) {
    addLog(error.message);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function isFlowUrl(value) {
  try { return ['flow.google.com', 'labs.google'].includes(new URL(value).hostname); }
  catch (_) { return false; }
}

async function ensurePool() {
  if (poolInit) return poolInit;
  poolInit = (async () => {
    const existing = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/*'] });
    for (const tab of existing) {
      if (pool.length >= 3) break;
      if (!pool.some(entry => entry.id === tab.id)) {
        pool.push({ id: tab.id, createdAt: Date.now(), count: 0, refreshing: false });
      }
    }
    while (settings.enabled && authenticated && pool.length < 3) {
      const tab = await chrome.tabs.create({ url: FLOW_URL, active: false });
      pool.push({ id: tab.id, createdAt: Date.now(), count: 0, refreshing: false });
    }
  })();
  try { await poolInit; } finally { poolInit = null; }
}

async function executeCaptchaInPage(siteKey, action, timeoutMs) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Flow captcha timed out')), timeoutMs);
  });
  const execute = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (globalThis.grecaptcha?.enterprise?.execute) {
        return globalThis.grecaptcha.enterprise.execute(siteKey, { action });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Flow captcha is not ready; check Google login');
  };
  try { return await Promise.race([execute(), expired]); }
  finally { clearTimeout(timer); }
}

async function processSolve(message, connection, epoch, expiresAt) {
  if (epoch !== generation || connection !== socket || !authenticated) return;
  let entry;
  let response;
  try {
    if (Date.now() >= expiresAt) throw new Error('Solver request expired');
    await ensurePool();
    entry = pool.filter(tab => !tab.refreshing).sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!entry) throw new Error('No Flow tab is available');
    let tab = await chrome.tabs.get(entry.id);
    while (tab.status !== 'complete' && Date.now() < expiresAt) {
      await new Promise(resolve => setTimeout(resolve, 200));
      tab = await chrome.tabs.get(entry.id);
    }
    if (!isFlowUrl(tab.url)) throw new Error('Flow login required');
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new Error('Solver request expired');
    const results = await chrome.scripting.executeScript({
      target: { tabId: entry.id }, world: 'MAIN', func: executeCaptchaInPage,
      args: [message.siteKey, message.action, remaining],
    });
    const token = results?.[0]?.result;
    if (typeof token !== 'string' || !token.trim()) throw new Error('Flow returned an empty token');
    response = { type: 'result', id: message.id, token };
  } catch (_) {
    response = { type: 'result', id: message.id, error: 'Flow captcha failed; check tab and login' };
  }
  if (connection !== socket || epoch !== generation || !authenticated) return;
  if (Date.now() >= expiresAt) response = { type: 'result', id: message.id, error: 'Solver request expired' };
  try { connection.send(JSON.stringify(response)); } catch (_) { return; }
  if (response.token) stats.solved++; else stats.errors++;
  addLog(response.token ? 'Captcha solved' : 'Captcha failed');
  if (entry && ++entry.count >= refreshInterval) {
    entry.refreshing = true;
    try {
      await chrome.tabs.reload(entry.id);
      entry.createdAt = Date.now();
      entry.count = 0;
    } catch (_) {
      pool = pool.filter(tab => tab !== entry);
    } finally { entry.refreshing = false; }
  }
}

async function handlePopup(message) {
  await startup;
  if (message.type === 'getStatus') return { ...stats, connected: authenticated, enabled: settings.enabled, logs };
  if (message.type === 'getConfig') return { ...settings };
  if (message.type === 'disconnect') {
    settings.enabled = false;
    await chrome.storage.local.set({ enabled: false });
    stopSocket();
    await clearProxy();
  } else if (message.type === 'connect') {
    validateConfig(settings);
    settings.enabled = true;
    await chrome.storage.local.set({ enabled: true });
    await connect();
  } else if (message.type === 'updateConfig') {
    const next = { ...settings };
    for (const key of Object.keys(DEFAULTS)) {
      if (key !== 'enabled' && typeof message[key] === 'string') next[key] = message[key];
    }
    validateConfig(next);
    stopSocket();
    settings = next;
    await chrome.storage.local.set(settings);
    if (settings.enabled) await connect(); else await clearProxy();
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  handlePopup(message).then(respond).catch(error => respond({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  pool = pool.filter(entry => entry.id !== tabId);
  if (settings.enabled && authenticated) ensurePool().catch(() => addLog('Flow tab recovery failed'));
});
chrome.alarms.create('solverKeepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (settings.enabled) connect().catch(() => addLog('Connection recovery failed'));
});
const startup = loadConfig();
startup.then(async () => {
  if (await chrome.permissions.contains({ permissions: ['webRequest', 'webRequestAuthProvider'], origins: ['<all_urls>'] })) {
    installProxyAuth();
  }
  if (settings.enabled) await connect();
}).catch(() => addLog('Configuration could not be loaded'));