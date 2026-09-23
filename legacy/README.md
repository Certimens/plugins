# Legacy

Anciens outils de captation, remplacés par l'extension (`extension/`) et conservés pour
référence. Ils ne fonctionnent plus avec le moteur actuel : ils envoient leurs mesures à
`POST /telemetry` sur une IP en dur, un endpoint que le moteur n'expose plus.

- `desktop-agents/` : agents de bureau Python (macOS, Windows) qui captaient les frappes au
  niveau du système et tatouaient les `.docx` téléchargés.
- `web-shield/` : extension « Web Shield » qui signalait à l'agent de bureau le document
  Google Docs / Word Online au premier plan.
