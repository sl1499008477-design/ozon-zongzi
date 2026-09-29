// Seller identity is independent of the Zongzi avatar and Web's bound stores.
(() => {
    const api = window.electronAPI;
    if (!api) return;
    const panel = document.createElement('section');
    panel.id = 'collector-seller-login';
    panel.setAttribute('aria-label', '商家后台登录状态');
    const label = document.createElement('strong');
    const login = document.createElement('button');
    login.type = 'button';
    login.textContent = '登录商家后台';
    const message = document.createElement('small');
    message.setAttribute('role', 'status');
    const routeLink = document.createElement('button');
    routeLink.type = 'button';
    routeLink.className = 'collector-seller-route-link';
    routeLink.textContent = '修改线路';
    panel.append(label, login, message, routeLink);
    const name = origin => origin === 'https://seller.ozonru.cn' ? '中国线路' : '俄罗斯线路';
    let avatar = null, generation = 0, inFlight = false, loginWaiting = false, lastRead = 0, routeSettingsUrl = '';
    function clearIdentity() {
        label.textContent = 'Ozon 线路：尚未同步';
        login.hidden = false;
        message.textContent = '';
        routeSettingsUrl = '';
        routeLink.disabled = true;
    }
    function render(status) {
        if (!status?.origin) return clearIdentity();
        label.textContent = `${name(status.origin)}${status.loggedIn && status.storeLabel ? ` · ${status.storeLabel}` : ''}`;
        login.hidden = status.loggedIn === true;
        routeSettingsUrl = status.routeSettingsUrl || '';
        routeLink.disabled = !routeSettingsUrl;
        if (status.loggedIn) loginWaiting = false;
        const pending = status.pendingOrigin
            ? `待切换：${name(status.pendingOrigin)}，当前任务结束后生效。` : '';
        message.textContent = [pending, status.syncError, status.verificationError,
            !status.loggedIn && !status.verificationError ? '请登录当前线路的商家后台。' : ''].filter(Boolean).join(' ');
    }
    async function refresh() {
        if (!avatar || inFlight) return;
        const ticket = generation;
        inFlight = true;
        lastRead = Date.now();
        try {
            const result = await api.invoke('seller-session-status', { verify: true });
            if (ticket !== generation) return;
            if (result?.code === 200) render(result.data);
            else { clearIdentity(); message.textContent = result?.message || '登录状态读取失败，请检查连接后重试'; }
        } catch {
            if (ticket === generation) { clearIdentity(); message.textContent = '登录状态读取失败，请检查连接后重试'; }
        } finally { inFlight = false; }
    }
    function mount() {
        const next = document.querySelector('.layout-page .content > .left > .user');
        if (next === avatar) return;
        generation += 1;
        avatar = next;
        loginWaiting = false;
        clearIdentity();
        panel.remove();
        if (avatar) { avatar.insertAdjacentElement('afterend', panel); void refresh(); }
    }
    login.addEventListener('click', async () => {
        const ticket = generation;
        login.disabled = true;
        try {
            const result = await api.invoke('seller-open-login');
            if (ticket !== generation) return;
            if (result?.code !== 200) message.textContent = result?.message || '商家后台未能打开，请重试';
            else { loginWaiting = true; message.textContent = '请在商家后台完成登录，返回助手后会自动确认。'; await refresh(); }
        } catch { if (ticket === generation) message.textContent = '商家后台未能打开，请重试'; }
        finally { login.disabled = false; }
    });
    routeLink.addEventListener('click', async () => {
        if (!routeSettingsUrl) return;
        const ticket = generation;
        try {
            const result = await api.invoke('open-url', routeSettingsUrl);
            if (ticket === generation && result?.code !== 200)
                message.textContent = result?.message || '线路设置页面未能打开，请重试';
        } catch {
            if (ticket === generation) message.textContent = '线路设置页面未能打开，请重试';
        }
    });
    window.addEventListener('focus', refresh);
    const refreshAfterWork = status => {
        if (['completed', 'failed', 'cancelled'].includes(status?.status) || Date.now() - lastRead >= 5000) void refresh();
    };
    api.on('task-status-update', refreshAfterWork);
    api.on('enrichment-status', refreshAfterWork);
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
        if (!document.hidden && (loginWaiting || Date.now() - lastRead >= 60000)) void refresh();
    }, 10000);
    mount();
})();
