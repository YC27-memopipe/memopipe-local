# CANARY · memopipe-local

Partie locale du MVP Screenpipe Track 3 : DSL sans `eval`, moteur pas à pas indépendant de Next.js, comparaison des permissions et analyse Screenpipe avec consentement. `memopipe-serv` porte le hub, Nimbus IT et sa base ; ce dépôt ne contient aucun serveur web.

## Découvrir les procédures adaptées à son historique

Le nouveau parcours ne nécessite pas de choisir l’automatisation d’Alice au départ. Il extrait les cas Nimbus de l’historique Screenpipe ; le hub les compare aux procédures publiées dans son catalogue. Les références restent à confirmer avant les tests.

```sh
# .env : SCREENPIPE_LOCAL_API_KEY, CANARY_HUB_URL, CANARY_TEAM_TOKEN, CANARY_AUTHOR=Bob
bun run canary:discover --since 24h

# Démonstration fictive explicite, sans lecture de Screenpipe
bun run canary:discover --fixtures fixtures/bob.json

# Inspection locale sans envoi au hub
bun run canary:discover --fixtures fixtures/bob.json --dry-run
```

Le terminal demande d’abord le consentement de lecture, puis l’autorisation de transmettre les champs et citations affichés. Il renvoie l’URL des recommandations. Aucune capture complète n’est transmise et aucun cas ne devient un test avant sa validation dans le hub.

Pour lancer cette analyse directement depuis le hub, laisser tourner `bun run canary:agent` sur le PC qui contient l’historique, puis ouvrir **Découvrir** dans le hub avec la même identité. L’agent utilise `CANARY_AUTHOR` (ou `--author Bob`) pour ne récupérer que les analyses d’historique de cette personne. Gmail est facultatif et son absence ne bloque pas ce parcours.

Le périmètre actuel est **Tickets Nimbus / Console des permissions**. Il reconstitue les champs et résultats visibles, sans générer automatiquement une procédure à partir des clics. Les preuves des fixtures sont fictives ; la provenance des enregistrements réels reste déclarative.

Le diagnostic des échecs et la proposition de correction sont désormais générés par OpenAI dans le **hub**, après un consentement distinct et un aperçu du contexte minimisé. La clé `OPENAI_API_KEY` et `AI_MODEL` se configurent uniquement dans `memopipe-serv/.env`. L’agent local ne reçoit pas cette clé. Les tests du hub bloquent Gmail et les actions hors du ticket/demandeur du test ; la publication passe toujours par une revue humaine.

## Démarrer

Bun ≥ 1.3 (vérifié avec 1.4.3).

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run canary:demo
```

La démo utilise **uniquement des données fictives et l’adaptateur en mémoire**. Résultat attendu : v1 = 2/3, dont exactement 4 écarts sur T-1182 ; v2 = 3/3, aucun écart.

```sh
bun run canary:analyze --fixtures fixtures/bob.json --dry-run
```

Répondre `o` au consentement puis à chaque cas à valider, `n` pour rejeter. Il n’existe pas d’option d’acceptation automatique. Les références de frames fictives sont affichées comme telles, sans lien Screenpipe prétendument authentique.

## Avec Screenpipe et le hub

```sh
cp .env.example .env
# Renseigner les trois valeurs privées ; Bun charge .env automatiquement.
# SCREENPIPE_LOCAL_API_KEY : récupérer en privé via `screenpipe auth token`.
bun run canary:analyze --hub https://canary-xxx.vercel.app --automation attribuer-acces --since 24h --save local-data/bob.json
```

`SCREENPIPE_LOCAL_API_URL` vaut `http://localhost:3030` par défaut. Seules les origines HTTP loopback sont acceptées. La clé est transmise dans `Authorization: Bearer …`, jamais affichée. Redirections refusées et timeout de 15 s. Le hub doit utiliser HTTPS, sauf en développement sur loopback.

Après consentement, le CLI vérifie `/health` : `frame_status: ok` ou `ui_recorder.running: true` est requis. S’il ne répond pas, lancer Screenpipe ; si la capture est arrêtée, vérifier l’espace disque et relancer l’app. Le CLI ne modifie pas la configuration du recorder. Une capture inactive interrompt le parcours live, sans basculer discrètement en fixtures.

La recherche porte sur les dernières 24 h (`--since 30m`, `24h`, `2d`, maximum 365 jours), avec deux fenêtres : `Tickets Nimbus` et `Console des permissions`. Les bornes ISO restent fixes pendant toute la pagination. Chaque recherche commence en accessibility et réessaie en OCR si aucune observation exploitable n’est retournée. Offset augmenté du nombre de lignes brutes, arrêt sur page vide. Pagination répétée, réponse mal formée ou limite atteinte : échec explicite sans envoyer un résultat partiel.

Les tickets sont regroupés par ID, les consoles par email. La dernière observation du ticket et la dernière console contenant `Modifications enregistrées` sont retenues. Les cas incomplets ou associés à plusieurs tickets pour le même email sont signalés et écartés. Les citations proviennent littéralement des frames retenues. Le statut attendu `done` est une règle du workflow, pas une inférence de l’état historique.

Le CLI affiche les champs, les attentes et les preuves, puis demande **une seule validation par cas**. Il envoie immédiatement chaque cas validé à `POST /api/scenarios`. Un refus ne produit aucun envoi. Les captures complètes ne sont jamais envoyées ; seuls les champs du scénario et les citations sélectionnées le sont. Les erreurs d’envoi arrêtent le CLI : les reçus déjà affichés restent valables, et aucun retry automatique n’est effectué. Le hub doit prévoir la déduplication si l’on relance une analyse.

Options :

| Option | Fonction |
| --- | --- |
| `--hub <origin>` | Remplace `CANARY_HUB_URL` |
| `--automation <id>` | Automatisation cible, obligatoire pour envoyer |
| `--since 24h` | Période live |
| `--save <path>` | Sauvegarde locale complète, sans écrasement |
| `--fixtures <path>` | Relecture explicite ; utilise la période du fichier |
| `--dry-run` | Validation locale uniquement, aucun envoi |

Les fichiers créés par `--save` ont `provenance: recorded`, contrairement à `fixtures/bob.json` (`synthetic-demo`). Cette provenance est une déclaration, sans signature cryptographique. Stocker les vrais enregistrements dans `local-data/` (ignoré par Git) ; ils peuvent contenir du texte privé. `--save` crée le fichier avec permissions 0600. Ne pas committer de vrais enregistrements par défaut.

## Agent : actions Gmail réelles via Screenpipe

Le hub ne peut pas joindre Screenpipe (`localhost`). Quand une automatisation exécute `gmail.search` ou `gmail.send`, le hub met l'action en file d'attente. L'agent, lancé sur le PC qui a Screenpipe, la prend (`GET /api/agent/next`), l'exécute, puis renvoie le résultat (`POST /api/agent/jobs/<id>`). Le test pas à pas du hub affiche ce résultat comme les autres étapes.

```sh
# .env : SCREENPIPE_LOCAL_API_KEY, CANARY_HUB_URL, CANARY_TEAM_TOKEN (= MEMOPIPE_TEAM_TOKEN du hub),
# CANARY_TEST_INBOX=vous@gmail.com pour que tous les envois arrivent dans votre boîte.
bun run canary:agent --hub https://memopipe-serv.onrender.com
```

| Action | Exécution locale |
| --- | --- |
| `gmail.search` (query, limit) | `GET /connections/imap/messages` puis `/connections/imap/messages/<id>` pour l'extrait du plus récent. Requiert Screenpipe > Connections > Email Inbox (IMAP), avec un mot de passe d'application Google. |
| `gmail.send` (to, subject, body) | Le navigateur piloté par Screenpipe (`owned-default` ou `user-browser`, option `--browser`) ouvre la rédaction Gmail préremplie, puis un seul clic sur « Envoyer ». Requiert d'être connecté à Gmail dans ce navigateur. Screenpipe n'expose pas d'envoi SMTP par API. |

Garde-fous : jeton d'équipe obligatoire ; hub en HTTPS ou loopback ; Screenpipe en loopback uniquement ; avec `CANARY_TEST_INBOX`, l'email part vers cette boîte et le sujet indique le destinataire prévu ; sur une page de connexion Google, aucun clic n'est fait ; chaque action est exécutée une seule fois, sans retry si l'envoi du résultat au hub échoue.

## DSL et moteur

Exemples complets : [v1](examples/v1.canary), [v2](examples/v2.canary).

- `AUTOMATION "titre"`, `USAGE "description"` : métadonnées optionnelles en tête.
- `SET nom = expression`, `DO action clé=expression`, `IF condition / ELSE / END` ; blocs imbriqués permis.
- Chaînes JSON entre guillemets doubles, chemins (`ticket.requester.email`), interpolation `{{p.name}}`.
- Opérateurs : `==`, `!=`, `not`, `and`, `or`, parenthèses. Priorité : atome, égalité, `not`, `and`, `or` ; court-circuit booléen.
- Lignes vides et commentaires commençant par `#` ignorés ; pas de commentaire inline.
- Actions : `iam.grant user=… system=… level=… expires=…`, `tickets.comment id=… text=…`, `tickets.close id=…`.
- Dates ISO `YYYY-MM-DD`. Systèmes/niveaux : github `none/read/write`, vpn-prod `none/access`, slack `none/guest/member`.

Les erreurs de syntaxe, actions inconnues, arguments manquants et niveaux statiques invalides échouent à la compilation. Les valeurs dynamiques sont vérifiées avant l’appel de l’adaptateur. Variables inconnues et chemins de prototype sont interdits. `ticket` est réservé. Chaque action doit viser le ticket ou l’email isolé du run.

```ts
import { compile, start, step, finish, MemoryAdapter } from '@canary/local';

const adapter = new MemoryAdapter();
const program = compile(dsl);
let state = await start(program, scenario, adapter);
state = await step(state, adapter); // une instruction, un log
// JSON.stringify(state) peut être stocké en base puis rechargé.
const { state: done, comparison } = await finish(state, adapter);
```

`pc` et les cibles de saut sont des index à partir de 0 ; la ligne source commence à 1. Les branchements et sauts sont également des étapes visibles. `END` ferme le bloc à la compilation sans instruction d’exécution. `SET` enregistre une valeur, une action enregistre le résultat de l’adaptateur. Une erreur produit un log et l’état `failed`, qui ne peut pas réussir le test. Le snapshot réel reste autoritaire pour le statut et les permissions ; les variables sont le contexte d’exécution initial, pas une vue automatiquement synchronisée de la base.

`compare(scenario, snapshot)` vérifie chaque niveau exact et le statut. `none` accepte l’absence d’un grant. Pour `expires_before`, tous les grants actifs du demandeur doivent avoir une date valide ≤ la limite, y compris le VPN inattendu. Les défauts d’expiration forment un seul écart. `testAll(dsl, scenarios, adapter)` crée un run isolé par scénario.

## Intégration et état de validation

Contrats et instructions pour le coéquipier : [docs/integration.md](docs/integration.md). Commande `bun pm pack` pour produire `canary-local-0.1.0.tgz`, à installer dans le dépôt serveur sans import entre dossiers.

Les tests couvrent le DSL, les trois scénarios, le pas à pas et sa reprise JSON, l’idempotence mémoire, l’isolation, les erreurs d’adaptateur, la comparaison, l’extraction, le consentement, le rejet, la pagination, OCR, les erreurs HTTP et les reçus du hub. Les transports sont simulés dans les tests ; ce ne sont pas des captures Screenpipe.

Validation finale du 17 octobre 2026 : **90 tests réussis, 0 échec**, typage et démo valides, archive installée et exécutée dans un projet TypeScript indépendant. Screenpipe 0.4.52 est maintenant sain avec capture et UI recorder actifs. La recherche réelle de la fenêtre `memopipe` a normalisé **15/15 observations accessibility et 15/15 OCR**, avec pagination complète ; une clé invalide est refusée en HTTP 403. La forme réelle `UI.content.id` est prise en charge comme identité de frame.

Le CLI réel `--since 5m --dry-run` termine avec code 0 et aucun envoi ; aucune page Nimbus n’a été retrouvée sur cette période. L’extraction métier réelle et l’adaptateur du serveur restent à valider avec Nimbus. Les 9 tests HTTP autonomes et le parcours complet sur données fictives sont validés. Voir le [rapport d’audit](docs/audit.md).

Commandes de vérification supplémentaires :

```sh
bun run test:integration   # vrais serveurs HTTP loopback, données fictives
bun run test:package       # génération + installation + typage + exécution indépendante
bun run canary:check-screenpipe --cli-auth --window memopipe --since 5m --page-size 2
```

La dernière commande lit uniquement les observations de la fenêtre/période indiquées et imprime les identifiants, dates et longueurs de texte, sans le contenu capturé. Elle utilise `SCREENPIPE_LOCAL_API_KEY` ou, avec `--cli-auth`, le CLI officiel via `bun x screenpipe@latest auth token`, sans persister ni afficher le jeton. `ScreenpipeClient.search(start, end, window, type, limit)` expose la même pagination pour le diagnostic ; l’appelant doit avoir obtenu le consentement pour ce périmètre. Le CLI métier conserve les seuls filtres Nimbus.

Les fixtures sont validées avant le rejeu (format, provenance, période, pages et périmètre), avec déduplication des observations identiques. Les scénarios utilisent strictement les champs du contrat : les champs surnuméraires sont refusés avant l’envoi. Les cas extraits invalides sont signalés sans masquer les autres tickets. Les réponses terminal préchargées sont conservées ; une fin d’entrée avant confirmation provoque une erreur explicite.

Références consultées : [spécification locale](message.txt), [starter et garde-fous réseau](https://github.com/screenpipe/hackathon-starter/blob/main/src/core.ts), [API locale officielle](https://docs.screenpi.pe/cli-reference), [recherche et authentification](https://docs.screenpi.pe/search-screen-history). Les principes loopback, Bearer, timeout et refus des redirections du starter sont réimplémentés ici sans en reprendre le reste de l’application.
