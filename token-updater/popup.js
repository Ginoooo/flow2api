// popup.js - Chrome扩展配置界面脚本

let statusTimer = null;
let approvedInsecureOrigin = '';

function sendMessage(request) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(request, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
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

function getFormConfig() {
    const apiUrl = normalizeApiUrl(document.getElementById('apiUrl').value);
    const connectionToken = document.getElementById('connectionToken').value.trim();
    const loginAccount = document.getElementById('loginAccount').value.trim().toLowerCase();
    const refreshInterval = Number.parseInt(
        document.getElementById('refreshInterval').value,
        10
    );

    if (!connectionToken) {
        throw new Error('请输入连接Token');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginAccount)) {
        throw new Error('请输入有效的Google账号邮箱');
    }
    if (!Number.isInteger(refreshInterval) || refreshInterval < 1 || refreshInterval > 1440) {
        throw new Error('刷新间隔必须在1-1440分钟之间');
    }

    return { apiUrl, connectionToken, loginAccount, refreshInterval };
}

function setBusy(busy) {
    document.getElementById('saveBtn').disabled = busy;
    document.getElementById('testBtn').disabled = busy;
}

function renderLastSync(lastSync) {
    const state = document.getElementById('lastSync');
    if (!lastSync || !lastSync.timestamp) {
        state.textContent = '尚未执行同步';
        state.className = 'sync-state';
        return;
    }
    const date = new Date(lastSync.timestamp);
    const time = Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
    state.textContent = `${lastSync.success ? '最近同步成功' : '最近同步失败'} · ${time}\n${lastSync.message || ''}`.trim();
    state.className = `sync-state ${lastSync.success ? 'success' : 'error'}`;
}

async function requestApiPermission(apiUrl) {
    const url = new URL(apiUrl);
    const originPattern = `${url.protocol}//${url.hostname}/*`;
    const granted = await chrome.permissions.request({ origins: [originPattern] });
    if (!granted) {
        throw new Error('需要授权访问Flow2API服务地址');
    }
}

async function saveCurrentConfig() {
    const config = getFormConfig();
    const insecureOrigin = insecureRemoteOrigin(config.apiUrl);
    if (insecureOrigin && approvedInsecureOrigin !== insecureOrigin) {
        const approved = confirm(
            '该地址使用非本机 HTTP 连接，Google 登录 Cookie 和连接 Token 将以明文传输。建议先为 Flow2API 配置 HTTPS。\n\n确定仍要使用该地址吗？'
        );
        if (!approved) {
            throw new Error('已取消保存，请改用HTTPS地址');
        }
    }
    approvedInsecureOrigin = insecureOrigin;
    config.insecureHttpOrigin = insecureOrigin;
    await requestApiPermission(config.apiUrl);
    const response = await sendMessage({ action: 'saveConfig', config });
    if (!response || !response.success) {
        throw new Error(response && response.error || '配置保存失败');
    }
    document.getElementById('apiUrl').value = response.config.apiUrl;
    document.getElementById('loginAccount').value = response.config.loginAccount;
    return response.config;
}

async function loadConfig() {
    const response = await sendMessage({ action: 'getConfig' });
    if (!response || !response.success) {
        throw new Error(response && response.error || '配置读取失败');
    }
    const config = response.config || {};
    document.getElementById('apiUrl').value = config.apiUrl || '';
    document.getElementById('connectionToken').value = config.connectionToken || '';
    document.getElementById('loginAccount').value = config.loginAccount || '';
    document.getElementById('refreshInterval').value = config.refreshInterval || 60;
    approvedInsecureOrigin = response.config.insecureHttpOrigin || '';
    renderLastSync(response.lastSync);
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadConfig();
    } catch (error) {
        showStatus(`配置读取失败：${error.message}`, 'error', false);
    }

    document.getElementById('saveBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在保存配置...', 'info', false);
        try {
            await saveCurrentConfig();
            showStatus('配置保存成功', 'success');
        } catch (error) {
            showStatus(error.message, 'error', false);
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('testBtn').addEventListener('click', async () => {
        setBusy(true);
        showStatus('正在保存配置并同步登录态...', 'info', false);
        try {
            await saveCurrentConfig();
            const response = await sendMessage({ action: 'testNow' });
            if (!response || !response.success) {
                throw new Error(response && response.error || '同步失败');
            }
            const actionText = response.action === 'added' ? '已添加账号' : '已更新账号';
            showStatus(`同步成功：${actionText}\n${response.message || ''}`.trim(), 'success', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: true,
                message: response.message || actionText
            });
        } catch (error) {
            showStatus(`同步失败：${error.message}`, 'error', false);
            renderLastSync({
                timestamp: new Date().toISOString(),
                success: false,
                message: error.message
            });
        } finally {
            setBusy(false);
        }
    });

    document.getElementById('logsBtn').addEventListener('click', () => {
        window.location.href = 'logs.html';
    });
});

function showStatus(message, type, autoHide = true) {
    const statusEl = document.getElementById('status');
    if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
    }
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = 'block';

    if (autoHide) {
        statusTimer = setTimeout(() => {
            statusEl.style.display = 'none';
            statusTimer = null;
        }, 5000);
    }
}
