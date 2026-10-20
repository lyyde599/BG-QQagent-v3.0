// NapCat 登录二维码定位（控制台展示用）
//
// NapCat 在「未登录/等待扫码」时会把二维码写到它的 cache/qrcode.png，约每 2 分钟刷新一次。
// 一旦登录成功就不再更新（或不再存在）。
//
// 本模块负责在几种可能的部署位置里找到那个文件。之前把二维码页单独挂成一个服务
// （scripts/qr-server.mjs + 独立端口 + nginx 子路径），现在直接由控制台后端提供，
// 少一个端口、也少一处外挂页面。
import fs from 'node:fs';
import path from 'node:path';

/** 候选路径：环境变量 > 配置的 snowluma 目录 > 常见 NapCat 注入位置 */
function candidates(extraDir = '') {
  const home = process.env.HOME || '';
  const list = [
    process.env.NAPCAT_QR_PATH,
    extraDir ? path.join(extraDir, 'cache', 'qrcode.png') : '',
    // 无 root 部署时的实际位置（本机 NapCat 注入在 QQ 资源目录下）
    home ? path.join(home, 'napcat/opt/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png') : '',
    // 其他常见位置
    '/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png',
    home ? path.join(home, '.config/QQ/NapCat/cache/qrcode.png') : ''
  ];
  return list.filter(Boolean);
}

/**
 * 返回 { exists, path, qrAt, mtimeMs, ageMs }
 * ageMs 用于前端提示「二维码是否可能已过期」。
 */
export function qrInfo(extraDir = '') {
  for (const f of candidates(extraDir)) {
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size === 0) continue;
      return {
        exists: true,
        path: f,
        size: st.size,
        qrAt: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs,
        ageMs: Date.now() - st.mtimeMs
      };
    } catch { /* 继续找下一个 */ }
  }
  return { exists: false, path: '', size: 0, qrAt: null, mtimeMs: 0, ageMs: null };
}

/** 读取二维码图片；不存在返回 null。 */
export function readQrBuffer(extraDir = '') {
  const info = qrInfo(extraDir);
  if (!info.exists) return null;
  try {
    return { info, buffer: fs.readFileSync(info.path) };
  } catch {
    return null;
  }
}
