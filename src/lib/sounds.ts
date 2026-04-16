let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  } catch {
    // AudioContext construction can fail in edge cases (sandbox, OS audio
    // service unavailable). Swallow — the notification is a nice-to-have.
    return null;
  }
}

export function playNotificationSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      // Fire-and-forget — resume() is async but we don't block on it.
      // If the context is still suspended when we start the oscillators,
      // they'll queue and play once resumed.
      ctx.resume().catch(() => {});
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
  } catch {
    // Any failure in the Web Audio graph shouldn't bubble into the
    // caller (which is called from a Zustand state setter).
  }
}
