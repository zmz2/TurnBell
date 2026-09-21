# TurnBell 1.6.0：macOS 安装与系统通知设置

TurnBell 是 Chromium 浏览器扩展，不是独立 Mac App。macOS 版使用浏览器扩展通知 API；Chrome 会把扩展通知交给 macOS 原生通知系统和通知中心，不需要安装 EXE、`.app` 辅助程序、Homebrew 包或本地服务。参考 [Chrome for Developers：macOS 原生通知系统](https://developer.chrome.com/blog/native-mac-os-notifications)。

## 安装

1. 在 GitHub 仓库页面点击 **Code → Download ZIP** 并完整解压；如果你拿到单独的 `TurnBell-1.6.0-macOS.zip`，也可以使用该版本包。
2. 在 Google Chrome 打开 `chrome://extensions/`，或在 Microsoft Edge 打开 `edge://extensions/`。
3. 开启页面上的 **开发人员模式**。
4. 点击 **加载未打包的扩展程序**（Edge 中显示为 **加载解压缩的扩展**）。
5. 选择解压目录中的 `extension` 文件夹；如果下载的是 macOS 发布包，它位于 `TurnBell-1.6.0-macOS/extension`。
6. 将 TurnBell 固定到工具栏，然后刷新已经打开的 ChatGPT 标签页。

更新时，在扩展管理页点击 TurnBell 卡片上的 **重新加载**，再刷新已打开的 ChatGPT 标签页。请只安装一个 TurnBell 实例，避免重复提醒。

## 开启 macOS 通知

1. 点击工具栏中的 TurnBell，打开弹窗。
2. 保持 **浏览器扩展通知 API（推荐）**。这是默认通知通道，会使用浏览器在 macOS 上接入的系统通知。
3. 开启 **提示音**，并保持 **macOS 系统默认通知声（推荐）**；点击 **测试所选通知通道**。
4. 打开 macOS **系统设置 → 通知**，选择 **Google Chrome** 或 **Microsoft Edge**，开启 **允许通知**。
5. 按需要选择横幅或提醒样式、通知中心显示方式和声音。若开启了专注模式或定时摘要，也请检查相应设置。

系统通知权限由 macOS 控制。TurnBell 的“打开浏览器通知设置”按钮会打开 Chrome 或 Edge 自己的通知权限页；它不能代替 macOS 系统设置中的“允许通知”开关。

若想试听 TurnBell 自带音效，可在 **提示音样式** 中选择柔和双音、温暖铃声、玻璃轻响、轻柔气泡或数字提示，再点 **试听**。选内置音效时系统通知声会静音，避免同时播放两种声音。

## 验证回复提醒

1. 刷新一个已有 ChatGPT 对话，等待历史内容加载完成。预期不弹通知。
2. 在 ChatGPT 输入框用 Enter 发送新问题。
3. 切换到其他标签页或应用，等待回答完成。
4. 回答稳定并出现最终操作栏后，macOS 通知中心应收到一条 TurnBell 通知，工具栏图标出现 `✓`。

TurnBell 每轮最多提醒一次。回答仍在变化、最终完成证据不足时会选择不提醒。扩展只在本机观察页面已经显示的 DOM，不读取 Cookie 或上传回答正文；完整说明见 [隐私说明](PRIVACY.md)。

## 排障

- 点击测试按钮后弹窗报告浏览器已接受通知，但没有横幅：在 **系统设置 → 通知** 中检查浏览器是否允许通知、提醒样式是否设为横幅或提醒，并检查专注模式。
- 通知进入摘要或通知中心但没有即时显示：检查 macOS 的定时摘要、专注模式以及浏览器的通知样式。
- 没有系统默认声音：检查 TurnBell 的提示音开关、macOS 中浏览器的通知声音设置和系统音量；内置音效可用 **试听** 单独检查。
- 测试通知没有被接受：在扩展管理页确认 TurnBell 已启用且权限可用，重新加载扩展，再次打开 ChatGPT 标签页。
- Edge 或其他 Chromium 浏览器：通知系统接入由浏览器决定；TurnBell 已针对 Chromium 扩展 API 适配，但 macOS 实机验证仍需在目标浏览器上完成。

## 兼容范围

TurnBell 面向桌面版 Chromium 浏览器，当前要求 Chrome 111 或兼容版本。Chrome on macOS 的原生通知路由有官方文档说明；本版本代码为 macOS 通知中心准备了安装包和系统设置指引。macOS 的实际横幅、声音、锁屏补发及 Edge 展示效果尚未在本次发布中实机验证。Safari、iOS 和 Android 不在支持范围内。
