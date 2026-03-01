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
  /** Human-readable label for the selected mic (used to re-match after Chrome regenerates IDs) */
  micDeviceLabel: string;
  /** Selected speaker deviceId ('' = system default) */
  speakerDeviceId: string;
  /** Human-readable label for the selected speaker (used to re-match after Chrome regenerates IDs) */
  speakerDeviceLabel: string;

  setTtsAutoSpeak: (on: boolean) => void;
  setTtsRatePct: (pct: number) => void;
  setMicSticky: (on: boolean) => void;
  setMicState: (state: MicState) => void;
  setVadActive: (active: boolean) => void;
  setTtsPlaying: (playing: boolean) => void;
  setTtsSpeakingId: (id: string | null) => void;
  setSpeakBlockSpoken: (spoken: boolean) => void;
  /** @deprecated Use setMicDevice(id, label) */
  setMicDeviceId: (id: string) => void;
  /** @deprecated Use setSpeakerDevice(id, label) */
  setSpeakerDeviceId: (id: string) => void;
  setMicDevice: (id: string, label: string) => void;
  setSpeakerDevice: (id: string, label: string) => void;
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
      micDeviceLabel: '',
      speakerDeviceId: '',
      speakerDeviceLabel: '',

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
      setMicDevice: (id, label) => set({ micDeviceId: id, micDeviceLabel: label }),
      setSpeakerDevice: (id, label) => set({ speakerDeviceId: id, speakerDeviceLabel: label }),
    }),
    {
      name: 'aigent-voice',
      partialize: (s) => ({
        ttsAutoSpeak: s.ttsAutoSpeak,
        ttsRatePct: s.ttsRatePct,
        micSticky: s.micSticky,
        micDeviceId: s.micDeviceId,
        micDeviceLabel: s.micDeviceLabel,
        speakerDeviceId: s.speakerDeviceId,
        speakerDeviceLabel: s.speakerDeviceLabel,
      }),
    }
  )
);
