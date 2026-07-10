import { useCallback, useState } from "react";

const STORAGE_KEY = "docent-theme";

// Theme state lives on <html data-theme="...">, set pre-paint by the inline
// script in index.html; this hook just mirrors and toggles it.
export function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage unavailable (private mode) — theme still applies for the session.
      }
      return next;
    });
  }, []);

  return [theme, toggleTheme];
}
