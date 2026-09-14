/**
 * AutoDL 云 GPU Worker（SSH 直连）——S7 集成：把 HeyGem 云端实例接成平台的真实
 * talking_head 后端。
 *
 * 原理：平台批次项 → 生成克隆音色音频（豆包）→ SCP 上传音频+形象视频 → SSH 执行
 * run.py → 轮询 /root/outputs → SCP 回传本地 → 登记为媒体资产。
 * 认证：SSH 公钥（已装到实例），配置在 data/secrets/autodl-ssh.json（git 忽略）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export function loadSshConfig(explicitPath = null) {
  const candidates = [
    explicitPath,
    process.env.AUTODL_SSH_CONFIG,
    path.join(process.cwd(), 'data', 'secrets', 'autodl-ssh.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { configPath: candidate, ...JSON.parse(fs.readFileSync(candidate, 'utf-8')) };
    }
  }
  throw new Error('缺少 AutoDL SSH 配置（data/secrets/autodl-ssh.json）');
}

function sshArgs(config, remoteCommand) {
  return [
    '-p', String(config.port),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', config.keyPath,
    `${config.user}@${config.host}`,
    remoteCommand,
  ];
}

export async function sshRun(config, remoteCommand, timeoutMs = 60_000) {
  const { stdout, stderr } = await execFileAsync('ssh', sshArgs(config, remoteCommand), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { stdout, stderr };
}

export async function scpTo(config, localFile, remotePath, timeoutMs = 120_000) {
  await execFileAsync('scp', [
    '-P', String(config.port),
    '-o', 'StrictHostKeyChecking=no',
    '-i', config.keyPath,
    localFile,
    `${config.user}@${config.host}:${remotePath}`,
  ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

export async function scpFrom(config, remotePath, localFile, timeoutMs = 300_000) {
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  await execFileAsync('scp', [
    '-P', String(config.port),
    '-o', 'StrictHostKeyChecking=no',
    '-i', config.keyPath,
    `${config.user}@${config.host}:${remotePath}`,
    localFile,
  ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

/**
 * 在 HeyGem 实例上生成一条真实数字人视频。
 * @returns {Promise<{ok:boolean, localFile?:string, log?:string, error?:string}>}
 */
export async function heygemGenerate({ config = null, audioLocal, videoLocal, outName, timeoutMs = 30 * 60_000, pollIntervalMs = 15_000 }) {
  const cfg = config || loadSshConfig();
  const remoteAudio = `${cfg.inputsDir}/${outName}.mp3`;
  const remoteVideo = `${cfg.inputsDir}/${outName}-avatar.mp4`;
  const remoteOut = `${cfg.outputsDir}/${outName}-avatar_output-r.mp4`;

  await scpTo(cfg, audioLocal, remoteAudio);
  await scpTo(cfg, videoLocal, remoteVideo);

  // 后台启动生成（首次加载模型较慢），轮询输出文件
  const startCmd = `cd ${cfg.heygemDir} && rm -f ${cfg.outputsDir}/${outName}-r.mp4 && nohup ${cfg.python} run.py --audio_path ${remoteAudio} --video_path ${remoteVideo} > /root/gen-${outName}.log 2>&1 < /dev/null & echo STARTED`;
  try {
    await sshRun(cfg, startCmd, 30_000);
  } catch (error) {
    // ssh 客户端会因远端后台进程持有会话而挂到超时；只要远端命令已发出（stdout 含 STARTED）即视为成功
    if (!(error.stdout || '').includes('STARTED')) {
      return { ok: false, error: `HeyGem 启动失败：${error.message}`, log: (error.stderr || '').slice(0, 400) };
    }
  }

  const deadline = Date.now() + timeoutMs;
  let lastLog = '';
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    let log = '';
    try {
      const res = await sshRun(cfg, `tail -c 2000 /root/gen-${outName}.log 2>/dev/null; echo ---; ls ${remoteOut} 2>/dev/null`);
      log = res.stdout;
    } catch (error) {
      lastLog = `poll error: ${error.message}`;
      continue;
    }
    if (log.includes(remoteOut)) {
      const localFile = path.join('data', 'media-output', `${outName}.mp4`);
      await scpFrom(cfg, remoteOut, localFile);
      return { ok: true, localFile, log: log.slice(-800) };
    }
    lastLog = log.slice(-400);
  }
  return { ok: false, error: `生成超时（${Math.round(timeoutMs / 60_000)} 分钟）`, log: lastLog };
}

export async function checkHeygemWorker() {
  const cfg = loadSshConfig();
  const res = await sshRun(cfg, 'nvidia-smi -L | head -1; ls /root/HeyGem-Linux-Python-Hack/run.py 2>/dev/null && echo HEYGEM_READY');
  return {
    ok: res.stdout.includes('HEYGEM_READY'),
    gpu: (res.stdout.match(/NVIDIA[^\n]*/) || [])[0] || null,
    label: cfg.label,
  };
}
