//! 调用虎牙 `getCdnTokenInfoEx` 获取新的 FLV anti-code。
//!
//! 页面里的 `sFlvAntiCode` 是给移动页/旧接口用的，直接拿来拼 CDN 地址
//! 通常只能播几秒就被断开。Dart 版每次取流都会走 Tars 请求换一个新 token，
//! 这里用最小实现移植同样的 Tars/TUP3 编解码，避免引入完整的 Tars 运行时。

use reqwest::blocking::Client;
use std::time::Duration;

const BYTE: u8 = 0;
const SHORT: u8 = 1;
const INT: u8 = 2;
const LONG: u8 = 3;
const FLOAT: u8 = 4;
const DOUBLE: u8 = 5;
const STRING1: u8 = 6;
const STRING4: u8 = 7;
const MAP: u8 = 8;
const LIST: u8 = 9;
const STRUCT_BEGIN: u8 = 10;
const STRUCT_END: u8 = 11;
const ZERO_TAG: u8 = 12;
const SIMPLE_LIST: u8 = 13;

struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn head(&mut self, ty: u8, tag: u8) {
        if tag < 15 {
            self.buf.push((tag << 4) | ty);
        } else {
            self.buf.push(0xF0 | ty);
            self.buf.push(tag);
        }
    }

    fn int(&mut self, value: i64, tag: u8) {
        if value == 0 {
            self.head(ZERO_TAG, tag);
        } else if (-128..=127).contains(&value) {
            self.head(BYTE, tag);
            self.buf.push(value as u8);
        } else if (-32768..=32767).contains(&value) {
            self.head(SHORT, tag);
            self.buf.extend_from_slice(&(value as i16).to_be_bytes());
        } else if (-2147483648..=2147483647).contains(&value) {
            self.head(INT, tag);
            self.buf.extend_from_slice(&(value as i32).to_be_bytes());
        } else {
            self.head(LONG, tag);
            self.buf.extend_from_slice(&value.to_be_bytes());
        }
    }

    fn string(&mut self, value: &str, tag: u8) {
        let bytes = value.as_bytes();
        if bytes.len() > 255 {
            self.head(STRING4, tag);
            self.buf.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        } else {
            self.head(STRING1, tag);
            self.buf.push(bytes.len() as u8);
        }
        self.buf.extend_from_slice(bytes);
    }

    fn bytes(&mut self, value: &[u8], tag: u8) {
        self.head(SIMPLE_LIST, tag);
        self.head(BYTE, 0);
        self.int(value.len() as i64, 0);
        self.buf.extend_from_slice(value);
    }

    fn empty_map(&mut self, tag: u8) {
        self.head(MAP, tag);
        self.int(0, 0);
    }

    fn one_entry_map(&mut self, key: &str, value: &[u8], tag: u8) {
        self.head(MAP, tag);
        self.int(1, 0);
        self.string(key, 0);
        self.bytes(value, 1);
    }
}

fn build_request(stream: &str) -> Vec<u8> {
    // GetCdnTokenExReq { sFlvUrl="", sStreamName, iLoopTime=0, tId, iAppId=66 }
    let mut req = Writer::new();
    req.head(STRUCT_BEGIN, 0);
    req.string("", 0);
    req.string(stream, 1);
    req.int(0, 2);

    // HuyaUserId { lUid=0, ..., sHuYaUA="pc_exe&7060000&official", ... }
    req.head(STRUCT_BEGIN, 3);
    req.int(0, 0);
    req.string("", 1);
    req.string("", 2);
    req.string("pc_exe&7060000&official", 3);
    req.string("", 4);
    req.int(0, 5);
    req.string("", 6);
    req.string("", 7);
    req.head(STRUCT_END, 0);
    req.int(66, 4);
    req.head(STRUCT_END, 0);

    // TUP3 参数 map：{"tReq": <struct bytes>}
    let mut args = Writer::new();
    args.one_entry_map("tReq", &req.buf, 0);

    // RequestPacket
    let mut body = Writer::new();
    body.int(3, 1); // iVersion = TUP3
    body.int(0, 2); // cPacketType
    body.int(0, 3); // iMessageType
    body.int(0, 4); // iRequestId
    body.string("liveui", 5);
    body.string("getCdnTokenInfoEx", 6);
    body.bytes(&args.buf, 7);
    body.int(0, 8); // iTimeout
    body.empty_map(9); // context
    body.empty_map(10); // status

    let mut packet = Vec::with_capacity(body.buf.len() + 4);
    packet.extend_from_slice(&((body.buf.len() + 4) as u32).to_be_bytes());
    packet.extend_from_slice(&body.buf);
    packet
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn byte(&mut self) -> Result<u8, String> {
        let value = *self.data.get(self.pos).ok_or("虎牙 token 响应被截断")?;
        self.pos += 1;
        Ok(value)
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(len).ok_or("虎牙 token 长度溢出")?;
        let slice = self.data.get(self.pos..end).ok_or("虎牙 token 响应被截断")?;
        self.pos = end;
        Ok(slice)
    }

    fn head(&mut self) -> Result<(u8, u8), String> {
        let first = self.byte()?;
        let ty = first & 0x0F;
        let mut tag = (first >> 4) & 0x0F;
        if tag == 15 {
            tag = self.byte()?;
        }
        Ok((ty, tag))
    }

    fn int_with_type(&mut self, ty: u8) -> Result<i64, String> {
        match ty {
            ZERO_TAG => Ok(0),
            BYTE => Ok(self.byte()? as i64),
            SHORT => {
                let bytes = self.take(2)?;
                Ok(i16::from_be_bytes([bytes[0], bytes[1]]) as i64)
            }
            INT => {
                let bytes = self.take(4)?;
                Ok(i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as i64)
            }
            LONG => {
                let bytes = self.take(8)?;
                let mut array = [0u8; 8];
                array.copy_from_slice(bytes);
                Ok(i64::from_be_bytes(array))
            }
            _ => Err(format!("虎牙 token 字段类型错误：{ty}")),
        }
    }

    fn int(&mut self) -> Result<i64, String> {
        let (ty, _tag) = self.head()?;
        self.int_with_type(ty)
    }

    fn string(&mut self) -> Result<String, String> {
        let (ty, _tag) = self.head()?;
        self.string_with_type(ty)
    }

    fn string_with_type(&mut self, ty: u8) -> Result<String, String> {
        let len = match ty {
            STRING1 => self.byte()? as usize,
            STRING4 => {
                let bytes = self.take(4)?;
                u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
            }
            _ => return Err(format!("虎牙 token 字符串类型错误：{ty}")),
        };
        let bytes = self.take(len)?;
        Ok(String::from_utf8_lossy(bytes).to_string())
    }

    fn bytes(&mut self) -> Result<Vec<u8>, String> {
        let (ty, _tag) = self.head()?;
        if ty != SIMPLE_LIST {
            let start = self.pos.saturating_sub(8);
            let end = (self.pos + 16).min(self.data.len());
            return Err(format!(
                "虎牙 token 字节类型错误：{ty} at {} / {:02x?}",
                self.pos,
                &self.data[start..end]
            ));
        }
        self.bytes_after_head()
    }

    fn bytes_after_head(&mut self) -> Result<Vec<u8>, String> {
        let (elem_ty, _elem_tag) = self.head()?;
        if elem_ty != BYTE {
            return Err("虎牙 token 字节元素类型错误".to_string());
        }
        let len = self.int()? as usize;
        Ok(self.take(len)?.to_vec())
    }

    fn skip(&mut self, ty: u8) -> Result<(), String> {
        match ty {
            ZERO_TAG | STRUCT_END => {}
            BYTE => {
                self.take(1)?;
            }
            SHORT => {
                self.take(2)?;
            }
            INT => {
                self.take(4)?;
            }
            LONG => {
                self.take(8)?;
            }
            FLOAT => {
                self.take(4)?;
            }
            DOUBLE => {
                self.take(8)?;
            }
            STRING1 => {
                let len = self.byte()? as usize;
                self.take(len)?;
            }
            STRING4 => {
                let bytes = self.take(4)?;
                let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
                self.take(len)?;
            }
            MAP => {
                let size = self.int()?;
                for _ in 0..size.max(0) * 2 {
                    let (child, _) = self.head()?;
                    self.skip(child)?;
                }
            }
            LIST => {
                let size = self.int()?;
                for _ in 0..size.max(0) {
                    let (child, _) = self.head()?;
                    self.skip(child)?;
                }
            }
            SIMPLE_LIST => {
                let (elem, _) = self.head()?;
                if elem != BYTE {
                    return Err("虎牙 token 简单列表元素错误".to_string());
                }
                let len = self.int()? as usize;
                self.take(len)?;
            }
            STRUCT_BEGIN => loop {
                let (child, _) = self.head()?;
                if child == STRUCT_END {
                    break;
                }
                self.skip(child)?;
            },
            other => return Err(format!("虎牙 token 未知 Tars 类型：{other}")),
        }
        Ok(())
    }

    fn eof(&self) -> bool {
        self.pos >= self.data.len()
    }
}

fn parse_token(packet: &[u8]) -> Result<String, String> {
    if packet.len() < 4 {
        return Err("虎牙 token 响应过短".to_string());
    }
    let mut reader = Reader::new(&packet[4..]);
    let mut buffer = None;
    while !reader.eof() {
        let (ty, tag) = reader.head()?;
        if tag == 7 {
            if ty != SIMPLE_LIST {
                return Err(format!("虎牙 token 数据字段类型错误：{ty}"));
            }
            buffer = Some(reader.bytes_after_head()?);
        } else {
            reader.skip(ty)?;
        }
    }
    let buffer = buffer.ok_or("虎牙 token 响应缺少数据")?;

    // 参数 map: {"tRsp": <bytes>}
    let mut args = Reader::new(&buffer);
    let (ty, _) = args.head()?;
    if ty != MAP {
        return Err("虎牙 token 参数不是 Map".to_string());
    }
    let size = args.int()?;
    let mut response = None;
    for _ in 0..size.max(0) {
        let key = args.string()?;
        let value = args.bytes()?;
        if key == "tRsp" {
            response = Some(value);
        }
    }
    let response = response.ok_or("虎牙 token 响应缺少 tRsp")?;

    // GetCdnTokenExResp { sFlvToken, iExpireTime }
    let mut body = Reader::new(&response);
    let (ty, _) = body.head()?;
    if ty != STRUCT_BEGIN {
        return Err("虎牙 token 结构不是 Struct".to_string());
    }
    let mut token = String::new();
    loop {
        let (ty, tag) = body.head()?;
        if ty == STRUCT_END {
            break;
        }
        match tag {
            0 => token = body.string_with_type(ty)?,
            1 => {
                body.int_with_type(ty)?;
            }
            _ => body.skip(ty)?,
        }
    }
    if token.is_empty() {
        return Err("虎牙 token 为空".to_string());
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn fetch_real_token() {
        let stream = "78941969-2559461593-10992803837303062528-2693342886-10057-A-0-1-imgplus";
        let token = super::fetch_token(stream).expect("虎牙 token");
        println!("{token}");
        assert!(token.contains("wsSecret="));
        assert!(token.contains("wsTime="));
    }
}

/// 拿一条新的 FLV anti-code；失败时由调用方回退到页面里的 anti-code。
pub fn fetch_token(stream: &str) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("虎牙 token 客户端创建失败：{error}"))?;
    let response = client
        .post("http://wup.huya.com")
        .header("Content-Type", "application/x-wup")
        .header("Origin", "https://m.huya.com/")
        .header("Referer", "https://m.huya.com/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; Android 10; SM-G9730) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        )
        .body(build_request(stream))
        .send()
        .map_err(|error| format!("虎牙 token 请求失败：{error}"))?;
    let packet = response
        .bytes()
        .map_err(|error| format!("虎牙 token 读取失败：{error}"))?;
    parse_token(&packet)
}
