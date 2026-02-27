import { create } from 'zustand';

export interface DemoSection {
  id: string;
  label: string;
  step: number;
}

interface DemoPlaybackState {
  currentStep: number;
  totalSteps: number;
  playing: boolean;
  stepLabels: string[];
  sections: DemoSection[];
  currentSectionId: string;
  setCurrentStep: (n: number) => void;
  setTotalSteps: (n: number) => void;
  setPlaying: (p: boolean) => void;
  setStepLabels: (labels: string[]) => void;
  setSections: (sections: DemoSection[]) => void;
  setCurrentSectionId: (id: string) => void;
}

export const useDemoPlaybackStore = create<DemoPlaybackState>((set) => ({
  currentStep: 0,
  totalSteps: 0,
  playing: true,
  stepLabels: [],
  sections: [],
  currentSectionId: '',
  setCurrentStep: (n) => set({ currentStep: n }),
  setTotalSteps: (n) => set({ totalSteps: n }),
  setPlaying: (p) => set({ playing: p }),
  setStepLabels: (labels) => set({ stepLabels: labels }),
  setSections: (sections) => set({ sections }),
  setCurrentSectionId: (id) => set({ currentSectionId: id }),
}));
