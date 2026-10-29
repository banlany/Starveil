// Windows 下不希望弹出控制台窗口；其它平台（含移动端）这个属性没有意义。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 桌面与移动端共用的唯一入口。
//!
//! 真正的逻辑都在 `lib.rs`：Tauri 2 的 Android/iOS 工程会以**库**的形式
//! 调用 `mobile_entry_point`，可执行的 `main` 只负责转一手。

fn main() {
    starveil_lib::run()
}
