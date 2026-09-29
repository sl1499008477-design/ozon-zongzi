// Small status surface alongside the existing collector task list.
const api = window.electronAPI;
if (api) {
    const panel = document.createElement('details');
    panel.id = 'collector-enrichment-status';
    const summary = document.createElement('summary');
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    const actions = document.createElement('div');
    const login = document.createElement('button');
    login.textContent = '打开 Seller 登录';
    const resume = document.createElement('button');
    resume.textContent = '继续补全';
    const note = document.createElement('small');
    note.textContent = '本次登录期间已处理的补全任务；同一商品在不同任务中分别计数。保持助手运行即可自动补全资料。';
    const entry = document.createElement('a');
    entry.href = '#/enrichment';
    entry.textContent = '查看补全任务 →';
    entry.className = 'enrichment-entry';
    actions.append(login, resume); panel.append(summary, message, actions, entry, note); document.body.append(panel);
    let statusRevision = 0;
    function render(status) {
        if (!status) return;
        panel.hidden = status.phase === 'signed_out';
        panel.dataset.phase = status.phase;
        const abnormal = ['needs_login', 'error'].includes(status.phase);
        summary.textContent = abnormal ? '自动补全：异常'
            : status.completed ? `自动补全：已处理 ${status.completed} 件` : '自动补全：已就绪';
        message.textContent = [status.message, abnormal && status.errorDetail !== status.message ? status.errorDetail : '']
            .filter(Boolean).join('\n');
        actions.hidden = !['needs_login', 'error'].includes(status.phase);
        login.hidden = status.phase !== 'needs_login' && status.errorKind !== 'seller';
        resume.textContent = ['service', 'auth'].includes(status.errorKind) ? '重新检查' : '继续补全';
        if (status.phase === 'needs_login' || status.phase === 'error') panel.open = true;
    }
    const openLogin = async () => {
        login.disabled = true;
        const requestedRevision = statusRevision;
        try {
            const result = await api.invoke('seller-open-login');
            if (statusRevision !== requestedRevision) return;
            if (result?.code !== 200) message.textContent = result?.message || 'Seller 窗口未能打开，请重试';
            else message.textContent = '请在 Seller 窗口完成登录，然后点击“继续补全”';
        } catch { if (statusRevision === requestedRevision) message.textContent = 'Seller 窗口未能打开，请重试'; }
        finally { login.disabled = false; }
    };
    login.addEventListener('click', openLogin);
    resume.addEventListener('click', async () => {
        resume.disabled = true;
        const requestedRevision = statusRevision;
        try {
            const status = await api.invoke('enrichment-resume');
            if (statusRevision === requestedRevision) render(status);
        }
        catch { if (statusRevision === requestedRevision) message.textContent = '未能继续补全，请稍后重试'; }
        finally { resume.disabled = false; }
    });
    api.on('enrichment-status', status => { statusRevision++; render(status); });
    const initialRevision = statusRevision;
    api.invoke('enrichment-status').then(status => {
        if (statusRevision === initialRevision) render(status);
    }).catch(() => { if (statusRevision === initialRevision) panel.hidden = true; });
}
