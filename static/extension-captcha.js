(() => {
  const element = id => document.getElementById(id);
  let timer = null;
  let loading = false;
  let active = false;
  let initialized = false;
  const inputClass = 'inline-flex items-center justify-center rounded-md border border-input h-8 px-3 text-sm';
  async function status() {
    if (loading || !active) return;
    loading = true;
    try {
      const response = await apiRequest('/api/captcha/extension-status');
      if (!response?.ok) throw new Error('插件状态读取失败');
      const data = await response.json();
      if (!active) return;
      element('extensionSummary').textContent = `${data.key_configured ? '密钥已配置' : '未配置连接密钥'} / 在线 ${data.connected_clients} / 成功 ${data.success_count} / 失败 ${data.error_count}`;
      if (!initialized) {
        element('extensionRefresh').value = data.refresh_interval;
        element('extensionMaxErrors').value = data.max_consecutive_errors;
        initialized = true;
      }
      element('extensionClients').replaceChildren(...data.clients.map(client => {
        const row = document.createElement('div');
        row.className = 'border-t border-border pt-3 flex flex-wrap gap-2 items-center';
        const name = document.createElement('span');
        name.className = 'text-sm break-all flex-1';
        name.textContent = `${client.name} / ${client.busy ? '忙碌' : '空闲'} / 成功 ${client.solve_count} / 失败 ${client.error_count}${client.auto_disabled ? ' / 已自动禁用' : ''}`;
        const toggle = document.createElement('button');
        toggle.type = 'button'; toggle.className = inputClass;
        toggle.textContent = client.enabled ? '禁用' : '启用';
        toggle.addEventListener('click', () => action('/api/captcha/extension-client-toggle', { client_id: client.client_id, enabled: !client.enabled }, toggle));
        const test = document.createElement('button');
        test.type = 'button'; test.className = inputClass; test.textContent = '测试';
        test.addEventListener('click', () => action('/api/captcha/extension-client-test', { client_id: client.client_id }, test));
        row.append(name, toggle, test);
        return row;
      }));
    } catch (error) { element('extensionSummary').textContent = error.message; }
    finally { loading = false; }
  }
  async function action(endpoint, payload, button) {
    if (button) button.disabled = true;
    try {
      const response = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      if (!response) return;
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || result.detail || '操作失败');
      if (result.auth_key) {
        element('extensionNewKey').value = result.auth_key;
        element('extensionNewKey').style.display = 'flex';
        element('extensionCopyKey').style.display = 'inline-flex';
      }
      if (result.token_length) showToast(`取码成功，${result.elapsed_ms} ms，长度 ${result.token_length}`, 'success');
      else showToast('插件配置已更新', 'success');
      await status();
    } catch (error) { showToast(error.message, 'error'); }
    finally { if (button) button.disabled = false; }
  }
  function sync() {
    const visible = element('cfgCaptchaMethod').value === 'extension_ws' && !element('panelSettings').classList.contains('hidden');
    element('extensionOptions').style.display = visible ? 'block' : 'none';
    if (visible === active) return;
    active = visible;
    if (timer) clearInterval(timer);
    timer = null;
    if (active) { status(); timer = setInterval(status, 5000); }
    else {
      initialized = false;
      element('extensionNewKey').value = '';
      element('extensionNewKey').style.display = 'none';
      element('extensionCopyKey').style.display = 'none';
    }
  }
  const endpoint = new URL('/ws/captcha', location.href);
  endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  element('extensionWsUrl').value = endpoint.href;
  element('cfgCaptchaMethod').addEventListener('change', sync);
  new MutationObserver(sync).observe(element('yescaptchaOptions'), { attributes: true, attributeFilter: ['style'] });
  new MutationObserver(sync).observe(element('panelSettings'), { attributes: true, attributeFilter: ['class'] });
  element('extensionSave').addEventListener('click', () => action('/api/captcha/extension-config', {
    refresh_interval: Number(element('extensionRefresh').value),
    max_consecutive_errors: Number(element('extensionMaxErrors').value),
  }, element('extensionSave')));
  element('extensionRotateKey').addEventListener('click', () => {
    if (confirm('生成新密钥将断开全部插件连接。继续？')) action('/api/captcha/extension-config', { regenerate_key: true }, element('extensionRotateKey'));
  });
  element('extensionCopyKey').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(element('extensionNewKey').value); showToast('已复制', 'success'); }
    catch (_) { showToast('复制失败', 'error'); }
  });
  sync();
})();