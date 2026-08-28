# 销售内容雷达｜给客户使用的最短部署路径

这份 Demo 现在适合“单客户私有试用”：一个共享工作区、一个客户成员账号、一个管理员账号。客户可以加入监控账号、查看作品、提交反馈；管理员可以查看账号加入记录、刷新结果、已读动作和反馈。

当前文档只覆盖 Web 服务部署。桌面安装包由公开 GitHub 仓库的 Release 提供；GitHub 不承载运行数据，也不替代中央监控服务。

## 客户端与中央服务的关系

直接下载安装包时，客户端默认在客户电脑本地运行，每台电脑有自己的 data 数据目录。你要在自己的管理员端持续看到客户新增的账号和作品，需要先按下面的 B 路径部署一个中央服务，再让客户端通过用户数据目录里的 client-config.json 指向该服务：

    {"remoteUrl":"https://你的服务域名"}

这一步是“多人共用一个工作台”的前提；只把安装包发给客户，不会自动把客户电脑上的数据汇聚到你的电脑。

## 先理解两种分享方式

### A. 立刻给客户演示：临时公网地址

在你本机启动带认证的服务，再用 Cloudflare Quick Tunnel 临时转发：

    XHS_AUTH_REQUIRED=true XHS_AUTH_SECRET=自己生成的随机长字符串 XHS_ADMIN_PASSWORD=管理员密码 XHS_CLIENT_PASSWORD=客户密码 XHS_COOKIE_SECURE=false npm start

另开一个终端：

    cloudflared tunnel --url http://127.0.0.1:3188

它会生成一个随机的 trycloudflare.com 地址，把这个地址和客户密码发给客户即可。这个方式依赖你的电脑和终端一直在线，只适合短时间测试；不要把它当作正式客户服务。Cloudflare 官方也明确说明 Quick Tunnel 面向测试/开发，没有正式服务等级保障。

### B. 正式给一个客户试用：VPS/云服务器 + Docker + 域名 HTTPS

这是建议的最短正式路径：

1. 准备一台可以长期运行的 VPS/云服务器，安装 Docker、Docker Compose 和 Caddy。
2. 把整个 xhs-content-monitor-demo/ 目录复制到服务器。
3. 在服务器执行：

       cp .env.example .env

   编辑 .env，至少替换：

   - XHS_AUTH_SECRET：随机长字符串；
   - XHS_ADMIN_PASSWORD：你自己的管理员密码；
   - XHS_CLIENT_PASSWORD：给客户的成员密码；
   - XHS_REFRESH_MINUTES：服务端刷新间隔，试用可填 30；
   - XHS_COOKIE_SECURE=true：正式 HTTPS 保持为 true。

4. 启动并检查：

       docker compose up -d --build
       curl http://127.0.0.1:3188/api/health

   首次启动会从 config/accounts.seed.json 建立账号台账，并在后台执行一次刷新。data/ 在 Docker volume 中持久化，容器重启不会丢账号、作品、已读状态、活动和反馈。

5. 把域名的 DNS A 记录指向服务器 IP，并把 Caddyfile.example 复制为 Caddy 配置，把 radar.example.com 换成你的真实域名：

       radar.example.com {
           encode gzip
           reverse_proxy 127.0.0.1:3188
       }

   放行服务器 80/443 端口后，Caddy 会负责 HTTPS 证书和续期。完成后把 https://你的域名 发给客户。

## 交付后的使用闭环

1. 你用 admin 登录：查看账号台账、作品流、刷新活动和客户反馈。
2. 客户用 client 登录：添加/查看需要监控的公开主页，点击刷新，提交问题和功能建议。
3. 服务端按 XHS_REFRESH_MINUTES 自动刷新；客户不打开浏览器时也会继续运行。
4. 你在本地修改代码，验证通过后重新构建发布客户端；中央 Web 服务则重新部署：

       docker compose up -d --build

   Docker volume 中的运行数据会保留。

   客户端发布命令：

       git tag v0.1.1
       git push origin v0.1.1

   GitHub Actions 会构建 macOS/Windows 安装包并更新 Release。客户打开客户端的“检查更新”即可获取新版本。

## 上线前验收

- [ ] 用客户账号登录成功，能新增一个监控账号。
- [ ] 用管理员账号登录成功，能看到该账号的加入活动。
- [ ] 客户提交一条反馈，管理员观察区能看到。
- [ ] 手动刷新后，作品流和账号状态正常更新。
- [ ] 重启容器后，账号、作品、反馈仍然存在。
- [ ] 通过 HTTPS 域名访问，浏览器没有证书或登录循环问题。
- [ ] 已告知客户：当前只读取公开主页，不访问私密内容，不绕过验证码或登录限制。

## 必须知道的边界

- 这是单客户试用版，不是多租户 SaaS；当前所有登录用户共享一个工作区。
- 数据用 JSON 文件保存，适合小规模试用；客户数和数据量上来后应迁移到 SQLite/Postgres，并加入租户隔离、邀请、密码重置和更细权限。
- 服务端自动刷新是定时轮询，不等于平台实时推送；小红书页面结构或限流策略变化时，账号可能进入“需处理”。
- .env 含密码和签名密钥，不能提交到代码仓库或发给客户。
- 未签名的 macOS/Windows 安装包可能出现系统安全提示；正式规模化交付前应补充 Apple Developer / Windows 代码签名和公证。
