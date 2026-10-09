import { create } from 'zustand';

/**
 * Walk mode in the 3D view (owner 9 Oct): the camera at eye height on the ground, moved with the keys. While
 * walking, the presenter's arrow keys and Esc belong to the walk, not to the slides.
 */
interface WalkState {
  walking: boolean;
  setWalking: (on: boolean) => void;
}

export const useWalk = create<WalkState>((set) => ({
  walking: false,
  setWalking: (on) => set({ walking: on }),
}));
