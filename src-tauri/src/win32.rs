//! Windows 系统能力：剪贴板写入、用默认浏览器打开链接。
//!
//! 这两件事以前是 `cmd /C clip` / `cmd /C start` 做的，每次都会闪一个黑色终端窗口，
//! 而且 `copy` 还要同步等子进程退出，界面会明显卡一下。
//!
//! 这里直接调 Win32 API：不弹窗、不起子进程、不阻塞 UI 线程。
//! 只声明真正用到的几个函数，不引入 `windows` crate（少一个依赖，也少一层版本耦合）。

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    pub type Handle = *mut c_void;

    unsafe extern "system" {
        pub fn OpenClipboard(owner: Handle) -> i32;
        pub fn CloseClipboard() -> i32;
        pub fn EmptyClipboard() -> i32;
        pub fn SetClipboardData(format: u32, data: Handle) -> Handle;
        pub fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        pub fn GlobalLock(mem: Handle) -> *mut u16;
        pub fn GlobalUnlock(mem: Handle) -> i32;
        pub fn GlobalFree(mem: Handle) -> Handle;
        pub fn ShellExecuteW(
            owner: Handle,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> Handle;
    }
}

/// 把文本写进系统剪贴板（UTF-16，Windows 的 `CF_UNICODETEXT`）。
#[cfg(windows)]
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    use platform::*;

    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 0x0002;

    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        // GMEM_MOVEABLE 是 SetClipboardData 的硬性要求：剪贴板接管这块内存的所有权。
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if mem.is_null() {
            return Err("分配剪贴板内存失败".to_string());
        }
        let target = GlobalLock(mem);
        if target.is_null() {
            GlobalFree(mem);
            return Err("锁定剪贴板内存失败".to_string());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(mem);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            GlobalFree(mem);
            return Err("打开剪贴板失败（可能正被其它程序占用）".to_string());
        }
        let written = EmptyClipboard() != 0 && !SetClipboardData(CF_UNICODETEXT, mem).is_null();
        CloseClipboard();
        if !written {
            GlobalFree(mem);
            return Err("写入剪贴板失败".to_string());
        }
    }
    Ok(())
}

/// 用系统默认程序打开链接。
///
/// `ShellExecuteW` 的返回值 <= 32 表示失败（32 本身是 `SE_ERR_NOASSOC`）。
#[cfg(windows)]
pub fn open_in_browser(url: &str) -> Result<(), String> {
    use platform::*;

    let mut target: Vec<u16> = url.encode_utf16().collect();
    target.push(0);
    let mut operation: Vec<u16> = "open".encode_utf16().collect();
    operation.push(0);

    unsafe {
        let result = ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        );
        if result.is_null() || (result as isize) <= 32 {
            return Err("打开链接失败".to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn copy_to_clipboard(_text: &str) -> Result<(), String> {
    Err("当前平台暂不支持写入剪贴板".to_string())
}

#[cfg(not(windows))]
pub fn open_in_browser(_url: &str) -> Result<(), String> {
    Err("当前平台暂不支持打开外部链接".to_string())
}
