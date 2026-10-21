import { useEffect, useRef } from 'react';
import { AudioLines, ChevronDown, Keyboard, LoaderCircle, Mic, MicOff, Phone, PhoneOff, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { isTalkShortcut } from './voice-input.js';

export function VoiceControls({ manager, visible = true }) {
  const { voice, catalog, selectedVoice, voiceLoading, voiceNotice, prepared, eventReady } = manager;
  const voiceLocked = voice.allocated || voice.busy;
  const heldKey = useRef(null);
  const holdMode = voice.mode === 'push-to-talk';
  useEffect(() => {
    if (!voice.active || !holdMode || !visible) return;
    const keydown = event => {
      if (!isTalkShortcut(event) || heldKey.current) return;
      event.preventDefault(); heldKey.current = event.code; voice.startInput();
    };
    const keyup = event => {
      if (event.code !== heldKey.current) return;
      event.preventDefault(); heldKey.current = null; voice.stopInput();
    };
    const release = () => { heldKey.current = null; voice.stopInput(); };
    window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup);
    window.addEventListener('blur', release); window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', release); window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', release); release();
    };
  }, [voice.active, holdMode, visible, voice.startInput, voice.stopInput]);
  const phase = voice.inputPending ? 'Waiting for microphone permission' : voice.transmitting ? 'Listening' : voice.activity === 'speaking' && voice.active ? 'Speaking' : voice.activity === 'processing' && voice.active ? 'Processing' : voice.disconnecting ? 'Ending call' : voice.busy ? 'Connecting' : voice.active ? 'Connected · microphone off' : 'Microphone off';
  const Icon = voice.busy || voice.inputPending ? LoaderCircle : voice.transmitting ? Mic : voice.activity === 'speaking' && voice.active ? AudioLines : MicOff;
  return <section aria-label="Voice controls" className="rounded-xl border bg-card text-card-foreground">
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${voice.transmitting ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon className={`size-4 ${voice.busy || voice.inputPending ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" /></span>
          <div className="min-w-0"><p className="text-sm font-medium">Talk with your manager</p><p id="status" role="status" aria-live="polite" className="text-xs text-muted-foreground">{phase}</p></div>
        </div>
        {voiceLocked ? <Button id="disconnect" type="button" variant="ghost" className="text-muted-foreground" disabled={voice.disconnecting} onClick={() => void voice.disconnect()}><PhoneOff aria-hidden="true" />{voice.disconnecting ? 'Ending call…' : voice.busy ? 'Cancel' : 'End call'}</Button> : <Button id="connect" type="button" onClick={manager.connect} disabled={!manager.managerEnabled || !prepared || !eventReady || !catalog}><Phone aria-hidden="true" />Connect voice</Button>}
      </div>
      {voice.active && <div className="flex flex-wrap items-center gap-3">
        {holdMode ? <Button id="push-to-talk" data-push-to-talk="true" type="button" size="lg" variant={voice.transmitting ? 'default' : 'outline'} aria-pressed={voice.transmitting} aria-describedby="talk-hint" className="h-11 min-w-40 touch-none"
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); voice.startInput(); }}
          onPointerUp={event => { voice.stopInput(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={voice.stopInput} onLostPointerCapture={voice.stopInput} onContextMenu={event => event.preventDefault()}
          onKeyDown={event => { if (event.code === 'Enter' && !event.repeat && !event.isComposing) { event.preventDefault(); heldKey.current = 'Enter'; voice.startInput(); } }}
          onBlur={() => { heldKey.current = null; voice.stopInput(); }}>
          <Mic aria-hidden="true" />{voice.transmitting ? 'Listening… release to stop' : voice.inputPending ? 'Allow microphone…' : 'Hold to talk'}
        </Button> : <Button id="mute" type="button" size="lg" variant={voice.transmitting || voice.inputPending ? 'secondary' : 'default'} className="h-11" onClick={voice.toggleMute}>
          {voice.transmitting || voice.inputPending ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{voice.transmitting ? 'Mute microphone' : voice.inputPending ? 'Cancel microphone' : voice.inputError ? 'Retry microphone' : 'Unmute microphone'}
        </Button>}
        <p id="talk-hint" className="flex items-center gap-1.5 text-xs text-muted-foreground">{holdMode ? <><Keyboard className="size-3.5" aria-hidden="true" />Or hold Space outside text fields</> : 'Stays on when you switch apps. Mute or end the call to stop.'}</p>
      </div>}
      {!voice.active && <p className="text-xs leading-relaxed text-muted-foreground">{voice.busy ? voice.status : holdMode ? 'Connect, then hold to talk when you want to speak.' : voice.openMicMuted ? 'Your microphone is muted. Connect keeps it muted until you unmute.' : 'Connect starts the call and microphone. You can mute or end the call at any time.'}</p>}
      {voice.inputError && <Alert variant="destructive" role="alert"><AlertDescription>{voice.inputError}</AlertDescription></Alert>}
      <details className="group border-t pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><Settings2 className="size-3.5" aria-hidden="true" /><span>{holdMode ? 'Push to talk' : 'Open microphone'} · {catalog?.voices.find(item => item.id === selectedVoice)?.name || 'Voice settings'}</span><ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="voice-mode">Microphone mode</Label><NativeSelect id="voice-mode" className="w-full" value={voice.mode} disabled={voiceLocked} onChange={event => voice.changeMode(event.target.value)}><option value="open-mic">Open microphone</option><option value="push-to-talk">Push to talk</option></NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="voice">Voice</Label><NativeSelect id="voice" className="w-full" aria-describedby="voice-hint" disabled={!catalog || voiceLocked || voiceLoading} value={selectedVoice} onChange={event => manager.changeVoice(event.target.value)}>{!catalog ? <option value="">{voiceLoading ? 'Loading voices…' : 'Voices unavailable'}</option> : catalog.voices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</NativeSelect></div>
          <p id="voice-hint" className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{voiceLocked ? 'End the call to change mode or voice.' : voiceNotice || 'Your voice choice is saved for the next call. Changing these settings never starts the microphone.'}</p>
          {!catalog && !voiceLoading && <Button id="retry-voices" type="button" variant="outline" onClick={() => void manager.loadVoices()}>Retry loading voices</Button>}
        </div>
        <div className="mt-4 space-y-2"><Button type="button" size="sm" variant="outline" onClick={() => void voice.audioRef.current?.play()}>Play manager audio</Button><p className="text-xs leading-relaxed text-muted-foreground">Playback controls affect what you hear. End call releases voice; your manager and workers can keep working.</p></div>
      </details>
    </div>
  </section>;
}
