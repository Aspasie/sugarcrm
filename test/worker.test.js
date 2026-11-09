// Tests du serveur MCP avec un faux Sugar (aucun appel réseau réel).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { _internal } from "../src/index.js";

const SECRET = "s".repeat(32);
const baseEnv = { MCP_SECRET: SECRET, SUGAR_USERNAME: "admin", SUGAR_PASSWORD: "pw" };
let calls;
let tokenCount;

function fakeSugar(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers: init.headers });
    if (u.pathname.endsWith("/oauth2/token")) {
      tokenCount++;
      return new Response(JSON.stringify({ access_token: `tok${tokenCount}`, refresh_token: "r", expires_in: 3600 }), { status: 200 });
    }
    const r = handler(init.method || "GET", u.pathname.replace("/rest/v11", ""), body, u, init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
}

async function rpc(env, method, params, path = `/mcp/${SECRET}`) {
  const res = await worker.fetch(
    new Request(`https://w.example${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

async function call(env, name, args) {
  const r = await rpc(env, "tools/call", { name, arguments: args });
  const res = r.body.result;
  return { isError: !!res.isError, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
}

beforeEach(() => {
  calls = [];
  tokenCount = 0;
  _internal.resetCaches();
});

test("refuse sans secret ou avec un mauvais secret", async () => {
  fakeSugar(() => ({}));
  assert.equal((await rpc(baseEnv, "tools/list", {}, "/mcp/mauvais")).status, 401);
  assert.equal((await rpc(baseEnv, "tools/list", {}, "/mcp")).status, 401);
  assert.equal((await rpc({ ...baseEnv, MCP_SECRET: "court" }, "tools/list", {}, "/mcp/court")).status, 500);
});

test("accepte le secret en en-tête Bearer", async () => {
  fakeSugar(() => ({}));
  const res = await worker.fetch(
    new Request("https://w.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    baseEnv
  );
  assert.equal(res.status, 200);
});

test("initialize, notification et liste des outils", async () => {
  fakeSugar(() => ({}));
  const init = await rpc(baseEnv, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  const notif = await worker.fetch(
    new Request(`https://w.example/mcp/${SECRET}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
    baseEnv
  );
  assert.equal(notif.status, 202);

  const readOnly = (await rpc(baseEnv, "tools/list", {})).body.result.tools.map((t) => t.name);
  assert.ok(readOnly.includes("sugar_search"));
  assert.ok(!readOnly.includes("sugar_update_record"), "écritures cachées quand WRITE_ENABLED est absent");

  const all = (await rpc({ ...baseEnv, WRITE_ENABLED: "true" }, "tools/list", {})).body.result.tools.map((t) => t.name);
  assert.ok(all.includes("sugar_update_record"));
  assert.ok(!all.some((n) => n.includes("delete")), "aucun outil de suppression");
});

test("connexion Sugar avec la plateforme mobile et recherche filtrée", async () => {
  fakeSugar((m, p, body) => {
    if (m === "POST" && p === "/Accounts/filter") return { body: { next_offset: -1, records: [{ id: "a1", name: "Acme" }] } };
    return { status: 404 };
  });
  const r = await call(baseEnv, "sugar_search", { module: "Accounts", filter: [{ name: { $starts: "Ac" } }], fields: ["name"], max_num: 500 });
  assert.equal(r.isError, false);
  assert.equal(r.data.records[0].name, "Acme");
  const login = calls.find((c) => c.path.endsWith("/oauth2/token"));
  assert.equal(login.body.platform, "mobile");
  assert.equal(login.body.client_id, "sugar");
  assert.equal(login.body.grant_type, "password");
  const search = calls.find((c) => c.path.endsWith("/Accounts/filter"));
  assert.equal(search.body.max_num, 100, "max_num plafonné à 100");
  assert.equal(search.body.fields, "name");
  assert.equal(search.headers["OAuth-Token"], "tok1");
});

test("jeton refusé (401) : nouvelle connexion et une seule reprise", async () => {
  let first = true;
  fakeSugar((m, p) => {
    if (p === "/me") {
      if (first) { first = false; return { status: 401, body: { error: "invalid_grant" } }; }
      return { body: { current_user: { user_name: "admin", id: "1" } } };
    }
    return { status: 404 };
  });
  const r = await call(baseEnv, "sugar_whoami", {});
  assert.equal(r.isError, false);
  assert.equal(r.data.user_name, "admin");
  assert.equal(tokenCount, 2);
});

test("écritures refusées quand WRITE_ENABLED n'est pas à true", async () => {
  fakeSugar(() => ({ body: {} }));
  const r = await rpc(baseEnv, "tools/call", { name: "sugar_update_record", arguments: { module: "Accounts", id: "a1", fields: { name: "x" } } });
  assert.ok(r.body.error, "outil inconnu quand les écritures sont désactivées");
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("modification : avant et après, une seule fiche", async () => {
  const env = { ...baseEnv, WRITE_ENABLED: "true" };
  fakeSugar((m, p, body) => {
    if (m === "GET" && p === "/Opportunities/o1") return { body: { id: "o1", sales_stage: "Prospecting" } };
    if (m === "PUT" && p === "/Opportunities/o1") return { body: { id: "o1", ...body } };
    return { status: 404 };
  });
  const r = await call(env, "sugar_update_record", { module: "Opportunities", id: "o1", fields: { sales_stage: "Closed Won" } });
  assert.equal(r.isError, false);
  assert.deepEqual(r.data.before, { sales_stage: "Prospecting" });
  assert.deepEqual(r.data.after, { sales_stage: "Closed Won" });
});

test("modules du système et champ deleted protégés", async () => {
  const env = { ...baseEnv, WRITE_ENABLED: "true" };
  fakeSugar(() => ({ body: {} }));
  for (const module of ["Users", "ACLRoles", "pmse_Project", "Teams"]) {
    const r = await call(env, "sugar_update_record", { module, id: "x1", fields: { name: "x" } });
    assert.equal(r.isError, true, module);
  }
  const del = await call(env, "sugar_update_record", { module: "Accounts", id: "a1", fields: { deleted: 1 } });
  assert.equal(del.isError, true);
  assert.equal(calls.filter((c) => c.method === "PUT" || c.method === "POST" && !c.path.endsWith("/oauth2/token")).length, 0);
});

test("noms de module et identifiants validés (pas d'injection de chemin)", async () => {
  fakeSugar(() => ({ body: {} }));
  const r = await call(baseEnv, "sugar_get_record", { module: "../Users", id: "1" });
  assert.equal(r.isError, true);
  const r2 = await call(baseEnv, "sugar_get_record", { module: "Accounts", id: "a/../../me" });
  assert.equal(r2.isError, true);
});

test("describe_module : libellés et liens", async () => {
  fakeSugar((m, p, body, u) => {
    if (p === "/metadata") {
      return { body: { modules: { Accounts: { fields: {
        name: { type: "name", vname: "LBL_NAME", required: true },
        account_type: { type: "enum", vname: "LBL_TYPE", options: "account_type_dom" },
        contacts: { type: "link", vname: "LBL_CONTACTS", module: "Contacts", relationship: "accounts_contacts" },
        _hash: "x",
      } } } } };
    }
    if (p === "/lang/fr_FR") return { body: { mod_strings: { Accounts: { LBL_NAME: "Nom" } }, app_list_strings: { account_type_dom: { Customer: "Client" } } } };
    return { status: 404 };
  });
  const r = await call(baseEnv, "sugar_describe_module", { module: "Accounts" });
  assert.equal(r.data.fields.find((f) => f.name === "name").label, "Nom");
  assert.equal(r.data.links[0].name, "contacts");
  const d = await call(baseEnv, "sugar_get_dropdown", { list_name: "account_type_dom" });
  assert.equal(d.data.values.Customer, "Client");
});

test("erreur Sugar renvoyée lisiblement à Claude", async () => {
  fakeSugar(() => ({ status: 403, body: { error: "not_authorized", error_message: "No access" } }));
  const r = await call(baseEnv, "sugar_get_record", { module: "Accounts", id: "a1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not_authorized/);
});
