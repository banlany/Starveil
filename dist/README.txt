星幕直播 · Starveil 0.3.6
==========================

双击 Starveil.exe 即可运行。
程序未做代码签名，Windows SmartScreen 可能提示未知发布者，选择「更多信息 → 仍要运行」即可。

系统要求
--------
- Windows 10 / 11（x64）
- Microsoft Edge WebView2 Runtime（Win11 自带；Win10 如缺失请安装）
- 无需安装其他运行库，程序已静态链接 VC 运行库

数据位置
--------
设置、关注、观看记录与登录 Cookie 保存在 WebView2 的应用数据目录：
  %LOCALAPPDATA%\top.june6699.starveil\EBWebView
删除该目录会同时清除本机设置、记录与登录态。

功能范围
--------
- 哔哩哔哩：推荐 / 分类 / 搜索 / 直播间 / 弹幕 / 聊天 / 扫码登录 / Cookie 登录
- 斗鱼：推荐 / 分类 / 搜索 / 直播间 / 弹幕；取流通过 WebView 执行平台签名，
  并由本机 127.0.0.1 流代理补齐 Referer；支持 Cookie 登录
- 虎牙：推荐 / 分类 / 搜索 / 直播间取流（弹幕 Tars 协议未接入）
- 抖音 / 快手：入口已预留，接口未接入

更多说明见上级目录 README.md。
