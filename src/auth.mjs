import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SESSION_COOKIE = 'xhs_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_SECRET =
  process.env.XHS_AUTH_SECRET || randomBytes(32).toString('hex');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const AUTH_REQUIRED = process.env.XHS_AUTH_REQUIRED === 'true' || IS_PRODUCTION;

const ADMIN_PASSWORD = process.env.XHS_ADMIN_PASSWORD || null;
const CLIENT_PASSWORD = process.env.XHS_CLIENT_PASSWORD || null;
const DEFAULT_TENANT_ID = process.env.XHS_DEFAULT_TENANT_ID || 'tenant_local';
const ADMIN_TENANT_ID = process.env.XHS_ADMIN_TENANT_ID || DEFAULT_TENANT_ID;
const CLIENT_TENANT_ID = process.env.XHS_CLIENT_TENANT_ID || DEFAULT_TENANT_ID;

const ROLE_PERMISSIONS = {
  admin: [
    'workspace.read',
    'workspace.manage',
    'content.read',
    'content.write',
    'content.review',
    'connector.manage',
    'connector.use',
    'publish.approve',
  ],
  client: [
    'workspace.read',
    'content.read',
    'content.write',
    'content.review',
    'connector.use',
  ],
};

let userDirectoryLookup = null;

if (
  AUTH_REQUIRED &&
  (!process.env.XHS_AUTH_SECRET || !ADMIN_PASSWORD || !CLIENT_PASSWORD)
) {
  throw new Error(
    '认证模式需要设置 XHS_AUTH_SECRET、XHS_ADMIN_PASSWORD 和 XHS_CLIENT_PASSWORD',
  );
}

function safeSecretEqual(expected, candidate) {
  if (!expected || typeof candidate !== 'string') {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signature(payload) {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function authRequired() {
  return AUTH_REQUIRED;
}

function tenantIdForUsername(username) {
  return username === 'admin' ? ADMIN_TENANT_ID : CLIENT_TENANT_ID;
}

function userPayload(username, role, displayName, tenantId = tenantIdForUsername(username)) {
  return {
    username,
    role,
    displayName,
    tenantId,
    permissions: ROLE_PERMISSIONS[role] || [],
  };
}

export function configureUserDirectory(lookup) {
  userDirectoryLookup = typeof lookup === 'function' ? lookup : null;
}

function authenticateDirectoryUser(username, password) {
  if (!userDirectoryLookup || typeof password !== 'string' || !password) return null;
  let entry;
  try {
    entry = userDirectoryLookup(username);
  } catch {
    return null;
  }
  if (!entry?.passwordHash || !entry.passwordSalt || entry.status === 'disabled') return null;
  try {
    const candidateHash = scryptSync(password, entry.passwordSalt, 32).toString('hex');
    if (!safeSecretEqual(entry.passwordHash, candidateHash)) return null;
    return userPayload(entry.username, entry.role, entry.displayName, entry.tenantId);
  } catch {
    return null;
  }
}

export function authConfig() {
  return {
    required: authRequired(),
    localDefaults: !IS_PRODUCTION && !process.env.XHS_AUTH_REQUIRED,
    tenantModel: 'tenant_project_rbac',
    persistentMemberDirectory: Boolean(userDirectoryLookup),
  };
}

export function authenticate(username, password) {
  const normalizedUsername =
    typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (normalizedUsername === 'admin' && safeSecretEqual(ADMIN_PASSWORD, password)) {
    return userPayload('admin', 'admin', '管理员');
  }
  if (normalizedUsername === 'client' && safeSecretEqual(CLIENT_PASSWORD, password)) {
    return userPayload('client', 'client', '客户成员');
  }
  return authenticateDirectoryUser(normalizedUsername, password);
}

export function sessionCookie(user) {
  const payload = encode(
    JSON.stringify({
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      tenantId: user.tenantId || tenantIdForUsername(user.username),
      permissions: user.permissions || ROLE_PERMISSIONS[user.role] || [],
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  );
  const token = payload + '.' + signature(payload);
  const secure = process.env.XHS_COOKIE_SECURE === 'true' || IS_PRODUCTION;
  return (
    SESSION_COOKIE +
    '=' +
    token +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    SESSION_TTL_SECONDS +
    (secure ? '; Secure' : '')
  );
}

export function clearSessionCookie() {
  const secure = process.env.XHS_COOKIE_SECURE === 'true' || IS_PRODUCTION;
  return (
    SESSION_COOKIE +
    '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' +
    (secure ? '; Secure' : '')
  );
}

function cookieValue(request) {
  const header = request.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      return valueParts.join('=');
    }
  }
  return null;
}

export function currentUser(request) {
  if (!authRequired()) {
    return {
      username: 'local',
      role: 'admin',
      displayName: '本地开发者',
      tenantId: DEFAULT_TENANT_ID,
      permissions: ROLE_PERMISSIONS.admin,
    };
  }

  const token = cookieValue(request);
  if (!token) {
    return null;
  }

  const [payload, providedSignature] = token.split('.');
  if (!payload || !safeSecretEqual(signature(payload), providedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decode(payload));
    if (!parsed.username || !parsed.role || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (userDirectoryLookup) {
      let directoryEntry = null;
      try {
        directoryEntry = userDirectoryLookup(parsed.username);
      } catch {
        directoryEntry = null;
      }
      if (directoryEntry?.status === 'disabled') return null;
      if (directoryEntry) {
        return userPayload(
          directoryEntry.username,
          directoryEntry.role,
          directoryEntry.displayName,
          directoryEntry.tenantId,
        );
      }
    }
    return {
      username: parsed.username,
      role: parsed.role,
      displayName: parsed.displayName || parsed.username,
      tenantId: parsed.tenantId || tenantIdForUsername(parsed.username),
      permissions: parsed.permissions || ROLE_PERMISSIONS[parsed.role] || [],
    };
  } catch {
    return null;
  }
}

export function isAdmin(user) {
  return user?.role === 'admin';
}

export { SESSION_COOKIE };
