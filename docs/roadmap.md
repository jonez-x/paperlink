# Umsetzung und Abnahme

| Etappe | Lieferumfang | Bestanden, wenn … |
|---|---|---|
| 1 · Stiftprototyp | CLI-Start, eine Browserseite, Stift, Radierer, Undo, Zoom, Hell/Dunkel/System | Eine echte Aufgabe lässt sich auf dem iPad ohne störende Verzögerung, versehentliche Striche oder springende Seite schreiben. |
| 2 · Abgaben und Vault | Mehrseitiges PDF, Seiten ergänzen, sichere Speicherung, Obsidian-Vorschau, PDF-Export | Nach Neustart und erneutem Öffnen sind alle Striche vorhanden. In Obsidian erscheint die Vorschau und der Export enthält Hintergrund und Anmerkungen. |
| 3 · Zwei Geräte | Kopplung per QR, Live-Updates, lokaler Puffer und Wiederverbindung | iPad und Laptop zeigen dasselbe Blatt. Nach WLAN-Unterbrechung fehlen keine Striche und Wiederholungen erzeugen keine Duplikate. |
| 4 · Assistent | CLI mit JSON, Snapshot und Annotation, lokaler Trigger, optionaler MCP-Adapter | Ein Assistent liest den markierten Ausschnitt und seine rückgängig machbare Anmerkung erscheint auf beiden Geräten. |
| Später | Endlose Canvases, Obsidian-Editorplugin, fortlaufende Assistentensitzungen | Priorität ergibt sich aus der Nutzung des ersten vollständigen Ablaufs. |

Vor Umsetzung offen: Verfügbarkeit des CLI-Befehls `paper`, Lizenz, Paketformat, Rendertechnik sowie das genaue Verhalten bei konkurrierenden Bearbeitungen. Die Speicherstruktur und Browser-Kopplung werden zunächst mit Testdaten erprobt. Die wichtigste Entscheidung fällt am iPad: Ob die Browser-Oberfläche sich für längere handschriftliche Abgaben gut genug anfühlt.
