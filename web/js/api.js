// Tauri 命令封装。浏览器里直接打开 web/ 时退化为演示数据，方便单独调样式。
const TAURI = window.__TAURI__;
const hasTauri = Boolean(TAURI?.core?.invoke);
const invoke = hasTauri ? TAURI.core.invoke : null;

// 抖音、快手已接入取流（详情/清晰度/播放/推荐），先开放出来。
// 它们的弹幕还没接入，进房后聊天栏会给出明确提示。
export const ENABLED_PLATFORMS = ['bilibili', 'douyu', 'huya', 'douyin', 'kuaishou'];
export const ALL_PLATFORMS = ['bilibili', 'douyu', 'huya', 'douyin', 'kuaishou'];

/// 后端枚举会序列化成 "Bilibili" 这种 PascalCase，统一收敛成小写 id。
export function normalizePlatform(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.startsWith('bilibili')) return 'bilibili';
  if (text.startsWith('douyu')) return 'douyu';
  if (text.startsWith('huya')) return 'huya';
  if (text.startsWith('douyin')) return 'douyin';
  if (text.startsWith('kuaishou')) return 'kuaishou';
  return text;
}

export function isPlatformEnabled(platform) {
  return ENABLED_PLATFORMS.includes(platform);
}

// 斗鱼：签名脚本由后端按房间拉取，签名在 WebView 的 JS 引擎里执行，
// 之后每次取流都用当前时间戳重新签一次（与 Dart 版 QuickJS 的做法一致）。
const douyuSessions = new Map();

function signDouyu(script, roomId, did) {
  if (!window.CryptoJS?.MD5) throw new Error('CryptoJS 未加载，无法计算斗鱼签名');
  const factory = new Function(`${script}\n;return ub98484234;`);
  const signer = factory();
  if (typeof signer !== 'function') throw new Error('斗鱼签名脚本没有返回函数');
  const signed = signer(String(roomId), String(did), String(Math.floor(Date.now() / 1000)));
  if (typeof signed !== 'string' || !signed.includes('sign=')) throw new Error('斗鱼签名结果为空');
  return signed;
}

export function roomUrl(platform, roomId) {
  switch (platform) {
    case 'bilibili':
      return `https://live.bilibili.com/${roomId}`;
    case 'douyu':
      return `https://www.douyu.com/${roomId}`;
    case 'huya':
      return `https://www.huya.com/${roomId}`;
    case 'douyin':
      return `https://live.douyin.com/${roomId}`;
    case 'kuaishou':
      return `https://live.kuaishou.com/u/${roomId}`;
    default:
      return '';
  }
}

export function canonicalImage(url) {
  if (!url) return '';
  let value = String(url).trim();
  if (value.startsWith('//')) value = `https:${value}`;
  if (value.startsWith('http://') && /(hdslb|biliimg|douyu|douyucdn|huya|msstatic|douyinpic|kuaishou)/i.test(value)) {
    value = `https://${value.slice(7)}`;
  }
  return value;
}

/// B 站原图经常是 720p/1080p，卡片只需要一百多像素宽；
/// 让 CDN 直接返回缩略图，能显著减少解码与显存开销。
export function coverImage(url, platform) {
  const value = canonicalImage(url);
  if (!value || platform !== 'bilibili' || !/hdslb\.com/i.test(value)) return value;
  const [base, query] = value.split('?');
  if (base.includes('@')) return value;
  return `${base}@480w_270h_1c.webp${query ? `?${query}` : ''}`;
}

export function categoryImage(url) {
  const value = canonicalImage(url);
  if (!value || !/hdslb\.com/i.test(value)) return value;
  const [base, query] = value.split('?');
  if (base.includes('@')) return value;
  return `${base}@96w_96h_1c.webp${query ? `?${query}` : ''}`;
}

export function formatOnline(value) {
  const number = Number(value) || 0;
  if (number >= 10000) {
    return `${(number / 10000).toFixed(1)}万`;
  }
  return String(number);
}

export function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 100000000) return `${(number / 100000000).toFixed(1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(1)}万`;
  return String(number);
}

export function currentClock(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function timeAgo(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const date = new Date(Number(timestamp));
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

async function call(command, args = {}) {
  if (!invoke) return demo(command, args);
  return invoke(command, args);
}

/// 虎牙的接口偶尔会直接返回 gzip 原始字节（上游未协商压缩），重试一次通常就正常。
async function callWithRetry(command, args = {}, attempts = 3, delay = 420) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await call(command, args);
    } catch (error) {
      last = error;
      if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}

function listCall(command, args, platform) {
  return platform === 'huya' ? callWithRetry(command, args) : call(command, args);
}

// ---------------------------------------------------------------- 命令

export const api = {
  recommend(platform, page = 1) {
    return listCall('recommend', { platform, page }, platform);
  },
  search(platform, keyword) {
    return listCall('search', { platform, keyword }, platform);
  },
  searchAnchors(platform, keyword, page = 1) {
    return listCall('search_anchors', { platform, keyword, page }, platform);
  },
  categories(platform) {
    return listCall('categories', { platform }, platform);
  },
  categoryRooms(platform, parentId, subId, name, page = 1) {
    return listCall('category_rooms', { platform, parentId, subId, name, page }, platform);
  },
  async openRoom(platform, roomId) {
    const normalized = normalizePlatform(platform);
    const payload = await call('open_room', { platform: normalized, roomId });
    if (payload?.detail) {
      payload.detail.platform = normalizePlatform(payload.detail.platform || platform);
    }
    if (normalized === 'douyu' && payload?.douyu_script) {
      douyuSessions.set(payload.key, {
        script: payload.douyu_script,
        did: payload.douyu_did,
        roomId: payload.detail.room_id,
      });
      const signed = signDouyu(payload.douyu_script, payload.detail.room_id, payload.douyu_did);
      payload.qualities = await call('douyu_qualities', { key: payload.key, signedArgs: signed });
    }
    return payload;
  },
  async play(key, index) {
    if (key.startsWith('douyu:')) {
      const session = douyuSessions.get(key);
      if (!session) throw new Error('斗鱼会话已失效，请重新进房');
      const signed = signDouyu(session.script, session.roomId, session.did);
      return call('douyu_play', { key, index, signedArgs: signed });
    }
    return call('play', { key, index });
  },
  // 抖音的弹幕握手要带 webmssdk 签名，由 room.js 算好后传进来；其余平台忽略这两个参数。
  startDanmaku(key, options = {}) {
    return call('start_danmaku', {
      key,
      signature: options.signature || null,
      userId: options.userId || null,
    });
  },
  stopDanmaku() {
    return call('stop_danmaku');
  },
  // 发送一条纯文本弹幕；需要该平台的登录态。
  sendDanmaku(key, text) {
    return call('send_danmaku', { key, text });
  },
  copyText(text) {
    return call('copy_text', { text });
  },
  // WebDAV 同步：地址由前端拼好整条 URL 传下去（含目录与文件名）。
  webdavTest(url, username, password, allowInsecureTls = false) {
    return call('webdav_test', { url, username, password, allowInsecureTls });
  },
  webdavUpload(url, username, password, content, allowInsecureTls = false) {
    return call('webdav_upload', { url, username, password, content, allowInsecureTls });
  },
  webdavDownload(url, username, password, allowInsecureTls = false) {
    return call('webdav_download', { url, username, password, allowInsecureTls });
  },
  openUrl(url) {
    return call('open_url', { url });
  },
  resolveInput(current, input) {
    return call('resolve_input', { current, input });
  },
  quitApp() {
    return call('quit_app');
  },
  /// 屏幕方向：`auto` / `portrait` / `landscape`。桌面端是空实现，不报错。
  setScreenOrientation(mode) {
    return call('set_screen_orientation', { mode });
  },
  /// 安卓系统栏配色：`color` 为 `#RRGGBB`，`light` 表示背景浅、图标用深色。桌面端空实现。
  setSystemBar(color, light) {
    return call('set_system_bar', { color, light });
  },
  /// 安卓小窗（系统级画中画）。桌面端返回 false，前端会退回 HTML5 画中画。
  enterPictureInPicture() {
    return call('enter_picture_in_picture');
  },
  /// 是否正在小窗里；退出小窗没有系统通知，前端轮询这个来判断。
  inPictureInPicture() {
    return call('in_picture_in_picture');
  },
  setCookie(platform, cookie) {
    return call('set_cookie', { platform, cookie });
  },
  clearCookie(platform) {
    return call('clear_cookie', { platform });
  },
  loginStatus(platform, cookie) {
    return call('login_status', { platform, cookie });
  },
  // 打开独立的登录窗口（与主窗口共享 Cookie），登录后由后端读出来。
  openLoginWindow(platform) {
    return call('open_login_window', { platform });
  },
  captureLogin(platform) {
    return call('capture_login', { platform });
  },
  biliQrGenerate() {
    return call('bili_qr_generate');
  },
  biliQrPoll(key) {
    return call('bili_qr_poll', { key });
  },
  onDanmaku(handler) {
    // 浏览器里没有后端事件，用演示弹幕驱动布局/样式调试。
    if (!hasTauri) return startDemoDanmaku(handler);
    return TAURI.event.listen('danmaku', (event) => handler(event.payload));
  },
  // 弹幕连接状态（连接中 / 已连接 / 失败原因 / 本平台不支持）。
  // 和 onDanmaku 分开：状态是"当前这一刻"的结论，界面用它画聊天栏顶部的横幅。
  onDanmakuStatus(handler) {
    if (!hasTauri) return Promise.resolve(() => {});
    return TAURI.event.listen('danmaku-status', (event) => handler(event.payload));
  },
};

// ---------------------------------------------------------------- 演示弹幕

const DEMO_DM_USERS = ['夜航星', '看海的人', '阿岚', '小满', '不吃香菜', 'kim', '南风'];
const DEMO_DM_TEXTS = [
  '这波操作可以',
  '前面的等等我',
  '主播今天状态真好',
  '666666',
  '哈哈哈哈哈',
  '这个 BGM 是什么',
  '刚来，讲到哪了',
  '别急，马上就好',
  '打卡打卡',
  '笑死我了',
  '这画质也太清晰了',
  '有没有人一起看',
  '主播能再说一遍吗',
  '这波稳了',
  '我裂开了',
  '好家伙',
  '这操作太秀了',
  '刚下班就来了',
  '这局有点难啊',
  '对面有点东西',
  '弹幕护体[赞]',
  '这歌好听',
  '求个歌单',
  '第一次看，已关注',
  '这个点位记住了',
  '手速真快',
  '老粉报道',
  '看了三年了',
  '今天人好多',
  '这波血赚',
  '别浪别浪',
  '稳住，能赢',
  '这解说有意思',
  '画面好丝滑',
  '主播声音好听',
  '明天还播吗',
];

/// 演示用的表情弹幕。真机上这些图是平台下发的 https 地址，这里用内联 SVG，
/// 保证离线打开 web/ 也能看到「表情混排」的渲染效果（弹幕层与聊天栏共用）。
const DEMO_EMOTICON = {
  key: '[赞]',
  url:
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E" +
    "%3Ccircle cx='10' cy='10' r='9' fill='%23ffcd00'/%3E" +
    "%3Ccircle cx='7' cy='8' r='1.3' fill='%23333'/%3E" +
    "%3Ccircle cx='13' cy='8' r='1.3' fill='%23333'/%3E" +
    "%3Cpath d='M6.2 12.2q3.8 3 7.6 0' stroke='%23333' stroke-width='1.3' fill='none' stroke-linecap='round'/%3E" +
    '%3C/svg%3E',
  width: 20,
  height: 20,
};

function startDemoDanmaku(handler) {
  let index = 0;
  const timer = setInterval(() => {
    const text = DEMO_DM_TEXTS[index % DEMO_DM_TEXTS.length];
    const payload = {
      user: DEMO_DM_USERS[index % DEMO_DM_USERS.length],
      text,
      color: index % 9 === 0 ? 0x66ccff : 0xffffff,
      position: index % 27 === 0 ? 1 : 0,
      system: false,
    };
    if (text.includes(DEMO_EMOTICON.key)) payload.emoticons = [DEMO_EMOTICON];
    handler(payload);
    index += 1;
  }, 300);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- 演示数据

const DEMO_TITLES = [
  '2026英雄联盟全球总决赛 · 瑞士轮',
  '新版本开荒，先测为敬',
  '深夜点唱，来听一首',
  '今天也要好好打排位',
  '主机区新游首发体验',
  '户外骑行 · 沿海公路',
  '绘画直播 · 角色设计',
  '一起看比赛！',
  '轻松聊天，随便问问',
  '冲榜上分中',
  '音乐电台 · 华语老歌',
  '桌面整理与代码日常',
];
const DEMO_USERS = ['夜航星', '阿澈', '小鹿乱撞', '青柠汽水', '一只猫饼', '远山', '拾光', '南风'];
const DEMO_GRADIENTS = [
  ['#1f3b73', '#0b1224'],
  ['#6e2244', '#1b0b12'],
  ['#174f3f', '#081713'],
  ['#5b3a15', '#1a1006'],
  ['#3c2b6e', '#120d24'],
  ['#622222', '#180808'],
];

function demoCover(index) {
  const [a, b] = DEMO_GRADIENTS[index % DEMO_GRADIENTS.length];
  const title = DEMO_TITLES[index % DEMO_TITLES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="${140 + (index % 5) * 90}" cy="${100 + (index % 3) * 60}" r="120" fill="rgba(255,255,255,.05)"/><text x="32" y="300" fill="rgba(255,255,255,.78)" font-size="34" font-family="Microsoft YaHei UI">${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function demoRooms(platform = 'bilibili', count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    platform,
    room_id: String(1000 + index),
    title: DEMO_TITLES[index % DEMO_TITLES.length],
    user_name: DEMO_USERS[index % DEMO_USERS.length],
    cover: demoCover(index),
    online: Math.max(120, 2800000 - index * 73000),
  }));
}

function demoTrees(platform) {
  const groups = {
    bilibili: [
      ['网游', ['英雄联盟', '无畏契约', '三角洲行动', 'CS2', 'APEX英雄', '守望先锋', 'DOTA2', '永劫无间', '魔兽世界']],
      ['手游', ['王者荣耀', '和平精英', '原神', '崩坏：星穹铁道', '第五人格', '明日方舟', '绝区零']],
      ['单机游戏', ['我的世界', '新游推荐', '独立游戏', '恐怖游戏', '生化危机']],
      ['娱乐', ['聊天室', '唱见', '虚拟主播', '户外']],
      ['知识', ['编程', '设计', '语言学习']],
    ],
    douyu: [
      ['网游', ['英雄联盟', 'DOTA2', 'CS2', '绝地求生', '永劫无间']],
      ['手游', ['王者荣耀', '和平精英', '原神']],
      ['娱乐', ['户外', '音乐', '舞蹈']],
    ],
    huya: [
      ['网游', ['英雄联盟', 'CS2', '绝地求生', 'DOTA2']],
      ['手游', ['王者荣耀', '和平精英']],
      ['娱乐', ['户外', '星秀']],
    ],
  };
  return (groups[platform] || groups.bilibili).map(([name, children], parentIndex) => ({
    id: String(parentIndex + 1),
    name,
    children: children.map((child, index) => ({
      id: String(parentIndex * 100 + index),
      name: child,
      parent_id: String(parentIndex + 1),
      pic: '',
    })),
  }));
}

async function demo(command, args) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  switch (command) {
    case 'recommend':
      return demoRooms(args.platform, args.page > 1 ? 12 : 30);
    case 'search':
      return demoRooms(args.platform, 12).map((room, index) => ({
        ...room,
        title: `${args.keyword} · ${DEMO_TITLES[index % DEMO_TITLES.length]}`,
      }));
    case 'categories':
      return demoTrees(args.platform);
    case 'category_rooms':
      return demoRooms(args.platform, 24);
    case 'open_room':
      return {
        key: `${args.platform}:${args.roomId}`,
        detail: {
          platform: args.platform,
          room_id: args.roomId,
          title: DEMO_TITLES[0],
          user_name: DEMO_USERS[0],
          cover: demoCover(0),
          online: 13800000,
          viewers: 12745,
          guard_count: 36,
          live: true,
          area: '英雄联盟',
          intro: '演示房间',
          url: roomUrl(args.platform, args.roomId),
        },
        qualities: ['原画', '蓝光', '高清'],
      };
    case 'play':
      return { urls: [], hls_urls: [], headers: [] };
    case 'resolve_input':
      return { platform: args.current, room_id: args.input, is_short_link: false, raw: args.input };
    default:
      return null;
  }
}
