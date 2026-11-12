# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier festgehalten.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [SemVer](https://semver.org/lang/de/).

## [Unreleased]

### Added

- **Bilder im Panel drehen (#322).** Jedes Produktbild lässt sich um 90° nach
  links (gegen den Uhrzeigersinn) oder rechts (im Uhrzeigersinn) drehen –
  `POST /api/frickeldave_store/products/{article_number}/images/{name}/rotate`
  mit `{"direction": "left" | "right"}`. Die Drehung ist destruktiv: Vor dem
  Überschreiben wird die Originaldatei byteweise unter `backups/images/`
  gesichert und ein Snapshot `pre-image-rotate` der Metadaten angelegt. Format
  und Dateiendung bleiben erhalten (JPEG, PNG, WebP, statisches GIF); die
  EXIF-Ausrichtung wird zuerst angewendet, übergroße Altbestände werden auf
  1600 px verkleinert. Animierte GIF- und WebP-Dateien werden mit
  `image_animated` (409) abgelehnt, die Datei bleibt unverändert. Die
  Bildliste liefert zusätzlich `mtime_ns` und `animated`. PNG und statisches
  GIF bleiben verlustfrei; JPEG/WebP werden neu kodiert (dokumentierte
  Toleranz nach zwei Drehungen: mittlere Abweichung ≤ 2/255 je Farbkanal).
- **Bildgrenze konfigurierbar (#289).** `settings.images.max_bytes` legt fest,
  ab welcher Dateigröße ein Bild als „zu groß“ gilt (Standard 500 KiB, erlaubt
  sind 50 KiB bis 10 MiB). `GET /api/frickeldave_store/settings` liefert den
  Wert unter `images`, `PATCH` nimmt ihn entgegen; die lange Kante bleibt bei
  1600 px.
- **Belegter Speicher in der API (#289).** `GET /api/frickeldave_store/settings`
  liefert unter `storage.usage` die Größen von Store-Datei, Bildern, Snapshots
  und dem gesamten Datenordner (`total_bytes`, `data_bytes`, `images_bytes`,
  `backups_bytes`, `files`) – ohne Symlinks zu folgen.
- **Produktliste nach Bildgröße sortierbar (#289).** `GET /api/frickeldave_store/products`
  akzeptiert `sort=size` und ordnet nach der Summe aller Bilddateien eines
  Produkts (`order=asc|desc`); sortiert wird vor `limit`/`offset`, `total`
  zählt weiterhin alle gefilterten Produkte.

### Changed

- **Bildgröße wird mit „Einstellungen speichern“ gesichert (#289).** Der separate
  Button „Bildgröße speichern“ entfällt. Speicherort und Maximalgröße für Bilder
  teilen sich ein Formular, ein „Einstellungen speichern“ und ein „Änderung
  verwerfen“; die API erhält nur die tatsächlich geänderten Abschnitte.
- **Standard-Bildgrenze von 400 KiB auf 500 KiB angehoben (#289).** Bilder bis
  500 KiB werden unverändert übernommen; die Grenze ist über die Einstellungen
  anpassbar.
- **Veröffentlichungsdialog aufgeräumt (#289).** Der doppelte Zusammenfassungs-
  absatz und der Dry-Run-Untertitel in der Titelleiste entfallen; die
  Metadatenboxen (Ziel, Zielbranch, Repository) haben mehr Abstand zur
  Titelleiste. Die Übersichten „Produkte“ und „Bilder“ sind kompakter
  und zeigen ihre Gesamtzahl rechts neben der Überschrift. Über der Dateiliste
  filtern Schaltflächen (Alle, Neu, Geändert, Entfernt, Unverändert) mit Anzahl
  die Änderungen; ohne Treffer erscheint ein Hinweis.
- **Redundante „Dateien“-Übersicht entfernt (#289).** Die Zählung der Dateien
  wiederholte nur den Katalog (`handmade.json`) und die verwalteten Bilder. Der
  Veröffentlichungsdialog zeigt deshalb nur noch „Produkte“ und „Bilder“ sowie
  die filterbare Dateiliste; diese Informationen beschreiben die Änderung
  vollständig.

### Fixed

- **Panel verbindet wieder: `fetchWithAuth` bekommt einen relativen Pfad (#289).**
  Seit 0.2.6 übergab das Panel `hass.fetchWithAuth` eine absolute URL. Home
  Assistant stellt die Instanz-URL selbst voran, sodass eine ungültige URL wie
  `https://ha…https://ha…/api/…` entstand, `fetch` abbrach und nur noch
  „Verbindung zum Server fehlgeschlagen“ zu sehen war. `fetchWithAuth` erhält
  jetzt den relativen Pfad; die absolute URL bleibt dem rohen `fetch`-Fallback
  vorbehalten.
- **Abgelaufene Sitzung liefert `401` statt `403` (#289).** Fehlte `hass_user` an
  einer Anfrage (abgelaufenes oder fehlendes HA-Token), antwortete die API mit
  `403 forbidden` und die Oberfläche meldete irreführend, der Home-Assistant-
  Benutzer sei „für diese Verwaltung nicht freigegeben“. Jetzt antwortet sie mit
  `401 not_authenticated` und der Meldung „Die Sitzung ist abgelaufen. Bitte die
  Seite neu laden.“; fehlende Rollen bleiben unverändert `403 forbidden`.
- **Versionskonstante folgt wieder dem Release (#289).** `VERSION` in `const.py`
  war fest auf 0.2.0 verdrahtet, während das Release 0.2.1 nur Manifest und
  `pyproject.toml` anhob. Dadurch zeigte der Panel-Footer weiterhin 0.2.0 und die
  Modul-URL des Panels (`?v=…`) blieb zwischen den Releases gleich, sodass
  Browser das alte ES-Modul aus dem Cache verwenden konnten. `VERSION` steht
  jetzt auf 0.2.2; ein Test wacht darüber, dass Konstante, Manifest und
  `pyproject.toml` übereinstimmen. Die `REPOSITORY_URL` zeigt auf das umbenannte
  Repository `Frickeldave/homeassistant-frickeldave-store`.
- **Panel blendet nicht installierte Fähigkeiten aus (#289).** Solange keine
  Erweiterung registriert ist (`provider: ""`), zeigt die Kopfleiste die
  Schaltflächen „Nach dev veröffentlichen“, „Nach prod veröffentlichen“ und
  „Katalog importieren“ gar nicht mehr an, statt sie nur deaktiviert
  darzustellen. Ist eine Erweiterung registriert, aber nicht bereit (z. B.
  fehlender Token), bleiben die Schaltflächen sichtbar, deaktiviert und nennen
  den Grund.

## [0.2.0] - 2026-11-02

**Breaking Release.** Die frickeldave-Synchronisation ist jetzt eine eigene
HACS-Integration (`Frickeldave/frickeldave-store-syncfd`, Contract 1). Die Basis
enthält keine frickeldave-spezifischen Vorgaben mehr.

### Breaking Changes

- **Veröffentlichen und Katalogimport entfernt (#289).** `publish.py` und
  `importer.py` sind gelöscht; ebenso die Endpunkte `POST /publish` (404) und
  `POST /import/catalog` (404). Beide Fähigkeiten kommen ausschließlich aus einer
  registrierten Erweiterung: `POST /api/frickeldave_store/features/publish` bzw.
  `.../features/import`. Ohne Erweiterung antworten sie mit `409
  feature_unavailable` und deutscher Meldung.
- **Konstanten entfernt (#289).** `DEFAULT_PUBLISH_REPOSITORY`,
  `DEFAULT_PUBLISH_DEV_BRANCH`, `DEFAULT_PUBLISH_PROD_BRANCH`,
  `DEFAULT_PUBLISH_PROD_WORKFLOW`, `DEFAULT_CATALOG_URL`, `DEFAULT_IMAGE_BASE_URL`
  und `IMPORT_ALLOWED_HOSTS` existieren nicht mehr. Die SSRF-Allowlist führt die
  Erweiterung.
- **Options-Flow ohne `github_*` (#289).** `github_repository`, `github_dev_branch`,
  `github_prod_workflow` und `github_token` sind keine Optionen der Basis mehr.
  `PATCH /settings` lehnt `publish` als unbekanntes Feld ab (`400`);
  `GET /settings` liefert kein `publish` mehr (auch kein `token_set`).
- **Feature-Status ohne Erweiterung (#289).** `features.publish` und
  `features.import` melden `available: false`, `provider: ""` und
  `reason: "Die Synchronisation ist nicht installiert. Installiere Frickeldave Store Sync über HACS."`
- **Generischer Import-Batch bleibt (#289).** `StoreFacade.async_apply_import_batch`
  schreibt unverändert über das neue Modul `batch_import.py` (Import-Ergebnis,
  Snapshot und Feldregeln identisch). Contract 1 bleibt bei `CONTRACT_VERSION = 1`.

### Migration

1. Basis `0.2.0` installieren.
2. `Frickeldave/homeassistant-frickeldave-store-syncfd` über HACS als zweites
   benutzerdefiniertes Repository (Kategorie Integration) installieren und
   einrichten.
3. Dort einen neuen Fine-grained Token (`Contents: write`, `Actions: write`)
   hinterlegen und den alten Token widerrufen. Der Token wird bewusst **nicht**
   automatisch übernommen.

Gespeicherte `settings.publish`-Daten bleiben in `frickeldave_store.data` erhalten,
werden ab 0.2.0 aber weder gelesen noch ausgeliefert – der Rückfallweg auf 0.1.x
funktioniert damit ohne Datenverlust. Details:
[docs/migration-0.2.md](docs/migration-0.2.md).

### Added

- `docs/migration-0.2.md` (Migrationsleitfaden 0.1.x → 0.2.0) (#289).

### Changed

- README, `docs/architecture.md`, `docs/permissions.md` und
  `docs/extension-api.md` beschreiben die neue Rollen- und Modulaufteilung (#289).
- Konfigurationspanel: der Tab „Veröffentlichen“ entfällt; ein Hinweisbanner nennt
  weiterhin, wo Token und Ziel-Repository gepflegt werden (#289).
- Seitenpanel: der Rückfall „ältere Basis ohne Feature-Angabe“ ist entfernt
  (#289).

## [0.1.17] - 2026-11-02

### Changed

- **Panel nutzt die generischen Feature-Routen (#289).** Publish und Import
  senden jetzt an `POST /api/frickeldave_store/features/publish` bzw.
  `.../features/import`. Die alten Pfade `/publish` und `/import/catalog`
  verschwinden in 0.2.0 und werden nicht mehr verwendet; Payload, Antwort und
  Normalisierung bleiben unverändert.
- **Sichtbarkeit folgt dem Feature-Status (#289).** Die Topbar-Icons für
  „Nach dev/prod veröffentlichen“ und „Katalog importieren“ erscheinen nur,
  wenn die jeweilige Fähigkeit vorhanden ist. Ist sie vorhanden, aber nicht
  verfügbar, bleibt das Icon dezent ausgegraut (`aria-disabled`, kein
  `disabled`) und nennt die deutsche Begründung über `aria-describedby`; ein
  Klick auf den fokussierbaren Button zeigt sie als Statusmeldung. Eine ältere
  Basis ohne Feature-Angabe behält das bisherige Verhalten.
- **Einstellungen-Tab „Veröffentlichen“ folgt dem Anbieter (#289).** Beim
  eingebauten Fallback (`provider: frickeldave_store`) bleibt der Tab
  unverändert. Meldet die Erweiterung `frickeldave_store_syncfd`, wird der Tab
  ausgeblendet und ein Hinweis verweist auf Einstellungen → Geräte & Dienste →
  Frickeldave Store Sync; dort wird das Token gepflegt, nie mehr im Basis-Panel.
  Fehlt die Fähigkeit ganz, erscheint der Hinweis, dass die Synchronisation
  nicht installiert ist.
- **Live-Aktualisierung über `frickeldave_store_features_changed` (#289).**
  Seiten- und Konfigurationspanel abonnieren das Event über
  `hass.connection.subscribeEvents`, entprellen es und laden nur `/me`
  (Seitenpanel) bzw. `/settings` (Konfigurationspanel) neu. Produktliste,
  Filter und offene Dialoge bleiben unangetastet; nicht mehr verfügbare
  Publish-/Import-Dialoge werden beendet. Die Subscription wird beim
  Disconnect abgemeldet.
- **Fehlerfälle der Feature-Routen (#289).** `feature_unavailable` (409) und
  `not_registered` (404) zeigen die deutsche `error.message`;
  `feature_unknown` erklärt, dass die Basis die Fähigkeit nicht kennt und die
  Erweiterung vermutlich veraltet ist. Der Token-Hinweis nennt bei der
  Erweiterung den Weg über Geräte & Dienste.

## [0.1.16] - 2026-11-02

### Added

- **Erweiterungsvertrag `custom_components.frickeldave_store.extension` (#289).**
  Contract 1: `ExtensionRegistration`, `FeatureSpec`, `FeatureStatus`,
  `StoreFacade`, `async_register_extension`, `async_unregister_extension` und
  `async_get_feature_status`. Eine zweite Custom Integration
  (`frickeldave_store_sync`) kann Fähigkeiten beisteuern, ohne interne
  Store-Objekte zu kennen. Die Fassade bietet Produkte inkl. Bildmetadaten,
  Lagerstätten, Artikelnummern, Rechteprüfung, Snapshot, Export im
  Website-Schema und einen validierten Import-Batch.
- **Feature-Status in `GET /me` und `/settings`.** Neues Feld `features` mit
  `available`, `reason`, `provider` und `contract_version` je Fähigkeit
  (eingebaut: `publish`, `import`). Bestehende Felder bleiben unverändert.
- **`POST /api/frickeldave_store/features/{feature}`.** Generischer,
  authentifizierter Einstiegspunkt für Erweiterungs-Fähigkeiten. Ohne
  registrierte Erweiterung bedient die Basis `publish` und `import` mit dem
  bisherigen Verhalten (Fallback), damit 0.1.16 vollständig rückwärtskompatibel
  bleibt.
- **Event `frickeldave_store_features_changed`** nach Registrierung und
  Abmeldung einer Erweiterung; ein offenes Panel kann seinen Feature-Status neu
  laden. Registrierung nach dem Panel-Setup ist unkritisch.
- **`docs/extension-api.md`** beschreibt Zweck, Stabilitätszusage,
  Beispielregistrierung, Fassade, Fehlercodes und die Manifest-Abhängigkeit.

### Changed

- `const.VERSION` folgt wieder Manifest und `pyproject.toml` (0.1.16).

## [0.1.15] - 2026-11-02

### Fixed

- **Veröffentlichung löschte 3D-Modellquellen (#289).** `_is_managed_path`
  betrachtete jede Datei unterhalb von `src/assets/handmade` als verwaltetes
  Produktbild. Der Katalog kennt `3dmodels/includes/*.scad` und
  `3dmodels/models/*.scad` nicht, deshalb committete die Veröffentlichung sie
  als entfernt (Vorfall `d13cb2f` im Website-Repository). Verwaltet sind jetzt
  ausschließlich `public/data/handmade.json` und Bilder im Muster
  `src/assets/handmade/<Kategorie>/<Artikelnummer>/<Artikelnummer>-NN.<Endung>`
  mit einer der fünf Kategorien. Fremde Pfade – `3dmodels/**`, `.gitkeep`,
  Unterordner ohne Artikelmuster – werden nie als entfernt gemeldet und damit
  nie gelöscht.
- **Stabile Bilddateinamen beim Veröffentlichen (#289).** Das Hauptbild heißt
  weiterhin `<Artikelnummer>-01`; alle übrigen Bilder behalten ihre eigene
  Nummer aus dem Store, solange sie frei ist. Bisher wurde rein nach Position
  durchnummeriert, sodass das Löschen eines Bildes alle folgenden Namen
  verschob (z. B. `LAKBCD-08.jpg` → `LAKBCD-04.jpg` bei gleichzeitigem Löschen
  von `LAKBCD-05.jpg`). Namen bleiben nun über Veröffentlichungen hinweg gleich,
  solange dasselbe Bild im Produkt bleibt.

### Added

- **Löschschutz `publish_removal_guard` (#289).** Eine Veröffentlichung bricht
  mit `409 publish_removals_blocked` und deutscher Meldung ab, wenn sie mehr als
  10 Bilder oder mehr als ein Drittel des bestehenden Bildbestands entfernen
  würde (mindestens 3 Löschungen, damit gezielte Einzelfälle nie blockieren).
  Im Dry-Run erscheint dieselbe Meldung als Warnung. Übergehen lässt sich der
  Schutz nur mit `"confirm_removals": true` (`POST /publish`, `app_admin`); die
  Bestätigung gilt je Lauf und wird nicht gespeichert. Die Antwort enthält
  zusätzlich `removal_guard` (`triggered`, `removed`, `existing`, `maxFiles`,
  `share`, `confirmed`). Das Panel zeigt dafür ein eigenes Bestätigungsfeld.

## [0.1.14] - 2026-11-02

### Added

- **Automatische Bildverkleinerung beim Upload (#289).** `POST
  /api/frickeldave_store/products/{artikelnummer}/images` skaliert auf maximal
  1600 px lange Kante (nie hoch), schreibt JPEG mit Qualität 82 progressiv und
  ohne EXIF/GPS, wandelt PNG/WebP mit Transparenz in WebP (Qualität 85) und
  PNG/WebP ohne Transparenz in JPEG. GIF und animiertes WebP bleiben
  unverändert; Bilder, die bereits ≤ 1600 px und ≤ 400 KiB sind, werden
  byteweise übernommen. Die Dateiendung folgt dem Ergebnis (`…-03.webp`).
  Defekte Bilder werden mit `400 image_invalid` abgelehnt.
- **Upload-Antwort mit Vorher/Nachher-Werten (#289).** Zusätzlich zu `images`
  liefert die Route `original`, `stored` (je `bytes`, `width`, `height`,
  `content_type`), `resized` und `optimize_message`.
- **Größenmetadaten je Bild (#289).** `GET /products/{artikelnummer}/images`,
  die Produktliste (HTTP und WebSocket) und das Produktdetail liefern je Bild
  `bytes`, `width`, `height`, `content_type` und `oversized` (lange Kante
  > 1600 px oder > 400 KiB). Die Werte werden beim Lesen aus den Dateien
  ermittelt, nicht persistiert und prozesslokal gecacht (Pfad + `mtime` +
  Größe, LRU mit 4096 Einträgen).
- **Sammel-Optimierung (#289).** `POST
  /api/frickeldave_store/products/{artikelnummer}/images/optimize` (Recht
  `product`) verkleinert alle zu großen Bilder eines Produkts, behält
  Reihenfolge und Hauptbild, antwortet je Bild mit `name`, `previous_name`,
  `before`, `after`, `resized`, `message`, `error` und liefert eine
  Gesamtstatistik (`count`, `bytes_before`, `bytes_after`, `saved_percent`).
  Der Lauf ist idempotent, Fehler einzelner Bilder brechen ihn nicht ab, und
  vor dem ersten Überschreiben entsteht ein Snapshot
  (`backups/*-pre-image-optimize.json`).
- **Upload-Rückmeldung im Bilder-Tab (#289).** Nach jedem Upload zeigt das
  Panel die Verkleinerung als Liste (`optimize_message`, deutsch formatiert wie
  „Bild von 12,0 MB auf 278 KB verkleinert (4032×3024 → 1600×1200).“). Bei
  `resized: false` erscheint eine ruhige Bestätigung, dass das Bild bereits
  passte; der angezeigte Dateiname stammt immer aus `images[].name`, auch wenn
  der Upload die Endung wechselt (`.webp`).
- **Bildgrößen und Warnungen im Bilder-Tab (#289).** Jede Bildkarte zeigt Maße
  und Dateigröße („1600 × 1200 · 278 KB“). Zu große Bilder erhalten ein
  Warnzeichen mit `title`/`aria-label`; über der Liste nennt ein Warnbanner
  Anzahl und beide Schwellwerte (max. 1600 px lange Kante und 400 KB).
- **Sammel-Optimierung aus dem Panel (#289).** Der Button „Bilder optimieren“
  ruft den Optimize-Endpunkt auf, zeigt einen Busy-Zustand, danach das Ergebnis
  je Bild samt Teilfehlern und die Ersparnis aus `summary` („3 Bilder optimiert,
  4,2 MB gespart (78 %).“). Die Liste wird mit den neuen `images` neu
  gerendert; ein zweiter Lauf meldet „Nichts zu tun – alle Bilder passen
  bereits.“
- **Warnzeichen in Produktliste und Kacheln (#289).** Produkte mit mindestens
  einem zu großen Bild tragen ein Warndreieck mit `title` und `aria-label`
  („Mindestens ein Bild ist zu groß. Produkt öffnen und Bilder optimieren.“),
  in der Kachel am Bild, in der Liste in der Statusspalte. Ein Klick öffnet den
  Produktdialog direkt im Bilder-Tab.
- **Tab „Allgemeine Einstellungen“ (#289).** Das Konfigurationspanel bekommt
  einen zusätzlichen Tab mit Backup-Schalter (abgeleitet aus
  `storage.data_path`), Speicherort-Auswahl aus `storage.choices[]` sowie
  schreibgeschützten Pfaden (`effective_path`, `paths[]`). Gespeichert wird über
  `PATCH /settings`; bei `reload_required` weist das Panel deutlich auf das
  Neuladen der Integration hin, bei `409`/`400` erscheint die deutsche
  Servermeldung und die Auswahl springt auf den gespeicherten Speicherort
  zurück.

### Changed

- **Pillow bleibt Core-Abhängigkeit (#289).** Die Integration importiert
  Pillow erst bei Bedarf und trägt es deshalb nicht in `manifest.json` ein;
  fehlt es, scheitert der Upload mit `pillow_missing` und einer deutschen
  Meldung statt mit einem Fehler beim Setup.

### Notes

- **Allgemeine Einstellungen (#289).** `GET/PATCH /settings` lieferte mit
  `storage.backup_included`, `storage.exclude_from_backup`, `storage.choices`
  (deutsche Labels und Beschreibungen) sowie `storage.data_path` bereits alles,
  was der Tab „Allgemeine Einstellungen“ braucht – am Backend war kein neuer
  Mechanismus nötig, die Oberfläche nutzt diese Felder jetzt.

## [0.1.13] - 2026-11-02

### Added

- **Sperre gegen versehentliches Leeren des Website-Katalogs (#289).**
  Enthält der lokale Store keine veröffentlichbaren Produkte (auch: nur noch
  archivierte), verweigert `POST /api/frickeldave_store/publish` die
  Veröffentlichung mit `409 publish_empty_catalog` und einer deutschen Meldung.
  Ein Dry-Run liefert weiterhin eine vollständige Vorschau, setzt aber das neue
  Feld `warning` (string|null) und ergänzt die `summary` um einen Hinweis. Der
  Notausgang ist das Body-Feld `allow_empty` (bool, Standard `false`): nur
  `app_admin` kann die Sperre bewusst umgehen; auch dann bleibt `warning`
  gesetzt. Ohne `allow_empty` wird kein Commit erzeugt – der Website-Katalog
  bleibt unangetastet.
- **Strukturierte Antwort statt nacktem 500 beim Veröffentlichen (#289).**
  `PublishView` fängt unerwartete Exceptions, loggt den vollständigen Traceback
  mit `_LOGGER.exception` und antwortet mit `500 internal_error` und einer
  deutschen Meldung, die auf das Home-Assistant-Protokoll verweist. Dasselbe gilt
  für den Katalogimport.

### Changed

- **Publish-Dialog zeigt `warning` (#289).** `normalizePublishResult` übernimmt
  das neue Feld `warning` (`string|null` → `""`). Der Hinweis erscheint im
  Dry-Run als Warnblock mit Symbol und Text oberhalb der Bestätigung und nach
  einem erfolgreichen Lauf zusätzlich im Ergebnis und im Toast.
- **Leerer Katalog im Panel (#289).** Antwortet der Server mit
  `409 publish_empty_catalog`, erklärt der Dialog, dass eine Veröffentlichung
  den Website-Katalog leeren würde. `allow_empty: true` wird erst gesendet,
  nachdem die Checkbox „Ich verstehe, dass der Website-Katalog geleert wird“
  gesetzt und „Trotzdem veröffentlichen“ bestätigt wurde. Ohne Häkchen bleibt
  der Button gesperrt; nach Abbruch, Fehler oder erneutem Dry-Run steht der
  Wert wieder auf `false`.
- **Neue Serverfehler im Panel (#289).** `publish_artifacts_unavailable` und
  `internal_error` zeigen die deutsche `message` direkt; bei `internal_error`
  zusätzlich der Hinweis auf das Home-Assistant-Protokoll (Filter
  `frickeldave_store`).
- **Dry-Run-Anzeige wieder durchgängig nutzbar (#289).** Lade-, Fehler- und
  Ergebniszustand folgen der Serverantwort; `busy` sperrt Aktions- und
  Schließen-Buttons während einer laufenden Anfrage. Statuswechsel werden über
  `aria-live` angekündigt, die Bestätigung ist ein 48 px hohes Touch-Ziel.

### Fixed

- **Veröffentlichen scheiterte an chunked GitHub-Antworten (#289).**
  `GitHubClient._async_json` verwarf den Body, sobald
  `response.content_length` leer war (`not None` ist `True`). GitHub liefert
  REST-Antworten regelmäßig mit `Transfer-Encoding: chunked` und ohne
  `Content-Length`; der Body wurde damit weggeworfen und `_async_json` gab
  `None` zurück. Schon der erste Leseaufruf (`GET git/ref/heads/dev`) endete in
  `AttributeError: 'NoneType' object has no attribute 'get'` → unbehandelter
  500, im Panel sichtbar als „Der Server hat einen Fehler gemeldet.“ Das betraf
  **jeden** Lesevorgang, also auch den Dry-Run, seit der Einführung der
  GitHub-Daten-API. Jetzt wird der Body immer gelesen (`response.read()`);
  `None` gibt es nur bei echten Null-Body-Status (204, 205, 304). Ungültiges
  JSON wird zu `502 github_unavailable`. Alle Stellen, die ein Objekt erwarten
  (Branch, Commit, Baum, Blob), prüfen den Typ und melden einen fachlichen
  Fehler statt `AttributeError`.
- **Nicht-JSON-Antworten von GitHub führen zu `github_unavailable` (#289).**
  Eine HTML- oder Proxy-Antwort (GitHub-Störung, Cloudflare-Seite) warf
  `json.JSONDecodeError` und schlug als unbehandelter 500 durch. Jetzt wird sie
  als `502 github_unavailable` mit deutscher Meldung zurückgegeben; 5xx von
  GitHub ebenfalls.
- **Fehlende oder unlesbare Bilddateien werden gemeldet (#289).**
  `build_artifacts` übersprang solche Bilder stillschweigend, `read_bytes()`
  konnte dagegen mit `PermissionError`/`OSError` als 500 durchschlagen. Jetzt
  sammelt der Aufbau die betroffenen Dateien und antwortet mit
  `409 publish_artifacts_unavailable` (Artikelnummer und Datei in der Meldung).
  Dasselbe gilt für einen Änderungseintrag ohne Artefakt in `async_commit`
  (vorher `KeyError`).

## [0.1.12] - 2026-11-02

### Added

- **Weitere Sortierschlüssel für die Produktliste (#289).** `sort` kennt neben
  `name` und `price` jetzt `category` (nach sichtbarem Kategorie-Label, nicht nach
  Rohcode), `stock` (Gesamtbestand über alle Lagerstätten, unabhängig vom
  Lagerstätten-Filter) und `status` (aktiv vor archiviert, sichtbar vor unsichtbar).
  Innerhalb gleicher Werte gilt Name, dann Artikelnummer. `order=desc` dreht nur das
  Hauptkriterium; der Tiebreaker bleibt aufsteigend und damit deterministisch.
  HTTP- und WebSocket-API akzeptieren dieselben Werte.
- **Katalogimport mit Vorschau und wählbarem Überschreiben (#289).**
  `POST /api/frickeldave_store/import/catalog` kennt zwei neue optionale
  Body-Felder, beide Standard `false`. `dry_run: true` lädt und prüft den Katalog,
  schreibt aber nichts – kein Store-Schreibzugriff, keine Bilddatei, kein Snapshot,
  kein `updatedAt` – und liefert die vollständige Vorschau mit `dry_run`,
  `would_create`, `would_overwrite`, `unchanged`, `failed`, `images_imported`,
  `errors` und einer deutschen `summary`. `overwrite: true` überschreibt vorhandene,
  nicht archivierte Produkte mit dem Katalogstand und zählt sie getrennt als
  `overwritten`: übernommen werden Name, Beschreibung, Preis, Größe, Tags,
  Sichtbarkeit, Personalisierbarkeit und Bestände; Artikelnummer, `createdAt`,
  Bilder, Buchungen, Archiv-Status und Kategorie bleiben lokal. Bilder werden nur
  ergänzt, nie gelöscht; archivierte Produkte werden nicht reaktiviert, sondern als
  `skipped` gemeldet. Ohne die neuen Felder bleibt die Antwort abwärtskompatibel
  (neue Zähler sind dann `0`). Nicht-boolesche Werte für `dry_run`/`overwrite`
  lehnt der Endpunkt mit einer deutschen `validation_error` ab; `overwrite` bleibt
  bei der Rolle `product`, weil es ein Sammel-Update auf ohnehin änderbare Daten ist
  und der Store vor dem ersten Schreiben einen Snapshot anlegt.
- **Artikelnummer-Vorschlag für den Anlegen-Dialog (#289).**
  `GET /api/frickeldave_store/products/article-number?category=LA` liefert
  `{"articleNumber", "category", "reserved": false}` (Recht `product`). Die Nummer
  entsteht nach derselben Regel wie beim Speichern und wird gegen alle vorhandenen
  Artikelnummern geprüft, auch gegen archivierte. Sie wird bewusst **nicht**
  reserviert: maßgeblich bleibt `POST /products`, dessen Antwort die tatsächlich
  vergebene Nummer enthält.
- **Sortierbare Spaltenköpfe in der Produktliste (#289).** In der Listenansicht
  sind `Produkt`, `Kategorie`, `Preis`, `Bestand` und `Status` jetzt echte Buttons
  in den Spaltenköpfen. Der erste Klick sortiert die neue Spalte aufsteigend, ein
  weiterer Klick dreht die Richtung. Die aktive Spalte trägt
  `aria-sort="ascending|descending"`, die übrigen `aria-sort="none"`; jeder Kopf
  hat ein `aria-label` mit Spaltenname und aktueller Richtung und ist per Tastatur
  erreichbar. `Aktionen` bleibt unsortierbar. Sortierfeld und -richtung bleiben im
  Zustand `_sort`/`_order`; ein Wechsel setzt den Seitenoffset zurück. Die
  Sortierauswahl in der Filterleiste bietet jetzt dieselben fünf Felder und bleibt
  mit den Spaltenköpfen synchron.
- **Produktdialog mit eigenem Beschreibungs-Tab (#289).** Die Tabs lauten jetzt
  `Grunddaten → Bilder → Beschreibung → Bestand`. Beschreibungsfeld, eigene
  KI-Hinweise, der Button „Beschreibung vorschlagen“ samt Vorschlagsansicht und
  Tag-Übernahme liegen im Tab `Beschreibung`; `Grunddaten` enthält weiterhin Name,
  Kategorie, Preis, Größe, Tags, Sichtbarkeit und Personalisierbarkeit.
- **Schrittweises Anlegen mit „Weiter“ (#289).** Beim Anlegen heißt der
  Footer-Button auf `Grunddaten`, `Bilder` und `Beschreibung` „Weiter“ und wechselt
  zum nächsten Tab; auf `Bestand` heißt er „Speichern“ und schließt den Dialog.
  „Weiter“ auf `Grunddaten` legt das Produkt per `POST /products` an und wechselt in
  den Bearbeiten-Modus (Überschrift „Produkt bearbeiten“). Auf den Folgetabs
  speichert „Weiter“ die Änderungen und wechselt weiter. Validierungsfehler halten
  den Tabwechsel auf und wechseln zu dem Tab, in dem das fehlerhafte Feld liegt.
  Nach dem Anlegen weist ein Hinweis im Footer darauf hin, dass das Produkt bereits
  gespeichert ist und „Schließen“ nur den Dialog beendet. Im Bearbeiten-Modus bleibt
  es bei einem einzigen „Speichern“ auf allen Tabs.
- **Artikelnummer als Badge im Dialogkopf (#289).** Die Nummer steht links neben
  der Überschrift in einem Badge aus HA-Design-Tokens (kein Rohfarbwert). Im
  Anlege-Modus wird sie beim Öffnen und bei jeder Kategorieänderung über
  `GET /products/article-number` geholt; während des Ladens zeigt das Badge „…“,
  bei einem Fehler „—“ mit der Ursache im `title`. Nach dem Anlegen zeigt das Badge
  immer die `articleNumber` aus der Server-Antwort. Der bisherige Untertitel
  „Artikelnummer …“ entfällt.
- **Katalogimport-Dialog mit automatischer Vorschau (#289).** Beim Öffnen läuft
  automatisch ein Dry-Run (`{"dry_run": true}`) und zeigt `would_create`,
  `would_overwrite`, `unchanged`, `failed`, `images_imported` und die `summary`.
  Die neue Checkbox „Bestehende Produkte überschreiben“ ist standardmäßig aus;
  solange sie aus ist, bleiben vorhandene Produkte unverändert. Bei aktiver
  Checkbox erscheint ein Warnbanner mit den überschriebenen und den erhaltenen
  Feldern, und die Vorschau wird mit `{"dry_run": true, "overwrite": true}` neu
  geladen. Der Bestätigungs-Button führt den echten Import aus und zeigt danach
  `created`, `overwritten`, `skipped`, `failed`, `images_imported` und die
  Fehlerliste je Artikelnummer. Fehler der API erscheinen als deutsche Meldung im
  offenen Dialog; während Vorschau und Import sind Mehrfachklicks gesperrt.

### Changed

- **Einheitliches Symbol für beide Veröffentlichungs-Aktionen (#289).** „Nach dev
  veröffentlichen“ und „Nach prod veröffentlichen“ nutzen in der App-Bar jetzt
  dasselbe Branch-Symbol; die Rakete ist entfallen. Damit die beiden Buttons
  unterscheidbar bleiben, trägt jeder ein kleines Kürzel in der unteren rechten
  Ecke („dev“ bzw. „prd“). Das Kürzel ist rein visuell (`aria-hidden`), die
  Unterscheidung für Screenreader läuft weiter über `aria-label` und `title`.

## [0.1.11] - 2026-11-02

### Fixed

- **Datenverlust beim Update behoben (#289).** Nach dem Einspielen einer neuen
  Version waren alle Produkte verschwunden. Ursache: `HassStoreBackend` las die
  Store-Datei über `homeassistant.helpers.storage.Store`. Dessen interner
  `_StoreManager` cached beim HA-Start die Dateiliste von `<config>/.storage` und
  beantwortet jeden Schlüssel, der dort nicht liegt, mit „existiert nicht“
  (`async_fetch` → `(False, None)`). Der Katalog liegt aber in
  `<config>/frickeldave_store/frickeldave_store.data`; `Store.async_load()`
  lieferte deshalb `None`, der Store startete leer und der nächste `async_save`
  überschrieb die echte Datei mit `"products": []`. Da HACS-Updates einen
  HA-Neustart auslösen, trat der Fehler bei jedem Update auf.
- **Eigenes Datei-Backend (#289).** `HassStoreBackend` liest und schreibt die
  Datei jetzt selbst (atomar, gleiches HA-Umschlagformat
  `{"version", "minor_version", "key", "data"}`). Bestehende Dateien, Snapshots
  und ältere Integrationen bleiben kompatibel; `STORAGE_VERSION` bleibt deshalb
  bei `2`.
- **Payload-Schema statt Envelope-Version (#289).** Maßgeblich für die Migration
  ist `data.schemaVersion`. Weicht die Envelope-Version ab (z. B. Store-Version 1
  bei bereits migriertem Payload), wird das protokolliert und nicht erneut
  migriert.
- **Kein stilles Verwerfen von Produkten (#289).** `coerce_payload` überspringt
  keine Produkte mehr: nicht lesbare Einträge führen zu
  `StoreError("products_unreadable")`, der Ladevorgang bricht ab und die
  Store-Datei bleibt unverändert.

### Added

- **Sicherheitsnetz gegen leere Overwrites (#289).** Enthielt die Store-Datei
  Produkte, schreibt `CatalogStore.async_save` niemals einen Stand mit null
  Produkten — außer der Aufrufer bestätigt es ausdrücklich (`allow_empty=True`).
  Im Zweifel bricht das Schreiben mit `refuse_empty_overwrite` ab und die Datei
  bleibt unangetastet.
- **Snapshot vor jedem Schreiben (#289).** Vor Schema-Migrationen entsteht
  weiterhin `<Datenordner>/backups/<zeitstempel>-pre-load-v<n>.json`; zusätzlich
  legt der erste Schreibvorgang nach dem Laden einen Snapshot
  `<zeitstempel>-pre-save.json` an (identische Stände werden nicht dupliziert).

### Changed

- **Lagerstätten-Filter wirkt standardmäßig (#289).** Die Auswahl einer
  Lagerstätte im Panel sendet jetzt immer `in_location=true`; angezeigt werden
  nur Produkte mit Bestand > 0 in dieser Lagerstätte. Die bisherige Checkbox
  „Nur mit Bestand in …“ wurde zum Opt-out „Auch Produkte ohne Bestand anzeigen“
  (Standard: aus, sendet `in_location=false`). Sie ist ohne gewählte Lagerstätte
  deaktiviert und wird beim Zurücksetzen auf „Alle Lagerstätten“ zurückgesetzt.
  Der Hinweistext unter dem Auswahlfeld beschreibt genau dieses Verhalten;
  „Filter zurücksetzen“ und der Hinweis „Filter aktiv“ folgen der neuen Semantik.

### Wiederherstellung

Ein Snapshot lässt sich ohne Neuinstallation zurückholen: HA stoppen, den
gewünschten `*-pre-load-v*.json`/`*-pre-save.json`-Snapshot aus
`config/frickeldave_store/backups/` nach `config/frickeldave_store/frickeldave_store.data`
kopieren, HA starten. Details in `docs/backup-restore.md`.

## [0.1.10] - 2026-11-02

### Added

- **Versionsauskunft (#289):** `GET /api/frickeldave_store/me` liefert zusätzlich
  `version`, `storage_schema_version` und `panel_module_url`; `GET`/`PATCH`
  `/api/frickeldave_store/settings` führen ebenfalls `version`. Damit kann das Panel
  anzeigen, welcher Build geladen ist.
- **Geladene Version sichtbar (#289):** Panel und Konfigurationspanel zeigen die von
  `/me` gelieferte Version dezent als Fußzeile (`v0.1.10`) an. Nach einem Update ist
  damit sofort erkennbar, welcher Build im Browser geladen ist.
- **Kompaktere Listenansicht (#289):** kleinere Vorschaubilder (40 px), engere
  Zeilenabstände und Zell-Paddings, Tags fließen einzeilig mit Umbruch. „Bearbeiten“
  und „Archivieren“ sind jetzt Icon-Buttons (Stift/Archivbox) nebeneinander mit
  `aria-label` und `title`; das Touch-Ziel bleibt 44 px.
- **Einklappbare Suche und Filter (#289):** die Filterleiste hat einen Kopfbereich
  „Suche und Filter“ mit Chevron-Schaltfläche (`aria-expanded`/`aria-controls`). Der
  Zustand bleibt über `localStorage` erhalten; bei aktiven Filtern zeigt ein Badge
  „Filter aktiv“ auch im zugeklappten Zustand, dass gefiltert wird.
- **Bündige Filterleiste (#289):** Suchfeld, Ansichtsumschalter und „Filter
  zurücksetzen“ nutzen eine gemeinsame Steuerelementhöhe (48 px, 44 px Touch-Ziel im
  Umschalter) und stehen auch umgebrochen bündig auf einer Linie; das Suchlabel ist
  für Screenreader ausgeblendet.
- **Veröffentlichen in der Kopfzeile (#289):** die Karte „Website veröffentlichen“
  entfällt. Zwei Icon-Buttons (Branch für dev, Rakete für prod) sitzen für
  `app_admin` in der Topbar-Aktionsgruppe und öffnen unverändert den Dry-Run-Dialog.
- **Bestands-Editor (#289):** im Tab „Bestand“ stehen pro Lagerstätte Label,
  Plus-Button, Nummernfeld und Minus-Button untereinander in gleicher Breite; die
  Buttons tragen Plus-/Minus-Symbole mit sprechendem `aria-label`.

### Fixed

- **Cache-Bust für Panel-Module (#289):** Beide Panel-Module werden wieder mit
  `?v=<VERSION>` ausgeliefert, sodass ein Update eine neue Modul-URL ergibt. Die
  statische Route bleibt ohne lange Cache-Zeiten; direkte Frontend-Dateien
  (inklusive des relativ importierten `lit.js`) werden über einen eigenen View mit
  `Cache-Control: no-cache, must-revalidate` ausgeliefert.
- **Ursache:** Browser hielten die feste Modul-URL über das Update hinweg im Cache;
  die Android-App zeigte die neue Oberfläche bereits, weil sie ihren Cache anders
  verwaltet.

## [0.1.9] - 2026-11-02

### Added

- **Listenansicht mit Umschalter (#289):** Produkte lassen sich neben den Kacheln als
  Tabelle mit Bild, Name, Artikelnummer, Kategorie, Preis, Tags, Sichtbarkeit und
  Beständen anzeigen. Der Umschalter („Kacheln“/„Liste“) sitzt in der Filterleiste,
  ist tastaturbedienbar, nutzt `aria-pressed` und merkt sich die Wahl in
  `localStorage`.
- **Veröffentlichen mit Dry-Run-Dialog (#289):** zwei Aktionen „Nach dev
  veröffentlichen“ und „Nach prod veröffentlichen“ (nur `app_admin`) öffnen zuerst den
  Dry-Run mit Zielbranch, Repository, Zusammenfassung, Zählungen für Dateien, Produkte
  und Bilder sowie der Dateiliste (max. 500, Kürzungshinweis). Erst „Jetzt
  veröffentlichen“ schreibt; danach nennen Toast und Dialog Ziel, Commit und
  Deployment-Status. Fehlt das Token, erscheint die deutsche Servermeldung mit Hinweis
  auf Einstellungen → Frickeldave Store → Veröffentlichen.
- **Produktdialog mit Tabs (#289):** „Grunddaten“, „Bilder“ und „Bestand“ ersetzen die
  separaten Bild- und Bestandsdialoge. Bilder (max. 10, Reihenfolge, Hauptbild,
  Löschen) werden im Tab verwaltet; beim Anlegen wechselt der Dialog nach dem ersten
  Speichern automatisch in den Bilder-Tab. Der Bestand-Tab zeigt je Lagerstätte eine
  Nummernbox mit Erhöhen/Verringern-Buttons und die Buchungshistorie.
- **Lagerstätten und Veröffentlichung in den Einstellungen (#289):** eigene Tabs im
  Konfigurationspanel pflegen Namen, Reihenfolge und Löschung der Lagerstätten
  (Löschschutz mit deutscher Meldung) sowie Repository, dev-/prod-Branch,
  prod-Workflow und ein write-only GitHub-Token mit Statusanzeige.
- **KI-Bedienung (#289):** optionales Feld „Eigene Hinweise“ (≤2000 Zeichen) für den
  Beschreibungsvorschlag, vorgeschlagene Tags als übernehmbare Chips und ein klarer
  Hinweis für verworfene Tags („Diese Tags gibt es noch nicht …“). Übernommen werden
  ausschließlich vorhandene Tags.

- **Veröffentlichen nach dev und prod (#289):** `POST /api/frickeldave_store/publish`
  committet den Export über die GitHub-Daten-API auf den Integrationsbranch `dev`
  (löst `fd-ci` und `fd-deploy-dev` aus) oder dispatcht zusätzlich `fd-deploy-prd`,
  der als einziger Weg `main` aktualisiert. GitHub-Token und Repository liegen in den
  Einstellungen, das Token wird nie zurückgegeben oder geloggt.
- **Dry-Run (#289):** derselbe Endpunkt liefert mit `dry_run: true` einen vollständigen
  Diff je Datei (`added`/`changed`/`removed`/`unchanged`), Zählungen für Produkte und
  Bilder, Zielbranch, Deployment-Hinweis und eine deutsche Zusammenfassung – ohne
  Commit, Workflow-Dispatch oder Store-Schreibzugriff.
- **Konfigurierbare Lagerstätten (#289):** Bestände werden je Lagerstätte geführt
  (Default „Lager“ und „Verkaufsschrank“). Umbenennen erhält den Bestand, Löschen ist
  gesperrt, solange dort Stück gebucht sind. `GET /locations` und `PATCH /settings`
  (`locations`) liefern bzw. ändern die Liste; der Website-Export bildet Lagerstätte 1
  weiterhin auf `stock` und Lagerstätte 2 auf `salesCabinet` ab.
- **KI: eigene Anweisungen und Tag-Vorschläge (#289):** der Beschreibungsvorschlag
  akzeptiert optional `instructions`, schlägt Tags ausschließlich aus der vorhandenen
  Tag-Liste vor und meldet verworfene Vorschläge (`rejected_tags`) für den Hinweis
  „Neue Tags musst du selbst anlegen“.

### Changed

- **Bestandsanzeigen folgen der Konfiguration (#289):** Kacheln, Listenansicht,
  Filter und Produktdialog lesen Lagerstätten und Namen aus `GET /locations`; die
  festen Filter „Auf Lager“/„Im Schrank“ und die Felder `stock`/`salesCabinet` im
  Panel entfallen. Die Bestandspflege erfolgt im Produktformular und wird beim
  Speichern persistiert.
- **Store-Schema 2:** Migration von `stock`/`salesCabinet` auf Bestände je Lagerstätte,
  verlustfrei auf die beiden Standard-Lagerstätten; `STORAGE_VERSION` 2.

## [0.1.8] - 2026-10-28

### Added

- **Konfigurierbarer Speicherort (`data_path`) mit Migration:** Der Katalog liegt
  wahlweise unter `config/frickeldave_store` (Standard), `/share/frickeldave_store`
  oder `/media/frickeldave_store`. `share`/`media` sind vom Home-Assistant-Backup
  ausgeschlossen; `config` bleibt der Standard und ist weiterhin im Backup enthalten.
  Beim Wechsel werden Store-Datei, Bilder und Snapshots kopiert, die alte Kopie
  bleibt erhalten; ein belegtes Ziel wird mit `409 conflict` abgelehnt. Freie Pfade
  und fehlende Mounts werden mit einer klaren Meldung abgelehnt.
- **Settings-API:** `GET /settings` liefert `storage` mit `data_path`,
  `effective_path`, `backup_included`, `exclude_from_backup`, `paths` und `choices`;
  `PATCH /settings` akzeptiert `{"storage": {"data_path": ...}}` und meldet
  `reload_required`.
- **Options-Flow:** Auswahlfeld `data_path` als Rückfallebene zum Konfigurationspanel.


### Changed

- **Design-Review nach der offiziellen Home-Assistant-Design-Dokumentation:**
  semantische `--ha-color-*`-Tokens (mit Legacy-Fallbacks für ältere HA-Versionen),
  Typografie-, Spacing-, Radius- und Motion-Tokens, HA-Button-Größen und -Varianten,
  Dialog-Anatomie (Schließen oben links, Footer unten rechts, destruktive
  Bestätigungen mit Fokus auf „Abbrechen“), Listen- und Formular-Patterns,
  Empty-/Loading-/Error-Zustände, UI-Text (Erstellen/Hinzufügen,
  Entfernen/Löschen, Archivieren), Fokusringe und Reduced Motion.
- Produkte werden weiterhin ausschließlich archiviert (kein Hard-Delete);
  dauerhaft gelöscht werden nur Dateien und Tags.

## [0.1.6] - 2026-10-28

### Changed

- **Topbar im HA-Stil:** vollbreite, sticky App-Bar außerhalb des Inhaltsbereichs mit
  HA-Metriken (56 px Höhe, 48 px Icon-Buttons, `--header-height`, `--app-header-*`,
  `--ha-space-*`); die Aktionen Aktualisieren, Katalog importieren und Produkt anlegen
  sind jetzt reine Icon-Buttons mit deutschen Labels; die Unterzeile „Angemeldet als …“
  entfällt.
- **Konfigurationspanel:** eigene vollbreite Topbar mit Zurück-/Vorwärts-Navigation
  (Fallback `/config/integrations`) und sinnvollen deaktivierten Zuständen.
- **UI-Review:** Karten, Buttons, Eingabefelder, Tabs und Badges an HA-Tokens und
  -Metriken angeglichen (12 px Radien, 44 px Touch-Ziele, Fokusringe, Kontrast).

## [0.1.5] - 2026-10-28

### Added

- **Tabbed Konfigurationspanel**: Ein zweites `panel_custom`-Panel hängt über
  `config_panel_domain` am Zahnrad des Integrationseintrags
  (`/frickeldave-store-config?config_entry=<id>`, `require_admin`) und bietet die Tabs
  **Benutzerverwaltung** und **KI-Einstellungen**. Das Seitenleisten-Panel bleibt
  unverändert; beide Panels werden idempotent registriert und beim Unload entfernt.
- **Benutzerverwaltungs-API**: `GET /api/frickeldave_store/users` liefert Freigaben mit
  echten HA-Namen, Rollen-Labels und noch nicht freigegebenen aktiven Benutzern
  (`available_users`, nur ID und Name). `PUT`/`DELETE /users/{user_id}` legen Freigaben
  an, ändern Rollen oder entziehen sie, persistieren in der Option `users` und wenden
  die Änderung sofort an. Der letzte `app_admin` ist gegen Löschen und Herabstufen
  geschützt (`409 conflict`); unbekannte Benutzer-IDs bleiben bearbeitbar.
- Tests für Liste, Anlegen, Ändern, Löschen, Namensauflösung, Rollenvalidierung,
  Letzter-Admin-Schutz, sofortigen Rechteentzug und `403` ohne `app_admin`.
- Dokumentation der Oberfläche und der Endpunkte in README, `docs/permissions.md` und
  `docs/architecture.md`.

### Changed

- **Einstellungen nicht mehr im Seitenleisten-Menü**: Der Drei-Punkte-Eintrag „KI“ im
  Panel entfällt; Einstellungen liegen ausschließlich im Konfigurationspanel am
  Integrationseintrag (Frontend-Umsetzung durch das Frontend-Team). Der Options-Flow
  bleibt als Rückfallebene erhalten.

## [0.1.4] - 2026-10-28

### Changed

- **Tags-Filter jetzt ODER-verknüpft**: Bei `GET /products` und den WebSocket-Filtern
  genügt ein Produkt einem der gewählten Tags, statt alle erfüllen zu müssen; die
  Verknüpfung entspricht damit der Kategorieauswahl. Groß-/Kleinschreibung bleibt
  unerheblich, eine leere Tag-Auswahl filtert weiterhin nicht, und alle übrigen
  Filter bleiben UND-verknüpft.
- **Panel-Topbar**: Burger-Menü und Drei-Punkte-Menü ersetzen die bisherigen Tabs.
  Einstellungen (KI) und Tag-Verwaltung liegen jetzt im Menü.

## [0.1.3] - 2026-10-27

### Added

- **Katalogimport** (`POST /api/frickeldave_store/import/catalog`): Der bestehende
  Website-Katalog `https://frickeldave.de/data/handmade.json` wird samt Bildern
  (172 Dateien im Website-Repository) idempotent in den Store übernommen. Die
  Zuordnung erfolgt über die `articleNumber`; vorhandene Produkte werden nie
  überschrieben (`skipped`), Duplikate im Dokument gelten als `failed`, gelöscht
  wird nichts. Bilder werden als `<artikelnummer>-NN.jpg` (01…10, erst `.jpg`,
  dann `.jpeg`) geladen und im Panel-Layout gespeichert; Bildabrufe laufen mit
  höchstens fünf parallelen Anfragen und eigenem Zeitlimit, Bildfehler brechen
  den Produktimport nicht ab. Nur ein nicht lesbares oder strukturell ungültiges
  Katalogdokument lehnt die Anfrage ab, ohne den Store zu verändern.
- Eigene `source_url`/`image_base_url` erfordern `app_admin` und sind auf
  `https` plus die Hosts `frickeldave.de` und `raw.githubusercontent.com`
  beschränkt (SSRF-Schutz); die Standardquellen genügen der Rolle `product`.
- Tests (`tests/test_importer.py`, 38 Fälle, gemocktes aiohttp ohne Netzwerk)
  für Feldabbildung, Idempotenz, Fehlerfälle, Bilderkennung, Obergrenzen und
  die Rechteprüfung des Endpunkts.
- Dokumentation des Imports in README, `docs/data-model.md` und
  `docs/architecture.md`.

## [0.1.2] - 2026-10-27

### Fixed

- Das Panel zeigte im Browser nur eine schwarze Seite: Das ES-Modul importierte
  Lit über den nackten Spezifizierer `lit`. Home Assistant liefert keine
  Import-Map aus, sodass `panel_custom` den Import mit "Failed to resolve module
  specifier 'lit'" abbrach. Lit 3.3.3 liegt jetzt als vendored ESM-Bundle unter
  `custom_components/frickeldave_store/frontend/lit.js`; das Panel importiert
  `./lit.js`. Der Build ist über `package.json` und `npm run build:frontend`
  reproduzierbar (lit und esbuild exakt gepinnt) und wird von
  `tests/test_frontend_assets.py` abgesichert: keine nackten Spezifizierer im
  Panel, Bundle vorhanden und mit `LitElement`, `html` und `css` exportiert.

## [0.1.1] - 2026-10-27

### Fixed

- Config- und Options-Flow verwenden das von Home Assistant mitgelieferte
  Schema-Modul (`probatio` ab HA 2026.10, sonst `voluptuous`) und definieren das
  Feld `users` als serialisierbaren String. Dadurch schlägt das Laden des
  Formulars nicht mehr mit "Config flow could not be loaded: 500 Internal Server
  Error" fehl; die Freigabevalidierung erfolgt weiterhin im Flow-Schritt und
  zeigt `invalid_users` an. Neue Regressionstests serialisieren die Formularschemata
  wie der HTTP-Layer.
- Die WebSocket-Kommandos `frickeldave_store/products` und
  `frickeldave_store/subscribe` verwenden ein gültiges Filter-Schema
  (Marker als Schlüssel, Validatoren als Werte). Bisher standen die
  `Optional`-Marker als Werte im Mapping, wodurch jede Nachricht mit Filterfeldern
  mit "not a valid value at 'search'" abgelehnt wurde. Die Feldnamen für
  `_query_from_msg` liegen nun in einer separaten Konstante; ein Regressionstest
  prüft alle Kommando-Schemas mit realistischen Filterwerten und weist ungültige
  Werte (z. B. `limit: "abc"`) zurück.

## [0.1.0] - 2026-10-27

### Added

- Grundgerüst der Home-Assistant-Custom-Integration `frickeldave_store`
  (Manifest, HACS-Metadaten, CI mit ruff, mypy, pytest, hassfest und HACS-Validation).
- Datenschicht mit HA-`Store` (Schlüssel `frickeldave_store.data`, Schema-Version 1),
  Bildablage unter `config/frickeldave_store/images/<artikelnummer>/`, atomaren
  Schreibvorgängen, Snapshots vor Migrationen und `async_migrate_entry`.
- Produktdomain: Anlegen mit eindeutiger Artikelnummer, Bearbeiten, ausschließlich
  Soft-Delete, unveränderliche Kategorie, Tag-Verwaltung, Bestandsbuchungen,
  kombinierbare Filter (Kategorie ODER, Tags UND, übrige UND) und Sortierung.
- Config Flow und Options Flow inklusive deutscher und englischer Übersetzungen.
- Berechtigungsschicht mit den Rollen `product`, `finance` und `app_admin`,
  Default Deny, Prüfung je HTTP-/WebSocket-Anfrage und sofortigem Rechteentzug.
- HTTP-API unter `/api/frickeldave_store` und WebSocket-Kommandos inklusive
  Panel-Registrierung (`panel_custom`, `frickeldave-store`).
- KI-Beschreibungsvorschläge über eine Anbieter-Abstraktion mit DeepSeek-Client,
  EXIF/GPS-Bereinigung und ausschließlich manueller Übernahme.
- Idempotenter Katalogexport im Schema der Website plus CLI.
- Dokumentation (`docs/`) und Testsuite (Domain-, API- und HA-Integrationstests).

Referenz: `Frickeldave/frickeldave.github.io#289`.
