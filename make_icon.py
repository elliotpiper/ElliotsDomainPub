"""Generate domain.ico (pure stdlib) - Elliot's Domain application icon.

A dark rounded tile carrying the hub in miniature: a glowing cyan core, one
orbit ring, and the six nodes sitting on it in their real accent colours.
Supersampled 3x so the curves stay clean down at 16px.
"""
import math
import struct

SS = 3                      # supersample factor
BG_EDGE = (4, 26, 38)       # tile corners
BG_MID = (10, 62, 84)       # tile centre
NODE_COLORS = [             # clockwise from top, matching the hub
    (34, 211, 238),         # Elliot's Jira Board
    (79, 156, 249),         # Jira WD
    (167, 139, 250),        # Confluence
    (245, 166, 35),         # Sprint plan 2026
    (244, 114, 182),        # Figma
    (52, 211, 153),         # Agentic Workflow
]


def clamp(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))


def over(dst, src, a):
    """Alpha-composite src over dst."""
    return tuple(clamp(s * a + d * (1 - a)) for s, d in zip(src, dst))


def render(size):
    n = size * SS
    c = (n - 1) / 2.0
    px = [(0, 0, 0, 0)] * (n * n)

    tile_r = n * 0.46           # half-width of the rounded tile
    corner = n * 0.115          # corner radius
    orbit = n * 0.295           # node ring radius
    core_r = n * 0.105
    node_r = n * 0.062
    edge = max(n * 0.006, 1.0)  # antialias width

    nodes = []
    for i, col in enumerate(NODE_COLORS):
        a = -math.pi / 2 + i * (math.pi / 3)
        nodes.append((c + orbit * math.cos(a), c + orbit * math.sin(a), col))

    for y in range(n):
        for x in range(n):
            dx, dy = x - c, y - c

            # --- rounded-square coverage (squircle via corner circle) ---
            ax, ay = abs(dx), abs(dy)
            inner = tile_r - corner
            if ax <= inner or ay <= inner:
                dist = max(ax, ay) - tile_r
            else:
                dist = math.hypot(ax - inner, ay - inner) - corner
            cover = min(1.0, max(0.0, 0.5 - dist / edge))
            if cover <= 0.0:
                continue

            # --- tile ground: soft radial lift toward the centre ---
            t = min(1.0, math.hypot(dx, dy) / tile_r)
            base = tuple(BG_MID[k] * (1 - t) ** 1.7 + BG_EDGE[k] * (1 - (1 - t) ** 1.7)
                         for k in range(3))

            # --- orbit ring ---
            ring = abs(math.hypot(dx, dy) - orbit)
            rw = max(n * 0.008, 1.0)
            if ring < rw * 2:
                base = over(base, (120, 220, 255), 0.34 * max(0.0, 1 - ring / (rw * 2)))

            # --- core glow + core ---
            d = math.hypot(dx, dy)
            base = over(base, (110, 235, 255), 0.42 * math.exp(-(d / (n * 0.20)) ** 2))
            if d < core_r + edge:
                a_core = min(1.0, max(0.0, 0.5 - (d - core_r) / edge))
                shade = min(1.0, d / core_r) if core_r else 0.0
                core_col = (
                    200 * (1 - shade) + 40 * shade,
                    250 * (1 - shade) + 190 * shade,
                    255 * (1 - shade) + 230 * shade,
                )
                base = over(base, core_col, a_core)

            # --- the six nodes ---
            for nx, ny, col in nodes:
                nd = math.hypot(x - nx, y - ny)
                if nd > node_r * 3.2:
                    continue
                base = over(base, col, 0.5 * math.exp(-(nd / (node_r * 1.5)) ** 2))
                if nd < node_r + edge:
                    base = over(base, col, min(1.0, max(0.0, 0.5 - (nd - node_r) / edge)))

            px[y * n + x] = (clamp(base[0]), clamp(base[1]), clamp(base[2]),
                             clamp(cover * 255))

    # --- box-downsample to the target size ---
    out = []
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = px[(y * SS + sy) * n + (x * SS + sx)]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            if a:
                out.append((clamp(r / a), clamp(g / a), clamp(b / a), clamp(a / (SS * SS))))
            else:
                out.append((0, 0, 0, 0))
    return out


def bmp(px, size):
    hdr = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    rows = []
    for y in range(size - 1, -1, -1):          # ICO stores bottom-up
        row = bytearray()
        for x in range(size):
            r, g, b, a = px[y * size + x]
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    mask_stride = ((size + 31) // 32) * 4
    return hdr + b''.join(rows) + b'\x00' * (mask_stride * size)


if __name__ == '__main__':
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [bmp(render(s), s) for s in sizes]
    out = bytearray(struct.pack('<HHH', 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for s, img in zip(sizes, images):
        out += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    for img in images:
        out += img
    with open('domain.ico', 'wb') as fh:
        fh.write(bytes(out))
    print('domain.ico', len(out), 'bytes,', len(sizes), 'sizes')
