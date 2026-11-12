# Backup und Wiederherstellung

## Speicherort wählen

Der Datenordner ist über die Option `data_path` konfigurierbar:

| `data_path` | Effektiver Pfad | Im HA-Backup enthalten |
| --- | --- | --- |
| `config` (Standard) | `config/frickeldave_store/` | **ja** |
| `share` | `/share/frickeldave_store/` | nein |
| `media` | `/media/frickeldave_store/` | nein |

`config` bleibt der Standard. Ein Home-Assistant-Backup mit „Home Assistant
settings“ archiviert das gesamte Config-Verzeichnis; Home Assistant erlaubt
dabei **keine** Ausnahme für einzelne Unterordner (`EXCLUDE_FROM_BACKUP` ist
fest verdrahtet). Wer den Katalog vom Backup ausnehmen will, legt ihn deshalb
nach `share` oder `media`.

Unterstützt werden ausschließlich diese drei Werte. Freie Pfade werden
abgelehnt (kein Pfad-Traversal). Vor dem Speichern legt die Integration das
Zielverzeichnis an und prüft die Schreibbarkeit; ein fehlender Mount führt zu
einem klaren Fehler (`400 validation_error`) statt zu einem stillen Fallback.

Im Konfigurationspanel (Tab **Allgemeine Einstellungen**) zeigt der Schalter
**„Produktkatalog im Home-Assistant-Backup enthalten“** den aus `data_path`
abgeleiteten Zustand: `config` = enthalten, `share`/`media` = nicht enthalten.
Der Schalter wählt beim Einschalten `config`, beim Ausschalten `share`; `media`
ist als alternatives Ziel wählbar. Die Oberfläche zeigt dabei die betroffenen
Pfade an.

## Was gesichert wird

Der Datenordner enthält immer **Store-Datei, Bilder und Snapshots gemeinsam**:

| Inhalt | Pfad (relativ zum Datenordner) |
| --- | --- |
| Metadaten | `frickeldave_store.data` |
| Bilder | `images/<artikelnummer>/<artikelnummer>-NN.jpg` |
| Snapshots | `backups/` |
| Original-Sicherungen gedrehter Bilder | `backups/images/<artikelnummer>/` |

Bei `data_path = config` sind das die bisherigen Pfade
`config/frickeldave_store/...`. Eine Sicherung nur der JSON-Datei verliert die
Bildzuordnungen.

Der **Export** ist davon unabhängig: `export_path` ist weiterhin relativ zu
`config/` (Standard `frickeldave_store/export`) und kann ebenfalls vom Backup
ausgenommen werden, indem er z. B. nach `share` oder `media` verschoben wird.

## Backup-Verhalten je Speicherort

**`config` (Standard)**

- Ein HA-Backup („Home Assistant settings“) enthält den Katalog automatisch.
- Zusätzlich empfiehlt sich ein manuelles Backup vor Updates:

  ```bash
  tar czf frickeldave_store_backup_$(date +%F).tar.gz config/frickeldave_store
  ```

**`share` / `media`**

- Der Katalog ist **nicht** im HA-Backup enthalten.
- Docker-Container-Nutzer müssen das Verzeichnis als Volume einbinden, sonst
  schlägt die Auswahl mit einer klaren Meldung fehl:
  - `/share` → `-v /pfad/auf/host:/share`
  - `/media` → `-v /pfad/auf/host:/media`
- Das Verzeichnis in die eigene Backup-Strategie aufnehmen, z. B.:

  ```bash
  tar czf frickeldave_store_backup_$(date +%F).tar.gz /pfad/auf/host/frickeldave_store
  ```

- Die Store-Datei und Bilder werden atomar geschrieben (`os.replace`); ein
  Backup während eines laufenden Schreibvorgangs sieht den alten oder neuen
  Stand, nie eine halbe Datei.

## Wechsel des Speicherorts (Migration)

Beim Ändern von `data_path` (Konfigurationspanel/`PATCH /settings` oder
Options-Flow):

1. Die Integration löst alten und neuen Ordner auf. Sind sie gleich, passiert
   nichts.
2. Enthält der Zielordner bereits eine `frickeldave_store.data` oder ein
   nicht-leeres `images/`, bricht der Wechsel mit `409 conflict` ab. Es wird
   **nichts überschrieben**.
3. Andernfalls werden Store-Datei, `images/` und `backups/` kopiert (im
   Executor). Der **alte Ordner bleibt unverändert** und kann nach einer
   Sichtprüfung manuell gelöscht werden.
4. Die Option wird gespeichert und der Config Entry neu geladen, damit der Store
   am neuen Pfad öffnet. Berechtigungen und KI-Einstellungen werden dabei erneut
   angewendet.

Die API meldet nach einer erfolgreichen Migration `"reload_required": true`.
Die Kopie läuft vollständig durch, bevor die Option geschrieben wird; es gibt
keinen Zustand, in dem Daten nur zur Hälfte kopiert sind.

Nach der Migration den alten Ordner erst löschen, wenn Produktanzahl und
Stichprobenbilder im Panel stimmen.

## Snapshots vor Migrationen und Schreibvorgängen

- Vor jeder Schema-Migration kopiert der Store die bestehende Datei nach
  `<Datenordner>/backups/<zeitstempel>-pre-load-v<n>.json`.
- Vor dem **ersten Schreibvorgang nach dem Laden** entsteht zusätzlich
  `<Datenordner>/backups/<zeitstempel>-pre-save.json`. Das ist das Netz für den
  Fehler aus Issue #289 (Katalog wurde leer geladen und überschrieben).
- `async_migrate_entry` legt zusätzlich
  `<Datenordner>/backups/<zeitstempel>-pre-entry-migration-v<n>.json` an.
- Vor einer Bilddrehung entstehen zwei Sicherungen: die pixelgenaue
  Original-Sicherung der Bilddatei unter
  `<Datenordner>/backups/images/<artikelnummer>/<zeitstempel>-<dateiname>` und
  der Metadaten-Snapshot
  `<Datenordner>/backups/<zeitstempel>-pre-image-rotate.json`. Die
  Original-Sicherung enthält die Bilddatei im Ausgangsformat; eine Drehung
  konvertiert nicht, anders als der Upload (PNG ohne Transparenz wird dort zu
  JPEG, PNG/WebP mit Transparenz zu WebP).
- Snapshots werden nicht automatisch gelöscht; bei Bedarf manuell aufräumen.
  Wiederholte `pre-save`-Snapshots mit identischem Inhalt werden nicht dupliziert.

## Prüfsummen

```bash
# data_path = config
cd config/frickeldave_store
sha256sum frickeldave_store.data
find images -type f -exec sha256sum {} + | sort -k2 > images.sha256
```

Bei `share`/`media` denselben Befehl im jeweiligen Ordner
(`/share/frickeldave_store` bzw. `/media/frickeldave_store`) ausführen.

## Wiederherstellung

### Aus einem Snapshot (ohne HA-Backup)

Die Integration legt vor Migrationen und vor dem ersten Schreiben nach dem Laden
Snapshots in `<Datenordner>/backups/` ab. Sie enthalten exakt das HA-Store-Format
(`{"version", "minor_version", "key", "data"}`) und können die Store-Datei direkt
ersetzen:

1. Home Assistant stoppen (Container), damit während des Kopierens nicht
   geschrieben wird.
2. Sicherstellen, dass es eine Sicherung des *aktuellen* Stands gibt:
   ```bash
   cd config/frickeldave_store
   cp frickeldave_store.data "frickeldave_store.data.vor-restore-$(date +%F-%H%M)"
   ```
3. Snapshots ansehen (neueste zuerst) und Produktanzahl prüfen:
   ```bash
   ls -1t backups/*.json
   python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['version'], len(d['data']['products']))" \
     backups/<zeitstempel>-pre-save.json
   ```
   Der Stand muss die erwartete Produktanzahl (> 0) zeigen.
4. Snapshot an die Stelle der Store-Datei kopieren:
   ```bash
   cp backups/<zeitstempel>-pre-save.json frickeldave_store.data
   ```
5. Rechte prüfen (`chown`/`chmod` wie die übrigen Dateien im Ordner).
6. Home Assistant starten und im Panel Produktanzahl sowie ein Stichprobenbild
   kontrollieren. Liegt der Snapshot auf einem älteren Schema, migriert der Store
   beim Laden und legt vorher erneut einen Snapshot an.
7. Ist der Bildordner `images/` ebenfalls beschädigt, den passenden
   `images`-Ordner aus dem HA-Backup daneben entpacken — die JSON-Snapshots
   enthalten nur die Bild-Metadaten, nicht die Bilddateien. Ausnahmen sind die
   Original-Sicherungen nach einer Drehung unter `backups/images/`; sie
   enthalten echte Bilddateien, aber immer nur ein einzelnes Bild je Drehung.

> Hinweis: `pre-save`-Snapshots entstehen vor dem ersten Schreiben nach dem
> Laden. Bei einem Update, das den Katalog leer angezeigt hat, ist genau dieser
> Snapshot der letzte vollständige Stand — solange danach kein weiterer
> Schreibvorgang mit leerem Inhalt erfolgt ist.

### Nach einer Bilddrehung

Eine Drehung lässt sich im Panel nicht rückgängig machen. Die Original-Sicherung
unter `<Datenordner>/backups/images/` enthält die Pixel vor der Drehung und den
ursprünglichen Dateinamen samt Endung:

1. Home Assistant stoppen (Container), damit während des Kopierens nicht
   geschrieben wird.
2. Sicherung suchen und den aktuellen Stand beiseitelegen:
   ```bash
   cd config/frickeldave_store
   ls -1t backups/images/LA0001/*-LA0001-03.jpg
   cp frickeldave_store.data "frickeldave_store.data.vor-restore-$(date +%F-%H%M)"
   cp images/LA0001/LA0001-03.jpg "images/LA0001/LA0001-03.jpg.vor-restore-$(date +%F-%H%M)"
   ```
3. Das Original an seinen alten Platz kopieren. Die Sicherung behält die Endung
   der Bilddatei und stellt den Zeitstempel voran:
   ```bash
   cp backups/images/LA0001/<zeitstempel>-LA0001-03.jpg images/LA0001/LA0001-03.jpg
   ```
4. Optional die Metadaten zurückspielen, etwa wenn Bildliste, Reihenfolge oder
   Hauptbild nicht mehr stimmen:
   ```bash
   cp backups/<zeitstempel>-pre-image-rotate.json frickeldave_store.data
   ```
5. Home Assistant starten und das Bild im Panel prüfen. `bytes`, `width`,
   `height` und `oversized` berechnet die Integration beim Lesen neu.

Die Sicherungen zählen zu `backups_bytes` in `storage.usage` und werden nicht
automatisch gelöscht. Nach erfolgreicher Prüfung lassen sie sich entfernen; für
einen späteren Vergleich ist ein Aufbewahrungsfenster sinnvoll.

### Aus einem Home-Assistant-Backup

1. Home Assistant stoppen (Container).
2. Bestehenden Datenordner beiseitelegen (nicht löschen). Der Pfad ergibt sich
   aus der Option `data_path` (siehe Tabelle oben).
3. Backup entpacken, sodass `frickeldave_store/` wieder an Ort und Stelle liegt.
4. Prüfsummen vergleichen (`sha256sum -c images.sha256`).
5. Home Assistant starten. Ist das gespeicherte Schema älter als die Integration,
   migriert der Store beim Laden und legt vorher einen Snapshot an.
6. Integrationsseite prüfen: **Einstellungen → Geräte & Dienste → Frickeldave
   Store**; Panel öffnen und Produktanzahl sowie ein Stichprobenbild kontrollieren.

Wird der Katalog nach `share`/`media` verschoben und anschließend ein
HA-Backup eingespielt, bleibt der externe Ordner unberührt – er ist nicht Teil
des Backups. Nach einem Restore des Config-Ordners zeigt die Option weiterhin
auf `share`/`media`; der Ordner muss also vorhanden sein, sonst schlägt das Setup
mit einer klaren Meldung fehl.

## Restore-Test (Protokoll)

Ein realer Restore-Test gehört zur Abnahme. Vorgehen:

1. Backup ziehen, `sha256sum` von Store-Datei und allen Bildern notieren.
2. Testinstanz starten, Ordner durch das Backup ersetzen.
3. Nach dem Start Prüfsummen erneut berechnen und vergleichen – sie müssen identisch sein.
4. `schemaVersion` in der Store-Datei und Integrationsversion notieren (Migrationsstand
   erhalten).
5. Ergebnis mit Datum und HA-Version dokumentieren.

> Hinweis: In dieser Ausbaustufe wurde der Restore-Test noch nicht gegen eine produktive
> Instanz durchgeführt. Das Runbook ist vorbereitet; die Durchführung erfolgt mit der
> produktiven Datenmigration.
