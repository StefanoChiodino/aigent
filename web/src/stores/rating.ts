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
  /** Move a rating from one messageId to another (e.g. streaming → final) */
  remapRating: (fromId: string, toId: string) => void;
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
      remapRating: (fromId, toId) => set(s => {
        const entry = s.ratings[fromId];
        if (!entry) return s;
        const { [fromId]: _, ...rest } = s.ratings;
        return { ratings: { ...rest, [toId]: entry } };
      }),
      clearRatings: () => set({ ratings: {} }),
    }),
    { name: 'aigent-ratings' },
  ),
);
