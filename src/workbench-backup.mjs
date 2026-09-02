import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const WORKBENCH_BACKUP_VERSION = 'workbench-backup-v0.1';

const COMPATIBILITY_FILES = [
  'accounts.json',
  'works.json',
  'activity.json',
  'feedback.json',
  'content-tasks.json',
];

const BACKUP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function integer(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function encryptionSecret(explicit) {
  return text(explicit, text(process.env.XHS_BACKUP_ENCRYPTION_KEY, ''));
}

function normalizeRetention(input) {
  const source = input && typeof input === 'object' ? input : {};
  const keep = integer(source.keep, integer(process.env.XHS_BACKUP_RETENTION_COUNT, 0));
  const maxAgeDays = integer(source.maxAgeDays, integer(process.env.XHS_BACKUP_RETENTION_DAYS, 0));
  return { keep, maxAgeDays };
}

function encryptionKeyId(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function createEncryptionContext(secret) {
  const salt = randomBytes(16);
  return {
    key: scryptSync(secret, salt, 32),
    manifest: {
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      keyId: encryptionKeyId(secret),
    },
  };
}

function encryptionKeyFromManifest(manifest, secret) {
  if (!secret) throw new Error('校验或恢复加密备份需要 XHS_BACKUP_ENCRYPTION_KEY');
  const encryption = manifest?.encryption;
  if (!encryption || encryption.algorithm !== 'aes-256-gcm' || encryption.kdf !== 'scrypt' || !encryption.salt) {
    throw new Error('备份加密元数据无效');
  }
  if (encryption.keyId && encryption.keyId !== encryptionKeyId(secret)) {
    throw new Error('备份加密密钥不匹配');
  }
  return scryptSync(secret, Buffer.from(encryption.salt, 'base64'), 32);
}

function encryptedArtifactPath(targetPath, encrypted) {
  return encrypted ? `${targetPath}.enc` : targetPath;
}

function encryptedMetadata(metadata, cipher, iv) {
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    sizeBytes: metadata.sizeBytes,
    sha256: metadata.sha256,
  };
}

function safeBackupId(value, fallback) {
  const candidate = text(value, fallback);
  if (!BACKUP_ID_PATTERN.test(candidate)) throw new Error('备份标识只能包含字母、数字、下划线和短横线');
  return candidate;
}

function safeFilePart(value, fallback = 'asset') {
  return text(value, fallback).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || fallback;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function fileMetadata(filePath, options = {}) {
  const file = await stat(filePath);
  return {
    sizeBytes: file.size,
    sha256: options.hash === false ? null : await sha256File(filePath),
  };
}

async function encryptFile(sourcePath, targetPath, encryption) {
  const metadata = await fileMetadata(sourcePath);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryption.key, iv);
  try {
    await pipeline(createReadStream(sourcePath), cipher, createWriteStream(targetPath, { mode: 0o600 }));
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    ...metadata,
    encrypted: encryptedMetadata(metadata, cipher, iv),
  };
}

function decipherForArtifact(metadata, key) {
  const encryption = metadata?.encrypted || metadata;
  if (!encryption || encryption.algorithm !== 'aes-256-gcm' || !encryption.iv || !encryption.authTag) {
    throw new Error('加密副本元数据无效');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encryption.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encryption.authTag, 'base64'));
  return decipher;
}

async function decryptedMetadata(filePath, metadata, key) {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const sink = new Writable({
    write(chunk, encoding, callback) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(filePath), decipherForArtifact(metadata, key), sink);
  return { sizeBytes, sha256: hash.digest('hex') };
}

async function decryptFile(sourcePath, targetPath, metadata, key) {
  try {
    await pipeline(
      createReadStream(sourcePath),
      decipherForArtifact(metadata, key),
      createWriteStream(targetPath, { mode: 0o600 }),
    );
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function optionalCopy(sourcePath, targetPath, encryption = null) {
  const artifactPath = encryptedArtifactPath(targetPath, encryption);
  try {
    const metadata = await fileMetadata(sourcePath);
    const copied = encryption
      ? await encryptFile(sourcePath, artifactPath, encryption)
      : (await copyFile(sourcePath, artifactPath), metadata);
    return {
      name: basename(sourcePath),
      path: relative(dirname(targetPath), artifactPath),
      copied: true,
      sizeBytes: copied.sizeBytes,
      sha256: copied.sha256,
      ...(copied.encrypted ? { encrypted: copied.encrypted } : {}),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { name: basename(sourcePath), path: relative(dirname(targetPath), artifactPath), copied: false, reason: 'not_found' };
    }
    throw error;
  }
}

function tableCounts(db) {
  const tables = [
    'tenants',
    'customers',
    'users',
    'projects',
    'brand_profiles',
    'project_members',
    'connectors',
    'connector_grants',
    'workspace_invitations',
    'directory_sync_runs',
    'content_tasks',
    'content_task_events',
    'media_assets',
    'knowledge_documents',
    'release_drafts',
    'monitoring_accounts',
    'monitoring_works',
    'monitoring_activity',
    'monitoring_feedback',
  ];
  const available = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  return Object.fromEntries(tables.filter((table) => available.has(table)).map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0),
  ]));
}

async function mediaManifest(db, backupDir, includeMedia, encryption = null) {
  const rows = db.prepare('SELECT id, path, filename, kind, status, updated_at FROM media_assets ORDER BY id').all();
  const mediaDir = join(backupDir, 'media-assets');
  if (includeMedia) await mkdir(mediaDir, { recursive: true });
  const assets = [];
  for (const row of rows) {
    const asset = {
      id: row.id,
      sourcePath: row.path,
      filename: row.filename,
      kind: row.kind,
      status: row.status,
      updatedAt: row.updated_at,
      exists: false,
      copied: false,
      backupPath: null,
      sizeBytes: null,
      sha256: null,
    };
    try {
      const metadata = await fileMetadata(row.path, { hash: includeMedia });
      asset.exists = true;
      asset.sizeBytes = metadata.sizeBytes;
      asset.sha256 = metadata.sha256;
      if (includeMedia) {
        const targetName = safeFilePart(row.id) + '-' + safeFilePart(basename(row.path));
        const targetPath = encryptedArtifactPath(join(mediaDir, targetName), encryption);
        const copied = encryption
          ? await encryptFile(row.path, targetPath, encryption)
          : (await copyFile(row.path, targetPath), metadata);
        asset.copied = true;
        asset.backupPath = relative(backupDir, targetPath);
        if (copied.encrypted) asset.encrypted = copied.encrypted;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    assets.push(asset);
  }
  return assets;
}

export function backupDirectory(dataDir, backupId) {
  const id = safeBackupId(backupId, 'backup-invalid');
  return join(resolve(dataDir), 'backups', id);
}

function backupControlOptions(dataDir, { encryptionKey = null, offsiteDir = null, retention = null } = {}) {
  const secret = encryptionSecret(encryptionKey);
  if (secret && secret.length < 16) throw new Error('工作台备份加密密钥至少需要 16 个字符');
  const configuredOffsite = text(offsiteDir, text(process.env.XHS_BACKUP_OFFSITE_DIR, ''));
  if (configuredOffsite) {
    const sourcePath = resolve(dataDir);
    const destinationPath = resolve(configuredOffsite);
    if (pathIsWithin(sourcePath, destinationPath) || pathIsWithin(destinationPath, sourcePath)) {
      throw new Error('异地备份目录必须与工作台数据目录相互独立');
    }
  }
  const retentionOptions = normalizeRetention(retention);
  const production = process.env.NODE_ENV === 'production';
  if (production && !secret) throw new Error('生产环境创建备份必须配置 XHS_BACKUP_ENCRYPTION_KEY');
  if (production && !configuredOffsite) throw new Error('生产环境创建备份必须配置 XHS_BACKUP_OFFSITE_DIR');
  if (production && retentionOptions.keep === 0 && retentionOptions.maxAgeDays === 0) {
    throw new Error('生产环境创建备份必须配置 XHS_BACKUP_RETENTION_COUNT 或 XHS_BACKUP_RETENTION_DAYS');
  }
  return { secret, configuredOffsite, retentionOptions };
}

async function replicateBackupDirectory(backupDir, offsiteDir) {
  const destination = join(resolve(offsiteDir), basename(backupDir));
  await mkdir(resolve(offsiteDir), { recursive: true });
  await cp(backupDir, destination, { recursive: true, errorOnExist: true, force: false });
  return destination;
}

export async function createWorkbenchBackup({
  dataDir,
  db,
  backupId = null,
  now = new Date().toISOString(),
  includeMedia = false,
  encryptionKey = null,
  offsiteDir = null,
  retention = null,
} = {}) {
  if (!dataDir || !db) throw new Error('创建备份需要工作台数据目录和数据库连接');
  const controls = backupControlOptions(dataDir, { encryptionKey, offsiteDir, retention });
  const encryption = controls.secret ? createEncryptionContext(controls.secret) : null;
  const timestampPart = String(now).replace(/[^0-9]/g, '').slice(0, 17) || String(Date.now());
  const id = safeBackupId(backupId, `backup-${timestampPart}-${randomUUID().slice(0, 8)}`);
  const backupDir = backupDirectory(dataDir, id);
  await mkdir(dirname(backupDir), { recursive: true });
  await mkdir(backupDir);

  const stagingDir = encryption ? await mkdtemp(join(tmpdir(), 'workbench-backup-stage-')) : null;
  try {
    const snapshotPath = join(stagingDir || backupDir, 'workbench.sqlite');
    const databasePath = encryptedArtifactPath(join(backupDir, 'workbench.sqlite'), encryption);
    db.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
    const database = encryption
      ? await encryptFile(snapshotPath, databasePath, encryption)
      : await fileMetadata(databasePath);
    const compatibilityFiles = [];
    for (const name of COMPATIBILITY_FILES) {
      compatibilityFiles.push(await optionalCopy(join(dataDir, name), join(backupDir, name), encryption));
    }
    const mediaAssets = await mediaManifest(db, backupDir, Boolean(includeMedia), encryption);
    const manifest = {
      backupVersion: WORKBENCH_BACKUP_VERSION,
      backupId: id,
      createdAt: now,
      encryption: encryption?.manifest || null,
      includes: {
        database: true,
        compatibilityFiles: compatibilityFiles.filter((item) => item.copied).map((item) => item.name),
        mediaFiles: Boolean(includeMedia),
        encrypted: Boolean(encryption),
        offsite: Boolean(controls.configuredOffsite),
      },
      database: {
        path: relative(backupDir, databasePath),
        ...database,
      },
      compatibilityFiles,
      mediaAssets,
      counts: tableCounts(db),
      replication: controls.configuredOffsite
        ? { status: 'PENDING', directoryName: id }
        : { status: 'NOT_CONFIGURED' },
      restoreNotes: [
        '当前备份是可校验的 SQLite 快照，不包含 .env、密码、Token、Cookie 或其他密钥文件。',
        encryption
          ? '数据库、兼容文件和已复制媒体使用 AES-256-GCM 加密；恢复或校验必须提供同一密钥。'
          : '本次未启用备份加密；生产环境禁止使用未加密备份。',
        includeMedia
          ? '本次包含可读取媒体文件副本；恢复到新数据目录时需重写媒体路径并重新验证。'
          : '本次只记录媒体资产路径和文件指纹，没有复制媒体文件；需要完整媒体恢复时请使用 includeMedia=true。',
        '备份创建不会覆盖当前数据库，也不会自动切换运行中的工作台。',
      ],
    };
    const manifestPath = join(backupDir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    let offsite = null;
    if (controls.configuredOffsite) {
      try {
        const offsiteBackupDir = await replicateBackupDirectory(backupDir, controls.configuredOffsite);
        manifest.replication = { status: 'PASS', directoryName: id };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        await writeFile(join(offsiteBackupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        offsite = { status: 'PASS' };
      } catch (error) {
        manifest.replication = { status: 'FAIL', directoryName: id, error: error?.message || '异地复制失败' };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        throw new Error('异地备份复制失败：' + (error?.message || error));
      }
    }

    const retentionResult = await pruneWorkbenchBackups(dataDir, {
      ...controls.retentionOptions,
      offsiteDir: controls.configuredOffsite || null,
    });
    return {
      backupId: id,
      createdAt: now,
      directory: backupDir,
      manifestPath,
      database,
      compatibilityFiles,
      mediaAssets: mediaAssets.map(({ sourcePath, ...item }) => item),
      includes: manifest.includes,
      counts: manifest.counts,
      offsite,
      retention: retentionResult,
    };
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  }
}

async function readManifest(backupDir) {
  return JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
}

export async function verifyWorkbenchBackup(backupDir, { encryptionKey = null } = {}) {
  const result = {
    status: 'PASS',
    backupId: null,
    createdAt: null,
    checks: [],
    counts: null,
  };
  let manifest;
  try {
    manifest = await readManifest(backupDir);
    result.backupId = manifest.backupId || null;
    result.createdAt = manifest.createdAt || null;
    result.checks.push({ id: 'manifest.readable', status: 'PASS', detail: 'manifest.json 可读取' });
  } catch (error) {
    result.status = 'FAIL';
    result.checks.push({ id: 'manifest.readable', status: 'FAIL', detail: error?.message || 'manifest.json 无法读取' });
    return result;
  }

  let decryptionKey = null;
  if (manifest.encryption) {
    try {
      decryptionKey = encryptionKeyFromManifest(manifest, encryptionSecret(encryptionKey));
      result.checks.push({ id: 'encryption.key', status: 'PASS', detail: '备份加密密钥匹配' });
    } catch (error) {
      result.status = 'FAIL';
      result.checks.push({ id: 'encryption.key', status: 'FAIL', detail: error?.message || '备份加密密钥无效' });
      return result;
    }
  }

  const databaseRelativePath = manifest.database?.path || 'workbench.sqlite';
  const databaseArtifact = backupArtifactPath(backupDir, databaseRelativePath, 'SQLite 快照');
  let database;
  try {
    database = manifest.database?.encrypted
      ? await decryptedMetadata(databaseArtifact, manifest.database, decryptionKey)
      : await fileMetadata(databaseArtifact);
    const expectedHash = manifest.database?.sha256;
    const expectedSize = manifest.database?.sizeBytes;
    const matches = (!expectedHash || expectedHash === database.sha256)
      && (!Number.isInteger(expectedSize) || expectedSize === database.sizeBytes);
    result.checks.push({
      id: 'database.file',
      status: matches ? 'PASS' : 'FAIL',
      detail: matches ? 'SQLite 快照文件存在且指纹一致' : 'SQLite 快照指纹不一致',
    });
  } catch (error) {
    result.status = 'FAIL';
    result.checks.push({ id: 'database.file', status: 'FAIL', detail: error?.message || 'SQLite 快照无法读取' });
  }

  if (database) {
    let stagingDir = null;
    let readableDatabasePath = databaseArtifact;
    let db;
    try {
      if (manifest.database?.encrypted) {
        stagingDir = await mkdtemp(join(tmpdir(), 'workbench-backup-verify-'));
        readableDatabasePath = join(stagingDir, 'workbench.sqlite');
        await decryptFile(databaseArtifact, readableDatabasePath, manifest.database, decryptionKey);
        result.checks.push({ id: 'database.decrypted', status: 'PASS', detail: 'SQLite 快照已解密并通过认证标签校验' });
      }
      db = new DatabaseSync(readableDatabasePath, { readOnly: true });
      const integrity = db.prepare('PRAGMA integrity_check').get();
      const integrityValue = integrity?.integrity_check || integrity?.['integrity_check(1)'];
      const integrityOk = integrityValue === 'ok';
      result.checks.push({
        id: 'database.integrity',
        status: integrityOk ? 'PASS' : 'FAIL',
        detail: integrityOk ? 'PRAGMA integrity_check=ok' : `integrity_check=${integrityValue || 'unknown'}`,
      });
      result.counts = tableCounts(db);
      result.checks.push({ id: 'database.tables', status: 'PASS', detail: '工作台核心表可读取' });
    } catch (error) {
      result.status = 'FAIL';
      result.checks.push({ id: 'database.integrity', status: 'FAIL', detail: error?.message || 'SQLite 完整性校验失败' });
    } finally {
      db?.close();
      if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    }
  }

  for (const item of manifest.compatibilityFiles || []) {
    if (!item.copied) continue;
    try {
      const artifact = backupArtifactPath(backupDir, item.path || item.name, '兼容文件');
      const actual = item.encrypted
        ? await decryptedMetadata(artifact, item, decryptionKey)
        : await fileMetadata(artifact);
      const matches = actual.sha256 === item.sha256 && actual.sizeBytes === item.sizeBytes;
      result.checks.push({
        id: 'compatibility.' + item.name,
        status: matches ? 'PASS' : 'FAIL',
        detail: matches ? `${item.name} 指纹一致` : `${item.name} 指纹不一致`,
      });
    } catch (error) {
      result.status = 'FAIL';
      result.checks.push({ id: 'compatibility.' + item.name, status: 'FAIL', detail: error?.message || `${item.name} 无法读取` });
    }
  }

  for (const asset of manifest.mediaAssets || []) {
    if (!asset.copied || !asset.backupPath) continue;
    try {
      const actual = asset.encrypted
        ? await decryptedMetadata(backupArtifactPath(backupDir, asset.backupPath, '媒体副本'), asset, decryptionKey)
        : await fileMetadata(backupArtifactPath(backupDir, asset.backupPath, '媒体副本'));
      const matches = actual.sizeBytes === asset.sizeBytes && (!asset.sha256 || actual.sha256 === asset.sha256);
      result.checks.push({
        id: 'media.' + asset.id,
        status: matches ? 'PASS' : 'FAIL',
        detail: matches ? `${asset.filename} 副本指纹一致` : `${asset.filename} 副本指纹不一致`,
      });
    } catch (error) {
      result.status = 'FAIL';
      result.checks.push({ id: 'media.' + asset.id, status: 'FAIL', detail: error?.message || `${asset.filename} 副本无法读取` });
    }
  }

  if (result.checks.some((item) => item.status === 'FAIL')) result.status = 'FAIL';
  return result;
}

function pathIsWithin(parent, candidate) {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const relativePath = relative(parentPath, candidatePath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('../') && !isAbsolute(relativePath));
}

function backupArtifactPath(backupDir, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(label + '路径无效');
  }
  const candidate = resolve(backupDir, relativePath);
  if (!pathIsWithin(backupDir, candidate) || candidate === resolve(backupDir)) {
    throw new Error(label + '必须位于备份目录内部');
  }
  return candidate;
}

async function requireEmptyDirectory(targetDir, sourceDir) {
  const targetPath = resolve(targetDir);
  if (pathIsWithin(sourceDir, targetPath)) {
    throw new Error('恢复目标不能位于备份目录内部');
  }
  await mkdir(targetPath, { recursive: true });
  const entries = await readdir(targetPath);
  if (entries.length > 0) throw new Error('恢复目标目录必须为空：' + targetPath);
  return targetPath;
}

function replaceMappedPaths(value, pathMap) {
  let next = String(value ?? '');
  const mappings = [...pathMap].filter(([sourcePath]) => sourcePath).sort((left, right) => right[0].length - left[0].length);
  for (const [sourcePath, targetPath] of mappings) {
    next = next.split(sourcePath).join(targetPath);
  }
  return next;
}

function restoreTextTables(db, pathMap) {
  const tables = [
    ['content_tasks', 'payload_json'],
    ['content_task_events', 'data_json'],
    ['media_assets', 'metadata_json'],
    ['knowledge_documents', 'content'],
    ['knowledge_documents', 'metadata_json'],
    ['release_drafts', 'payload_json'],
    ['monitoring_accounts', 'payload_json'],
    ['monitoring_works', 'payload_json'],
    ['monitoring_activity', 'payload_json'],
    ['monitoring_feedback', 'payload_json'],
  ];
  for (const [table, column] of tables) {
    const rows = db.prepare(`SELECT id, ${column} AS value FROM ${table}`).all();
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
    for (const row of rows) {
      const next = replaceMappedPaths(row.value, pathMap);
      if (next !== row.value) update.run(next, row.id);
    }
  }
}

function rebuildKnowledgeSearchIndex(db) {
  try {
    db.exec('DELETE FROM knowledge_documents_fts');
    db.exec(`
      INSERT INTO knowledge_documents_fts (id, tenant_id, project_id, title, content)
      SELECT id, tenant_id, project_id, title, content FROM knowledge_documents
    `);
  } catch (error) {
    if (!/no such table/i.test(error?.message || '')) throw error;
  }
}

export async function restoreWorkbenchBackupToDirectory({ backupDir, targetDir, encryptionKey = null } = {}) {
  if (!backupDir || !targetDir) throw new Error('恢复需要备份目录和新的目标目录');
  const verification = await verifyWorkbenchBackup(backupDir, { encryptionKey });
  if (verification.status !== 'PASS') throw new Error('备份校验未通过，已停止恢复');
  const manifest = await readManifest(backupDir);
  const decryptionKey = manifest.encryption
    ? encryptionKeyFromManifest(manifest, encryptionSecret(encryptionKey))
    : null;
  const targetPath = await requireEmptyDirectory(targetDir, backupDir);
  const databaseArtifact = backupArtifactPath(backupDir, manifest.database?.path || 'workbench.sqlite', 'SQLite 快照');
  const targetDatabasePath = join(targetPath, 'workbench.sqlite');
  if (manifest.database?.encrypted) {
    await decryptFile(databaseArtifact, targetDatabasePath, manifest.database, decryptionKey);
  } else {
    await copyFile(databaseArtifact, targetDatabasePath);
  }

  for (const item of manifest.compatibilityFiles || []) {
    if (!item.copied) continue;
    const artifact = backupArtifactPath(backupDir, item.path || item.name, '兼容文件');
    const target = join(targetPath, item.name);
    if (item.encrypted) await decryptFile(artifact, target, item, decryptionKey);
    else await copyFile(artifact, target);
  }

  const pathMap = new Map();
  const assetTargetPaths = new Map();
  const missingMedia = [];
  const mediaDir = join(targetPath, 'media-assets');
  const copiedMedia = [];
  if (manifest.includes?.mediaFiles) await mkdir(mediaDir, { recursive: true });
  for (const asset of manifest.mediaAssets || []) {
    if (!asset.exists || !asset.copied || !asset.backupPath || !manifest.includes?.mediaFiles) {
      missingMedia.push({ id: asset.id, filename: asset.filename, reason: asset.exists ? 'media_not_included' : 'source_not_found' });
      continue;
    }
    const targetName = safeFilePart(asset.id) + '-' + safeFilePart(basename(asset.sourcePath || asset.filename));
    const targetMediaPath = join(mediaDir, targetName);
    const mediaArtifact = backupArtifactPath(backupDir, asset.backupPath, '媒体副本');
    if (asset.encrypted) await decryptFile(mediaArtifact, targetMediaPath, asset, decryptionKey);
    else await copyFile(mediaArtifact, targetMediaPath);
    assetTargetPaths.set(asset.id, targetMediaPath);
    if (!pathMap.has(asset.sourcePath)) pathMap.set(asset.sourcePath, targetMediaPath);
    copiedMedia.push({ id: asset.id, filename: asset.filename, path: targetMediaPath });
  }

  const targetDatabase = join(targetPath, 'workbench.sqlite');
  const db = new DatabaseSync(targetDatabase);
  try {
    db.exec('BEGIN');
    for (const asset of manifest.mediaAssets || []) {
      const targetMediaPath = assetTargetPaths.get(asset.id);
      if (targetMediaPath) {
        db.prepare('UPDATE media_assets SET path = ? WHERE id = ?').run(targetMediaPath, asset.id);
        db.prepare('UPDATE knowledge_documents SET source_path = ? WHERE source_path = ?').run(targetMediaPath, asset.sourcePath);
      }
    }
    restoreTextTables(db, pathMap);
    rebuildKnowledgeSearchIndex(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }

  for (const name of ['accounts.json', 'works.json', 'activity.json', 'feedback.json', 'content-tasks.json']) {
    const filePath = join(targetPath, name);
    try {
      const content = await readFile(filePath, 'utf8');
      const rewritten = replaceMappedPaths(content, pathMap);
      if (rewritten !== content) await writeFile(filePath, rewritten, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const restoreManifest = {
    restoreVersion: WORKBENCH_BACKUP_VERSION,
    sourceBackupId: manifest.backupId || null,
    restoredAt: new Date().toISOString(),
    target: 'new_empty_directory',
    encryptedSource: Boolean(manifest.encryption),
    copiedMedia,
    missingMedia,
    notes: [
      '恢复只写入新的空目录，没有覆盖当前工作台数据。',
      missingMedia.length ? '存在未包含或源文件缺失的媒体，恢复结果只能作为部分恢复，需补齐媒体后再验收。' : '媒体副本已复制并完成数据库路径重写。',
    ],
  };
  await writeFile(join(targetPath, 'restore-manifest.json'), JSON.stringify(restoreManifest, null, 2) + '\n', 'utf8');
  return {
    status: missingMedia.length ? 'PARTIAL' : 'PASS',
    sourceBackupId: manifest.backupId || null,
    targetDirectory: targetPath,
    copiedMedia,
    missingMedia,
    restoreManifestPath: join(targetPath, 'restore-manifest.json'),
  };
}

function backupCopyDirectory(root, backupId) {
  const safeId = safeBackupId(backupId, 'backup-invalid');
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, safeId);
  if (!pathIsWithin(rootPath, candidate) || candidate === rootPath) {
    throw new Error('备份清理目标路径无效');
  }
  return candidate;
}

function backupTimestamp(backup) {
  const timestamp = Date.parse(backup.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function pruneWorkbenchBackups(dataDir, {
  keep = null,
  maxAgeDays = null,
  offsiteDir = null,
  now = new Date(),
} = {}) {
  if (!dataDir) throw new Error('清理备份需要工作台数据目录');
  const retention = normalizeRetention({ keep, maxAgeDays });
  const result = {
    status: 'NOT_RUN',
    keep: retention.keep,
    maxAgeDays: retention.maxAgeDays,
    deleted: [],
    offsiteDeleted: [],
    errors: [],
  };
  if (retention.keep === 0 && retention.maxAgeDays === 0) return result;

  const configuredOffsite = text(offsiteDir, text(process.env.XHS_BACKUP_OFFSITE_DIR, ''));
  if (configuredOffsite) {
    const sourcePath = resolve(dataDir);
    const destinationPath = resolve(configuredOffsite);
    if (pathIsWithin(sourcePath, destinationPath) || pathIsWithin(destinationPath, sourcePath)) {
      throw new Error('异地备份目录必须与工作台数据目录相互独立');
    }
  }
  const backups = (await listWorkbenchBackups(dataDir))
    .filter((backup) => backup.status !== 'invalid')
    .sort((left, right) => backupTimestamp(right) - backupTimestamp(left) || right.backupId.localeCompare(left.backupId));
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  const cutoff = retention.maxAgeDays > 0 && Number.isFinite(currentTime)
    ? currentTime - retention.maxAgeDays * 24 * 60 * 60 * 1000
    : null;
  const candidates = backups.filter((backup, index) => {
    const exceedsKeep = retention.keep > 0 && index >= retention.keep;
    const exceedsAge = cutoff !== null && backupTimestamp(backup) > 0 && backupTimestamp(backup) < cutoff;
    return exceedsKeep || exceedsAge;
  });

  for (const backup of candidates) {
    try {
      await rm(backupCopyDirectory(join(resolve(dataDir), 'backups'), backup.backupId), { recursive: true, force: false });
      result.deleted.push(backup.backupId);
    } catch (error) {
      if (error?.code !== 'ENOENT') result.errors.push({ backupId: backup.backupId, location: 'local', error: error?.message || String(error) });
    }
    if (configuredOffsite) {
      try {
        await rm(backupCopyDirectory(configuredOffsite, backup.backupId), { recursive: true, force: false });
        result.offsiteDeleted.push(backup.backupId);
      } catch (error) {
        if (error?.code !== 'ENOENT') result.errors.push({ backupId: backup.backupId, location: 'offsite', error: error?.message || String(error) });
      }
    }
  }
  result.status = result.errors.length ? 'PARTIAL' : 'PASS';
  return result;
}

export async function listWorkbenchBackups(dataDir) {
  const root = join(resolve(dataDir), 'backups');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((left, right) => right.name.localeCompare(left.name))) {
    const directory = join(root, entry.name);
    try {
      const manifest = await readManifest(directory);
      backups.push({
        backupId: manifest.backupId || entry.name,
        createdAt: manifest.createdAt || null,
        backupVersion: manifest.backupVersion || null,
        includes: manifest.includes || {},
        counts: manifest.counts || {},
        directory,
        manifestPath: join(directory, 'manifest.json'),
      });
    } catch {
      backups.push({
        backupId: entry.name,
        createdAt: null,
        backupVersion: null,
        includes: {},
        counts: {},
        directory,
        manifestPath: join(directory, 'manifest.json'),
        status: 'invalid',
      });
    }
  }
  return backups;
}
