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
  /** Which message is actively being spoken (timestamp, or '__streaming__'). */
  ttsSpeakingId: string | null;
  speakBlockSpoken: boolean;
  /** Selected mic deviceId ('' = system default) */
  micDeviceId: string;
  /** Selected speaker deviceId ('' = system default) */
  speakerDeviceId: string;

  setTtsAutoSpeak: (on: boolean) => void;
  setTtsRatePct: (pct: number) => void;
  setMicSticky: (on: boolean) => void;
  setMicState: (state: MicState) => void;
  setVadActive: (active: boolean) => void;
  setTtsPlaying: (playing: boolean) => void;
  setTtsSpeakingId: (id: string | null) => void;
  setSpeakBlockSpoken: (spoken: boolean) => void;
  setMicDeviceId: (id: string) => void;
  setSpeakerDeviceId: (id: string) => void;
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
      ttsSpeakingId: null,
      speakBlockSpoken: false,
      micDeviceId: '',
      speakerDeviceId: '',

      setTtsAutoSpeak: (on) => set({ ttsAutoSpeak: on }),
      setTtsRatePct: (pct) => set({ ttsRatePct: pct }),
      setMicSticky: (on) => set({ micSticky: on }),
      setMicState: (state) => set({ micState: state }),
      setVadActive: (active) => set({ vadActive: active }),
      setTtsPlaying: (playing) => set({ ttsPlaying: playing }),
      setTtsSpeakingId: (id) => set({ ttsSpeakingId: id }),
      setSpeakBlockSpoken: (spoken) => set({ speakBlockSpoken: spoken }),
      setMicDeviceId: (id) => set({ micDeviceId: id }),
      setSpeakerDeviceId: (id) => set({ speakerDeviceId: id }),
    }),
    {
      name: 'aigent-voice',
      partialize: (s) => ({
        ttsAutoSpeak: s.ttsAutoSpeak,
        ttsRatePct: s.ttsRatePct,
        micSticky: s.micSticky,
        micDeviceId: s.micDeviceId,
        speakerDeviceId: s.speakerDeviceId,
      }),
    }
  )
);
