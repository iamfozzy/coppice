let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

export function playNotificationSound() {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume();
  }

  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  // Two-tone chime: A5 then E6
  const osc1 = ctx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.value = 880;
  osc1.connect(gain);
  osc1.start(now);
  osc1.stop(now + 0.12);

  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = 1320;
  osc2.connect(gain);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.3);
}
