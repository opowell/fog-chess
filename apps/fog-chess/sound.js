// Chess move sound — a short wooden "clack", played when a piece moves.
// Synthesised on the fly with Web Audio: no asset files, works offline. Loaded as
// a plain <script> in index.html, exposing window.playChessMoveSound.
// (Borrowed from battle-simulator's apps/design/chess-sound.js.)
(function () {
  let ctx = null;

  function playChessMoveSound() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = ctx || new AC();
      if (ctx.state === 'suspended') ctx.resume();

      const now = ctx.currentTime;

      // A hard, HIGH-passed noise transient right at the onset — sub-millisecond attack,
      // gone in ~5ms. This split-second broadband "tick" ahead of the main body is what
      // separates a true click from a soft tap; without it the sound reads as a padded
      // thud no matter how the body is filtered.
      const tickDur = 0.006;
      const tickBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * tickDur), ctx.sampleRate);
      const tickData = tickBuffer.getChannelData(0);
      for (let i = 0; i < tickData.length; i++) tickData[i] = Math.random() * 2 - 1;
      const tick = ctx.createBufferSource();
      tick.buffer = tickBuffer;
      const tickFilter = ctx.createBiquadFilter();
      tickFilter.type = 'highpass';
      tickFilter.frequency.value = 4200;
      const tickGain = ctx.createGain();
      tickGain.gain.setValueAtTime(0.55, now);
      tickGain.gain.exponentialRampToValueAtTime(0.0001, now + tickDur);
      tick.connect(tickFilter).connect(tickGain).connect(ctx.destination);
      tick.start(now);
      tick.stop(now + tickDur);

      // The main body: a short burst of bandpassed noise, pitched up near 3.3kHz and
      // over almost as fast as the tick — a longer tail is what turns "click" back into
      // "clack". Attack is near-instant (<1ms) so nothing softens the front edge.
      const dur = 0.03;
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3300;
      filter.Q.value = 1.3;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.5, now + 0.001);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      noise.connect(filter).connect(noiseGain).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + dur);

      // A brief high "ping" gives the click a clear pitch center rather than pure hiss —
      // pitched up near 2.2kHz and gone within 20ms, shorter than the previous pass so it
      // can't linger into a bell-like tone.
      const ping = ctx.createOscillator();
      ping.type = 'triangle';
      ping.frequency.setValueAtTime(2200, now);
      ping.frequency.exponentialRampToValueAtTime(1900, now + 0.015);
      const pingGain = ctx.createGain();
      pingGain.gain.setValueAtTime(0.0001, now);
      pingGain.gain.exponentialRampToValueAtTime(0.2, now + 0.001);
      pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
      ping.connect(pingGain).connect(ctx.destination);
      ping.start(now);
      ping.stop(now + 0.02);

      // Barely any low body left — just enough to keep it from sounding paper-thin,
      // gone in 15ms so it can't read as a thump.
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(280, now);
      thump.frequency.exponentialRampToValueAtTime(160, now + 0.012);
      const thumpGain = ctx.createGain();
      thumpGain.gain.setValueAtTime(0.0001, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.08, now + 0.001);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.015);
      thump.connect(thumpGain).connect(ctx.destination);
      thump.start(now);
      thump.stop(now + 0.016);
    } catch { /* audio is a nicety — never let it break the move flow */ }
  }

  window.playChessMoveSound = playChessMoveSound;
})();
