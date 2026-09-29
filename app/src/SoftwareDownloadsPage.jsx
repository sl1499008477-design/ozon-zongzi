import React from "react";
import { Button, Card, Tag } from "antd";
import { AppleOutlined, ChromeOutlined, DesktopOutlined, DownloadOutlined, WindowsOutlined } from "@ant-design/icons";
import { SourceSectionTitle } from "./SourceTable.jsx";
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_VERSION } from "./extension-page-contract.mjs";
import collector from "./collector-release.json";
import { PRODUCT_BRAND } from "./brand.js";
import "./software-downloads.css";

function CollectorDownload({ target, children, primary = true }) {
  const artifact = collector.artifacts.find(item => item.target === target);
  if (!artifact) return <div className="software-download-file"><Button disabled>{children} · 暂未发布</Button></div>;
  return <div className="software-download-file">
    <Button type={primary ? "primary" : "default"} icon={<DownloadOutlined />} href={artifact.path} download>
      {children}
    </Button>
    <span className="software-download-size">v{artifact.version || collector.version} · {(artifact.bytes / 1024 / 1024).toFixed(1)} MB</span>
  </div>;
}

const sourceTargetNames = {
  "mac-arm64": "Mac Apple 芯片",
  "mac-x64": "Mac Intel",
  "win-x64": "Windows x64",
};

function sourceFileName(file) {
  if (file.kind === "source") return "对应源码";
  if (file.name === "COPYING.GPLv3") return "GPLv3 许可证";
  if (file.name === "THIRD-PARTY-NOTICES.txt") return "第三方声明";
  if (file.kind === "building") return "构建说明";
  if (file.kind === "release") return "发行校验";
  return file.name;
}

function CollectorSources() {
  if (!collector.sources?.length) return null;
  return <>
    <p><strong>FFmpeg 对应源码与许可证：</strong>采集助手内置的 FFmpeg 与 x264 按 GPLv3 发布；各架构的对应源码、许可证和构建说明可直接下载。</p>
    {collector.sources.map(source => <p key={source.target}>
      <strong>{sourceTargetNames[source.target] || source.target}：</strong>{" "}
      {source.files.map((file, index) => <React.Fragment key={file.path}>
        {index > 0 ? " · " : null}<a href={file.path} download>{sourceFileName(file)}</a>
      </React.Fragment>)}
    </p>)}
  </>;
}

export default function SoftwareDownloadsPage() {
  return <div className="software-downloads-page">
    <SourceSectionTitle title="软件下载" subtitle={`ozon 粽子 · Web v${PRODUCT_BRAND.version} · 按你的电脑选择安装包。`} />

    <Card className="software-download-card">
      <div className="software-download-heading">
        <span className="software-download-icon"><ChromeOutlined /></span>
        <div><h3>浏览器扩展 <Tag color="blue">v{EXTENSION_VERSION}</Tag></h3><p>在 Ozon 页面采集商品、补全资料与查看算价信息。</p></div>
      </div>
      <div className="software-extension-content">
        <div>
          <p className="software-download-platform">Chrome / Edge · macOS 与 Windows 通用</p>
          <p>两个系统使用同一份扩展包，无需按电脑芯片区分。</p>
          <Button type="primary" icon={<DownloadOutlined />} href={EXTENSION_DOWNLOAD_PATH} download>下载扩展 ZIP</Button>
        </div>
        <div className="software-install-guide">
          <h4>安装与更新</h4>
          <ol>
            <li>下载并解压 ZIP，保留解压后的文件夹。</li>
            <li>打开浏览器的扩展管理页，开启“开发者模式”。</li>
            <li>选择“加载已解压的扩展程序”，选中包含 manifest.json 的文件夹。</li>
            <li>回到 Web 登录并完成扩展授权。更新后重新加载扩展，再刷新 Ozon 页面。</li>
          </ol>
        </div>
      </div>
    </Card>

    <Card className="software-download-card">
      <div className="software-download-heading">
        <span className="software-download-icon"><DesktopOutlined /></span>
        <div><h3>ozon 粽子</h3><p>按 Ozon 销售与营销数据筛选商品，加入采集箱或发送至 AI 上架。</p></div>
      </div>
      <p>同一款采集助手，按操作系统和芯片提供 3 类下载。Windows 安装版与便携版功能相同，任选其一。</p>
      <div className="software-platform-grid">
        <section className="software-platform-card">
          <AppleOutlined className="software-platform-icon" />
          <h4>Mac · Apple 芯片</h4>
          <p>macOS 12 及以上 · Apple M 系列</p>
          <CollectorDownload target="mac-arm64">下载 Mac Apple 芯片版</CollectorDownload>
          <span className="software-package-note">ZIP · 解压后拖入“应用程序”</span>
        </section>
        <section className="software-platform-card">
          <AppleOutlined className="software-platform-icon" />
          <h4>Mac · Intel 芯片</h4>
          <p>macOS 12 及以上 · Intel 处理器</p>
          <CollectorDownload target="mac-x64">下载 Mac Intel 版</CollectorDownload>
          <span className="software-package-note">ZIP · 解压后拖入“应用程序”</span>
        </section>
        <section className="software-platform-card">
          <WindowsOutlined className="software-platform-icon" />
          <h4>Windows · 64 位</h4>
          <p>Intel / AMD 处理器 · x64</p>
          <CollectorDownload target="win-x64-setup">下载安装版</CollectorDownload>
          <CollectorDownload target="win-x64-portable" primary={false}>下载便携版</CollectorDownload>
          <span className="software-package-note">EXE · 首次使用推荐安装版</span>
        </section>
      </div>
      <div className="software-desktop-notes">
        <p><strong>如何选择 Mac 版本：</strong>打开 Apple 菜单 → 关于本机；显示“芯片：Apple M…”选 Apple 芯片版，显示“处理器：Intel…”选 Intel 版。</p>
        <p><strong>使用前：</strong>确认采集助手的服务地址与当前 Web 地址一致，使用相同的账号登录，并在采集助手内登录 Ozon Seller。</p>
        <p><strong>发布状态：</strong>当前为未签名的内部测试包。Mac Apple 芯片版已有本机运行验证；Intel Mac 与 Windows 版尚待对应系统实机验证。系统可能提示未识别的开发者。</p>
        <CollectorSources />
      </div>
    </Card>
  </div>;
}
