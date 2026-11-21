// 前端异常转发：落到后端日志文件，出问题时用户不必开 DevTools 复制控制台。
// 只收 error 级；同一段文本 10 秒内只发一次、每分钟最多 20 条，
// 防止渲染循环里的异常把日志文件刷满。
import { api } from './api.js';

const REPEAT_MS = 10_000;
const BUDGET = 20;
const MAX_LENGTH = 900;

const seen = new Map();
let windowStart = 0;
let sent = 0;
let installed = false;

function trim(text) {
  const value = String(text ?? '').replace(/\s+$/, '');
  return value.length > MAX_LENGTH ? `${value.slice(0, MAX_LENGTH)}…` : value;
}

function allowed(text) {
  const now = Date.now();
  const last = seen.get(text);
  if (last && now - last < REPEAT_MS) return false;
  if (now - windowStart > 60_000) {
    windowStart = now;
    sent = 0;
  }
  if (sent >= BUDGET) return false;
  sent += 1;
  // 记录表别无限增长；清掉的是旧的去重信息，下一次同样的错误会被重新发送。
  if (seen.size > 200) seen.clear();
  seen.set(text, now);
  return true;
}

function forward(text, module = 'web') {
  const body = trim(text);
  if (!body || !allowed(body)) return;
  api.frontendLog('error', module, body);
}

function describe(value) {
  if (value instanceof Error) return `${value.message}\n${value.stack || ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/// 装一次即可；重复调用不会重复挂钩子。
export function installLogForwarding() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    // 资源加载失败（封面、字体）不记：量大且与功能无关。
    if (!event.error) return;
    const detail = describe(event.error);
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : '';
    forward(`${detail}${where}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    forward(`未处理的 Promise 拒绝：${describe(event.reason)}`);
  });

  // 控制台错误同步到后端；自己的转发不走 console，避免递归。
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    forward(args.map(describe).join(' '));
  };
}
