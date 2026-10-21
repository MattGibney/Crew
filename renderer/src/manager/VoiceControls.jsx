import { Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function VoiceControls({ manager }) {
  const { voice, catalog, selectedVoice, voiceLoading, voiceNotice, prepared, eventReady, account, error } = manager;
  const voiceLocked = voice.allocated || voice.busy;
  const hint = voiceLocked ? 'Disconnect to change voice. Your choice applies when you connect again.' : voiceNotice || (catalog ? 'Saved on this browser for your next call. Connect to hear the selected voice.' : 'Voices are unavailable. Retry loading before connecting.');
  return <section aria-label="Voice controls"><Card>
    <CardHeader><CardTitle>Voice</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p id="account" className="text-sm text-muted-foreground">{account}</p>
      <p id="status" role="status" aria-live="polite" className="font-medium">{voice.status}</p>
      {error && <Alert variant="destructive" id="error" role="alert"><AlertDescription className="whitespace-pre-wrap break-words">{error}</AlertDescription></Alert>}
      <div className="space-y-2">
        <Label htmlFor="voice">Voice</Label>
        <NativeSelect id="voice" className="w-full" aria-describedby="voice-hint" disabled={!catalog || voiceLocked || voiceLoading} value={selectedVoice} onChange={event => manager.changeVoice(event.target.value)}>
          {!catalog ? <option value="">{voiceLoading ? 'Loading voices…' : 'Voices unavailable'}</option> : catalog.voices.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === catalog.defaultVoice ? ' (Codex default)' : ''}</option>)}
        </NativeSelect>
        <p id="voice-hint" className="text-sm text-muted-foreground" role="status">{hint}</p>
        {!catalog && !voiceLoading && <Button id="retry-voices" type="button" variant="outline" onClick={() => void manager.loadVoices()}>Retry loading voices</Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button id="connect" type="button" onClick={manager.connect} disabled={!prepared || !eventReady || !catalog || voiceLocked}><Phone aria-hidden="true" />Connect voice</Button>
        <Button id="mute" type="button" variant="outline" disabled={!voice.active} onClick={voice.toggleMute}>{voice.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}{voice.muted ? 'Unmute microphone' : 'Mute microphone'}</Button>
        <Button id="disconnect" type="button" variant="outline" disabled={!voice.allocated && !voice.busy} onClick={() => void voice.disconnect()}><PhoneOff aria-hidden="true" />Disconnect</Button>
      </div>
      <audio id="audio" ref={voice.audioRef} autoPlay controls className="w-full" aria-label="Assistant audio" />
      <p className="text-sm text-muted-foreground">Finish any other voice call before connecting. Disconnect ends voice and releases the microphone. Codex and its isolated workers can keep working; Stop manager work cancels only the current manager turn.</p>
      <p className="text-sm text-muted-foreground">The audio player controls local playback only. It does not ask the model to wait before speaking.</p>
    </CardContent>
  </Card></section>;
}
