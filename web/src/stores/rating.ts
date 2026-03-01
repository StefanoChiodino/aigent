import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RatingEntry {
  score: number;
  notes?: string;
}

interface RatingState {
  /** Per-message ratings: messageId (timestamp) → { score, notes? } */
  ratings: Record<string, RatingEntry>;
  setRating: (messageId: string, score: number, notes?: string) => void;
  clearRatings: () => void;
}

export const useRatingStore = create<RatingState>()(
  persist(
    (set) => ({
      ratings: {},
      setRating: (messageId, score, notes) => set(s => {
        if (score === 0) {
          const { [messageId]: _, ...rest } = s.ratings;
          return { ratings: rest };
        }
        return { ratings: { ...s.ratings, [messageId]: { score, notes } } };
      }),
      clearRatings: () => set({ ratings: {} }),
    }),
    { name: 'aigent-ratings' },
  ),
);
