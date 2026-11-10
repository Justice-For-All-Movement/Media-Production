# Test-only signal analysis (numpy): distinct pitches, chroma and RMS of a 16-bit WAV file.
import json, sys, wave
import numpy as np

def load(path):
    with wave.open(path, 'rb') as w:
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    return (x.reshape(-1, ch).mean(axis=1) if ch > 1 else x), sr

def frames(x, sr, size=8192, hop=4096):
    win = np.hanning(size)
    for i in range(0, len(x) - size, hop):
        seg = x[i:i + size]
        if np.sqrt(np.mean(seg ** 2)) < 0.01: continue
        yield np.abs(np.fft.rfft(seg * win)), np.fft.rfftfreq(size, 1 / sr)

cmd, path = sys.argv[1], sys.argv[2]
x, sr = load(path)
if cmd == 'pitches':   # dominant spectral peak per frame, as MIDI note numbers
    notes = []
    for mag, freqs in frames(x, sr):
        band = (freqs > 80) & (freqs < 2000)
        f = freqs[band][np.argmax(mag[band])]
        notes.append(int(round(69 + 12 * np.log2(f / 440.0))))
    hist = {}
    for n in notes: hist[n] = hist.get(n, 0) + 1
    print(json.dumps({'distinct': sorted(set(notes)), 'frames': len(notes), 'hist': hist}))
elif cmd == 'chroma':  # energy per pitch class
    chroma = np.zeros(12)
    for mag, freqs in frames(x, sr):
        band = (freqs > 100) & (freqs < 2000)
        midi = np.round(69 + 12 * np.log2(freqs[band] / 440.0)).astype(int)
        np.add.at(chroma, midi % 12, mag[band] ** 2)
    print(json.dumps((chroma / chroma.sum()).tolist()))
elif cmd == 'rms':
    a, b = int(float(sys.argv[3]) * sr), int(float(sys.argv[4]) * sr)
    print(json.dumps(float(np.sqrt(np.mean(x[a:b] ** 2)))))
