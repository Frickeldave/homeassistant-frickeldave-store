# Frickeldave Store

![CI](https://github.com/Frickeldave/homeassistant-frickeldave-store/actions/workflows/ci.yml/badge.svg)

Home-Assistant-Custom-Integration für die Verwaltung des Frickeldave-Handmade-Katalogs:
Produkte, Bilder, Tags, Bestände, Berechtigungen und KI-Beschreibungsvorschläge – alles
in einem deutschen Panel in Home Assistant. Der Katalogexport versorgt die Website.

Veröffentlichen nach `dev`/`prod` und der Katalogimport liegen seit **0.2.0** in der
zweiten Custom Integration
[`Frickeldave/homeassistant-frickeldave-store-syncfd`](https://github.com/Frickeldave/homeassistant-frickeldave-store-syncfd).
Diese Basis ist ohne sie vollständig nutzbar (Produkte, Bilder, Lagerstätten, Export,
Rechte, KI); die Synchronisation ist ein optionales Paket.

Die Integration läuft mit **Home Assistant Container** – ohne Supervisor, Add-on oder
zusätzlichen Anwendungscontainer. Es gibt keine `hassio`- oder Supervisor-Aufrufe.

> Repository-Hinweis: Die Spezifikation in Issue #289 nennt `Frickeldave/frickeldave-store`.
> Am 2026-10-27 wurde das Repository zu `Frickeldave/frickeldave.home.net` umbenannt,
> seit dem 2026-11-03 heißt es **`Frickeldave/homeassistant-frickeldave-store`**.
> Die Domain der Integration bleibt `frickeldave_store`; alle URLs in Manifest,
> HACS-Metadaten und Dokumentation verweisen auf das aktuelle Repository.

## Voraussetzungen

- Home Assistant ab **2024.6** (getestet mit 2025.1)
- HACS (für die Installation als benutzerdefiniertes Repository)
- Ein Home-Assistant-Benutzerkonto für jede Person, die das Panel nutzt

## Installation über HACS

1. HACS öffnen → **Integrationen** → Drei-Punkte-Menü → **Benutzerdefinierte Repositories**.
2. Repository `https://github.com/Frickeldave/homeassistant-frickeldave-store` eintragen,
   Kategorie **Integration** wählen.
3. „Frickeldave Store“ installieren.
4. Home Assistant neu starten.

**Installationsreihenfolge mit Synchronisation:** immer zuerst diese Basis, danach
`Frickeldave/homeassistant-frickeldave-store-syncfd` als zweites benutzerdefiniertes
Repository (ebenfalls Kategorie **Integration**). HACS löst keine Abhängigkeiten
zwischen Custom-Integrationen auf; die Erweiterung verweigert den Start, wenn die Basis
fehlt oder älter als Contract 1 ist. Erst nach der Registrierung erscheinen im Panel die
Schaltflächen „Nach dev/prod veröffentlichen“ und „Katalog importieren“.

Manuelle Installation ohne HACS: Ordner `custom_components/frickeldave_store/` nach
`config/custom_components/` kopieren und Home Assistant neu starten.

## Einrichtung

**Einstellungen → Geräte & Dienste → Integration hinzufügen → „Frickeldave Store“.**

Im Einrichtungsdialog werden die ersten freigegebenen Benutzer eingetragen – eine Zeile
pro Home-Assistant-Benutzer-ID:

```
<ha_user_id>: product,app_admin
<ha_user_id>: product
```

Die stabile HA-Benutzer-ID findet man in Home Assistant unter **Einstellungen → Personen
→ Person → Erweiterte Einstellungen** (bzw. in `.storage/auth`). Ohne Eintrag gilt
**Default Deny**: Die Person sieht das Panel, erhält aber auf allen Datenrouten `403`.

### Optionen

| Option | Bedeutung |
| --- | --- |
| `users` | Freigaben im Format `<ha_user_id>: role,role` |
| `data_path` | Datenordner: `config` (Standard, im Backup), `share` oder `media` (vom Backup ausgeschlossen) |
| `ai_endpoint` | Vollständige URL der Chat-Completions-API (Standard: DeepSeek) |
| `ai_model` | Modellname, Standard `deepseek-flash` (akzeptiert Bilder) |
| `ai_api_key` | Zugangsschlüssel; wird nie zurückgegeben, geloggt oder exportiert |
| `ai_prompt` | Prompt, Standard „Generiere mir eine schöne Beschreibung des Artikels für meinen Handmade-Shop.“ |
| `export_path` | Exportverzeichnis relativ zu `config/` (Standard `frickeldave_store/export`) |
| `stock_locations` | Lagerstätten, eine pro Zeile (Standard: `Lager` und `Verkaufsschrank`); Zeile 1 → `stock`, Zeile 2 → `salesCabinet` im Website-Export |

Repository, Branches, Workflow und GitHub-Token sind **keine** Optionen dieser Integration
mehr; sie werden im Options-Flow der Erweiterung gepflegt (siehe
[docs/migration-0.2.md](docs/migration-0.2.md)).

YAML-Konfiguration wird nicht unterstützt (`config_entry_only_config_schema`).

### Benutzerverwaltung

Das Zahnrad am Eintrag **Einstellungen → Geräte & Dienste → Frickeldave Store** öffnet
das tabbed Konfigurationspanel (`/frickeldave-store-config?config_entry=<id>`) mit den
Tabs **Allgemeine Einstellungen**, **Benutzerverwaltung**, **Lagerstätten** und
**KI-Einstellungen**. Dort lassen sich Freigaben bequem
über echte HA-Benutzernamen anlegen, bearbeiten und löschen; die Rollenauswahl nutzt die
Labels `Produktpflege`, `Finanzen` und `Anwendungsverwaltung`.

- **Hinzufügen:** In der Benutzerverwaltung eine noch nicht freigegebene aktive
  HA-Person wählen und mindestens eine Rolle vergeben.
- **Bearbeiten:** Rollen einer bestehenden Freigabe ändern. Unbekannte Benutzer-IDs
  (z. B. nach dem Löschen eines HA-Kontos) bleiben als Eintrag ohne Namen sichtbar und
  können weiter bearbeitet oder entfernt werden.
- **Löschen:** Freigabe entziehen; der Zugriff endet mit der nächsten Anfrage.
- **Schutz:** Die letzte Freigabe mit der Rolle `app_admin` kann weder gelöscht noch
  herabgestuft werden (`409 conflict`).

Der Options-Flow bleibt als Rückfallebene erhalten. Die Option `users` bleibt die einzige
Quelle der Wahrheit: Die Oberfläche schreibt Änderungen dorthin und wendet sie sofort an,
sodass ein Rechteentzug ohne Neustart greift.

## Rollen und Rechte

| Rolle | Umfang |
| --- | --- |
| `product` | Produkte, Bilder, Tags, Bestände, Sichtbarkeit, Archivierung, KI-Vorschläge |
| `finance` | spätere Finanzfunktionen (in dieser Ausbaustufe keine Endpunkte) |
| `app_admin` | Einstellungen, Export, Benutzerfreigaben; Veröffentlichen/Import nur, wenn die Erweiterung die Fähigkeit mit dieser Rolle registriert |

Rollen sind kombinierbar. Finanzrechte folgen **nie** implizit aus `product` oder
`app_admin`. Jede geschützte HTTP- und WebSocket-Route prüft serverseitig pro Anfrage;
ein Rechteentzug greift beim nächsten Zugriff, auch bei geöffnetem Panel.
Details: [docs/permissions.md](docs/permissions.md).

## Bedienung

Nach der Einrichtung erscheint **Frickeldave Store** mit dem Icon `mdi:store-cog` in der
Seitenleiste. Beide Panels werden als `panel_custom`-Web-Components ohne iframe geladen:
das Seitenleisten-Panel (`.../frickeldave-store-panel.js`) für die Katalogarbeit und das
Konfigurationspanel (`.../frickeldave-store-config-panel.js`, `require_admin`) am Zahnrad
des Integrationseintrags. Einstellungen liegen damit nicht mehr im Drei-Punkte-Menü des
Seitenleisten-Panels. Die JavaScript-Dateien liegen unter
`custom_components/frickeldave_store/frontend/` und werden vom Frontend-Team gepflegt;
fehlt eine Datei, bleiben Integration und API vollständig funktionsfähig.

Der Bilder-Tab im Produktdialog zeigt je Bild Maße und Dateigröße, warnt vor zu
großen Bildern und fasst sie über „Bilder optimieren“ zusammen. Produkte mit
mindestens einem zu großen Bild tragen in Liste und Kachel ein Warndreieck, das
den Dialog direkt im Bilder-Tab öffnet. Jede Bildkarte trägt zusätzlich die
Schaltflächen **↺ 90°** (nach links, gegen den Uhrzeigersinn) und **↻ 90°** (nach
rechts, im Uhrzeigersinn); die Vorschau aktualisiert sich sofort, ohne die Seite
neu zu laden. Die Schaltflächen stehen im Bearbeitungsmodus bereit, beim Anlegen
noch nicht, und sind bei animierten GIF- und WebP-Dateien deaktiviert.

## Daten, Speicherort und Backup

Der Datenordner ist über `data_path` wählbar: `config` (Standard),
`share` oder `media`. Freie Pfade werden abgelehnt; fehlt der Mount, schlägt
die Auswahl mit einer klaren Meldung fehl.

| Inhalt | Pfad bei `data_path = config` |
| --- | --- |
| Metadaten (JSON) | `config/frickeldave_store/frickeldave_store.data` |
| Bilder | `config/frickeldave_store/images/<artikelnummer>/<artikelnummer>-NN.jpg` |
| Snapshots vor Migration | `config/frickeldave_store/backups/` |
| Original-Sicherungen gedrehter Bilder | `config/frickeldave_store/backups/images/<artikelnummer>/` |
| Export (konfigurierbar) | `config/frickeldave_store/export/public/data/handmade.json` und `src/assets/handmade/` |

Bei `share` bzw. `media` liegt derselbe Aufbau unter
`/share/frickeldave_store/` bzw. `/media/frickeldave_store/`.

**Backup:** Ein HA-Backup mit „Home Assistant settings“ archiviert das gesamte
Config-Verzeichnis und damit `config/frickeldave_store` automatisch. Eine Ausnahme
für einzelne Unterordner ist in HA nicht möglich. Wer den Katalog nicht im
HA-Backup haben will, wählt `share` oder `media` und sichert den Ordner selbst
(Docker: Volume für `/share` bzw. `/media` einbinden). Der Exportpfad ist davon
unabhängig und kann ebenfalls außerhalb von `config` liegen.

Im Konfigurationspanel (Tab **Allgemeine Einstellungen**) zeigt ein Schalter den
aus `data_path` abgeleiteten Backup-Status und erlaubt den Wechsel des
Speicherorts; nach einem Wechsel verlangt die Integration ein Neuladen.

Beim Wechsel werden Store-Datei, Bilder und Snapshots kopiert; der alte Ordner
bleibt als Sicherheitskopie erhalten. Ist der Zielordner bereits belegt, bricht
der Wechsel mit `409 conflict` ab. Schreibvorgänge sind atomar (temporäre Datei +
`os.replace`), Datei-I/O läuft im Executor.
Details: [docs/backup-restore.md](docs/backup-restore.md).

## Lagerstätten und Bestände

Bestände werden **je Lagerstätte** geführt. Standard sind `Lager` und
`Verkaufsschrank`; damit bleibt das bisherige Verhalten unverändert. Die Administration
pflegt die Liste an zwei Stellen, die dieselbe Quelle nutzen:

- **Konfigurationspanel** (Zahnrad am Integrationseintrag, `PATCH /settings`)
- **Options-Flow** (Einstellungen → Geräte & Dienste → Frickeldave Store → Konfigurieren),
  eine Zeile pro Lagerstätte

Regeln: mindestens eine Lagerstätte, eindeutige Namen, keine leeren Namen, maximal 40
Zeichen und 20 Einträge. **Umbenennen erhält den Bestand** (die interne ID bleibt
stabil). Das **Löschen** einer Lagerstätte mit Bestand wird mit `409 conflict`
abgelehnt und nennt Produkte und Stückzahl; erst umbuchen, dann löschen.

Buchungen (`POST /products/{article_number}/stock`) tragen `locationId`; eine
Umlagerung zusätzlich `targetLocationId`. Ohne Angabe gilt die erste Lagerstätte als
Quelle und die zweite als Ziel. `GET /locations` liefert `id`, `name`, `position`,
`stock_total` und `products_with_stock` für alle mit der Rolle `product`.

Beim Laden migriert die Integration Bestände der Schema-Version 1 verlustfrei:
`stock` → erste Lagerstätte, `salesCabinet` → zweite. Vorher wird ein Snapshot unter
`backups/pre-load-v1-*.json` abgelegt.

## Katalogexport

Der Export ist idempotent, enthält ausschließlich nicht archivierte Produkte und schreibt
das Schema von `public/data/handmade.json`. Weil die Website nur zwei Zahlen kennt,
bildet der Export die **erste** Lagerstätte auf `stock` und die **zweite** auf
`salesCabinet` ab; ohne zweite Lagerstätte bleibt `salesCabinet` bei `0`. Diese
Abbildung ist unabhängig von den Namen und bleibt stabil, solange die Reihenfolge bleibt.
Artikelnummer bleibt der Schlüssel; Bilder werden als
`src/assets/handmade/<kategorie>/<artikelnummer>/<artikelnummer>-NN.jpg` abgelegt, das
Hauptbild zuerst.

CLI (ohne laufendes Home Assistant):

```bash
python -m custom_components.frickeldave_store.export \
  config/frickeldave_store/frickeldave_store.data ./export
```

## Veröffentlichen und Katalogimport (Erweiterung)

Beide Fähigkeiten sind seit **0.2.0** ausgelagert:

| Fähigkeit | Endpunkt | Anbieter |
| --- | --- | --- |
| `publish` | `POST /api/frickeldave_store/features/publish` | `frickeldave_store_syncfd` |
| `import` | `POST /api/frickeldave_store/features/import` | `frickeldave_store_syncfd` |

Die Basis validiert nichts mehr selbst: Sie authentifiziert, prüft die Rolle und leitet
den Aufruf an den Handler der Erweiterung weiter. Payload, Antwortformat und die
fachlichen Regeln (Dry-Run, `allow_empty`, `confirm_removals`, `overwrite`, die
SSRF-Allowlist für `source_url`/`image_base_url` sowie der Löschschutz) sind unverändert
und in der Erweiterung dokumentiert.

Ohne installierte Erweiterung melden `GET /me` und `GET /settings`:

```json
{
  "features": {
    "publish": {
      "available": false,
      "reason": "Die Synchronisation ist nicht installiert. Installiere Frickeldave Store Sync über HACS.",
      "provider": "",
      "contract_version": 1
    },
    "import": {
      "available": false,
      "reason": "Die Synchronisation ist nicht installiert. Installiere Frickeldave Store Sync über HACS.",
      "provider": "",
      "contract_version": 1
    }
  }
}
```

`POST /features/publish` und `POST /features/import` antworten dann mit
`409 feature_unavailable` und derselben deutschen Meldung; unbekannte Namen mit
`404 feature_unknown`. Sobald die Erweiterung registriert ist, kommen `available: true`
und `provider: frickeldave_store_syncfd` aus der Registrierung. Das Panel gated die
Schaltflächen über `features.*.available`: fehlt die Fähigkeit ganz, erscheint kein Icon;
ist sie vorhanden, aber nicht verfügbar, bleibt das Icon ausgegraut (`aria-disabled`) und
nennt die Begründung beim Fokus beziehungsweise Klick.

Der öffentliche Erweiterungsvertrag (Contract 1) steht in
[docs/extension-api.md](docs/extension-api.md); der Umstieg von 0.1.x ist in
[docs/migration-0.2.md](docs/migration-0.2.md) beschrieben.

## KI-Beschreibungen

Der Vorschlag wird **nie automatisch gespeichert**. Es werden nur Produktdaten und
Produktbilder übertragen; Bilder werden vorher von EXIF/GPS und Textmetadaten befreit.
Kunden-, Finanz- und personenbezogene Daten sind ausgeschlossen. Fehler, Timeouts und
Nutzungslimits werden als lesbare Meldung angezeigt.

`POST /products/{article_number}/description/suggest` akzeptiert optional
`{"instructions": "..."}` (max. 2000 Zeichen); der Text wird als zusätzlicher Abschnitt
an den konfigurierten Basis-Prompt gehängt. Ohne das Feld bleibt das Verhalten
unverändert. Die Antwort enthält neben `suggestion` die Tag-Vorschläge:

```json
{
  "suggestion": "…",
  "tags": ["Holz"],
  "rejected_tags": ["Rakete"],
  "available_tags": ["Deko", "Holz"],
  "instructions_used": true
}
```

Serverseitig werden ausschließlich **vorhandene** Tags durchgelassen (Vergleich ohne
Groß-/Kleinschreibung, Ausgabe in der gespeicherten Schreibweise). Neue Tags legt nur der
Nutzer über `POST /tags` an; verworfene Vorschläge stehen in `rejected_tags`, damit die
Oberfläche auf „Neue Tags musst du selbst anlegen“ hinweisen kann.

## API

Alle Routen liegen unter `/api/frickeldave_store` und benötigen eine HA-Anmeldung.
Fehlerformat: `{"error": {"code": "...", "message": "..."}}`.

| Methode | Pfad |
| --- | --- |
| GET | `/me` |
| GET, POST | `/products` |
| GET | `/products/article-number` (`product`; Vorschlag, nicht reserviert) |
| GET, PATCH | `/products/{article_number}` |
| POST | `/products/{article_number}/archive` |
| GET, POST | `/products/{article_number}/images` |
| GET, DELETE | `/products/{article_number}/images/{name}` |
| POST | `/products/{article_number}/images/{name}/rotate` (`product`; Bild um 90° drehen) |
| POST | `/products/{article_number}/images/order` |
| POST | `/products/{article_number}/images/main` |
| POST | `/products/{article_number}/images/optimize` (`product`; Bestandsbilder verkleinern) |
| GET, POST | `/products/{article_number}/stock` |
| POST | `/products/{article_number}/description/suggest` |
| GET, POST | `/tags` |
| DELETE | `/tags/{name}` |
| GET | `/users` (nur `app_admin`) |
| PUT, DELETE | `/users/{user_id}` (nur `app_admin`) |
| GET, PATCH | `/settings` (nur `app_admin`) |
| GET | `/locations` (`product`) |
| POST | `/export` (nur `app_admin`) |
| POST | `/features/{feature}` (Fähigkeit einer Erweiterung; `publish`/`import` nur mit Erweiterung) |

`GET /me` und `GET /settings` liefern zusätzlich `features` (Verfügbarkeit je Fähigkeit
mit `available`, `reason`, `provider`, `contract_version`); `/settings` enthält für
`app_admin` außerdem `feature_details` mit Titel, benötigter Rolle und
`provides_panel_routes`. Die Erweiterung `frickeldave_store_syncfd` bedient
`POST /features/publish` und `/features/import`. Der öffentliche Erweiterungsvertrag
(Contract 1) ist in [`docs/extension-api.md`](docs/extension-api.md) beschrieben.

Filter für `GET /products`: `search`, `category` (Komma = ODER), `tags` (Komma = ODER),
`customizable`, `in_stock`/`in_cabinet` (erste/zweite Lagerstätte), `location` +
`in_location` (beliebige Lagerstätte), `visibility=visible|invisible`, `archived`,
`sort=name|price|category|stock|status|size`, `order=asc|desc`, `limit`, `offset`.

Sortierung: `category` ordnet nach dem sichtbaren Kategorie-Label, `stock` nach dem
Gesamtbestand über alle Lagerstätten (unabhängig von `location`/`in_location`),
`status` nach aktiv vor archiviert und sichtbar vor unsichtbar, `size` nach der Summe
der Bilddateien (Bytes). Sortiert wird vor `limit`/`offset`; `total` zählt alle
gefilterten Produkte. Bei Gleichstand gilt Name, dann Artikelnummer – auch bei
`order=desc`, das nur das Hauptkriterium dreht.

`GET /products/article-number?category=LA` liefert
`{"articleNumber": "LAH3K3", "category": "LA", "reserved": false}` für den
Anlegen-Dialog (Recht `product`). Der Vorschlag wird nicht reserviert; beim Anlegen
erzeugt `POST /products` die Nummer erneut und gibt die tatsächliche zurück.

`GET /settings` liefert neben `ai`, `users`, `export_path` und `locations` den Abschnitt
`storage` mit `data_path`, `effective_path`, `backup_included`, `exclude_from_backup`,
`paths` (Metadaten, Bilder, Snapshots), `choices` und `usage` (`total_bytes`,
`data_bytes`, `images_bytes`, `backups_bytes`, `files`; Symlinks werden nicht
verfolgt). `GET /settings` enthält außerdem `images` mit der Bildgrenze
(`{"max_bytes": 512000}`). `PATCH /settings` akzeptiert `{"ai": {...}}`,
`{"images": {"max_bytes": 51200..10485760}}`,
`{"locations": [{"id"?: "...", "name": "..."}]}` und
`{"storage": {"data_path": "config|share|media"}}`; ein mitgeschicktes `publish` gilt als
unbekanntes Feld (`400`), die gespeicherten Werte bleiben aber erhalten. Nach einer
erfolgreichen Migration enthält die Antwort
`"reload_required": true`. Ungültige Werte oder unbekannte Felder → `400`, ein
belegtes Ziel oder eine Lagerstätte mit Bestand → `409`.

`GET /users` liefert `users` (Freigaben mit `user_id`, `name`, `roles`, `role_labels`),
`available_users` (aktive, noch nicht freigegebene HA-Benutzer – nur ID und Name) sowie
`roles` (ID und Label). `PUT /users/{user_id}` erwartet `{"roles": ["product", ...]}`,
`DELETE /users/{user_id}` entfernt die Freigabe; beide antworten mit derselben Struktur
wie `GET /users`. Unbekannte Rollen, leere Rollenlisten und das Entfernen der letzten
`app_admin`-Freigabe werden abgelehnt (`400` bzw. `409`).

## Bilder: Upload, Verkleinerung und Metadaten

`POST /products/{article_number}/images` (multipart, Feld `file`) nimmt JPEG, PNG,
WebP und GIF bis 10 MB an und **verkleinert automatisch**:

| Ausgangsbild | Ergebnis |
| --- | --- |
| Lange Kante > 1600 px | auf 1600 px verkleinert (nie hochskaliert) |
| JPEG | neu als JPEG, Qualität 82, progressiv, ohne EXIF/GPS/Kommentare |
| PNG/WebP **mit** Transparenz | WebP, Qualität 85, Alpha bleibt erhalten |
| PNG/WebP **ohne** Transparenz | JPEG, Qualität 82 |
| GIF (auch animiert) und animiertes WebP | unverändert durchgereicht |
| Bereits passend (≤ 1600 px **und** ≤ 500 KiB, konfigurierbar) | byteweise übernommen, kein Re-Encoding |

Die Dateiendung folgt dem Ergebnis: aus `LA0001-03.png` mit Transparenz wird
`LA0001-03.webp`. Defekte Dateien werden mit `400 image_invalid` und deutscher
Meldung abgelehnt; fehlt Pillow, antwortet die Route mit `pillow_missing`.

Die Antwort enthält zusätzlich zu `images`:

```json
{
  "original": {"bytes": 12582912, "width": 4032, "height": 3024, "content_type": "image/jpeg"},
  "stored": {"bytes": 285000, "width": 1600, "height": 1200, "content_type": "image/jpeg"},
  "resized": true,
  "optimize_message": "Bild von 12,0 MB auf 278 KB verkleinert (4032×3024 → 1600×1200)."
}
```

`GET /products/{article_number}/images`, die Produktliste und das Produktdetail
liefern je Bild `bytes`, `width`, `height`, `content_type`, `oversized`,
`mtime_ns` und `animated`. `oversized` ist `true`, wenn die lange Kante >
1600 px **oder** die Datei größer als `settings.images.max_bytes` ist (Standard
500 KiB); `animated` ist `true` bei animiertem GIF oder WebP. Die Werte werden
beim Lesen aus den Dateien ermittelt und nicht im Store gespeichert.

`POST /products/{article_number}/images/optimize` verkleinert alle zu großen
Bilder eines Produkts nach denselben Regeln, behält Reihenfolge und Hauptbild und
ist idempotent (zweiter Aufruf: `resized: false`). Vor dem ersten Überschreiben
entsteht ein Snapshot der Metadaten (`backups/*-pre-image-optimize.json`).

```json
{
  "results": [
    {"name": "LA0001-01.webp", "previous_name": "LA0001-01.png",
     "before": {"bytes": 2400000, "width": 3000, "height": 2000, "content_type": "image/png"},
     "after": {"bytes": 210000, "width": 1600, "height": 1067, "content_type": "image/webp"},
     "resized": true, "message": "Bild von 2,3 MB auf 205 KB verkleinert (3000×2000 → 1600×1067).",
     "error": null}
  ],
  "summary": {"count": 1, "bytes_before": 2400000, "bytes_after": 210000, "saved_percent": 91.2},
  "images": [{"name": "LA0001-01.webp", "width": 1600, "height": 1067, "bytes": 210000,
              "content_type": "image/webp", "oversized": false}]
}
```

Fehler einzelner Bilder brechen den Lauf nicht ab; sie erscheinen mit `error`
und `resized: false`, die übrigen Bilder werden weiter verarbeitet.

### Drehen um 90°

`POST /products/{article_number}/images/{name}/rotate` erwartet
`{"direction": "left"}` (nach links, gegen den Uhrzeigersinn) oder
`{"direction": "right"}` (nach rechts, im Uhrzeigersinn). Vor dem Überschreiben
entsteht eine pixelgenaue Original-Sicherung der Bilddatei unter
`backups/images/<artikelnummer>/<zeitstempel>-<dateiname>`; zusätzlich legt der
Store den Metadaten-Snapshot `backups/*-pre-image-rotate.json` an.

Die Antwort führt unter `images` die aktualisierte Bildliste und unter `result`
den Zustand vor und nach der Drehung:

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

Formate: JPEG bleibt JPEG (Qualität 82, progressiv), WebP bleibt WebP (Qualität
85, Alpha erhalten), PNG bleibt verlustfrei mit Alpha, ein statisches GIF bleibt
GIF; EXIF- und ICC-Daten fallen in allen Formaten weg. Die EXIF-Orientierung
wird vor dem Drehen angewendet. Animierte GIF- und WebP-Dateien lehnt die Route
mit `409 image_animated` ab und lässt sie unverändert. Bilder aus dem Altbestand
über 1600 px werden auf die lange Kante 1600 px verkleinert (nie hochskaliert);
`oversized` wird neu berechnet.

Nach einer Drehung sind JPEG und WebP nicht mehr byteidentisch zum Ausgangsbild.
PNG bleibt pixelidentisch, die mittlere Abweichung je Farbkanal liegt bei
höchstens 2 von 255.

Fehler: `400 validation_error` (ungültige Richtung oder ungültiger Bildname),
`404 not_found` (Produkt oder Bild fehlt), `409 image_animated`,
`400 image_invalid`, `500 pillow_missing`, `500 image_write_failed`,
`401 not_authenticated`, `403 forbidden`.

WebSocket-Kommandos: `frickeldave_store/me`, `frickeldave_store/products`,
`frickeldave_store/subscribe`.

## Entwicklung

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install ruff mypy pytest homeassistant pytest-homeassistant-custom-component aiohttp
ruff check .
ruff format --check .
mypy custom_components
pytest -q
python -m json.tool custom_components/frickeldave_store/manifest.json

# Panel-Frontend (Lit-Bundle)
npm ci
npm run build:frontend
node --check custom_components/frickeldave_store/frontend/frickeldave-store-panel.js
node --check custom_components/frickeldave_store/frontend/lit.js
```

`custom_components/frickeldave_store/frontend/lit.js` ist ein vendored Build von
Lit 3.3.3. Home Assistant liefert keine Import-Map für den Spezifizierer `lit`,
deshalb importiert das Panel `./lit.js`; das Bundle wird nie von Hand bearbeitet.
Details: [frontend/README.md](custom_components/frickeldave_store/frontend/README.md).

Dokumentation: [Architektur](docs/architecture.md), [Datenmodell](docs/data-model.md),
[Berechtigungen](docs/permissions.md), [Backup & Restore](docs/backup-restore.md),
[Migration auf 0.2.0](docs/migration-0.2.md), [Erweiterungs-API](docs/extension-api.md).

## Roadmap / ausdrückliche Nicht-Ziele dieser Ausbaustufe

Nicht enthalten und bewusst auf später verschoben:

- PayPal-Synchronisation (Artikel und Kunden)
- vollständige Kundenverwaltung (CRUD, Rechnungs-/Lieferadresse)
- Website-Publish-Workflow oder PR-Automation in dieser Basis (liegt in der Erweiterung)
- Aufnahme in den offiziellen HACS-Katalog
- Finanzfunktionen (Einkaufskosten, Margen, Steuerrücklagen)

## Lizenz

[MIT](LICENSE) – Copyright (c) 2026 David Koenig
