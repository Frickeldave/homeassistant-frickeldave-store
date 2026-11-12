# Datenmodell

## Store-Payload (Schema-Version 1)

Datei: `config/frickeldave_store/frickeldave_store.data`
Schlüssel im HA-`Store`: `frickeldave_store.data`, Version `1`, Minor-Version `1`.

```json
{
  "schemaVersion": 1,
  "products": [],
  "tags": [],
  "bookings": [],
  "settings": {
    "ai": {
      "endpoint": "https://api.deepseek.com/chat/completions",
      "model": "deepseek-flash",
      "prompt": "Generiere mir eine schöne Beschreibung ...",
      "api_key": ""
    }
  },
  "updatedAt": "2026-10-27T12:00:00Z"
}
```

Der API-Key liegt ausschließlich serverseitig im Store. Er wird nie über die API
zurückgegeben (`api_key_set: true` genügt), nie geloggt und nie exportiert.

## Produkt

| Feld | Typ | Regel |
| --- | --- | --- |
| `articleNumber` | string | 6 Zeichen, Kategoriepräfix + 4 Zufallszeichen, Primärschlüssel, unveränderlich |
| `name` | string | Pflicht, max. 200 Zeichen |
| `description` | string | optional, max. 20 000 Zeichen |
| `category` | string | `3D`, `EP`, `LA`, `SB`, `WO`; nach dem Anlegen unveränderlich |
| `price` | number | EUR, ≥ 0, zwei Nachkommastellen |
| `size` | string | optional, max. 200 Zeichen |
| `tags` | string[] | frei wählbar, case-insensitiv dedupliziert |
| `customizable` | bool | Standard `true` |
| `visible` | bool | Standard `true` |
| `stock` | int | Lagerbestand, ≥ 0 |
| `salesCabinet` | int | Verkaufsschrank, ≥ 0 |
| `images` | object[] | max. 10, geordnet, genau ein Hauptbild |
| `archived` | bool | Soft-Delete |
| `createdAt`, `updatedAt` | string | ISO-8601 mit `Z` |
| `schemaVersion` | int | derzeit `1` |

Kategoriebedeutung: `3D` 3D-Druck, `EP` Epoxidharz, `LA` Laser, `SB` Steinmasse, `WO` Holz.

### Bilder

```json
{"name": "LAH3K3-01.jpg", "is_main": true}
```

Datei: `config/frickeldave_store/images/<artikelnummer>/<artikelnummer>-NN.jpg`
(`NN` zweistellig, aufsteigend). Erlaubte Uploads: JPEG, PNG, WebP, GIF, max. 10 MB.
Ein elfter Upload wird mit Code `image_limit` und Status `409` abgelehnt; es entsteht
keine Teilpersistenz (Datei wird erst nach der Prüfung geschrieben).

Die API liefert je Bild die Metadaten aus `ImageInfo`: `bytes`, `width`, `height`,
`content_type`, `oversized`, `mtime_ns` (Änderungszeit in Nanosekunden; bricht den
Metadaten-Cache und dient dem Panel als Versionsparameter im Bild-URL) und `animated`
(`true` bei animiertem GIF oder WebP). Die Werte werden beim Lesen aus der Datei
ermittelt und nicht im Store gespeichert.

#### Drehen

`POST /products/{article_number}/images/{name}/rotate` mit
`{"direction": "left" | "right"}` schreibt die Bilddatei neu und erweitert die Antwort
um `result`:

```json
{
  "result": {
    "name": "LA0001-01.jpg",
    "direction": "left",
    "degrees": -90,
    "before": {"bytes": 285000, "width": 1600, "height": 1200,
               "content_type": "image/jpeg", "oversized": false},
    "after": {"bytes": 279000, "width": 1200, "height": 1600,
              "content_type": "image/jpeg", "oversized": false},
    "message": "Bild um 90° gegen den Uhrzeigersinn gedreht (1600×1200 → 1200×1600)."
  }
}
```

Vor dem Schreiben kopiert der Store die Originaldatei nach
`backups/images/<artikelnummer>/<zeitstempel>-<dateiname>` und legt den
Metadaten-Snapshot `backups/<zeitstempel>-pre-image-rotate.json` an. Beide gehören zum
Datenordner und zählen zu `storage.usage.backups_bytes`. Dateiname und Position in der
Bildliste bleiben unverändert; nur `bytes`, `width`, `height`, `mtime_ns` und
`oversized` ändern sich.

### Bestandsbuchung

| Feld | Bedeutung |
| --- | --- |
| `id` | zufällige Kennung |
| `articleNumber` | betroffenes Produkt |
| `type` | `in` (Zugang), `out` (Abgang), `transfer` (Umlagerung Lager → Schrank), `correction` (Korrektur auf Zielwert) |
| `quantity` | Menge, > 0 |
| `note` | optionaler Text |
| `at` | Zeitstempel |
| `ha_user_id` | auslösender HA-Benutzer (stabile ID) |

Formeln: `in` → `stock += quantity`; `out` → `stock = max(0, stock - quantity)`;
`transfer` → `moved = min(quantity, stock)`, `stock -= moved`, `salesCabinet += moved`;
`correction` → `stock = quantity`.

Einzelstück = Produkt mit Menge 1. Personalisierbare Produkte werden durch Verkäufe
nicht automatisch abgebucht.

## Katalogimport

`POST /api/frickeldave_store/features/import` (Erweiterung
`frickeldave_store_syncfd`) übernimmt den Live-Katalog der Website
(`https://frickeldave.de/data/handmade.json`) und die zugehörigen Bilder in den Store.
Die Basis stellt dafür nur den generischen Batch-Pfad
`StoreFacade.async_apply_import_batch` (`batch_import.py`) bereit; Netzzugriff,
Quellen-Allowlist und Rollenprüfung liegen bei der Erweiterung.

Ohne `overwrite` ist der Import eine reine Anlege-Operation: bestehende Produkte bleiben
unverändert. Es gibt keinen Hard-Delete-Pfad.

Optionen (beide Standard `false`):

| Feld | Wirkung |
| --- | --- |
| `dry_run` | lädt und prüft den Katalog, schreibt aber nichts (kein Store-Schreibzugriff, keine Bilddatei, kein Snapshot, kein `updatedAt`) und liefert die Vorschau |
| `overwrite` | überschreibt vorhandene, nicht archivierte Produkte mit dem Katalogstand |

### Feldabbildung

| Katalogfeld | Zielfeld | Regel |
| --- | --- | --- |
| `articleNumber` | `articleNumber` | Primärschlüssel, Großbuchstaben; 1–12 Zeichen `A-Z0-9` |
| `category` | `category` | muss `3D`, `EP`, `LA`, `SB` oder `WO` sein |
| `name` | `name` | Pflicht, max. 200 Zeichen |
| `description` | `description` | optional, max. 20 000 Zeichen |
| `price` | `price` | Zahl ≥ 0, zwei Nachkommastellen |
| `size` | `size` | optional, max. 200 Zeichen |
| `tags` | `tags` | Liste, case-insensitiv dedupliziert, zusätzlich in die Store-Tag-Liste |
| `visible`, `customizable` | dito | boolesch, Standard `true` |
| `stock`, `salesCabinet` | dito | ganze Zahl ≥ 0 |
| – | `archived` | immer `false` (archivierte Produkte werden nie reaktiviert) |
| – | `schemaVersion` | aktuelle Schema-Version |
| – | `createdAt`, `updatedAt` | Zeitstempel des Imports (ISO-8601, `Z`) |

### Überschreiben (`overwrite: true`)

| Feld | Quelle beim Überschreiben |
| --- | --- |
| `articleNumber` | lokal (stabil, kein Wechsel) |
| `createdAt` | lokal (bleibt erhalten) |
| `name`, `description`, `price`, `size`, `tags`, `visible`, `customizable`, `stock` | Katalog |
| `category` | lokal – unveränderlich, weil die Artikelnummer sie kodiert |
| `images` | lokal; nur fehlende Bilder werden ergänzt, nie gelöscht |
| `archived` | lokal; archivierte Produkte werden übersprungen und nicht reaktiviert |
| Buchungen (`bookings`) | bleiben erhalten (separater Speicher) |
| `updatedAt` | Zeitpunkt des Überschreibens |

Panel und Import erzeugen sechsstellige Artikelnummern (Kategoriepräfix + 4 Zeichen). Der
Import akzeptiert zusätzlich kurze Altbestandsnummern wie `LAX`, damit der gewachsene
Katalog vollständig übernommen wird; neu angelegte Produkte bleiben sechsstellig.

### Idempotenz und Zähler

| Zähler | Bedeutung |
| --- | --- |
| `created` | neu angelegte Produkte |
| `overwritten` | tatsächlich überschriebene Produkte (nur mit `overwrite`) |
| `skipped` | Artikelnummer existiert bereits (Produkt bleibt unverändert, inkl. archivierter) |
| `failed` | ungültiges Produkt oder doppelte Artikelnummer im Dokument |
| `images_imported` | in diesem Lauf geschriebene Bilddateien (im Dry-Run: würde geschrieben) |
| `products_total` | Anzahl der Produkte im gelieferten Dokument |
| `errors` | Liste aus `{"articleNumber", "message"}` |
| `dry_run` | ob es sich um eine Vorschau handelte |
| `would_create` | nur Dry-Run: Produkte, die angelegt würden |
| `would_overwrite` | nur Dry-Run: Produkte, die überschrieben würden (Inhalt weicht ab) |
| `unchanged` | nur Dry-Run: vorhandene Produkte, die unverändert blieben |
| `summary` | deutsche Zusammenfassung des Laufs |

Ein zweiter Lauf über dasselbe Dokument liefert `created=0` und `skipped=<products_total>`.
Mit `overwrite` zählt ein inhaltsgleiches Produkt als `skipped`; nur abweichende
Katalogstände erhöhen `overwritten`.
Doppelte Artikelnummern innerhalb eines Dokuments werden nur beim ersten Vorkommen
angelegt; alle weiteren zählen als `failed`. Produktfehler sind nicht fatal – nur ein
nicht lesbares oder strukturell ungültiges Dokument (`catalog_invalid`, HTTP 422) oder ein
nicht erreichbarer Katalog (`catalog_unavailable`, HTTP 502) lehnt die Anfrage ab; in
diesem Fall wird der Store überhaupt nicht verändert.

### Bilder

`<image_base_url>/<kategorie>/<artikelnummer>/<artikelnummer>-NN.jpg` mit `NN` = 01…10.
Alle zehn Indizes werden geprüft, je Index zuerst `.jpg`, dann `.jpeg`; fehlt ein Index in
beiden Endungen (HTTP 404), wird der nächste probiert. Dadurch bleiben Lücken erhalten
(im aktuellen Bestand `LAKBCD` mit 01, 03, 05, 08 – alle vier werden übernommen).
Höchstens zehn Bilder pro Produkt, das erste gefundene Bild ist das Hauptbild. Dateien landen unter
`config/frickeldave_store/images/<artikelnummer>/` – identisch zu Panel-Uploads, damit
Export und Panel dieselben Bilder nutzen. Bildfehler (HTTP ≠ 200, Timeout, leerer
Inhalt, fehlende Bildsignatur) werden als `errors`-Eintrag gemeldet, brechen den
Produktimport aber nicht ab. Abrufe laufen mit höchstens fünf gleichzeitigen Anfragen und
30 s Zeitlimit je Anfrage.

Der Import prüft die Dateisignatur (JPEG, PNG, WebP, GIF) statt des Content-Type, weil
GitHub große Binärdateien als `application/octet-stream` ausliefert, und akzeptiert bis
25 MB pro Bild (der Altbestand enthält eine ~12-MB-Datei); Panel-Uploads bleiben bei
10 MB. Pro Produkt fallen damit höchstens 20 Bildanfragen an (zehn Indizes mal zwei
Endungen), was für den einmaligen Import unkritisch ist.

## Tags

Tags liegen zusätzlich als sortierte Liste im Store (`tags`). Das Löschen eines Tags
entfernt es aus allen Produkten und aktualisiert deren `updatedAt`.

## Filter- und Sortierregeln

- `category` – Komma-Liste, **ODER**-Verknüpfung
- `tags` – Komma-Liste, **ODER**-Verknüpfung (case-insensitiv); ein Produkt genügt
  einem der gewählten Tags
- `search` – Teilstring über Name, Beschreibung, Artikelnummer und Tags
- `customizable`, `in_stock` (`stock > 0`), `in_cabinet` (`salesCabinet > 0`),
  `visibility`, `archived` – jeweils **UND**
- Standard: archivierte Produkte werden ausgeblendet (`archived=false`)
- Sortierung `name` oder `price`, `order=asc|desc`, Sekundärschlüssel Artikelnummer
  (deterministisch und stabil)

## Migration und Snapshots

- `SCHEMA_VERSION` in `models.py` = 1, `config_flow.VERSION` = 1, `MINOR_VERSION` = 1.
- Vor einer Migration kopiert der Store die bestehende Datei nach
  `config/frickeldave_store/backups/<zeitstempel>-pre-*.json`.
- `migrate_payload()` ist idempotent; ein höheres gespeichertes Schema wird mit
  `schema_too_new` abgelehnt.
- `async_migrate_entry` sichert zusätzlich die Store-Datei vor der Entry-Migration.
