const fields = ['wsUrl', 'authKey', 'clientName', 'proxyScheme', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPass'];
const element = id => document.getElementById(id);
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result?.error) throw new Error(result.error);
  return result;
}
async function refresh() {
  const status = await request({ type: 'getStatus' });
  element('status').textContent = status.connected ? '在线' : '离线';
  element('stats').textContent = `成功 ${status.solved} / 失败 ${status.errors}`;
  element('logs').replaceChildren(...status.logs.slice(-12).map(log => {
    const row = document.createElement('div');
    row.textContent = `${log.time} ${log.message}`;
    return row;
  }));
}
async function command(type) {
  try {
    element('message').textContent = '';
    if (type === 'updateConfig') {
      const config = Object.fromEntries(fields.map(key => [key, element(key).value.trim()]));
      config.authKey = element('authKey').value.trim();
      config.proxyPass = element('proxyPass').value;
      if (config.proxyScheme) {
        if (!confirm('代理将影响此 Chrome 配置的全部网页。继续应用？')) return;
        const permissions = { permissions: [] };
        if (config.proxyUser || config.proxyPass) {
          permissions.permissions.push('webRequest', 'webRequestAuthProvider');
          permissions.origins = ['<all_urls>'];
        }
        if (permissions.permissions.length && !await chrome.permissions.request(permissions)) {
          throw new Error('代理认证权限未授予');
        }
      }
      await request({ type, ...config });
    } else await request({ type });
    await refresh();
  } catch (error) { element('message').textContent = error.message; }
}
element('save').addEventListener('click', () => command('updateConfig'));
element('connect').addEventListener('click', () => command('connect'));
element('disconnect').addEventListener('click', () => command('disconnect'));
request({ type: 'getConfig' }).then(config => {
  fields.forEach(key => { element(key).value = config[key] || ''; });
  return refresh();
}).catch(error => { element('message').textContent = error.message; });
setInterval(() => refresh().catch(() => {}), 2000);