# 销售内容雷达｜小红书内容监控工作台

这是一个开源的 P0 工作台，用来把销售的小红书主页集中到一个界面里，定期读取公开主页，去重并展示新发现的作品。项目同时提供 Web 版和可下载的 Electron 桌面客户端，后续可以继续加入 AI 分析、提醒和更多平台。

项目地址：[github.com/lifehacker520/xhs-content-monitor](https://github.com/lifehacker520/xhs-content-monitor)

## 启动

要求 Node.js 22 或以上。在终端执行：

    cd "/Users/rancemac/Documents/obsidian/AI操作系统/tmp/xhs-content-monitor-demo"
    npm start

然后打开 <http://127.0.0.1:3188>。本地开发模式默认直接进入工作台；部署到生产环境时会启用登录。

首次启动会自动读取 config/accounts.seed.json 中的 16 个账号。服务启动后会在后台进行一次刷新；也可以点击右上角“刷新全部”。

## 下载客户端

打开 GitHub 的 [Releases](https://github.com/lifehacker520/xhs-content-monitor/releases) 页面，下载对应系统的安装包。客户端默认在本机运行，数据保存在当前用户的应用数据目录，不会写入 GitHub。

本地开发和打包命令：

    npm install
    npm run desktop       # 启动桌面开发版
    npm run dist:mac      # 构建 macOS DMG 和 ZIP
    npm run dist:win      # 在 Windows 构建 Windows 安装包

客户端右上角的“检查更新”会检查 GitHub Release；发现新版本后可以下载并重启安装。普通代码提交不会直接触发用户更新，发布新版本时使用版本标签，例如：

    git tag v0.1.1
    git push origin v0.1.1

GitHub Actions 会在 macOS 和 Windows 环境构建安装包并上传到 Release。客户端更新依赖已发布的 Release 和安装包，不依赖客户自行拉取源码。

如果以后要让桌面客户端连接中央服务，可在客户端用户数据目录创建 client-config.json：

    {"remoteUrl":"https://你的服务域名"}

没有该配置时，客户端使用内置的本地服务和本机数据，适合单机试用；多人共享同一套监控台账时，应部署中央服务并让客户端指向该地址。

## 当前实现

- 支持 xhslink.cn/m/...、xhslink.com/m/... 分享短链和小红书完整主页链接。
- 短链跟随跳转得到用户 ID；保存时只保存短码、用户 ID 和不带查询参数的主页地址，不保存 xsec_token。
- 从公开主页 HTML / 内嵌状态中提取作品标题、时间、点赞数和可用的作品链接。
- 首次刷新建立基线；后续刷新对新指纹标记“新发现”。
- 账号、作品和已读状态保存在服务端 data/ 中；桌面客户端会把它们保存到当前用户的应用数据目录。
- 支持管理员/客户成员两种角色，记录账号加入、刷新、已读和反馈活动。
- 提供反馈入口与管理员观察区，管理员可查看客户反馈和使用活动。
- 服务端可通过 XHS_REFRESH_MINUTES 配置定时刷新，客户关闭浏览器后仍会继续监控。
- 提供 Docker、Docker Compose、Caddy HTTPS 配置示例和部署说明，详见 [DEPLOY.md](DEPLOY.md)。
- 提供本地 API：/api/health、/api/auth/*、/api/state、/api/refresh、/api/accounts、/api/works/seen、/api/feedback、/api/activity。

## 已知边界

这是可运行的单客户验证版，不是多租户生产 SaaS。小红书页面结构和反爬策略可能变化；部分主页虽然能返回作品标题，但没有稳定的 noteId，这类作品会先链接回主页。触发限流时，账号会显示“需处理”，不会伪造成功结果。运行数据使用 JSON 文件，适合小规模试用，后续扩大客户数时应迁移到数据库并增加租户隔离。

客户端当前默认是“每台电脑一份本地数据”。如果需要你在管理员端监控客户电脑上的统一笔记，必须把 Web 服务部署到一台长期在线的服务器，客户客户端通过 client-config.json 连接同一个中央地址；GitHub 只负责代码和安装包分发，不负责实时业务数据同步。

当前没有接入 Coze、AI 摘要、钉钉/飞书通知、抖音或视频号。下一阶段可以增加浏览器采集适配器、AI 标签与摘要、人工确认队列和通知 Webhook。

不要用这个 Demo 访问私密内容或绕过验证码、登录限制和平台安全机制；正式使用前应取得账号使用者和组织的必要授权，并评估平台规则。

## 测试

    npm run check
    npm test
