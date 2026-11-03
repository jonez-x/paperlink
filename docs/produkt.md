# Produkt und Bedienung

## Der erste vollständige Ablauf

1. Paperlink auf dem Laptop starten. Die CLI zeigt die Adresse und bei aktiviertem WLAN-Zugriff einen QR-Code.
2. Ein Canvas im gewünschten Ordner des Vaults anlegen und ein mehrseitiges Arbeitsblatt als PDF importieren.
3. Auf dem iPad im Browser öffnen, direkt auf dem Blatt schreiben, radieren, markieren und mit zwei Fingern zoomen.
4. Am Laptop dasselbe Dokument sehen. Im Chat nach Aufgabe 3 fragen oder auf dem iPad einen Bereich markieren und Feedback anfragen.
5. Der Assistent liest den aktuellen Ausschnitt und setzt seinen Hinweis auf eine separate Ebene. Du kannst ihn ausblenden, entfernen oder übernehmen.
6. Das bearbeitete Arbeitsblatt auf hellem Papier als PDF abgeben. Original, editierbare Handschrift und Obsidian-Vorschau bleiben erhalten.

## Schreiboberfläche

Seitenmodus für Arbeitsblätter und Abgaben zuerst. Endlose Fläche für freie Skizzen und Notizen später. Die kompakte Leiste enthält Stift, Marker, Radierer, Lasso, Text und Undo/Redo. Das Lasso soll Objekte verschieben und skalieren können. Seitenwechsel, Zoom und PDF-Import sind leicht erreichbar. Selten genutzte Optionen liegen im Menü. Im normalen Schreibmodus bleibt die Fläche frei von Chatfenstern und KI-Angeboten.

[Mistral](https://mistral.ai/) ist die visuelle Referenz. Warme neutrale Flächen, kantige Formen, klare Typografie und feine Trennlinien. Orange zeigt das aktive Werkzeug, Gelb und Rot bleiben sparsame Akzente. Kleine Pixel-Details eignen sich für leere Zustände. Das Projekt verwendet eigene Symbole und einen eigenen Namen.

**Hell, Dunkel und System sind ab dem ersten Prototyp verfügbar.** Die Einstellung bleibt pro Browser erhalten. Der Dunkelmodus umfasst Oberfläche und leere Schreibseiten. Farben müssen in beiden Modi lesbar bleiben. Importierte PDFs behalten standardmäßig ihr Originalbild. Für den Export sind Papierfarbe und Tintenabbildung unabhängig vom UI-Theme.

## iPad und Netzwerk

Browser statt nativer App. Der erste Praxistest findet in Safari mit einem echten Apple Pencil statt. Stiftbewegungen werden sofort lokal dargestellt. Finger dienen im Stiftmodus der Navigation. Aufgelegte Hand darf weder Striche noch Seitensprünge auslösen. Zum Test gehören Druck, Radierer, Zwei-Finger-Zoom, Undo und die Bedienung im Hoch- und Querformat.

Der Server ist standardmäßig nur lokal erreichbar. WLAN-Zugriff wird ausdrücklich aktiviert und Geräte werden per QR-Code gekoppelt. Mac und iPad können dasselbe Dokument gleichzeitig öffnen. Bei kurzer Unterbrechung puffert der Browser ausstehende Stiftzüge und gleicht sie nach Wiederverbindung ab. Eine klare Anzeige unterscheidet lokal gepufferte und auf dem Server gespeicherte Änderungen.
