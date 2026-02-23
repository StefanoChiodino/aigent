import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type MicState = 'idle' | 'recording' | 'transcribing';

interface VoiceState {
  ttsAutoSpeak: boolean;
  ttsRatePct: number;
  micSticky: boolean;
  micState: MicState;
  vadActive: boolean;
  ttsPlaying: boolean;
  speakBlockSpoken: boolean;

  setTtsAutoSpeak: (on: boolean) => void;
  setTtsRatePct: (pct: number) => void;
  setMicSticky: (on: boolean) => void;
  setMicState: (state: MicState) => void;
  setVadActive: (active: boolean) => void;
  setTtsPlaying: (playing: boolean) => void;
  setSpeakBlockSpoken: (spoken: boolean) => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      ttsAutoSpeak: false,
      ttsRatePct: 25,
      micSticky: false,
      micState: 'idle',
      vadActive: false,
      ttsPlaying: false,
      speakBlockSpoken: false,

      setTtsAutoSpeak: (on) => set({ ttsAutoSpeak: on }),
      setTtsRatePct: (pct) => set({ ttsRatePct: pct }),
      setMicSticky: (on) => set({ micSticky: on }),
      setMicState: (state) => set({ micState: state }),
      setVadActive: (active) => set({ vadActive: active }),
      setTtsPlaying: (playing) => set({ ttsPlaying: playing }),
      setSpeakBlockSpoken: (spoken) => set({ speakBlockSpoken: spoken }),
    }),
    {
      name: 'aigent-voice',
      partialize: (s) => ({ ttsAutoSpeak: s.ttsAutoSpeak, ttsRatePct: s.ttsRatePct, micSticky: s.micSticky }),
    }
  )
);
