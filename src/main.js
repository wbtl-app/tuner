import { YIN } from 'pitchfinder';

// Constants
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Instrument tunings (string frequencies from low to high)
const TUNINGS = {
  guitar: [
    { note: 'E2', freq: 82.41 },
    { note: 'A2', freq: 110.00 },
    { note: 'D3', freq: 146.83 },
    { note: 'G3', freq: 196.00 },
    { note: 'B3', freq: 246.94 },
    { note: 'E4', freq: 329.63 }
  ],
  bass: [
    { note: 'E1', freq: 41.20 },
    { note: 'A1', freq: 55.00 },
    { note: 'D2', freq: 73.42 },
    { note: 'G2', freq: 98.00 }
  ],
  ukulele: [
    { note: 'G4', freq: 392.00 },
    { note: 'C4', freq: 261.63 },
    { note: 'E4', freq: 329.63 },
    { note: 'A4', freq: 440.00 }
  ],
  violin: [
    { note: 'G3', freq: 196.00 },
    { note: 'D4', freq: 293.66 },
    { note: 'A4', freq: 440.00 },
    { note: 'E5', freq: 659.25 }
  ],
  chromatic: []
};

// State
let audioContext = null;
let analyser = null;
let mediaStream = null;
let detectPitch = null;
let isRunning = false;
let animationId = null;
let currentOscillator = null;
let currentGainNode = null;

// Settings (loaded from localStorage)
let a4Reference = parseInt(localStorage.getItem('tuner-a4') || '440');
let selectedInstrument = localStorage.getItem('tuner-instrument') || 'guitar';

// DOM Elements
const startScreen = document.getElementById('startScreen');
const startBtn = document.getElementById('startBtn');
const tunerDisplay = document.getElementById('tunerDisplay');
const stopBtn = document.getElementById('stopBtn');
const noteName = document.getElementById('noteName');
const frequency = document.getElementById('frequency');
const cents = document.getElementById('cents');
const needle = document.getElementById('needle');
const levelFill = document.getElementById('levelFill');
const levelValue = document.getElementById('levelValue');
const instrumentSelect = document.getElementById('instrumentSelect');
const a4Slider = document.getElementById('a4Slider');
const a4Value = document.getElementById('a4Value');
const stringsContainer = document.getElementById('stringsContainer');
const stringsEl = document.getElementById('strings');

// Initialize UI
function initUI() {
  instrumentSelect.value = selectedInstrument;
  a4Slider.value = a4Reference;
  a4Value.textContent = `${a4Reference} Hz`;
  updateStrings();
}

// Frequency to note conversion
function frequencyToNote(freq) {
  const semitones = 12 * Math.log2(freq / a4Reference);
  const noteNum = Math.round(semitones) + 69; // MIDI note number (A4 = 69)
  const octave = Math.floor(noteNum / 12) - 1;
  const noteIndex = ((noteNum % 12) + 12) % 12;
  const noteName = NOTE_NAMES[noteIndex];
  return { name: noteName, octave, noteNum, fullName: `${noteName}${octave}` };
}

// Get cents off from perfect pitch
function getCentsOff(freq, note) {
  const exactFreq = a4Reference * Math.pow(2, (note.noteNum - 69) / 12);
  return Math.round(1200 * Math.log2(freq / exactFreq));
}

// Update display
function updateDisplay(freq, note, centsOff) {
  // Note name
  noteName.textContent = note.fullName;

  // Frequency
  frequency.textContent = `${freq.toFixed(1)} Hz`;

  // Cents
  const absCents = Math.abs(centsOff);
  if (absCents <= 5) {
    cents.textContent = 'In Tune';
    cents.className = 'cents-display in-tune';
    noteName.className = 'note-name in-tune';
  } else if (centsOff > 0) {
    cents.textContent = `+${centsOff} cents`;
    cents.className = 'cents-display sharp';
    noteName.className = 'note-name sharp';
  } else {
    cents.textContent = `${centsOff} cents`;
    cents.className = 'cents-display flat';
    noteName.className = 'note-name flat';
  }

  // Needle rotation (-50 to +50 cents = -90 to +90 degrees)
  const clampedCents = Math.max(-50, Math.min(50, centsOff));
  const rotation = (clampedCents / 50) * 90;
  needle.style.transform = `translateX(-50%) rotate(${rotation}deg)`;
}

// Reset display
function resetDisplay() {
  noteName.textContent = '--';
  noteName.className = 'note-name';
  frequency.textContent = '-- Hz';
  cents.textContent = '-- cents';
  cents.className = 'cents-display';
  needle.style.transform = 'translateX(-50%) rotate(0deg)';
}

// Update input level meter
function updateLevel(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sum / buffer.length);
  const db = 20 * Math.log10(rms);
  const percent = Math.max(0, Math.min(100, (db + 60) * 1.67)); // Map -60dB to 0dB -> 0% to 100%

  levelFill.style.width = `${percent}%`;
  levelValue.textContent = `${Math.round(percent)}%`;

  return rms > 0.01; // Noise gate threshold
}

// Update strings display
function updateStrings() {
  const tuning = TUNINGS[selectedInstrument];

  if (!tuning || tuning.length === 0) {
    stringsContainer.style.display = 'none';
    return;
  }

  stringsContainer.style.display = 'block';
  stringsEl.innerHTML = '';

  // Recalculate frequencies based on current A4 reference
  const a4Ratio = a4Reference / 440;

  tuning.forEach((string, index) => {
    const adjustedFreq = string.freq * a4Ratio;
    const btn = document.createElement('button');
    btn.className = 'string-btn';
    btn.innerHTML = `
      <span class="note">${string.note}</span>
      <span class="freq">${adjustedFreq.toFixed(1)} Hz</span>
      <span class="play-icon">▶</span>
    `;
    btn.addEventListener('click', () => playTone(adjustedFreq, btn));
    stringsEl.appendChild(btn);
  });
}

// Play reference tone
function playTone(freq, btnEl) {
  // Stop any existing tone
  stopTone();

  // Create audio context if needed
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Resume if suspended
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  currentOscillator = audioContext.createOscillator();
  currentGainNode = audioContext.createGain();

  currentOscillator.connect(currentGainNode);
  currentGainNode.connect(audioContext.destination);

  currentOscillator.frequency.value = freq;
  currentOscillator.type = 'sine';

  currentGainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
  currentGainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 2);

  currentOscillator.start();
  currentOscillator.stop(audioContext.currentTime + 2);

  // Visual feedback
  if (btnEl) {
    btnEl.classList.add('active');
    setTimeout(() => btnEl.classList.remove('active'), 2000);
  }

  currentOscillator.onended = () => {
    currentOscillator = null;
    currentGainNode = null;
  };
}

// Stop tone
function stopTone() {
  if (currentOscillator) {
    try {
      currentOscillator.stop();
    } catch (e) {}
    currentOscillator = null;
  }
  if (currentGainNode) {
    currentGainNode = null;
  }
}

// Analysis loop
function analyze() {
  if (!isRunning) return;

  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  // Check if there's enough signal
  if (updateLevel(buffer)) {
    const pitch = detectPitch(buffer);

    if (pitch && pitch > 20 && pitch < 5000) {
      const note = frequencyToNote(pitch);
      const centsOff = getCentsOff(pitch, note);
      updateDisplay(pitch, note, centsOff);
    }
  } else {
    // Signal too quiet
    resetDisplay();
  }

  animationId = requestAnimationFrame(analyze);
}

// Start tuner
async function startTuner() {
  try {
    // Create audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Get microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // Set up audio nodes
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096; // Larger buffer for better low-frequency detection
    source.connect(analyser);

    // Initialize pitch detector
    detectPitch = YIN({ sampleRate: audioContext.sampleRate });

    // Start analysis
    isRunning = true;
    analyze();

    // Update UI
    startScreen.style.display = 'none';
    tunerDisplay.classList.add('active');

  } catch (err) {
    console.error('Error starting tuner:', err);
    alert('Could not access microphone. Please allow microphone access and try again.');
  }
}

// Stop tuner
function stopTuner() {
  isRunning = false;

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  detectPitch = null;

  // Update UI
  tunerDisplay.classList.remove('active');
  startScreen.style.display = 'block';
  resetDisplay();
  levelFill.style.width = '0%';
  levelValue.textContent = '0%';
}

// Event listeners
startBtn.addEventListener('click', startTuner);
stopBtn.addEventListener('click', stopTuner);

instrumentSelect.addEventListener('change', (e) => {
  selectedInstrument = e.target.value;
  localStorage.setItem('tuner-instrument', selectedInstrument);
  updateStrings();
});

a4Slider.addEventListener('input', (e) => {
  a4Reference = parseInt(e.target.value);
  a4Value.textContent = `${a4Reference} Hz`;
  localStorage.setItem('tuner-a4', a4Reference.toString());
  updateStrings();
});

// Initialize
initUI();
