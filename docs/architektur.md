# Architektur, CLI und KI-Anbindung

Browser, CLI und optionaler MCP-Adapter greifen auf dieselben Dokumentfunktionen des lokalen Servers zu. HTTP liefert Dokumente, Snapshots und Befehle. Ein WebSocket überträgt Änderungen an offene Browser. Das UI zeichnet laufende Stiftzüge direkt und sendet abgeschlossene Züge mit eindeutiger Operations-ID. Ein Modellaufruf liegt nie im Pfad zwischen Stift und Bildschirm.

## Dokumente und Obsidian

Pro Canvas ein vom Nutzer gewählter Ort im Vault. Vorschlag für die erste Version:

- Eine Markdown-Notiz als Einstieg, mit eingebetteter Vorschau und Browser-Link.
- Eine versionierte Paperlink-Datei mit stabilen IDs für Dokument, Seiten und Objekte.
- Relativ referenzierte Assets für PDF-Original und Vorschau.

Paperlink speichert PDFs und Stiftzüge getrennt. Seitenkoordinaten bleiben unabhängig von Zoom und Browsergröße. Texte und KI-Anmerkungen sind eigene Objekte. Die Vorschau wird nach bestätigten Änderungen aktualisiert. Die App erkennt Dokumente anhand ihrer ID und kann sie über die CLI mitsamt den zugehörigen Dateien verschieben. Verschieben per Obsidian oder Dateimanager muss vor breiter Freigabe mit stabilen relativen Verweisen getestet werden. Das native Obsidian-Canvas-Format und ein Obsidian-Editorplugin sind eigene, spätere Integrationen.

Der Server schreibt atomar und ist während der Bearbeitung die maßgebliche Instanz. Jede Änderung hat eine Revision. Ergänzungen mit stabiler ID können dedupliziert werden. Änderungen an vorhandenen Objekten prüfen die erwartete Revision und melden Konflikte. Undo/Redo erfasst die eigenen Bearbeitungsschritte, damit Änderungen anderer Geräte erhalten bleiben. Browser speichern noch nicht bestätigte Operationen lokal. Nach einem Verbindungsabbruch laden sie den bestätigten Stand und senden ausstehende Operationen erneut.

## Entwurf der CLI

```sh
paper init --vault ~/Documents/MeinVault
paper serve --port 8080 --lan
paper canvas create "Aufgabe 4" --path "Uni/Mathe"
paper canvas list --json
paper canvas open <canvas-id>
paper canvas import-pdf <canvas-id> Arbeitsblatt.pdf
paper page inspect <page-id> --json
paper page snapshot <page-id> --output /tmp/seite.png
paper annotate <page-id> --region 120,300,400,200 --text "Hier fehlt die Einheit."
paper canvas export <canvas-id> --pdf --output Abgabe.pdf
paper mcp
```

Ein Server verwaltet mehrere Dokumente. Port und Speicherort sind konfigurierbar. Weitere Instanzen können auf getrennten Ports laufen. Gleichzeitiges Schreiben mehrerer Server auf denselben Dokumentbestand soll die erste Version unterbinden. Für Agenten gibt es stabile IDs, JSON-Ausgaben, aussagekräftige Fehler und eine kurze Befehlsreferenz. Annotationen verwenden Seitenkoordinaten und erscheinen in offenen Browsern. Pfade bleiben auf die konfigurierte Dokumentwurzel begrenzt.

## KI lesen, bearbeiten und anstoßen

- **Aus dem Chat:** Assistenten mit lokalem Terminalzugriff nutzen die CLI. Kompatible Clients können alternativ den optionalen MCP-Adapter verwenden. Die ersten Werkzeuge sind Seiten auflisten, Ausschnitt abrufen und Annotation hinzufügen.
- **Vom Blatt aus:** „Feedback anfragen“ sendet ein Ereignis mit Dokument-ID, Seite, Ausschnitt, Revision und optionaler Frage an eine lokal konfigurierte Integration. Der erste Adapter kann Claude Code per `claude -p` oder Codex per `codex exec` starten. Keine Modellanbindung ist voreingestellt.
- **Laufende Unterhaltung:** Claude Code Channels ist eine Option für eine laufende Claude-Code-Sitzung. Für eine von Paperlink verwaltete Codex-Unterhaltung kommt der Codex App Server infrage. Für normale offene ChatGPT-Chats ist kein direkter Push vorgesehen. API-Trigger für ChatGPT Workspace Agents sind ein gesonderter Integrationsweg.
- **Automatische Auslöser später:** Ein ausdrücklich aktivierter Modus könnte nach einer Schreibpause Feedback anfragen. Die normale Live-Synchronisation löst keine Modellaufrufe aus.

Die erste KI-Integration beschränkt Zugriff auf das gewählte Blatt bzw. den gewählten Bereich und schreibt auf eine eigene Anmerkungsebene. Originalhandschrift bleibt standardmäßig geschützt. Ergebnisse mit veralteter Bezugsrevision müssen vor der Platzierung geprüft oder als veraltet angezeigt werden. Der Browser darf keine beliebigen Shell-Befehle an den Server schicken. Adapter und erlaubte Aktionen werden am Rechner konfiguriert.

Referenzen: [MCP](https://ts.sdk.modelcontextprotocol.io/server), [Claude Code CLI](https://code.claude.com/docs/en/headless), [Claude Code Channels](https://code.claude.com/docs/en/channels), [Codex](https://developers.openai.com/blog/codex-as-a-platform), [ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business).
