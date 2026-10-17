// background.js - Chrome扩展后台脚本

// 定时器名称
const ALARM_NAME = 'tokenRefresh';
const DEFAULT_REFRESH_INTERVAL = 60;
const MIN_REFRESH_INTERVAL = 1;
const MAX_REFRESH_INTERVAL = 1440;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1500, 4000];

const FLOW_URL = 'https://flow.google.com/projects';
const MODERN_FLOW_COOKIE_NAMES = new Set(['OSID', '__Secure-OSID']);
const GOOGLE_ACCOUNT_COOKIE_NAMES = new Set([
    'SID',
    'HSID',
    'SSID',
    'APISID',
    'SAPISID',
    '__Secure-1PSID',
    '__Secure-3PSID'
]);

let activeSyncPromise = null;
let logWriteQueue = Promise.resolve();

// 日志系统
const Logger = {
    log(level, message, details = null) {
        const timestamp = new Date().toISOString();
        const safeDetails = sanitizeLogDetails(details);
        const logEntry = {
            timestamp,
            level,
            message,
            details: safeDetails
        };

        console.log(`[${level}] ${message}`, safeDetails || '');

        logWriteQueue = logWriteQueue.then(async () => {
            const { logs = [] } = await chrome.storage.local.get(['logs']);
            const updatedLogs = [logEntry, ...logs].slice(0, 50);
            await chrome.storage.local.set({ logs: updatedLogs });
        }).catch((error) => {
            console.error('Failed to persist extension log', error);
        });
        return logWriteQueue;
    },

    info(message, details) {
        return this.log('INFO', message, details);
    },

    error(message, details) {
        return this.log('ERROR', message, details);
    },

    success(message, details) {
        return this.log('SUCCESS', message, details);
    },

    async getLogs() {
        await logWriteQueue;
        const { logs = [] } = await chrome.storage.local.get(['logs']);
        return logs;
    },

    async clearLogs() {
        await logWriteQueue;
        await chrome.storage.local.set({ logs: [] });
    }
};

function sanitizeLogDetails(value, key = '') {
    if (value === null || value === undefined) {
        return value;
    }
    if (/^(authorization|connectionToken|google_cookies|session_token|password|secret)$/i.test(key)) {
        return '[REDACTED]';
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeLogDetails(item));
    }
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                sanitizeLogDetails(entryValue, entryKey)
            ])
        );
    }
    if (typeof value === 'string') {
        return value
            .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
            .replace(
                /("(?:google_cookies|session_token|connectionToken|password|secret)"\s*:\s*")[^"]*/gi,
                '$1[REDACTED]'
            )
            .replace(
                /((?:^|[;\s])(?:__Secure-)?(?:OSID|SID|HSID|SSID|APISID|SAPISID)=)[^;\s]+/gi,
                '$1[REDACTED]'
            );
    }
    return value;
}

async function initializeExtension() {
    await migrateLegacyConfig();
    await setupAlarm();
    await restoreSyncBadge();
}

chrome.runtime.onInstalled.addListener(() => {
    initializeExtension().then(() => {
        return Logger.info('扩展已初始化');
    }).catch((error) => {
        Logger.error('扩展初始化失败', { error: error.message });
    });
});

chrome.runtime.onStartup.addListener(() => {
    initializeExtension().catch((error) => {
        Logger.error('扩展启动失败', { error: error.message });
    });
});

// 监听来自popup的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getConfig') {
        Promise.all([
            getConfig(),
            chrome.storage.local.get(['lastSync'])
        ]).then(([config, state]) => {
            sendResponse({ success: true, config, lastSync: state.lastSync || null });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'saveConfig') {
        saveConfig(request.config).then(async (config) => {
            await setupAlarm();
            await Logger.info('配置已保存，定时任务已更新', {
                apiUrl: config.apiUrl,
                loginAccount: config.loginAccount,
                refreshInterval: config.refreshInterval
            });
            sendResponse({ success: true, config });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'testNow') {
        runTokenSync().then((result) => {
            sendResponse(result);
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true; // 保持消息通道开启
    } else if (request.action === 'getLogs') {
        Logger.getLogs().then((logs) => {
            sendResponse({ success: true, logs });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    } else if (request.action === 'clearLogs') {
        Logger.clearLogs().then(() => {
            sendResponse({ success: true });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

// 监听定时器触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_NAME) {
        await Logger.info('定时同步任务已触发');
        const result = await runTokenSync();

        // 发送通知
        if (result.success) {
            const title = result.action === 'updated' ? '✅ Token已更新' : '✅ Token已添加';
            const message = result.displayMessage || result.message || 'Token已成功同步到Flow2API';

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: title,
                message: String(message).slice(0, 240)
            });
        } else {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon48.png',
                title: '❌ Token同步失败',
                message: String(result.error || '未知错误').slice(0, 240)
            });
        }
    }
});

// 设置定时器
async function setupAlarm() {
    await chrome.alarms.clear(ALARM_NAME);
    const config = await getConfig();
    if (!config.apiUrl || !config.connectionToken || !config.loginAccount) {
        await Logger.info('配置尚未完成，暂未启动定时同步');
        return;
    }
    let validatedConfig;
    try {
        validatedConfig = validateConfig(config);
    } catch (error) {
        await Logger.error('配置需要重新确认，暂未启动定时同步', {
            error: error.message
        });
        return;
    }
    const intervalMinutes = validatedConfig.refreshInterval;
    chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: intervalMinutes,
        periodInMinutes: intervalMinutes
    });
    await Logger.info(`定时同步间隔已设置为 ${intervalMinutes} 分钟`);
}

function normalizeRefreshInterval(value) {
    const interval = Number.parseInt(value, 10);
    if (!Number.isInteger(interval) || interval < MIN_REFRESH_INTERVAL || interval > MAX_REFRESH_INTERVAL) {
        return DEFAULT_REFRESH_INTERVAL;
    }
    return interval;
}

function normalizeApiUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch (error) {
        throw new Error('连接接口格式无效');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('连接接口仅支持 HTTP 或 HTTPS');
    }
    if (url.username || url.password) {
        throw new Error('连接接口中不能包含用户名或密码');
    }
    url.hash = '';
    url.search = '';
    if (!url.pathname || url.pathname === '/') {
        url.pathname = '/api/plugin/update-token';
    }
    return url.toString();
}

function insecureRemoteOrigin(value) {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]';
    return url.protocol === 'http:' && !loopback ? url.origin : '';
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new Error('请输入有效的Google账号邮箱');
    }
    return email;
}

function validateConfig(config) {
    const connectionToken = String(config && config.connectionToken || '').trim();
    if (!connectionToken || connectionToken.length > 4096) {
        throw new Error('连接Token无效');
    }
    const refreshInterval = Number.parseInt(config && config.refreshInterval, 10);
    if (
        !Number.isInteger(refreshInterval)
        || refreshInterval < MIN_REFRESH_INTERVAL
        || refreshInterval > MAX_REFRESH_INTERVAL
    ) {
        throw new Error(`刷新间隔必须在 ${MIN_REFRESH_INTERVAL}-${MAX_REFRESH_INTERVAL} 分钟之间`);
    }
    const apiUrl = normalizeApiUrl(config && config.apiUrl);
    const requiredApprovalOrigin = insecureRemoteOrigin(apiUrl);
    const insecureHttpOrigin = String(config && config.insecureHttpOrigin || '').trim();
    if (requiredApprovalOrigin && insecureHttpOrigin !== requiredApprovalOrigin) {
        throw new Error('非本机HTTP地址需要在扩展设置中重新确认');
    }
    return {
        apiUrl,
        connectionToken,
        loginAccount: normalizeEmail(config && config.loginAccount),
        refreshInterval,
        insecureHttpOrigin: requiredApprovalOrigin
    };
}

async function migrateLegacyConfig() {
    const [synced, local] = await Promise.all([
        chrome.storage.sync.get(['connectionToken']),
        chrome.storage.local.get(['connectionToken'])
    ]);
    if (!local.connectionToken && synced.connectionToken) {
        await chrome.storage.local.set({ connectionToken: synced.connectionToken });
    }
    if (synced.connectionToken) {
        await chrome.storage.sync.remove(['connectionToken']);
    }
}

async function getConfig() {
    await migrateLegacyConfig();
    const [synced, local] = await Promise.all([
        chrome.storage.sync.get(['apiUrl', 'loginAccount', 'refreshInterval']),
        chrome.storage.local.get(['connectionToken', 'insecureHttpOrigin'])
    ]);
    return {
        apiUrl: synced.apiUrl || '',
        connectionToken: local.connectionToken || '',
        loginAccount: synced.loginAccount || '',
        refreshInterval: normalizeRefreshInterval(synced.refreshInterval),
        insecureHttpOrigin: local.insecureHttpOrigin || ''
    };
}

async function saveConfig(input) {
    const config = validateConfig(input || {});
    await Promise.all([
        chrome.storage.sync.set({
            apiUrl: config.apiUrl,
            loginAccount: config.loginAccount,
            refreshInterval: config.refreshInterval
        }),
        chrome.storage.local.set({
            connectionToken: config.connectionToken,
            insecureHttpOrigin: config.insecureHttpOrigin
        })
    ]);
    await chrome.storage.sync.remove(['connectionToken']);
    return config;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function waitForTabReady(tabId, timeoutMs = 15000) {
    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
        };

        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                finish();
            }
        };

        const timer = setTimeout(finish, timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then((currentTab) => {
            if (currentTab && currentTab.status === 'complete') {
                finish();
            }
        }).catch(finish);
    });
}

function normalizeCookieDomain(domain) {
    return String(domain || '').replace(/^\./, '').toLowerCase();
}

function cookieKey(cookie) {
    const partitionSite = cookie.partitionKey && cookie.partitionKey.topLevelSite
        ? cookie.partitionKey.topLevelSite
        : '';
    return [cookie.name, cookie.domain, cookie.path, cookie.storeId, partitionSite].join('\u0000');
}

function deduplicateCookies(cookies) {
    return Array.from(new Map(cookies.map(cookie => [cookieKey(cookie), cookie])).values());
}

function isGoogleAccountCookieDomain(domain) {
    const normalizedDomain = normalizeCookieDomain(domain);
    return normalizedDomain === 'google.com';
}

function serializeCookieStorage(cookies) {
    const payload = cookies
        .filter(cookie => cookie && cookie.name && cookie.value)
        .map(cookie => {
            const item = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || '',
                path: cookie.path || '/',
                secure: Boolean(cookie.secure),
                httpOnly: Boolean(cookie.httpOnly),
                hostOnly: Boolean(cookie.hostOnly),
                session: Boolean(cookie.session)
            };
            if (Number.isFinite(cookie.expirationDate)) {
                item.expirationDate = cookie.expirationDate;
            }
            if (cookie.sameSite) {
                item.sameSite = cookie.sameSite;
            }
            if (cookie.partitionKey && typeof cookie.partitionKey === 'object') {
                item.partitionKey = cookie.partitionKey;
            }
            return item;
        });
    return JSON.stringify(payload);
}

async function collectRelevantCookies() {
    const cookies = await chrome.cookies.getAll({ url: FLOW_URL });
    await Logger.info(`从Flow页面请求范围找到 ${cookies.length} 个Cookie`);
    return deduplicateCookies(cookies);
}

let nativeFlowDiagnosticActive = false;

async function diagnoseNativeFlowSession() {
    const base = { diagnostic_only: true, account_saved: false };
    if (nativeFlowDiagnosticActive) {
        return { ...base, error_code: 'diagnostic_already_running' };
    }
    nativeFlowDiagnosticActive = true;
    const observations = [];
    let observer = null;
    let timer = null;
    const sessionHeaderNames = names => names
        .map(name => name.toLowerCase())
        .filter(name => name === 'authorization' || name.startsWith('sec-session')
            || name.includes('device-bound'))
        .sort();
    const compareCookies = (wirePairs, snapshot) => {
        const exportedPairs = JSON.parse(serializeCookieStorage(snapshot))
            .map(cookie => [cookie.name, cookie.value]);
        const wireNames = [...new Set(wirePairs.map(pair => pair[0]))].sort();
        const exportedNames = [...new Set(exportedPairs.map(pair => pair[0]))].sort();
        const sortedPairs = pairs => JSON.stringify(pairs.map(pair => JSON.stringify(pair)).sort());
        return {
            matches: sortedPairs(wirePairs) === sortedPairs(exportedPairs),
            pair_order_matches: JSON.stringify(wirePairs) === JSON.stringify(exportedPairs),
            missing_from_export: wireNames.filter(name => !exportedNames.includes(name)),
            not_sent: exportedNames.filter(name => !wireNames.includes(name)),
            changed_names: wireNames.filter(name => exportedNames.includes(name)
                && sortedPairs(wirePairs.filter(pair => pair[0] === name))
                    !== sortedPairs(exportedPairs.filter(pair => pair[0] === name))),
        };
    };
    try {
        if (!chrome.webRequest?.onBeforeSendHeaders
                || !await chrome.permissions.contains({ permissions: ['webRequest'] })) {
            return { ...base, error_code: 'web_request_permission_required' };
        }
        observer = details => {
            if (details.url !== FLOW_URL || details.method !== 'GET'
                    || details.initiator !== `chrome-extension://${chrome.runtime.id}`
                    || observations.length >= 8) {
                return;
            }
            const headers = details.requestHeaders || [];
            const cookieHeader = headers.find(header => header.name.toLowerCase() === 'cookie');
            const cookieHeaderObserved = typeof cookieHeader?.value === 'string';
            const pairs = cookieHeaderObserved ? cookieHeader.value.split(';')
                .map(segment => segment.trim())
                .filter(segment => segment.indexOf('=') > 0)
                .map(segment => {
                    const separator = segment.indexOf('=');
                    return [segment.slice(0, separator).trim(), segment.slice(separator + 1)];
                }) : [];
            observations.push({
                pairs,
                cookie_header_observed: cookieHeaderObserved,
                request_session_header_names: sessionHeaderNames(headers.map(header => header.name)),
            });
        };
        chrome.webRequest.onBeforeSendHeaders.addListener(
            observer, { urls: [FLOW_URL], types: ['xmlhttprequest'] },
            ['requestHeaders', 'extraHeaders']
        );
        const before = await chrome.cookies.getAll({ url: FLOW_URL });
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(FLOW_URL, {
            credentials: 'include', cache: 'no-store', signal: controller.signal,
        });
        const html = await response.text();
        const after = await chrome.cookies.getAll({ url: FLOW_URL });
        const match = html.match(/"oPEP7c"\s*:\s*("(?:[^"\\]|\\.)*")/);
        const account = match ? JSON.parse(match[1]) : '';
        return {
            ...base,
            browser_http_status: response.status,
            browser_account_known: typeof account === 'string' && account.includes('@'),
            browser_xsrf_present: /"SNlM0e"\s*:\s*"[^\"]+"/.test(html),
            exported_before_count: JSON.parse(serializeCookieStorage(before)).length,
            exported_after_count: JSON.parse(serializeCookieStorage(after)).length,
            response_session_header_names: sessionHeaderNames([...response.headers.keys()]),
            request_observed: observations.length > 0,
            attempts: observations.map(observation => ({
                cookie_header_observed: observation.cookie_header_observed,
                cookie_count: observation.pairs.length,
                cookie_names: observation.pairs.map(pair => pair[0]),
                request_session_header_names: observation.request_session_header_names,
                before: observation.cookie_header_observed ? compareCookies(observation.pairs, before) : null,
                after: observation.cookie_header_observed ? compareCookies(observation.pairs, after) : null,
            })),
        };
    } catch (error) {
        return {
            ...base,
            error_code: error?.name === 'AbortError' ? 'diagnostic_timeout' : 'diagnostic_failed',
        };
    } finally {
        if (observer) chrome.webRequest.onBeforeSendHeaders.removeListener(observer);
        if (timer !== null) clearTimeout(timer);
        nativeFlowDiagnosticActive = false;
    }
}

async function closeTemporaryTab(tab) {
    if (!tab || typeof tab.id !== 'number') {
        return;
    }

    try {
        await chrome.tabs.remove(tab.id);
        await Logger.info('标签页已关闭');
    } catch (error) {
        await Logger.info('临时标签页已不存在');
    }
}

function parseServerErrorMessage(responseText) {
    const raw = String(responseText || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const payload = JSON.parse(raw);
        const message = payload.detail || payload.message || payload.error;
        if (typeof message === 'string') {
            return message.slice(0, 300);
        }
    } catch (error) {
        // 非JSON响应直接使用截断后的文本
    }

    return raw.slice(0, 300);
}

function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function requestError(message, retryable = false) {
    const error = new Error(message);
    error.retryable = retryable;
    return error;
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function sendTokenPayload(config, payload) {
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            const response = await fetchWithTimeout(config.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.connectionToken}`
                },
                body: JSON.stringify(payload)
            });
            const responseText = await response.text();

            if (response.ok) {
                let result;
                try {
                    result = JSON.parse(responseText);
                } catch (error) {
                    throw requestError('服务器返回了无效的JSON响应');
                }
                if (!result || typeof result !== 'object') {
                    throw requestError('服务器返回格式无效');
                }
                if (result.success === false) {
                    throw requestError(
                        String(result.error || result.message || '服务器拒绝了同步请求')
                    );
                }
                return result;
            }

            const serverError = parseServerErrorMessage(responseText);
            if (!isRetryableStatus(response.status) || attempt >= RETRY_DELAYS_MS.length) {
                throw requestError(
                    serverError
                        ? `服务器错误 ${response.status}: ${serverError}`
                        : `服务器错误: ${response.status}`
                );
            }
            lastError = new Error(serverError || `HTTP ${response.status}`);
        } catch (error) {
            lastError = error && error.name === 'AbortError'
                ? new Error('连接Flow2API服务超时')
                : error;
            const retryableNetworkError = error && error.retryable !== false && (
                error.name === 'AbortError'
                || error instanceof TypeError
                || /fetch|network|timeout/i.test(String(error.message || ''))
            );
            if (!retryableNetworkError || attempt >= RETRY_DELAYS_MS.length) {
                throw lastError;
            }
        }

        const delay = RETRY_DELAYS_MS[attempt];
        await Logger.info(`推送失败，将在 ${delay} 毫秒后重试`, {
            attempt: attempt + 1,
            error: lastError ? lastError.message : 'unknown'
        });
        await sleep(delay);
    }

    throw lastError || new Error('Token推送失败');
}

function runTokenSync() {
    if (activeSyncPromise) {
        return activeSyncPromise;
    }
    activeSyncPromise = extractAndSendToken()
        .then(async (result) => {
            try {
                await recordSyncResult(result);
            } catch (error) {
                await Logger.error('同步状态保存失败', { error: error.message });
            }
            return result;
        })
        .finally(() => {
            activeSyncPromise = null;
        });
    return activeSyncPromise;
}

async function recordSyncResult(result) {
    const success = Boolean(result && result.success);
    const lastSync = {
        timestamp: new Date().toISOString(),
        success,
        action: String(result && result.action || ''),
        message: sanitizeLogDetails(String(
            success
                ? result && result.message || '同步成功'
                : result && result.error || '同步失败'
        )).slice(0, 300)
    };
    await chrome.storage.local.set({ lastSync });
    await updateSyncBadge(lastSync);
}

async function restoreSyncBadge() {
    const { lastSync } = await chrome.storage.local.get(['lastSync']);
    if (lastSync) {
        await updateSyncBadge(lastSync);
    }
}

async function updateSyncBadge(lastSync) {
    const success = Boolean(lastSync && lastSync.success);
    await chrome.action.setBadgeBackgroundColor({ color: success ? '#137333' : '#c5221f' });
    await chrome.action.setBadgeText({ text: success ? '✓' : '!' });
    await chrome.action.setTitle({
        title: success ? 'Flow2API：最近同步成功' : 'Flow2API：最近同步失败'
    });
}

// 提取cookie并发送到服务器
async function extractAndSendToken() {
    let tab = null;

    try {
        await Logger.info('开始提取Token...');

        const config = validateConfig(await getConfig());

        await Logger.info('配置已加载', { apiUrl: config.apiUrl });

        // 1. 打开新版Flow页面（在后台），让浏览器刷新当前登录态
        await Logger.info('正在打开Google Flow页面...');
        tab = await chrome.tabs.create({
            url: FLOW_URL,
            active: false
        });

        await Logger.info('页面已创建，等待加载...', { tabId: tab.id });

        await waitForTabReady(tab.id);

        await Logger.info('页面加载完成，等待JavaScript执行...');

        await sleep(5000);

        const loadedTab = await chrome.tabs.get(tab.id);
        let loadedHost = '';
        try {
            loadedHost = new URL(loadedTab.url || '').hostname.toLowerCase();
        } catch (error) {
            loadedHost = '';
        }
        if (loadedHost !== 'flow.google.com') {
            await closeTemporaryTab(tab);
            tab = null;
            return {
                success: false,
                error: 'Google Flow未保持登录状态。请在当前浏览器配置中重新登录Flow后再试。'
            };
        }

        await Logger.info('开始提取Cookies...');

        // 2. 提取新版Flow会话与Google账号Cookie
        const uniqueCookies = await collectRelevantCookies();

        await Logger.info(`总共找到 ${uniqueCookies.length} 个唯一Cookie`);

        const modernFlowCookie = uniqueCookies.find(cookie => (
            MODERN_FLOW_COOKIE_NAMES.has(cookie.name)
            && normalizeCookieDomain(cookie.domain) === 'flow.google.com'
            && cookie.value
        ));
        const googleAccountCookie = uniqueCookies.find(cookie => (
            GOOGLE_ACCOUNT_COOKIE_NAMES.has(cookie.name)
            && isGoogleAccountCookieDomain(cookie.domain)
            && cookie.value
        ));
        const googleCookies = googleAccountCookie ? serializeCookieStorage(uniqueCookies) : '';

        if (modernFlowCookie) {
            await Logger.success('找到新版Flow Cookie', {
                name: modernFlowCookie.name,
                domain: modernFlowCookie.domain,
                path: modernFlowCookie.path,
                length: modernFlowCookie.value.length
            });
        }
        // 关闭标签页
        await closeTemporaryTab(tab);
        tab = null;

        if (!modernFlowCookie) {
            await Logger.error('未找到Flow登录Cookie', {
                foundCookies: uniqueCookies.map(c => ({
                    name: c.name,
                    domain: c.domain
                }))
            });

            return {
                success: false,
                error: '未找到Flow登录Cookie。请先登录Google Flow，并确认首页或项目页可以正常打开。'
            };
        }

        if (!googleAccountCookie) {
            await Logger.error('未找到Google账号Cookie', {
                requiredNames: Array.from(GOOGLE_ACCOUNT_COOKIE_NAMES)
            });
            return {
                success: false,
                error: '已找到新版Flow会话，但未读取到Google账号Cookie。请重新登录Google后再试。'
            };
        }

        if (!googleCookies) {
            await Logger.error('Cookie序列化失败');
            return { success: false, error: '未生成可同步的Cookie数据。' };
        }

        await Logger.info('Flow Cookie提取成功', {
            mode: 'structured-cookie',
            cookieCount: uniqueCookies.length
        });

        // 3. 发送到服务器
        await Logger.info('正在发送到服务器...');

        const payload = {
            google_cookies: googleCookies,
            protocol_mode: 'protocol'
        };
        payload.login_account = String(config.loginAccount).trim();

        const result = await sendTokenPayload(config, payload);

        // 根据action显示不同的日志信息
        if (result.action === 'updated') {
            await Logger.success('✅ Token已更新到上游', {
                action: '更新现有Token',
                message: result.message
            });
        } else if (result.action === 'added') {
            await Logger.success('✅ Token已添加到上游', {
                action: '添加新Token',
                message: result.message
            });
        } else {
            await Logger.success('✅ Token已同步到上游', result);
        }

        return {
            success: true,
            message: result.message || 'Token更新成功',
            action: result.action,
            displayMessage: result.action === 'updated'
                ? `✅ 成功更新到上游\n${result.message || 'Token更新成功'}`
                : `✅ 成功添加到上游\n${result.message || 'Token同步成功'}`
        };

    } catch (error) {
        await Logger.error('同步过程失败', { error: error.message });

        await closeTemporaryTab(tab);

        return { success: false, error: error.message };
    }
}
