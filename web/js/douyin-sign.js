// 抖音弹幕握手签名。
//
// vendor/douyin-sign.js 会覆写 document / window / navigator，因此必须用
// new Function 包进函数作用域，并注入 undefined 的 process / require 等名字。

const SIGN_SCRIPT = 'vendor/douyin-sign.js';
// 必须和后端 WebSocket 请求头的 User-Agent 完全一致：签名里带 UA 的指纹。
const DOUYIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let signerPromise = null;

function compileSigner(source) {
  const factory = new Function(
    'document',
    'window',
    'navigator',
    'process',
    'require',
    'self',
    'module',
    'global',
    `${source}\n;return getMSSDKSignature;`,
  );
  const sign = factory(
    {},
    {},
    { userAgent: DOUYIN_UA },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  if (typeof sign !== 'function') {
    throw new Error('签名脚本没有导出 getMSSDKSignature');
  }
  return sign;
}

async function ensureSigner() {
  if (signerPromise) return signerPromise;
  signerPromise = (async () => {
    const response = await fetch(SIGN_SCRIPT, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`签名脚本加载失败（HTTP ${response.status}）`);
    return compileSigner(await response.text());
  })();
  // 失败不缓存，下次重试还能重新拉一次。
  signerPromise.catch(() => {
    signerPromise = null;
  });
  return signerPromise;
}

/// 抖音用 19 位数字当匿名 `user_unique_id`，随便造一个即可。
function randomUserId() {
  let digits = String(Math.floor(Math.random() * 9) + 1);
  for (let index = 0; index < 18; index += 1) digits += String(Math.floor(Math.random() * 10));
  return digits;
}

/// 签名参数串，顺序须与 Dart 版 getDefaultSignatureParams 一致。
function buildStub(roomId, userId) {
  return [
    'live_id=1',
    'aid=6383',
    'version_code=180800',
    'webcast_sdk_version=1.3.0',
    `room_id=${roomId}`,
    'sub_room_id=',
    'sub_channel_id=',
    'did_rule=3',
    `user_unique_id=${userId}`,
    'device_platform=web',
    'device_type=',
    'ac=',
    'identity=audience',
  ].join(',');
}

/**
 * 为房间生成弹幕签名。
 * @param {string} roomId 抖音的一次性房间号（19 位，`detail.extra.room_id`）
 * @returns {Promise<{signature: string, userId: string}>}
 */
export async function signDouyinDanmaku(roomId) {
  if (!window.CryptoJS?.MD5) throw new Error('CryptoJS 未加载，无法计算抖音签名');
  const id = String(roomId || '').trim();
  if (!id) throw new Error('缺少抖音房间号，无法生成弹幕签名');
  const sign = await ensureSigner();
  const userId = randomUserId();
  const stub = window.CryptoJS.MD5(buildStub(id, userId)).toString();
  // 极少数情况下签名会带 `-` 或 `=`（会破坏查询串），重算几次。
  let signature = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    signature = String(sign(stub, DOUYIN_UA) || '');
    if (signature && !signature.includes('-') && !signature.includes('=')) break;
  }
  if (!signature || signature.includes('-') || signature.includes('=')) {
    throw new Error('签名生成失败（平台脚本没有返回有效签名）');
  }
  return { signature, userId };
}

// ------------------------------------------------------------ a_bogus（REST 接口）

// 列表接口签名 a_bogus（vendor/douyin-abogus.js），与弹幕握手的 signature 是两套算法。
const ABOGUS_SCRIPT = 'vendor/douyin-abogus.js';

let abogusPromise = null;

function compileAbogus(source) {
  // 与 webmssdk 相同，用 new Function 隔离作用域。
  const factory = new Function(`${source}\n;return getABogus;`);
  const sign = factory();
  if (typeof sign !== 'function') throw new Error('a_bogus 脚本没有导出 getABogus');
  return sign;
}

async function ensureAbogus() {
  if (abogusPromise) return abogusPromise;
  abogusPromise = (async () => {
    const response = await fetch(ABOGUS_SCRIPT, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`a_bogus 脚本加载失败（HTTP ${response.status}）`);
    return compileAbogus(await response.text());
  })();
  abogusPromise.catch(() => {
    abogusPromise = null;
  });
  return abogusPromise;
}

/// 生成 107 位 msToken（大小写字母 + 数字），同时作为签名输入。
export function douyinMsToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < 107; index += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * 给一条查询串算 `a_bogus`。
 * @param {string} query 不含 `?`、也不含 `a_bogus` 的原始查询串
 * @returns {Promise<string>} 要追加到 URL 末尾的 `a_bogus` 值
 */
export async function signDouyinQuery(query) {
  const text = String(query || '').trim();
  if (!text) throw new Error('抖音签名缺少查询串');
  const sign = await ensureAbogus();
  const value = String(sign(text, DOUYIN_UA) || '');
  if (!value) throw new Error('a_bogus 生成失败（签名脚本没有返回结果）');
  return value;
}
