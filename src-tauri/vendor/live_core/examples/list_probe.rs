//! 列表字段诊断：打印推荐列表前几条的用户名 / 头像 / 房间号。
//!
//! 头像这类字段平台给不给、给的是相对路径还是完整地址，各平台都不一样，
//! 改完 `parse_rooms` 用这个快速对一眼。
//!
//! ```bash
//! cargo run -p live_core --example list_probe -- bilibili
//! cargo run -p live_core --example list_probe -- douyu
//! ```

use live_core::{LiveCore, Platform};

fn main() {
    let platform = std::env::args().nth(1).unwrap_or_else(|| "bilibili".to_string());
    let platform = Platform::from_id(&platform).expect("平台名");
    let core = LiveCore::new();
    match core.recommend(platform, 1, &Default::default()) {
        Ok(items) => {
            for item in items.iter().take(5) {
                println!("{} | {} | {}", item.user_name, item.avatar, item.room_id);
            }
        }
        Err(error) => println!("失败: {error}"),
    }
}
