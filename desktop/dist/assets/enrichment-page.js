import { b as h } from './index-A-3CMN9t.js';

const api = () => window.electronAPI;
const count = value => Number(value) || 0;
function taskStatus(task) {
    if (task.controlState === 'CANCELLED') return '已取消';
    if (task.controlState === 'PAUSED') return '已暂停';
    if (task.processing) return '补全中';
    if (task.pending) return '等待补全';
    if (task.failed) return '补全失败';
    return '已完成';
}
function batchTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '历史批次' : date.toLocaleString('zh-CN', { hour12: false });
}

export default {
    name: 'EnrichmentTasks',
    data() {
        return { tasks: [], loading: true, refreshing: false, loadError: '', actionError: '', notice: '', busyKey: '',
            pendingCancel: null, requestVersion: 0, alive: false, timer: null, onStatus: null,
            status: { phase: 'idle', message: '' } };
    },
    mounted() {
        this.alive = true;
        this.onStatus = status => { if (this.alive) this.status = status || this.status; };
        api().on('enrichment-status', this.onStatus);
        api().invoke('enrichment-status').then(this.onStatus).catch(() => {});
        void this.refresh();
        this.timer = window.setInterval(() => { void this.refresh(); }, 5000);
    },
    beforeUnmount() {
        this.alive = false;
        this.requestVersion++;
        window.clearInterval(this.timer);
        api().off('enrichment-status', this.onStatus);
    },
    methods: {
        async refresh() {
            if (this.busyKey || this.refreshing) return;
            const version = ++this.requestVersion;
            this.refreshing = true;
            try {
                const result = await api().invoke('enrichment-tasks');
                if (!this.alive || version !== this.requestVersion) return;
                if (result?.code !== 200 || !Array.isArray(result.data)) throw new Error(result?.message || '返回数据异常');
                this.tasks = result.data;
                this.loadError = '';
            } catch (error) {
                if (this.alive && version === this.requestVersion) this.loadError = `任务读取失败：${error.message || '请稍后重试'}，请点击刷新。`;
            } finally {
                if (this.alive && version === this.requestVersion) { this.loading = false; this.refreshing = false; }
            }
        },
        async control(task, action) {
            if (this.busyKey) return;
            this.requestVersion++;
            this.refreshing = false;
            this.busyKey = task.key;
            this.actionError = ''; this.notice = '';
            try {
                const result = await api().invoke('enrichment-task-control', { taskKey: task.key, action });
                if (!this.alive) return;
                if (result?.code !== 200 || result.data?.key !== task.key) throw new Error(result?.message || '未收到操作确认，请刷新核对');
                this.tasks = this.tasks.map(current => current.key === task.key ? result.data : current);
                this.pendingCancel = null;
                this.notice = `${task.name}：${{ pause: '已暂停补全', resume: '已恢复，等待继续补全', cancel: '已取消补全，已采集资料保留' }[action]}`;
            } catch (error) {
                if (this.alive) this.actionError = `操作未确认：${error.message || '请刷新后核对'}`;
            } finally {
                if (this.alive) this.busyKey = '';
            }
        },
        async checkService(openSeller = false) {
            this.actionError = '';
            try {
                if (openSeller) {
                    const result = await api().invoke('seller-open-login');
                    if (result?.code !== 200) throw new Error(result?.message || 'Seller 登录窗口未能打开');
                } else {
                    const status = await api().invoke('enrichment-resume');
                    if (this.alive) this.status = status;
                }
            } catch (error) { if (this.alive) this.actionError = error.message; }
        },
    },
    render() {
        const button = (label, onClick, extra = {}) => h('button', { type: 'button', onClick, ...extra }, label);
        const finished = this.tasks.filter(task => taskStatus(task) === '已完成').length;
        const remaining = this.tasks.filter(task => !['已完成', '已取消'].includes(taskStatus(task))).length;
        const errorStatus = ['error', 'needs_login'].includes(this.status.phase);
        return h('section', { class: 'enrichment-page', 'aria-label': '资料补全' }, [
            h('header', { class: 'enrichment-heading' }, [
                h('div', null, [h('div', { class: 'eyebrow' }, 'OZON SELLER WORKSPACE'), h('h1', null, '资料补全'),
                    h('p', null, '按采集任务分别管理。暂停或取消补全会保留已采集资料，其他任务继续处理。')]),
                button(this.refreshing ? '刷新中…' : '刷新', () => this.refresh(), { disabled: this.refreshing || Boolean(this.busyKey) }),
            ]),
            h('div', { class: 'enrichment-overview' }, [h('span', null, `采集批次 ${this.tasks.length}`),
                h('span', null, `待处理 ${remaining}`), h('span', null, `已完成 ${finished}`)]),
            errorStatus ? h('div', { class: 'enrichment-notice warning', role: 'status' }, [
                h('span', null, this.status.message),
                this.status.phase === 'needs_login' || this.status.errorKind === 'seller'
                    ? button('打开 Seller 登录', () => this.checkService(true)) : null,
                button(this.status.phase === 'needs_login' ? '继续补全' : '重新检查', () => this.checkService()),
            ]) : null,
            this.loadError ? h('p', { class: 'enrichment-notice error', role: 'alert' }, this.loadError) : null,
            this.actionError ? h('p', { class: 'enrichment-notice error', role: 'alert' }, this.actionError) : null,
            this.notice ? h('p', { class: 'enrichment-notice success', role: 'status' }, this.notice) : null,
            h('div', { class: 'enrichment-table-wrap' }, [h('table', { class: 'enrichment-table' }, [
                h('thead', null, [h('tr', null, ['采集任务 / 批次', '状态', 'SKU 补全进度', '当前商品 / 说明', '操作'].map(label => h('th', { scope: 'col' }, label)))]),
                h('tbody', null, this.tasks.length ? this.tasks.map(task => {
                    const label = taskStatus(task), incomplete = count(task.total) > count(task.completed);
                    const active = task.controlState === 'ACTIVE';
                    return h('tr', { key: task.key, 'data-task-key': task.key }, [
                        h('td', null, [h('strong', null, task.name), h('small', null, batchTime(task.createdAt))]),
                        h('td', null, [h('span', { class: `enrichment-badge ${task.controlState.toLowerCase()}` }, label)]),
                        h('td', null, [h('span', null, `已完成 ${count(task.completed)} / ${count(task.total)}`),
                            h('progress', { max: Math.max(1, count(task.total)), value: count(task.completed), 'aria-label': `${task.name} SKU 补全进度` }),
                            h('small', null, `待补全 ${count(task.pending)} · 补全中 ${count(task.processing)} · 失败 ${count(task.failed)}`)]),
                        h('td', null, [h('span', null, task.currentSkus?.length ? task.currentSkus.map(sku => `SKU ${sku}`).join('、') : '—'),
                            task.errorMessage && !['PAUSED', 'CANCELLED'].includes(task.controlState) ? h('small', { class: 'enrichment-task-error' }, task.errorMessage) : null]),
                        h('td', null, [h('div', { class: 'enrichment-task-actions' }, [
                            active && incomplete ? button('暂停', () => this.control(task, 'pause'), { disabled: Boolean(this.busyKey) }) : null,
                            task.controlState === 'PAUSED' ? button('恢复', () => this.control(task, 'resume'), { disabled: Boolean(this.busyKey) }) : null,
                            incomplete && task.controlState !== 'CANCELLED' ? button('取消补全', () => { this.pendingCancel = task; this.actionError = ''; }, { class: 'danger', disabled: Boolean(this.busyKey) }) : null,
                            this.busyKey === task.key ? h('small', { role: 'status' }, '正在保存…') : null,
                        ])]),
                    ]);
                }) : [h('tr', null, [h('td', { colspan: 5, class: 'enrichment-empty' }, this.loading ? '正在读取补全任务…' : this.loadError ? '未能读取任务，请刷新重试' : '暂无资料补全任务')])]),
            ])]),
            this.pendingCancel ? h('dialog', { class: 'enrichment-confirm', role: 'alertdialog', 'aria-label': '取消资料补全',
                ref: node => { if (node && !node.open) node.showModal(); },
                onCancel: event => { if (this.busyKey) event.preventDefault(); else this.pendingCancel = null; } }, [
                h('h2', null, '取消这个任务的资料补全？'), h('strong', null, this.pendingCancel.name),
                h('p', { class: 'enrichment-batch-time' }, batchTime(this.pendingCancel.createdAt)),
                h('p', null, '将停止该批次剩余商品的资料补全。已采集商品和已补全资料会保留，其他采集任务不受影响。'),
                h('p', null, '需要稍后继续处理时，请选择“暂停”。'),
                this.actionError ? h('p', { role: 'alert', class: 'enrichment-task-error' }, this.actionError) : null,
                h('div', { class: 'enrichment-confirm-actions' }, [
                    button('返回', () => { this.pendingCancel = null; }, { disabled: Boolean(this.busyKey) }),
                    button(this.busyKey ? '正在取消…' : '确认取消', () => this.control(this.pendingCancel, 'cancel'), { class: 'danger', disabled: Boolean(this.busyKey) }),
                ]),
            ]) : null,
        ]);
    },
};
