//! 斗鱼取流签名。
//!
//! 斗鱼会把签名函数按房间号下发（`homeH5Enc`），函数体高度混淆且每次不同，
//! 只能执行不能移植。这里用纯 Rust 的 boa 引擎跑它，入口固定为
//! `ub98484234(rid, did, tt)`。
//!
//! 下发的脚本分两类：一类自带 md5，另一类直接引用页面上原有的 `CryptoJS`。
//! 所以执行前先注入一个 `CryptoJS` 兼容层，MD5 由 Rust 的 md5 实现提供，
//! 既保证结果正确，也不用在 JS 里重写摘要算法。

use crate::error::LiveError;

/// 兼容层：只提供签名脚本实际会用到的接口。
const CRYPTO_SHIM: &str = r#"
({
  MD5: function (input) {
    var hex = __ely_md5(String(input));
    return {
      toString: function () { return hex; },
      valueOf: function () { return hex; }
    };
  },
  enc: {
    Hex: {
      stringify: function (word) { return String(word); },
      parse: function (hex) { return hex; }
    },
    Utf8: {
      stringify: function (text) { return String(text); },
      parse: function (text) { return text; }
    }
  },
  lib: {
    WordArray: {
      create: function (words) { return words; }
    }
  }
})
"#;

/// boa 的间接 eval 在部分版本里访问不到全局 var 里的 CryptoJS，
/// 而斗鱼下发的签名函数恰好把 MD5 调用写进 eval 字符串。
/// 这里直接把 `CryptoJS.MD5(cb).toString()` 替换成 Rust 预算好的十六进制摘要，
/// 让混淆函数只做纯位运算，不再依赖 JS 里的大整数/对象调用。
fn patch_eval_string(text: &str) -> String {
    let pattern = match regex::Regex::new(r"CryptoJS\.MD5\(([^)]*)\)\.toString\(\)") {
        Ok(pattern) => pattern,
        Err(_) => return text.to_string(),
    };
    pattern.replace_all(text, "__ely_md5($1)").to_string()
}

#[cfg(feature = "douyu-js")]
pub fn sign(script: &str, rid: &str, did: &str, timestamp: u64) -> Result<String, LiveError> {
    use boa_engine::{Context, JsValue, NativeFunction, Source, js_string};

    let mut context = Context::default();

    // 把 md5 暴露成全局函数，供兼容层调用。
    context
        .register_global_builtin_callable(
            js_string!("__ely_md5"),
            1,
            NativeFunction::from_fn_ptr(|_this, args, ctx| {
                let input = args.first().cloned().unwrap_or(JsValue::undefined());
                let text = input.to_string(ctx)?.to_std_string_escaped();
                let hex = format!("{:x}", md5::compute(text.as_bytes()));
                Ok(JsValue::from(js_string!(hex)))
            }),
        )
        .map_err(|error| LiveError::protocol(format!("斗鱼签名环境初始化失败：{error}")))?;

    let crypto = context
        .eval(Source::from_bytes(CRYPTO_SHIM))
        .map_err(|error| LiveError::protocol(format!("斗鱼签名兼容层加载失败：{error}")))?;
    context
        .global_object()
        .set(js_string!("CryptoJS"), crypto, false, &mut context)
        .map_err(|error| LiveError::protocol(format!("斗鱼签名兼容层挂载失败：{error}")))?;

    // 斗鱼脚本把真正的签名函数藏在 eval 字符串里，并在里面调用 CryptoJS.MD5。
    // boa 的间接 eval 对全局对象属性解析不稳定，这里接管 eval，把 MD5 调用换成原生函数。
    let eval_fn = NativeFunction::from_fn_ptr(|_this, args, ctx| {
        let input = args.first().cloned().unwrap_or(JsValue::undefined());
        let text = input.to_string(ctx)?.to_std_string_escaped();
        let patched = patch_eval_string(&text);
        ctx.eval(Source::from_bytes(patched.as_bytes()))
    });
    let eval_value: JsValue = eval_fn.to_js_function(context.realm()).into();
    context
        .global_object()
        .set(js_string!("eval"), eval_value, true, &mut context)
        .map_err(|error| LiveError::protocol(format!("斗鱼签名 eval 接管失败：{error}")))?;

    context
        .eval(Source::from_bytes(script))
        .map_err(|error| LiveError::protocol(format!("斗鱼签名脚本无法执行：{error}")))?;

    // 有些房间的脚本只定义了一半，这里给一个明确的错误而不是 undefined 调用失败。
    let ready = context
        .eval(Source::from_bytes(
            b"typeof ub98484234 === 'function' ? 'yes' : 'no'",
        ))
        .map_err(|error| LiveError::protocol(format!("斗鱼签名脚本自检失败：{error}")))?
        .to_string(&mut context)
        .map_err(|error| LiveError::protocol(format!("斗鱼签名脚本自检失败：{error}")))?
        .to_std_string_escaped();
    if ready != "yes" {
        return Err(LiveError::protocol(
            "斗鱼签名脚本里没有 ub98484234 函数（脚本结构已变更）",
        ));
    }

    let call = format!("ub98484234('{rid}','{did}','{timestamp}')");
    let signed = context
        .eval(Source::from_bytes(call.as_bytes()))
        .map_err(|error| LiveError::protocol(format!("斗鱼签名函数调用失败：{error}")))?
        .to_string(&mut context)
        .map_err(|error| LiveError::protocol(format!("斗鱼签名结果无法转成字符串：{error}")))?
        .to_std_string_escaped();

    if signed.trim().is_empty() || signed == "undefined" {
        return Err(LiveError::protocol("斗鱼签名脚本返回空结果"));
    }
    Ok(signed)
}

#[cfg(not(feature = "douyu-js"))]
pub fn sign(_script: &str, _rid: &str, _did: &str, _timestamp: u64) -> Result<String, LiveError> {
    Err(LiveError::unsupported(
        "斗鱼取流需要执行下发的 JS 签名，但编译时关闭了 douyu-js 特性",
    ))
}

/// 32 位十六进制设备号，进程内复用（匿名请求共用写死的假 did 容易被风控掐流）。
pub fn device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

#[cfg(all(test, feature = "douyu-js"))]
mod tests {
    use super::*;

    /// 自带 md5 的脚本。
    #[test]
    fn 执行自带md5的脚本() {
        let script = r#"
            function ub98484234(rid, did, tt) {
                return "did=" + did + "&tt=" + tt + "&sign=" + __ely_md5(rid + did + tt);
            }
        "#;
        let signed = sign(script, "9999", "abc", 1_700_000_000).expect("应当签名成功");
        assert!(signed.starts_with("did=abc&tt=1700000000&sign="));
        let digest = &signed["did=abc&tt=1700000000&sign=".len()..];
        assert_eq!(digest.len(), 32);
        assert_eq!(
            digest,
            format!(
                "{:x}",
                md5::compute("9999abc1700000000".as_bytes())
            )
        );
    }

    /// 依赖页面 CryptoJS 的脚本（真实失败案例）。
    #[test]
    fn 兼容层提供CryptoJS() {
        let script = r#"
            function ub98484234(rid, did, tt) {
                return "v=1&sign=" + CryptoJS.MD5(rid + did + tt).toString();
            }
        "#;
        let signed = sign(script, "252140", "did-1", 1_700_000_001).expect("应当签名成功");
        let digest = signed.strip_prefix("v=1&sign=").expect("格式正确");
        assert_eq!(digest.len(), 32);
        assert_eq!(
            digest,
            format!("{:x}", md5::compute("252140did-11700000001".as_bytes()))
        );
    }

    /// 脚本结构变更时给出可读错误，而不是 panic。
    #[test]
    fn 缺少入口函数时报错() {
        let error = sign("var nothing = 1;", "1", "d", 1).expect_err("应当报错");
        assert!(matches!(error, LiveError::ProtocolChanged(_)), "{error:?}");
    }

    #[test]
    fn 设备号是32位十六进制() {
        let did = device_id();
        assert_eq!(did.len(), 32);
        assert!(did.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(did, device_id());
    }
}
