#!/usr/bin/env node
// 通过 WebView2 的 DevTools 协议驱动界面：截图、执行 JS、读控制台。
// 用法：
//   node tools/cdp.mjs info
//   node tools/cdp.mjs shot out.png
//   node tools/cdp.mjs eval "document.title"
//   node tools/cdp.mjs reload
//   node tools/cdp.mjs console 1500
//   node tools/cdp.mjs click "#some-selector"
// 端口默认 9224，可用 CDP_PORT 覆盖。

import { writeFile } from 'node:fs/promises';

const port = process.env.CDP_PORT || '9224';
const [, , action = 'info', ...rest] = process.argv;

async function target() {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  const list = await response.json();
  const pages = list.filter((item) => item.type === 'page');
  const page =
    pages.find((item) => item.url.includes(':1420')) ||
    pages.find((item) => item.url.startsWith('http')) ||
    pages[0];
  if (!page) throw new Error('没有找到 WebView 页面');
  return page.webSocketDebuggerUrl;
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (event) => reject(new Error(`WebSocket 失败：${event.message || ''}`));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  close() {
    this.ws.close();
  }
}

const cdp = new CDP(await target());
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

try {
  switch (action) {
    case 'info': {
      const info = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({title: document.title, url: location.href, ready: document.readyState, cards: document.querySelectorAll('.card').length})`,
        returnByValue: true,
      });
      console.log(info.result.value);
      break;
    }
    case 'shot': {
      const file = rest[0] || 'shot.png';
      const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(result.data, 'base64'));
      console.log(file);
      break;
    }
    case 'eval': {
      const expression = rest.join(' ');
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        console.error(result.exceptionDetails.text, result.exceptionDetails.exception?.description || '');
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(result.result.value));
      }
      break;
    }
    case 'click': {
      const selector = rest[0];
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
        returnByValue: true,
        userGesture: true,
      });
      console.log(result.result.value);
      break;
    }
    case 'reload': {
      await cdp.send('Page.reload', { ignoreCache: true });
      console.log('reloaded');
      break;
    }
    case 'console': {
      await cdp.send('Log.enable');
      await cdp.send('Network.enable');
      const reload = rest.includes('--reload');
      const wait = Number(rest.find((item) => /^\d+$/.test(item)) || 1000);
      if (reload) await cdp.send('Page.reload', { ignoreCache: true });
      await new Promise((resolve) => setTimeout(resolve, wait));
      for (const event of cdp.events) {
        if (event.method === 'Runtime.consoleAPICalled') {
          const args = event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
          console.log(`[${event.params.type}] ${args}`);
        }
        if (event.method === 'Runtime.exceptionThrown') {
          console.log(`[exception] ${event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text}`);
        }
        if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
          console.log(`[log] ${event.params.entry.text} ${event.params.entry.url || ''}`);
        }
        if (event.method === 'Network.loadingFailed') {
          console.log(`[network] ${event.params.errorText} ${event.params.type}`);
        }
      }
      break;
    }
    default:
      console.error(`未知操作：${action}`);
      process.exitCode = 2;
  }
} finally {
  cdp.close();
  setTimeout(() => process.exit(process.exitCode || 0), 30);
}
