# Fitness

Persönliche Trainings-App (Gewicht, Training, Körpermaße).

- Läuft als statische Seite auf GitHub Pages, kann auf dem Handy zum Startbildschirm hinzugefügt werden.
- **Dieses Repository enthält keine persönlichen Daten.** Die Daten liegen in einem separaten, privaten Repository und werden nur mit einem persönlichen Schlüssel geladen.
- Ohne Schlüssel zeigt die App nur einen Sperrbildschirm.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Grundgerüst |
| `app.js` | Logik und Ansichten |
| `style.css` | Design (dunkel) |
| `sw.js` | Service Worker (installierbar, App-Dateien offline verfügbar) |
| `manifest.webmanifest` | App-Name und Icons für den Startbildschirm |

## Daten-Repository (privat)

Erwartete Dateien: `gewicht.md`, `masse.md`, `trainingslog.md` (Markdown-Tabellen) und `trainingsplan.json`.
