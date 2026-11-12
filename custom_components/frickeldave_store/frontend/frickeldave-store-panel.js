/**
 * Frickeldave Store - Verwaltungspanel für Home Assistant.
 *
 * Einzelne Lit-Web-Component für `panel_custom` mit `embed_iframe=False`.
 * Lit liegt als vendored ESM-Bundle unter `./lit.js` (siehe frontend/README.md),
 * weil Home Assistant keine Import-Map für den nackten Spezifizierer "lit"
 * bereitstellt. Alle Daten kommen über die HA-HTTP-API mit Bearer-Token; die
 * Autorisierung erfolgt serverseitig pro Anfrage.
 *
 * Aufbau:
 *   1. Konstanten und Hilfsfunktionen
 *   2. API-Schicht und Zustandsverwaltung
 *   3. Editor-, Bild-, Bestands-, Archiv- und Tag-Logik
 *   4. Render-Methoden (Produktliste und Dialoge)
 *   5. Styles ausschließlich über HA-Design-Tokens und eigene --fd-* Schicht
 */

import { LitElement, html, css } from "./lit.js";
import { authRequestUrl, shouldRefreshToken } from "./auth-retry.js";
import { featureInfo, normalizeFeatures } from "./features.js";
import { formatBytes } from "./format-bytes.js";
import {
  ROTATE_DIRECTIONS,
  canRotateImage,
  normalizeRotateDirection,
  rotateAriaLabel,
  rotateButtonLabel,
  rotateNoticeText,
  rotateTargetSelector,
} from "./image-rotate.js";
import {
  FILE_FILTER_ALL,
  fileStatusCounts,
  filterFileChanges,
  statusOptions,
} from "./publish-filters.js";

const API_ROOT = "/api/frickeldave_store";
const MAX_IMAGES = 10;
const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 300;
const TOAST_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 30000;
// Der Katalogimport lädt Produkte und Bilder von der Website und darf länger laufen.
const IMPORT_TIMEOUT_MS = 180000;

// Event der Basis, sobald sich registrierte Erweiterungen ändern (Contract 1).
const FEATURES_EVENT = "frickeldave_store_features_changed";
// Fehler der generischen Feature-Route: deuten auf einen veralteten Stand hin.
const FEATURE_ERROR_CODES = new Set(["feature_unavailable", "not_registered", "feature_unknown"]);

const CATEGORY_LABELS = Object.freeze({
  "3D": "3D-Druck",
  EP: "Epoxidharz",
  LA: "Laser",
  SB: "Steinmasse",
  WO: "Holz",
});

const CATEGORY_KEYS = Object.freeze(Object.keys(CATEGORY_LABELS));

const VISIBILITY_OPTIONS = Object.freeze([
  { value: "all", label: "Alle" },
  { value: "visible", label: "Sichtbar" },
  { value: "invisible", label: "Unsichtbar" },
]);

// Sortierbare Spalten der Listenansicht. Reihenfolge = Spaltenreihenfolge.
const SORT_COLUMNS = Object.freeze([
  { field: "name", label: "Produkt" },
  { field: "category", label: "Kategorie" },
  { field: "price", label: "Preis" },
  { field: "stock", label: "Bestand" },
  { field: "size", label: "Größe" },
  { field: "status", label: "Status" },
]);

const SORT_FIELDS = Object.freeze(SORT_COLUMNS.map((column) => column.field));

const EDITOR_TABS = Object.freeze(["general", "images", "description", "stock"]);

// Schwellwerte, die der Server für `oversized` verwendet (lange Kante und Dateigröße).
const IMAGE_MAX_LONG_EDGE = 1600;
const IMAGE_MAX_BYTES = 500 * 1024;

const OVERSIZED_HINT =
  "Mindestens ein Bild ist zu groß. Produkt öffnen und Bilder optimieren.";

// Beim „Weiter“-Klick wird das Feld geprüft, das auf dem Zielfeld sichtbar ist.
const EDITOR_FIELD_TABS = Object.freeze({
  name: "general",
  category: "general",
  price: "general",
  size: "general",
  description: "description",
});

const BOOKING_TYPE_LABELS = Object.freeze({
  in: "Zugang",
  out: "Abgang",
  transfer: "Umlagerung",
  correction: "Korrektur",
});

const VIEW_STORAGE_KEY = "fd-store-view";
const VIEW_MODES = Object.freeze(["grid", "list"]);
const FILTERS_STORAGE_KEY = "fd-store-filters-open";

const PUBLISH_STATUS_META = Object.freeze({
  added: { label: "Neu", icon: "＋" },
  changed: { label: "Geändert", icon: "✎" },
  removed: { label: "Entfernt", icon: "−" },
  unchanged: { label: "Unverändert", icon: "＝" },
});

const PUBLISH_TARGET_LABELS = Object.freeze({
  dev: "dev",
  prod: "prod",
});

const currencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const numberFormatter = new Intl.NumberFormat("de-DE");

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
});

class ApiError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const formatPrice = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? currencyFormatter.format(number) : "—";
};

const formatNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? numberFormatter.format(number) : "0";
};

const formatDateTime = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
};

const formatDimensions = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return "";
  }
  return `${Math.round(w)} × ${Math.round(h)}`;
};

const formatImageMeta = (image) => {
  const parts = [formatDimensions(image?.width, image?.height), image?.bytes ? formatBytes(image.bytes) : ""];
  return parts.filter(Boolean).join(" · ");
};

const percentFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

const formatPercent = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? percentFormatter.format(number) : "0";
};

const categoryLabel = (key) => CATEGORY_LABELS[key] || key || "—";

const productPath = (articleNumber) =>
  `${API_ROOT}/products/${encodeURIComponent(String(articleNumber ?? ""))}`;

const toggleInList = (list, value) =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

const isFeatureError = (error) =>
  error instanceof ApiError && FEATURE_ERROR_CODES.has(String(error.code || ""));

const normalizeTagNames = (data) => {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.tags)
      ? data.tags
      : [];
  const names = raw
    .map((entry) => (typeof entry === "string" ? entry : entry?.name))
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "de"));
};

const normalizeImage = (image) => {
  if (typeof image === "string") {
    return {
      name: image,
      url: image,
      is_main: false,
      bytes: 0,
      width: 0,
      height: 0,
      content_type: "",
      oversized: false,
      animated: false,
      mtime_ns: 0,
    };
  }
  if (!image || typeof image !== "object") {
    return null;
  }
  const bytes = Math.max(0, Math.round(Number(image.bytes) || 0));
  const width = Math.max(0, Math.round(Number(image.width) || 0));
  const height = Math.max(0, Math.round(Number(image.height) || 0));
  const mtimeNs = Math.max(0, Math.trunc(Number(image.mtime_ns) || 0));
  // Der Server setzt `oversized`; für ältere Antworten wird es aus den Maßen abgeleitet.
  const oversized =
    Boolean(image.oversized) ||
    Math.max(width, height) > IMAGE_MAX_LONG_EDGE ||
    bytes > IMAGE_MAX_BYTES;
  return {
    name: typeof image.name === "string" ? image.name : "",
    url: typeof image.url === "string" ? image.url : "",
    is_main: Boolean(image.is_main),
    bytes,
    width,
    height,
    content_type: typeof image.content_type === "string" ? image.content_type : "",
    oversized,
    // Animierte Bilder sind nicht drehbar; `mtime_ns` bricht den Bild-Cache.
    animated: Boolean(image.animated),
    mtime_ns: mtimeNs,
  };
};

const isAbortError = (error) => error?.name === "AbortError";

const asCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
};

const normalizeLocations = (data) => {
  const raw = Array.isArray(data) ? data : Array.isArray(data?.locations) ? data.locations : [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => ({
      id: String(entry.id ?? ""),
      name: typeof entry.name === "string" ? entry.name : "",
      position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : index,
      stockTotal: asCount(entry.stock_total),
      productsWithStock: asCount(entry.products_with_stock),
    }))
    .filter((entry) => entry.id && entry.name)
    .sort((a, b) => a.position - b.position);
};

const normalizeBooking = (entry) => {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    id: String(entry.id ?? ""),
    type: typeof entry.type === "string" ? entry.type : "correction",
    quantity: asCount(entry.quantity),
    note: typeof entry.note === "string" ? entry.note : "",
    at: typeof entry.at === "string" ? entry.at : "",
    locationName: typeof entry.locationName === "string" ? entry.locationName : "",
    targetLocationName: typeof entry.targetLocationName === "string" ? entry.targetLocationName : "",
  };
};

const normalizeCounts = (value) => ({
  added: asCount(value?.added),
  changed: asCount(value?.changed),
  removed: asCount(value?.removed),
  unchanged: asCount(value?.unchanged),
  total: asCount(value?.total),
});

const normalizeRemovalGuard = (value) => {
  const payload = value && typeof value === "object" ? value : {};
  return {
    triggered: Boolean(payload.triggered),
    removed: asCount(payload.removed),
    existing: asCount(payload.existing),
    maxFiles: asCount(payload.maxFiles),
    share: asCount(payload.share),
  };
};

const normalizePublishResult = (data) => {
  const payload = data && typeof data === "object" ? data : {};
  const deployment = payload.deployment && typeof payload.deployment === "object" ? payload.deployment : {};
  const files = Array.isArray(payload.files)
    ? payload.files
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          path: typeof entry.path === "string" ? entry.path : "",
          status: PUBLISH_STATUS_META[entry.status] ? entry.status : "changed",
          kind: entry.kind === "image" ? "image" : "catalog",
          articleNumber: typeof entry.articleNumber === "string" ? entry.articleNumber : "",
        }))
        .filter((entry) => entry.path)
    : [];
  return {
    target: payload.target === "prod" ? "prod" : "dev",
    dryRun: Boolean(payload.dry_run),
    repository: typeof payload.repository === "string" ? payload.repository : "",
    branch: typeof payload.branch === "string" ? payload.branch : "",
    commit: typeof payload.commit === "string" ? payload.commit : "",
    changed: Boolean(payload.changed),
    counts: normalizeCounts(payload.counts),
    products: normalizeCounts(payload.products),
    images: normalizeCounts(payload.images),
    files,
    filesTruncated: Boolean(payload.files_truncated),
    removalGuard: normalizeRemovalGuard(payload.removal_guard),
    deployment: {
      triggered: Boolean(deployment.triggered),
      wouldTrigger: Boolean(deployment.would_trigger),
      mode: typeof deployment.mode === "string" ? deployment.mode : "push",
      workflow: typeof deployment.workflow === "string" ? deployment.workflow : "",
      branch: typeof deployment.branch === "string" ? deployment.branch : "",
    },
    warning: typeof payload.warning === "string" ? payload.warning : "",
    summary: typeof payload.summary === "string" ? payload.summary : "",
  };
};

const readStoredView = () => {
  try {
    const stored = window.localStorage?.getItem(VIEW_STORAGE_KEY);
    return VIEW_MODES.includes(stored) ? stored : "grid";
  } catch {
    return "grid";
  }
};

const storeView = (view) => {
  try {
    window.localStorage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Privater Modus oder gesperrter Speicher: Ansicht bleibt für die Sitzung gültig.
  }
};

const readStoredFiltersOpen = () => {
  try {
    const stored = window.localStorage?.getItem(FILTERS_STORAGE_KEY);
    return stored === null || stored === undefined ? true : stored === "open";
  } catch {
    return true;
  }
};

const storeFiltersOpen = (open) => {
  try {
    window.localStorage?.setItem(FILTERS_STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Privater Modus oder gesperrter Speicher: Zustand bleibt für die Sitzung gültig.
  }
};

export class FrickeldaveStorePanel extends LitElement {
  static properties = {
    hass: { attribute: false, noAccessor: true },
    panel: { attribute: false },
    narrow: { attribute: false, type: Boolean },

    _accessState: { state: true },
    _accessError: { state: true },
    _me: { state: true },
    _features: { state: true },

    _menuOpen: { state: true },
    _filtersOpen: { state: true },

    _products: { state: true },
    _total: { state: true },
    _productsLoading: { state: true },
    _productsError: { state: true },

    _search: { state: true },
    _categoryFilter: { state: true },
    _tagFilter: { state: true },
    _customizableOnly: { state: true },
    _locationFilter: { state: true },
    _includeWithoutStock: { state: true },
    _visibility: { state: true },
    _showArchived: { state: true },
    _sort: { state: true },
    _order: { state: true },
    _offset: { state: true },
    _allTags: { state: true },
    _imageVersion: { state: true },
    _view: { state: true },

    _locations: { state: true },
    _locationsError: { state: true },

    _editor: { state: true },
    _archiveDialog: { state: true },
    _tagsDialog: { state: true },
    _importDialog: { state: true },
    _publishDialog: { state: true },

    _toast: { state: true },
  };

  constructor() {
    super();

    this._hass = undefined;
    this._controllers = new Set();
    this._searchTimer = undefined;
    this._toastTimer = undefined;
    this._focusReturn = null;
    this._accessUserId = null;
    this._productsRequestId = 0;
    this._imagesRequestId = 0;
    this._bookingsRequestId = 0;
    this._articlePreviewRequestId = 0;
    this._importPreviewRequestId = 0;
    this._imageCache = new Map();
    this._imagePending = new Set();

    this._accessState = "idle";
    this._accessError = "";
    this._accessRefreshScheduled = false;
    this._me = null;
    this._features = null;
    this._featureUnsubscribe = null;
    this._featureConnection = null;
    this._featureSubscribing = false;
    this._featuresTimer = undefined;
    this._menuOpen = false;
    this._filtersOpen = readStoredFiltersOpen();

    this._products = [];
    this._total = 0;
    this._productsLoading = false;
    this._productsError = "";

    this._search = "";
    this._categoryFilter = [];
    this._tagFilter = [];
    this._customizableOnly = false;
    this._locationFilter = "";
    this._includeWithoutStock = false;
    this._visibility = "all";
    this._showArchived = false;
    this._sort = "name";
    this._order = "asc";
    this._offset = 0;
    this._allTags = [];
    this._view = readStoredView();

    this._locations = [];
    this._locationsError = "";

    this._editor = null;
    this._archiveDialog = null;
    this._tagsDialog = null;
    this._importDialog = null;
    this._publishDialog = null;

    this._toast = null;
    this._imageVersion = 0;
    this._editorSnapshot = "";
    this._editorShakeTimer = undefined;

    this._onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        this._revalidateAccess();
      }
    };

    // Gebundene Listener für das Kontextmenü (document-Ebene).
    this._onMenuOutside = (event) => this._handleMenuOutside(event);
    this._onMenuKeydown = (event) => this._handleMenuKeydown(event);
  }

  get hass() {
    return this._hass;
  }

  set hass(value) {
    const previous = this._hass;
    if (previous === value) {
      return;
    }
    this._hass = value;
    const update = this.requestUpdate("hass", previous);
    if (update && typeof update.catch === "function") {
      update.catch(() => {});
    }

    const userId = value?.user?.id ?? null;
    if (this._accessUserId !== null && userId !== null && userId !== this._accessUserId) {
      this._accessUserId = userId;
      this._resetForUser();
    }

    this._bootstrap();
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibilityChange);
    this._bootstrap();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this._detachMenuListeners();
    this._unsubscribeFeatureEvents();
    clearTimeout(this._featuresTimer);
    clearTimeout(this._searchTimer);
    clearTimeout(this._toastTimer);
    clearTimeout(this._editorShakeTimer);
    for (const controller of this._controllers) {
      controller.abort();
    }
    this._controllers.clear();
    this._releaseImages();
  }

  firstUpdated() {
    this._bootstrap();
  }

  updated() {
    this._syncDialogs();
  }

  /* --------------------------------------------------------------------- */
  /* Basis: Sitzung, Basis-URL, HTTP                                        */
  /* --------------------------------------------------------------------- */

  _token() {
    const auth = this.hass?.auth;
    const token = auth?.data?.access_token || auth?.accessToken || "";
    return typeof token === "string" ? token : "";
  }

  _baseUrl() {
    const raw = this.hass?.auth?.data?.hassUrl || window.location.origin || "";
    return String(raw).replace(/\/+$/, "");
  }

  _assetUrl(url) {
    if (!url) {
      return "";
    }
    try {
      return new URL(url, `${this._baseUrl()}/`).href;
    } catch {
      return url;
    }
  }

  _can(permission) {
    return Boolean(this._me?.can?.[permission]);
  }

  /**
   * Status einer Fähigkeit. Ab 0.2.0 gibt es keinen eingebauten Publish-/Import-
   * Pfad mehr; `present` bedeutet daher „von einer Erweiterung installiert“.
   * Reservierte Fähigkeiten ohne Erweiterung (leerer `provider`) fehlen in der
   * Karte und gelten damit als nicht installiert.
   */
  _featureInfo(name) {
    return featureInfo(this._features, name);
  }

  _featureHint(info, fallback) {
    return info.reason || `${fallback} ist derzeit nicht verfügbar.`;
  }

  _ensureFeatureSubscription() {
    const connection = this.hass?.connection;
    if (!connection || typeof connection.subscribeEvents !== "function" || !this._token()) {
      return;
    }
    if (
      this._featureConnection === connection &&
      (this._featureSubscribing || this._featureUnsubscribe)
    ) {
      return;
    }
    this._unsubscribeFeatureEvents();
    this._featureConnection = connection;
    this._featureSubscribing = true;

    let pending;
    try {
      pending = connection.subscribeEvents(
        () => this._scheduleFeatureRefresh(),
        FEATURES_EVENT,
      );
    } catch {
      this._featureSubscribing = false;
      this._featureConnection = null;
      return;
    }

    Promise.resolve(pending)
      .then((unsubscribe) => {
        this._featureSubscribing = false;
        if (this._featureConnection !== connection || !this.isConnected) {
          if (typeof unsubscribe === "function") {
            unsubscribe();
          }
          return;
        }
        this._featureUnsubscribe = unsubscribe;
      })
      .catch(() => {
        this._featureSubscribing = false;
      });
  }

  _unsubscribeFeatureEvents() {
    this._featureSubscribing = false;
    this._featureConnection = null;
    const unsubscribe = this._featureUnsubscribe;
    this._featureUnsubscribe = null;
    if (typeof unsubscribe === "function") {
      try {
        unsubscribe();
      } catch {
        // Die Verbindung kann beim Trennen bereits geschlossen sein.
      }
    }
  }

  _scheduleFeatureRefresh() {
    clearTimeout(this._featuresTimer);
    this._featuresTimer = setTimeout(() => {
      this._featuresTimer = undefined;
      this._reloadFeatures();
    }, 150);
  }

  /**
   * Nur Identität und Fähigkeiten neu laden. Produktliste, Filter und offene
   * Dialoge bleiben unangetastet; nicht mehr verfügbare Dialoge werden beendet.
   */
  async _reloadFeatures() {
    if (!this.hass || !this._token() || this._accessState !== "ready") {
      return;
    }
    try {
      const me = await this._api(`${API_ROOT}/me`);
      this._applyMe(me);

      const publish = this._featureInfo("publish");
      if (this._publishDialog && !this._publishDialog.busy && !publish.available) {
        this._publishDialog = null;
        this._restoreFocus();
        this._showToast(this._featureHint(publish, "Veröffentlichen"));
      }
      const importFeature = this._featureInfo("import");
      if (this._importDialog && !this._importDialog.busy && !importFeature.available) {
        this._importDialog = null;
        this._restoreFocus();
        this._showToast(this._featureHint(importFeature, "Der Katalogimport"));
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        // Ein 401 ist eine abgelaufene Sitzung, keine fehlende Freigabe.
        this._accessState = error.status === 403 ? "denied" : "error";
        this._accessError = this._errorText(error);
        this._products = [];
        this._total = 0;
        this._allTags = [];
      }
    }
  }

  _applyMe(me) {
    const user = me && typeof me === "object" ? me : {};
    const can = {
      product: Boolean(user?.can?.product),
      finance: Boolean(user?.can?.finance),
      app_admin: Boolean(user?.can?.app_admin),
    };
    this._me = {
      userId: user.user_id || "",
      name: typeof user.name === "string" ? user.name : this._me?.name || "",
      roles: Array.isArray(user.roles)
        ? user.roles.filter((role) => typeof role === "string")
        : [],
      can,
      version: typeof user.version === "string" ? user.version : this._me?.version || "",
    };
    this._features = normalizeFeatures(user.features);
    this._accessUserId = this.hass?.user?.id ?? null;
    return can;
  }

  _httpFallbackMessage(status) {
    if (status === 400) {
      return "Die Anfrage ist ungültig. Bitte die Eingaben prüfen.";
    }
    if (status === 401) {
      return "Die Sitzung ist abgelaufen. Bitte die Seite neu laden.";
    }
    if (status === 403) {
      return "Kein Zugriff auf diese Funktion.";
    }
    if (status === 404) {
      return "Der Eintrag wurde nicht gefunden.";
    }
    if (status === 409) {
      return "Der Vorgang steht im Konflikt mit dem aktuellen Datenstand.";
    }
    if (status === 413) {
      return "Die Datei ist zu groß.";
    }
    if (status === 429) {
      return "Nutzungslimit erreicht. Bitte später erneut versuchen.";
    }
    if (status >= 500) {
      return "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.";
    }
    return "Die Anfrage ist fehlgeschlagen.";
  }

  _errorText(error) {
    if (error instanceof ApiError) {
      if (error.status === 429) {
        return error.message || "Nutzungslimit erreicht. Bitte später erneut versuchen.";
      }
      return error.message || this._httpFallbackMessage(error.status);
    }
    return "Unerwarteter Fehler. Bitte erneut versuchen.";
  }

  _suggestionError(error) {
    if (error instanceof ApiError) {
      if (error.status === 429) {
        return "Das Nutzungslimit des KI-Anbieters ist erreicht. Bitte später erneut versuchen.";
      }
      if (error.status === 408 || error.status === 504) {
        return "Der KI-Anbieter hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.";
      }
      return error.message || "Der Beschreibungsvorschlag konnte nicht erstellt werden.";
    }
    return "Der Beschreibungsvorschlag konnte nicht erstellt werden.";
  }

  _canRefreshToken() {
    return typeof this.hass?.auth?.refreshAccessToken === "function";
  }

  /**
   * Erneuert den HA-Access-Token. Der Rückgabewert sagt nur, ob die
   * Erneuerung geklappt hat; der Aufrufer wiederholt die Anfrage dann genau
   * einmal und zeigt sonst die reguläre 401-Meldung.
   */
  async _refreshAccessToken() {
    if (!this._canRefreshToken()) {
      return false;
    }
    try {
      await this.hass.auth.refreshAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Nach einer erfolgreichen Token-Erneuerung die Zugriffsdaten einmal neu
   * laden, damit die Oberfläche ohne manuellen Reload weiterläuft. Das Flag
   * verhindert zusätzliche Durchläufe, wenn mehrere parallele Anfragen
   * gleichzeitig einen 401 gesehen haben.
   */
  _scheduleAccessRefresh() {
    if (this._accessRefreshScheduled) {
      return;
    }
    this._accessRefreshScheduled = true;
    setTimeout(() => {
      this._accessRefreshScheduled = false;
      if (this._accessState === "ready") {
        this._revalidateAccess();
      }
    }, 0);
  }

  /**
   * Zentrale HTTP-Schicht. Bevorzugt `hass.fetchWithAuth`, damit Home
   * Assistant die Anfrage signiert und abgelaufene Tokens erneuert; für ältere
   * HA-Versionen bleibt der rohe fetch-Fallback mit Bearer-Header erhalten.
   * Ein 401 löst genau eine Token-Erneuerung und genau einen Wiederholungs-
   * versuch aus; 403 (fehlende Berechtigung) wird nie wiederholt.
   */
  async _api(path, options = {}) {
    const { method = "GET", body, formData, timeoutMs = REQUEST_TIMEOUT_MS } = options;

    const token = this._token();
    if (!this.hass) {
      throw new ApiError("Home Assistant ist noch nicht verbunden. Bitte kurz warten.", 0, "no_hass");
    }
    if (!token) {
      throw new ApiError("Keine gültige Sitzung gefunden. Bitte die Seite neu laden.", 401, "no_token");
    }

    const controller = new AbortController();
    this._controllers.add(controller);
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const headers = {
      Accept: "application/json",
    };

    let payload;
    if (formData instanceof FormData) {
      payload = formData;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    // fetchWithAuth signiert selbst; nur der Fallback braucht den Bearer-Header.
    const authFetch =
      typeof this.hass.fetchWithAuth === "function" ? this.hass.fetchWithAuth.bind(this.hass) : null;

    const send = (useAuthFetch) => {
      const requestHeaders = { ...headers };
      if (!useAuthFetch) {
        requestHeaders.Authorization = `Bearer ${this._token()}`;
      }
      const init = {
        method,
        headers: requestHeaders,
        body: payload,
        signal: controller.signal,
        credentials: "same-origin",
      };
      // fetchWithAuth stellt die Instanz-URL selbst voran: nur relativer Pfad.
      const url = authRequestUrl(path, this._baseUrl(), useAuthFetch);
      return useAuthFetch ? authFetch(url, init) : fetch(url, init);
    };

    try {
      const useAuthFetch = Boolean(authFetch);
      let response = await send(useAuthFetch);
      let retried = false;

      if (shouldRefreshToken(response.status, retried) && this._canRefreshToken()) {
        if (await this._refreshAccessToken()) {
          retried = true;
          response = await send(useAuthFetch);
        }
      }
      if (response.ok && retried) {
        this._scheduleAccessRefresh();
      }

      if (!response.ok) {
        let message = "";
        let code = "";
        try {
          const data = await response.json();
          message = typeof data?.error?.message === "string" ? data.error.message : "";
          code = typeof data?.error?.code === "string" ? data.error.code : "";
        } catch {
          message = "";
        }
        throw new ApiError(message || this._httpFallbackMessage(response.status), response.status, code);
      }

      if (response.status === 204) {
        return null;
      }

      const text = await response.text();
      if (!text) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch (error) {
      if (timedOut) {
        throw new ApiError("Zeitüberschreitung bei der Serveranfrage. Bitte erneut versuchen.", 408, "timeout");
      }
      if (isAbortError(error) || error instanceof ApiError) {
        throw error;
      }
      throw new ApiError("Verbindung zum Server fehlgeschlagen. Bitte erneut versuchen.", 0, "network_error");
    } finally {
      clearTimeout(timeoutId);
      this._controllers.delete(controller);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Zugriff und Lebenszyklus der Daten                                     */
  /* --------------------------------------------------------------------- */

  _bootstrap() {
    if (!this.hass) {
      return;
    }
    if (!this._token()) {
      // Home Assistant liefert die Sitzung kurz nach dem ersten Render nach.
      return;
    }
    this._ensureFeatureSubscription();
    if (this._accessState !== "idle") {
      return;
    }
    this._loadMe();
  }

  _resetForUser() {
    for (const controller of this._controllers) {
      controller.abort();
    }
    this._controllers.clear();
    this._accessState = "idle";
    this._accessError = "";
    this._me = null;
    this._features = null;
    this._products = [];
    this._total = 0;
    this._allTags = [];
    this._menuOpen = false;
    this._detachMenuListeners();
    this._editor = null;
    this._archiveDialog = null;
    this._tagsDialog = null;
    this._importDialog = null;
    this._publishDialog = null;
    this._locations = [];
    this._locationsError = "";
    this._releaseImages();
    this._imageVersion += 1;
    this._bootstrap();
  }

  async _loadMe() {
    this._accessState = "loading";
    this._accessError = "";
    try {
      const me = await this._api(`${API_ROOT}/me`);
      const can = this._applyMe(me);

      if (can.product || can.app_admin) {
        this._accessState = "ready";
        if (can.product) {
          this._loadLocations();
          this._loadTags();
          this._loadProducts();
        }
      } else {
        this._accessState = "denied";
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (this._accessState === "loading") {
          this._accessState = "idle";
        }
        return;
      }
      this._accessError = this._errorText(error);
      this._accessState = error instanceof ApiError && error.status === 403 ? "denied" : "error";
    }
  }

  async _revalidateAccess() {
    if (this._accessState !== "ready" || !this.hass || !this._token()) {
      return;
    }
    try {
      const me = await this._api(`${API_ROOT}/me`);
      const can = this._applyMe(me);
      if (!can.product && !can.app_admin) {
        this._accessState = "denied";
        this._accessError = "";
        this._products = [];
        this._total = 0;
        this._allTags = [];
        this._menuOpen = false;
        this._detachMenuListeners();
        this._editor = null;
        this._archiveDialog = null;
        this._tagsDialog = null;
        this._importDialog = null;
        this._publishDialog = null;
        this._locations = [];
        return;
      }
      if (!can.product) {
        this._products = [];
        this._total = 0;
        this._allTags = [];
        this._menuOpen = false;
        this._detachMenuListeners();
        this._editor = null;
        this._archiveDialog = null;
        this._tagsDialog = null;
        this._importDialog = null;
        this._publishDialog = null;
        this._locations = [];
      } else {
        this._loadLocations();
        this._loadProducts();
        this._loadTags();
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        // Ein 401 ist eine abgelaufene Sitzung, keine fehlende Freigabe.
        this._accessState = error.status === 403 ? "denied" : "error";
        this._accessError = this._errorText(error);
        this._products = [];
        this._total = 0;
        this._allTags = [];
      }
    }
  }

  _retryAccess() {
    this._accessState = "idle";
    this._accessError = "";
    this._bootstrap();
  }

  _reloadAll() {
    if (!this._can("product")) {
      return;
    }
    this._releaseImages();
    this._imageVersion += 1;
    this._loadLocations();
    this._loadTags();
    this._loadProducts();
  }

  async _loadLocations() {
    if (!this._can("product")) {
      return;
    }
    try {
      const data = await this._api(`${API_ROOT}/locations`);
      this._locations = normalizeLocations(data);
      this._locationsError = "";
      if (this._locationFilter && !this._locations.some((entry) => entry.id === this._locationFilter)) {
        this._locationFilter = "";
        this._includeWithoutStock = false;
        this._offset = 0;
        this._loadProducts();
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      this._locationsError = this._errorText(error);
    }
  }

  _locationName(locationId) {
    return this._locations.find((entry) => entry.id === locationId)?.name || "";
  }

  _productStockEntries(product) {
    return this._locations.map((location) => ({
      id: location.id,
      name: location.name,
      value: Number(product?.stock?.[location.id]) || 0,
    }));
  }

  _productStockTotal(product) {
    return this._productStockEntries(product).reduce((sum, entry) => sum + entry.value, 0);
  }

  /* --------------------------------------------------------------------- */
  /* Produktliste und Filter                                                */
  /* --------------------------------------------------------------------- */

  async _loadProducts() {
    if (!this._can("product")) {
      return;
    }
    const requestId = ++this._productsRequestId;
    this._productsLoading = true;
    this._productsError = "";

    const params = new URLSearchParams();
    const search = this._search.trim();
    if (search) {
      params.set("search", search);
    }
    if (this._categoryFilter.length > 0) {
      params.set("category", this._categoryFilter.join(","));
    }
    if (this._tagFilter.length > 0) {
      params.set("tags", this._tagFilter.join(","));
    }
    if (this._customizableOnly) {
      params.set("customizable", "true");
    }
    if (this._locationFilter) {
      params.set("location", this._locationFilter);
      // Die Auswahl filtert immer nach Bestand; der Opt-out erweitert auf Produkte ohne Bestand.
      params.set("in_location", this._includeWithoutStock ? "false" : "true");
    }
    if (this._visibility !== "all") {
      params.set("visibility", this._visibility);
    }
    params.set("archived", this._showArchived ? "true" : "false");
    params.set("sort", this._sort);
    params.set("order", this._order);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(this._offset));

    try {
      const data = await this._api(`${API_ROOT}/products?${params.toString()}`);
      if (requestId !== this._productsRequestId) {
        return;
      }
      const products = Array.isArray(data?.products) ? data.products : [];
      this._products = products;
      this._total = Number.isFinite(Number(data?.total)) ? Number(data.total) : products.length;
    } catch (error) {
      if (isAbortError(error) || requestId !== this._productsRequestId) {
        return;
      }
      this._products = [];
      this._total = 0;
      this._productsError = this._errorText(error);
    } finally {
      if (requestId === this._productsRequestId) {
        this._productsLoading = false;
      }
    }
  }

  async _loadTags() {
    if (!this._can("product")) {
      return;
    }
    try {
      const data = await this._api(`${API_ROOT}/tags`);
      this._allTags = normalizeTagNames(data);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      // Die Tag-Liste ist nur Komfort. Fehler erscheinen im Tag-Dialog bzw. beim Speichern.
      this._allTags = [];
    }
  }

  _onSearchInput(value) {
    this._search = value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this._offset = 0;
      this._loadProducts();
    }, SEARCH_DEBOUNCE_MS);
  }

  _toggleFilterValue(field, value) {
    this[field] = toggleInList(this[field], value);
    this._offset = 0;
    this._loadProducts();
  }

  _setVisibility(value) {
    this._visibility = value;
    this._offset = 0;
    this._loadProducts();
  }

  _setFlag(field, value) {
    this[field] = Boolean(value);
    this._offset = 0;
    this._loadProducts();
  }

  _setLocationFilter(locationId) {
    this._locationFilter = locationId || "";
    if (!this._locationFilter) {
      this._includeWithoutStock = false;
    }
    this._offset = 0;
    this._loadProducts();
  }

  _setIncludeWithoutStock(value) {
    this._includeWithoutStock = Boolean(value) && Boolean(this._locationFilter);
    this._offset = 0;
    this._loadProducts();
  }

  _setView(view) {
    if (!VIEW_MODES.includes(view) || this._view === view) {
      return;
    }
    this._view = view;
    storeView(view);
  }

  _toggleFilters() {
    this._filtersOpen = !this._filtersOpen;
    storeFiltersOpen(this._filtersOpen);
  }

  _sortLabel() {
    return SORT_COLUMNS.find((column) => column.field === this._sort)?.label || "Name";
  }

  _setSortField(value) {
    if (!SORT_FIELDS.includes(value)) {
      return;
    }
    if (this._sort === value) {
      return;
    }
    this._sort = value;
    this._order = "asc";
    this._offset = 0;
    this._loadProducts();
  }

  /** Klick auf einen Spaltenkopf: neue Spalte aufsteigend, aktive Spalte dreht um. */
  _setSort(field) {
    if (!SORT_FIELDS.includes(field)) {
      return;
    }
    if (this._sort === field) {
      this._order = this._order === "asc" ? "desc" : "asc";
    } else {
      this._sort = field;
      this._order = "asc";
    }
    this._offset = 0;
    this._loadProducts();
  }

  _toggleSortOrder() {
    this._order = this._order === "asc" ? "desc" : "asc";
    this._offset = 0;
    this._loadProducts();
  }

  _changePage(delta) {
    const pages = Math.max(1, Math.ceil(this._total / PAGE_SIZE));
    const page = Math.floor(this._offset / PAGE_SIZE) + 1;
    const next = Math.min(Math.max(page + delta, 1), pages);
    if (next === page) {
      return;
    }
    this._offset = (next - 1) * PAGE_SIZE;
    this._loadProducts();
  }

  _hasActiveFilters() {
    return Boolean(
      this._search.trim() ||
        this._categoryFilter.length > 0 ||
        this._tagFilter.length > 0 ||
        this._customizableOnly ||
        // Eine Lagerstätte ist für sich ein aktiver Filter; der Opt-out allein nicht.
        Boolean(this._locationFilter) ||
        this._visibility !== "all" ||
        this._showArchived,
    );
  }

  _resetFilters() {
    this._search = "";
    this._categoryFilter = [];
    this._tagFilter = [];
    this._customizableOnly = false;
    this._locationFilter = "";
    this._includeWithoutStock = false;
    this._visibility = "all";
    this._showArchived = false;
    this._offset = 0;
    this._loadProducts();
  }

  _productImages(product) {
    return Array.isArray(product?.images) ? product.images.map(normalizeImage).filter(Boolean) : [];
  }

  _mainImage(product) {
    const images = this._productImages(product);
    return images.find((image) => image.is_main) || images[0] || null;
  }

  _productOversizedCount(product) {
    return this._productImages(product).filter((image) => image.oversized).length;
  }

  /** Gesamtgröße der Produktbilder für die Spalte „Größe“. */
  _productSizeLabel(product) {
    const images = this._productImages(product);
    if (images.length === 0) {
      return "—";
    }
    const bytes = images.reduce((total, image) => total + image.bytes, 0);
    return formatBytes(bytes);
  }

  /**
   * Der Dateiname bleibt beim Drehen unverändert. Ohne Versionsparameter
   * liefert der Browser weiterhin die alte Ausrichtung aus dem Cache.
   */
  _imageVersionQuery(image) {
    const mtime = Math.max(0, Math.trunc(Number(image?.mtime_ns) || 0));
    return mtime > 0 ? `v=${mtime}` : "";
  }

  _imageUrl(product, image) {
    if (!image) {
      return "";
    }
    const version = this._imageVersionQuery(image);
    if (image.url) {
      if (!version) {
        return image.url;
      }
      return `${image.url}${image.url.includes("?") ? "&" : "?"}${version}`;
    }
    if (image.name && product?.articleNumber) {
      const url = `${productPath(product.articleNumber)}/images/${encodeURIComponent(image.name)}`;
      return version ? `${url}?${version}` : url;
    }
    return "";
  }

  /**
   * Bilder liegen hinter einer bearer-geschuetzten Route. Ein reines
   * <img src> kann keinen Authorization-Header senden, deshalb werden die
   * Dateien einmalig mit Token geladen und als Object-URL zwischengespeichert.
   */
  _imageState(url) {
    const resolved = this._assetUrl(url);
    if (!resolved) {
      return { status: "empty", src: "" };
    }
    const entry = this._imageCache.get(resolved);
    if (entry) {
      return entry.status === "ready"
        ? { status: "ready", src: entry.objectUrl }
        : { status: "error", src: "" };
    }
    if (!this._imagePending.has(resolved) && this._token()) {
      queueMicrotask(() => this._loadImage(resolved));
    }
    return { status: "loading", src: "" };
  }

  _imageSrc(url) {
    return this._imageState(url).src;
  }

  async _loadImage(url) {
    if (!this.isConnected || this._imagePending.has(url) || this._imageCache.has(url)) {
      return;
    }
    const token = this._token();
    if (!token) {
      return;
    }
    this._imagePending.add(url);
    const controller = new AbortController();
    this._controllers.add(controller);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        // Nach dem Drehen darf keine zwischengespeicherte Antwort gewinnen.
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Bild konnte nicht geladen werden (${response.status}).`);
      }
      const blob = await response.blob();
      this._imageCache.set(url, { status: "ready", objectUrl: URL.createObjectURL(blob) });
      this._imageVersion += 1;
    } catch (error) {
      if (!isAbortError(error)) {
        this._imageCache.set(url, { status: "error", objectUrl: "" });
        this._imageVersion += 1;
      }
    } finally {
      this._imagePending.delete(url);
      this._controllers.delete(controller);
    }
  }

  _releaseImages() {
    for (const entry of this._imageCache.values()) {
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
    }
    this._imageCache.clear();
    this._imagePending.clear();
  }

  _showToast(message) {
    clearTimeout(this._toastTimer);
    this._toast = { message };
    this._toastTimer = setTimeout(() => {
      this._toast = null;
    }, TOAST_TIMEOUT_MS);
  }

  /* --------------------------------------------------------------------- */
  /* Fokus- und Dialogverwaltung                                            */
  /* --------------------------------------------------------------------- */

  _captureFocus() {
    try {
      const active = this.renderRoot?.activeElement;
      this._focusReturn = active && typeof active.focus === "function" ? active : null;
    } catch {
      this._focusReturn = null;
    }
  }

  _restoreFocus() {
    const target = this._focusReturn;
    this._focusReturn = null;
    this.updateComplete
      .then(() => {
        const element = target && target.isConnected
          ? target
          : this.renderRoot?.querySelector("#fd-main-heading");
        if (element && typeof element.focus === "function") {
          element.focus();
        }
      })
      .catch(() => {});
  }

  _syncDialogs() {
    const entries = [
      ["#fd-editor-dialog", Boolean(this._editor)],
      ["#fd-archive-dialog", Boolean(this._archiveDialog)],
      ["#fd-tags-dialog", Boolean(this._tagsDialog)],
      ["#fd-import-dialog", Boolean(this._importDialog)],
      ["#fd-publish-dialog", Boolean(this._publishDialog)],
    ];
    for (const [selector, shouldOpen] of entries) {
      const dialog = this.renderRoot?.querySelector(selector);
      if (!dialog || !shouldOpen || dialog.open) {
        continue;
      }
      try {
        dialog.showModal();
        const target = dialog.querySelector("[data-autofocus]");
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      } catch {
        // showModal kann fehlschlagen, wenn der Dialog bereits geschlossen wird.
      }
    }
  }

  _handleDialogCancel(event, close) {
    event.preventDefault();
    close();
  }

  _focusFirstInvalid(errors) {
    const firstKey = Object.keys(errors)[0];
    if (!firstKey) {
      return;
    }
    this.updateComplete
      .then(() => {
        const field = this.renderRoot?.querySelector(`[data-field="${firstKey}"]`);
        if (field && typeof field.focus === "function") {
          field.focus();
        }
      })
      .catch(() => {});
  }

  /* --------------------------------------------------------------------- */
  /* Produkt-Editor                                                         */
  /* --------------------------------------------------------------------- */

  _openCreate() {
    if (!this._can("product")) {
      return;
    }
    this._captureFocus();
    this._imagesRequestId += 1;
    this._bookingsRequestId += 1;
    this._editor = {
      mode: "create",
      articleNumber: "",
      name: "",
      description: "",
      category: CATEGORY_KEYS[0],
      price: "",
      size: "",
      tags: [],
      tagDraft: "",
      customizable: true,
      visible: true,
      archived: false,
      stock: this._initialStock(null),
      tab: "general",
      images: [],
      imagesLoading: false,
      imagesBusy: false,
      imagesError: "",
      imagesNotice: "",
      imagesCaptureNotice: "",
      imagesPendingDelete: null,
      imagesUploadResults: [],
      imagesOptimizeBusy: false,
      imagesOptimizeError: "",
      imagesOptimizeResult: null,
      bookings: [],
      bookingsLoading: false,
      bookingsLoaded: false,
      bookingsError: "",
      suggestion: null,
      suggestionInstructions: "",
      shake: false,
      createFlow: true,
      articlePreview: { loading: false, value: "", error: "" },
    };
    this._editorSnapshot = this._editorFormState(this._editor);
    this._loadArticlePreview(this._editor.category);
  }

  _initialStock(product) {
    const stock = {};
    const raw = product && typeof product.stock === "object" && product.stock !== null ? product.stock : null;
    this._locations.forEach((location, index) => {
      let value = raw ? Number(raw[location.id]) : 0;
      if (!raw && index === 0 && Number.isFinite(Number(product?.stock))) {
        value = Number(product.stock);
      }
      if (index === 1 && product?.salesCabinet != null) {
        value = Number(product.salesCabinet);
      }
      stock[location.id] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    });
    return stock;
  }

  _openEdit(product) {
    if (!this._can("product") || !product) {
      return;
    }
    this._captureFocus();
    this._imagesRequestId += 1;
    this._bookingsRequestId += 1;
    this._editor = {
      mode: "edit",
      articleNumber: product.articleNumber || "",
      name: typeof product.name === "string" ? product.name : "",
      description: typeof product.description === "string" ? product.description : "",
      category: product.category || "",
      price: this._formatPriceInput(product.price),
      size: typeof product.size === "string" ? product.size : "",
      tags: Array.isArray(product.tags) ? [...product.tags] : [],
      tagDraft: "",
      customizable: Boolean(product.customizable),
      visible: product.visible !== false,
      archived: Boolean(product.archived),
      stock: this._initialStock(product),
      tab: "general",
      images: [],
      imagesLoading: false,
      imagesBusy: false,
      imagesError: "",
      imagesNotice: "",
      imagesCaptureNotice: "",
      imagesPendingDelete: null,
      imagesUploadResults: [],
      imagesOptimizeBusy: false,
      imagesOptimizeError: "",
      imagesOptimizeResult: null,
      bookings: [],
      bookingsLoading: false,
      bookingsLoaded: false,
      bookingsError: "",
      suggestion: null,
      suggestionInstructions: "",
      shake: false,
      createFlow: false,
      articlePreview: { loading: false, value: product.articleNumber || "", error: "" },
    };
    this._editorSnapshot = this._editorFormState(this._editor);
  }

  /**
   * Holt die voraussichtliche Artikelnummer für eine Kategorie. Die Nummer ist
   * bewusst nicht reserviert; verbindlich ist erst die Antwort von POST /products.
   */
  async _loadArticlePreview(category) {
    const editor = this._editor;
    if (!editor || editor.mode !== "create") {
      return;
    }
    const requestId = ++this._articlePreviewRequestId;

    if (!CATEGORY_LABELS[category]) {
      this._patchEditor({
        articlePreview: { loading: false, value: "", error: "Bitte eine Kategorie auswählen." },
      });
      return;
    }

    this._patchEditor({ articlePreview: { loading: true, value: "", error: "" } });

    try {
      const data = await this._api(
        `${API_ROOT}/products/article-number?category=${encodeURIComponent(category)}`,
      );
      if (requestId !== this._articlePreviewRequestId) {
        return;
      }
      if (!this._editor || this._editor.mode !== "create") {
        return;
      }
      const value = typeof data?.articleNumber === "string" ? data.articleNumber.trim() : "";
      this._patchEditor({
        articlePreview: {
          loading: false,
          value,
          error: value ? "" : "Es wurde keine Artikelnummer geliefert.",
        },
      });
    } catch (error) {
      if (isAbortError(error) || requestId !== this._articlePreviewRequestId) {
        return;
      }
      if (!this._editor || this._editor.mode !== "create") {
        return;
      }
      this._patchEditor({
        articlePreview: { loading: false, value: "", error: this._errorText(error) },
      });
    }
  }

  _setEditorCategory(value) {
    if (!this._editor) {
      return;
    }
    this._setEditorField("category", value);
    this._loadArticlePreview(value);
  }

  _nextEditorTab(tab) {
    const index = EDITOR_TABS.indexOf(tab);
    if (index < 0 || index >= EDITOR_TABS.length - 1) {
      return EDITOR_TABS[EDITOR_TABS.length - 1];
    }
    return EDITOR_TABS[index + 1];
  }

  _editorFormState(editor) {
    return JSON.stringify({
      name: editor.name,
      description: editor.description,
      category: editor.category,
      price: editor.price,
      size: editor.size,
      tags: editor.tags,
      customizable: editor.customizable,
      visible: editor.visible,
      stock: editor.stock,
    });
  }

  _editorHasChanges() {
    if (!this._editor) {
      return false;
    }
    return this._editorSnapshot !== this._editorFormState(this._editor);
  }

  _shakeEditor() {
    if (!this._editor) {
      return;
    }
    clearTimeout(this._editorShakeTimer);
    this._patchEditor({ shake: true });
    this._editorShakeTimer = setTimeout(() => {
      if (this._editor) {
        this._patchEditor({ shake: false });
      }
    }, 600);
  }

  _closeEditor({ force = false } = {}) {
    if (this._editor?.saving) {
      return;
    }
    if (!force && this._editorHasChanges()) {
      this._shakeEditor();
      return;
    }
    clearTimeout(this._editorShakeTimer);
    this._editorSnapshot = "";
    this._articlePreviewRequestId += 1;
    this._imagesRequestId += 1;
    this._bookingsRequestId += 1;
    this._editor = null;
    this._restoreFocus();
  }

  _discardEditor() {
    this._closeEditor({ force: true });
  }

  _patchEditor(patch) {
    if (!this._editor) {
      return;
    }
    this._editor = { ...this._editor, ...patch };
  }

  _setEditorField(field, value) {
    const editor = this._editor;
    if (!editor) {
      return;
    }
    const fieldErrors = { ...editor.fieldErrors };
    delete fieldErrors[field];
    this._editor = { ...editor, [field]: value, fieldErrors, error: "" };
  }

  _formatPriceInput(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return "";
    }
    return number.toFixed(2).replace(".", ",");
  }

  _parsePrice(raw) {
    const text = String(raw ?? "")
      .trim()
      .replace(/\s/g, "")
      .replace("€", "");
    if (!text) {
      return null;
    }
    let normalized = text;
    if (text.includes(",") && text.includes(".")) {
      normalized = text.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = text.replace(",", ".");
    }
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
      return null;
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }

  _validateEditor(editor) {
    const errors = {};
    const name = editor.name.trim();
    if (!name) {
      errors.name = "Bitte einen Namen angeben.";
    } else if (name.length > 200) {
      errors.name = "Der Name darf höchstens 200 Zeichen enthalten.";
    }

    if (editor.mode === "create" && !CATEGORY_LABELS[editor.category]) {
      errors.category = "Bitte eine Kategorie auswählen.";
    }

    if (!String(editor.price).trim()) {
      errors.price = "Bitte einen Preis angeben.";
    } else if (this._parsePrice(editor.price) === null) {
      errors.price = "Bitte einen gültigen Preis angeben, zum Beispiel 12,50.";
    }

    const price = this._parsePrice(editor.price);
    if (price !== null && price > 1000000) {
      errors.price = "Der Preis ist unrealistisch hoch.";
    }
    if (editor.size.trim().length > 200) {
      errors.size = "Die Größe darf höchstens 200 Zeichen enthalten.";
    }
    if (editor.description.length > 20000) {
      errors.description = "Die Beschreibung darf höchstens 20000 Zeichen enthalten.";
    }
    return errors;
  }

  _addEditorTag(rawName) {
    const editor = this._editor;
    if (!editor) {
      return;
    }
    const name = String(rawName ?? "").trim();
    if (!name) {
      return;
    }
    if (editor.tags.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      this._patchEditor({ error: `Der Tag „${name}“ ist bereits gesetzt.`, tagDraft: "" });
      return;
    }
    this._patchEditor({ tags: [...editor.tags, name], tagDraft: "", error: "" });
  }

  _removeEditorTag(name) {
    const editor = this._editor;
    if (!editor) {
      return;
    }
    this._patchEditor({ tags: editor.tags.filter((tag) => tag !== name), error: "" });
  }

  async _saveEditor(event) {
    event?.preventDefault();
    const editor = this._editor;
    if (!editor || editor.saving) {
      return;
    }

    const fieldErrors = this._validateEditor(editor);
    if (Object.keys(fieldErrors).length > 0) {
      const firstField = Object.keys(fieldErrors)[0];
      const targetTab = EDITOR_FIELD_TABS[firstField];
      const patch = {
        fieldErrors,
        error: "Bitte die markierten Felder prüfen.",
      };
      // Der Fehler kann auf einem gerade verborgenen Tab liegen: dorthin wechseln.
      if (targetTab && targetTab !== editor.tab) {
        patch.tab = targetTab;
      }
      this._patchEditor(patch);
      this._focusFirstInvalid(fieldErrors);
      return;
    }

    const payload = {
      name: editor.name.trim(),
      description: editor.description.trim(),
      price: this._parsePrice(editor.price),
      size: editor.size.trim(),
      tags: [...editor.tags],
      customizable: editor.customizable,
      visible: editor.visible,
      stock: { ...editor.stock },
    };
    const isCreate = editor.mode === "create";
    // Im Anlege-Ablauf führt „Weiter“ zum nächsten Tab, „Speichern“ (letzter Tab) schließt.
    const staysOpen = editor.createFlow && editor.tab !== "stock";

    this._patchEditor({ saving: true, error: "", fieldErrors: {} });

    try {
      if (isCreate) {
        const created = await this._api(`${API_ROOT}/products`, {
          method: "POST",
          body: { ...payload, category: editor.category },
        });
        const articleNumber = typeof created?.articleNumber === "string" ? created.articleNumber : "";
        this._loadProducts();
        this._loadTags();

        if (!articleNumber) {
          this._editor = null;
          this._showToast("Produkt wurde erstellt.");
          this._restoreFocus();
          return;
        }

        // Ab jetzt existiert das Produkt: Badge zeigt die verbindliche Nummer aus
        // der Server-Antwort, die Vorschau ist erledigt.
        this._articlePreviewRequestId += 1;

        if (editor.tab === "stock") {
          this._editor = null;
          this._showToast(`Produkt wurde erstellt (${articleNumber}).`);
          this._restoreFocus();
          return;
        }

        this._advanceEditorTab(editor.tab, {
          mode: "edit",
          createFlow: true,
          articleNumber,
          articlePreview: { loading: false, value: articleNumber, error: "" },
        });
        this._showToast(`Produkt wurde erstellt (${articleNumber}).`);
        return;
      }

      await this._api(productPath(editor.articleNumber), {
        method: "PATCH",
        body: payload,
      });
      this._loadProducts();
      this._loadTags();

      if (staysOpen) {
        this._advanceEditorTab(editor.tab, {});
        return;
      }

      this._editor = null;
      this._showToast("Produkt wurde gespeichert.");
      this._restoreFocus();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ saving: false });
        return;
      }
      this._patchEditor({ saving: false, error: this._errorText(error) });
    }
  }

  _advanceEditorTab(fromTab, patch = {}) {
    if (!this._editor) {
      return;
    }
    const next = this._nextEditorTab(fromTab);
    this._patchEditor({ ...patch, tab: next, saving: false });
    this._editorSnapshot = this._editorFormState(this._editor);
    this._loadEditorTabData(next);
  }

  _loadEditorTabData(tab) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || !editor.articleNumber) {
      return;
    }
    if (tab === "images" && editor.images.length === 0 && !editor.imagesLoading) {
      this._loadImages(editor.articleNumber);
    }
    if (tab === "stock" && !editor.bookingsLoaded) {
      this._loadBookings(editor.articleNumber);
    }
  }

  async _suggestDescription() {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || editor.suggestion?.loading) {
      return;
    }
    const instructions = String(editor.suggestionInstructions ?? "").trim();
    this._patchEditor({
      suggestion: {
        loading: true,
        error: "",
        text: "",
        tags: [],
        rejectedTags: [],
        instructionsUsed: false,
      },
    });
    try {
      const data = await this._api(`${productPath(editor.articleNumber)}/description/suggest`, {
        method: "POST",
        body: instructions ? { instructions } : {},
      });
      const text = typeof data?.suggestion === "string" ? data.suggestion.trim() : "";
      if (!text) {
        throw new ApiError("Es wurde kein Vorschlag geliefert. Bitte erneut versuchen.", 0, "empty_suggestion");
      }
      const known = new Set((this._allTags || []).map((tag) => tag.toLocaleLowerCase("de")));
      const tags = Array.isArray(data?.tags)
        ? data.tags
            .filter(
              (tag) =>
                typeof tag === "string" &&
                (known.size === 0 || known.has(tag.toLocaleLowerCase("de"))),
            )
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];
      const rejectedTags = Array.isArray(data?.rejected_tags)
        ? data.rejected_tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim())
        : [];
      this._patchEditor({
        suggestion: {
          loading: false,
          error: "",
          text,
          tags,
          rejectedTags,
          instructionsUsed: Boolean(data?.instructions_used),
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ suggestion: null });
        return;
      }
      this._patchEditor({
        suggestion: {
          loading: false,
          error: this._suggestionError(error),
          text: "",
          tags: [],
          rejectedTags: [],
          instructionsUsed: false,
        },
      });
    }
  }

  _patchSuggestion(text) {
    const editor = this._editor;
    if (!editor?.suggestion) {
      return;
    }
    this._editor = { ...editor, suggestion: { ...editor.suggestion, text } };
  }

  _addSuggestedTag(tag) {
    const editor = this._editor;
    if (!editor || typeof tag !== "string" || !tag.trim()) {
      return;
    }
    const known = new Set((this._allTags || []).map((entry) => entry.toLocaleLowerCase("de")));
    if (known.size > 0 && !known.has(tag.toLocaleLowerCase("de"))) {
      this._patchEditor({ error: `Der Tag „${tag}“ existiert nicht und kann nicht übernommen werden.` });
      return;
    }
    if (editor.tags.some((entry) => entry.toLocaleLowerCase("de") === tag.toLocaleLowerCase("de"))) {
      return;
    }
    this._patchEditor({ tags: [...editor.tags, tag], error: "" });
    this._showToast(`Tag „${tag}“ übernommen.`);
  }

  _applySuggestedTags() {
    const editor = this._editor;
    const suggested = editor?.suggestion?.tags;
    if (!editor || !Array.isArray(suggested) || suggested.length === 0) {
      return;
    }
    const known = new Set((this._allTags || []).map((entry) => entry.toLocaleLowerCase("de")));
    const additions = suggested.filter(
      (tag) =>
        (known.size === 0 || known.has(tag.toLocaleLowerCase("de"))) &&
        !editor.tags.some((entry) => entry.toLocaleLowerCase("de") === tag.toLocaleLowerCase("de")),
    );
    if (additions.length === 0) {
      this._showToast("Alle vorgeschlagenen Tags sind bereits gesetzt.");
      return;
    }
    this._patchEditor({ tags: [...editor.tags, ...additions], error: "" });
    this._showToast(
      additions.length === 1 ? "Vorgeschlagener Tag übernommen." : `${additions.length} Tags übernommen.`,
    );
  }

  _applySuggestion() {
    const editor = this._editor;
    if (!editor?.suggestion) {
      return;
    }
    this._patchEditor({ description: editor.suggestion.text, suggestion: null });
    this._showToast("Vorschlag übernommen. Bitte noch speichern.");
  }

  _discardSuggestion() {
    if (!this._editor?.suggestion) {
      return;
    }
    this._patchEditor({ suggestion: null });
  }

  /* --------------------------------------------------------------------- */
  /* Bilder (Tab im Produktdialog)                                          */
  /* --------------------------------------------------------------------- */

  _imageBusy() {
    const editor = this._editor;
    return Boolean(
      editor && (editor.imagesBusy || editor.imagesLoading || editor.imagesOptimizeBusy),
    );
  }

  _oversizedCount(images) {
    return (Array.isArray(images) ? images : []).filter((image) => image?.oversized).length;
  }

  _oversizedTitle(image) {
    const details = [formatDimensions(image?.width, image?.height), image?.bytes ? formatBytes(image.bytes) : ""]
      .filter(Boolean)
      .join(", ");
    return `Bild ist zu groß${details ? `: ${details}` : ""}. Empfohlen: max. 1600 px und 400 KB.`;
  }

  _focusImageResult(id) {
    this.updateComplete
      .then(() => this.renderRoot?.querySelector(`#${id}`)?.focus?.())
      .catch(() => {});
  }

  _uploadResult(file, data, previousNames) {
    const images = Array.isArray(data?.images) ? data.images.map(normalizeImage).filter(Boolean) : [];
    const added = images.filter((image) => image.name && !previousNames.has(image.name));
    const stored = data?.stored && typeof data.stored === "object" ? data.stored : null;
    const sizeText = formatImageMeta(stored || {});
    const resized = Boolean(data?.resized);
    const serverMessage = typeof data?.optimize_message === "string" ? data.optimize_message.trim() : "";
    // GIF und animiertes WebP bleiben absichtlich unverändert; das steht in der Servermeldung.
    const passedThrough = !resized && serverMessage && !serverMessage.startsWith("Bild unverändert");
    return {
      name: added[added.length - 1]?.name || file?.name || "",
      resized,
      message: resized
        ? serverMessage || `Bild wurde verkleinert${sizeText ? ` (${sizeText})` : ""}.`
        : passedThrough
          ? serverMessage
          : `Bild war bereits passend${sizeText ? ` (${sizeText})` : ""} – keine Verkleinerung nötig.`,
    };
  }

  _applyOptimizePayload(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    const summary = data?.summary && typeof data.summary === "object" ? data.summary : {};
    const items = results
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        message:
          (typeof entry.error === "string" && entry.error.trim()) ||
          (typeof entry.message === "string" && entry.message.trim()) ||
          (entry.resized ? "Bild wurde verkleinert." : "Bild war bereits passend."),
        error: typeof entry.error === "string" ? entry.error.trim() : "",
      }));
    const changed = results.filter((entry) => entry?.resized).length;
    const bytesBefore = Math.max(0, Number(summary.bytes_before) || 0);
    const bytesAfter = Math.max(0, Number(summary.bytes_after) || 0);
    const savedBytes = Math.max(0, bytesBefore - bytesAfter);
    const summaryText =
      changed > 0
        ? `${formatNumber(changed)} ${changed === 1 ? "Bild" : "Bilder"} optimiert, ` +
          `${formatBytes(savedBytes)} gespart (${formatPercent(summary.saved_percent)} %).`
        : "Nichts zu tun – alle Bilder passen bereits.";
    const patch = {
      imagesOptimizeBusy: false,
      imagesOptimizeError: "",
      imagesOptimizeResult: { items, summaryText, changed },
    };
    if (Array.isArray(data?.images)) {
      patch.images = data.images.map(normalizeImage).filter(Boolean);
      patch.imagesLoading = false;
    }
    this._patchEditor(patch);
  }

  async _optimizeImages() {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy() || !editor.articleNumber) {
      return;
    }
    this._patchEditor({
      imagesOptimizeBusy: true,
      imagesOptimizeError: "",
      imagesOptimizeResult: null,
      imagesError: "",
      imagesNotice: "",
    });
    try {
      const data = await this._api(`${productPath(editor.articleNumber)}/images/optimize`, {
        method: "POST",
      });
      if (!this._editor) {
        return;
      }
      this._applyOptimizePayload(data);
      this._focusImageResult("fd-optimize-result");
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesOptimizeBusy: false });
        return;
      }
      this._patchEditor({
        imagesOptimizeBusy: false,
        imagesOptimizeError: this._errorText(error),
      });
    }
  }

  _canManageImages() {
    return Boolean(this._editor && this._editor.mode === "edit" && this._editor.articleNumber);
  }

  /** Öffnet den Produktdialog direkt im Bilder-Tab (Ziel des Warnzeichens). */
  _openImagesFor(product) {
    if (!this._can("product") || !product) {
      return;
    }
    this._openEdit(product);
    if (!this._editor) {
      return;
    }
    this._patchEditor({ tab: "images" });
    this._loadEditorTabData("images");
  }

  async _loadImages(articleNumber) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || editor.articleNumber !== articleNumber) {
      return;
    }
    const requestId = ++this._imagesRequestId;
    this._patchEditor({ imagesLoading: true, imagesError: "" });
    try {
      const data = await this._api(`${productPath(articleNumber)}/images`);
      if (requestId !== this._imagesRequestId) {
        return;
      }
      const current = this._editor;
      if (!current || current.mode !== "edit" || current.articleNumber !== articleNumber) {
        return;
      }
      const images = Array.isArray(data?.images) ? data.images.map(normalizeImage).filter(Boolean) : [];
      this._patchEditor({ images, imagesLoading: false });
    } catch (error) {
      if (isAbortError(error) || requestId !== this._imagesRequestId) {
        return;
      }
      if (!this._editor) {
        return;
      }
      this._patchEditor({ imagesLoading: false, imagesError: this._errorText(error) });
    }
  }

  async _onImagesSelected(event) {
    const input = event.target;
    const files = Array.from(input?.files ?? []);
    if (input) {
      input.value = "";
    }
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy() || files.length === 0) {
      return;
    }

    if (editor.images.length + files.length > MAX_IMAGES) {
      const free = Math.max(MAX_IMAGES - editor.images.length, 0);
      this._patchEditor({
        imagesError:
          `Maximal ${MAX_IMAGES} Bilder pro Produkt. Es sind bereits ${editor.images.length} Bilder hinterlegt ` +
          `und nur noch ${free} ${free === 1 ? "Platz" : "Plätze"} frei. Es wurde nichts hochgeladen.`,
        imagesNotice: "",
        imagesPendingDelete: null,
      });
      return;
    }

    const articleNumber = editor.articleNumber;
    const previousNames = new Set(editor.images.map((image) => image.name));
    const results = [];
    this._patchEditor({
      imagesBusy: true,
      imagesError: "",
      imagesNotice: "",
      imagesPendingDelete: null,
      imagesUploadResults: [],
      imagesOptimizeResult: null,
      imagesOptimizeError: "",
    });

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file, file.name);
        const data = await this._api(`${productPath(articleNumber)}/images`, { method: "POST", formData });
        results.push(this._uploadResult(file, data, previousNames));
        for (const image of Array.isArray(data?.images) ? data.images : []) {
          if (image?.name) {
            previousNames.add(image.name);
          }
        }
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({
          imagesBusy: false,
          imagesUploadResults: results,
          imagesNotice:
            files.length === 1 ? "Bild wurde hochgeladen." : `${files.length} Bilder wurden hochgeladen.`,
        });
        if (this._editor.images.length >= MAX_IMAGES) {
          // Das Eingabefeld wird jetzt deaktiviert; der Fokus wandert zum Ergebnis.
          this._focusImageResult("fd-upload-result");
        }
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesBusy: false });
        return;
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({
          imagesBusy: false,
          imagesUploadResults: results,
          imagesError: `${this._errorText(error)} Bereits übertragene Bilder bleiben erhalten.`,
        });
      }
    }
  }

  _openCapture() {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy()) {
      return;
    }
    const unavailable =
      "Kamera nicht verfügbar. Bitte die Kamera-Berechtigung der Home-Assistant-App in den " +
      "Systemeinstellungen prüfen.";
    const input = this.renderRoot?.querySelector("#fd-image-capture");
    if (!input) {
      this._patchEditor({ imagesCaptureNotice: "", imagesError: unavailable });
      return;
    }
    this._patchEditor({ imagesCaptureNotice: "", imagesError: "" });
    try {
      input.click();
    } catch {
      this._patchEditor({ imagesError: unavailable });
    }
  }

  async _onCaptureSelected(event) {
    const input = event.target;
    const file = input?.files?.[0] ?? null;
    if (input) {
      // Ohne den Reset feuert `change` bei gleichem Dateinamen kein zweites Mal.
      input.value = "";
    }
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy()) {
      return;
    }
    if (!file) {
      this._patchEditor({ imagesCaptureNotice: "Es wurde kein Foto aufgenommen." });
      return;
    }
    const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
    const name = typeof file.name === "string" ? file.name : "";
    if (type.startsWith("image/heic") || type.startsWith("image/heif") || /\.(heic|heif)$/i.test(name)) {
      this._patchEditor({
        imagesCaptureNotice: "",
        imagesError:
          "Dieses Bildformat wird nicht unterstützt. Bitte ein Foto aufnehmen oder als JPEG hochladen.",
      });
      return;
    }
    this._patchEditor({ imagesCaptureNotice: "", imagesError: "" });
    // Kein DataTransfer: ältere WKWebView-Versionen können daraus keine FileList bauen.
    const normalized = new File([file], name || "aufnahme.jpg", {
      type: "image/jpeg",
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
    });
    await this._onImagesSelected({ target: { files: [normalized], value: "" } });
  }

  _onCaptureCancelled() {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit") {
      return;
    }
    this._patchEditor({ imagesCaptureNotice: "Es wurde kein Foto aufgenommen." });
  }

  async _moveImage(index, delta) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy()) {
      return;
    }
    const target = index + delta;
    if (target < 0 || target >= editor.images.length) {
      return;
    }
    const images = [...editor.images];
    const [moved] = images.splice(index, 1);
    if (!moved) {
      return;
    }
    images.splice(target, 0, moved);

    const articleNumber = editor.articleNumber;
    this._patchEditor({
      images,
      imagesBusy: true,
      imagesError: "",
      imagesNotice: "",
      imagesPendingDelete: null,
    });

    try {
      await this._api(`${productPath(articleNumber)}/images/order`, {
        method: "POST",
        body: { order: images.map((image) => image.name) },
      });
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesNotice: "Reihenfolge gespeichert." });
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesBusy: false });
        return;
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesError: this._errorText(error) });
      }
    }
  }

  async _setMainImage(name) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy() || !name) {
      return;
    }
    const articleNumber = editor.articleNumber;
    this._patchEditor({
      imagesBusy: true,
      imagesError: "",
      imagesNotice: "",
      imagesPendingDelete: null,
    });

    try {
      await this._api(`${productPath(articleNumber)}/images/main`, {
        method: "POST",
        body: { name },
      });
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesNotice: "Hauptbild gespeichert." });
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesBusy: false });
        return;
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesError: this._errorText(error) });
      }
    }
  }

  /**
   * Verwirft die zwischengespeicherten Object-URLs eines Bildes. Der Name bleibt
   * beim Drehen gleich, deshalb reicht es nicht, nur die neue Version zu laden:
   * der alte Eintrag würde die alte Ausrichtung weiter anzeigen.
   */
  _forgetImage(name) {
    const suffix = `/images/${encodeURIComponent(name)}`;
    for (const [url, entry] of [...this._imageCache]) {
      if (!url.includes(suffix)) {
        continue;
      }
      if (entry.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
      this._imageCache.delete(url);
    }
    this._imageVersion += 1;
  }

  /** Nach dem Re-Render zurück zum selben Drehknopf; deaktivierte Knöpfe verlieren den Fokus. */
  _focusRotateButton(name, direction) {
    const selector = rotateTargetSelector(name, direction);
    if (!selector) {
      return;
    }
    this.updateComplete
      .then(() => this.renderRoot?.querySelector(selector)?.focus?.())
      .catch(() => {});
  }

  async _rotateImage(name, direction) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy() || !name) {
      return;
    }
    const rotation = normalizeRotateDirection(direction);
    const image = editor.images.find((entry) => entry.name === name);
    if (!rotation || !canRotateImage(image, { mode: editor.mode })) {
      return;
    }
    const articleNumber = editor.articleNumber;
    this._patchEditor({
      imagesBusy: true,
      imagesError: "",
      imagesNotice: "",
      imagesPendingDelete: null,
    });

    try {
      await this._api(
        `${productPath(articleNumber)}/images/${encodeURIComponent(name)}/rotate`,
        { method: "POST", body: { direction: rotation } },
      );
      // Erst den alten Cache verwerfen, dann die Metadaten (neue `mtime_ns`) laden.
      this._forgetImage(name);
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesNotice: rotateNoticeText(rotation) });
        this._focusRotateButton(name, rotation);
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesBusy: false });
        return;
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesError: this._errorText(error) });
      }
    }
  }

  _requestDeleteImage(name) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy()) {
      return;
    }
    this._patchEditor({
      imagesPendingDelete: editor.imagesPendingDelete === name ? null : name,
      imagesError: "",
      imagesNotice: "",
    });
  }

  async _deleteImage(name) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy() || !name) {
      return;
    }
    const articleNumber = editor.articleNumber;
    this._patchEditor({
      imagesBusy: true,
      imagesError: "",
      imagesPendingDelete: null,
    });

    try {
      await this._api(`${productPath(articleNumber)}/images/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesNotice: "Bild wurde gelöscht." });
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        this._patchEditor({ imagesBusy: false });
        return;
      }
      await this._loadImages(articleNumber);
      if (this._editor) {
        this._patchEditor({ imagesBusy: false, imagesError: this._errorText(error) });
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Bestand (Tab im Produktdialog)                                         */
  /* --------------------------------------------------------------------- */

  _stockValue(editor, locationId) {
    const value = Number(editor?.stock?.[locationId]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }

  _setStockValue(locationId, rawValue) {
    const editor = this._editor;
    if (!editor || !locationId) {
      return;
    }
    const parsed = Number(String(rawValue ?? "").trim());
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
    this._patchEditor({
      stock: { ...editor.stock, [locationId]: value },
      fieldErrors: { ...editor.fieldErrors },
      error: "",
    });
  }

  _stepStock(locationId, delta) {
    const editor = this._editor;
    if (!editor || !locationId) {
      return;
    }
    const next = Math.max(0, this._stockValue(editor, locationId) + delta);
    this._patchEditor({ stock: { ...editor.stock, [locationId]: next }, error: "" });
  }

  _bookingTypeLabel(type) {
    return BOOKING_TYPE_LABELS[type] || type || "Buchung";
  }

  async _loadBookings(articleNumber) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || editor.articleNumber !== articleNumber) {
      return;
    }
    const requestId = ++this._bookingsRequestId;
    this._patchEditor({ bookingsLoading: true, bookingsError: "" });
    try {
      const data = await this._api(`${productPath(articleNumber)}/stock`);
      if (requestId !== this._bookingsRequestId) {
        return;
      }
      const current = this._editor;
      if (!current || current.articleNumber !== articleNumber) {
        return;
      }
      const bookings = Array.isArray(data?.bookings)
        ? data.bookings.map(normalizeBooking).filter(Boolean)
        : [];
      this._patchEditor({ bookings, bookingsLoading: false, bookingsLoaded: true });
    } catch (error) {
      if (isAbortError(error) || requestId !== this._bookingsRequestId) {
        return;
      }
      if (!this._editor) {
        return;
      }
      this._patchEditor({ bookingsLoading: false, bookingsError: this._errorText(error) });
    }
  }

  _setEditorTab(tab) {
    const editor = this._editor;
    if (!editor || !EDITOR_TABS.includes(tab) || editor.tab === tab) {
      return;
    }
    this._patchEditor({ tab });
    this._loadEditorTabData(tab);
  }

  _onEditorTabKeydown(event) {
    const tabs = EDITOR_TABS;
    const currentIndex = tabs.indexOf(this._editor?.tab || "general");
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = tabs[nextIndex];
    this._setEditorTab(next);
    this.updateComplete
      .then(() => {
        this.renderRoot?.querySelector(`#fd-editor-tab-${next}`)?.focus?.();
      })
      .catch(() => {});
  }

  /* --------------------------------------------------------------------- */
  /* Archivierung (nur Soft-Delete)                                         */
  /* --------------------------------------------------------------------- */

  _requestArchive(product) {
    if (!this._can("product") || !product || product.archived) {
      return;
    }
    this._captureFocus();
    this._archiveDialog = { product, saving: false, error: "" };
  }

  _closeArchive() {
    if (this._archiveDialog?.saving) {
      return;
    }
    this._archiveDialog = null;
    this._restoreFocus();
  }

  async _confirmArchive() {
    const dialog = this._archiveDialog;
    if (!dialog || dialog.saving) {
      return;
    }
    this._archiveDialog = { ...dialog, saving: true, error: "" };

    try {
      await this._api(`${productPath(dialog.product.articleNumber)}/archive`, { method: "POST" });
      this._archiveDialog = null;
      this._showToast("Produkt wurde archiviert. Die Daten bleiben erhalten.");
      this._restoreFocus();
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (!this._archiveDialog) {
        return;
      }
      this._archiveDialog = { ...this._archiveDialog, saving: false, error: this._errorText(error) };
    }
  }

  /* --------------------------------------------------------------------- */
  /* Katalogimport von frickeldave.de                                       */
  /* --------------------------------------------------------------------- */

  _openImport() {
    if (!this._can("product")) {
      return;
    }
    const feature = this._featureInfo("import");
    if (!feature.available) {
      this._showToast(this._featureHint(feature, "Der Katalogimport"));
      return;
    }
    this._captureFocus();
    this._importDialog = {
      phase: "confirm",
      busy: false,
      error: "",
      result: null,
      overwrite: false,
      preview: null,
      previewLoading: true,
      previewError: "",
    };
    this._loadImportPreview();
  }

  _closeImport() {
    if (this._importDialog?.busy) {
      return;
    }
    this._importPreviewRequestId += 1;
    this._importDialog = null;
    this._restoreFocus();
  }

  _toggleImportOverwrite(value) {
    const dialog = this._importDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    this._importDialog = { ...dialog, overwrite: Boolean(value), error: "" };
    // Die Vorschau hängt vom Überschreiben ab: mit denselben Optionen neu laden.
    this._loadImportPreview();
  }

  _resetImportPreview() {
    const dialog = this._importDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    this._importDialog = { ...dialog, phase: "confirm", result: null, error: "" };
    this._loadImportPreview();
  }

  async _loadImportPreview() {
    const dialog = this._importDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    const requestId = ++this._importPreviewRequestId;
    const overwrite = Boolean(dialog.overwrite);
    this._importDialog = { ...dialog, previewLoading: true, previewError: "", error: "" };

    try {
      const data = await this._api(`${API_ROOT}/features/import`, {
        method: "POST",
        body: { dry_run: true, overwrite, import_images: true },
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      if (requestId !== this._importPreviewRequestId || !this._importDialog) {
        return;
      }
      this._importDialog = {
        ...this._importDialog,
        preview: this._normalizeImportResult(data),
        previewLoading: false,
        previewError: "",
      };
    } catch (error) {
      if (isAbortError(error) || requestId !== this._importPreviewRequestId) {
        return;
      }
      if (!this._importDialog) {
        return;
      }
      this._importDialog = {
        ...this._importDialog,
        previewLoading: false,
        preview: null,
        previewError: this._importErrorText(error),
      };
      if (isFeatureError(error)) {
        this._reloadFeatures();
      }
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        this._revalidateAccess();
      }
    }
  }

  _focusImport(selector) {
    this.updateComplete
      .then(() => {
        const target = this.renderRoot?.querySelector(selector);
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      })
      .catch(() => {});
  }

  _featureErrorText(error, action) {
    if (!(error instanceof ApiError)) {
      return "";
    }
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (error.code === "feature_unavailable") {
      return message || `${action} ist derzeit nicht verfügbar.`;
    }
    if (error.code === "not_registered") {
      return message || `${action} ist nicht eingerichtet. Bitte die Erweiterung installieren.`;
    }
    if (error.code === "feature_unknown") {
      return `${action} ist dieser Basis unbekannt. Vermutlich ist die Erweiterung veraltet; bitte Frickeldave Store und die Erweiterung aktualisieren.`;
    }
    return "";
  }

  _importErrorText(error) {
    if (error instanceof ApiError) {
      const featureText = this._featureErrorText(error, "Der Katalogimport");
      if (featureText) {
        return featureText;
      }
      if (error.status === 403) {
        return "Keine Berechtigung für den Katalogimport.";
      }
      if (error.status === 401) {
        return "Die Sitzung ist abgelaufen. Bitte die Seite neu laden.";
      }
      if (error.status === 408 || error.status === 504) {
        return "Der Import hat zu lange gedauert. Bitte erneut versuchen.";
      }
      if (error.status === 0) {
        return "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen und erneut versuchen.";
      }
      return error.message || "Der Katalog konnte nicht importiert werden. Bitte erneut versuchen.";
    }
    return "Der Katalog konnte nicht importiert werden. Bitte erneut versuchen.";
  }

  _normalizeImportResult(data) {
    const count = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
    };
    const errors = Array.isArray(data?.errors)
      ? data.errors
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            articleNumber: String(entry.articleNumber ?? "").trim(),
            message: String(entry.message ?? "").trim(),
          }))
      : [];
    return {
      dryRun: Boolean(data?.dry_run),
      created: count(data?.created),
      skipped: count(data?.skipped),
      failed: count(data?.failed),
      imagesImported: count(data?.images_imported),
      productsTotal: count(data?.products_total),
      wouldCreate: count(data?.would_create),
      wouldOverwrite: count(data?.would_overwrite),
      overwritten: count(data?.overwritten),
      unchanged: count(data?.unchanged),
      summary: typeof data?.summary === "string" ? data.summary.trim() : "",
      errors,
    };
  }

  async _startImport() {
    const dialog = this._importDialog;
    if (!dialog || dialog.busy || dialog.previewLoading || !this._can("product")) {
      return;
    }

    this._importDialog = { ...dialog, phase: "running", busy: true, error: "", result: null };
    this._focusImport("#fd-import-status");

    try {
      const data = await this._api(`${API_ROOT}/features/import`, {
        method: "POST",
        body: {
          dry_run: false,
          overwrite: Boolean(dialog.overwrite),
          import_images: true,
        },
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      const result = this._normalizeImportResult(data);

      // Nach dem Import ohne Such- und Filtereinschränkung neu laden,
      // damit die übernommenen Produkte sichtbar sind.
      clearTimeout(this._searchTimer);
      this._resetFilters();
      this._loadTags();

      this._importDialog = {
        ...this._importDialog,
        phase: "result",
        busy: false,
        error: "",
        result,
      };
      this._focusImport("#fd-import-result");
    } catch (error) {
      if (!this._importDialog) {
        return;
      }
      this._importDialog = {
        ...this._importDialog,
        phase: "error",
        busy: false,
        error: this._importErrorText(error),
        result: null,
      };
      this._focusImport("#fd-import-error");
      if (isFeatureError(error)) {
        this._reloadFeatures();
      }
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        this._revalidateAccess();
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Tag-Verwaltung                                                         */
  /* --------------------------------------------------------------------- */

  _openTags() {
    if (!this._can("product")) {
      return;
    }
    const trigger = this._menuTrigger();
    this._closeMenu({ restoreFocus: false });
    if (trigger) {
      this._focusReturn = trigger;
    } else {
      this._captureFocus();
    }
    this._tagsDialog = {
      tags: [...this._allTags],
      draft: "",
      loading: true,
      busy: false,
      error: "",
      notice: "",
      pendingDelete: null,
    };
    this._refreshTagDialog();
  }

  _closeTags() {
    if (this._tagsDialog?.busy) {
      return;
    }
    this._tagsDialog = null;
    this._restoreFocus();
  }

  async _refreshTagDialog() {
    if (!this._tagsDialog) {
      return;
    }
    this._tagsDialog = { ...this._tagsDialog, loading: true, error: "" };
    try {
      const data = await this._api(`${API_ROOT}/tags`);
      const tags = normalizeTagNames(data);
      this._allTags = tags;
      if (!this._tagsDialog) {
        return;
      }
      this._tagsDialog = { ...this._tagsDialog, tags, loading: false };
    } catch (error) {
      if (isAbortError(error) || !this._tagsDialog) {
        return;
      }
      this._tagsDialog = { ...this._tagsDialog, loading: false, error: this._errorText(error) };
    }
  }

  async _addTag(event) {
    event?.preventDefault();
    const dialog = this._tagsDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    const name = dialog.draft.trim();
    if (!name) {
      this._tagsDialog = { ...dialog, error: "Bitte einen Tag-Namen angeben." };
      return;
    }
    if (name.length > 40) {
      this._tagsDialog = { ...dialog, error: "Der Tag-Name darf höchstens 40 Zeichen enthalten." };
      return;
    }

    this._tagsDialog = { ...dialog, busy: true, error: "", notice: "", pendingDelete: null };

    try {
      await this._api(`${API_ROOT}/tags`, { method: "POST", body: { name } });
      await this._refreshTagDialog();
      if (this._tagsDialog) {
        this._tagsDialog = {
          ...this._tagsDialog,
          busy: false,
          draft: "",
          notice: `Tag „${name}“ wurde erstellt.`,
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (this._tagsDialog) {
          this._tagsDialog = { ...this._tagsDialog, busy: false };
        }
        return;
      }
      if (!this._tagsDialog) {
        return;
      }
      this._tagsDialog = { ...this._tagsDialog, busy: false, error: this._errorText(error) };
    }
  }

  _requestDeleteTag(name) {
    const dialog = this._tagsDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    this._tagsDialog = {
      ...dialog,
      pendingDelete: dialog.pendingDelete === name ? null : name,
      error: "",
      notice: "",
    };
  }

  async _deleteTag(name) {
    const dialog = this._tagsDialog;
    if (!dialog || dialog.busy || !name) {
      return;
    }
    this._tagsDialog = { ...dialog, busy: true, error: "", pendingDelete: null };

    try {
      await this._api(`${API_ROOT}/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (this._tagFilter.includes(name)) {
        this._tagFilter = this._tagFilter.filter((tag) => tag !== name);
        this._offset = 0;
      }
      await this._refreshTagDialog();
      if (this._tagsDialog) {
        this._tagsDialog = { ...this._tagsDialog, busy: false, notice: `Tag „${name}“ wurde gelöscht.` };
      }
      this._loadProducts();
    } catch (error) {
      if (isAbortError(error)) {
        if (this._tagsDialog) {
          this._tagsDialog = { ...this._tagsDialog, busy: false };
        }
        return;
      }
      if (!this._tagsDialog) {
        return;
      }
      this._tagsDialog = { ...this._tagsDialog, busy: false, error: this._errorText(error) };
    }
  }

  /* --------------------------------------------------------------------- */
  /* Render: Rahmen, Kopfzeile, Navigation                                  */
  /* --------------------------------------------------------------------- */

  render() {
    return html`
      ${this._renderAccess()}
      ${this._renderEditorDialog()}
      ${this._renderArchiveDialog()}
      ${this._renderTagsDialog()}
      ${this._renderImportDialog()}
      ${this._renderPublishDialog()}
      ${this._renderToast()}
    `;
  }

  _renderAccess() {
    if (this._accessState === "ready") {
      return this._renderMain();
    }
    if (this._accessState === "denied") {
      return this._renderDenied();
    }
    if (this._accessState === "error") {
      return this._renderAccessError();
    }
    return this._renderBoot();
  }

  _renderBoot() {
    return html`
      <div class="fd-shell">
        <section class="fd-card fd-state" role="status" aria-live="polite">
          <span class="fd-spinner" aria-hidden="true"></span>
          <h1 id="fd-main-heading" tabindex="-1">Frickeldave Store</h1>
          <p class="fd-muted">
            ${this.hass ? "Zugriff wird geprüft …" : "Verbindung zu Home Assistant wird hergestellt …"}
          </p>
        </section>
      </div>
    `;
  }

  _renderDenied() {
    return html`
      <div class="fd-shell">
        <section class="fd-card fd-state">
          <h1 id="fd-main-heading" tabindex="-1">Kein Zugriff</h1>
          <p>Ihr Home-Assistant-Benutzer ist für diese Verwaltung nicht freigegeben.</p>
          <p class="fd-muted">${this._accessError || "Bitte wenden Sie sich an die Anwendungsverwaltung."}</p>
        </section>
      </div>
    `;
  }

  _renderAccessError() {
    return html`
      <div class="fd-shell">
        <section class="fd-card fd-state" role="alert">
          <h1 id="fd-main-heading" tabindex="-1">Verbindung fehlgeschlagen</h1>
          <p>${this._accessError}</p>
          <button type="button" class="fd-button fd-button--primary" @click=${() => this._retryAccess()}>
            Erneut versuchen
          </button>
        </section>
      </div>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Kopfzeile und Hauptmenü                                                */
  /* --------------------------------------------------------------------- */

  _menuItems() {
    return [...(this.renderRoot?.querySelectorAll(".fd-menu [role='menuitem']") ?? [])];
  }

  _menuTrigger() {
    const trigger = this.renderRoot?.querySelector("#fd-menu-trigger");
    return trigger && typeof trigger.focus === "function" ? trigger : null;
  }

  _toggleSidebar() {
    this._closeMenu({ restoreFocus: false });
    this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
  }

  _toggleMenu() {
    if (this._menuOpen) {
      this._closeMenu();
    } else {
      this._openMenu();
    }
  }

  _openMenu() {
    if (this._menuOpen) {
      return;
    }
    this._menuOpen = true;
    document.addEventListener("pointerdown", this._onMenuOutside, true);
    document.addEventListener("keydown", this._onMenuKeydown, true);
    this._focusMenuItem(0);
  }

  _closeMenu({ restoreFocus = true } = {}) {
    if (!this._menuOpen) {
      return;
    }
    this._menuOpen = false;
    this._detachMenuListeners();
    if (restoreFocus) {
      const trigger = this._menuTrigger();
      this.updateComplete
        .then(() => {
          trigger?.focus?.();
        })
        .catch(() => {});
    }
  }

  _detachMenuListeners() {
    document.removeEventListener("pointerdown", this._onMenuOutside, true);
    document.removeEventListener("keydown", this._onMenuKeydown, true);
  }

  _focusMenuItem(index) {
    this.updateComplete
      .then(() => {
        const items = this._menuItems();
        if (items.length === 0) {
          return;
        }
        items[(index + items.length) % items.length].focus();
      })
      .catch(() => {});
  }

  _handleMenuOutside(event) {
    if (!this._menuOpen) {
      return;
    }
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const anchor = this.renderRoot?.querySelector(".fd-menu-anchor");
    if (anchor && path.includes(anchor)) {
      return;
    }
    this._closeMenu({ restoreFocus: false });
  }

  _handleMenuKeydown(event) {
    if (!this._menuOpen) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this._closeMenu();
      return;
    }
    if (event.key === "Tab") {
      this._closeMenu({ restoreFocus: false });
      return;
    }
    const items = this._menuItems();
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(this.renderRoot?.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this._focusMenuItem(current < 0 ? 0 : current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this._focusMenuItem(current <= 0 ? items.length - 1 : current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      this._focusMenuItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      this._focusMenuItem(items.length - 1);
    }
  }

  _renderHeaderMenu() {
    if (!this._menuOpen) {
      return "";
    }
    if (!this._can("product")) {
      return "";
    }
    return html`
      <div id="fd-main-menu" class="fd-menu" role="menu" aria-label="Weitere Aktionen">
        <button
          type="button"
          class="fd-menu-item"
          role="menuitem"
          tabindex="-1"
          @click=${() => this._openTags()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M17.63 5.84C17.27 5.33 16.67 5 16 5H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h11c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"
            />
          </svg>
          Tags verwalten
        </button>
      </div>
    `;
  }

  _renderMain() {
    const canProduct = this._can("product");
    const canPublish = this._can("app_admin");
    const publishFeature = this._featureInfo("publish");
    const importFeature = this._featureInfo("import");
    const showPublish = canPublish && publishFeature.present;
    const showImport = canProduct && importFeature.present;

    return html`
      <div class="fd-app">
        <header class="fd-app-bar">
          <button
            type="button"
            class="fd-bar-icon fd-bar-menu"
            @click=${() => this._toggleSidebar()}
            aria-label="Menü öffnen"
            title="Menü"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>
          <h1 id="fd-main-heading" class="fd-bar-title" tabindex="-1">Frickeldave Store</h1>
          ${canProduct || showPublish
            ? html`
                <div class="fd-bar-actions">
                  ${canProduct
                    ? html`
                        <button
                          type="button"
                          class="fd-bar-icon"
                          @click=${() => this._reloadAll()}
                          ?disabled=${this._productsLoading}
                          aria-label="Aktualisieren"
                          title="Aktualisieren"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path
                              d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                            />
                          </svg>
                        </button>
                        ${showImport
                          ? html`
                              <button
                                type="button"
                                class="fd-bar-icon"
                                @click=${() => this._openImport()}
                                ?disabled=${Boolean(this._importDialog?.busy)}
                                aria-disabled=${importFeature.available ? "false" : "true"}
                                aria-describedby=${importFeature.available ? undefined : "fd-feature-import-reason"}
                                aria-label="Katalog importieren"
                                title=${importFeature.available
                                  ? "Katalog importieren"
                                  : this._featureHint(importFeature, "Der Katalogimport")}
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                  <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
                                </svg>
                              </button>
                            `
                          : ""}
                        <button
                          type="button"
                          class="fd-bar-icon"
                          @click=${() => this._openCreate()}
                          aria-label="Produkt erstellen"
                          title="Produkt erstellen"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                          </svg>
                        </button>
                      `
                    : ""}
                  ${showPublish
                    ? html`
                        <span class="fd-bar-divider" aria-hidden="true"></span>
                        <button
                          type="button"
                          class="fd-bar-icon"
                          @click=${() => this._openPublish("dev")}
                          ?disabled=${Boolean(this._publishDialog?.busy)}
                          aria-disabled=${publishFeature.available ? "false" : "true"}
                          aria-describedby=${publishFeature.available ? undefined : "fd-feature-publish-reason"}
                          aria-label="Nach dev veröffentlichen"
                          title=${publishFeature.available
                            ? "Nach dev veröffentlichen"
                            : this._featureHint(publishFeature, "Veröffentlichen")}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path
                              d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM10 4H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z"
                            />
                          </svg>
                          <span class="fd-bar-badge" aria-hidden="true">dev</span>
                        </button>
                        <button
                          type="button"
                          class="fd-bar-icon"
                          @click=${() => this._openPublish("prod")}
                          ?disabled=${Boolean(this._publishDialog?.busy)}
                          aria-disabled=${publishFeature.available ? "false" : "true"}
                          aria-describedby=${publishFeature.available ? undefined : "fd-feature-publish-reason"}
                          aria-label="Nach prod veröffentlichen"
                          title=${publishFeature.available
                            ? "Nach prod veröffentlichen"
                            : this._featureHint(publishFeature, "Veröffentlichen")}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path
                              d="M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM10 4H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z"
                            />
                          </svg>
                          <span class="fd-bar-badge" aria-hidden="true">prd</span>
                        </button>
                      `
                    : ""}
                  ${showImport && !importFeature.available
                    ? html`<span id="fd-feature-import-reason" class="fd-sr-only">
                        ${this._featureHint(importFeature, "Der Katalogimport")}
                      </span>`
                    : ""}
                  ${showPublish && !publishFeature.available
                    ? html`<span id="fd-feature-publish-reason" class="fd-sr-only">
                        ${this._featureHint(publishFeature, "Veröffentlichen")}
                      </span>`
                    : ""}
                </div>
                ${canProduct
                  ? html`
                      <div class="fd-menu-anchor">
                        <button
                          id="fd-menu-trigger"
                          type="button"
                          class="fd-bar-icon"
                          @click=${() => this._toggleMenu()}
                          aria-haspopup="menu"
                          aria-expanded=${this._menuOpen ? "true" : "false"}
                          aria-controls="fd-main-menu"
                          aria-label="Weitere Aktionen"
                          title="Weitere Aktionen"
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <circle cx="12" cy="5" r="1.7" />
                            <circle cx="12" cy="12" r="1.7" />
                            <circle cx="12" cy="19" r="1.7" />
                          </svg>
                        </button>
                        ${this._renderHeaderMenu()}
                      </div>
                    `
                  : ""}
              `
            : ""}
        </header>

        <div class="fd-shell">
          ${canProduct ? this._renderProducts() : this._renderNoProductView()}
          ${this._me?.version
            ? html`<footer class="fd-panel-footer" aria-label="Geladene Panel-Version">
                v${this._me.version}
              </footer>`
            : ""}
        </div>
      </div>
    `;
  }

  _renderNoProductView() {
    return html`
      <section class="fd-card fd-state">
        <h2>Keine Produktverwaltung</h2>
        <p class="fd-muted">
          Ihr Benutzer darf keine Produkte verwalten. Benutzer und KI-Einstellungen verwalten Sie
          in den Einstellungen unter „Geräte &amp; Dienste“ → „Frickeldave Store“.
        </p>
      </section>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Render: Produktliste                                                   */
  /* --------------------------------------------------------------------- */

  _renderProducts() {
    return html`
      <section class="fd-card fd-filters" aria-labelledby="fd-filter-title">
        <div class="fd-filter-summary">
          <div class="fd-filter-summary-title">
            <h2 id="fd-filter-title">Suche und Filter</h2>
            ${this._hasActiveFilters()
              ? html`<span class="fd-badge fd-badge--active">Filter aktiv</span>`
              : ""}
          </div>
          <button
            type="button"
            class="fd-button fd-filter-toggle"
            @click=${() => this._toggleFilters()}
            aria-expanded=${this._filtersOpen ? "true" : "false"}
            aria-controls="fd-filter-panel"
            aria-label=${this._filtersOpen ? "Suche und Filter ausblenden" : "Suche und Filter anzeigen"}
          >
            ${this._filtersOpen ? "Ausblenden" : "Anzeigen"}
            <svg
              class="fd-filter-chevron${this._filtersOpen ? " fd-filter-chevron--open" : ""}"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
            </svg>
          </button>
        </div>

        <div id="fd-filter-panel" class="fd-filter-panel" ?hidden=${!this._filtersOpen}>
          <div class="fd-filter-head">
            <div class="fd-field fd-field--search">
              <label class="fd-label fd-sr-only" for="fd-search">Suche</label>
              <input
                id="fd-search"
                class="fd-input"
                type="search"
                placeholder="Name, Beschreibung, Artikelnummer oder Tag"
                .value=${this._search}
                @input=${(event) => this._onSearchInput(event.target.value)}
              />
            </div>
            <div class="fd-filter-actions">
              <div class="fd-view-toggle" role="group" aria-label="Darstellung der Produktliste">
                <button
                  type="button"
                  class="fd-view-option"
                  aria-pressed=${this._view === "grid" ? "true" : "false"}
                  @click=${() => this._setView("grid")}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
                  </svg>
                  Kacheln
                </button>
                <button
                  type="button"
                  class="fd-view-option"
                  aria-pressed=${this._view === "list" ? "true" : "false"}
                  @click=${() => this._setView("list")}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h16v2H4v-2z" />
                  </svg>
                  Liste
                </button>
              </div>
              <button
                type="button"
                class="fd-button"
                @click=${() => this._resetFilters()}
                ?disabled=${!this._hasActiveFilters()}
              >
                Filter zurücksetzen
              </button>
            </div>
          </div>

          <div class="fd-filter-options">
            <fieldset class="fd-fieldset">
              <legend class="fd-label">Kategorie</legend>
              <div class="fd-chip-row">
                ${CATEGORY_KEYS.map(
                  (key) => html`
                    <button
                      type="button"
                      class="fd-chip"
                      aria-pressed=${this._categoryFilter.includes(key) ? "true" : "false"}
                      @click=${() => this._toggleFilterValue("_categoryFilter", key)}
                    >
                      ${CATEGORY_LABELS[key]}
                    </button>
                  `,
                )}
              </div>
            </fieldset>

            <fieldset class="fd-fieldset">
              <legend class="fd-label">Tags</legend>
              ${this._allTags.length === 0
                ? html`<p class="fd-hint">Noch keine Tags vorhanden.</p>`
                : html`
                    <div class="fd-chip-row fd-chip-row--scroll">
                      ${this._allTags.map(
                        (tag) => html`
                          <button
                            type="button"
                            class="fd-chip"
                            aria-pressed=${this._tagFilter.includes(tag) ? "true" : "false"}
                            @click=${() => this._toggleFilterValue("_tagFilter", tag)}
                          >
                            ${tag}
                          </button>
                        `,
                      )}
                    </div>
                  `}
            </fieldset>
          </div>

          <div class="fd-filter-grid">
            <div class="fd-field">
              <span class="fd-label" id="fd-flags-label">Bestand und Status</span>
              <div class="fd-switch-row" role="group" aria-labelledby="fd-flags-label">
                <label class="fd-switch">
                  <input
                    type="checkbox"
                    .checked=${this._customizableOnly}
                    @change=${(event) => this._setFlag("_customizableOnly", event.target.checked)}
                  />
                  <span>Personalisierbar</span>
                </label>
                <label class="fd-switch">
                  <input
                    type="checkbox"
                    .checked=${this._showArchived}
                    @change=${(event) => this._setFlag("_showArchived", event.target.checked)}
                  />
                  <span>Nur archivierte anzeigen</span>
                </label>
              </div>
            </div>

            <div class="fd-field">
              <label class="fd-label" for="fd-location-filter">Lagerstätte</label>
              ${this._locations.length === 0
                ? html`<p class="fd-hint">
                    ${this._locationsError || "Lagerstätten werden geladen …"}
                  </p>`
                : html`
                    <select
                      id="fd-location-filter"
                      class="fd-input"
                      .value=${this._locationFilter}
                      @change=${(event) => this._setLocationFilter(event.target.value)}
                    >
                      <option value="">Alle Lagerstätten</option>
                      ${this._locations.map(
                        (location) => html`<option value=${location.id}>${location.name}</option>`,
                      )}
                    </select>
                  `}
              <p class="fd-hint" id="fd-location-hint">
                ${this._locationFilter
                  ? `Zeigt nur Produkte mit Bestand > 0 in ${this._locationName(this._locationFilter)}.`
                  : "Ohne Auswahl erscheinen Produkte aller Lagerstätten."}
                Die Option „Auch Produkte ohne Bestand anzeigen“ erweitert die Liste um Produkte
                ohne Bestand in der gewählten Lagerstätte.
              </p>
              <label class="fd-switch">
                <input
                  type="checkbox"
                  .checked=${this._includeWithoutStock}
                  ?disabled=${!this._locationFilter}
                  aria-describedby="fd-location-hint"
                  @change=${(event) => this._setIncludeWithoutStock(event.target.checked)}
                />
                <span>Auch Produkte ohne Bestand anzeigen</span>
              </label>
            </div>

            <fieldset class="fd-fieldset fd-fieldset--inline">
              <legend class="fd-label">Sichtbarkeit</legend>
              <div class="fd-chip-row">
                ${VISIBILITY_OPTIONS.map(
                  (option) => html`
                    <button
                      type="button"
                      class="fd-chip"
                      aria-pressed=${this._visibility === option.value ? "true" : "false"}
                      @click=${() => this._setVisibility(option.value)}
                    >
                      ${option.label}
                    </button>
                  `,
                )}
              </div>
            </fieldset>

            <div class="fd-field">
              <label class="fd-label" for="fd-sort">Sortierung</label>
              <div class="fd-sort-row">
                <select
                  id="fd-sort"
                  class="fd-input"
                  .value=${this._sort}
                  @change=${(event) => this._setSortField(event.target.value)}
                >
                  ${SORT_COLUMNS.map(
                    (column) => html`<option value=${column.field}>${column.label}</option>`,
                  )}
                </select>
                <button
                  type="button"
                  class="fd-button"
                  @click=${() => this._toggleSortOrder()}
                  aria-label=${`Sortierrichtung für ${this._sortLabel()}: ${
                    this._order === "asc" ? "aufsteigend" : "absteigend"
                  }. Richtung wechseln.`}
                >
                  ${this._order === "asc" ? "↑ Aufsteigend" : "↓ Absteigend"}
                </button>
              </div>
              <p class="fd-hint">In der Listenansicht sortieren auch die Spaltenköpfe.</p>
            </div>
          </div>
        </div>
      </section>

      ${this._productsError ? this._renderErrorBanner(this._productsError, () => this._loadProducts()) : ""}

      <p class="fd-list-meta" aria-live="polite">
        ${this._productsLoading ? "Produkte werden geladen …" : this._resultSummary()}
      </p>

      ${this._renderProductGrid()}
      ${this._renderPagination()}
    `;
  }

  _resultSummary() {
    const total = this._total;
    const loaded = this._products.length;
    if (total === 0) {
      return "Keine Produkte gefunden.";
    }
    if (loaded < total) {
      return `${formatNumber(loaded)} von ${formatNumber(total)} Produkten angezeigt.`;
    }
    return total === 1 ? "1 Produkt gefunden." : `${formatNumber(total)} Produkte gefunden.`;
  }

  _renderErrorBanner(message, retry) {
    return html`
      <div class="fd-banner fd-banner--error" role="alert">
        <p>${message}</p>
        ${retry
          ? html`<button type="button" class="fd-button fd-button--small" @click=${() => retry()}>
              Erneut versuchen
            </button>`
          : ""}
      </div>
    `;
  }

  _renderProductGrid() {
    if (this._productsLoading && this._products.length === 0) {
      return html`
        <div class="fd-state fd-state--inline" role="status" aria-live="polite">
          <span class="fd-spinner" aria-hidden="true"></span>
          <p>Produkte werden geladen …</p>
        </div>
      `;
    }
    if (this._products.length === 0) {
      return html`
        <div class="fd-state fd-state--inline">
          <h2>Keine Produkte gefunden</h2>
          <p class="fd-muted">
            ${this._hasActiveFilters()
              ? "Bitte Suche oder Filter anpassen."
              : "Es sind noch keine Produkte vorhanden."}
          </p>
          ${this._hasActiveFilters()
            ? html`<button type="button" class="fd-button" @click=${() => this._resetFilters()}>
                Filter zurücksetzen
              </button>`
            : html`<button type="button" class="fd-button fd-button--primary" @click=${() => this._openCreate()}>
                Produkt erstellen
              </button>`}
        </div>
      `;
    }
    return this._view === "list" ? this._renderProductList() : this._renderProductTiles();
  }

  _renderProductTiles() {
    return html`
      <ul class="fd-grid" role="list">
        ${this._products.map((product) => this._renderProductCard(product))}
      </ul>
    `;
  }

  _renderProductList() {
    return html`
      <div class="fd-product-list-wrap">
        <table class="fd-product-table">
          <caption class="fd-sr-only">Produkte in der Listenansicht</caption>
          <thead>
            <tr>
              ${SORT_COLUMNS.map((column) => this._renderSortHeader(column))}
              <th scope="col">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            ${this._products.map((product) => this._renderProductRow(product))}
          </tbody>
        </table>
      </div>
    `;
  }

  _renderSortHeader(column) {
    const active = this._sort === column.field;
    const ascending = this._order === "asc";
    const directionLabel = active ? (ascending ? "aufsteigend" : "absteigend") : "unsortiert";
    const arrow = active ? (ascending ? "↑" : "↓") : "↕";

    return html`
      <th scope="col" aria-sort=${active ? (ascending ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          class="fd-sort-header"
          @click=${() => this._setSort(column.field)}
          aria-label=${`Nach ${column.label} sortieren. Aktuell ${directionLabel}.`}
          title=${`Nach ${column.label} sortieren (aktuell ${directionLabel})`}
        >
          <span>${column.label}</span>
          <span class="fd-sort-arrow" aria-hidden="true">${arrow}</span>
        </button>
      </th>
    `;
  }

  _renderProductRow(product) {
    const mainImage = this._mainImage(product);
    const mainSrc = this._imageSrc(this._imageUrl(product, mainImage));
    const archived = Boolean(product.archived);
    const productLabel = product.name || product.articleNumber || "Produkt";

    return html`
      <tr class="fd-product-row${archived ? " fd-product--archived" : ""}">
        <td class="fd-product-cell" data-label="Produkt">
          <div class="fd-product-row-main">
            <div class="fd-product-thumb">
              ${mainSrc
                ? html`<img src=${mainSrc} alt=${`Produktbild von ${productLabel}`} loading="lazy" />`
                : html`<span aria-hidden="true">${String(productLabel).slice(0, 1).toUpperCase()}</span>`}
            </div>
            <div class="fd-product-row-text">
              <span class="fd-product-title">${product.name || "(ohne Namen)"}</span>
              <span class="fd-muted fd-small">${product.articleNumber || "Ohne Artikelnummer"}</span>
              ${Array.isArray(product.tags) && product.tags.length > 0
                ? html`
                    <ul class="fd-tag-list" role="list" aria-label="Tags">
                      ${product.tags.map((tag) => html`<li class="fd-tag">${tag}</li>`)}
                    </ul>
                  `
                : ""}
            </div>
          </div>
        </td>
        <td data-label="Kategorie">${categoryLabel(product.category)}</td>
        <td data-label="Preis" class="fd-price">${formatPrice(product.price)}</td>
        <td data-label="Bestand">
          <div class="fd-stock-chips">${this._renderStockSummary(product)}</div>
        </td>
        <td data-label="Größe" class="fd-size-cell">${this._productSizeLabel(product)}</td>
        <td data-label="Status">
          <div class="fd-badges">
            ${this._renderImageWarning(product, "row")} ${this._renderProductBadges(product)}
          </div>
        </td>
        <td data-label="Aktionen">
          <div class="fd-row-actions">${this._renderProductActions(product)}</div>
        </td>
      </tr>
    `;
  }

  _renderStockSummary(product) {
    if (this._locations.length === 0) {
      return html`<span class="fd-muted fd-small">
        ${this._locationsError || "Keine Lagerstätten konfiguriert."}
      </span>`;
    }
    return this._productStockEntries(product).map(
      (entry) => html`
        <span class="fd-stock-chip">
          <span class="fd-muted">${entry.name}:</span>
          <strong>${formatNumber(entry.value)}</strong>
        </span>
      `,
    );
  }

  /**
   * Warndreieck für Produkte mit mindestens einem zu großen Bild. In der Kachel
   * liegt es als Badge am Bild, in der Liste in der Statusspalte; beide Varianten
   * öffnen den Produktdialog im Bilder-Tab.
   */
  _renderImageWarning(product, variant = "card") {
    if (this._productOversizedCount(product) === 0) {
      return "";
    }
    return html`
      <button
        type="button"
        class="fd-image-warning fd-image-warning--${variant}"
        title=${OVERSIZED_HINT}
        aria-label=${OVERSIZED_HINT}
        @click=${(event) => {
          event.stopPropagation();
          this._openImagesFor(product);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
        </svg>
        ${variant === "row" ? html`<span class="fd-image-warning-text">Bilder zu groß</span>` : ""}
      </button>
    `;
  }

  _renderProductBadges(product) {
    return html`
      ${product.customizable ? html`<span class="fd-badge">Personalisierbar</span>` : ""}
      ${product.visible === false ? html`<span class="fd-badge fd-badge--warning">Nicht sichtbar</span>` : ""}
      ${product.archived ? html`<span class="fd-badge fd-badge--muted">Archiviert</span>` : ""}
    `;
  }

  _renderProductActions(product) {
    const productLabel = product.name || product.articleNumber || "Produkt";
    return html`
      <button
        type="button"
        class="fd-button fd-row-action"
        @click=${() => this._openEdit(product)}
        aria-label=${`${productLabel} bearbeiten`}
        title=${`${productLabel} bearbeiten`}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
          />
        </svg>
      </button>
      ${product.archived
        ? ""
        : html`
            <button
              type="button"
              class="fd-button fd-row-action"
              @click=${() => this._requestArchive(product)}
              aria-label=${`${productLabel} archivieren`}
              title=${`${productLabel} archivieren`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M20.54 5.23l-1.39-1.68A1.4 1.4 0 0 0 18 3H6c-.47 0-.88.21-1.15.55L3.46 5.23A1.9 1.9 0 0 0 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"
                />
              </svg>
            </button>
          `}
    `;
  }

  _renderProductCard(product) {
    const mainImage = this._mainImage(product);
    const mainSrc = this._imageSrc(this._imageUrl(product, mainImage));
    const archived = Boolean(product.archived);
    const productLabel = product.name || product.articleNumber || "Produkt";

    return html`
      <li class="fd-card fd-product${archived ? " fd-product--archived" : ""}">
        <div class="fd-product-media">
          ${mainSrc
            ? html`<img src=${mainSrc} alt=${`Produktbild von ${productLabel}`} loading="lazy" />`
            : html`<div class="fd-product-placeholder" aria-hidden="true">
                ${String(productLabel).slice(0, 1).toUpperCase()}
              </div>`}
          ${this._renderImageWarning(product, "card")}
        </div>
        <div class="fd-product-body">
          <div class="fd-product-title-row">
            <h2 class="fd-product-title">${product.name || "(ohne Namen)"}</h2>
            <span class="fd-price">${formatPrice(product.price)}</span>
          </div>
          <p class="fd-muted fd-small">
            ${categoryLabel(product.category)} · ${product.articleNumber}${product.size ? ` · ${product.size}` : ""}
          </p>
          ${product.description ? html`<p class="fd-product-description">${product.description}</p>` : ""}

          <div class="fd-badges">${this._renderProductBadges(product)}</div>

          <p class="fd-stock-line">${this._renderStockSummary(product)}</p>
          ${product.updatedAt
            ? html`<p class="fd-hint">Zuletzt geändert: ${formatDateTime(product.updatedAt)}</p>`
            : ""}

          ${Array.isArray(product.tags) && product.tags.length > 0
            ? html`
                <ul class="fd-tag-list" role="list" aria-label="Tags">
                  ${product.tags.map((tag) => html`<li class="fd-tag">${tag}</li>`)}
                </ul>
              `
            : ""}

          <div class="fd-card-actions">${this._renderProductActions(product)}</div>
        </div>
      </li>
    `;
  }

  _renderPagination() {
    if (this._total <= PAGE_SIZE) {
      return "";
    }
    const page = Math.floor(this._offset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(this._total / PAGE_SIZE));
    const from = this._offset + 1;
    const to = Math.min(this._offset + PAGE_SIZE, this._total);

    return html`
      <div class="fd-pagination">
        <p class="fd-muted fd-small">
          ${formatNumber(from)}–${formatNumber(to)} von ${formatNumber(this._total)}
        </p>
        <div class="fd-pagination-actions">
          <button
            type="button"
            class="fd-button"
            @click=${() => this._changePage(-1)}
            ?disabled=${page <= 1 || this._productsLoading}
          >
            Zurück
          </button>
          <span aria-live="polite">Seite ${page} von ${pages}</span>
          <button
            type="button"
            class="fd-button"
            @click=${() => this._changePage(1)}
            ?disabled=${page >= pages || this._productsLoading}
          >
            Weiter
          </button>
        </div>
      </div>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Render: Editor-Dialog                                                  */
  /* --------------------------------------------------------------------- */

  _articleBadge(editor) {
    if (editor.mode === "edit") {
      const value = editor.articleNumber || "—";
      return {
        text: value,
        title: value === "—" ? "Keine Artikelnummer vorhanden." : `Artikelnummer ${value}`,
        label: value === "—" ? "Keine Artikelnummer vorhanden." : `Artikelnummer ${value}`,
      };
    }

    const preview = editor.articlePreview || {};
    if (preview.loading) {
      return {
        text: "…",
        title: "Artikelnummer wird ermittelt …",
        label: "Artikelnummer wird ermittelt",
      };
    }
    if (preview.value) {
      return {
        text: preview.value,
        title: `Voraussichtliche Artikelnummer ${preview.value}. Verbindlich ist die Nummer nach dem Anlegen.`,
        label: `Voraussichtliche Artikelnummer ${preview.value}`,
      };
    }
    const reason = preview.error || "Die Artikelnummer wird beim Anlegen vergeben.";
    return {
      text: "—",
      title: reason,
      label: `Artikelnummer nicht verfügbar: ${reason}`,
    };
  }

  _renderEditorDialog() {
    const editor = this._editor;
    if (!editor) {
      return "";
    }
    const errors = editor.fieldErrors || {};
    const isCreate = editor.mode === "create";
    const tab = editor.tab || "general";
    const articleBadge = this._articleBadge(editor);
    const continueFlow = editor.createFlow && tab !== "stock";
    const submitLabel = editor.saving
      ? continueFlow
        ? "Wird gespeichert …"
        : "Speichern …"
      : continueFlow
        ? "Weiter"
        : "Speichern";
    const cancelLabel = editor.createFlow && editor.mode === "edit" ? "Schließen" : "Abbrechen";

    return html`
      <dialog
        id="fd-editor-dialog"
        class="fd-dialog fd-dialog--wide${editor.shake ? " fd-dialog--shake" : ""}"
        aria-labelledby="fd-editor-title"
        @cancel=${(event) => this._handleDialogCancel(event, () => this._closeEditor())}
        @click=${(event) => {
          if (event.target === event.currentTarget) {
            this._closeEditor();
          }
        }}
      >
        <div class="fd-dialog-head">
          <button
            type="button"
            class="fd-icon-button fd-dialog-close"
            @click=${() => this._closeEditor()}
            ?disabled=${editor.saving}
            aria-label="Dialog schließen"
            title="Dialog schließen"
          >
            ✕
          </button>
          <span
            class="fd-article-badge"
            title=${articleBadge.title}
            aria-label=${articleBadge.label}
            aria-live=${isCreate ? "polite" : "off"}
          >
            ${articleBadge.text}
          </span>
          <div class="fd-dialog-title">
            <h2 id="fd-editor-title">${isCreate ? "Produkt erstellen" : "Produkt bearbeiten"}</h2>
          </div>
        </div>

        <div class="fd-editor-tabs" role="tablist" aria-label="Produktbereiche">
          ${[
            { id: "general", label: "Grunddaten" },
            { id: "images", label: "Bilder" },
            { id: "description", label: "Beschreibung" },
            { id: "stock", label: "Bestand" },
          ].map(
            (entry) => html`
              <button
                id="fd-editor-tab-${entry.id}"
                type="button"
                class="fd-tab"
                role="tab"
                aria-selected=${tab === entry.id ? "true" : "false"}
                aria-controls="fd-editor-panel-${entry.id}"
                tabindex=${tab === entry.id ? "0" : "-1"}
                @click=${() => this._setEditorTab(entry.id)}
                @keydown=${(event) => this._onEditorTabKeydown(event)}
              >
                ${entry.label}
              </button>
            `,
          )}
        </div>

        <form class="fd-dialog-form" @submit=${(event) => this._saveEditor(event)} novalidate>
          <div class="fd-dialog-body">
          ${editor.error ? html`<div class="fd-banner fd-banner--error" role="alert">${editor.error}</div>` : ""}
          ${editor.shake
            ? html`<p class="fd-hint" role="status" aria-live="polite">
                Nicht gespeicherte Änderungen. Mit „Abbrechen“ verwerfen.
              </p>`
            : ""}

          <div
            id="fd-editor-panel-general"
            role="tabpanel"
            aria-labelledby="fd-editor-tab-general"
            ?hidden=${tab !== "general"}
          >
          <div class="fd-form-grid">
            <div class="fd-field">
              <label class="fd-label" for="fd-editor-name">
                Name <span class="fd-required" aria-hidden="true">*</span>
              </label>
              <input
                id="fd-editor-name"
                data-field="name"
                data-autofocus
                class="fd-input"
                type="text"
                maxlength="200"
                required
                aria-required="true"
                .value=${editor.name}
                aria-invalid=${errors.name ? "true" : "false"}
                aria-describedby=${errors.name ? "fd-editor-name-error" : "fd-editor-name-hint"}
                @input=${(event) => this._setEditorField("name", event.target.value)}
              />
              ${errors.name
                ? html`<p class="fd-error-text" id="fd-editor-name-error">${errors.name}</p>`
                : html`<p class="fd-hint" id="fd-editor-name-hint">Pflichtfeld.</p>`}
            </div>

            <div class="fd-field">
              <label class="fd-label" for="fd-editor-category">Kategorie *</label>
              ${isCreate
                ? html`
                    <select
                      id="fd-editor-category"
                      data-field="category"
                      class="fd-input"
                      .value=${editor.category}
                      @change=${(event) => this._setEditorCategory(event.target.value)}
                    >
                      ${CATEGORY_KEYS.map(
                        (key) => html`<option value=${key}>${CATEGORY_LABELS[key]}</option>`,
                      )}
                    </select>
                  `
                : html`
                    <input
                      id="fd-editor-category"
                      class="fd-input"
                      type="text"
                      .value=${categoryLabel(editor.category)}
                      disabled
                    />
                  `}
              <p class="fd-hint">
                ${isCreate
                  ? "Die Kategorie kann nach dem Erstellen nicht geändert werden."
                  : "Die Kategorie ist unveränderlich. Für einen Wechsel bitte ein neues Produkt erstellen."}
              </p>
              ${errors.category ? html`<p class="fd-error-text">${errors.category}</p>` : ""}
            </div>

            <div class="fd-field">
              <label class="fd-label" for="fd-editor-price">
                Preis (EUR) <span class="fd-required" aria-hidden="true">*</span>
              </label>
              <input
                id="fd-editor-price"
                data-field="price"
                class="fd-input"
                type="text"
                inputmode="decimal"
                required
                aria-required="true"
                placeholder="z. B. 12,50"
                .value=${editor.price}
                aria-invalid=${errors.price ? "true" : "false"}
                aria-describedby=${errors.price ? "fd-editor-price-error" : "fd-editor-price-hint"}
                @input=${(event) => this._setEditorField("price", event.target.value)}
              />
              ${errors.price
                ? html`<p class="fd-error-text" id="fd-editor-price-error">${errors.price}</p>`
                : html`<p class="fd-hint" id="fd-editor-price-hint">Dezimal mit Komma oder Punkt.</p>`}
            </div>

            <div class="fd-field">
              <label class="fd-label" for="fd-editor-size">Größe</label>
              <input
                id="fd-editor-size"
                data-field="size"
                class="fd-input"
                type="text"
                maxlength="200"
                .value=${editor.size}
                @input=${(event) => this._setEditorField("size", event.target.value)}
              />
              ${errors.size ? html`<p class="fd-error-text">${errors.size}</p>` : ""}
            </div>

            <div class="fd-field fd-field--full">
              <span class="fd-label" id="fd-editor-tags-label">Tags</span>
              <ul class="fd-chip-row fd-chip-row--selected" role="list" aria-labelledby="fd-editor-tags-label">
                ${editor.tags.length === 0
                  ? html`<li class="fd-hint">Noch keine Tags gewählt.</li>`
                  : editor.tags.map(
                      (tag) => html`
                        <li class="fd-selected-tag">
                          ${tag}
                          <button
                            type="button"
                            class="fd-icon-button fd-icon-button--small"
                            @click=${() => this._removeEditorTag(tag)}
                            aria-label=${`Tag ${tag} entfernen`}
                          >
                            ✕
                          </button>
                        </li>
                      `,
                    )}
              </ul>

              <div class="fd-tag-input-row">
                <label class="fd-sr-only" for="fd-editor-tag-input">Tag hinzufügen</label>
                <input
                  id="fd-editor-tag-input"
                  class="fd-input"
                  type="text"
                  list="fd-tag-options"
                  placeholder="Tag eingeben"
                  .value=${editor.tagDraft}
                  @input=${(event) => this._setEditorField("tagDraft", event.target.value)}
                  @keydown=${(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      this._addEditorTag(event.target.value);
                    }
                  }}
                />
                <datalist id="fd-tag-options">
                  ${this._allTags.map((tag) => html`<option value=${tag}></option>`)}
                </datalist>
                <button type="button" class="fd-button" @click=${() => this._addEditorTag(editor.tagDraft)}>
                  Hinzufügen
                </button>
              </div>
              ${errors.tags ? html`<p class="fd-error-text">${errors.tags}</p>` : ""}
              ${this._allTags.length > 0
                ? html`
                    <div class="fd-chip-row fd-chip-row--scroll">
                      ${this._allTags
                        .filter((tag) => !editor.tags.includes(tag))
                        .map(
                          (tag) => html`
                            <button type="button" class="fd-chip" @click=${() => this._addEditorTag(tag)}>
                              + ${tag}
                            </button>
                          `,
                        )}
                    </div>
                  `
                : ""}
            </div>

            <div class="fd-field fd-field--full">
              <div class="fd-switch-row">
                <label class="fd-switch">
                  <input
                    type="checkbox"
                    .checked=${editor.visible}
                    @change=${(event) => this._setEditorField("visible", event.target.checked)}
                  />
                  <span>Sichtbar auf der Website</span>
                </label>
                <label class="fd-switch">
                  <input
                    type="checkbox"
                    .checked=${editor.customizable}
                    @change=${(event) => this._setEditorField("customizable", event.target.checked)}
                  />
                  <span>Personalisierbar</span>
                </label>
              </div>
            </div>
          </div>
          </div>

          <div
            id="fd-editor-panel-images"
            role="tabpanel"
            aria-labelledby="fd-editor-tab-images"
            ?hidden=${tab !== "images"}
          >
            ${this._renderEditorImages(editor)}
          </div>

          <div
            id="fd-editor-panel-description"
            role="tabpanel"
            aria-labelledby="fd-editor-tab-description"
            ?hidden=${tab !== "description"}
          >
            ${this._renderEditorDescription(editor)}
          </div>

          <div
            id="fd-editor-panel-stock"
            role="tabpanel"
            aria-labelledby="fd-editor-tab-stock"
            ?hidden=${tab !== "stock"}
          >
            ${this._renderEditorStock(editor)}
          </div>
          </div>

          <footer class="fd-dialog-foot">
            ${editor.mode === "edit" && editor.createFlow
              ? html`<p class="fd-foot-hint" role="note">
                  Das Produkt ist bereits gespeichert. „${cancelLabel}“ beendet nur den Dialog.
                </p>`
              : editor.mode === "create" && continueFlow
                ? html`<p class="fd-foot-hint" role="note">
                    Mit „Weiter“ wird das Produkt angelegt und gespeichert.
                  </p>`
                : ""}
            <div class="fd-dialog-foot-actions">
              <button
                type="button"
                class="fd-button fd-button--plain"
                @click=${() => this._discardEditor()}
                ?disabled=${editor.saving}
              >
                ${cancelLabel}
              </button>
              <button
                type="submit"
                class="fd-button fd-button--primary"
                ?disabled=${editor.saving}
                aria-busy=${editor.saving ? "true" : "false"}
              >
                ${submitLabel}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    `;
  }

  _renderEditorDescription(editor) {
    const errors = editor.fieldErrors || {};
    const suggestion = this._renderSuggestion(editor);

    return html`
      <div class="fd-form-grid">
        <div class="fd-field fd-field--full">
          <label class="fd-label" for="fd-editor-description">Beschreibung</label>
          <textarea
            id="fd-editor-description"
            data-field="description"
            class="fd-input fd-textarea"
            rows="6"
            .value=${editor.description}
            aria-invalid=${errors.description ? "true" : "false"}
            aria-describedby=${errors.description
              ? "fd-editor-description-error"
              : "fd-editor-description-hint"}
            @input=${(event) => this._setEditorField("description", event.target.value)}
          ></textarea>
          ${errors.description
            ? html`<p class="fd-error-text" id="fd-editor-description-error">${errors.description}</p>`
            : html`<p class="fd-hint" id="fd-editor-description-hint">
                Erscheint auf der Produktseite. Höchstens 20000 Zeichen.
              </p>`}
        </div>

        ${editor.mode === "edit"
          ? html`
              <div class="fd-field fd-field--full">
                <label class="fd-label" for="fd-editor-instructions">Eigene Hinweise für die KI (optional)</label>
                <textarea
                  id="fd-editor-instructions"
                  class="fd-input fd-textarea"
                  rows="2"
                  maxlength="2000"
                  placeholder="Zum Beispiel: Betone die Handarbeit und die Pflegehinweise."
                  .value=${editor.suggestionInstructions || ""}
                  @input=${(event) => this._setEditorField("suggestionInstructions", event.target.value)}
                ></textarea>
                <p class="fd-hint">Fließt nur in den nächsten Vorschlag ein, nicht in die Beschreibung.</p>
              </div>
              <div class="fd-inline-actions fd-field--full">
                <button
                  type="button"
                  class="fd-button"
                  @click=${() => this._suggestDescription()}
                  ?disabled=${editor.saving || Boolean(editor.suggestion?.loading)}
                  aria-busy=${editor.suggestion?.loading ? "true" : "false"}
                >
                  ${editor.suggestion?.loading ? "Vorschlag wird erstellt …" : "Beschreibung vorschlagen"}
                </button>
                <span class="fd-hint">
                  Der Vorschlag wird erst nach „Übernehmen“ und Speichern wirksam.
                </span>
              </div>
            `
          : html`<p class="fd-hint fd-field--full">
              Ein KI-Vorschlag ist verfügbar, sobald das Produkt erstellt ist.
            </p>`}

        ${suggestion ? html`<div class="fd-field--full">${suggestion}</div>` : ""}
      </div>
    `;
  }

  _renderSuggestion(editor) {
    const suggestion = editor.suggestion;
    if (!suggestion) {
      return "";
    }
    if (suggestion.error) {
      return html`<p class="fd-error-text" role="alert">${suggestion.error}</p>`;
    }
    if (suggestion.loading) {
      return html`<p class="fd-hint" role="status" aria-live="polite">Vorschlag wird erstellt …</p>`;
    }
    return html`
      <div class="fd-suggestion">
        <label class="fd-label" for="fd-editor-suggestion">Vorschlag (bearbeitbar)</label>
        <textarea
          id="fd-editor-suggestion"
          class="fd-input fd-textarea"
          rows="4"
          .value=${suggestion.text}
          @input=${(event) => this._patchSuggestion(event.target.value)}
        ></textarea>
        <div class="fd-card-actions">
          <button type="button" class="fd-button fd-button--primary" @click=${() => this._applySuggestion()}>
            Vorschlag übernehmen
          </button>
          <button type="button" class="fd-button" @click=${() => this._discardSuggestion()}>
            Verwerfen
          </button>
        </div>

        ${Array.isArray(suggestion.tags) && suggestion.tags.length > 0
          ? html`
              <div class="fd-field">
                <span class="fd-label" id="fd-suggested-tags-label">Vorgeschlagene Tags</span>
                <p class="fd-hint" id="fd-suggested-tags-hint">
                  Nur vorhandene Tags können übernommen werden.
                </p>
                <ul
                  class="fd-chip-row"
                  role="list"
                  aria-labelledby="fd-suggested-tags-label"
                  aria-describedby="fd-suggested-tags-hint"
                >
                  ${suggestion.tags.map(
                    (tag) => html`
                      <li>
                        <button type="button" class="fd-chip" @click=${() => this._addSuggestedTag(tag)}>
                          + ${tag}
                        </button>
                      </li>
                    `,
                  )}
                </ul>
                ${suggestion.tags.length > 1
                  ? html`<div class="fd-inline-actions">
                      <button type="button" class="fd-button" @click=${() => this._applySuggestedTags()}>
                        Alle vorgeschlagenen Tags übernehmen
                      </button>
                    </div>`
                  : ""}
              </div>
            `
          : ""}

        ${Array.isArray(suggestion.rejectedTags) && suggestion.rejectedTags.length > 0
          ? html`
              <div class="fd-banner fd-banner--warning" role="note">
                <p>
                  Diese Tags gibt es noch nicht und werden nicht automatisch angelegt. Neue Tags musst du
                  selbst anlegen.
                </p>
                <ul class="fd-chip-row" role="list" aria-label="Verworfene Tag-Vorschläge">
                  ${suggestion.rejectedTags.map(
                    (tag) => html`<li class="fd-chip fd-chip--rejected">${tag}</li>`,
                  )}
                </ul>
              </div>
            `
          : ""}
      </div>
    `;
  }

  _renderEditorImages(editor) {
    if (!this._canManageImages()) {
      return html`
        <div class="fd-state fd-state--inline">
          <h3>Bilder nach dem Anlegen</h3>
          <p class="fd-hint">
            Die Artikelnummer wird erst beim Anlegen vergeben. Mit „Weiter“ wird das Produkt angelegt –
            danach kannst du bis zu ${MAX_IMAGES} Bilder hochladen.
          </p>
        </div>
      `;
    }
    const busy = this._imageBusy();
    const images = Array.isArray(editor.images) ? editor.images : [];
    const productLabel = editor.name || editor.articleNumber || "Produkt";
    const oversizedCount = this._oversizedCount(images);
    const uploadResults = Array.isArray(editor.imagesUploadResults) ? editor.imagesUploadResults : [];
    const optimizeResult = editor.imagesOptimizeResult;

    return html`
      ${editor.imagesError ? html`<div class="fd-banner fd-banner--error" role="alert">${editor.imagesError}</div>` : ""}
      ${editor.imagesNotice || uploadResults.length > 0
        ? html`<div
            id="fd-upload-result"
            class="fd-banner fd-banner--success"
            role="status"
            aria-live="polite"
            tabindex="-1"
          >
            <div class="fd-result-body">
              ${editor.imagesNotice ? html`<p>${editor.imagesNotice}</p>` : ""}
              ${uploadResults.length > 0
                ? html`<ul class="fd-result-list" role="list" aria-label="Ergebnis der Uploads">
                    ${uploadResults.map(
                      (result) => html`
                        <li>
                          <span class="fd-result-name">${result.name}</span>
                          <span>${result.message}</span>
                        </li>
                      `,
                    )}
                  </ul>`
                : ""}
            </div>
          </div>`
        : ""}

      ${oversizedCount > 0
        ? html`<div class="fd-banner fd-banner--warning" role="note">
            <p>
              ${oversizedCount === 1 ? "1 Bild ist zu groß." : `${oversizedCount} Bilder sind zu groß.`}
              Empfohlen sind höchstens 1600 px lange Kante und 400 KB je Bild.
            </p>
          </div>`
        : ""}

      <div class="fd-image-toolbar">
        <p class="fd-muted fd-small">
          ${images.length} von ${MAX_IMAGES} Bildern · Artikelnummer ${editor.articleNumber}
        </p>
        <button
          type="button"
          class="fd-button"
          @click=${() => this._optimizeImages()}
          ?disabled=${busy || oversizedCount === 0}
          aria-busy=${editor.imagesOptimizeBusy ? "true" : "false"}
          title=${oversizedCount === 0
            ? "Alle Bilder passen bereits."
            : `${oversizedCount === 1 ? "1 Bild" : `${oversizedCount} Bilder`} verkleinern`}
        >
          Bilder optimieren
        </button>
      </div>

      ${editor.imagesOptimizeError
        ? html`<div class="fd-banner fd-banner--error" role="alert">${editor.imagesOptimizeError}</div>`
        : ""}
      ${optimizeResult
        ? html`<section
            id="fd-optimize-result"
            class="fd-optimize-result"
            tabindex="-1"
            aria-live="polite"
            aria-label="Ergebnis der Bildoptimierung"
          >
            <p class="fd-optimize-summary">${optimizeResult.summaryText}</p>
            ${optimizeResult.items.length > 0
              ? html`<ul class="fd-result-list" role="list">
                  ${optimizeResult.items.map(
                    (item) => html`
                      <li class=${item.error ? "fd-result-error" : ""}>
                        <span class="fd-result-name">${item.name}</span>
                        <span>${item.message}</span>
                      </li>
                    `,
                  )}
                </ul>`
              : ""}
          </section>`
        : ""}

      <div class="fd-upload">
        <label class="fd-label" for="fd-image-upload">Bilder hochladen (maximal ${MAX_IMAGES})</label>
        <input
          id="fd-image-upload"
          class="fd-input fd-file"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          ?disabled=${busy || images.length >= MAX_IMAGES}
          @change=${(event) => this._onImagesSelected(event)}
        />
        <p class="fd-hint">
          ${images.length >= MAX_IMAGES
            ? "Die maximale Anzahl ist erreicht. Bitte zuerst ein Bild löschen."
            : "Mehrere Dateien möglich. Ein Upload über die Höchstzahl wird ohne Teilübernahme abgelehnt."}
        </p>
        <div class="fd-capture">
          <input
            id="fd-image-capture"
            class="fd-sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            capture="environment"
            ?disabled=${busy || images.length >= MAX_IMAGES}
            @change=${(event) => this._onCaptureSelected(event)}
            @cancel=${() => this._onCaptureCancelled()}
          />
          <button
            type="button"
            class="fd-button fd-button--primary"
            ?disabled=${busy || images.length >= MAX_IMAGES}
            @click=${() => this._openCapture()}
          >
            Foto aufnehmen
          </button>
          <p class="fd-hint">Ein Foto pro Aufnahme, bis zu ${MAX_IMAGES} Bilder je Produkt.</p>
          ${editor.imagesCaptureNotice
            ? html`<p class="fd-hint" role="status">${editor.imagesCaptureNotice}</p>`
            : ""}
        </div>
        ${editor.imagesBusy
          ? html`<p class="fd-hint" role="status">
              <span class="fd-spinner" aria-hidden="true"></span> Bilder werden übertragen …
            </p>`
          : ""}
      </div>

      ${editor.imagesLoading && images.length === 0
        ? html`<p class="fd-muted" role="status">
            <span class="fd-spinner" aria-hidden="true"></span> Bilder werden geladen …
          </p>`
        : ""}

      ${!editor.imagesLoading && images.length === 0
        ? html`<div class="fd-state fd-state--inline">
            <h3>Noch keine Bilder hinterlegt</h3>
            <p class="fd-hint">Lade bis zu zehn Bilder hoch. Das erste Bild ist das Hauptbild.</p>
          </div>`
        : ""}

      <ul class="fd-image-grid" role="list" aria-label="Bilder in Reihenfolge">
        ${images.map((image, index) => {
          const state = this._imageState(this._imageUrl({ articleNumber: editor.articleNumber }, image));
          const src = state.src;
          const meta = formatImageMeta(image);
          // Drehen nur im Bearbeitungsmodus, ohne laufende Aktion und nicht bei animierten Bildern.
          const canRotate = canRotateImage(image, { mode: editor.mode, busy });
          return html`
            <li class="fd-image-card">
              <div class="fd-image-preview">
                ${src
                  ? html`<img
                      src=${src}
                      alt=${image.is_main
                        ? `Hauptbild von ${productLabel}`
                        : `Bild ${index + 1} von ${productLabel}`}
                      loading="lazy"
                    />`
                  : html`<div class="fd-image-loading">
                      ${state.status === "error"
                        ? html`<span class="fd-image-error">Bild nicht verfügbar</span>`
                        : html`<span class="fd-spinner" aria-hidden="true"></span>
                            <span class="fd-sr-only">Bild wird geladen …</span>`}
                    </div>`}
                ${image.is_main ? html`<span class="fd-badge fd-badge--main">Hauptbild</span>` : ""}
              </div>
              <p class="fd-image-name" title=${image.name}>${image.name}</p>
              <p class="fd-image-meta">
                <span>${meta || "Größe unbekannt"}</span>
                ${image.oversized
                  ? html`<span
                      class="fd-image-flag"
                      role="img"
                      title=${this._oversizedTitle(image)}
                      aria-label=${this._oversizedTitle(image)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                      </svg>
                    </span>`
                  : ""}
              </p>
              <div class="fd-image-actions">
                <button
                  type="button"
                  class="fd-button fd-button--small"
                  @click=${() => this._moveImage(index, -1)}
                  ?disabled=${busy || index === 0}
                  aria-label=${`Bild ${index + 1} nach links verschieben`}
                >
                  ←
                </button>
                <button
                  type="button"
                  class="fd-button fd-button--small"
                  @click=${() => this._moveImage(index, 1)}
                  ?disabled=${busy || index === images.length - 1}
                  aria-label=${`Bild ${index + 1} nach rechts verschieben`}
                >
                  →
                </button>
                <button
                  type="button"
                  class="fd-button fd-button--small"
                  @click=${() => this._setMainImage(image.name)}
                  ?disabled=${busy || image.is_main}
                  aria-label=${`Bild ${index + 1} als Hauptbild setzen`}
                >
                  Als Hauptbild
                </button>
                ${ROTATE_DIRECTIONS.map(
                  (direction) => html`<button
                    type="button"
                    class="fd-button fd-button--small fd-image-rotate"
                    data-image=${image.name}
                    data-direction=${direction}
                    @click=${() => this._rotateImage(image.name, direction)}
                    ?disabled=${busy || !canRotate}
                    aria-label=${rotateAriaLabel(index + 1, direction)}
                    title=${image.animated
                      ? "Animierte Bilder lassen sich nicht drehen."
                      : rotateAriaLabel(index + 1, direction)}
                  >
                    ${rotateButtonLabel(direction)}
                  </button>`,
                )}
                <button
                  type="button"
                  class="fd-button fd-button--small fd-button--danger"
                  @click=${() => this._onDeleteImageClick(image.name)}
                  ?disabled=${busy}
                  aria-label=${`Bild ${index + 1} löschen`}
                >
                  ${editor.imagesPendingDelete === image.name ? "Wirklich löschen" : "Löschen"}
                </button>
              </div>
              ${editor.imagesPendingDelete === image.name
                ? html`<p class="fd-hint">Erneut „Wirklich löschen“ wählen, um das Bild zu entfernen.</p>`
                : ""}
            </li>
          `;
        })}
      </ul>
    `;
  }

  _renderEditorStock(editor) {
    const isCreate = editor.mode === "create";
    return html`
      ${this._locations.length === 0
        ? html`<div class="fd-banner fd-banner--warning" role="note">
            <p>
              ${this._locationsError
                ? this._locationsError
                : "Es sind keine Lagerstätten konfiguriert. Lege sie unter Einstellungen → Frickeldave Store → Lagerstätten an."}
            </p>
          </div>`
        : html`
            <div class="fd-stock-editors">
              ${this._locations.map((location) => {
                const value = this._stockValue(editor, location.id);
                return html`
                  <div class="fd-stock-editor">
                    <label class="fd-label" for=${`fd-editor-stock-${location.id}`}>${location.name}</label>
                    <button
                      type="button"
                      class="fd-button fd-stock-step"
                      @click=${() => this._stepStock(location.id, 1)}
                      aria-label=${`Anzahl für ${location.name} erhöhen`}
                      title=${`Anzahl für ${location.name} erhöhen`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
                      </svg>
                    </button>
                    <input
                      id=${`fd-editor-stock-${location.id}`}
                      class="fd-input fd-stock-input"
                      type="number"
                      min="0"
                      step="1"
                      inputmode="numeric"
                      .value=${String(value)}
                      aria-label=${`Bestand für ${location.name}`}
                      @input=${(event) => this._setStockValue(location.id, event.target.value)}
                    />
                    <button
                      type="button"
                      class="fd-button fd-stock-step"
                      @click=${() => this._stepStock(location.id, -1)}
                      ?disabled=${value <= 0}
                      aria-label=${`Anzahl für ${location.name} verringern`}
                      title=${`Anzahl für ${location.name} verringern`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M19 13H5v-2h14v2z" />
                      </svg>
                    </button>
                  </div>
                `;
              })}
            </div>
            <p class="fd-hint">
              Die Buttons ändern nur das Formular. Übernommen wird der Bestand mit „Speichern“.
            </p>
          `}

      ${isCreate
        ? html`<p class="fd-hint">Die Buchungshistorie ist verfügbar, sobald das Produkt erstellt ist.</p>`
        : this._renderBookings(editor)}
    `;
  }

  _renderBookings(editor) {
    const bookings = Array.isArray(editor.bookings) ? editor.bookings : [];
    return html`
      <section class="fd-bookings" aria-labelledby="fd-bookings-title">
        <div class="fd-config-toolbar">
          <h3 id="fd-bookings-title">Buchungshistorie</h3>
          <button
            type="button"
            class="fd-button fd-button--small"
            @click=${() => this._loadBookings(editor.articleNumber)}
            ?disabled=${editor.bookingsLoading}
          >
            Neu laden
          </button>
        </div>
        ${editor.bookingsError
          ? html`<div class="fd-banner fd-banner--error" role="alert">${editor.bookingsError}</div>`
          : ""}
        ${editor.bookingsLoading && bookings.length === 0
          ? html`<p class="fd-muted" role="status">Buchungen werden geladen …</p>`
          : ""}
        ${!editor.bookingsLoading && !editor.bookingsError && bookings.length === 0
          ? html`<p class="fd-hint">Noch keine Buchungen vorhanden.</p>`
          : ""}
        ${bookings.length > 0
          ? html`
              <ul class="fd-booking-list" role="list">
                ${bookings.map(
                  (booking) => html`
                    <li class="fd-booking">
                      <div class="fd-booking-head">
                        <span class="fd-badge">${this._bookingTypeLabel(booking.type)}</span>
                        <strong>${formatNumber(booking.quantity)} Stück</strong>
                        <span class="fd-muted fd-small">${formatDateTime(booking.at)}</span>
                      </div>
                      <p class="fd-hint">
                        ${booking.locationName || "Unbekannte Lagerstätte"}${booking.targetLocationName
                          ? ` → ${booking.targetLocationName}`
                          : ""}
                        ${booking.note ? ` · ${booking.note}` : ""}
                      </p>
                    </li>
                  `,
                )}
              </ul>
            `
          : ""}
      </section>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Bild-Aktionen im Editor                                                */
  /* --------------------------------------------------------------------- */

  _onDeleteImageClick(name) {
    const editor = this._editor;
    if (!editor || editor.mode !== "edit" || this._imageBusy()) {
      return;
    }
    if (editor.imagesPendingDelete === name) {
      this._deleteImage(name);
      return;
    }
    this._requestDeleteImage(name);
  }

  /* --------------------------------------------------------------------- */
  /* Veröffentlichen (dev/prod mit Dry-Run)                                 */
  /* --------------------------------------------------------------------- */

  _openPublish(target) {
    if (!this._can("app_admin") || !PUBLISH_TARGET_LABELS[target]) {
      return;
    }
    const feature = this._featureInfo("publish");
    if (!feature.available) {
      this._showToast(this._featureHint(feature, "Veröffentlichen"));
      return;
    }
    this._captureFocus();
    this._publishDialog = {
      target,
      phase: "checking",
      busy: true,
      error: "",
      result: null,
      message: "",
      emptyCatalog: false,
      allowEmpty: false,
      confirmRemovals: false,
      fileFilter: FILE_FILTER_ALL,
    };
    this._requestPublish(true);
  }

  _closePublish() {
    if (this._publishDialog?.busy) {
      return;
    }
    this._publishDialog = null;
    this._restoreFocus();
  }

  _setPublishMessage(value) {
    if (!this._publishDialog) {
      return;
    }
    this._publishDialog = { ...this._publishDialog, message: String(value ?? "").slice(0, 200) };
  }

  _setPublishAllowEmpty(value) {
    if (!this._publishDialog) {
      return;
    }
    this._publishDialog = { ...this._publishDialog, allowEmpty: Boolean(value) };
  }

  _setPublishConfirmRemovals(value) {
    if (!this._publishDialog) {
      return;
    }
    this._publishDialog = {
      ...this._publishDialog,
      confirmRemovals: Boolean(value),
      error: this._publishDialog.removalsBlocked ? "" : this._publishDialog.error,
    };
  }

  _setPublishFilter(status) {
    const dialog = this._publishDialog;
    if (!dialog || dialog.fileFilter === status) {
      return;
    }
    if (status !== FILE_FILTER_ALL && !PUBLISH_STATUS_META[status]) {
      return;
    }
    this._publishDialog = { ...dialog, fileFilter: status };
  }

  _publishErrorText(error) {
    const featureText = this._featureErrorText(error, "Das Veröffentlichen");
    if (featureText) {
      return featureText;
    }
    const text = this._errorText(error);
    if (error instanceof ApiError) {
      if (error.code === "publish_token_missing" || error.code === "publish_not_configured") {
        return `${text} Hinterlege das Token in den Einstellungen der Erweiterung „Frickeldave Store Sync“ unter Geräte & Dienste.`;
      }
      if (error.code === "internal_error") {
        return `${text} Details stehen im Home-Assistant-Protokoll (Filter: frickeldave_store).`;
      }
    }
    return text;
  }

  _publishStatusText(dialog) {
    if (dialog.busy) {
      return "Anfrage läuft …";
    }
    if (dialog.phase === "done") {
      return "Veröffentlichung abgeschlossen.";
    }
    if (dialog.phase === "error") {
      return "Dry-Run fehlgeschlagen.";
    }
    if (dialog.phase === "dry-run") {
      return dialog.emptyCatalog
        ? "Veröffentlichung abgelehnt: Der Store ist leer."
        : "Dry-Run abgeschlossen.";
    }
    return "";
  }

  _publishToastMessage(result) {
    const target = PUBLISH_TARGET_LABELS[result.target] || result.target;
    const commit = result.commit
      ? `Commit ${result.commit.slice(0, 7)}`
      : result.changed
        ? "Commit erstellt"
        : "keine Dateiänderungen";
    const deployment = result.deployment.triggered
      ? "Deployment ausgelöst"
      : "kein Deployment ausgelöst";
    const base = `Nach ${target} veröffentlicht: ${commit}, ${deployment}.`;
    return result.warning ? `${base} ${result.warning}` : base;
  }

  async _requestPublish(dryRun) {
    const dialog = this._publishDialog;
    if (!dialog) {
      return;
    }
    const allowEmpty = !dryRun && Boolean(dialog.allowEmpty);
    const confirmRemovals = !dryRun && Boolean(dialog.confirmRemovals);
    if (!dryRun) {
      // Beim bestätigten Leeren bleibt die Ablehnung sichtbar, bis die Antwort da ist.
      this._publishDialog = {
        ...dialog,
        busy: true,
        error: dialog.emptyCatalog || dialog.removalsBlocked ? dialog.error : "",
      };
    }
    const message = dialog.message.trim();
    try {
      const data = await this._api(`${API_ROOT}/features/publish`, {
        method: "POST",
        body: {
          target: dialog.target,
          dry_run: Boolean(dryRun),
          ...(allowEmpty ? { allow_empty: true } : {}),
          ...(confirmRemovals ? { confirm_removals: true } : {}),
          ...(message ? { message } : {}),
        },
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      if (!this._publishDialog) {
        return;
      }
      const result = normalizePublishResult(data);
      if (dryRun) {
        this._publishDialog = {
          ...this._publishDialog,
          phase: "dry-run",
          busy: false,
          error: "",
          result,
          emptyCatalog: false,
          allowEmpty: false,
          confirmRemovals: false,
          fileFilter: FILE_FILTER_ALL,
        };
      } else {
        this._publishDialog = {
          ...this._publishDialog,
          phase: "done",
          busy: false,
          error: "",
          result,
          emptyCatalog: false,
          allowEmpty: false,
          confirmRemovals: false,
          fileFilter: FILE_FILTER_ALL,
        };
        this._showToast(this._publishToastMessage(result));
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (!this._publishDialog) {
        return;
      }
      if (isFeatureError(error)) {
        this._reloadFeatures();
      }
      const code = error instanceof ApiError ? error.code : "";
      const emptyCatalog = !dryRun && code === "publish_empty_catalog";
      const removalsBlocked = !dryRun && code === "publish_removals_blocked";
      this._publishDialog = {
        ...this._publishDialog,
        phase: dryRun ? "error" : "dry-run",
        busy: false,
        error: this._publishErrorText(error),
        emptyCatalog,
        removalsBlocked,
        // Zustimmung gilt nie fort: nach einem Fehler und nach jedem Abbruch
        // muss der Notausgang erneut bewusst gesetzt werden.
        allowEmpty: false,
        confirmRemovals: false,
      };
      if (emptyCatalog) {
        this.updateComplete
          .then(() => {
            const checkbox = this.renderRoot?.querySelector("#fd-publish-allow-empty");
            if (checkbox && typeof checkbox.focus === "function") {
              checkbox.focus();
            }
          })
          .catch(() => {});
      }
      if (removalsBlocked) {
        this.updateComplete
          .then(() => {
            const checkbox = this.renderRoot?.querySelector("#fd-publish-confirm-removals");
            if (checkbox && typeof checkbox.focus === "function") {
              checkbox.focus();
            }
          })
          .catch(() => {});
      }
    }
  }

  _renderPublishHeading(id, title, total) {
    return html`
      <h3 id=${id}>
        <span>${title}</span>
        <span class="fd-publish-total">
          <span class="fd-sr-only">gesamt: </span>${formatNumber(total)}
        </span>
      </h3>
    `;
  }

  _renderCounts(counts) {
    return html`
      <dl class="fd-publish-counts">
        ${["added", "changed", "removed", "unchanged"].map((status) => {
          const meta = PUBLISH_STATUS_META[status];
          return html`
            <div class="fd-publish-count">
              <dt>
                <span class="fd-status-icon" aria-hidden="true">${meta.icon}</span>
                ${meta.label}
              </dt>
              <dd>${formatNumber(counts[status])}</dd>
            </div>
          `;
        })}
      </dl>
    `;
  }

  _renderPublishDialog() {
    const dialog = this._publishDialog;
    if (!dialog) {
      return "";
    }
    const target = PUBLISH_TARGET_LABELS[dialog.target] || dialog.target;
    const result = dialog.result;
    const done = dialog.phase === "done";
    const dryRun = dialog.phase === "dry-run";
    const emptyCatalog = Boolean(dialog.emptyCatalog) && !done;
    const removalsBlocked =
      !done && (Boolean(dialog.removalsBlocked) || Boolean(result?.removalGuard?.triggered));
    const warning = emptyCatalog || dialog.removalsBlocked ? "" : result?.warning || "";
    const deploymentBranch = result?.deployment?.branch || result?.branch || "";
    const fileFilter = dialog.fileFilter || FILE_FILTER_ALL;
    const fileCounts = result ? fileStatusCounts(result.files) : null;
    const visibleFiles = result ? filterFileChanges(result.files, fileFilter) : [];

    return html`
      <dialog
        id="fd-publish-dialog"
        class="fd-dialog fd-dialog--wide"
        aria-labelledby="fd-publish-title"
        @cancel=${(event) => this._handleDialogCancel(event, () => this._closePublish())}
        @click=${(event) => {
          if (event.target === event.currentTarget) {
            this._closePublish();
          }
        }}
      >
        <div class="fd-dialog-head">
          <button
            type="button"
            class="fd-icon-button fd-dialog-close"
            @click=${() => this._closePublish()}
            ?disabled=${dialog.busy}
            aria-label="Dialog schließen"
            title="Dialog schließen"
          >
            ✕
          </button>
          <div class="fd-dialog-title">
            <h2 id="fd-publish-title">${done ? "Veröffentlicht" : `Nach ${target} veröffentlichen`}</h2>
          </div>
        </div>

        <div class="fd-dialog-body">
          <p class="fd-sr-only" role="status">${this._publishStatusText(dialog)}</p>

          ${emptyCatalog
            ? html`
                <div class="fd-banner fd-banner--warning" role="alert">
                  <p><strong>Veröffentlichung abgelehnt.</strong></p>
                  <p>${dialog.error}</p>
                  <p>
                    Wenn du fortfährst, zeigt die Website keine Produkte mehr, bis du wieder welche
                    veröffentlichst.
                  </p>
                </div>
                <section class="fd-publish-confirm" aria-labelledby="fd-publish-empty-title">
                  <h3 id="fd-publish-empty-title">Leeren bestätigen</h3>
                  <label class="fd-switch">
                    <input
                      id="fd-publish-allow-empty"
                      type="checkbox"
                      .checked=${Boolean(dialog.allowEmpty)}
                      ?disabled=${dialog.busy}
                      aria-describedby="fd-publish-empty-hint"
                      @change=${(event) => this._setPublishAllowEmpty(event.target.checked)}
                    />
                    <span>Ich verstehe, dass der Website-Katalog geleert wird</span>
                  </label>
                  <p class="fd-hint" id="fd-publish-empty-hint">
                    „Trotzdem veröffentlichen“ ist erst nach dem Anhaken möglich. Die Zustimmung gilt
                    nur für diesen Lauf und wird nicht gespeichert.
                  </p>
                </section>
              `
            : dialog.error
              ? html`<div class="fd-banner fd-banner--error" role="alert">
                  <p>${dialog.error}</p>
                  ${dialog.phase === "error"
                    ? html`<div class="fd-inline-actions">
                        <button
                          type="button"
                          class="fd-button fd-button--small"
                          @click=${() => this._requestPublish(true)}
                        >
                          Dry-Run erneut starten
                        </button>
                      </div>`
                    : ""}
                </div>`
              : ""}

          ${warning
            ? html`<div class="fd-banner fd-banner--warning" role="note">
                <p>${warning}</p>
              </div>`
            : ""}

          ${removalsBlocked
            ? html`
                <section class="fd-publish-confirm" aria-labelledby="fd-publish-removals-title">
                  <h3 id="fd-publish-removals-title">Löschung bestätigen</h3>
                  <label class="fd-switch">
                    <input
                      id="fd-publish-confirm-removals"
                      type="checkbox"
                      .checked=${Boolean(dialog.confirmRemovals)}
                      ?disabled=${dialog.busy}
                      aria-describedby="fd-publish-removals-hint"
                      @change=${(event) => this._setPublishConfirmRemovals(event.target.checked)}
                    />
                    <span>
                      Ich verstehe, dass mehrere Bilder von der Website entfernt werden
                    </span>
                  </label>
                  <p class="fd-hint" id="fd-publish-removals-hint">
                    Der Löschschutz greift bei mehr als
                    ${formatNumber(result?.removalGuard?.maxFiles ?? 10)} entfernten Bildern oder
                    mehr als einem Drittel des bestehenden Bildbestands. „Jetzt veröffentlichen“
                    ist erst nach dem Anhaken möglich; die Bestätigung gilt nur für diesen Lauf.
                  </p>
                </section>
              `
            : ""}

          ${dialog.phase === "checking"
            ? html`
                <p class="fd-muted" role="status">
                  <span class="fd-spinner" aria-hidden="true"></span> Repository wird verglichen …
                </p>
              `
            : ""}

          ${result
            ? html`
                <dl class="fd-publish-meta">
                  <div>
                    <dt>Ziel</dt>
                    <dd>${target}</dd>
                  </div>
                  <div>
                    <dt>Zielbranch</dt>
                    <dd>${deploymentBranch || "—"}</dd>
                  </div>
                  <div>
                    <dt>Repository</dt>
                    <dd>${result.repository || "—"}</dd>
                  </div>
                </dl>

                <section class="fd-publish-section" aria-labelledby="fd-publish-products-title">
                  ${this._renderPublishHeading(
                    "fd-publish-products-title",
                    "Produkte",
                    result.products.total,
                  )}
                  ${this._renderCounts(result.products)}
                </section>

                <section class="fd-publish-section" aria-labelledby="fd-publish-images-title">
                  ${this._renderPublishHeading(
                    "fd-publish-images-title",
                    "Bilder",
                    result.images.total,
                  )}
                  ${this._renderCounts(result.images)}
                </section>

                <div class="fd-banner ${result.deployment.wouldTrigger || result.deployment.triggered ? "fd-banner--warning" : "fd-banner--success"}" role="note">
                  <p>
                    ${done
                      ? result.deployment.triggered
                        ? "Deployment wurde ausgelöst."
                        : "Kein Deployment wurde ausgelöst."
                      : result.deployment.wouldTrigger
                        ? `Ein Deployment würde ausgelöst (${result.deployment.workflow || "Workflow"} über ${result.deployment.mode || "push"}).`
                        : "Es würde kein Deployment ausgelöst, weil sich nichts ändert."}
                  </p>
                </div>

                ${done && result.commit
                  ? html`<p class="fd-muted fd-small">Commit: ${result.commit}</p>`
                  : ""}

                <section class="fd-publish-section" aria-labelledby="fd-publish-filelist-title">
                  <h3 id="fd-publish-filelist-title">Dateiliste</h3>
                  ${result.files.length === 0
                    ? html`<p class="fd-hint">Keine Dateien in der Antwort.</p>`
                    : html`
                        <div
                          class="fd-publish-filters"
                          role="group"
                          aria-label="Dateiliste nach Status filtern"
                        >
                          ${statusOptions(fileCounts).map((option) => {
                            const meta =
                              option.status === FILE_FILTER_ALL
                                ? { label: "Alle" }
                                : PUBLISH_STATUS_META[option.status];
                            return html`
                              <button
                                type="button"
                                class="fd-chip fd-publish-filter"
                                aria-pressed=${fileFilter === option.status ? "true" : "false"}
                                @click=${() => this._setPublishFilter(option.status)}
                              >
                                ${meta.label}
                                <span class="fd-publish-filter-count">
                                  ${formatNumber(option.count)}
                                </span>
                              </button>
                            `;
                          })}
                        </div>
                        ${visibleFiles.length === 0
                          ? html`<p class="fd-hint" role="status">
                              Keine Dateien mit dem Status
                              „${PUBLISH_STATUS_META[fileFilter]?.label || fileFilter}“.
                            </p>`
                          : html`
                              <ul class="fd-publish-filelist" role="list">
                                ${visibleFiles.map((entry) => {
                                  const meta = PUBLISH_STATUS_META[entry.status];
                                  return html`
                                    <li class="fd-publish-file">
                                      <span class="fd-status-icon" aria-hidden="true">${meta.icon}</span>
                                      <span class="fd-publish-file-status">${meta.label}</span>
                                      <span class="fd-publish-file-path">${entry.path}</span>
                                      <span class="fd-muted fd-small">
                                        ${entry.kind === "image" ? "Bild" : "Katalog"}${entry.articleNumber
                                          ? ` · ${entry.articleNumber}`
                                          : ""}
                                      </span>
                                    </li>
                                  `;
                                })}
                              </ul>
                            `}
                      `}
                  ${result.filesTruncated
                    ? html`<p class="fd-hint">
                        Die Liste ist gekürzt: weitere Dateien werden nicht angezeigt.
                      </p>`
                    : ""}
                </section>

                ${dryRun
                  ? html`
                      <div class="fd-field">
                        <label class="fd-label" for="fd-publish-message">Commit-Nachricht (optional)</label>
                        <input
                          id="fd-publish-message"
                          class="fd-input"
                          type="text"
                          maxlength="200"
                          .value=${dialog.message}
                          @input=${(event) => this._setPublishMessage(event.target.value)}
                        />
                        <p class="fd-hint">Höchstens 200 Zeichen. Leer lassen für die Standardmeldung.</p>
                      </div>
                    `
                  : ""}
              `
            : ""}
        </div>

        <div class="fd-dialog-foot">
          ${done
            ? html`<button type="button" class="fd-button fd-button--primary" @click=${() => this._closePublish()}>
                Schließen
              </button>`
            : emptyCatalog
              ? html`
                  <button
                    type="button"
                    class="fd-button fd-button--plain"
                    @click=${() => this._closePublish()}
                    ?disabled=${dialog.busy}
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    class="fd-button fd-button--danger"
                    @click=${() => this._requestPublish(false)}
                    ?disabled=${!dialog.allowEmpty || dialog.busy}
                    aria-busy=${dialog.busy ? "true" : "false"}
                  >
                    ${dialog.busy ? "Veröffentlichen …" : "Trotzdem veröffentlichen"}
                  </button>
                `
              : html`
                  <button
                    type="button"
                    class="fd-button fd-button--plain"
                    @click=${() => this._closePublish()}
                    ?disabled=${dialog.busy}
                    data-autofocus
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    class="fd-button fd-button--primary"
                    @click=${() => this._requestPublish(false)}
                    ?disabled=${!dryRun || dialog.busy || (removalsBlocked && !dialog.confirmRemovals)}
                    aria-busy=${dialog.busy ? "true" : "false"}
                  >
                    ${dialog.busy ? "Veröffentlichen …" : "Jetzt veröffentlichen"}
                  </button>
                `}
        </div>
      </dialog>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Render: Archivierung                                                   */
  /* --------------------------------------------------------------------- */

  _renderArchiveDialog() {
    const dialog = this._archiveDialog;
    if (!dialog) {
      return "";
    }
    const product = dialog.product;
    const productLabel = product.name || product.articleNumber || "Produkt";

    return html`
      <dialog
        id="fd-archive-dialog"
        class="fd-dialog"
        aria-labelledby="fd-archive-title"
        aria-describedby="fd-archive-description"
        @cancel=${(event) => this._handleDialogCancel(event, () => this._closeArchive())}
        @click=${(event) => {
          if (event.target === event.currentTarget) {
            this._closeArchive();
          }
        }}
      >
        <div class="fd-dialog-head">
          <div class="fd-dialog-title">
            <h2 id="fd-archive-title">Produkt archivieren</h2>
            <p class="fd-muted fd-small">${productLabel} · Artikelnummer ${product.articleNumber}</p>
          </div>
        </div>

        <div class="fd-dialog-body">
          ${dialog.error ? html`<div class="fd-banner fd-banner--error" role="alert">${dialog.error}</div>` : ""}
          <div class="fd-banner fd-banner--warning" role="note" id="fd-archive-description">
            <p>
              Das Produkt verschwindet aus der Website und aus dem Export. Die Daten und Bilder bleiben
              erhalten und können über „Archivierte anzeigen“ weiterhin eingesehen werden.
            </p>
          </div>
          <p class="fd-hint">Ein endgültiges Löschen ist nicht vorgesehen.</p>
        </div>

        <div class="fd-dialog-foot">
          <button
            type="button"
            class="fd-button fd-button--plain"
            data-autofocus
            @click=${() => this._closeArchive()}
            ?disabled=${dialog.saving}
          >
            Abbrechen
          </button>
          <button
            type="button"
            class="fd-button fd-button--primary"
            @click=${() => this._confirmArchive()}
            ?disabled=${dialog.saving}
            aria-busy=${dialog.saving ? "true" : "false"}
          >
            ${dialog.saving ? "Archivieren …" : "Archivieren"}
          </button>
        </div>
      </dialog>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Render: Katalogimport                                                  */
  /* --------------------------------------------------------------------- */

  _renderImportDialog() {
    const dialog = this._importDialog;
    if (!dialog) {
      return "";
    }
    const running = dialog.busy;
    const result = dialog.result;
    const showIntro = dialog.phase !== "result";
    const preview = dialog.preview;

    return html`
      <dialog
        id="fd-import-dialog"
        class="fd-dialog"
        aria-labelledby="fd-import-title"
        @cancel=${(event) => this._handleDialogCancel(event, () => this._closeImport())}
        @click=${(event) => {
          if (event.target === event.currentTarget) {
            this._closeImport();
          }
        }}
      >
        <div class="fd-dialog-head">
          <button
            type="button"
            class="fd-icon-button fd-dialog-close"
            @click=${() => this._closeImport()}
            ?disabled=${running}
            aria-label="Dialog schließen"
            title="Dialog schließen"
          >
            ✕
          </button>
          <div class="fd-dialog-title">
            <h2 id="fd-import-title">Katalog importieren</h2>
            <p class="fd-muted fd-small">Produkte der Live-Website übernehmen</p>
          </div>
        </div>

        <div class="fd-dialog-body">
          ${showIntro
            ? html`
                <div class="fd-import-intro">
                  <p>
                    Der aktuelle Katalog von <strong>frickeldave.de</strong> wird in diese Verwaltung geladen.
                  </p>
                  <ul class="fd-import-notes">
                    <li>
                      Ohne „Bestehende Produkte überschreiben“ bleiben vorhandene Produkte unverändert;
                      es werden nur neue Produkte angelegt.
                    </li>
                    <li>
                      Zu jedem Produkt werden bis zu ${MAX_IMAGES} Bilder aus dem Website-Repository
                      übernommen.
                    </li>
                    <li>
                      Der Vorgang kann einen Moment dauern. Die Seite bitte bis zum Abschluss geöffnet
                      lassen.
                    </li>
                  </ul>
                </div>

                <div class="fd-field">
                  <label class="fd-switch">
                    <input
                      type="checkbox"
                      .checked=${Boolean(dialog.overwrite)}
                      ?disabled=${running}
                      aria-describedby="fd-import-overwrite-hint"
                      @change=${(event) => this._toggleImportOverwrite(event.target.checked)}
                    />
                    <span>Bestehende Produkte überschreiben</span>
                  </label>
                  <p class="fd-hint" id="fd-import-overwrite-hint">
                    Standardmäßig aus. Vorhandene Produkte bleiben dann unverändert.
                  </p>
                </div>

                ${dialog.overwrite
                  ? html`
                      <div class="fd-banner fd-banner--warning" role="note">
                        <p><strong>Vorhandene Produkte werden überschrieben.</strong></p>
                        <p>
                          Überschrieben werden: Name, Beschreibung, Preis, Größe, Tags, Sichtbarkeit,
                          Personalisierbarkeit und Bestand.
                        </p>
                        <p>
                          Erhalten bleiben: Artikelnummer, Anlagedatum, Bilder, Buchungen, Archiv-Status
                          und Kategorie.
                        </p>
                      </div>
                    `
                  : ""}

                ${dialog.previewLoading
                  ? html`
                      <div
                        id="fd-import-preview-status"
                        class="fd-state fd-state--inline"
                        role="status"
                        aria-live="polite"
                        tabindex="-1"
                      >
                        <span class="fd-spinner" aria-hidden="true"></span>
                        <p>Vorschau wird geladen …</p>
                      </div>
                    `
                  : dialog.previewError
                    ? html`
                        <div
                          id="fd-import-preview-error"
                          class="fd-banner fd-banner--error"
                          role="alert"
                          tabindex="-1"
                        >
                          <p>${dialog.previewError}</p>
                          <button type="button" class="fd-button" @click=${() => this._loadImportPreview()}>
                            Vorschau erneut laden
                          </button>
                        </div>
                      `
                    : preview
                      ? this._renderImportPreview(preview)
                      : ""}
              `
            : ""}

          ${dialog.error
            ? html`
                <div id="fd-import-error" class="fd-banner fd-banner--error" role="alert" tabindex="-1">
                  ${dialog.error}
                </div>
              `
            : ""}

          ${running
            ? html`
                <div
                  id="fd-import-status"
                  class="fd-state fd-state--inline"
                  role="status"
                  aria-live="polite"
                  tabindex="-1"
                >
                  <span class="fd-spinner" aria-hidden="true"></span>
                  <p>Katalog wird importiert …</p>
                </div>
              `
            : ""}

          ${result ? this._renderImportResult(result) : ""}
        </div>

        <div class="fd-dialog-foot">
          ${dialog.phase === "result"
            ? html`
                <div class="fd-dialog-foot-actions">
                  <button
                    type="button"
                    class="fd-button"
                    @click=${() => this._resetImportPreview()}
                    ?disabled=${running}
                  >
                    Erneut prüfen
                  </button>
                  <button type="button" class="fd-button fd-button--primary" @click=${() => this._closeImport()}>
                    Schließen
                  </button>
                </div>
              `
            : html`
                <div class="fd-dialog-foot-actions">
                  <button
                    type="button"
                    class="fd-button fd-button--plain"
                    @click=${() => this._closeImport()}
                    ?disabled=${running}
                    data-autofocus
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    class="fd-button fd-button--primary"
                    @click=${() => this._startImport()}
                    ?disabled=${running || dialog.previewLoading}
                    aria-busy=${running ? "true" : "false"}
                  >
                    ${running
                      ? "Import läuft …"
                      : dialog.overwrite
                        ? "Import mit Überschreiben starten"
                        : "Import starten"}
                  </button>
                </div>
              `}
        </div>
      </dialog>
    `;
  }

  _renderImportPreview(preview) {
    return html`
      <section id="fd-import-preview" class="fd-import-preview" aria-live="polite">
        <h3>Vorschau</h3>

        <dl class="fd-import-summary">
          <div class="fd-import-stat">
            <dt>Neu</dt>
            <dd>${formatNumber(preview.wouldCreate)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Zu überschreiben</dt>
            <dd>${formatNumber(preview.wouldOverwrite)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Unverändert</dt>
            <dd>${formatNumber(preview.unchanged)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Fehlerhaft</dt>
            <dd class=${preview.failed > 0 ? "fd-import-stat--error" : ""}>
              ${formatNumber(preview.failed)}
            </dd>
          </div>
          <div class="fd-import-stat">
            <dt>Bilder</dt>
            <dd>${formatNumber(preview.imagesImported)}</dd>
          </div>
        </dl>

        ${preview.summary
          ? html`<p class="fd-hint">${preview.summary}</p>`
          : html`<p class="fd-hint">
              ${formatNumber(preview.productsTotal)} Produkte im Katalog geprüft. Es wurde nichts
              geschrieben.
            </p>`}

        ${preview.errors.length > 0
          ? html`
              <div class="fd-import-errors">
                <h4>Hinweise aus der Vorschau</h4>
                <ul role="list">
                  ${preview.errors.map(
                    (entry) => html`
                      <li>
                        <strong>${entry.articleNumber || "Ohne Artikelnummer"}</strong>
                        <span>${entry.message || "Unbekannter Fehler."}</span>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
          : ""}
      </section>
    `;
  }

  _renderImportResult(result) {
    const errorCount = result.errors.length;

    return html`
      <section id="fd-import-result" class="fd-import-result" tabindex="-1" aria-live="polite">
        <h3>Import abgeschlossen</h3>

        <dl class="fd-import-summary">
          <div class="fd-import-stat">
            <dt>Neu</dt>
            <dd>${formatNumber(result.created)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Überschrieben</dt>
            <dd>${formatNumber(result.overwritten)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Unverändert</dt>
            <dd>${formatNumber(result.skipped)}</dd>
          </div>
          <div class="fd-import-stat">
            <dt>Fehlgeschlagen</dt>
            <dd class=${errorCount > 0 || result.failed > 0 ? "fd-import-stat--error" : ""}>
              ${formatNumber(result.failed)}
            </dd>
          </div>
          <div class="fd-import-stat">
            <dt>Bilder</dt>
            <dd>${formatNumber(result.imagesImported)}</dd>
          </div>
        </dl>

        ${result.summary ? html`<p class="fd-hint">${result.summary}</p>` : ""}

        <p class="fd-muted fd-small">
          ${result.productsTotal === 1
            ? "1 Produkt im Katalog."
            : `${formatNumber(result.productsTotal)} Produkte im Katalog.`}
        </p>

        ${errorCount > 0
          ? html`
              <div class="fd-import-errors">
                <h4>Fehler pro Produkt</h4>
                <ul role="list">
                  ${result.errors.map(
                    (entry) => html`
                      <li>
                        <strong>${entry.articleNumber || "Ohne Artikelnummer"}</strong>
                        <span>${entry.message || "Unbekannter Fehler."}</span>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
          : ""}
      </section>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Render: Tag-Verwaltung                                                 */
  /* --------------------------------------------------------------------- */

  _setTagDraft(value) {
    if (!this._tagsDialog) {
      return;
    }
    this._tagsDialog = { ...this._tagsDialog, draft: value, error: "", notice: "" };
  }

  _onDeleteTagClick(name) {
    const dialog = this._tagsDialog;
    if (!dialog || dialog.busy) {
      return;
    }
    if (dialog.pendingDelete === name) {
      this._deleteTag(name);
      return;
    }
    this._requestDeleteTag(name);
  }

  _renderTagsDialog() {
    const dialog = this._tagsDialog;
    if (!dialog) {
      return "";
    }

    return html`
      <dialog
        id="fd-tags-dialog"
        class="fd-dialog"
        aria-labelledby="fd-tags-title"
        @cancel=${(event) => this._handleDialogCancel(event, () => this._closeTags())}
        @click=${(event) => {
          if (event.target === event.currentTarget) {
            this._closeTags();
          }
        }}
      >
        <div class="fd-dialog-head">
          <button
            type="button"
            class="fd-icon-button fd-dialog-close"
            @click=${() => this._closeTags()}
            ?disabled=${dialog.busy}
            aria-label="Dialog schließen"
            title="Dialog schließen"
          >
            ✕
          </button>
          <div class="fd-dialog-title">
            <h2 id="fd-tags-title">Tags verwalten</h2>
            <p class="fd-muted fd-small">Tags sind öffentliche Filter der Website.</p>
          </div>
        </div>

        <div class="fd-dialog-body">
          ${dialog.error ? html`<div class="fd-banner fd-banner--error" role="alert">${dialog.error}</div>` : ""}
          ${dialog.notice ? html`<div class="fd-banner fd-banner--success" role="status">${dialog.notice}</div>` : ""}

          <form class="fd-tag-input-row" @submit=${(event) => this._addTag(event)}>
            <label class="fd-sr-only" for="fd-tag-draft">Neuer Tag</label>
            <input
              id="fd-tag-draft"
              data-autofocus
              class="fd-input"
              type="text"
              maxlength="40"
              placeholder="Neuer Tag"
              .value=${dialog.draft}
              @input=${(event) => this._setTagDraft(event.target.value)}
            />
            <button type="submit" class="fd-button fd-button--primary" ?disabled=${dialog.busy} aria-busy=${dialog.busy ? "true" : "false"}>Erstellen</button>
          </form>

          ${dialog.loading ? html`<p class="fd-muted" role="status">Tags werden geladen …</p>` : ""}
          ${!dialog.loading && dialog.tags.length === 0
            ? html`<div class="fd-state fd-state--inline">
                <h3>Noch keine Tags vorhanden</h3>
                <p class="fd-hint">Erstellen Sie oben den ersten Tag.</p>
              </div>`
            : ""}

          <ul class="fd-tag-manage-list" role="list">
            ${dialog.tags.map(
              (tag) => html`
                <li class="fd-tag-manage">
                  <span>${tag}</span>
                  <button
                    type="button"
                    class="fd-button fd-button--small${dialog.pendingDelete === tag ? " fd-button--danger" : ""}"
                    @click=${() => this._onDeleteTagClick(tag)}
                    ?disabled=${dialog.busy}
                    aria-label=${`Tag ${tag} löschen`}
                  >
                    ${dialog.pendingDelete === tag ? "Wirklich löschen" : "Löschen"}
                  </button>
                </li>
              `,
            )}
          </ul>
        </div>

        <div class="fd-dialog-foot">
          <button
            type="button"
            class="fd-button fd-button--plain"
            @click=${() => this._closeTags()}
            ?disabled=${dialog.busy}
          >
            Schließen
          </button>
        </div>
      </dialog>
    `;
  }

  _renderToast() {
    return html`
      <div class="fd-toast-slot" role="status" aria-live="polite">
        ${this._toast ? html`<div class="fd-toast">${this._toast.message}</div>` : ""}
      </div>
    `;
  }

  /* --------------------------------------------------------------------- */
  /* Styles: HA-Design-Tokens plus eigene --fd-* Schicht                    */
  /* --------------------------------------------------------------------- */

  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--ha-color-text-primary, var(--primary-text-color, #212121));
      background-color: var(--ha-color-surface-lower, var(--primary-background-color, transparent));
      font-family: var(
        --ha-font-family-body,
        var(--paper-font-body1_-_font-family, Roboto, "Helvetica Neue", Arial, sans-serif)
      );
      font-size: var(--ha-font-size-m, 14px);
      line-height: var(--fd-line-height, 1.6);

      --fd-space-1: var(--ha-space-1, 4px);
      --fd-space-2: var(--ha-space-2, 8px);
      --fd-space-3: var(--ha-space-3, 12px);
      --fd-space-4: var(--ha-space-4, 16px);
      --fd-space-6: var(--ha-space-6, 24px);
      --fd-space-8: var(--ha-space-8, 32px);

      --fd-radius-lg: var(--ha-border-radius-lg, var(--ha-card-border-radius, 12px));
      --fd-radius: var(--ha-border-radius-md, 8px);
      --fd-radius-sm: var(--ha-border-radius-md, 8px);
      --fd-radius-pill: var(--ha-border-radius-pill, 999px);
      --fd-radius-dialog: var(--ha-border-radius-xl, 16px);

      --fd-surface: var(--ha-color-surface-default, var(--card-background-color, #ffffff));
      --fd-surface-alt: var(--ha-color-surface-low, var(--secondary-background-color, rgba(127, 127, 127, 0.08)));
      --fd-text: var(--ha-color-text-primary, var(--primary-text-color, #212121));
      --fd-text-muted: var(--ha-color-text-secondary, var(--secondary-text-color, #6b6b6b));
      --fd-divider: var(--ha-color-border-neutral-quiet, var(--divider-color, rgba(0, 0, 0, 0.12)));
      --fd-border-strong: var(--ha-color-border-neutral-normal, var(--fd-divider));
      --fd-accent: var(--ha-color-fill-primary-loud-resting, var(--primary-color, #03a9f4));
      --fd-accent-hover: var(--ha-color-fill-primary-loud-hover, var(--fd-accent));
      --fd-accent-active: var(--ha-color-fill-primary-loud-active, var(--fd-accent));
      --fd-on-accent: var(--ha-color-on-primary-loud, var(--text-primary-color, #ffffff));
      --fd-accent-soft: var(--ha-color-fill-primary-normal-resting, var(--fd-surface-alt));
      --fd-on-accent-soft: var(--ha-color-on-primary-normal, var(--fd-text));
      --fd-neutral-soft: var(--ha-color-fill-neutral-normal-resting, var(--fd-surface-alt));
      --fd-error: var(--ha-color-on-danger-quiet, var(--error-color, #c62828));
      --fd-error-fill: var(--ha-color-fill-danger-quiet-resting, var(--fd-surface-alt));
      --fd-error-border: var(--ha-color-border-danger-normal, var(--fd-error));
      --fd-error-strong: var(--ha-color-fill-danger-loud-resting, var(--fd-error));
      --fd-on-error-strong: var(--ha-color-on-danger-loud, #ffffff);
      --fd-warning: var(--ha-color-on-warning-quiet, var(--warning-color, #ff9800));
      --fd-warning-fill: var(--ha-color-fill-warning-quiet-resting, var(--fd-surface-alt));
      --fd-warning-border: var(--ha-color-border-warning-normal, var(--fd-warning));
      --fd-success: var(--ha-color-on-success-quiet, var(--success-color, #2e7d32));
      --fd-success-fill: var(--ha-color-fill-success-quiet-resting, var(--fd-surface-alt));
      --fd-success-border: var(--ha-color-border-success-normal, var(--fd-success));
      --fd-shadow: var(--ha-card-box-shadow, none);
      --fd-shadow-dialog: 0 12px 40px rgba(0, 0, 0, 0.35);

      --fd-font-small: var(--ha-font-size-s, 12px);
      --fd-focus: var(--ha-color-focus, var(--primary-color, #03a9f4));
      --fd-focus-ring: 2px solid var(--fd-focus);
      --fd-line-height: 1.6;
      --fd-line-height-heading: 1.2;
      --fd-duration-fast: var(--ha-animation-duration-fast, 150ms);
      --fd-duration-normal: var(--ha-animation-duration-normal, 250ms);
      --fd-control-height: 48px;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    h1,
    h2,
    h3 {
      line-height: var(--fd-line-height-heading, 1.2);
    }

    :where(button, input, select, textarea, [tabindex]):focus-visible {
      outline: var(--fd-focus-ring);
      outline-offset: 2px;
    }

    /* Layout ------------------------------------------------------------- */

    .fd-app {
      display: flex;
      flex-direction: column;
      min-height: 100%;
    }

    .fd-shell {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--fd-space-4);
      width: 100%;
      max-width: 1440px;
      margin: 0 auto;
      padding: var(--fd-space-4);
    }

    .fd-panel-footer {
      margin-top: auto;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      text-align: end;
    }

    /* App-Leiste: volle Panel-Breite, HA-Metriken ------------------------- */

    .fd-app-bar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      flex: none;
      flex-wrap: nowrap;
      align-items: center;
      gap: 0;
      height: var(--header-height, 56px);
      padding: 0 var(--ha-space-3, 12px);
      background: var(--app-header-background-color, var(--primary-background-color));
      color: var(--app-header-text-color, var(--primary-text-color));
      border-bottom: var(--app-header-border-bottom, 1px solid var(--divider-color));
    }

    .fd-bar-title {
      flex: 1 1 auto;
      min-width: 0;
      margin: 0;
      padding-inline-start: var(--ha-space-6, 24px);
      overflow: hidden;
      font-size: var(--ha-font-size-xl, 1.5rem);
      font-weight: 400;
      line-height: var(--header-height, 56px);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .fd-bar-actions {
      display: flex;
      flex: none;
      align-items: center;
      min-width: 0;
      margin-inline-start: auto;
    }

    .fd-bar-divider {
      flex: none;
      width: 1px;
      height: 24px;
      margin: 0 var(--fd-space-1);
      background: var(--fd-divider);
    }

    .fd-bar-icon {
      position: relative;
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: var(--ha-icon-button-size, 48px);
      height: var(--ha-icon-button-size, 48px);
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    /* Rein visuelles Kürzel (dev/prd) in der unteren rechten Ecke des Buttons.
       Bewusst innerhalb der 48 px: kein Überhängen, damit weder das Klickziel
       verkleinert noch der Fokusring oder das horizontale Scrollen beschnitten wird. */
    .fd-bar-badge {
      position: absolute;
      inset-block-end: 0;
      inset-inline-end: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 14px;
      height: 12px;
      padding: 0 2px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-surface);
      color: var(--fd-text);
      font-size: var(--ha-font-size-xs, 10px);
      font-weight: var(--ha-font-weight-medium, 500);
      line-height: 1;
      letter-spacing: 0.02em;
      pointer-events: none;
      user-select: none;
    }

    .fd-bar-icon:hover:not(:disabled):not([aria-disabled="true"]) {
      background: var(--ha-color-fill-neutral-quiet-hover, var(--secondary-background-color, rgba(127, 127, 127, 0.16)));
    }

    .fd-bar-icon:disabled {
      opacity: 0.38;
      cursor: default;
    }

    /* Fähigkeit vorhanden, aber derzeit nicht verfügbar: sichtbar ausgegraut,
       Begründung über aria-describedby. Der Button bleibt fokussierbar. */
    .fd-bar-icon[aria-disabled="true"] {
      opacity: 0.38;
      cursor: not-allowed;
    }

    .fd-bar-icon svg {
      display: block;
      width: 24px;
      height: 24px;
    }

    .fd-bar-icon svg path,
    .fd-bar-icon svg circle {
      fill: currentColor;
      stroke: none;
    }

    .fd-menu-anchor {
      position: relative;
      flex: none;
    }

    .fd-menu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 30;
      display: flex;
      flex-direction: column;
      min-width: 200px;
      padding: 6px 0;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface);
      box-shadow: var(--fd-shadow-dialog);
    }

    .fd-menu-item {
      display: flex;
      align-items: center;
      min-height: 44px;
      padding: 8px 16px;
      border: none;
      background: none;
      color: var(--fd-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background-color var(--fd-duration-fast);
    }

    .fd-menu-item:hover,
    .fd-menu-item:focus-visible {
      background: var(--fd-surface-alt);
    }

    .fd-menu-item svg {
      flex: none;
      width: 20px;
      height: 20px;
      margin-inline-end: var(--fd-space-3);
      fill: currentColor;
    }

    /* Karten ------------------------------------------------------------- */

    .fd-card {
      background: var(--fd-surface);
      border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--fd-divider));
      border-radius: var(--fd-radius-lg);
      box-shadow: var(--fd-shadow);
    }

    .fd-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--fd-space-2);
      padding: var(--fd-space-8) var(--fd-space-4);
      text-align: center;
    }

    .fd-state h1,
    .fd-state h2,
    .fd-state h3 {
      margin: 0;
      font-weight: 500;
    }

    .fd-state--inline {
      border: 1px dashed var(--fd-divider);
      border-radius: var(--fd-radius-lg);
    }

    .fd-spinner {
      flex: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 3px solid var(--fd-divider);
      border-top-color: var(--fd-accent);
      animation: fd-spin 0.9s linear infinite;
    }

    @keyframes fd-spin {
      to {
        transform: rotate(360deg);
      }
    }

    /* Formularelemente ---------------------------------------------------- */

    .fd-label {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      font-weight: 500;
    }

    .fd-required {
      color: var(--fd-error);
    }

    .fd-hint {
      margin: 0;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    .fd-small {
      font-size: var(--fd-font-small);
    }

    .fd-muted {
      margin: 0;
      color: var(--fd-text-muted);
    }

    .fd-error-text {
      margin: 0;
      color: var(--fd-error);
      font-size: var(--fd-font-small);
      font-weight: 500;
    }

    .fd-sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    .fd-input {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      border: 1px solid var(--fd-border-strong);
      border-radius: var(--fd-radius-sm);
      background: var(--fd-surface);
      color: var(--fd-text);
      font: inherit;
      transition: border-color var(--fd-duration-fast);
    }

    .fd-input:focus-visible {
      border-color: var(--fd-accent);
    }

    .fd-input:disabled {
      background: var(--fd-surface-alt);
      color: var(--fd-text-muted);
      cursor: not-allowed;
    }

    .fd-textarea {
      min-height: 96px;
      resize: vertical;
    }

    .fd-file {
      padding: 8px;
    }

    .fd-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }

    .fd-field--full {
      grid-column: 1 / -1;
    }

    .fd-form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--fd-space-4);
    }

    .fd-fieldset {
      min-width: 0;
      margin: 0;
      padding: var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
    }

    .fd-fieldset legend {
      padding: 0 6px;
    }

    .fd-fieldset--inline {
      padding: 0;
      border: none;
    }

    .fd-switch-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-2) var(--fd-space-4);
    }

    .fd-switch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 48px;
      cursor: pointer;
    }

    .fd-switch input {
      width: 20px;
      height: 20px;
      accent-color: var(--fd-accent);
      cursor: pointer;
    }

    .fd-switch input:disabled {
      cursor: not-allowed;
    }

    .fd-switch:has(input:disabled) {
      color: var(--fd-text-muted);
      cursor: not-allowed;
    }

    /* Buttons ------------------------------------------------------------- */

    .fd-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--fd-space-2);
      min-height: 48px;
      padding: 8px 16px;
      border: 1px solid var(--fd-border-strong);
      border-radius: var(--fd-radius-pill);
      background: transparent;
      color: var(--fd-text);
      font: inherit;
      font-size: var(--ha-font-size-m, 14px);
      cursor: pointer;
      transition:
        background-color var(--fd-duration-fast),
        border-color var(--fd-duration-fast),
        color var(--fd-duration-fast);
    }

    .fd-button:hover:not(:disabled) {
      background: var(--ha-color-fill-neutral-quiet-hover, var(--fd-surface-alt));
    }

    .fd-button:active:not(:disabled) {
      background: var(--ha-color-fill-neutral-quiet-active, var(--fd-surface-alt));
    }

    .fd-button:disabled {
      cursor: default;
      opacity: 0.5;
    }

    .fd-button[aria-busy="true"] {
      position: relative;
      color: transparent;
    }

    .fd-button[aria-busy="true"]::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 18px;
      height: 18px;
      margin: -9px 0 0 -9px;
      border: 2px solid var(--fd-text);
      border-top-color: transparent;
      border-radius: 50%;
      animation: fd-spin 0.9s linear infinite;
    }

    .fd-button--primary {
      border-color: transparent;
      background: var(--fd-accent);
      color: var(--fd-on-accent);
    }

    .fd-button--primary:hover:not(:disabled) {
      background: var(--fd-accent-hover);
    }

    .fd-button--primary:active:not(:disabled) {
      background: var(--fd-accent-active);
    }

    .fd-button--filled {
      border-color: transparent;
      background: var(--fd-neutral-soft);
      color: var(--fd-text);
    }

    .fd-button--plain {
      border-color: transparent;
      background: transparent;
      color: var(--fd-text-muted);
    }

    .fd-button--plain:hover:not(:disabled) {
      background: var(--fd-surface-alt);
      color: var(--fd-text);
    }

    .fd-button--danger {
      border-color: var(--fd-error-border);
      background: transparent;
      color: var(--fd-error);
    }

    .fd-button--danger:hover:not(:disabled) {
      background: var(--fd-error-fill);
    }

    .fd-button--danger-filled {
      border-color: transparent;
      background: var(--fd-error-strong);
      color: var(--fd-on-error-strong);
    }

    .fd-button--primary[aria-busy="true"]::after,
    .fd-button--danger-filled[aria-busy="true"]::after {
      border-color: var(--fd-on-accent);
      border-top-color: transparent;
    }

    .fd-button--danger[aria-busy="true"]::after {
      border-color: var(--fd-error);
      border-top-color: transparent;
    }

    .fd-button--success {
      border-color: var(--fd-success-border);
      background: transparent;
      color: var(--fd-success);
    }

    .fd-button--success:hover:not(:disabled) {
      background: var(--fd-success-fill);
    }

    .fd-button--small {
      min-height: 48px;
      padding: 4px 12px;
      font-size: var(--fd-font-small);
    }

    .fd-button--xs {
      min-height: 24px;
      padding: 2px 8px;
      font-size: var(--fd-font-small);
    }

    .fd-button--large {
      min-height: 48px;
      padding: 8px 16px;
      font-size: var(--ha-font-size-l, 16px);
    }

    .fd-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      width: 44px;
      height: 44px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: var(--fd-text-muted);
      font: inherit;
      cursor: pointer;
      transition:
        background-color var(--fd-duration-fast),
        color var(--fd-duration-fast);
    }

    .fd-icon-button:hover:not(:disabled) {
      background: var(--fd-surface-alt);
      color: var(--fd-text);
    }

    .fd-icon-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .fd-icon-button--small {
      width: 24px;
      height: 24px;
      font-size: 11px;
    }

    /* Chips und Tags ------------------------------------------------------ */

    .fd-chip-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-2);
      list-style: none;
      margin: var(--fd-space-2) 0 0;
      padding: 0;
    }

    .fd-chip-row--scroll {
      max-height: 124px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .fd-chip-row--selected {
      align-items: center;
      min-height: 34px;
    }

    .fd-chip {
      appearance: none;
      min-height: 48px;
      padding: 6px 12px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-surface);
      color: var(--fd-text);
      font: inherit;
      font-size: var(--fd-font-small);
      cursor: pointer;
      transition:
        background-color var(--fd-duration-fast),
        border-color var(--fd-duration-fast),
        color var(--fd-duration-fast);
    }

    .fd-chip:hover {
      background: var(--fd-surface-alt);
    }

    .fd-chip[aria-pressed="true"] {
      border-color: var(--fd-accent);
      background: var(--fd-accent);
      color: var(--fd-on-accent);
    }

    .fd-chip[aria-pressed="true"]::before {
      content: "✓";
      margin-inline-end: 4px;
    }

    .fd-selected-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 4px 4px 12px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-surface-alt);
      font-size: var(--fd-font-small);
    }

    .fd-tag-input-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-2);
      align-items: center;
      margin-top: var(--fd-space-2);
    }

    .fd-tag-input-row .fd-input {
      flex: 1 1 200px;
      width: auto;
    }

    .fd-tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .fd-tag {
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--fd-surface-alt);
      color: var(--fd-text-muted);
      font-size: 11px;
    }

    /* Banner und Status --------------------------------------------------- */

    .fd-banner {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--fd-space-2);
      padding: var(--fd-space-3) var(--fd-space-3) var(--fd-space-3) var(--fd-space-8);
      border: 1px solid var(--fd-divider);
      border-left: 4px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-banner::before {
      content: "";
      position: absolute;
      inset-inline-start: var(--fd-space-3);
      top: var(--fd-space-3);
      width: 18px;
      height: 18px;
      background-color: var(--fd-text);
      mask: var(--fd-banner-icon) center / contain no-repeat;
      -webkit-mask: var(--fd-banner-icon) center / contain no-repeat;
    }

    .fd-banner p {
      margin: 0;
    }

    .fd-banner--error {
      border-color: var(--fd-error-border);
      background: var(--fd-error-fill);
      --fd-banner-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z'/%3E%3C/svg%3E");
    }

    .fd-banner--error::before {
      background-color: var(--fd-error);
    }

    .fd-banner--warning {
      border-color: var(--fd-warning-border);
      background: var(--fd-warning-fill);
      --fd-banner-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'/%3E%3C/svg%3E");
    }

    .fd-banner--warning::before {
      background-color: var(--fd-warning);
    }

    .fd-banner--success {
      border-color: var(--fd-success-border);
      background: var(--fd-success-fill);
      --fd-banner-icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E");
    }

    .fd-banner--success::before {
      background-color: var(--fd-success);
    }

    .fd-inline-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-2);
    }

    .fd-status {
      padding: 4px 10px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-pill);
      font-size: var(--fd-font-small);
    }

    .fd-status--ok {
      border-color: var(--fd-success);
      color: var(--fd-text);
    }

    .fd-status--warn {
      border-color: var(--fd-warning);
      color: var(--fd-text);
    }

    /* Filter -------------------------------------------------------------- */

    .fd-filters {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-3);
      padding: var(--fd-space-4);
    }

    .fd-filter-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--fd-space-2) var(--fd-space-3);
    }

    .fd-filter-summary-title {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-2);
      min-width: 0;
    }

    .fd-filter-summary h2 {
      margin: 0;
      font-size: var(--ha-font-size-l, 16px);
      font-weight: 500;
    }

    .fd-filter-toggle {
      min-height: var(--fd-control-height);
      padding: 8px 14px;
    }

    .fd-filter-toggle svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
      transition: transform var(--fd-duration-fast);
    }

    .fd-filter-toggle .fd-filter-chevron--open {
      transform: rotate(180deg);
    }

    .fd-filter-panel {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-3);
    }

    .fd-filter-panel[hidden] {
      display: none;
    }

    .fd-filter-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-3);
    }

    .fd-field--search {
      flex: 1 1 280px;
    }

    .fd-filter-head .fd-input,
    .fd-filter-head .fd-button {
      height: var(--fd-control-height);
      min-height: var(--fd-control-height);
    }

    .fd-filter-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-2);
    }

    .fd-filter-options {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--fd-space-3);
      align-items: start;
    }

    @media (min-width: 1200px) {
      .fd-filter-options {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    .fd-filter-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: var(--fd-space-3);
      align-items: start;
    }

    .fd-sort-row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-2);
    }

    .fd-sort-row .fd-input {
      flex: 1 1 120px;
      width: auto;
    }

    .fd-list-meta {
      margin: 0;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    /* Produktliste -------------------------------------------------------- */

    .fd-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: var(--fd-space-3);
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .fd-product {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .fd-product--archived {
      opacity: 0.72;
    }

    .fd-product-media {
      position: relative;
      aspect-ratio: 4 / 3;
      overflow: hidden;
      background: var(--fd-surface-alt);
    }

    .fd-product-media img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .fd-product-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--fd-text-muted);
      font-size: 2.5rem;
    }

    .fd-product-body {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--fd-space-2);
      padding: var(--fd-space-3);
    }

    .fd-product-title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--fd-space-2);
    }

    .fd-product-title {
      margin: 0;
      font-size: var(--ha-font-size-l, 16px);
      font-weight: 500;
      line-height: var(--fd-line-height-heading, 1.2);
    }

    .fd-price {
      color: var(--fd-text);
      font-weight: 600;
      white-space: nowrap;
    }

    .fd-product-description {
      display: -webkit-box;
      margin: 0;
      overflow: hidden;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }

    .fd-badges {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }

    .fd-badge {
      padding: 2px 8px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-surface-alt);
      color: var(--fd-text-muted);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .fd-badge--warning {
      border-color: var(--fd-warning);
      color: var(--fd-text);
    }

    .fd-badge--muted {
      border-color: var(--fd-divider);
      color: var(--fd-text-muted);
    }

    .fd-badge--active {
      border-color: var(--fd-accent);
      background: var(--fd-accent-soft);
      color: var(--fd-on-accent-soft);
    }

    .fd-badge--main {
      position: absolute;
      top: 6px;
      left: 6px;
      border-color: transparent;
      background: var(--fd-accent);
      color: var(--fd-on-accent);
    }

    .fd-stock-line {
      margin: 0;
      font-size: var(--fd-font-small);
    }

    .fd-card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-2);
      margin-top: auto;
    }

    .fd-pagination {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--fd-space-3);
      padding: var(--fd-space-2) 0;
    }

    .fd-pagination-actions {
      display: flex;
      align-items: center;
      gap: var(--fd-space-2);
    }

    /* Dialoge ------------------------------------------------------------- */

    .fd-dialog {
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 48px);
      padding: 0;
      border: none;
      border-radius: var(--fd-radius-dialog);
      background: var(--fd-surface);
      color: var(--fd-text);
      box-shadow: var(--fd-shadow-dialog);
    }

    .fd-dialog--wide {
      width: min(980px, calc(100vw - 32px));
    }

    .fd-dialog[open] {
      display: flex;
      flex-direction: column;
    }

    .fd-dialog::backdrop {
      background: rgba(0, 0, 0, 0.55);
    }

    .fd-dialog-head {
      display: flex;
      flex: none;
      align-items: flex-start;
      gap: var(--fd-space-3);
      padding: var(--fd-space-4) var(--fd-space-6) var(--fd-space-3);
      border-bottom: 1px solid var(--fd-divider);
    }

    .fd-dialog-title {
      flex: 1 1 auto;
      min-width: 0;
    }

    .fd-dialog-head h2 {
      margin: 0;
      font-size: var(--ha-font-size-xl, 1.5rem);
      font-weight: 500;
      line-height: var(--fd-line-height-heading, 1.2);
    }

    .fd-dialog-close {
      margin-inline-start: calc(-1 * var(--fd-space-2));
    }

    /* Artikelnummer im Dialogkopf: HA-Tokens, in Light und Dark lesbar ----- */

    .fd-article-badge {
      display: inline-flex;
      flex: none;
      align-items: center;
      align-self: flex-start;
      min-height: 28px;
      margin-block-start: 2px;
      padding: 2px var(--fd-space-3);
      border: 1px solid var(--fd-accent);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-accent-soft);
      color: var(--fd-on-accent-soft);
      font-family: var(--ha-font-family-code, monospace);
      font-size: var(--fd-font-small);
      font-weight: 500;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .fd-dialog-form {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
    }

    .fd-dialog-body {
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: var(--fd-space-3);
      padding: 0 var(--fd-space-6) var(--fd-space-6);
      overflow-y: auto;
    }

    .fd-dialog-foot {
      display: flex;
      flex: none;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: var(--fd-space-3);
      padding: var(--fd-space-4);
      border-top: 1px solid var(--fd-divider);
    }

    .fd-dialog-foot-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-3);
      margin-inline-start: auto;
    }

    .fd-foot-hint {
      flex: 1 1 260px;
      margin: 0;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      text-align: start;
    }

    .fd-dialog--shake {
      animation: fd-shake var(--fd-duration-normal) ease-in-out;
    }

    @keyframes fd-shake {
      0%,
      100% {
        transform: translateX(0);
      }

      20% {
        transform: translateX(-6px);
      }

      40% {
        transform: translateX(6px);
      }

      60% {
        transform: translateX(-4px);
      }

      80% {
        transform: translateX(4px);
      }
    }

    /* Katalogimport -------------------------------------------------------- */

    .fd-import-intro {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
    }

    .fd-import-intro p {
      margin: 0;
    }

    .fd-import-notes {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding-left: 1.2em;
    }

    .fd-import-result {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-3);
    }

    .fd-import-preview {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-3);
    }

    .fd-import-preview h3,
    .fd-import-result h3 {
      margin: 0;
      font-size: 1rem;
      font-weight: 500;
    }

    .fd-banner .fd-button {
      margin-top: var(--fd-space-2);
    }

    .fd-import-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: var(--fd-space-2);
      margin: 0;
    }

    .fd-import-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--fd-space-2) var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-import-stat dt {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    .fd-import-stat dd {
      margin: 0;
      font-size: 1.15rem;
      font-variant-numeric: tabular-nums;
    }

    .fd-import-stat--error {
      color: var(--fd-error);
    }

    .fd-import-errors {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
    }

    .fd-import-errors h4 {
      margin: 0;
      font-size: var(--fd-font-small);
      font-weight: 500;
    }

    .fd-import-errors ul {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 240px;
      margin: 0;
      padding: var(--fd-space-2);
      overflow-y: auto;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
      list-style: none;
    }

    .fd-import-errors li {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--fd-divider);
    }

    .fd-import-errors li:last-child {
      padding-bottom: 0;
      border-bottom: none;
    }

    /* Bilder -------------------------------------------------------------- */

    .fd-upload {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    /* Aufnahmekontrolle nur auf Geräten mit primärem Touch-Pointer (Companion-App). */
    .fd-capture {
      display: none;
    }

    @media (pointer: coarse) {
      .fd-capture {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
    }

    .fd-image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: var(--fd-space-3);
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .fd-image-card {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: var(--fd-space-2);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
    }

    .fd-image-preview {
      position: relative;
      aspect-ratio: 4 / 3;
      overflow: hidden;
      border-radius: var(--fd-radius-sm);
      background: var(--fd-surface-alt);
    }

    .fd-image-preview img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .fd-image-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
    }

    .fd-image-error {
      color: var(--fd-text-muted);
      font-size: 11px;
      text-align: center;
      padding: 0 8px;
    }

    .fd-image-name {
      margin: 0;
      overflow: hidden;
      color: var(--fd-text-muted);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .fd-image-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    /* Sechs Aktionen je Karte: kurze Labels, Umbruch in drei Reihen, Ziele ab 48 px. */
    .fd-image-actions .fd-button {
      flex: 1 1 auto;
      min-width: 48px;
      min-height: 48px;
      white-space: nowrap;
    }

    .fd-image-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--fd-space-2);
    }

    .fd-image-toolbar p {
      margin: 0;
    }

    .fd-image-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin: 0;
      color: var(--fd-text-muted);
      font-size: 11px;
    }

    .fd-image-flag {
      display: inline-flex;
      flex: none;
      align-items: center;
      color: var(--fd-warning);
    }

    .fd-image-flag svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .fd-result-body {
      display: flex;
      flex: 1 1 240px;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .fd-result-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0;
      padding-inline-start: var(--fd-space-4);
      font-size: var(--fd-font-small);
    }

    .fd-result-name {
      margin-inline-end: 6px;
      color: var(--fd-text-muted);
      font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, monospace);
      font-size: 11px;
      overflow-wrap: anywhere;
    }

    .fd-result-error {
      color: var(--fd-error);
    }

    .fd-optimize-result {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      padding: var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-optimize-summary {
      margin: 0;
      font-weight: 500;
    }

    .fd-image-warning {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-width: 44px;
      min-height: 44px;
      padding: 2px 8px;
      border: 1px solid var(--fd-warning-border);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-warning-fill);
      color: var(--fd-text);
      font: inherit;
      cursor: pointer;
      transition:
        background-color var(--fd-duration-fast),
        border-color var(--fd-duration-fast);
    }

    .fd-image-warning svg {
      flex: none;
      width: 18px;
      height: 18px;
      fill: var(--fd-warning);
    }

    .fd-image-warning:hover {
      border-color: var(--fd-warning);
      background: var(--fd-surface-alt);
    }

    .fd-image-warning-text {
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    /* In der Listenzeile genau so hoch wie ein .fd-badge daneben. */
    .fd-image-warning--row {
      align-self: center;
      min-width: 0;
      min-height: 0;
      padding: 2px 8px;
      font-size: 11px;
      line-height: var(--fd-line-height, 1.6);
    }

    .fd-image-warning--row svg {
      width: 14px;
      height: 14px;
    }

    .fd-image-warning--card {
      position: absolute;
      top: 4px;
      right: 4px;
      min-width: 44px;
      padding: 0;
      border-color: var(--fd-warning-border);
      background: var(--fd-surface);
      box-shadow: var(--fd-shadow);
    }

    .fd-image-warning--card svg {
      width: 22px;
      height: 22px;
    }

    /* Bestand ------------------------------------------------------------- */

    .fd-stock-summary {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-6);
      margin: 0;
      padding: var(--fd-space-3);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-stock-summary dt {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    .fd-stock-summary dd {
      margin: 0;
      font-size: 1.4rem;
      font-weight: 600;
    }

    /* Tag-Verwaltung ------------------------------------------------------ */

    .fd-tag-manage-list {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .fd-tag-manage {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--fd-space-3);
      padding: 8px 10px;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius-sm);
    }

    /* Vorschlag (KI) ------------------------------------------------------ */

    .fd-suggestion {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      margin-top: var(--fd-space-2);
      padding: var(--fd-space-3);
      border: 1px solid var(--fd-accent);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    /* Toast --------------------------------------------------------------- */

    .fd-toast-slot {
      position: fixed;
      inset-inline: 0;
      bottom: var(--fd-space-6);
      display: flex;
      justify-content: center;
      pointer-events: none;
      z-index: 20;
    }

    .fd-toast {
      max-width: min(560px, calc(100vw - 32px));
      padding: 10px 18px;
      border-radius: var(--fd-radius-pill);
      background: var(--fd-accent);
      color: var(--fd-on-accent);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      font-size: var(--fd-font-small);
    }

    /* Ansichtsumschalter -------------------------------------------------- */

    .fd-view-toggle {
      display: inline-flex;
      gap: 2px;
      height: var(--fd-control-height);
      padding: 1px;
      border: 1px solid var(--fd-border-strong);
      border-radius: var(--fd-radius-pill);
      background: var(--fd-surface);
    }

    .fd-view-option {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 100%;
      min-height: 0;
      padding: 0 16px;
      border: none;
      border-radius: var(--fd-radius-pill);
      background: transparent;
      color: var(--fd-text);
      font: inherit;
      cursor: pointer;
    }

    .fd-view-option svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    .fd-view-option:hover {
      background: var(--fd-surface-alt);
    }

    .fd-view-option[aria-pressed="true"] {
      background: var(--fd-accent-soft);
      color: var(--fd-on-accent-soft);
      font-weight: 500;
      box-shadow: inset 0 0 0 2px var(--fd-accent);
    }

    /* Veröffentlichung ---------------------------------------------------- */

    .fd-publish-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--fd-space-2);
      margin: var(--fd-space-4) 0 0;
    }

    .fd-publish-meta div {
      padding: var(--fd-space-2) var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-publish-meta dt {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    .fd-publish-meta dd {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .fd-publish-section {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-1);
    }

    .fd-publish-section h3 {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--fd-space-2);
      margin: 0;
      font-size: var(--ha-font-size-m, 14px);
      font-weight: 500;
    }

    .fd-publish-total {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      font-variant-numeric: tabular-nums;
    }

    .fd-publish-confirm {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      padding: var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-publish-confirm h3 {
      margin: 0;
      font-size: var(--ha-font-size-m, 14px);
      font-weight: 500;
    }

    .fd-publish-counts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
      gap: var(--fd-space-1);
      margin: 0;
    }

    .fd-publish-count {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding: var(--fd-space-1) var(--fd-space-2);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-publish-count dt {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
    }

    .fd-publish-count dd {
      margin: 0;
      font-size: 1rem;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }

    .fd-publish-filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fd-space-1);
    }

    .fd-publish-filter {
      min-height: 32px;
      padding: 2px 10px;
    }

    .fd-publish-filter-count {
      margin-inline-start: 6px;
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
    }

    .fd-status-icon {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      font-weight: 700;
      line-height: 1;
    }

    .fd-publish-filelist {
      display: flex;
      flex-direction: column;
      max-height: 280px;
      margin: 0;
      padding: var(--fd-space-2);
      overflow-y: auto;
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
      list-style: none;
    }

    .fd-publish-file {
      display: grid;
      grid-template-columns: 20px minmax(90px, auto) minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--fd-space-2);
      min-height: 40px;
      padding: 4px 0;
      border-bottom: 1px solid var(--fd-divider);
    }

    .fd-publish-file:last-child {
      border-bottom: none;
    }

    .fd-publish-file-status {
      font-size: var(--fd-font-small);
      font-weight: 500;
    }

    .fd-publish-file-path {
      overflow-wrap: anywhere;
      font-family: var(--ha-font-family-code, monospace);
      font-size: var(--fd-font-small);
    }

    /* Listenansicht ------------------------------------------------------- */

    .fd-product-list-wrap {
      overflow-x: auto;
      border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--fd-divider));
      border-radius: var(--fd-radius-lg);
      background: var(--fd-surface);
    }

    .fd-product-table {
      width: 100%;
      min-width: 960px;
      border-collapse: collapse;
    }

    .fd-product-table th,
    .fd-product-table td {
      padding: 4px var(--fd-space-3);
      border-bottom: 1px solid var(--fd-divider);
      text-align: start;
      vertical-align: middle;
    }

    .fd-product-table thead th {
      color: var(--fd-text-muted);
      font-size: var(--fd-font-small);
      font-weight: 500;
      white-space: nowrap;
    }

    .fd-size-cell {
      color: var(--fd-text-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .fd-sort-header {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-height: 44px;
      margin-block: -4px;
      padding: 0 var(--fd-space-1);
      border: none;
      border-radius: var(--fd-radius-sm);
      background: transparent;
      color: inherit;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      cursor: pointer;
      transition: color var(--fd-duration-fast) ease;
    }

    .fd-sort-header:hover {
      color: var(--fd-text);
    }

    .fd-sort-header[aria-label] {
      white-space: nowrap;
    }

    .fd-sort-arrow {
      display: inline-block;
      min-width: 1em;
      color: var(--fd-text-muted);
      font-size: 1em;
      line-height: 1;
      text-align: center;
    }

    .fd-sort-header:hover .fd-sort-arrow,
    .fd-product-table thead th[aria-sort="ascending"] .fd-sort-arrow,
    .fd-product-table thead th[aria-sort="descending"] .fd-sort-arrow {
      color: var(--fd-accent);
    }

    .fd-product-table tbody tr:last-child td {
      border-bottom: none;
    }

    .fd-product-table tbody tr:hover {
      background: var(--fd-surface-alt);
    }

    .fd-product-row-main {
      display: flex;
      align-items: center;
      gap: var(--fd-space-2);
      min-width: 200px;
    }

    .fd-product-thumb {
      display: flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      overflow: hidden;
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
      color: var(--fd-text-muted);
      font-size: 1.1rem;
    }

    .fd-product-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .fd-product-row-text {
      display: flex;
      flex-direction: column;
      gap: 0;
      min-width: 0;
    }

    .fd-product-row-text .fd-tag-list {
      margin-top: 2px;
    }

    .fd-product-row-text .fd-tag {
      padding: 0 6px;
      font-size: 10px;
    }

    .fd-stock-chips {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .fd-stock-chip {
      display: flex;
      gap: 4px;
      font-size: var(--fd-font-small);
      line-height: 1.4;
    }

    .fd-row-actions {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      justify-content: flex-end;
      gap: 4px;
    }

    .fd-row-action {
      flex: none;
      width: 44px;
      min-width: 44px;
      height: 44px;
      min-height: 44px;
      padding: 0;
      border-radius: 50%;
    }

    .fd-row-action svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    /* Tabs im Produktdialog ----------------------------------------------- */

    .fd-editor-tabs {
      display: flex;
      flex: none;
      gap: 4px;
      padding: 0 var(--fd-space-6);
      border-bottom: 1px solid var(--fd-divider);
      overflow-x: auto;
    }

    .fd-editor-tabs .fd-tab {
      min-height: 48px;
      padding: 8px 16px;
      border: none;
      border-bottom: 3px solid transparent;
      border-radius: 0;
      background: transparent;
      color: var(--fd-text-muted);
      font: inherit;
      cursor: pointer;
    }

    .fd-editor-tabs .fd-tab:hover {
      color: var(--fd-text);
      background: var(--fd-surface-alt);
    }

    .fd-editor-tabs .fd-tab[aria-selected="true"] {
      border-bottom-color: var(--fd-accent);
      color: var(--fd-text);
      font-weight: 500;
    }

    .fd-dialog-body [hidden] {
      display: none !important;
    }

    /* Bestand im Produktdialog -------------------------------------------- */

    .fd-stock-editors {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--fd-space-3);
    }

    .fd-stock-editor {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      padding: var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
    }

    .fd-stock-editor > * {
      width: 100%;
    }

    .fd-stock-step {
      min-height: var(--fd-control-height);
      padding: 0;
    }

    .fd-stock-step svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    .fd-stock-input {
      max-width: none;
      font-variant-numeric: tabular-nums;
      text-align: center;
    }

    .fd-bookings {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      margin-top: var(--fd-space-4);
      padding-top: var(--fd-space-3);
      border-top: 1px solid var(--fd-divider);
    }

    .fd-bookings h3 {
      margin: 0;
      font-size: var(--ha-font-size-m, 14px);
      font-weight: 500;
    }

    .fd-booking-list {
      display: flex;
      flex-direction: column;
      gap: var(--fd-space-2);
      max-height: 240px;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }

    .fd-booking {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--fd-space-2) var(--fd-space-3);
      border: 1px solid var(--fd-divider);
      border-radius: var(--fd-radius);
      background: var(--fd-surface-alt);
    }

    .fd-booking-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fd-space-2);
    }

    .fd-chip--rejected {
      border-style: dashed;
      border-color: var(--fd-warning-border);
      color: var(--fd-text);
      text-decoration: line-through;
    }

    /* Responsive ---------------------------------------------------------- */

    @media (max-width: 900px) {
      .fd-shell {
        gap: var(--fd-space-3);
        padding: var(--fd-space-3);
      }

      .fd-grid {
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
    }

    @media (max-width: 640px) {
      .fd-shell {
        padding: var(--fd-space-2);
      }

      .fd-app-bar {
        padding: 0 var(--ha-space-1, 4px);
      }

      .fd-bar-actions {
        overflow-x: auto;
        scrollbar-width: none;
        /* Platz für den 2px-Fokusring samt 2px Offset, damit das Scrollen ihn nicht abschneidet. */
        padding-block: 5px;
        margin-block: -5px;
      }

      .fd-bar-actions::-webkit-scrollbar {
        display: none;
      }

      .fd-bar-title {
        padding-inline-start: var(--ha-space-2, 8px);
        font-size: var(--ha-font-size-l, 1.25rem);
      }

      .fd-grid {
        grid-template-columns: 1fr;
      }

      .fd-product-media {
        aspect-ratio: 16 / 9;
      }

      .fd-dialog,
      .fd-dialog--wide {
        width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
      }

      .fd-dialog-body {
        padding: var(--fd-space-3);
      }

      .fd-image-grid {
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      }

      .fd-view-toggle {
        width: 100%;
      }

      .fd-view-option {
        flex: 1;
        justify-content: center;
      }

      .fd-publish-file {
        grid-template-columns: 20px minmax(0, 1fr);
      }

      .fd-publish-file-status,
      .fd-publish-file-path {
        grid-column: 2;
      }

      .fd-product-list-wrap {
        overflow-x: visible;
        border: none;
        background: transparent;
      }

      .fd-product-table {
        min-width: 0;
      }

      .fd-product-table thead {
        display: none;
      }

      .fd-product-table,
      .fd-product-table tbody,
      .fd-product-table tr,
      .fd-product-table td {
        display: block;
        width: 100%;
      }

      .fd-product-table tr {
        margin-bottom: var(--fd-space-3);
        padding: var(--fd-space-2);
        border: 1px solid var(--fd-divider);
        border-radius: var(--fd-radius-lg);
        background: var(--fd-surface);
      }

      .fd-product-table td {
        display: grid;
        grid-template-columns: 130px minmax(0, 1fr);
        gap: var(--fd-space-2);
        padding: 6px 0;
        border-bottom: 1px solid var(--fd-divider);
      }

      .fd-product-table td:last-child {
        border-bottom: none;
      }

      .fd-product-table td::before {
        content: attr(data-label);
        color: var(--fd-text-muted);
        font-size: var(--fd-font-small);
      }

      .fd-editor-tabs {
        padding: 0 var(--fd-space-3);
      }
    }

    @media (max-width: 480px) {
      .fd-bar-title {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  `;
}

if (!customElements.get("frickeldave-store-panel")) {
  customElements.define("frickeldave-store-panel", FrickeldaveStorePanel);
}
