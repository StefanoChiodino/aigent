import { create } from 'zustand';

interface DemoPlaybackState {
  currentStep: number;
  totalSteps: number;
  playing: boolean;
  stepLabels: string[];
  setCurrentStep: (n: number) => void;
  setTotalSteps: (n: number) => void;
  setPlaying: (p: boolean) => void;
  setStepLabels: (labels: string[]) => void;
}

export const useDemoPlaybackStore = create<DemoPlaybackState>((set) => ({
  currentStep: 0,
  totalSteps: 0,
  playing: true,
  stepLabels: [],
  setCurrentStep: (n) => set({ currentStep: n }),
  setTotalSteps: (n) => set({ totalSteps: n }),
  setPlaying: (p) => set({ playing: p }),
  setStepLabels: (labels) => set({ stepLabels: labels }),
}));
