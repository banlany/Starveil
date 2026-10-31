"""按进程名抓窗口截图，或按「窗口内相对坐标」点击。

用法：
    python tools/shot.py shot starveil.exe out.png [--maximize]
    python tools/shot.py click starveil.exe 0.042 0.105

截图走屏幕 BitBlt：WebView2 用 PrintWindow 常常只能拿到黑图。
"""

import ctypes
import struct
import sys
import time
import zlib
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def find_window_by_process(process_name: str):
    target = process_name.lower()
    hits = []

    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)
        if not handle:
            return True
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(
            handle, 0, buffer, ctypes.byref(size)
        ):
            if buffer.value.split("\\")[-1].lower() == target:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                area = (rect.right - rect.left) * (rect.bottom - rect.top)
                if area > 10000:
                    hits.append((area, hwnd, rect))
        ctypes.windll.kernel32.CloseHandle(handle)
        return True

    enum = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(enum(callback), 0)
    if not hits:
        raise SystemExit(f"没找到进程 {process_name} 的窗口")
    hits.sort(reverse=True)
    return hits[0]


class HDR(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class INFO(ctypes.Structure):
    _fields_ = [("bmiHeader", HDR), ("bmiColors", wintypes.DWORD * 3)]


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    with open(path, "wb") as handle:
        handle.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b"")
        )


def shot(process: str, out: str, maximize: bool = False):
    _area, hwnd, rect = find_window_by_process(process)
    if maximize:
        user32.ShowWindow(hwnd, 3)
        # 强制提到最前：Windows 会拦截 SetForegroundWindow，用 TOPMOST 兜底。
        HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
        SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 0x0002, 0x0001, 0x0040
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        time.sleep(1.6)
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
        time.sleep(0.3)
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    screen_dc = user32.GetDC(0)
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)
    ok = gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, rect.left, rect.top, 0x00CC0020)

    info = INFO()
    info.bmiHeader.biSize = ctypes.sizeof(HDR)
    info.bmiHeader.biWidth = width
    info.bmiHeader.biHeight = -height
    info.bmiHeader.biPlanes = 1
    info.bmiHeader.biBitCount = 32
    info.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(width * height * 4)
    lines = gdi32.GetDIBits(mem_dc, bitmap, 0, height, buf, ctypes.byref(info), 0)
    data = buf.raw
    rows = []
    for y in range(height):
        start = y * width * 4
        row = bytearray(width * 3)
        for x in range(width):
            b, g, r = data[start + x * 4], data[start + x * 4 + 1], data[start + x * 4 + 2]
            row[x * 3 : x * 3 + 3] = bytes((r, g, b))
        rows.append(bytes(row))
    write_png(out, width, height, rows)
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(0, screen_dc)
    print(f"shot ok={ok} lines={lines} size={width}x{height} at=({rect.left},{rect.top}) -> {out}")


def click(process: str, frac_x: float, frac_y: float, pause: float = 1.2):
    _area, hwnd, rect = find_window_by_process(process)
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)
    x = rect.left + int(frac_x * width)
    y = rect.top + int(frac_y * height)
    user32.SetCursorPos(x, y)
    time.sleep(0.35)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(pause)
    print(f"click frac=({frac_x:.3f},{frac_y:.3f}) -> screen({x},{y}) window={width}x{height}")


def scroll(process: str, frac_x: float, frac_y: float, notches: int, pause: float = 0.8):
    """在窗口内相对位置滚轮：notches > 0 向下滚（Windows 一格 = 120）。"""
    _area, hwnd, rect = find_window_by_process(process)
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)
    x = rect.left + int(frac_x * width)
    y = rect.top + int(frac_y * height)
    user32.SetCursorPos(x, y)
    time.sleep(0.3)
    step = -120 if notches > 0 else 120
    for _ in range(abs(notches)):
        user32.mouse_event(0x0800, 0, 0, step, 0)
        time.sleep(0.12)
    time.sleep(pause)
    print(f"scroll frac=({frac_x:.3f},{frac_y:.3f}) notches={notches} -> screen({x},{y})")


def main():
    action = sys.argv[1]
    if action == "shot":
        shot(sys.argv[2], sys.argv[3], "--maximize" in sys.argv)
    elif action == "click":
        click(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
    elif action == "scroll":
        scroll(sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
