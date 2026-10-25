"""生成星幕直播的图标与 logo。

设计：深紫到品红的圆角方形底，中央白色播放三角，右上角一颗四芒星，
小尺寸下仍能看清「播放 + 星」的轮廓。
"""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

SIZE = 2048
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "assets")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(WEB_DIR, exist_ok=True)

# 渐变底
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
grad = Image.new("RGBA", (SIZE, SIZE))
pixels = grad.load()
stops = [
    (0.0, (35, 25, 95)),
    (0.42, (91, 61, 239)),
    (0.74, (196, 78, 235)),
    (1.0, (255, 93, 154)),
]


def sample(t):
    for i in range(len(stops) - 1):
        a, ca = stops[i]
        b, cb = stops[i + 1]
        if a <= t <= b:
            k = (t - a) / (b - a)
            return tuple(int(ca[j] + (cb[j] - ca[j]) * k) for j in range(3))
    return stops[-1][1]


for y in range(SIZE):
    for x in range(SIZE):
        t = (x / SIZE * 0.62 + y / SIZE * 0.38)
        pixels[x, y] = sample(min(1.0, max(0.0, t))) + (255,)

# 圆角遮罩
mask = Image.new("L", (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle((60, 60, SIZE - 60, SIZE - 60), radius=430, fill=255)
bg.paste(grad, (0, 0), mask)

# 柔光
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((250, 120, 1300, 1170), fill=(255, 255, 255, 30))
gd.ellipse((900, 700, 1900, 1750), fill=(255, 255, 255, 22))
glow = glow.filter(ImageFilter.GaussianBlur(180))
bg.alpha_composite(Image.composite(glow, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask))

# 内部细边框
border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(border)
bd.rounded_rectangle((84, 84, SIZE - 84, SIZE - 84), radius=405, outline=(255, 255, 255, 46), width=10)
bg.alpha_composite(border)

# 播放三角（带一点圆角感：先画三角，再在顶点补圆）
triangle = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
td = ImageDraw.Draw(triangle)
points = [(770, 585), (770, 1465), (1470, 1025)]
td.polygon(points, fill=(255, 255, 255, 248))
# 轻微投影
shadow = triangle.filter(ImageFilter.GaussianBlur(26))
shadow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
shadow_layer.paste((30, 15, 60, 90), (0, 0), shadow)
shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(24))
bg.alpha_composite(shadow_layer)
bg.alpha_composite(triangle)

# 四芒星
def star(cx, cy, outer, inner, color):
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    pts = []
    for i in range(8):
        angle = math.pi / 4 * i - math.pi / 2
        radius = outer if i % 2 == 0 else inner
        pts.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    d.polygon(pts, fill=color)
    return layer

spark = star(1520, 605, 210, 58, (255, 246, 214, 255))
spark_glow = spark.filter(ImageFilter.GaussianBlur(34))
bg.alpha_composite(spark_glow)
bg.alpha_composite(spark)

tiny = star(1540, 1460, 66, 18, (255, 255, 255, 210))
bg.alpha_composite(tiny)

# 输出
icon = bg.resize((1024, 1024), Image.LANCZOS)
icon.save(os.path.join(OUT_DIR, "icon.png"))
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(WEB_DIR, "logo.png"))
icon.save(
    os.path.join(OUT_DIR, "icon.ico"),
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("wrote", os.path.join(OUT_DIR, "icon.ico"))
