// Serveur MCP distant pour SugarCRM, déployé sur Cloudflare Workers.
// Transport : MCP « Streamable HTTP » en mode sans état (réponses JSON).
// Adresse du connecteur : https://<worker>/mcp/<MCP_SECRET>

const SERVER_NAME = "sugarcrm-aspasie";
const SERVER_VERSION = "0.1.0";
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const DEFAULTS = {
  SUGAR_URL: "https://aspasie.sugarondemand.com",
  SUGAR_PLATFORM: "mobile",
  SUGAR_API_VERSION: "v11",
  SUGAR_CLIENT_ID: "sugar",
  SUGAR_LANGUAGE: "fr_FR",
};

// Modules du système : jamais d'écriture, peu importe les droits du compte.
const WRITE_BLOCKED_MODULES = new Set(
  [
    "Users", "Employees", "Teams", "TeamNotices", "ACLRoles", "ACLActions",
    "OAuthKeys", "OAuthTokens", "Schedulers", "WorkFlow", "WebLogicHooks",
    "InboundEmail", "OutboundEmail", "EAPM", "Administration",
    "ConsoleConfiguration", "DataArchiver", "ArchiveRuns",
    "PubSub_ModuleEvent_PushSubs", "CJ_WebHooks", "CJ_Forms", "Styleguide",
    "MobileDevices", "PushNotifications", "Filters", "SavedSearch",
    "Dashboards", "Currencies", "TaxRates", "TimePeriods", "Holidays",
    "UserSignatures", "DataPrivacy", "CustomQueries", "Metrics",
  ].map((m) => m.toLowerCase())
);
const WRITE_BLOCKED_PREFIXES = ["pmse_", "dri_workflow_template", "dri_subworkflow_template"];
// Champs interdits en écriture (« deleted » permettrait une suppression déguisée).
const WRITE_BLOCKED_FIELDS = new Set(["id", "deleted", "date_entered", "created_by"]);

const NAME_RE = /^[A-Za-z0-9_]{1,100}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_OUTPUT_CHARS = 120000;

// ---------------------------------------------------------------------------
// Configuration

function cfg(env, key) {
  const v = env[key];
  return v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : DEFAULTS[key];
}

function writesEnabled(env) {
  return String(env.WRITE_ENABLED || "").toLowerCase() === "true";
}

function apiBase(env) {
  return `${cfg(env, "SUGAR_URL").replace(/\/+$/, "")}/rest/${cfg(env, "SUGAR_API_VERSION")}`;
}

// ---------------------------------------------------------------------------
// Client SugarCRM (jeton conservé en mémoire dans l'isolat du Worker)

let tokenCache = null; // { access, refresh, expiresAt }
let langCache = null; // { lang, data, at }

class SugarError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function sugarErrorMessage(status, data) {
  if (data && typeof data === "object") {
    const msg = data.error_message || data.error_description || data.message;
    const code = data.error;
    if (msg || code) return `Sugar ${status} ${code || ""}: ${msg || ""}`.trim();
    if (data.raw) return `Sugar ${status}: ${data.raw}`;
  }
  return `Sugar a répondu ${status}`;
}

async function requestToken(env, body) {
  const res = await fetch(`${apiBase(env)}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg(env, "SUGAR_CLIENT_ID"),
      client_secret: env.SUGAR_CLIENT_SECRET || "",
      platform: cfg(env, "SUGAR_PLATFORM"),
      ...body,
    }),
  });
  const data = await readJson(res);
  if (!res.ok || !data || !data.access_token) {
    throw new SugarError(`Connexion à Sugar refusée. ${sugarErrorMessage(res.status, data)}`, res.status);
  }
  tokenCache = {
    access: data.access_token,
    refresh: data.refresh_token || null,
    expiresAt: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000,
  };
  return tokenCache.access;
}

async function getToken(env, force = false) {
  if (!force && tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.access;
  if (!force && tokenCache && tokenCache.refresh) {
    try {
      return await requestToken(env, { grant_type: "refresh_token", refresh_token: tokenCache.refresh });
    } catch {
      // jeton de rafraîchissement expiré : on refait une connexion complète
    }
  }
  if (!env.SUGAR_USERNAME || !env.SUGAR_PASSWORD) {
    throw new SugarError("SUGAR_USERNAME ou SUGAR_PASSWORD n'est pas configuré dans Cloudflare.", 500);
  }
  return requestToken(env, {
    grant_type: "password",
    username: env.SUGAR_USERNAME,
    password: env.SUGAR_PASSWORD,
  });
}

async function sugar(env, method, path, { query, body } = {}) {
  const url = new URL(apiBase(env) + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const doFetch = async (token) =>
    fetch(url.toString(), {
      method,
      headers: {
        "OAuth-Token": token,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch(await getToken(env));
  if (res.status === 401) {
    // Jeton expiré ou session remplacée par une autre connexion : on réessaie une fois.
    tokenCache = null;
    res = await doFetch(await getToken(env, true));
  }
  const data = await readJson(res);
  if (!res.ok) throw new SugarError(sugarErrorMessage(res.status, data), res.status);
  return data;
}

async function getLang(env, lang) {
  if (langCache && langCache.lang === lang && Date.now() - langCache.at < 30 * 60 * 1000) {
    return langCache.data;
  }
  let data;
  try {
    data = await sugar(env, "GET", `/lang/${encodeURIComponent(lang)}`);
  } catch (e) {
    if (lang === "en_us") throw e;
    data = await sugar(env, "GET", "/lang/en_us"); // langue absente de l'instance : repli sur l'anglais
  }
  langCache = { lang, data, at: Date.now() };
  return data;
}

// ---------------------------------------------------------------------------
// Validation

function need(args, key) {
  const v = args[key];
  if (v === undefined || v === null || v === "") throw new SugarError(`Paramètre manquant : ${key}`, 400);
  return v;
}

function checkName(v, label) {
  if (typeof v !== "string" || !NAME_RE.test(v)) throw new SugarError(`${label} invalide : ${v}`, 400);
  return v;
}

function checkId(v, label = "id") {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new SugarError(`${label} invalide : ${v}`, 400);
  return v;
}

function fieldsParam(fields) {
  if (!fields) return undefined;
  if (Array.isArray(fields)) return fields.filter((f) => NAME_RE.test(f)).join(",");
  return String(fields)
    .split(",")
    .map((f) => f.trim())
    .filter((f) => NAME_RE.test(f))
    .join(",");
}

function clampNum(v, def, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function assertWritable(env, module) {
  if (!writesEnabled(env)) {
    throw new SugarError("Les écritures sont désactivées (WRITE_ENABLED n'est pas à true).", 403);
  }
  const m = module.toLowerCase();
  if (WRITE_BLOCKED_MODULES.has(m) || WRITE_BLOCKED_PREFIXES.some((p) => m.startsWith(p))) {
    throw new SugarError(`Écriture refusée : ${module} est un module du système, protégé par le connecteur.`, 403);
  }
}

function cleanWriteFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new SugarError("fields doit être un objet { nom_du_champ: valeur }.", 400);
  }
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!NAME_RE.test(k)) throw new SugarError(`Nom de champ invalide : ${k}`, 400);
    if (WRITE_BLOCKED_FIELDS.has(k.toLowerCase())) {
      throw new SugarError(`Le champ ${k} ne peut pas être modifié par le connecteur.`, 403);
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) throw new SugarError("Aucun champ à écrire.", 400);
  return out;
}

function pick(record, keys) {
  const out = {};
  if (!record) return out;
  for (const k of keys) out[k] = record[k];
  return out;
}

// ---------------------------------------------------------------------------
// Outils

const FILTER_HELP =
  "Filtre Sugar (tableau JSON). Exemples : " +
  '[{"name":{"$starts":"Acme"}}] ; ' +
  '[{"sales_stage":{"$in":["Prospecting","Negotiation/Review"]}},{"amount":{"$gte":10000}}] ; ' +
  '[{"$or":[{"name":{"$contains":"lab"}},{"billing_address_city":{"$equals":"Montréal"}}]}] ; ' +
  '[{"date_modified":{"$dateRange":"last_30_days"}}]. ' +
  "Opérateurs : $equals, $not_equals, $starts, $ends, $contains, $in, $not_in, $gt, $gte, $lt, $lte, " +
  "$between, $is_null, $not_null, $dateRange, $or, $and. Utiliser les noms techniques des champs " +
  "(voir sugar_describe_module).";

const READ_TOOLS = [
  {
    name: "sugar_whoami",
    description: "Vérifie la connexion à Sugar et renvoie l'utilisateur connecté.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Qui suis-je dans Sugar", readOnlyHint: true },
    run: async (env) => {
      const me = await sugar(env, "GET", "/me");
      const u = me && me.current_user ? me.current_user : me;
      return {
        user_name: u && u.user_name,
        full_name: u && u.full_name,
        id: u && u.id,
        type: u && u.type,
        sugar_url: cfg(env, "SUGAR_URL"),
        platform: cfg(env, "SUGAR_PLATFORM"),
        writes_enabled: writesEnabled(env),
      };
    },
  },
  {
    name: "sugar_list_modules",
    description: "Liste les modules Sugar accessibles (Accounts, Contacts, Opportunities, Quotes, modules personnalisés, etc.).",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Lister les modules", readOnlyHint: true },
    run: async (env) => {
      const data = await sugar(env, "GET", "/metadata", { query: { type_filter: "module_list" } });
      const list = data && data.module_list ? data.module_list : data;
      const names = Array.isArray(list) ? list : Object.keys(list || {}).filter((k) => k !== "_hash");
      return { modules: names.sort() };
    },
  },
  {
    name: "sugar_describe_module",
    description:
      "Décrit les champs d'un module : nom technique, type, libellé, obligatoire, liste déroulante associée, liens (relations). " +
      "À appeler avant une recherche filtrée ou une écriture pour connaître les noms exacts des champs.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Nom du module, ex. Accounts, Opportunities." },
        include_links: { type: "boolean", description: "Inclure les champs de type lien (relations). Défaut : true." },
      },
      required: ["module"],
    },
    annotations: { title: "Décrire un module", readOnlyHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const data = await sugar(env, "GET", "/metadata", {
        query: { type_filter: "modules", module_filter: module },
      });
      const meta = data && data.modules && data.modules[module];
      if (!meta || !meta.fields) throw new SugarError(`Module introuvable ou inaccessible : ${module}`, 404);
      let modStrings = null;
      try {
        const lang = await getLang(env, cfg(env, "SUGAR_LANGUAGE"));
        modStrings = lang && lang.mod_strings ? lang.mod_strings[module] : null;
      } catch {
        modStrings = null;
      }
      const includeLinks = args.include_links !== false;
      const fields = [];
      const links = [];
      for (const [name, f] of Object.entries(meta.fields)) {
        if (name === "_hash" || !f || typeof f !== "object") continue;
        const label = (modStrings && f.vname && modStrings[f.vname]) || f.vname || null;
        if (f.type === "link") {
          if (includeLinks) links.push({ name, label, module: f.module || null, relationship: f.relationship || null });
          continue;
        }
        const entry = { name, type: f.type, label };
        if (f.required) entry.required = true;
        if (f.options) entry.options = f.options;
        if (f.len) entry.len = f.len;
        if (f.module) entry.related_module = f.module;
        if (f.readonly || f.calculated) entry.readonly = true;
        if (f.source === "non-db") entry.non_db = true;
        fields.push(entry);
      }
      return { module, field_count: fields.length, fields, links };
    },
  },
  {
    name: "sugar_get_dropdown",
    description:
      "Renvoie les valeurs d'une liste déroulante (clé technique et libellé), ex. sales_stage_dom, account_type_dom. " +
      "Le nom de la liste est donné par le champ options de sugar_describe_module. Utiliser la clé technique pour écrire.",
    inputSchema: {
      type: "object",
      properties: {
        list_name: { type: "string" },
        language: { type: "string", description: "Ex. fr_FR, en_us. Défaut : langue configurée." },
      },
      required: ["list_name"],
    },
    annotations: { title: "Valeurs d'une liste déroulante", readOnlyHint: true },
    run: async (env, args) => {
      const listName = checkName(need(args, "list_name"), "list_name");
      const language = args.language ? checkName(args.language, "language") : cfg(env, "SUGAR_LANGUAGE");
      const lang = await getLang(env, language);
      const values = lang && lang.app_list_strings ? lang.app_list_strings[listName] : undefined;
      if (values === undefined) throw new SugarError(`Liste introuvable : ${listName}`, 404);
      return { list_name: listName, language, values };
    },
  },
  {
    name: "sugar_search",
    description:
      "Cherche des fiches dans un module avec un filtre, un tri et une pagination. " + FILTER_HELP,
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        filter: { type: "array", description: "Filtre Sugar, voir la description de l'outil.", items: { type: "object" } },
        fields: { type: "array", items: { type: "string" }, description: "Champs à renvoyer. Recommandé pour limiter la taille." },
        order_by: { type: "string", description: "Ex. date_modified:desc, name:asc." },
        max_num: { type: "integer", description: "Nombre maximal de fiches (défaut 20, max 100)." },
        offset: { type: "integer", description: "Pour la page suivante, reprendre next_offset." },
      },
      required: ["module"],
    },
    annotations: { title: "Chercher des fiches", readOnlyHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const body = {
        filter: Array.isArray(args.filter) ? args.filter : [],
        max_num: clampNum(args.max_num, 20, 100),
        offset: Number.isFinite(Number(args.offset)) ? Math.max(0, Number(args.offset)) : 0,
      };
      const f = fieldsParam(args.fields);
      if (f) body.fields = f;
      if (args.order_by) body.order_by = String(args.order_by);
      const data = await sugar(env, "POST", `/${module}/filter`, { body });
      return { module, next_offset: data.next_offset, count: (data.records || []).length, records: data.records || [] };
    },
  },
  {
    name: "sugar_count",
    description: "Compte les fiches d'un module qui correspondent à un filtre. " + FILTER_HELP,
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        filter: { type: "array", items: { type: "object" } },
      },
      required: ["module"],
    },
    annotations: { title: "Compter des fiches", readOnlyHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const data = await sugar(env, "POST", `/${module}/filter/count`, {
        body: { filter: Array.isArray(args.filter) ? args.filter : [] },
      });
      return { module, count: data && data.record_count !== undefined ? data.record_count : data };
    },
  },
  {
    name: "sugar_global_search",
    description: "Recherche plein texte dans tout Sugar ou dans certains modules (nom de client, courriel, numéro, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Texte à chercher." },
        modules: { type: "array", items: { type: "string" }, description: "Limiter à ces modules (optionnel)." },
        max_num: { type: "integer", description: "Défaut 20, max 50." },
      },
      required: ["q"],
    },
    annotations: { title: "Recherche globale", readOnlyHint: true },
    run: async (env, args) => {
      const q = String(need(args, "q"));
      const moduleList = Array.isArray(args.modules) ? args.modules.map((m) => checkName(m, "module")).join(",") : undefined;
      const query = { q, max_num: clampNum(args.max_num, 20, 50), module_list: moduleList };
      let data;
      try {
        data = await sugar(env, "GET", "/globalsearch", { query });
      } catch (e) {
        if (e.status !== 404) throw e;
        data = await sugar(env, "GET", "/search", { query });
      }
      return { q, next_offset: data.next_offset, records: data.records || data };
    },
  },
  {
    name: "sugar_get_record",
    description: "Lit une fiche complète par son identifiant.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Champs à renvoyer (optionnel)." },
      },
      required: ["module", "id"],
    },
    annotations: { title: "Lire une fiche", readOnlyHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const id = checkId(need(args, "id"));
      return sugar(env, "GET", `/${module}/${id}`, { query: { fields: fieldsParam(args.fields) } });
    },
  },
  {
    name: "sugar_get_related",
    description:
      "Liste les fiches liées à une fiche par un lien (relation), ex. Accounts > contacts, Accounts > opportunities, " +
      "Opportunities > quotes. Les noms de liens sont donnés par sugar_describe_module.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        link: { type: "string", description: "Nom du lien, ex. contacts, opportunities, notes, calls." },
        fields: { type: "array", items: { type: "string" } },
        order_by: { type: "string" },
        max_num: { type: "integer", description: "Défaut 20, max 100." },
        offset: { type: "integer" },
      },
      required: ["module", "id", "link"],
    },
    annotations: { title: "Fiches liées", readOnlyHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const id = checkId(need(args, "id"));
      const link = checkName(need(args, "link"), "link");
      const data = await sugar(env, "GET", `/${module}/${id}/link/${link}`, {
        query: {
          fields: fieldsParam(args.fields),
          order_by: args.order_by,
          max_num: clampNum(args.max_num, 20, 100),
          offset: args.offset,
        },
      });
      return { module, id, link, next_offset: data.next_offset, records: data.records || [] };
    },
  },
];

const WRITE_TOOLS = [
  {
    name: "sugar_create_record",
    description:
      "Crée UNE fiche dans un module (ex. une note, un appel, un contact). Utiliser les noms techniques des champs " +
      "et les clés techniques des listes déroulantes. Pour rattacher une note à une fiche : parent_type et parent_id. " +
      "Les modules du système sont refusés.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        fields: { type: "object", description: "Ex. {\"name\":\"Suivi\",\"parent_type\":\"Accounts\",\"parent_id\":\"...\"}" },
      },
      required: ["module", "fields"],
    },
    annotations: { title: "Créer une fiche", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      assertWritable(env, module);
      const fields = cleanWriteFields(args.fields);
      const created = await sugar(env, "POST", `/${module}`, { body: fields });
      return { created: true, module, id: created && created.id, values: pick(created, Object.keys(fields)) };
    },
  },
  {
    name: "sugar_update_record",
    description:
      "Modifie UNE fiche existante : seuls les champs fournis changent. Renvoie les valeurs avant et après. " +
      "Lire la fiche avant de la modifier. Les modules du système et le champ deleted sont refusés.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        fields: { type: "object", description: "Champs à modifier, ex. {\"sales_stage\":\"Closed Won\"}." },
      },
      required: ["module", "id", "fields"],
    },
    annotations: { title: "Modifier une fiche", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const id = checkId(need(args, "id"));
      assertWritable(env, module);
      const fields = cleanWriteFields(args.fields);
      const keys = Object.keys(fields);
      const before = await sugar(env, "GET", `/${module}/${id}`, { query: { fields: keys.join(",") } });
      const after = await sugar(env, "PUT", `/${module}/${id}`, { body: fields });
      return { updated: true, module, id, before: pick(before, keys), after: pick(after, keys) };
    },
  },
  {
    name: "sugar_link_records",
    description:
      "Lie deux fiches existantes par un lien (relation), ex. ajouter un contact à un compte (Accounts, lien contacts). " +
      "Les noms de liens sont donnés par sugar_describe_module.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        link: { type: "string" },
        related_id: { type: "string" },
      },
      required: ["module", "id", "link", "related_id"],
    },
    annotations: { title: "Lier deux fiches", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (env, args) => {
      const module = checkName(need(args, "module"), "module");
      const id = checkId(need(args, "id"));
      const link = checkName(need(args, "link"), "link");
      const relatedId = checkId(need(args, "related_id"), "related_id");
      assertWritable(env, module);
      const data = await sugar(env, "POST", `/${module}/${id}/link/${link}/${relatedId}`, { body: {} });
      return { linked: true, module, id, link, related_id: relatedId, related_record: data && data.related_record ? { id: data.related_record.id, name: data.related_record.name } : null };
    },
  },
];

function activeTools(env) {
  return writesEnabled(env) ? READ_TOOLS.concat(WRITE_TOOLS) : READ_TOOLS;
}

const INSTRUCTIONS =
  "Connecteur SugarCRM d'Aspasie. Démarche conseillée : sugar_describe_module pour connaître les noms techniques " +
  "des champs et des liens, puis sugar_search ou sugar_global_search, puis sugar_get_record ou sugar_get_related. " +
  "Pour les listes déroulantes, utiliser sugar_get_dropdown et écrire la clé technique. " +
  "Écritures : une seule fiche par appel ; toujours lire la fiche avant de la modifier et annoncer à l'utilisateur " +
  "ce qui va changer. Aucune suppression n'est possible par ce connecteur.";

// ---------------------------------------------------------------------------
// Protocole MCP (JSON-RPC 2.0)

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

function toText(value) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS) + "\n[... réponse tronquée : préciser fields ou réduire max_num]";
  }
  return text;
}

async function handleRpc(env, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Requête JSON-RPC invalide");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const params = msg.params || {};

  switch (msg.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: activeTools(env).map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      });
    case "tools/call": {
      const tool = activeTools(env).find((t) => t.name === params.name);
      if (!tool) return rpcError(msg.id, -32602, `Outil inconnu ou désactivé : ${params.name}`);
      try {
        const out = await tool.run(env, params.arguments || {});
        return rpcResult(msg.id, { content: [{ type: "text", text: toText(out) }] });
      } catch (e) {
        return rpcResult(msg.id, {
          isError: true,
          content: [{ type: "text", text: e && e.message ? e.message : String(e) }],
        });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, etc.
      return rpcError(msg.id, -32601, `Méthode non prise en charge : ${msg.method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, url, env) {
  const secret = env.MCP_SECRET;
  if (!secret || secret.length < 24) return false; // échoue fermé si le secret est absent ou trop court
  const parts = url.pathname.split("/").filter(Boolean); // ["mcp", "<secret>"]
  if (parts.length === 2 && safeEqual(parts[1], secret)) return true;
  const auth = request.headers.get("Authorization") || "";
  return parts.length === 1 && auth.startsWith("Bearer ") && safeEqual(auth.slice(7), secret);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("ok", { status: 200 });
    }
    if (!url.pathname.startsWith("/mcp")) {
      return new Response("Not found", { status: 404 });
    }
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 24) {
      return json(500, { error: "MCP_SECRET absent ou trop court (24 caractères minimum)." });
    }
    if (!authorized(request, url, env)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (request.method === "GET") {
      // Pas de flux SSE initié par le serveur en mode sans état.
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, rpcError(null, -32700, "JSON invalide"));
    }

    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleRpc(env, m)))).filter(Boolean);
      return results.length ? json(200, results) : new Response(null, { status: 202 });
    }
    const result = await handleRpc(env, payload);
    return result ? json(200, result) : new Response(null, { status: 202 });
  },
};

// Exporté pour les tests.
export const _internal = { WRITE_BLOCKED_MODULES, resetCaches: () => { tokenCache = null; langCache = null; } };
