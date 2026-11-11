/**
 * Trove Media Vault - Equalizer & Audio DSP Stage
 * Hardware-accelerated 8-Band Web Audio API Biquad Filters, 3D Spatializer, and Acoustic Room Simulation.
 */
(function() {
  window.Trove = window.Trove || {};

  const { MotionAnim } = window.Trove.utils || {};

  const Equalizer = {
    ctx: null,
    sourceAudio: null,
    sourceVideo: null,
    filters: [],
    // Virtualizer & Room Nodes
    splitter: null,
    merger: null,
    leftGainDirect: null,
    leftGainCross: null,
    rightGainDirect: null,
    rightGainCross: null,
    // 3D Binaural Wrap & Haas Depth Nodes
    spatialHighPass: null,
    spatialAirShelf: null,
    spatialDecorrSplitter: null,
    spatialAllpassL1: null,
    spatialAllpassL2: null,
    spatialDelayRightITD: null,
    spatialAllpassR1: null,
    spatialAllpassR2: null,
    spatialWrapLeftGain: null,
    spatialWrapRightGain: null,
    spatialDelayLeftCross: null,
    spatialDelayRightCross: null,
    spatialCrossLeftGain: null,
    spatialCrossRightGain: null,
    convolver: null,
    _convolverConnected: false,
    reverbDryGain: null,
    reverbWetGain: null,
    compressor: null,
    studioBuffer: null,
    hallBuffer: null,

    enabled: true,
    volumeNormalization: localStorage.getItem('trove_vol_normalization') !== 'false',
    currentPreset: 'flat',
    spatialWidth: 0, // 0% to 100%
    roomMode: 'off', // 'off' | 'studio' | 'hall'
    gains: [0, 0, 0, 0, 0, 0, 0, 0],
    customGains: [0, 0, 0, 0, 0, 0, 0, 0],

    frequencies: [
      { freq: 32, type: 'lowshelf', label: '32', desc: 'Sub' },
      { freq: 64, type: 'peaking', label: '64', desc: 'Bass' },
      { freq: 125, type: 'peaking', label: '125', desc: 'Low' },
      { freq: 250, type: 'peaking', label: '250', desc: 'Warm' },
      { freq: 500, type: 'peaking', label: '500', desc: 'Mid' },
      { freq: 1000, type: 'peaking', label: '1k', desc: 'Voice' },
      { freq: 4000, type: 'peaking', label: '4k', desc: 'Clear' },
      { freq: 16000, type: 'highshelf', label: '16k', desc: 'Air' }
    ],

    presets: {
      flat: [0, 0, 0, 0, 0, 0, 0, 0],
      bass: [6, 5.5, 4, 1.5, 0, 0, 0, -1],
      vocal: [-3, -2, 0, 1.5, 3.5, 4, 2, 0],
      rock: [4.5, 3.5, 2, -0.5, -1, 1, 3, 4.5],
      electronic: [5.5, 5, 3, 0, 0.5, 2, 3.5, 5],
      acoustic: [2, 2, 1, 0, 1, 2, 3, 3.5],
      treble: [-2, -1, 0, 0, 1, 2, 4.5, 6.5]
    },

    get isOpen() {
      const sheet = document.getElementById('eq-bottom-sheet');
      return sheet && sheet.style.display === 'flex';
    },

    // Synthetic room impulse generator
    createImpulse(duration = 1.2, decay = 2.0) {
      if (!this.ctx) return null;
      const rate = this.ctx.sampleRate;
      const length = Math.floor(rate * duration);
      const buffer = this.ctx.createBuffer(2, length, rate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        left[i] = (Math.random() * 2 - 1) * env;
        right[i] = (Math.random() * 2 - 1) * env;
      }
      return buffer;
    },

    initAudioContext() {
      if (this.ctx) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        try {
          // Optimize audio render buffer for glitch-free background playback
          this.ctx = new AudioCtx({ latencyHint: 'playback' });
        } catch (_) {
          this.ctx = new AudioCtx();
        }

        // Recover smoothly if OS interrupts or suspends the audio context while playing
        this.ctx.onstatechange = () => {
          const player = window.Trove?.player;
          const activeEl = player?.getActiveElement?.();
          if (this.ctx && (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted')) {
            if (player?.isPlaying || (activeEl && !activeEl.paused)) {
              this.ctx.resume().catch(() => {});
            }
          }
        };

        // 1. Build 8-band filter chain
        this.filters = this.frequencies.map((f, idx) => {
          const filter = this.ctx.createBiquadFilter();
          filter.type = f.type;
          filter.frequency.value = f.freq;
          filter.gain.value = this.enabled ? (this.gains[idx] || 0) : 0;
          if (f.type === 'peaking') {
            filter.Q.value = 1.4;
          }
          return filter;
        });

        for (let i = 0; i < this.filters.length - 1; i++) {
          this.filters[i].connect(this.filters[i + 1]);
        }
        const lastFilter = this.filters[this.filters.length - 1];

        // 2. 3D Holographic Spatializer Stage (Mid-Side Widener + Binaural Haas/Allpass Wrap)
        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);
        this.leftGainDirect = this.ctx.createGain();
        this.leftGainCross = this.ctx.createGain();
        this.rightGainDirect = this.ctx.createGain();
        this.rightGainCross = this.ctx.createGain();

        lastFilter.connect(this.splitter);

        this.splitter.connect(this.leftGainDirect, 0);
        this.leftGainDirect.connect(this.merger, 0, 0);

        this.splitter.connect(this.leftGainCross, 1);
        this.leftGainCross.connect(this.merger, 0, 0);

        this.splitter.connect(this.rightGainDirect, 1);
        this.rightGainDirect.connect(this.merger, 0, 1);

        this.splitter.connect(this.rightGainCross, 0);
        this.rightGainCross.connect(this.merger, 0, 1);

        // 2B. Binaural 3D Phase/Haas Depth Stage (High-passed > 220Hz to keep bass laser-tight & punchy)
        this.spatialHighPass = this.ctx.createBiquadFilter();
        this.spatialHighPass.type = 'highpass';
        this.spatialHighPass.frequency.value = 220;
        this.spatialHighPass.Q.value = 0.7;

        this.spatialAirShelf = this.ctx.createBiquadFilter();
        this.spatialAirShelf.type = 'highshelf';
        this.spatialAirShelf.frequency.value = 5500;
        this.spatialAirShelf.gain.value = 0;

        this.spatialDecorrSplitter = this.ctx.createChannelSplitter(2);

        this.spatialAllpassL1 = this.ctx.createBiquadFilter();
        this.spatialAllpassL1.type = 'allpass';
        this.spatialAllpassL1.frequency.value = 380;
        this.spatialAllpassL1.Q.value = 0.8;

        this.spatialAllpassL2 = this.ctx.createBiquadFilter();
        this.spatialAllpassL2.type = 'allpass';
        this.spatialAllpassL2.frequency.value = 1650;
        this.spatialAllpassL2.Q.value = 0.8;

        this.spatialDelayRightITD = this.ctx.createDelay(0.05);
        this.spatialDelayRightITD.delayTime.value = 0.00065; // ~0.65ms Binaural ITD cue

        this.spatialAllpassR1 = this.ctx.createBiquadFilter();
        this.spatialAllpassR1.type = 'allpass';
        this.spatialAllpassR1.frequency.value = 820;
        this.spatialAllpassR1.Q.value = 0.8;

        this.spatialAllpassR2 = this.ctx.createBiquadFilter();
        this.spatialAllpassR2.type = 'allpass';
        this.spatialAllpassR2.frequency.value = 3200;
        this.spatialAllpassR2.Q.value = 0.8;

        this.spatialWrapLeftGain = this.ctx.createGain();
        this.spatialWrapRightGain = this.ctx.createGain();

        this.spatialDelayLeftCross = this.ctx.createDelay(0.05);
        this.spatialDelayLeftCross.delayTime.value = 0.011; // 11ms early ear reflection
        this.spatialDelayRightCross = this.ctx.createDelay(0.05);
        this.spatialDelayRightCross.delayTime.value = 0.017; // 17ms asymmetric reflection
        this.spatialCrossLeftGain = this.ctx.createGain();
        this.spatialCrossRightGain = this.ctx.createGain();

        lastFilter.connect(this.spatialHighPass);
        this.spatialHighPass.connect(this.spatialAirShelf);
        this.spatialAirShelf.connect(this.spatialDecorrSplitter);

        // Left Binaural Path -> Left direct + 11ms cross to Right
        this.spatialDecorrSplitter.connect(this.spatialAllpassL1, 0);
        this.spatialAllpassL1.connect(this.spatialAllpassL2);
        this.spatialAllpassL2.connect(this.spatialWrapLeftGain);
        this.spatialWrapLeftGain.connect(this.merger, 0, 0);

        this.spatialAllpassL2.connect(this.spatialDelayLeftCross);
        this.spatialDelayLeftCross.connect(this.spatialCrossLeftGain);
        this.spatialCrossLeftGain.connect(this.merger, 0, 1);

        // Right Binaural Path -> Right direct + 17ms cross to Left
        this.spatialDecorrSplitter.connect(this.spatialDelayRightITD, 1);
        this.spatialDelayRightITD.connect(this.spatialAllpassR1);
        this.spatialAllpassR1.connect(this.spatialAllpassR2);
        this.spatialAllpassR2.connect(this.spatialWrapRightGain);
        this.spatialWrapRightGain.connect(this.merger, 0, 1);

        this.spatialAllpassR2.connect(this.spatialDelayRightCross);
        this.spatialDelayRightCross.connect(this.spatialCrossRightGain);
        this.spatialCrossRightGain.connect(this.merger, 0, 0);

        this.applySpatialWidth();

        // 3. Acoustic Environment (Reverb Convolver Node - dynamically bypassed when Off)
        this.convolver = this.ctx.createConvolver();
        this.reverbDryGain = this.ctx.createGain();
        this.reverbWetGain = this.ctx.createGain();

        this.merger.connect(this.reverbDryGain);
        this._convolverConnected = false;

        // 4. Output Stage: DynamicsCompressor (protective limiter & volume normalizer) -> Destination
        this.compressor = this.ctx.createDynamicsCompressor();
        this.applyNormalization();

        this.reverbDryGain.connect(this.compressor);
        this.reverbWetGain.connect(this.compressor);
        this.compressor.connect(this.ctx.destination);

        this.applyRoomMode();

        // Connect audio/video elements if already in DOM
        const playerAudio = document.getElementById('player-audio');
        const playerVideo = document.getElementById('player-video');
        if (playerAudio) this.connectMediaElement(playerAudio, 'audio');
        if (playerVideo) this.connectMediaElement(playerVideo, 'video');

      } catch (err) {
        console.warn('Web Audio API not supported or initialization error:', err);
      }
    },

    connectMediaElement(el, type = 'audio') {
      if (!this.ctx || !this.filters.length || !el) return;
      try {
        if (type === 'audio' && !this.sourceAudio) {
          this.sourceAudio = this.ctx.createMediaElementSource(el);
          this.sourceAudio.connect(this.filters[0]);
        } else if (type === 'video' && !this.sourceVideo) {
          this.sourceVideo = this.ctx.createMediaElementSource(el);
          this.sourceVideo.connect(this.filters[0]);
        }
      } catch (err) {
        // Element might already be connected
      }
    },

    async resume() {
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
        try {
          await this.ctx.resume();
        } catch (_) {}
      }
    },

    applyGains() {
      if (!this.filters || !this.filters.length || !this.ctx) return;
      this.filters.forEach((filter, idx) => {
        const target = this.enabled ? (this.gains[idx] || 0) : 0;
        filter.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
      });
    },

    applySpatialWidth() {
      if (!this.leftGainDirect || !this.ctx) return;
      const pct = this.enabled ? (this.spatialWidth / 100) : 0;
      const intensity = pct > 0 ? Math.pow(pct, 0.85) : 0;

      // Aggressive M/S widening (Side up to 4.4x) while anchoring center Mid
      const midScale = 1.0 - 0.16 * intensity;
      const sideScale = 1.0 + 3.4 * intensity;
      const direct = (midScale + sideScale) / 2;
      const cross = (midScale - sideScale) / 2;

      const t = this.ctx.currentTime;
      this.leftGainDirect.gain.setTargetAtTime(direct, t, 0.02);
      this.leftGainCross.gain.setTargetAtTime(cross, t, 0.02);
      this.rightGainDirect.gain.setTargetAtTime(direct, t, 0.02);
      this.rightGainCross.gain.setTargetAtTime(cross, t, 0.02);

      // 3D Binaural Wrap & Out-of-Head HRTF Air Stage
      const wrapGain = intensity * 0.44;
      const crossWrapGain = -intensity * 0.16;
      const airGainDb = intensity * 3.5;

      if (this.spatialWrapLeftGain) this.spatialWrapLeftGain.gain.setTargetAtTime(wrapGain, t, 0.02);
      if (this.spatialWrapRightGain) this.spatialWrapRightGain.gain.setTargetAtTime(wrapGain, t, 0.02);
      if (this.spatialCrossLeftGain) this.spatialCrossLeftGain.gain.setTargetAtTime(crossWrapGain, t, 0.02);
      if (this.spatialCrossRightGain) this.spatialCrossRightGain.gain.setTargetAtTime(crossWrapGain, t, 0.02);
      if (this.spatialAirShelf) this.spatialAirShelf.gain.setTargetAtTime(airGainDb, t, 0.02);
    },

    applyRoomMode() {
      if (!this.convolver || !this.ctx) return;
      if (!this.enabled || this.roomMode === 'off') {
        this.reverbDryGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
        this.reverbWetGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.02);
        if (this._convolverConnected) {
          try {
            this.merger.disconnect(this.convolver);
            this.convolver.disconnect(this.reverbWetGain);
          } catch (_) {}
          this._convolverConnected = false;
        }
        return;
      }

      if (!this._convolverConnected) {
        try {
          this.merger.connect(this.convolver);
          this.convolver.connect(this.reverbWetGain);
          this._convolverConnected = true;
        } catch (_) {}
      }

      if (this.roomMode === 'studio') {
        if (!this.studioBuffer) this.studioBuffer = this.createImpulse(0.55, 3.2);
        this.convolver.buffer = this.studioBuffer;
        this.reverbDryGain.gain.setTargetAtTime(0.88, this.ctx.currentTime, 0.02);
        this.reverbWetGain.gain.setTargetAtTime(0.24, this.ctx.currentTime, 0.02);
      } else if (this.roomMode === 'hall') {
        if (!this.hallBuffer) this.hallBuffer = this.createImpulse(2.0, 2.0);
        this.convolver.buffer = this.hallBuffer;
        this.reverbDryGain.gain.setTargetAtTime(0.76, this.ctx.currentTime, 0.02);
        this.reverbWetGain.gain.setTargetAtTime(0.38, this.ctx.currentTime, 0.02);
      }
    },

    applyNormalization() {
      if (!this.compressor || !this.ctx) return;
      const t = this.ctx.currentTime;
      if (this.enabled && this.volumeNormalization) {
        this.compressor.threshold.setTargetAtTime(-24, t, 0.02);
        this.compressor.ratio.setTargetAtTime(10, t, 0.02);
        this.compressor.knee.setTargetAtTime(30, t, 0.02);
        this.compressor.attack.setTargetAtTime(0.005, t, 0.02);
        this.compressor.release.setTargetAtTime(0.25, t, 0.02);
      } else {
        // Gentle transparent safety peak limiter to prevent clipping at high EQ/3D Spatial gain
        this.compressor.threshold.setTargetAtTime(-1.5, t, 0.02);
        this.compressor.ratio.setTargetAtTime(12, t, 0.02);
        this.compressor.knee.setTargetAtTime(3, t, 0.02);
        this.compressor.attack.setTargetAtTime(0.002, t, 0.02);
        this.compressor.release.setTargetAtTime(0.1, t, 0.02);
      }
    },

    setVolumeNormalization(enabled) {
      this.volumeNormalization = !!enabled;
      try {
        localStorage.setItem('trove_vol_normalization', this.volumeNormalization ? 'true' : 'false');
      } catch (_) {}
      this.applyNormalization();
    },

    setBand(bandIdx, val) {
      const parsed = Math.max(-12, Math.min(12, parseFloat(val) || 0));
      this.gains[bandIdx] = parsed;
      this.customGains = [...this.gains];
      this.currentPreset = 'custom';
      this.applyGains();
      this.save();
      this.updateUI();
    },

    setPreset(presetKey) {
      if (presetKey === 'custom') {
        this.currentPreset = 'custom';
        this.gains = [...this.customGains];
      } else if (this.presets[presetKey]) {
        this.currentPreset = presetKey;
        this.gains = [...this.presets[presetKey]];
      } else {
        return;
      }
      this.applyGains();
      this.save();
      this.updateUI();
    },

    setSpatialWidth(pct) {
      this.spatialWidth = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
      this.applySpatialWidth();
      this.save();
      this.updateUI();
    },

    setRoomMode(mode) {
      if (['off', 'studio', 'hall'].includes(mode)) {
        this.roomMode = mode;
        this.applyRoomMode();
        this.save();
        this.updateUI();
      }
    },

    toggleBypass() {
      this.enabled = !this.enabled;
      this.applyGains();
      this.applySpatialWidth();
      this.applyRoomMode();
      this.applyNormalization();
      this.save();
      this.updateUI();
    },

    save() {
      try {
        localStorage.setItem('trove_eq_settings', JSON.stringify({
          enabled: this.enabled,
          preset: this.currentPreset,
          gains: this.gains,
          customGains: this.customGains,
          spatialWidth: this.spatialWidth,
          roomMode: this.roomMode
        }));
      } catch (_) {}
    },

    load() {
      try {
        const raw = localStorage.getItem('trove_eq_settings') || localStorage.getItem('trove_eq');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed.enabled === 'boolean') this.enabled = parsed.enabled;
          if (typeof parsed.preset === 'string') this.currentPreset = parsed.preset;
          if (typeof parsed.spatialWidth === 'number') this.spatialWidth = parsed.spatialWidth;
          if (typeof parsed.roomMode === 'string') this.roomMode = parsed.roomMode;
          if (Array.isArray(parsed.customGains) && parsed.customGains.length === 8) {
            this.customGains = parsed.customGains;
          }
          if (Array.isArray(parsed.gains) && parsed.gains.length === 8) {
            this.gains = parsed.gains;
          } else if (this.currentPreset === 'custom') {
            this.gains = [...this.customGains];
          } else if (this.presets[this.currentPreset]) {
            this.gains = [...this.presets[this.currentPreset]];
          }
        }
      } catch (_) {}
    },

    updateUI() {
      const eqBadge = document.getElementById('eq-badge');
      if (eqBadge) {
        if (!this.enabled) {
          eqBadge.innerText = 'Off';
          eqBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-mono bg-stone-brown/20 dark:bg-[#252a36] text-stone-brown/60 dark:text-[#758092]';
        } else {
          const label = this.currentPreset === 'custom' ? 'Custom' : (this.currentPreset.charAt(0).toUpperCase() + this.currentPreset.slice(1));
          eqBadge.innerText = label;
          eqBadge.className = 'px-1.5 py-0.5 rounded text-[10px] font-mono bg-almond-cream/60 dark:bg-[#252a36] text-stone-brown dark:text-[#c6ac8f]';
        }
      }

      const presetTag = document.getElementById('eq-active-preset-tag');
      if (presetTag) {
        presetTag.innerText = this.currentPreset.charAt(0).toUpperCase() + this.currentPreset.slice(1);
      }

      const bypassBtn = document.getElementById('btn-eq-bypass');
      const bypassDot = document.getElementById('eq-bypass-dot');
      const bypassLabel = document.getElementById('eq-bypass-label');
      if (bypassBtn && bypassDot && bypassLabel) {
        if (this.enabled) {
          bypassBtn.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold font-mono border transition flex items-center gap-1.5 bg-emerald-500/15 border-emerald-500/30 text-emerald-900 dark:text-emerald-300 shadow-sm';
          bypassDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
          bypassLabel.innerText = 'ON';
        } else {
          bypassBtn.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold font-mono border transition flex items-center gap-1.5 bg-stone-brown/10 border-stone-brown/20 text-stone-brown dark:text-[#9aa4b2] shadow-sm';
          bypassDot.className = 'w-2 h-2 rounded-full bg-stone-brown/50';
          bypassLabel.innerText = 'BYPASS';
        }
      }

      document.querySelectorAll('.eq-preset-btn').forEach(btn => {
        const p = btn.dataset.preset;
        if (p === this.currentPreset) {
          btn.className = 'eq-preset-btn px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium shrink-0 transition bg-jet-black text-white dark:bg-[#f3f4f6] dark:text-[#0e1116] shadow-sm';
        } else {
          btn.className = 'eq-preset-btn px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium shrink-0 transition bg-white dark:bg-[#222734] border border-almond-cream dark:border-[#353c4d] text-stone-brown dark:text-[#c6ac8f] hover:bg-almond-cream/40';
        }
      });

      const spatialSlider = document.getElementById('spatial-widener-slider');
      const spatialVal = document.getElementById('spatial-widener-val');
      if (spatialSlider) spatialSlider.value = this.spatialWidth;
      if (spatialVal) spatialVal.innerText = `${this.spatialWidth}%`;

      document.querySelectorAll('.eq-room-btn').forEach(btn => {
        const rm = btn.dataset.room;
        if (rm === this.roomMode) {
          btn.className = 'eq-room-btn px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition bg-jet-black text-white dark:bg-[#f3f4f6] dark:text-[#0e1116] shadow-sm';
        } else {
          btn.className = 'eq-room-btn px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition text-stone-brown dark:text-[#9aa4b2] hover:text-black dark:hover:text-white';
        }
      });

      this.gains.forEach((val, idx) => {
        const slider = document.querySelector(`.eq-band-slider[data-band="${idx}"]`);
        if (slider) slider.value = val;
        const valText = document.getElementById(`eq-val-${idx}`);
        if (valText) {
          valText.innerText = (val > 0 ? `+${val}` : `${val}`) + 'dB';
        }
      });
    },

    show() {
      this.initAudioContext();
      this.resume();
      this.updateUI();
      const sheet = document.getElementById('eq-bottom-sheet');
      if (sheet) {
        sheet.style.display = 'flex';
        if (window.lucide) window.lucide.createIcons({ root: sheet });
        if (MotionAnim) MotionAnim.animateSheetIn(sheet);
      }
    },

    hide() {
      const sheet = document.getElementById('eq-bottom-sheet');
      if (sheet && sheet.style.display === 'flex') {
        if (MotionAnim) {
          MotionAnim.animateSheetOut(sheet, () => {
            sheet.style.display = 'none';
          });
        } else {
          sheet.style.display = 'none';
        }
      }
    },

    toggle() {
      if (this.isOpen) {
        this.hide();
      } else {
        this.show();
      }
    },

    init() {
      this.load();
      this.updateUI();
      this.setupEventListeners();
    },

    setupEventListeners() {
      const btnOpen = document.getElementById('btn-eq-toggle') || document.getElementById('btn-open-eq');
      const btnClose = document.getElementById('btn-close-eq');
      const sheet = document.getElementById('eq-bottom-sheet');
      const backdrop = document.getElementById('eq-backdrop');
      const btnBypass = document.getElementById('btn-eq-bypass');
      const btnReset = document.getElementById('btn-reset-eq');
      const spatialSlider = document.getElementById('spatial-widener-slider');

      if (btnOpen) {
        btnOpen.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggle();
        });
      }
      if (btnClose) {
        btnClose.addEventListener('click', () => this.hide());
      }
      if (sheet) {
        sheet.addEventListener('click', (e) => {
          if (e.target === sheet || e.target === backdrop) {
            this.hide();
          }
        });
      }
      if (backdrop) {
        backdrop.addEventListener('click', (e) => {
          e.stopPropagation();
          this.hide();
        });
      }
      if (btnBypass) {
        btnBypass.addEventListener('click', () => this.toggleBypass());
      }
      if (btnReset) {
        btnReset.addEventListener('click', () => this.setPreset('flat'));
      }

      // Presets buttons
      document.querySelectorAll('.eq-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.preset;
          if (p) this.setPreset(p);
        });
      });

      // Room buttons
      document.querySelectorAll('.eq-room-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const rm = btn.dataset.room;
          if (rm) this.setRoomMode(rm);
        });
      });

      // Spatial slider
      if (spatialSlider) {
        spatialSlider.addEventListener('input', (e) => {
          this.setSpatialWidth(e.target.value);
        });
      }

      // 8 band sliders
      document.querySelectorAll('.eq-band-slider').forEach(slider => {
        slider.addEventListener('input', (e) => {
          const band = parseInt(e.target.dataset.band, 10);
          this.setBand(band, e.target.value);
        });
      });

      // Keep AudioContext alive across minimize / notification resume transitions
      const ensureAudioAlive = () => {
        if (!this.ctx) return;
        const player = window.Trove?.player;
        const activeEl = player?.getActiveElement?.();
        if (player?.isPlaying || (activeEl && !activeEl.paused)) {
          this.resume();
        }
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          ensureAudioAlive();
        }
      });
      window.addEventListener('focus', ensureAudioAlive);
    }
  };

  // Export
  window.Trove.equalizer = Equalizer;

  // Backward compatibility aliases
  window.Equalizer = Equalizer;
  window.showEqualizerSheet = () => Equalizer.show();
  window.hideEqualizerSheet = () => Equalizer.hide();
})();

