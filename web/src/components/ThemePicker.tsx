import { useState } from "react";
import { THEMES, applyTheme, currentTheme, type ThemeId } from "../lib/theme";

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(currentTheme());
  return (
    <section className="panel" style={{ marginTop: 28 }} aria-label="Apparence">
      <h2>Apparence</h2>
      <div className="theme-grid" role="radiogroup" aria-label="Thème de couleurs">
        {THEMES.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={theme === t.id}
            className="theme-swatch"
            onClick={() => {
              applyTheme(t.id);
              setTheme(t.id);
            }}
          >
            <span className="dots" aria-hidden>
              {t.colors.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            {t.name}
          </button>
        ))}
      </div>
    </section>
  );
}
