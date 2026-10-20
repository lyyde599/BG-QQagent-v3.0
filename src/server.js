// 🔴 时区铁律（记忆系统 00 铁律 0.5 / 01 第六节）：
//   服务器系统时区是 UTC，但用户在**中国（UTC+8）** —— 所有面向用户的时间必须是北京时间。
//   TZ 必须在任何 new Date() 之前设置，且 ESM 的 import 会先于模块体执行，
//   所以这三行放在**所有 import 之上**。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
process.on('uncaughtException', (error) => console.error('[未捕获异常]', error));

const app = createApp();
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
