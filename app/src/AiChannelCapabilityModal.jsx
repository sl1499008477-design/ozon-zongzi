import React, { useRef, useState } from "react";
import { Alert, Button, Descriptions, Form, Image, Input, Modal, Radio, Tag } from "antd";
import "./ai-channel-capability.css";

const stages = { queued:"等待后台测试执行", waiting_capacity: "等待请求名额", preparing: "准备样本与拼图", image: "拼图生图中", slicing: "切片与尺寸检查中", saving: "保存测试结果中", completed: "测试处理完成", text: "旧版文字测试中" };
const waitReasons = { test_queue: "等待后台测试执行", channel_busy: "等待通道当前任务完成", result_unknown: "上一请求结果待核实", billing_busy: "等待同计费账号请求名额", request_capacity: "等待全局请求名额" };
const dateText = value => value ? new Date(value).toLocaleString() : "—";

export function capabilityProgressLabel(progress, now = Date.now()) {
  const started = Date.parse(progress?.startedAt);
  let label = waitReasons[progress?.waitReason] || stages[progress?.stage] || "正在获取测试进度";
  const retryAt = Date.parse(progress?.retryAt);
  if (progress?.waitReason === "result_unknown" && Number.isFinite(retryAt)) {
    const remaining = Math.ceil((retryAt - now) / 1000);
    label += remaining > 0 ? ` · 保护期剩余${Math.floor(remaining / 60)}分${remaining % 60}秒` : " · 保护期已结束，等待后台更新";
  }
  return `${label}${Number.isFinite(started) ? ` · 已等待 ${Math.max(0, Math.floor((now - started) / 1000))} 秒` : ""}`;
}

export function capabilityResultLabel(check) {
  if (!check) return "未测试";
  if (check.type !== "GRID_SAMPLE_V1") return `旧版基础测试 · ${check.status === "PASSED" ? "通过" : check.status === "RUNNING" ? "进行中" : "未通过"}`;
  return ({ QUEUED:"能力测试排队中", RUNNING: "拼图能力测试进行中", PENDING_REVIEW: "待人工确认", PASSED: "测试通过", FAILED: "拼图能力测试失败", REVIEW_FAILED: "人工确认未通过" })[check.status] || "等待测试结果";
}

function Prompt({ prompt }) {
  return <details className="ai-channel-capability-prompt"><summary>提示词版本：{prompt?.version || "—"} · 展开原文</summary><pre>{prompt?.text || "暂无提示词"}</pre></details>;
}

function Review({ check, disabled, onSave }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  async function save(values) {
    if (lock.current || disabled) return;
    lock.current = true; setSaving(true); setError("");
    try { await onSave({ id: check.id, productCorrect: values.productCorrect, textCorrect: values.textCorrect, notes: values.notes || "" }); }
    catch (err) { setError(err.message || "人工确认保存失败，请刷新核对结果"); }
    finally { lock.current = false; setSaving(false); }
  }
  return <Form layout="vertical" className="ai-channel-capability-review" onFinish={save} disabled={saving || disabled}>
    <h3>人工确认</h3>
    <p>请逐张放大对照原图，核对产品及包装上的品牌、Logo和参数是否完整，背景是否带入店铺水印或推广联系方式。两项均选择“是”才会标记为通过；任一项选择“否”将标记为人工确认未通过。</p>
    {error && <Alert type="error" showIcon title={error} />}
    <Form.Item name="productCorrect" label="商品外观、结构和数量是否正确" rules={[{ type: "boolean", required: true, message: "请选择是或否" }]}>
      <Radio.Group options={[{ label: "是", value: true }, { label: "否", value: false }]} />
    </Form.Item>
    <Form.Item name="textCorrect" label="文字、参数和Logo是否正确" rules={[{ type: "boolean", required: true, message: "请选择是或否" }]}>
      <Radio.Group options={[{ label: "是", value: true }, { label: "否", value: false }]} />
    </Form.Item>
    <Form.Item name="notes" label="备注（可选）"><Input.TextArea rows={3} maxLength={1000} showCount /></Form.Item>
    <Button type="primary" htmlType="submit" loading={saving}>保存人工确认</Button>
  </Form>;
}

function ResultImages({ check }) {
  const sources = new Map((check.sample?.images || []).map(item => [item.index, item]));
  const results = new Map((check.images || []).map(item => [item.index, item]));
  const indices = [...new Set([...sources.keys(), ...results.keys()])].sort((a, b) => a - b);
  if (!indices.length) return <p>尚无图片结果。</p>;
  return <Image.PreviewGroup><div className="ai-channel-capability-results">
    {indices.map(index => {
      const source = sources.get(index), result = results.get(index);
      const sourceUrl = result?.sourceUrl || source?.url;
      return <article className="ai-channel-capability-pair" key={index} data-image-index={index}>
        <h4>{index + 1}. {source?.label || "商品图"}</h4>
        <div className="ai-channel-capability-pair-images">
          <div><p>原图{source?.width && source?.height ? ` · ${source.width} × ${source.height}` : ""}</p>{sourceUrl ? <Image src={sourceUrl} alt={`原图 ${index + 1}`} /> : <div className="ai-channel-capability-placeholder">原图不可用</div>}</div>
          <div><p>测试结果{result?.generatedUrl ? ` · ${result.width ?? "—"} × ${result.height ?? "—"}` : ""}</p>{result?.generatedUrl ? <Image src={result.generatedUrl} alt={`测试结果 ${index + 1}`} /> : <div className="ai-channel-capability-placeholder">尚未生成</div>}</div>
        </div>
      </article>;
    })}
  </div></Image.PreviewGroup>;
}

export default function AiChannelCapabilityModal({ channel, testSample, progress, now, progressError, submitting, busy, onStart, onReview, onRefresh, onClose }) {
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const check = channel.capability_check;
  const gridCheck = check?.type === "GRID_SAMPLE_V1";
  const running = Boolean(progress);
  const reason = !testSample?.available ? testSample?.reason || "固定样本尚未就绪，请刷新后查看。" : !channel.enabled ? "请先启用此通道再开始测试。" : channel.connection_check?.status === "MODEL_MISSING" ? "所选模型不可用，请先修改通道配置。" : submitting && !running ? "另一通道测试请求尚未结束，请稍候。" : "";
  const automatic = check?.automatic;
  const failedBeforeSlicing = check?.status === "FAILED" && ["preparing", "image"].includes(check?.failedStage);
  const automaticStatus = failedBeforeSlicing ? "NOT_RUN" : automatic?.status;
  const failedStageName = { preparing: "样本准备与拼图", image: "图片生成与接收", slicing: "切片与尺寸检查", saving: "保存测试结果" }[check?.failedStage];
  const resultMessage = check?.errorCode === "AI_GATEWAY_UNEXPECTED_EOF" && check?.failedStage === "image"
    ? "图片响应在接收过程中意外中断，未取得可用的完整图片，尚未进入切片和数量尺寸检查。平台可能已计费，请先核对通道调用记录。"
    : check?.message;
  const expected = testSample?.expected;
  async function refresh() {
    setRefreshing(true); setError("");
    try { await onRefresh(); } catch (err) { setError(err.message || "刷新失败，请稍后重试"); }
    finally { setRefreshing(false); }
  }
  async function start() {
    setError("");
    try { await onStart(); } catch (err) { setError(err.message || "请刷新核对测试结果，避免重复付费测试"); }
  }
  return <Modal centered open width={1080} className="ai-channel-capability-modal" title={`${channel.name} · 能力测试`} onCancel={onClose} footer={[
    <Button key="close" onClick={onClose}>关闭</Button>,
    <Button key="refresh" onClick={refresh} loading={refreshing}>刷新结果</Button>,
    <Button key="start" type="primary" disabled={Boolean(reason) || running || submitting || busy} loading={submitting && running} onClick={start}>{check ? "重新测试（可能产生费用）" : "开始测试（可能产生费用）"}</Button>,
  ]}>
    <Alert type="warning" showIcon title="可能产生费用" description="将调用当前通道生成一张拼图，再切成6张结果图。测试不会创建或上架商品，重新测试也可能收费。" />
    {error && <Alert type="error" showIcon title={error} />}
    {reason && <Alert type="info" showIcon title={reason} />}
    {running && <Alert type={progressError ? "warning" : "info"} showIcon title={capabilityProgressLabel(progress, now)} description={progressError ? "暂时无法读取进度，后台测试不会因此停止；请刷新核对，避免重复测试。" : "测试耗时较长，页面会自动更新。关闭弹窗或刷新页面后，可再次打开查看最新进度。"} />}
    <section className="ai-channel-capability-section">
      <h3>固定测试样本</h3>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
        { key: "sample", label: "样本 / 版本", children: `${testSample?.sample?.name || "待加载"} / ${testSample?.sample?.version || "—"}` },
        { key: "expected", label: "输出目标", children: `${expected?.count ?? 6} 张 · ${expected?.width ?? 768} × ${expected?.height ?? 1024} px` },
        { key: "image", label: "图片设置", children: `${testSample?.image?.ratio || "3:4"} · ${testSample?.image?.language === "ru" ? "俄语" : testSample?.image?.language || "俄语"} · ${testSample?.image?.quality === "high" ? "高质量" : testSample?.image?.quality || "高质量"}` },
      ]} />
      <Prompt prompt={testSample?.prompt} />
      <Image.PreviewGroup><div className="ai-channel-capability-samples">{[...(testSample?.sample?.images || [])].sort((a, b) => a.index - b.index).map(item => <figure key={item.index}><Image src={item.url} alt={`固定样本原图 ${item.index + 1}：${item.label}`} /><figcaption>{item.index + 1}. {item.label}<span>{item.width} × {item.height} px</span></figcaption></figure>)}</div></Image.PreviewGroup>
      {!!testSample?.sample?.referenceNotes?.length && <details className="ai-channel-capability-prompt"><summary>人工核对参考（{testSample.sample.referenceNotes.length}项）</summary><ul className="ai-channel-capability-notes">{testSample.sample.referenceNotes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
    </section>
    <section className="ai-channel-capability-section">
      <h3>{progress?.id && check?.id && progress.id !== check.id ? "上次测试结果" : "最新测试结果"}</h3>
      {!check ? <p>尚未测试。查看样本不会调用 AI，只有点击下方明确的测试按钮才会开始。</p> : <>
        <Alert type={check.status === "PASSED" && gridCheck ? "success" : ["FAILED", "REVIEW_FAILED"].includes(check.status) ? "error" : "info"} showIcon title={capabilityResultLabel(check)} description={resultMessage || (gridCheck ? undefined : "旧结果仅来自基础连通能力测试，不能代表正式拼图、生图和切片流程通过。以下重新测试会使用上方固定样本。")}/>
        <p className="ai-channel-capability-meta">{check.id && <span>测试 ID：{check.id}</span>}<span>开始：{dateText(check.startedAt)}</span><span>检查：{dateText(check.checkedAt)}</span>{failedStageName && <span>失败环节：{failedStageName}</span>}{check.errorCode && <span>错误码：{check.errorCode}</span>}</p>
        {gridCheck && <>
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={[
            { key: "sample", label: "本次样本版本", children: check.sample?.version || "—" },
            { key: "models", label: "本次模型", children: [check.profile?.textModel, check.profile?.imageModel].filter(Boolean).join(" / ") || "—" },
            { key: "protocol", label: "调用方式", children: check.profile?.imageProtocol === "SUB2API_OPENAI_IMAGES" ? "直接图片编辑" : check.profile?.imageProtocol === "SUB2API_RESPONSES_IMAGE_TOOL" ? "图片工具" : "—" },
          ]}/>
          <Prompt prompt={check.prompt} />
          {automatic && <div className="ai-channel-capability-automatic"><Tag color={automaticStatus === "PASSED" ? "blue" : automaticStatus === "FAILED" ? "error" : "default"}>{automaticStatus === "PASSED" ? "数量尺寸检查通过" : automaticStatus === "FAILED" ? "数量尺寸检查未通过" : automaticStatus === "NOT_RUN" ? "数量尺寸检查未执行" : "数量尺寸待检查"}</Tag><span>预期 {automatic.expectedCount ?? "—"} 张 · 实际 {automatic.actualCount ?? "—"} 张 · 目标 {automatic.expectedWidth ?? "—"} × {automatic.expectedHeight ?? "—"} px</span></div>}
          <p>按原图序号成对对照，点击图片可放大。</p>
          <ResultImages check={check} />
          {check.status === "PENDING_REVIEW" && automatic?.status === "PASSED" && <Review key={check.id} check={check} disabled={running || submitting} onSave={onReview} />}
          {check.review && <div className="ai-channel-capability-reviewed"><h3>人工确认记录</h3><p>商品外观、结构和数量：{check.review.productCorrect ? "是" : "否"}</p><p>文字、参数和Logo：{check.review.textCorrect ? "是" : "否"}</p>{check.review.notes && <p>备注：{check.review.notes}</p>}<p>确认人：{check.review.reviewedBy || "—"} · {dateText(check.review.reviewedAt)}</p></div>}
        </>}
      </>}
    </section>
  </Modal>;
}
