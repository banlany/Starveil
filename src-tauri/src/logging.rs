// 统一运行日志。
//
// 一条日志同时落盘与标准输出（非 Windows 进 logcat），单文件超过 512KB 转成 `.1`。
// 目录由 `init` 指定：Windows 是数据根目录（默认 `%LOCALAPPDATA%\Starveil`，便携版为
// exe 同级的 `data`），安卓是 `<私有目录>/files/logs`（在 FileProvider 的 files-path 内，
// 可以直接分享）。目录未定时只写标准输出，不阻塞调用方。
//
// 记录开关由 `set_enabled` 控制，关闭后既不落盘也不写标准输出；状态存在日志目录的
// `logging.off` 标记文件里，下次启动由 `init` 读回。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

/// 单个日志文件上限，超过后转存为 `starveil.log.1`（旧的 `.1` 直接丢弃）。
pub const MAX_BYTES: u64 = 512 * 1024;
const FILE_NAME: &str = "starveil.log";
const BACKUP_NAME: &str = "starveil.log.1";
/// 存在即表示关闭记录；用文件而不是配置项，`init` 拿到目录就能判断。
const OFF_NAME: &str = "logging.off";

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl Level {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO ",
            Self::Warn => "WARN ",
            Self::Error => "ERROR",
        }
    }

    const fn id(self) -> u8 {
        self as u8
    }
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());
/// 默认 info；`STARVEIL_LOG` 只在启动时读一次，设置页的临时值走 `set_level`。
static LEVEL: AtomicU8 = AtomicU8::new(Level::Info.id());
/// 默认记录；`init` 按标记文件恢复，设置页的开关走 `set_enabled`。
static ENABLED: AtomicBool = AtomicBool::new(true);

/// 设定日志目录，读取启动级别与记录开关。目录建不出来时保持仅标准输出。
pub fn init(dir: Option<PathBuf>) {
    if let Ok(raw) = std::env::var("STARVEIL_LOG") {
        if let Some(level) = Level::parse(&raw) {
            LEVEL.store(level.id(), Ordering::Relaxed);
        }
    }
    let Some(dir) = dir else { return };
    let _ = std::fs::create_dir_all(&dir);
    ENABLED.store(restore_enabled(&dir), Ordering::Relaxed);
    let _ = DIR.set(dir);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 开关记录并落盘标记；目录未定时只改内存状态（下次启动回到默认开启）。
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    if let Some(dir) = DIR.get() {
        write_marker(dir, on);
    }
}

fn restore_enabled(dir: &Path) -> bool {
    !dir.join(OFF_NAME).exists()
}

fn write_marker(dir: &Path, on: bool) {
    let marker = dir.join(OFF_NAME);
    if on {
        let _ = std::fs::remove_file(marker);
    } else {
        let _ = std::fs::write(marker, b"");
    }
}

pub fn level() -> Level {
    match LEVEL.load(Ordering::Relaxed) {
        0 => Level::Debug,
        3 => Level::Error,
        2 => Level::Warn,
        _ => Level::Info,
    }
}

pub fn set_level(level: Level) {
    LEVEL.store(level.id(), Ordering::Relaxed);
}

pub fn level_name() -> &'static str {
    match level() {
        Level::Debug => "debug",
        Level::Info => "info",
        Level::Warn => "warn",
        Level::Error => "error",
    }
}

/// 当前日志文件；目录还没定下来时为 `None`。
pub fn path() -> Option<PathBuf> {
    DIR.get().map(|dir| dir.join(FILE_NAME))
}

pub fn info(module: &str, message: impl AsRef<str>) {
    write(Level::Info, module, message.as_ref());
}

pub fn warn(module: &str, message: impl AsRef<str>) {
    write(Level::Warn, module, message.as_ref());
}

pub fn error(module: &str, message: impl AsRef<str>) {
    write(Level::Error, module, message.as_ref());
}

pub fn debug(module: &str, message: impl AsRef<str>) {
    write(Level::Debug, module, message.as_ref());
}

fn write(level: Level, module: &str, message: &str) {
    if !enabled() || level < self::level() {
        return;
    }
    let line = format_line(level, module, message);
    if cfg!(not(windows)) {
        // Android 上标准输出会进 logcat（`adb logcat -s RustStdoutStderr`）。
        print!("{line}");
    }
    let Some(dir) = DIR.get() else { return };
    // 多线程同时写会交错，轮转也要排他。
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let file = dir.join(FILE_NAME);
    rotate(&file, line.len());
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        Ok(mut handle) => {
            let _ = handle.write_all(line.as_bytes());
        }
        // 磁盘满、权限变化时至少别把调用方拖住。
        Err(_) => print!("{line}"),
    }
}

fn format_line(level: Level, module: &str, message: &str) -> String {
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let prefix = format!("{stamp} {} [{module}] ", level.label());
    // 续行缩进到消息列，保证一行一条、方便 grep。
    let pad = " ".repeat(prefix.chars().count());
    let mut out = String::with_capacity(message.len() + 64);
    for (index, part) in message.lines().enumerate() {
        if index == 0 {
            out.push_str(&prefix);
            out.push_str(part);
        } else {
            out.push_str(&pad);
            out.push_str(part);
        }
        out.push('\n');
    }
    if out.is_empty() {
        out.push_str(prefix.trim_end());
        out.push('\n');
    }
    out
}

/// 写前检查：加上这一行会超限就把当前文件转成 `.1`。
fn rotate(file: &Path, incoming: usize) {
    let size = std::fs::metadata(file).map(|meta| meta.len()).unwrap_or(0);
    if size == 0 || size + incoming as u64 <= MAX_BYTES {
        return;
    }
    let Some(dir) = file.parent() else { return };
    let backup = dir.join(BACKUP_NAME);
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(file, &backup);
}

/// 读最近 `lines` 行；没有日志文件时返回空串。
pub fn read_tail(lines: usize) -> Result<String, String> {
    let file = path().ok_or_else(|| "当前平台没有日志目录".to_string())?;
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取日志失败：{error}")),
    };
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines.max(1));
    Ok(all[start..].join("\n"))
}

/// 清空当前日志与轮转出来的 `.1`。
pub fn clear() -> Result<(), String> {
    let file = path().ok_or_else(|| "当前平台没有日志目录".to_string())?;
    let Some(dir) = file.parent() else {
        return Err("日志目录异常".to_string());
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Err(error) = std::fs::write(&file, b"") {
        return Err(format!("清空日志失败：{error}"));
    }
    let _ = std::fs::remove_file(dir.join(BACKUP_NAME));
    Ok(())
}

/// 接管 panic：先落盘再交给原 hook（原 hook 会打印到标准错误，桌面无控制台时看不见）。
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知 panic".to_string());
        let place = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "位置未知".to_string());
        error("panic", format!("{payload}（{place}）"));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("starveil-log-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn rotate_keeps_single_backup() {
        let dir = temp_dir("rotate");
        let file = dir.join(FILE_NAME);
        std::fs::write(&file, vec![b'a'; MAX_BYTES as usize]).expect("写满");
        rotate(&file, 64);
        assert!(dir.join(BACKUP_NAME).exists());
        assert!(!file.exists());
        // 再超限一次：旧的 .1 被替换，不会堆出 .2 / .3。
        std::fs::write(&file, vec![b'b'; MAX_BYTES as usize]).expect("再写满");
        rotate(&file, 64);
        let backup = std::fs::read(dir.join(BACKUP_NAME)).expect("读备份");
        assert!(backup.iter().all(|byte| *byte == b'b'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn marker_keeps_switch_across_restart() {
        let dir = temp_dir("marker");
        assert!(restore_enabled(&dir));
        write_marker(&dir, false);
        assert!(!restore_enabled(&dir));
        write_marker(&dir, true);
        assert!(restore_enabled(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_keeps_one_line_per_message() {
        let text = format_line(Level::Warn, "proxy", "第一行\n第二行");
        assert_eq!(text.lines().count(), 2);
        assert!(text.contains("WARN "));
        assert!(text.contains("[proxy] 第一行"));
    }
}
