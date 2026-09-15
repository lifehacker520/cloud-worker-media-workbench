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
  /* run.py 以「视频文件 basename」命名产出；outName 可能被截断，故必须按实际上传名推导，否则轮询永不匹配（G9-01 实测 Bug） */
  const remoteVideoBase = remoteVideo.split('/').pop().replace(/\.[^./]+$/, '');
  const remoteOut = `${cfg.outputsDir}/${remoteVideoBase}_output-r.mp4`;

  await scpTo(cfg, audioLocal, remoteAudio);
  await scpTo(cfg, videoLocal, remoteVideo);

  // 可靠性：改为远端脚本方式（复杂链式 ssh 命令曾在真实环境失败；脚本可独立测试与复用）
  // 脚本负责：陈旧锁回收 → 原子抢锁 → 清理孤儿 run.py → 写启动时间戳 → nohup 起 run.py
  const runnerScript = path.join('tools', 'media-model-worker', 'heygem-run.sh');
  if (fs.existsSync(runnerScript)) {
    await scpTo(cfg, runnerScript, '/root/heygem-run.sh');
  }
  const lockDir = '/root/.heygem-lock';
  const startCmd = `chmod +x /root/heygem-run.sh && bash /root/heygem-run.sh '${remoteAudio}' '${remoteVideo}' '${outName}'`;
  try {
    await sshRun(cfg, startCmd, 60_000);
  } catch (error) {
    const stdout = error.stdout || '';
    if (stdout.includes('LOCKED_BY_OTHER_RUN')) {
      return { ok: false, error: '云实例正被另一个生成任务占用（远程锁未释放），请稍后重试', locked: true, log: stdout.slice(0, 200) };
    }
    if (!stdout.includes('STARTED')) {
      return { ok: false, error: `HeyGem 启动失败：${error.message}`, log: (stdout + (error.stderr || '')).slice(0, 400) };
    }
    // 远端已 STARTED（ssh 因后台进程持有会话而挂到超时）视为启动成功
  }

  const deadline = Date.now() + timeoutMs;
  let lastLog = '';
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    let log = '';
    try {
      const res = await sshRun(cfg, [
        `tail -c 1200 /root/gen-${outName}.log 2>/dev/null`,
        `echo ---STAT---`,
        `START_TS=$(cat /root/.gen-started-${outName} 2>/dev/null || echo 0)`,
        `if [ -f ${remoteOut} ]; then OUT_TS=$(stat -c %Y ${remoteOut} 2>/dev/null || echo 0); SIZE=$(stat -c %s ${remoteOut} 2>/dev/null || echo 0); echo "OUT=$remoteOut TS=$OUT_TS START=$START_TS SIZE=$SIZE"; else echo "OUT_MISSING START=$START_TS"; fi`,
        `ps -ef | grep -c "[r]un.py" `,
      ].join('; '));
      log = res.stdout;
    } catch (error) {
      lastLog = `poll error: ${error.message}`;
      continue;
    }
    /* 只有「体积达标 + 新于本次启动」才算产出，避免捡到上一次的旧文件 */
    const statMatch = log.match(/OUT=(\S+) TS=(\d+) START=(\d+) SIZE=(\d+)/);
    const fresh = statMatch && Number(statMatch[2]) >= Number(statMatch[3]) && Number(statMatch[4]) > 100_000;
    if (fresh && log.includes(remoteOut)) {
      try { await sshRun(cfg, `rmdir ${lockDir} 2>/dev/null; echo released`, 15_000); } catch { /* 锁释放失败不影响产出交付 */ }
      const localFile = path.join('data', 'media-output', `${outName}.mp4`);
      await scpFrom(cfg, remoteOut, localFile);
      return { ok: true, localFile, log: log.slice(-800) };
    }
    lastLog = log.slice(-400);
  }
  try { await sshRun(cfg, `rmdir ${lockDir} 2>/dev/null; pkill -f "run.py --audio_path" 2>/dev/null; echo cleaned`, 20_000); } catch { /* 清理失败需人工检查实例 */ }
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

/**
 * N13 最小实现：把时间轴字幕烧录到视频底部（白字黑底条，居中）。
 * lines: [{ text, start, end }]（秒）。字体默认 STHeiti（macOS 自带中文黑体）。
 */
export async function burnSubtitles(videoFile, lines = [], fontFile = '/System/Library/Fonts/STHeiti Medium.ttc') {
  if (!Array.isArray(lines) || !lines.length) return { ok: false, error: '无字幕行', file: videoFile };
  if (!fs.existsSync(fontFile)) return { ok: false, error: `字幕字体不存在：${fontFile}`, file: videoFile };
  const escapeText = (t) => String(t).replace(/\\/g, '\\\\\\\\').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'").replace(/%/g, '\\\\%');
  const filters = lines.map((seg) => `drawtext=fontfile='${fontFile}':text='${escapeText(seg.text)}':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=h*0.85:enable='between(t,${Number(seg.start)},${Number(seg.end)})'`);
  const out = videoFile.replace(/\.mp4$/, '-subtitled.mp4');
  await execFileAsync('ffmpeg', ['-y', '-i', videoFile, '-vf', filters.join(','), '-c:a', 'copy', out], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  return { ok: true, file: out };
}
