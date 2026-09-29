# 画像（PNG）から Chromium の疑似カメラ用 Y4M 動画を作る（E2E のカメラ読取試験用）
import sys, pymupdf
src, out = sys.argv[1], sys.argv[2]
W, H = 640, 480
pix = pymupdf.Pixmap(src)
if pix.alpha: pix = pymupdf.Pixmap(pix, 0)
# 中央に配置（白背景）
scale = min(W * 0.6 / pix.width, H * 0.6 / pix.height)
nw, nh = int(pix.width * scale), int(pix.height * scale)
ox, oy = (W - nw) // 2, (H - nh) // 2
Y = bytearray([235]) * (W * H)
samples = pix.samples; n = pix.n
for y in range(nh):
    sy = int(y / scale)
    for x in range(nw):
        sx = int(x / scale)
        i = (sy * pix.width + sx) * n
        r, g, b = samples[i], samples[i + 1], samples[i + 2]
        Y[(oy + y) * W + ox + x] = int(16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256)
U = bytes([128]) * (W * H // 4)
with open(out, 'wb') as f:
    f.write(f'YUV4MPEG2 W{W} H{H} F10:1 Ip A1:1 C420jpeg\n'.encode())
    for _ in range(20):
        f.write(b'FRAME\n'); f.write(bytes(Y)); f.write(U); f.write(U)
