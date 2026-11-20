// 系统字体清单。
// Windows 走 DirectWrite 枚举字体家族（不是字体文件），返回的名字可以直接写进 CSS
// `font-family`；其它平台返回空表，设置页据此隐藏字体选项。

use serde::Serialize;
use std::sync::OnceLock;

#[derive(Clone, Serialize)]
pub struct FontEntry {
    /// CSS `font-family` 用的名字。
    pub name: String,
    /// 界面显示名，优先中文名称。
    pub label: String,
}

/// 枚举结果缓存：DirectWrite 枚举为毫秒级，但设置页每次进分区都要读一次。
pub fn list() -> Vec<FontEntry> {
    static CACHE: OnceLock<Vec<FontEntry>> = OnceLock::new();
    CACHE.get_or_init(enumerate).clone()
}

#[cfg(not(windows))]
fn enumerate() -> Vec<FontEntry> {
    Vec::new()
}

#[cfg(windows)]
fn enumerate() -> Vec<FontEntry> {
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteLocalizedStrings,
        DWRITE_FACTORY_TYPE_SHARED,
    };

    fn text_at(names: &IDWriteLocalizedStrings, index: u32) -> Option<String> {
        unsafe {
            let len = names.GetStringLength(index).ok()? as usize;
            let mut buffer = vec![0u16; len + 1];
            names.GetString(index, &mut buffer).ok()?;
            Some(String::from_utf16_lossy(&buffer[..len]))
        }
    }

    /// 某语言名称的下标；`FindLocaleName` 用全称且大小写不敏感，如 `zh-cn`。
    fn locale_index(names: &IDWriteLocalizedStrings, locale: &str) -> Option<u32> {
        let wide: Vec<u16> = locale.encode_utf16().chain(std::iter::once(0)).collect();
        let mut index = 0u32;
        let mut exists = BOOL(0);
        unsafe {
            names
                .FindLocaleName(PCWSTR(wide.as_ptr()), &mut index, &mut exists)
                .ok()?;
        }
        exists.as_bool().then_some(index)
    }

    /// 拉丁字体在前、中文字体在后，各自按小写名排序。
    fn sort_key(entry: &FontEntry) -> (u8, String) {
        let cjk = entry
            .label
            .chars()
            .next()
            .is_some_and(|c| (c as u32) >= 0x2E80);
        (u8::from(cjk), entry.label.to_lowercase())
    }

    let mut out: Vec<FontEntry> = Vec::new();
    unsafe {
        let factory: IDWriteFactory = match DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) {
            Ok(factory) => factory,
            Err(_) => return out,
        };
        let mut collection: Option<IDWriteFontCollection> = None;
        if factory
            .GetSystemFontCollection(&mut collection, false)
            .is_err()
        {
            return out;
        }
        let Some(collection) = collection else {
            return out;
        };
        for index in 0..collection.GetFontFamilyCount() {
            let Ok(family) = collection.GetFontFamily(index) else {
                continue;
            };
            let Ok(names) = family.GetFamilyNames() else {
                continue;
            };
            // 第一条名称当 CSS 名，中文名优先用于显示；没有中文名就用第一条。
            let Some(name) = text_at(&names, 0) else {
                continue;
            };
            let label = locale_index(&names, "zh-cn")
                .and_then(|index| text_at(&names, index))
                .unwrap_or_else(|| name.clone());
            if out.iter().any(|item| item.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            out.push(FontEntry { name, label });
        }
    }
    out.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    out
}
