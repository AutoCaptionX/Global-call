/**
 * Web Audio API synthesizer for Global Call sound effects
 * Zero-dependency, lightweight, and works perfectly on mobile & desktop
 */

class SoundSynthesizer {
  private ctx: AudioContext | null = null;
  private dialInterval: any = null;
  private ringInterval: any = null;

  private init() {
    if (!this.ctx) {
      // @ts-ignore
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Play a beautiful ascending chime when call connects successfully
  playConnect() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const playTone = (freq: number, start: number, duration: number) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      
      osc.connect(gain);
      gain.connect(this.ctx!.destination);
      
      osc.start(start);
      osc.stop(start + duration);
    };

    playTone(523.25, now, 0.3); // C5
    playTone(659.25, now + 0.1, 0.3); // E5
    playTone(783.99, now + 0.2, 0.4); // G5
  }

  // Play a descending tone when call ends
  playDisconnect() {
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const playTone = (freq: number, start: number, duration: number) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      
      osc.connect(gain);
      gain.connect(this.ctx!.destination);
      
      osc.start(start);
      osc.stop(start + duration);
    };

    playTone(783.99, now, 0.2); // G5
    playTone(659.25, now + 0.1, 0.2); // E5
    playTone(523.25, now + 0.2, 0.3); // C5
  }

  // Play a dial sound (beep) when dialing
  startDialTone() {
    this.init();
    if (!this.ctx) return;
    this.stopDialTone();

    const triggerDialBeep = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      
      // Dial tone consists of 350Hz + 440Hz dual tone
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc1.frequency.setValueAtTime(350, now);
      osc2.frequency.setValueAtTime(440, now);
      
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.05, now + 0.05);
      gain.gain.setValueAtTime(0.05, now + 1.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
      
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.ctx.destination);
      
      osc1.start(now);
      osc2.start(now);
      
      osc1.stop(now + 1.3);
      osc2.stop(now + 1.3);
    };

    triggerDialBeep();
    this.dialInterval = setInterval(triggerDialBeep, 3000);
  }

  stopDialTone() {
    if (this.dialInterval) {
      clearInterval(this.dialInterval);
      this.dialInterval = null;
    }
  }

  // Play a beautiful chiming ringtone for incoming calls
  startRingtone() {
    this.init();
    if (!this.ctx) return;
    this.stopRingtone();

    const triggerRingSequence = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      
      const playChime = (freq: number, start: number) => {
        const osc = this.ctx!.createOscillator();
        const gain = this.ctx!.createGain();
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.08, start + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        
        osc.connect(gain);
        gain.connect(this.ctx!.destination);
        
        osc.start(start);
        osc.stop(start + 0.5);
      };

      // Play a simple elegant melody sequence: A4 - C5 - E5 - C5
      playChime(440.00, now); // A4
      playChime(523.25, now + 0.2); // C5
      playChime(659.25, now + 0.4); // E5
      playChime(523.25, now + 0.6); // C5
    };

    triggerRingSequence();
    this.ringInterval = setInterval(triggerRingSequence, 2000);
  }

  stopRingtone() {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
  }
}

export const sound = new SoundSynthesizer();
