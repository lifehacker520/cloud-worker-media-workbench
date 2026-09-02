# 工作台备份协议

当前版本提供“可校验快照 + 可选加密异地副本 + 保留策略”。生产环境创建备份时，服务端强制要求同时配置加密密钥、独立异地目录和保留数量/天数；没有这些配置会拒绝创建。

## 快照内容

- `workbench.sqlite` 或 `workbench.sqlite.enc`：通过 SQLite `VACUUM INTO` 生成一致性快照，包含租户、成员、客户、品牌资料、项目、连接器授权、内容任务、运行事件、媒体资产、知识文档和发布草稿。
- 兼容 JSON：如果数据目录中存在 `accounts.json`、`works.json`、`activity.json`、`feedback.json`、`content-tasks.json`，会逐个复制并记录明文 SHA-256 指纹；启用加密时副本以 `.enc` 保存。
- `manifest.json`：备份版本、创建时间、表记录数量、兼容文件、媒体资产引用和校验信息。
- 媒体文件：默认只记录原路径、存在状态和大小；只有管理员明确选择包含媒体时才复制到 `media-assets/`，启用加密时媒体副本同样加密。
- 异地副本：配置 `XHS_BACKUP_OFFSITE_DIR` 后，每个完整备份目录会复制到独立目录，并在本地和异地保留相同的 manifest。

`.env`、环境变量、密码、Token、Cookie 和浏览器会话永远不进入备份。

## 运行方式

管理员 UI 调用：

- `GET /api/workspace/backups`：列出备份目录和摘要。
- `POST /api/workspace/backups`：创建快照，JSON body 可传 `{"includeMedia":true}`；加密密钥、异地目录和保留策略由服务端环境变量控制，不接受前端传入。
- `POST /api/workspace/backups/:backupId/verify`：校验 SQLite 完整性、兼容文件和已复制媒体明文指纹；加密备份会先认证标签再解密校验。

也可以使用本地运维命令：

```text
npm run backup:workbench -- list
npm run backup:workbench -- create
npm run backup:workbench -- create --include-media
npm run backup:workbench -- verify <backupId>
npm run backup:workbench -- restore <backupId> --target <empty-directory>
npm run backup:workbench -- prune --keep 14
```

`restore` 只接受新的空目录作为目标；它会先校验备份，再复制/解密 SQLite 快照、兼容 JSON 和已包含的媒体，并重写数据库、任务事件、知识文档和兼容 JSON 中的媒体路径。恢复完成后会写入 `restore-manifest.json`，不会切换当前服务，也不会覆盖当前工作目录。备份未包含的媒体会保留记录但返回 `PARTIAL`，不能当作完整恢复通过。校验和恢复加密备份时读取 `XHS_BACKUP_ENCRYPTION_KEY`，不会把密钥写入备份或输出。

## 生产配置

```text
XHS_BACKUP_ENCRYPTION_KEY=<至少 16 个字符的随机密钥>
XHS_BACKUP_OFFSITE_DIR=/srv/cloud-worker-media-workbench-offsite/backups
XHS_BACKUP_RETENTION_COUNT=14
# 或：XHS_BACKUP_RETENTION_DAYS=30
```

异地目录必须与工作台 `data/` 相互独立；保留策略按创建时间保留最新副本，并同步清理异地副本。当前清理不会自动删除失联的异地孤儿副本，也没有磁盘空间告警，运维仍需监控存储容量。

## 当前边界

创建备份不会覆盖当前运行数据，不会自动切换服务，也不会把数据上传到未配置的外部服务。正式上线前还必须完成：

1. 为真实客户选择并提供受控异地存储目录/介质，确认保管人和密钥轮换责任；
2. 配置磁盘空间告警或外部运维监控；
3. 用用户授权的客户生产快照在隔离主机执行恢复，并对账号、监控台账、内容任务、知识文档和媒体做抽样验收；
4. 定期执行数据库版本升级、监控 SQLite 迁移后的并发恢复演练和媒体路径重写验收。

当前代码已通过临时目录的加密异地复制、保留清理、密钥校验和生产模式新空目录恢复自动化演练；这不等于真实客户数据的生产恢复已经获授权或验收通过。
