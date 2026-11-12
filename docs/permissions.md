# Berechtigungen

## Grundsätze

- **Default Deny:** Unbekannte HA-Benutzer haben keine Rolle und erhalten auf jeder
  geschützten HTTP- und WebSocket-Route `403` mit leerem Fehlerobjekt
  (`{"error": {"code": "forbidden", "message": "..."}}`) – ohne Produkt-, Kunden- oder
  Finanzdaten im Body.
- **Fehlende Sitzung = `401`:** Trägt eine Anfrage keinen `hass_user` (abgelaufenes
  oder fehlendes HA-Token), antwortet die API mit `401`
  (`{"error": {"code": "not_authenticated", "message": "Die Sitzung ist abgelaufen. Bitte die Seite neu laden."}}`),
  nicht mit `403`. Nur eine fehlende Rolle ist `403 forbidden`.
- **Stabile Benutzer-ID:** Freigaben hängen an der HA-Benutzer-ID, nicht am Namen.
- **Prüfung je Anfrage:** `require_admin` ist keine Zugangskontrolle. Jede Route ruft
  `PermissionManager.require()` auf; das Mapping wird bei jeder Anfrage neu gelesen.
  Ein Rechteentzug greift damit beim nächsten Zugriff, auch bei geöffnetem Panel.
- **Keine impliziten Finanzrechte:** `finance` folgt weder aus `product` noch aus
  `app_admin`.

## Rollen

| Rolle | Bedeutung | Endpunkte |
| --- | --- | --- |
| `product` | Produktpflege | `/products*`, `/tags*`, `/locations`, `/products/*/stock`, `/products/*/description/suggest` |
| `finance` | Finanzen (spätere Ausbaustufe) | derzeit keine Endpunkte |
| `app_admin` | Anwendungsverwaltung | `/settings`, `/export` |

Rollen sind beliebig kombinierbar.

## Routen-Matrix

| Route | Methode | Rolle |
| --- | --- | --- |
| `/api/frickeldave_store/me` | GET | nur Anmeldung (liefert eigene Rechte, keine Fachdaten) |
| `/api/frickeldave_store/products` | GET, POST | `product` |
| `/api/frickeldave_store/products/{article_number}` | GET, PATCH | `product` |
| `/api/frickeldave_store/products/{article_number}/archive` | POST | `product` |
| `/api/frickeldave_store/products/{article_number}/images` | GET, POST | `product` |
| `/api/frickeldave_store/products/{article_number}/images/{name}` | GET, DELETE | `product` |
| `/api/frickeldave_store/products/{article_number}/images/{name}/rotate` | POST | `product` |
| `/api/frickeldave_store/products/{article_number}/images/order` | POST | `product` |
| `/api/frickeldave_store/products/{article_number}/images/main` | POST | `product` |
| `/api/frickeldave_store/products/{article_number}/stock` | GET, POST | `product` |
| `/api/frickeldave_store/products/{article_number}/description/suggest` | POST | `product` |
| `/api/frickeldave_store/tags` | GET, POST | `product` |
| `/api/frickeldave_store/tags/{name}` | DELETE | `product` |
| `/api/frickeldave_store/users` | GET | `app_admin` |
| `/api/frickeldave_store/users/{user_id}` | PUT, DELETE | `app_admin` |
| `/api/frickeldave_store/settings` | GET, PATCH | `app_admin` |
| `/api/frickeldave_store/export` | POST | `app_admin` |
| `/api/frickeldave_store/features/{feature}` | POST | Rolle aus der Registrierung der Erweiterung (`publish`: `app_admin`, `import`: `product` mit `app_admin` für eigene Quellen); ohne Erweiterung `409 feature_unavailable` |
| `frickeldave_store/me` | WS | nur Anmeldung |
| `frickeldave_store/products` | WS | `product` |
| `frickeldave_store/subscribe` | WS | `product` (bei jedem Push erneut geprüft) |

Die Bild-Routen einschließlich `.../images/{name}/rotate` verlangen dieselbe Rolle
`product` wie alle übrigen Produktendpunkte. `401` und `403` verhalten sich dort
unverändert: eine fehlende oder abgelaufene Sitzung ergibt `401 not_authenticated`,
eine fehlende Produktrolle `403 forbidden` – ohne Bilddaten im Body.

## Freigaben verwalten

### Oberfläche (primär)

Das Zahnrad am Eintrag **Einstellungen → Geräte & Dienste → Frickeldave Store** öffnet
das Konfigurationspanel mit den Tabs **Benutzerverwaltung**, **Lagerstätten** und
**KI-Einstellungen** (`/frickeldave-store-config?config_entry=<id>`). Die JavaScript-Oberfläche nutzt
ausschließlich die Endpunkte `/users` und `/users/{user_id}`; das Backend ist damit auch
ohne Frontend testbar.

Ablauf in der Benutzerverwaltung:

1. **Hinzufügen:** Aus `available_users` (aktive HA-Benutzer ohne Freigabe, nur ID und
   Name) eine Person wählen und mindestens eine Rolle vergeben.
2. **Bearbeiten:** Rollen einer Freigabe ändern; die Auswahl wird über
   `normalise_roles` geprüft und dedupliziert.
3. **Löschen:** Freigabe entfernen. Der Entzug wirkt sofort, weil die Antwort erst nach
   `_async_apply_entry_config` erzeugt wird.

Der Endpunkt liefert zu jeder Freigabe den echten HA-Namen (`hass.auth.async_get_users`)
sowie `role_labels` für die Anzeige. Unbekannte Benutzer-IDs bleiben mit `name: ""`
sichtbar und bearbeit-/entfernbar, damit verwaiste Freigaben aufgeräumt werden können.

Sicherheitsregeln:

- Unbekannte oder leere Rollenlisten → `400 validation_error`.
- Neue Freigabe für eine nicht existierende HA-Benutzer-ID → `404 not_found`.
- Die letzte `app_admin`-Freigabe kann weder gelöscht noch herabgestuft werden →
  `409 conflict` (kein Aussperren der Verwaltung).
- Jede Mutation schreibt die Option `users` über
  `hass.config_entries.async_update_entry` und wendet sie sofort an.

### Options-Format (Rückfallebene und Quelle der Wahrheit)

Format in Config-/Options-Entry (`users`), eine Zeile pro Benutzer:

```
# Kommentar
<ha_user_id>: product,app_admin
<ha_user_id>: product
```

Der Options-Flow bleibt als Rückfallebene erhalten und schreibt dasselbe Format.
Änderungen werden über den Update-Listener und zusätzlich direkt nach API-Mutationen
angewendet (`PermissionManager.load`), ohne Neustart. Unbekannte Rollen werden beim
Speichern abgelehnt (`validation_error`).

## Antwort von `GET /me`

```json
{
  "user_id": "abc123",
  "name": "David Koenig",
  "roles": ["product", "app_admin"],
  "can": {"product": true, "finance": false, "app_admin": true}
}
```

Unbekannte Benutzer erhalten dieselbe Struktur mit leeren Rollen und ausschließlich
`false`-Werten. Das ist die einzige Route ohne Rollenpflicht, weil sie keine geschützten
Daten enthält und das Panel daraus sein Rechte-Gating ableitet.

## Geheimnisse

API-Keys sind ausschließlich serverseitig gespeichert. Sie erscheinen nicht in Antworten
(`api_key_set: true`), nicht in Logs, nicht in Diagnose-Dumps und nicht im Export.
