// Keep the negotiated audio transport alive without opening an input device.
// Zero-valued locally generated samples are not a user utterance. This graph is
// connected only to a MediaStream destination, never to the speaker destination.
export function createSilentAudio(AudioContextClass = globalThis.AudioContext) {
  if (!AudioContextClass)
    throw new Error(
      "This browser does not support the audio transport. Use the Crew desktop app or a current browser.",
    );
  let context: AudioContext | undefined,
    source: ConstantSourceNode | undefined,
    destination: MediaStreamAudioDestinationNode | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      source?.stop();
    } catch {
      /* The source may not have started. */
    }
    try {
      source?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    destination?.stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
  };
  try {
    context = new AudioContextClass({ sampleRate: 48000 });
    destination = context.createMediaStreamDestination();
    source = context.createConstantSource();
    source.offset.value = 0;
    source.connect(destination);
    source.start();
    const track = destination.stream.getAudioTracks()[0];
    if (!track)
      throw new Error("Could not prepare the silent audio transport.");
    const ready = context.resume().then(() => {
      if (!disposed && context!.state !== "running")
        throw new Error(
          "Audio playback is paused by the browser. Connect again to enable the call.",
        );
    });
    ready.catch(() => {}); // The hook awaits this; avoid an unhandled early rejection.
    return { track, stream: destination.stream, ready, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
