"""
Plays the reference game for observation: reads the 10x20 well from the screen (ffmpeg Desktop
Duplication, cropped and averaged to one pixel per cell), identifies the falling piece from its
shape near the top, picks a placement with a standard heuristic (height, holes, bumpiness, lines)
and sends rotate/move/hard-drop keys. Keys are sent only while the game window is in the foreground.

usage: python -I bot.py <game pid> <seconds> [x0 x1 ybottom cell]
"""
import ctypes
import subprocess
import sys
import time
from ctypes import wintypes

PID = int(sys.argv[1])
SECONDS = float(sys.argv[2])
X0, X1, YB = (int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])) if len(sys.argv) > 5 else (1057, 1502, 940)
CELL = (X1 - X0) / 10.0
W, H = 10, 21
# Filled cells are bright and saturated; the white ghost outline (about 45 % saturation) and the
# floor line's glow are not.
SAT_MIN_BRIGHT = int(sys.argv[6]) if len(sys.argv) > 6 else 70
SAT_MIN = float(sys.argv[7]) if len(sys.argv) > 7 else 0.6
Y0 = int(round(YB - H * CELL))

user32 = ctypes.WinDLL('user32', use_last_error=True)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class _U(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('mi', MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _U)]


SCAN = {'left': (0x4B, True), 'right': (0x4D, True), 'x': (0x2D, False), 'z': (0x2C, False), 'space': (0x39, False)}


def foreground_ok():
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(pid))
    return pid.value == PID


def send(key, up):
    scan, ext = SCAN[key]
    flags = 0x0008 | (0x0001 if ext else 0) | (0x0002 if up else 0)
    inp = INPUT(type=1)
    inp.u.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def tap(key, hold=0.035, gap=0.045):
    if not foreground_ok():
        raise SystemExit('stopped: the game is not in the foreground')
    send(key, False)
    time.sleep(hold)
    send(key, True)
    time.sleep(gap)


# SRS states, (x, y) with y down inside the piece box.
SHAPES = {
    'I': [[(0, 1), (1, 1), (2, 1), (3, 1)], [(2, 0), (2, 1), (2, 2), (2, 3)], [(0, 2), (1, 2), (2, 2), (3, 2)], [(1, 0), (1, 1), (1, 2), (1, 3)]],
    'O': [[(1, 0), (2, 0), (1, 1), (2, 1)]] * 4,
    'T': [[(1, 0), (0, 1), (1, 1), (2, 1)], [(1, 0), (1, 1), (2, 1), (1, 2)], [(0, 1), (1, 1), (2, 1), (1, 2)], [(1, 0), (0, 1), (1, 1), (1, 2)]],
    'S': [[(1, 0), (2, 0), (0, 1), (1, 1)], [(1, 0), (1, 1), (2, 1), (2, 2)], [(1, 1), (2, 1), (0, 2), (1, 2)], [(0, 0), (0, 1), (1, 1), (1, 2)]],
    'Z': [[(0, 0), (1, 0), (1, 1), (2, 1)], [(2, 0), (1, 1), (2, 1), (1, 2)], [(0, 1), (1, 1), (1, 2), (2, 2)], [(1, 0), (0, 1), (1, 1), (0, 2)]],
    'J': [[(0, 0), (0, 1), (1, 1), (2, 1)], [(1, 0), (2, 0), (1, 1), (1, 2)], [(0, 1), (1, 1), (2, 1), (2, 2)], [(1, 0), (1, 1), (0, 2), (1, 2)]],
    'L': [[(2, 0), (0, 1), (1, 1), (2, 1)], [(1, 0), (1, 1), (1, 2), (2, 2)], [(0, 1), (1, 1), (2, 1), (0, 2)], [(0, 0), (1, 0), (1, 1), (1, 2)]],
}


def norm(cells):
    mx = min(c[0] for c in cells)
    my = min(c[1] for c in cells)
    return sorted((x - mx, y - my) for x, y in cells)


SPAWN_NORM = {t: norm(s[0]) for t, s in SHAPES.items()}


def read_frames(end):
    """Frames until `end`; the capture restarts when Desktop Duplication drops (the game reloading)."""
    vf = f'crop={X1 - X0}:{YB - Y0}:{X0}:{Y0},scale={W}:{H}:flags=area,format=rgb24'
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'ddagrab=framerate=20:draw_mouse=0,hwdownload,format=bgra', '-vf', vf, '-f', 'rawvideo', '-']
    size = W * H * 3
    while time.time() < end:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            while True:
                buf = p.stdout.read(size)
                if len(buf) < size:
                    break
                yield buf
        finally:
            p.kill()
        time.sleep(0.5)


def grid(buf):
    """Filled cells: bright and coloured (the ghost outline is white and thin; the plate is dark)."""
    g = [[False] * W for _ in range(H)]  # g[row from top][col]
    for r in range(H):
        for c in range(W):
            i = (r * W + c) * 3
            R, G, B = buf[i], buf[i + 1], buf[i + 2]
            mx, mn = max(R, G, B), min(R, G, B)
            g[r][c] = mx > SAT_MIN_BRIGHT and (mx - mn) > SAT_MIN * mx
    return g


def drop(board, cells):
    """Lands `cells` (x, y-down box offsets already in board columns) straight down; returns rows."""
    ys = 0
    while True:
        ok = True
        for x, y in cells:
            yy = y + ys + 1
            if yy >= H or board[yy][x]:
                ok = False
                break
        if not ok:
            return ys
        ys += 1


def evaluate(board):
    heights = []
    holes = 0
    for c in range(W):
        h = 0
        seen = False
        for r in range(H):
            if board[r][c]:
                if not seen:
                    h = H - r
                    seen = True
            elif seen:
                holes += 1
        heights.append(h)
    agg = sum(heights)
    bump = sum(abs(heights[i] - heights[i + 1]) for i in range(W - 1))
    return agg, holes, bump, max(heights)


def best_move(board, piece):
    best = None
    for rot in range(4 if piece != 'O' else 1):
        shape = SHAPES[piece][rot]
        minx = min(x for x, _ in shape)
        maxx = max(x for x, _ in shape)
        for left in range(-minx, W - maxx):
            cells = [(left + x, y) for x, y in shape]
            if any(board[y][x] for x, y in cells):
                continue
            d = drop(board, cells)
            b = [row[:] for row in board]
            for x, y in cells:
                b[y + d][x] = True
            full = [r for r in range(H) if all(b[r])]
            lines = len(full)
            b = [[False] * W for _ in full] + [row for r, row in enumerate(b) if r not in full]
            agg, holes, bump, top = evaluate(b)
            score = -0.51 * agg + 0.76 * lines - 0.36 * holes * 2 - 0.18 * bump
            if best is None or score > best[0]:
                best = (score, rot, left)
    return best


def find_piece(g):
    """A group of exactly four connected filled cells in the top seven rows, in a spawn shape."""
    seen = set()
    for r in range(7):
        for c in range(W):
            if not g[r][c] or (c, r) in seen:
                continue
            comp = []
            todo = [(c, r)]
            seen.add((c, r))
            while todo:
                x, y = todo.pop()
                comp.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and g[ny][nx] and (nx, ny) not in seen:
                        seen.add((nx, ny))
                        todo.append((nx, ny))
            if len(comp) == 4:
                shape = norm(comp)
                piece = next((t for t, s in SPAWN_NORM.items() if s == shape), None)
                if piece:
                    return comp, piece
    return None, None


def main():
    end = time.time() + SECONDS
    last_drop = 0.0
    placed = 0
    for buf in read_frames(end):
        if time.time() > end:
            break
        if time.time() - last_drop < 0.18:
            continue
        g = grid(buf)
        # Light effects can wash whole rows near the top of the well: ignore rows there that are
        # nearly full (the stack never fills a row up there without clearing it).
        for r in range(7):
            if sum(g[r]) >= 7:
                g[r] = [False] * W
        # The falling piece: a group of exactly four connected cells near the top in a spawn shape.
        top, piece = find_piece(g)
        if piece is None:
            continue
        board = [row[:] for row in g]
        for c, r in top:
            board[r][c] = False
        mv = best_move(board, piece)
        if mv is None:
            continue
        _, rot, left = mv
        # Current box column from the observed spawn cells.
        cur_left = min(c for c, _ in top) - min(x for x, _ in SHAPES[piece][0])
        if rot == 1:
            tap('x')
        elif rot == 2:
            tap('x')
            tap('x')
        elif rot == 3:
            tap('z')
        shift = left - cur_left
        for _ in range(abs(shift)):
            tap('right' if shift > 0 else 'left')
        tap('space')
        last_drop = time.time()
        placed += 1
    print(f'placed {placed}')


main()
