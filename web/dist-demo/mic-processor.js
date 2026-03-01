// AudioWorkletProcessor — runs in AudioWorkletGlobalScope (audio thread).
// Accumulates 128-sample render quanta into 4096-sample frames, computes RMS
// for VAD, and posts { samples: Float32Array, rms: number } to the main thread
// via a zero-copy transferable.

const FRAME_SIZE = 4096;

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SIZE);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // keep processor alive

    const channel = input[0];
    let i = 0;

    while (i < channel.length) {
      const space = FRAME_SIZE - this._offset;
      const take = Math.min(space, channel.length - i);
      this._buffer.set(channel.subarray(i, i + take), this._offset);
      this._offset += take;
      i += take;

      if (this._offset === FRAME_SIZE) {
        // Compute RMS on the audio thread (cheap here, saves main thread work)
        let sum = 0;
        for (let j = 0; j < FRAME_SIZE; j++) {
          sum += this._buffer[j] * this._buffer[j];
        }
        const rms = Math.sqrt(sum / FRAME_SIZE);

        // Transfer the buffer zero-copy to the main thread, then reset
        const samples = this._buffer;
        this._buffer = new Float32Array(FRAME_SIZE);
        this._offset = 0;

        this.port.postMessage({ samples, rms }, [samples.buffer]);
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor('mic-processor', MicProcessor);
