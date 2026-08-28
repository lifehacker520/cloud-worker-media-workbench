# 抖音采集适配路线

## 当前实测

测试链接：

https://v.douyin.com/nXMZhZv_tZ4/

它可以解析并跳转到博主“技术爬爬虾”的抖音主页，但无登录会话的服务端 HTML 请求会返回安全校验页面。因此当前 Demo 会把账号标记为“需处理”，不会把“请求成功”误当成“已经拿到作品”。

## 可复用的开源方向

- [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)：展示了用 Playwright/CDP 保存登录态、采集多个平台的整体架构。它的项目说明包含学习用途和非商业使用限制，不能直接复制进商业客户端。
- [douyin-monitor](https://github.com/eric1981/douyin-monitor)：使用 Playwright 打开创作者主页并监听页面 API，请求作品列表时依赖用户主动登录后的持久化 Cookie。
- [douyin-cli](https://github.com/Yht20927/douyin-cli)：支持用抖音主页 URL 或 sec_user_id 获取用户作品，适合参考作品字段、分页和标准化结构。
- 自有账号或获得授权的账号，优先评估[抖音开放平台](https://developer.open-douyin.com/docs/resource/zh-CN/developer/introduction/overview)的官方数据能力。

## 本项目建议

下一阶段增加独立的“抖音浏览器会话采集器”：

1. 用户在专用浏览器配置中主动登录抖音并完成平台要求的验证。
2. 采集器通过 Playwright/CDP 打开主页，只读取页面已经返回的公开作品数据。
3. 拦截或读取作品列表响应，统一转换为本项目的标题、发布时间、封面、作品链接和指纹字段。
4. 复用现有去重、最新排序、红色未读提醒和账号已读接口。
5. 登录过期、验证码或安全校验时，显示明确的“需要重新登录/人工处理”，不尝试绕过安全机制。

这样可以继续保持免费自建，同时把抖音采集和现有的小红书公开 HTML 采集器隔离，平台规则变化时不会拖垮整个工作台。
