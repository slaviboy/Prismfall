"""
Background-motion vs music analysis of reference clips (reference-capture/te-clips).

For every clip: per-frame (30 Hz) mean brightness and motion energy (mean absolute frame
difference) in background regions left and right of the well (the board and HUD columns are left
out), and 30 Hz audio envelopes (bass < 150 Hz, mid 400-2000 Hz, treble > 5 kHz, plus onset
strength). Reports correlations across lags, the share of variance at beat, bar and section
timescales, the dominant periods and the largest background events with the audio around them.

usage: python -I analyze.py <clip-name> [<clip-name> ...]   (names without -v0.mp4/.wav)
"""
import json
import math
import os
import re
import subprocess
import sys

DIR = 'F:/Projects/Web/TetrisEffect/reference-capture/te-clips'
FPS = 30
REGIONS = {'left': 'crop=880:1080:0:0', 'right': 'crop=760:1080:1800:0'}


def ffmpeg_series(src, vf, key, out, audio=False):
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src]
    args += (['-af', vf] if audio else ['-vf', vf]) + ['-f', 'null', '-']
    subprocess.run(args, check=True, cwd=DIR)
    vals = []
    pat = re.compile(re.escape(key) + r'=(-?[0-9.]+|-inf|inf|nan)')
    with open(os.path.join(DIR, out), encoding='utf-8') as f:
        for line in f:
            m = pat.search(line)
            if m:
                v = m.group(1)
                vals.append(float('-120' if 'inf' in v or v == 'nan' else v))
    os.remove(os.path.join(DIR, out))
    return vals


def video_series(mp4, region):
    tmp = f'_tmp_{os.getpid()}.txt'
    base =f'fps={FPS},{REGIONS[region]},scale=220:-2,format=gray'
    luma = ffmpeg_series(mp4, f"{base},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file='{tmp}'", 'lavfi.signalstats.YAVG', tmp)
    motion = ffmpeg_series(mp4, f"{base},tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file='{tmp}'", 'lavfi.signalstats.YAVG', tmp)
    return luma, motion


def audio_series(wav, band):
    tmp = f'_tmpa_{os.getpid()}.txt'
    filt = {'bass': 'lowpass=f=150,lowpass=f=150', 'mid': 'highpass=f=400,lowpass=f=2000', 'treble': 'highpass=f=5000,highpass=f=5000', 'full': 'anull'}[band]
    af = f"pan=mono|c0=0.5*c0+0.5*c1,{filt},asetnsamples=n={48000 // FPS}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:key=lavfi.astats.Overall.RMS_level:file='{tmp}'"
    return ffmpeg_series(wav, af, 'lavfi.astats.Overall.RMS_level', tmp, audio=True)


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
    if va <= 0 or vb <= 0:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


def lagged(a, b, lag):
    """Correlation of a(t) with b(t - lag): positive lag = a follows b."""
    if lag >= 0:
        return corr(a[lag:], b[:len(b) - lag] if lag else b)
    return corr(a[:lag], b[-lag:])


def smooth(x, frames):
    """Centred moving average over `frames` samples."""
    if frames <= 1:
        return x[:]
    out = []
    acc = 0.0
    q = []
    half = frames // 2
    pref = [0.0]
    for v in x:
        pref.append(pref[-1] + v)
    for i in range(len(x)):
        lo, hi = max(0, i - half), min(len(x), i + half + 1)
        out.append((pref[hi] - pref[lo]) / (hi - lo))
    return out


def band_split(x):
    """Variance shares: fast (< 0.5 s, beat scale), medium (0.5-4 s, bar scale), slow (> 4 s, sections)."""
    s05 = smooth(x, int(0.5 * FPS))
    s4 = smooth(x, int(4 * FPS))
    fast = [a - b for a, b in zip(x, s05)]
    medium = [a - b for a, b in zip(s05, s4)]
    m = mean(s4)
    slow = [v - m for v in s4]
    var = lambda v: sum(t * t for t in v) / max(1, len(v))
    tot = var(fast) + var(medium) + var(slow)
    return {k: round(var(v) / tot, 3) if tot > 0 else 0 for k, v in (('fast', fast), ('medium', medium), ('slow', slow))}, fast, medium, s4


def autocorr_peak(x, lo_s, hi_s):
    best = (0.0, 0.0)
    m = mean(x)
    y = [v - m for v in x]
    den = sum(v * v for v in y) or 1.0
    for lag in range(int(lo_s * FPS), int(hi_s * FPS) + 1):
        num = sum(y[i] * y[i + lag] for i in range(len(y) - lag))
        r = num / den
        if r > best[0]:
            best = (r, lag / FPS)
    return best


def onset(env_db):
    """Half-wave rectified rise of an envelope in dB (an onset-strength curve)."""
    return [0.0] + [max(0.0, env_db[i] - env_db[i - 1]) for i in range(1, len(env_db))]


def analyse(name):
    wav = os.path.join(DIR, f'{name}.wav')
    vids = sorted(f for f in os.listdir(DIR) if f.startswith(f'{name}-v') and f.endswith('.mp4'))
    log = open(os.path.join(DIR, f'{name}.txt'), encoding='utf-8').read()
    audio_start = re.search(r'started (\S+)Z?\s*$', log.strip().splitlines()[-1])
    report = {'clip': name, 'segments': []}
    audio = {b: audio_series(wav, b) for b in ('bass', 'mid', 'treble', 'full')}
    from datetime import datetime
    a0 = datetime.fromisoformat(audio_start.group(1).replace('Z', '').rstrip('Z')[:26])
    for k, vid in enumerate(vids):
        seg = re.search(rf'segment {k} started (\S+)', log)
        v0 = datetime.fromisoformat(seg.group(1).replace('Z', '')[:26])
        # Video starts later than the process launch (ddagrab start-up); estimated 0.35 s.
        offset = int(round(((v0 - a0).total_seconds() + 0.35) * FPS))
        entry = {'video': vid, 'offset_frames': offset}
        for region in REGIONS:
            luma, motion = video_series(os.path.join(DIR, vid), region)
            off = offset
            if off < 0:
                # The audio started after the video: drop the video frames before it.
                luma, motion, off = luma[-off:], motion[-off:], 0
            n = min(len(motion), len(audio['bass']) - off)
            if n < FPS * 10:
                continue
            luma, motion = luma[:n], motion[:n]
            a = {b: v[off:off + n] for b, v in audio.items()}
            on = {b: onset(v) for b, v in a.items()}
            lag_max = int(0.5 * FPS)
            best = {}
            for feat, series in (('luma', luma), ('motion', motion)):
                for b in ('bass', 'mid', 'treble', 'full'):
                    for kind, src in (('env', a[b]), ('onset', on[b])):
                        scores = [(lagged(series, src, L), L) for L in range(-lag_max, lag_max + 1)]
                        r, L = max(scores)
                        best[f'{feat}~{b}.{kind}'] = {'r': round(r, 3), 'lag_ms': round(L * 1000 / FPS)}
            shares_l, fast_l, med_l, slow_l = band_split(luma)
            shares_m, fast_m, med_m, slow_m = band_split(motion)
            # Correlation of the slow (section-scale) parts.
            slow_audio = smooth(a['full'], int(4 * FPS))
            fast_bass = band_split(on['bass'])[1]
            entry[region] = {
                'frames': n,
                'luma_mean': round(mean(luma), 2),
                'motion_mean': round(mean(motion), 3),
                'luma_shares': shares_l,
                'motion_shares': shares_m,
                'best': best,
                'slow_luma~slow_loudness': round(corr(slow_l, slow_audio), 3),
                'slow_motion~slow_loudness': round(corr(slow_m, slow_audio), 3),
                'fast_motion~fast_bass_onset': round(corr(fast_m, fast_bass), 3),
                'motion_period': autocorr_peak(motion, 0.25, 4.0),
                'bass_onset_period': autocorr_peak(on['bass'], 0.25, 4.0),
                'luma_period': autocorr_peak(luma, 0.25, 4.0),
            }
            # Largest background events: motion peaks, with what the audio did just before.
            mm = mean(motion)
            sd = math.sqrt(mean([(v - mm) ** 2 for v in motion])) or 1
            peaks = []
            for i in range(1, n - 1):
                if motion[i] > mm + 4 * sd and motion[i] >= motion[i - 1] and motion[i] >= motion[i + 1]:
                    if not peaks or i - peaks[-1][0] > FPS:
                        window = range(max(0, i - 6), i + 1)
                        peaks.append((i, round((motion[i] - mm) / sd, 1), round(max(on['full'][j] for j in window), 2), round(max(on['bass'][j] for j in window), 2)))
            entry[region]['events'] = [{'t': round(i / FPS, 2), 'z': z, 'onset_full_db': of, 'onset_bass_db': ob} for i, z, of, ob in peaks[:25]]
        report['segments'].append(entry)
    return report


if __name__ == '__main__':
    out = []
    for name in sys.argv[1:]:
        r = analyse(name)
        out.append(r)
        print(json.dumps(r, indent=1)[:4000])
    with open(os.path.join(DIR, 'analysis.json'), 'w', encoding='utf-8', newline='') as f:
        json.dump(out, f, indent=1)
