const DEFAULT_SETTINGS = {
  serverUrl: "ws://127.0.0.1:8000/captcha_ws",
  apiKey: "",
  routeKey: "",
  clientLabel: ""
};

const $ = (id) => document.getElementById(id);
let locale = "zh-CN";
let translations = {};
let statusMessage = null;

function translate(source, params = {}) {
  const message = translations[locale]?.[source] || source;
  return message.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
}

function renderLanguage() {
  document.documentElement.lang = locale;
  $("language").value = locale;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(element.dataset.i18n);
  });
  ["placeholder", "aria-label"].forEach((attribute) => {
    document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
      element.setAttribute(attribute, translate(element.getAttribute(`data-i18n-${attribute}`)));
    });
  });
  if (statusMessage) $("status").textContent = translate(statusMessage.source, statusMessage.params);
}

async function loadLanguage() {
  const stored = new Promise((resolve) => {
    chrome.storage.local.get({ uiLanguage: "" }, (settings) => {
      const error = chrome.runtime.lastError;
      resolve(error ? {} : settings);
    });
  });
  const catalog = fetch("locales.json")
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .catch(() => ({}));
  const [settings, messages] = await Promise.all([stored, catalog]);
  translations = messages;
  const candidates = [settings.uiLanguage, ...(navigator.languages || [navigator.language])];
  const language = candidates.find((value) => /^(zh|en)(-|$)/i.test(value || ""));
  locale = /^en(-|$)/i.test(language || "") ? "en" : "zh-CN";
  renderLanguage();
}

function normalizeSettings(values) {
  return {
    serverUrl: (values.serverUrl || DEFAULT_SETTINGS.serverUrl).trim(),
    apiKey: (values.apiKey || "").trim(),
    routeKey: (values.routeKey || "").trim(),
    clientLabel: (values.clientLabel || "").trim()
  };
}

function setStatus(message, isError = false, params = {}) {
  const status = $("status");
  statusMessage = { source: message, params };
  status.textContent = translate(message, params);
  status.style.color = isError ? "#b91c1c" : "#065f46";
}

function isValidWsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch (e) {
    return false;
  }
}

function loadSettings() {
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    const settings = normalizeSettings(stored);
    $("serverUrl").value = settings.serverUrl;
    $("apiKey").value = settings.apiKey;
    $("routeKey").value = settings.routeKey;
    $("clientLabel").value = settings.clientLabel;
  });
}

function saveSettings() {
  const settings = normalizeSettings({
    serverUrl: $("serverUrl").value,
    apiKey: $("apiKey").value,
    routeKey: $("routeKey").value,
    clientLabel: $("clientLabel").value
  });

  if (!isValidWsUrl(settings.serverUrl)) {
    setStatus("WebSocket URL 必须以 ws:// 或 wss:// 开头。", true);
    return;
  }
  if (!settings.apiKey) {
    setStatus("请填写 Flow2API API Key。", true);
    return;
  }

  chrome.storage.local.set(settings, () => {
    if (chrome.runtime.lastError) {
      setStatus("保存失败：{error}", true, { error: chrome.runtime.lastError.message });
      return;
    }
    setStatus("已保存，后台连接会自动重连。");
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadLanguage();
  loadSettings();
  $("saveBtn").addEventListener("click", saveSettings);
  $("language").addEventListener("change", () => {
    locale = $("language").value === "en" ? "en" : "zh-CN";
    renderLanguage();
    chrome.storage.local.set({ uiLanguage: locale }, () => {
      if (chrome.runtime.lastError) {
        setStatus("语言偏好保存失败：{error}", true, { error: chrome.runtime.lastError.message });
      }
    });
  });
});
