"""
How a world's background moves with its music, measured from a recording with sound (the method of
BACKGROUND_VISUAL_REFERENCE.md §2, so Prismfall's worlds can be compared with the reference).

For background regions left and right of the board (the board and HUD columns are left out) it
takes, at 30 Hz, the mean brightness and the motion energy (mean absolute frame difference), and
audio envelopes of the bass (< 150 Hz), mids (400-2000 Hz), treble (> 5 kHz) and the full mix. It
reports:
  slow  - correlation of 4 s-smoothed brightness and motion with 4 s-smoothed loudness
          (does the world follow the music's large shape?)
  beat  - correlation of the < 0.5 s part of the motion with bass onsets (does it pulse on hits?)
  shares - variance of brightness at < 0.5 s, 0.5-4 s and > 4 s
  best  - the audio envelope the background follows best, and the lag

Uses only the standard library and ffmpeg.

usage: python -I scripts/music_coupling.py <clip.mp4> [more clips] [--regions 0:0.32,0.68:1] [--json out.json]
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile

FPS = 30


def series(cmd_tail, src, key, audio=False):
    with tempfile.TemporaryDirectory() as tmp:
        out = 'm.txt'
        filt = cmd_tail.replace('FILE', out)
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', os.path.abspath(src)] + (['-vn', '-af', filt] if audio else ['-an', '-vf', filt]) + ['-f', 'null', '-']
        subprocess.run(args, check=True, cwd=tmp)
        vals = []
        pat = re.compile(re.escape(key) + r'=(-?[0-9.]+|-inf|inf|nan)')
        with open(os.path.join(tmp, out), encoding='utf-8') as f:
            for line in f:
                m = pat.search(line)
                if m:
                    v = m.group(1)
                    vals.append(-120.0 if ('inf' in v or v == 'nan') else float(v))
        return vals


def video(src, x0, x1):
    crop = f"crop=iw*{x1 - x0}:ih:iw*{x0}:0"
    base = f'fps={FPS},{crop},scale=220:-2,format=gray'
    luma = series(f'{base},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=FILE', src, 'lavfi.signalstats.YAVG')
    motion = series(f'{base},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=FILE', src, 'lavfi.signalstats.YAVG')
    return luma, motion


def audio(src, band):
    filt = {'bass': 'lowpass=f=150,lowpass=f=150', 'mid': 'highpass=f=400,lowpass=f=2000', 'treble': 'highpass=f=5000,highpass=f=5000', 'full': 'anull'}[band]
    af = f'aresample=48000,pan=mono|c0=0.5*c0+0.5*c1,{filt},asetnsamples=n={48000 // FPS}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=FILE'
    return series(af, src, 'lavfi.astats.Overall.RMS_level', audio=True)


def mean(x):
    return sum(x) / max(1, len(x))


def corr(a, b):
    n = min(len(a), len(b))
    if n < 10:
        return 0.0
    a, b = a[:n], b[:n]
    ma, mb = mean(a), mean(b)
    va = sum((v - ma) ** 2 for v in a)
    vb = sum((v - mb) ** 2 for v in b)
    return 0.0 if va <= 0 or vb <= 0 else sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def lagged(a, b, lag):
    if lag >= 0:
        return corr(a[lag:], b[:len(b) - lag] if lag else b)
    return corr(a[:lag], b[-lag:])


def smooth(x, frames):
    if frames <= 1:
        return x[:]
    half = frames // 2
    pref = [0.0]
    for v in x:
        pref.append(pref[-1] + v)
    return [(pref[min(len(x), i + half + 1)] - pref[max(0, i - half)]) / (min(len(x), i + half + 1) - max(0, i - half)) for i in range(len(x))]


def shares(x):
    s05 = smooth(x, int(0.5 * FPS))
    s4 = smooth(x, int(4 * FPS))
    fast = [a - b for a, b in zip(x, s05)]
    med = [a - b for a, b in zip(s05, s4)]
    m = mean(s4)
    slow = [v - m for v in s4]
    var = lambda v: sum(t * t for t in v) / max(1, len(v))
    tot = var(fast) + var(med) + var(slow) or 1
    return {'fast': round(var(fast) / tot, 3), 'medium': round(var(med) / tot, 3), 'slow': round(var(slow) / tot, 3)}, fast, s4


def onset(env):
    return [0.0] + [max(0.0, env[i] - env[i - 1]) for i in range(1, len(env))]


def analyse(src, regions):
    a = {b: audio(src, b) for b in ('bass', 'mid', 'treble', 'full')}
    out = {'clip': src, 'regions': {}}
    for (x0, x1) in regions:
        luma, motion = video(src, x0, x1)
        n = min(len(luma), len(a['full']))
        luma, motion = luma[:n], motion[:n]
        aa = {k: v[:n] for k, v in a.items()}
        sl, _, slow_l = shares(luma)
        sm, fast_m, slow_m = shares(motion)
        slow_loud = smooth(aa['full'], 4 * FPS)
        fast_bass = shares(onset(aa['bass']))[1]
        best = []
        for feat, s in (('brightness', luma), ('motion', motion)):
            for band in ('bass', 'mid', 'treble'):
                r, lag = max((lagged(s, aa[band], L), L) for L in range(-15, 16))
                best.append((round(r, 3), feat, band, round(lag * 1000 / FPS)))
        best.sort(reverse=True)
        out['regions'][f'{x0}-{x1}'] = {
            'frames': n,
            'slow_brightness': round(corr(slow_l, slow_loud), 3),
            'slow_motion': round(corr(slow_m, slow_loud), 3),
            'beat_motion': round(corr(fast_m, fast_bass), 3),
            'brightness_shares': sl,
            'motion_shares': sm,
            'best': {'r': best[0][0], 'feature': best[0][1], 'band': best[0][2], 'lag_ms': best[0][3]},
        }
    return out


def main():
    args = sys.argv[1:]
    regions = [(0.0, 0.32), (0.68, 1.0)]
    out_json = None
    clips = []
    i = 0
    while i < len(args):
        if args[i] == '--regions':
            regions = [tuple(float(v) for v in r.split(':')) for r in args[i + 1].split(',')]
            i += 2
        elif args[i] == '--json':
            out_json = args[i + 1]
            i += 2
        else:
            clips.append(args[i])
            i += 1
    results = []
    for c in clips:
        r = analyse(c, regions)
        results.append(r)
        for name, e in r['regions'].items():
            print(f"{os.path.basename(c)} [{name}] slow r {e['slow_brightness']:+.2f}/{e['slow_motion']:+.2f}  beat r {e['beat_motion']:+.2f}  fast share {e['brightness_shares']['fast']:.2f}  best {e['best']['feature']}~{e['best']['band']} r {e['best']['r']:.2f} lag {e['best']['lag_ms']} ms")
    if out_json:
        with open(out_json, 'w', encoding='utf-8', newline='') as f:
            json.dump(results, f, indent=1)


if __name__ == '__main__':
    main()
