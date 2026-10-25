//! 斗鱼签名诊断：打印下发脚本的入口形态、运行环境与多种参数形态的调用结果。
//!
//! ```bash
//! cargo run -p live_core --example douyu_probe -- 9999
//! ```

#[cfg(not(feature = "douyu-js"))]
fn main() {
    println!("需要 douyu-js 特性");
}

#[cfg(feature = "douyu-js")]
fn main() {
    use boa_engine::{Context, JsValue, NativeFunction, Source, js_string};
    use live_core::HttpSession;

    let rid = std::env::args().nth(1).unwrap_or_else(|| "9999".to_string());
    let http = HttpSession::new();
    let referer = format!("https://www.douyu.com/{rid}");
    let raw = http
        .get_text(
            "https://www.douyu.com/swf_api/homeH5Enc",
            &[("rids", rid.as_str())],
            &[
                ("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124"),
                ("referer", referer.as_str()),
            ],
        )
        .expect("拉取脚本失败");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON");
    let script = value["data"][format!("room{rid}")]
        .as_str()
        .expect("脚本字段")
        .to_string();

    println!("脚本长度 {}", script.len());
    println!("  含 CryptoJS: {}", script.contains("CryptoJS"));
    println!("  含 eval(strc): {}", script.contains("eval(strc)"));

    let mut context = Context::default();
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
        .expect("注册 md5");
    context
        .eval(Source::from_bytes(
            r#"var CryptoJS={MD5:function(x){var h=__ely_md5(String(x));return {toString:function(){return h;},valueOf:function(){return h;}};},enc:{Hex:{stringify:function(w){return String(w);}},Utf8:{parse:function(t){return t;}}}};"#,
        ))
        .expect("兼容层");

    match context.eval(Source::from_bytes(script.as_bytes())) {
        Ok(_) => println!("脚本执行 OK"),
        Err(error) => println!("脚本执行失败: {error}"),
    }

    for expr in [
        "typeof ub98484234 + '/len' + ub98484234.length",
        "(function(){function __t(a){return a+1;} return String(__t(1));})()",
        "String(eval('1+1'))",
        "typeof q7cad0d5d90",
    ] {
        let probe = format!("try{{ String({expr}) }}catch(e){{ 'ERR ' + e.message }}");
        match context.eval(Source::from_bytes(probe.as_bytes())) {
            Ok(value) => println!(
                "{expr} => {}",
                value
                    .to_string(&mut context)
                    .map(|text| text.to_std_string_escaped())
                    .unwrap_or_default()
            ),
            Err(error) => println!("{expr} => 失败: {error}"),
        }
    }

    let cases = [
        (
            "字符串 did",
            format!("'{rid}','10000000000000000000000000001501','1700000000'"),
        ),
        (
            "数组 did",
            format!("'{rid}',('10000000000000000000000000001501').split(''),'1700000000'"),
        ),
        (
            "32位hex did",
            format!("'{rid}','abcdef0123456789abcdef0123456789','1700000000'"),
        ),
    ];
    for (label, args) in cases {
        let call = format!("try{{ String(ub98484234({args})) }}catch(e){{ 'ERR ' + e.message }}");
        match context.eval(Source::from_bytes(call.as_bytes())) {
            Ok(value) => println!(
                "{label} => {}",
                value
                    .to_string(&mut context)
                    .map(|text| text.to_std_string_escaped())
                    .unwrap_or_default()
            ),
            Err(error) => println!("{label} => 调用失败: {error}"),
        }
    }
}
