# Validation locale · 17 octobre 2026

Résultat : **90 tests Bun réussis, 0 échec**, TypeScript valide. Aucun commit/push, aucun changement dans `memopipe-serv`, aucune mutation de système externe. Les seules écritures métier sont celles de l’adaptateur mémoire ; les envois du CLI sont testés contre un serveur loopback avec données et jetons fictifs.

## Couverture de la spécification

| Section | Vérification exécutée | Résultat |
| --- | --- | --- |
| §3 | Package TS pur, contrats exportés, installation indépendante | Réussi ; aucun import entre les dépôts |
| §5 | SET, DO, IF/ELSE/END imbriqués, sauts, opérateurs, interpolation, syntaxe et actions invalides | Réussi, sans eval |
| §6 | Validation des scénarios, dates, niveaux, preuves, comparaison exacte, expiration agrégée | Réussi |
| §7 | Auth, consentement, pagination, accessibility/OCR, regroupement, validation/rejet, dry-run, save/replay, erreurs | Réussi sur transport réel et/ou fixtures selon les points ci-dessous |
| §8 | Pas à pas, journal, reprise JSON, isolation ticket/email, idempotence, exécution complète, erreurs | Réussi avec adaptateur mémoire |
| §10 | POST /api/scenarios, Bearer, enveloppe JSON, reçu, refus d’auth, HTTP 503, JSON/reçu invalide, redirection et connexion refusée | Réussi sur mock HTTP loopback |
| §11 | v1 prestataire = 4 écarts ; v2 = aucun écart sur Alice + T-1175 + T-1182 ; extraction des deux tickets | Réussi sur fixtures fictives |

Les routes `/api/runs`, `/api/runs/:id/step`, `/api/runs/:id/finish`, `/api/test-all`, les tables et les interfaces web sont à implémenter par le serveur ; les fonctions correspondantes du moteur sont disponibles et testées. Le mock expose uniquement `/api/scenarios`, l’unique route HTTP appelée par notre CLI. Le parcours moteur utilise directement son interface exportée, comme le fera le hub.

## Screenpipe réel

Screenpipe **0.4.52**, santé `healthy`, `frame_status: ok`, UI recorder `running: true`, mode `full`, capture entrées/événements active. Les identifiants et horodatages individuels des observations réelles sont exclus de cette documentation publique.

Recherche réelle via `ScreenpipeClient.search`, fenêtre du projet, période récente de cinq minutes, page de 2 lignes :

- Accessibility : **15 lignes reçues, 15 normalisées**, 15 identifiants uniques.
- OCR : **15 lignes reçues, 15 normalisées**, mêmes identifiants et horodatages.
- Offsets vérifiés pour chaque recherche : **0, 2, 4, 6, 8, 10, 12, 14, 15**, dernière page vide.
- Aucun identifiant, horodatage individuel ou texte des captures réelles n’est reproduit dans ce rapport.
- Clé volontairement invalide : **HTTP 403**, erreur explicite du connecteur.
- Le jeton valide a été récupéré par le CLI officiel en mémoire, sans écriture dans `.env` et sans affichage.

Le CLI final a été lancé sans fixtures avec `--since 5m --dry-run`. Capture active, **0 demande Nimbus retrouvée**, **0 envoi**, code de sortie **0**. Cela valide la connexion réelle et l’absence de faux scénario ; cela ne valide pas l’extraction métier Nimbus.

## Mock HTTP et parcours autonome

**9 tests HTTP** lancent de vrais serveurs `127.0.0.1` sur ports éphémères, arrêtés à la fin des tests. Le vrai CLI est exécuté en sous-processus.

- Consentement, rejet du premier cas et validation du second : **1 POST**, T-1182 uniquement, jeton et JSON conformes.
- `--dry-run` : **0 requête au hub**, même après validation des deux scénarios.
- Refus de consentement : aucune lecture de fixture ni envoi ; fin d’entrée avant confirmation : échec explicite.
- HTTP 401/503, réponse non JSON, reçu invalide, redirection et refus de connexion : échec, aucun reçu de succès, aucun retry automatique.
- Mock Screenpipe HTTP → fallback OCR paginé → extraction → validation → mock hub → runner mémoire : v1 **[0, 0, 4]**, v2 **[0, 0, 0]**.
- Sauvegarde/rejeu : mêmes scénarios ; écrasement d’une fixture existante refusé.

## Corrections apportées

1. **Normalisation accessibility réelle** : `type: UI`, `content.id` dans Screenpipe 0.4.52, vérifié contre les `frame_id` OCR correspondants. Les IDs audio/input ne sont jamais transformés en frames.
2. **Confirmations CLI** : conservation des lignes préchargées et refus explicite de la fin d’entrée ; aucune approbation implicite.
3. **Champs vides** : un libellé vide ne peut plus absorber la ligne suivante ; un cas invalide n’interrompt plus l’extraction des autres cas valides.
4. **Validation aux frontières** : fixtures/pages/périodes, scénarios/champs autorisés, preuves nulles, ID de ticket et données surnuméraires vérifiés avant upload/action. Validation de tous les scénarios avant `testAll`.
5. **DSL** : une chaîne `"="` n’est plus acceptée à la place du symbole d’affectation.
6. **Erreurs réseau** : diagnostics explicites pour JSON Screenpipe/hub invalide, reçu invalide et livraison non confirmée, sans retry.
7. **Recherche réutilisable** : pagination exportée via `ScreenpipeClient.search`, également utilisée par `history`; déduplication des observations identiques au rejeu.

## Archive et branchement

`bun run test:package` génère `canary-local-0.1.0.tgz`, copie l’archive dans un projet temporaire, l’installe avec `bun add ./canary-local-0.1.0.tgz`, vérifie le typage des imports `@canary/local` et `@canary/local/contracts`, puis exécute les trois scénarios et la reprise pas à pas. Résultats : **[0, 0, 4]** puis **[0, 0, 0]**. Le projet consommateur importe uniquement le paquet installé. Le compilateur utilisé est celui des dépendances de développement du dépôt ; le projet consommateur ne dépend pas des sources du dépôt.

À vérifier dès Nimbus disponible : vrais titres dans `window_name`, libellés et résumés sauvegardés, association email/ticket, extraction réelle de T-1175/T-1182 ; puis adaptateur base de données, isolation/idempotence et routes du hub. Le guide `docs/integration.md` fixe ces contrats.

## Reproduire

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run test:integration
bun run canary:demo
bun run test:package
bun run canary:check-screenpipe --cli-auth --window memopipe --since 5m --page-size 2
bun run canary:analyze --fixtures fixtures/bob.json --dry-run
# Avec SCREENPIPE_LOCAL_API_KEY configuré dans .env :
bun run canary:analyze --since 5m --dry-run
# Après traitement réel des tickets Nimbus, avant tout envoi :
bun run canary:analyze --since 24h --dry-run --save local-data/bob-real.json
```

La suite HTTP nécessite l’autorisation d’écouter/contacter loopback. Dans Codex, elle a été exécutée hors sandbox réseau. Aucun secret ni vrai enregistrement n’est nécessaire pour `bun test`, la démo ou l’installation du package.
