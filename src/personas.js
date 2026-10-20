// ── 人设入口（转发层）──────────────────────────────────────────────────
//
// 2026-10-05：人设扩展为 18 个（2 个 legacy 模板 + 16 个可选人设）。
// 实现拆分：
//   · personas-legacy.js —— 原有 blank / xiaojingyu 两份完整角色卡（保持原样）
//   · personas-new.js    —— 通用底座 BASE_RULES + 16 个人格 PROFILE，
//                           由 buildPersonaText() 渲染成约 6000 字的完整卡
//
// 本文件只做聚合导出，让所有 `import { PERSONAS } from './personas.js'`
// 的地方自动拿到全部 18 个，无需改动调用方。
export { PERSONAS, LEGACY_PERSONAS, PERSONA_GROUPS, PROFILES, buildPersonaText } from './personas-new.js';
