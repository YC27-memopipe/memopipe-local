# Contrat d’intégration · memopipe-serv

`@canary/local@0.1.0` fournit le moteur TypeScript pur et les contrats. Aucun serveur HTTP, aucun import Next.js, aucune dépendance runtime. Le hub conserve la base, les routes, les écrans, les versions et contributions ; il implémente l’adaptateur métier sur les tables Nimbus.

## Transfert du package

Dans `memopipe-local` :

```sh
bun test
bun run typecheck
bun pm pack
```

Transmettre `canary-local-0.1.0.tgz` au coéquipier (aucune publication npm nécessaire). Dans son dépôt :

```sh
bun add /chemin/vers/canary-local-0.1.0.tgz
```

Le paquet contient les sources TS. Dans `next.config.ts`, ajouter `transpilePackages: ['@canary/local']`. Pour un déploiement reproductible, conserver l’archive dans le dépôt serveur (par exemple `vendor/`) et l’installer depuis ce chemin relatif, puis committer le lockfile. L’archive n’embarque ni `.env`, ni captures, ni CLI. Incrémenter la version du package avant une prochaine livraison.

```ts
import { compile, start, step, finish, compare, testAll } from '@canary/local';
import type { ActionAdapter, Scenario, RunState, ScenarioUploadRequest } from '@canary/local';
```

## Actions à implémenter côté serveur

L’interface exacte se trouve dans `src/types.ts` du package :

```ts
interface ActionAdapter {
  createTestTicket(input: TicketInput, runId: string): Promise<Ticket>;
  execute(call: ActionCall, context: {
    runId: string;
    operationId: string;
  }): Promise<unknown>;
  snapshot(ticket: Ticket, runId: string): Promise<Snapshot>;
}
```

`createTestTicket` crée un ticket frais et un email frais, sans grant initial. Exemples : `T-1182-R<runId>` et `ines.fabre+r<runId>@presta.example`. Les deux doivent différer des données du scénario. Stocker le lien runId/ticket/email et conserver ces identifiants dans les étapes suivantes. Ne jamais modifier le ticket original. Un nouveau run crée une nouvelle copie.

`execute` fait les vraies mutations dans Nimbus :

| Action | Arguments | Mutation |
| --- | --- | --- |
| `iam.grant` | user, system, level, expires? | Upsert `(email, system)` ; `none` retire l’accès ou stocke un grant `none` ; effacer l’ancienne expiration si omise |
| `tickets.comment` | id, text | Ajouter un commentaire |
| `tickets.close` | id | Mettre le statut à `done` |

Vérifier les cibles contre le run et appeler `validateCall` côté adaptateur si nécessaire. Le runner effectue déjà ces vérifications avant dispatch. Renvoyer un résultat JSON sérialisable décrivant l’effet pour le journal.

**Idempotence** : `operationId` est `<runId>:<pc>`. Stocker un reçu unique `(runId, operationId)` avec la signature de l’action et son résultat, dans la même transaction que la mutation. Un retry de la même opération renvoie le reçu ; une signature différente pour le même identifiant échoue. C’est indispensable pour éviter de doubler un commentaire après un crash entre mutation et sauvegarde du run. `MemoryAdapter` illustre ce comportement, mais son état disparaît au redémarrage.

`snapshot` lit le ticket actuel et tous les grants de l’email dédié au run depuis la base, sans utiliser les valeurs attendues du scénario. Ne pas réutiliser l’objet ticket initial pour décider du statut final.

## Routes du hub

### POST /api/scenarios

Vérifier `Authorization: Bearer <CANARY_TEAM_TOKEN>` côté serveur ; ne jamais exposer ce secret au navigateur. JSON envoyé par le CLI, **un scénario par requête** :

```json
{
  "automation_id": "attribuer-acces",
  "author": "Bob",
  "scenario": {
    "title": "T-1182 · Inès Fabre · prestataire",
    "origin": "Screenpipe · Bob · T-1182",
    "ticket": {
      "id": "T-1182",
      "type": "access_request",
      "requester": {
        "name": "Inès Fabre",
        "email": "ines.fabre@presta.example",
        "contract": "prestataire",
        "team": "data",
        "end_date": "2027-01-15"
      }
    },
    "expected": {
      "github": "read",
      "vpn-prod": "none",
      "slack": "guest",
      "expires_before": "2027-01-15",
      "ticket_status": "done"
    },
    "evidence": [{ "frame_id": 51234, "quote": "GitHub : Lecture seule" }]
  }
}
```

Cet exemple est fictif. L’origine des fixtures de démonstration contient `DÉMO FICTIVE`. Contrat identique à la spec §6, avec `ticket.id` facultatif pour conserver l’ID source. Contrats `ScenarioUploadRequest` et `ScenarioUploadResponse` exportés. Valider avec `validateScenario`, vérifier l’automatisation cible, stocker en base. Le validateur refuse les champs surnuméraires : retirer les métadonnées de stockage (`id`, `automation_id`, etc.) du document scénario avant de le passer au moteur. `ticket.id` reste le seul identifiant source optionnel prévu dans ce document. Réponse 200/201 : `{ "id": "scenario-id" }`. Erreurs : 400 données invalides, 401/403 jeton, 404 automatisation inconnue, 5xx erreur. Le CLI n’envoie aucun cas refusé.

Prévoir une clé de déduplication, par exemple automation + auteur + hash JSON canonique du scénario ; un doublon peut retourner l’ID existant avec HTTP 200. Pas de retry automatique du CLI. Une requête qui expire peut avoir été reçue ; ne pas créer de doublon lors d’une relance.

### Exécution

- `POST /api/runs` : charger le DSL de la version/copie et le scénario depuis la base, `compile(dsl)` **avant de créer le ticket**, puis `await start(program, scenario, dbAdapter)`. Persister l’intégralité de `RunState`.
- `POST /api/runs/:id/step` : charger l’état, `await step(state, dbAdapter)`, sauvegarder et renvoyer. Une instruction par clic, y compris les sauts. Si terminé, lire le snapshot et appeler `compare`. Si failed, garder l’erreur visible et empêcher l’approbation.
- `POST /api/runs/:id/finish` : `await finish(state, dbAdapter)` ; sauvegarder état et comparaison.
- `POST /api/test-all` : `await testAll(dsl, scenarios, dbAdapter)`. Garder les résultats associés à cette version exacte du DSL ; une édition invalide les résultats précédents.

**Concurrence** : sérialiser step/finish par run, par verrou en base ou contrôle de révision transactionnel. Le runner fait des transitions immuables ; il ne fournit pas de verrou distribué. Persister chaque étape si le hub veut reprendre une exécution `finish` interrompue ; `finish` renvoie l’état final en une fois. Les opérations idempotentes permettent de rejouer depuis le dernier état enregistré. Les états persistés et programmes compilés sont des données internes de confiance : ne pas accepter un `Program`/`RunState` arbitraire du navigateur.

Le hub doit montrer les écarts **et** les erreurs d’exécution. Une comparaison sans écart ne suffit pas si le run est `failed`. Pour les contributions, ne permettre l’approbation que si chaque run est `completed` et `comparison.passed === true`.

## Texte Nimbus à figer

Le parseur dépend du texte visible HTML suivant, une information par ligne :

```text
Titre de fenêtre : T-1182 · Tickets Nimbus
Type : access_request
Demandeur : Inès Fabre
Email : ines.fabre@presta.example
Type de contrat : Prestataire
Équipe : data
Fin de mission : 15/01/2027
Statut : Terminé
Commentaire : Mission de 3 mois en prestation : GitHub en lecture seule, pas de VPN prod
```

`Titre de fenêtre` représente `document.title`, pas une ligne à ajouter à la page. `Type de contrat` vaut `CDI` ou `Prestataire`. Le parseur produit `cdi`/`prestataire`. La date accepte aussi `2027-01-15`. L’email doit être visible et le nom du demandeur doit être seul après `Demandeur :`.

Console : `document.title = 'Console des permissions · ines.fabre@presta.example'`. Après enregistrement, afficher un résumé :

```text
Email : ines.fabre@presta.example
Modifications enregistrées le 18/10/2026 à 09:24
GitHub : Lecture seule
VPN production : Non
Slack : Invité
Expiration : 15/01/2027
```

GitHub : `Lecture seule`, `Écriture`, `Aucun` ; VPN : `Oui`, `Non` ; Slack : `Invité`, `Membre`, `Aucun`. `Expiration : Aucune` pour le CDI. Le marqueur `Modifications enregistrées` doit correspondre à ce résumé sauvegardé, et non aux contrôles en cours de modification. Ne pas le conserver au-dessus de valeurs non sauvegardées sans distinguer clairement le résumé.

Avant la démo, vérifier dans le vrai `/search` que les titres arrivent dans `window_name` et que ces libellés sont bien présents en accessibility ou OCR. Sans cette vérification, seule l’intégration sur fixtures est démontrée. La dernière console sauvegardée de la période sert de référence ; la présence de plusieurs tickets pour un même email est volontairement rejetée, faute de lien historique fiable.


## Vérifications autonomes livrées

Voir [audit.md](audit.md) : 90 tests, dont 9 tests HTTP du vrai CLI contre des mocks loopback. `bun run test:package` installe réellement l’archive dans un projet indépendant, vérifie les contrats TypeScript et exécute v1/v2 sur les trois scénarios. `ScreenpipeClient.search` a été vérifié sur les deux types réels de Screenpipe 0.4.52, y compris la forme accessibility `UI.content.id`. Ces vérifications ne remplacent pas celles des pages Nimbus et de votre adaptateur base de données.
