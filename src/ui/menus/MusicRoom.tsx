import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { shell, type CatalogTrack } from '../../app/GameShell';
import { goBack, toast } from '../../app/stores';
import { updateSection, useSettings } from '../../settings/store';
import { Button, ChoiceRow, MenuList, useTicker } from '../components/controls';
import { useConfirmBackLabels } from '../hints';
import { ControlHints, MenuScreen } from './MenuScreen';

/** What's playing: title, tempo and section, with a lamp on the beat. */
function NowPlaying(props: { track: CatalogTrack | undefined }): ReactNode {
  const lamp = useRef<HTMLSpanElement>(null);
  const section = useTicker(() => {
    const f = shell.audio.features.features;
    return f.section ? `Section: ${f.section.replace(/-\d+$/, '')}` : '';
  }, 250);
  useEffect(() => {
    // Driven by the main loop's beat events (they only fire while music is really playing).
    return shell.onFrame(() => {
      const f = shell.audio.features.features;
      if (lamp.current) lamp.current.style.opacity = String(0.25 + f.beatPulse * 0.75);
    });
  }, []);
  if (!props.track) return null;
  return (
    <div className="world-details now-playing" data-testid="now-playing">
      <p className="now-playing-label">
        <span className="sound-cue-lamp" ref={lamp} aria-hidden /> Now playing
      </p>
      <h2 className="world-details-name">{props.track.title}</h2>
      <p className="world-details-desc">
        {props.track.subtitle}, {props.track.bpm} BPM
      </p>
      <p className="world-details-music">
        <span ref={section} />
      </p>
    </div>
  );
}

/** Music Room: listen to every unlocked world's music and the player's own files; pick free-play music. */
export function MusicRoom(): ReactNode {
  const [tracks, setTracks] = useState<CatalogTrack[]>([]);
  const [playing, setPlaying] = useState<string | null>(shell.currentTrackId);
  const [busy, setBusy] = useState<number | null>(null);
  const freePlay = useSettings((s) => s.setup.music);
  const fileRef = useRef<HTMLInputElement>(null);
  const { confirm, back } = useConfirmBackLabels();

  const refresh = useCallback(() => {
    void shell.catalog().then(setTracks);
  }, []);
  useEffect(() => {
    refresh();
    // Leaving the room returns to the world's music.
    return () => void shell.playTrack(null);
  }, [refresh]);

  const play = async (id: string): Promise<void> => {
    shell.unlockAudio();
    const next = playing === id ? null : id;
    if (await shell.playTrack(next)) setPlaying(next);
    else toast('That track could not be played.', 'warning');
  };

  const addFile = async (file: File): Promise<void> => {
    shell.unlockAudio();
    const ctx = shell.audio.engine.ctx;
    if (!ctx) {
      toast('Sound is off or blocked, so music can’t be analysed yet.', 'warning');
      return;
    }
    setBusy(0);
    try {
      const t = await shell.userMusic.add(file, ctx, (p) => setBusy(p));
      toast(`Added ${t.name}: about ${Math.round(t.analysis.bpm)} BPM`, 'success');
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That file could not be added.', 'warning', 6000);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: CatalogTrack): Promise<void> => {
    if (playing === t.id) {
      await shell.playTrack(null);
      setPlaying(null);
    }
    if (freePlay === t.id) updateSection('setup', { music: 'stage' });
    await shell.userMusic.remove(t.id.slice(5));
    toast(`Removed ${t.title}`);
    refresh();
  };

  const current = tracks.find((t) => t.id === playing);
  return (
    <MenuScreen
      title="Music Room"
      onBack={() => goBack()}
      testId="music-room"
      aside={<NowPlaying track={current} />}
      footer={
        <ControlHints
          hints={[
            { keys: confirm, label: 'Play or stop' },
            { keys: back, label: 'Back' },
          ]}
        />
      }
    >
      <ChoiceRow
        label="Music in free play"
        description="Marathon, Sprint, Ultra, Zen and Practice. Voyage always plays each world’s own music."
        value={tracks.some((t) => t.id === freePlay) || freePlay === 'stage' || freePlay === 'shuffle' ? freePlay : 'stage'}
        options={[{ value: 'stage', label: 'Each world’s own' }, { value: 'shuffle', label: 'Shuffle all' }, ...tracks.map((t) => ({ value: t.id, label: t.title }))]}
        onChange={(v) => updateSection('setup', { music: v })}
        testId="music-freeplay"
      />
      <MenuList className="track-list">
        {tracks.map((t) => (
          <div key={t.id} className={`track-row${playing === t.id ? ' is-playing' : ''}`}>
            <button
              type="button"
              className="track-item"
              data-focusable
              data-testid={`track-${t.id}`}
              onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
              onClick={() => void play(t.id)}
            >
              <span className="track-title">{t.title}</span>
              <span className="track-meta">
                {t.subtitle}, {t.bpm} BPM{playing === t.id ? ', playing' : ''}
              </span>
            </button>
            {t.source === 'user' ? (
              <Button onClick={() => void remove(t)} testId={`remove-${t.id}`} title={`Remove ${t.title}`}>
                Remove
              </Button>
            ) : null}
          </div>
        ))}
      </MenuList>
      <div className="settings-actions">
        {shell.userMusic.supported ? (
          <Button onClick={() => fileRef.current?.click()} disabled={busy !== null} testId="music-add">
            {busy === null ? 'Add your own music' : `Analysing ${Math.round(busy * 100)}%`}
          </Button>
        ) : (
          <p className="menu-note">Your own music needs browser storage (IndexedDB), which is unavailable here.</p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          data-testid="music-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void addFile(f);
          }}
        />
      </div>
      <p className="menu-note">Files stay on this computer. Each is analysed once for its tempo, beat and sections so the worlds can move with it.</p>
    </MenuScreen>
  );
}
