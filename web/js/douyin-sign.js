// 抖音弹幕握手签名。
//
// 抖音的弹幕 WebSocket（`webcast/im/push/v2`）要求查询串里带一个由 webmssdk
// 生成的 `signature`，算法写在一个 600 KB 的混淆脚本里，Rust 侧没有 JS 引擎跑得动它。
// 所以签名在 WebView 里算（和斗鱼签名同一套路），算完把 `signature` 与
// `user_unique_id` 一起交给 `start_danmaku`，由后端去连。
//
// `vendor/douyin-sign.js` 里定义的是全局 `getMSSDKSignature(msStub, userAgent)`。
// 它开头会把 `document` / `window` / `navigator` 覆写成空对象，这是原脚本在
// 非浏览器环境下的既定行为（Dart 版在 QuickJS 里也是这么跑的），别去"修"它。
//
// 因此**不能**把它当普通 `<script>` 注入页面：浏览器里 `document` / `window` /
// `navigator` 都是只读访问器，那几行赋值会静默失败，脚本就退化成拿真实 DOM +
// 真实 window 去跑，最后抛 `TypeError: crawler is not a function`。
// 正确做法是像 Dart 版那样把整段源码塞进函数作用域（下面的 `new Function`），
// 让这三个名字变成局部变量——`process` / `require` / `self` / `module` / `global`
// 一并喂 `undefined`，强制它走浏览器分支（脚本里有个 Node 分支靠 `typeof process` 判定）。

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

/// 算签名时用的参数串，顺序必须和 Dart 版 `getDefaultSignatureParams` 一致：
/// 平台是把这个串的 md5 当 `msStub` 去验签的，顺序错了签名就废。
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

// 抖音的列表类接口（首页推荐、分区房间）验的是 `a_bogus`，和上面弹幕握手用的
// `signature` 是两套算法：前者是一段 17KB 的纯函数（SM3 + RC4），后者是
// 600KB 的 webmssdk。脚本在 `vendor/douyin-abogus.js`，算法来源见该文件头。
const ABOGUS_SCRIPT = 'vendor/douyin-abogus.js';

let abogusPromise = null;

function compileAbogus(source) {
  // 和 webmssdk 那份一样，用 `new Function` 把它关进函数作用域：
  // 脚本里有浏览器分支判断，直接当 `<script>` 注入会拿到真实 DOM 行为。
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

/// 抖音要求查询串里带一个 107 位的 `msToken`，它同时是签名的输入之一。
/// 长度和字符集与网页端一致（大小写字母 + 数字），长度不对会被判成伪造。
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
