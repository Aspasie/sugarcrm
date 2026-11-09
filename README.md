# Connecteur SugarCRM pour Claude (Aspasie)

Serveur MCP distant qui relie Claude (claude.ai, Claude Desktop, application mobile) au SugarCRM d'Aspasie
(`https://aspasie.sugarondemand.com`). Il tourne sur Cloudflare Workers et se déploie automatiquement à chaque
envoi sur la branche `main` de ce dépôt.

## Ce que Claude peut faire

### Lecture (toujours active)

| Outil | Rôle |
| --- | --- |
| `sugar_whoami` | Vérifie la connexion et indique le compte utilisé |
| `sugar_list_modules` | Liste tous les modules accessibles |
| `sugar_describe_module` | Champs d'un module (noms techniques, libellés, listes, relations) |
| `sugar_get_dropdown` | Valeurs d'une liste déroulante (ex. étapes de vente) |
| `sugar_search` | Recherche filtrée, triée et paginée dans un module |
| `sugar_count` | Nombre de fiches correspondant à un filtre |
| `sugar_global_search` | Recherche plein texte dans tout Sugar |
| `sugar_get_record` | Lecture d'une fiche |
| `sugar_get_related` | Fiches liées (contacts d'un compte, opportunités, notes, etc.) |

### Écriture (seulement si `WRITE_ENABLED` vaut `true`)

| Outil | Rôle |
| --- | --- |
| `sugar_create_record` | Crée une fiche (une à la fois) |
| `sugar_update_record` | Modifie une fiche, renvoie l'avant et l'après |
| `sugar_link_records` | Lie deux fiches existantes |

### Garde-fous intégrés au code

- **Aucune suppression possible** : il n'existe aucun outil de suppression, et le champ `deleted` est refusé.
- **Modules du système protégés** : aucune écriture dans Users, Teams, ACLRoles, Workflows, Schedulers, etc.,
  peu importe les droits du compte Sugar.
- **Une fiche par appel** : pas de modification en lot.
- **Accès protégé** : sans le secret `MCP_SECRET`, le serveur répond 401. Sans secret configuré, il refuse tout.

## Réglages (Cloudflare > Worker > Settings > Variables and Secrets)

| Nom | Type | Valeur |
| --- | --- | --- |
| `SUGAR_USERNAME` | Secret | Nom d'utilisateur Sugar |
| `SUGAR_PASSWORD` | Secret | Mot de passe Sugar |
| `MCP_SECRET` | Secret | Chaîne aléatoire d'au moins 24 caractères (40 ou plus conseillé) |
| `WRITE_ENABLED` | Texte | `true` pour activer les écritures, `false` sinon |
| `SUGAR_PLATFORM` | Texte, facultatif | Défaut : `mobile` |
| `SUGAR_URL` | Texte, facultatif | Défaut : `https://aspasie.sugarondemand.com` |
| `SUGAR_LANGUAGE` | Texte, facultatif | Défaut : `fr_FR` (repli automatique sur `en_us`) |
| `SUGAR_API_VERSION` | Texte, facultatif | Défaut : `v11` |

Les identifiants Sugar ne doivent **jamais** se trouver dans ce dépôt.

## Mise en service

### 1. Créer le Worker à partir de ce dépôt

1. Cloudflare > **Workers & Pages** > **Create** > **Import a repository**.
2. Autoriser l'accès à GitHub si demandé, puis choisir ce dépôt.
3. Nom du projet : `sugarcrm` (doit correspondre à `name` dans `wrangler.toml`).
4. Laisser les commandes par défaut et cliquer sur **Deploy**.

### 2. Ajouter les réglages

Dans le Worker : **Settings** > **Variables and Secrets** > **Add**, pour chaque ligne du tableau ci-dessus.
Chaque ajout redéploie le Worker automatiquement.

### 3. Vérifier

Ouvrir `https://sugarcrm.wispy-king-3ab6.workers.dev/` : la page doit afficher `ok`.

### 4. Brancher dans Claude

1. claude.ai > **Réglages** > **Connecteurs** > **Ajouter un connecteur personnalisé**.
2. Nom : `SugarCRM`.
3. URL : `https://sugarcrm.wispy-king-3ab6.workers.dev/mcp/<MCP_SECRET>`
4. Dans les réglages du connecteur, mettre les outils d'écriture sur **Toujours demander**.
5. Test : « Utilise sugar_whoami pour vérifier la connexion à Sugar. »

L'URL contient le secret : la traiter comme un mot de passe. Pour Claude Code, on peut aussi utiliser
l'adresse `/mcp` avec l'en-tête `Authorization: Bearer <MCP_SECRET>`.

## Dépannage

| Symptôme | Cause probable |
| --- | --- |
| `Connexion à Sugar refusée ... invalid_grant` | Mauvais identifiants, ou connexion par SugarIdentity (SSO) |
| `... invalid_client` | Plateforme non reconnue par Sugar (vérifier `SUGAR_PLATFORM`) |
| Déconnexions de l'application mobile Sugar | Le même compte utilise la plateforme `mobile` ailleurs |
| `401 Unauthorized` dans Claude | URL du connecteur incomplète ou secret modifié |
| Outils d'écriture absents | `WRITE_ENABLED` n'est pas à `true` |

## Développement

```bash
npm install
npm test
```

Essai local : copier `.dev.vars.example` en `.dev.vars`, le remplir, puis `npm run dev`.
