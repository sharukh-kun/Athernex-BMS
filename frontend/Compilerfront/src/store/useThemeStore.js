// store/useThemeStore.js
import { create } from "zustand";

export const useThemeStore = create((set) => ({
  theme: "dark",
  toggleTheme: () =>
    set((state) => ({
      theme: state.theme === "dark" ? "light" : "dark"
    }))
}));