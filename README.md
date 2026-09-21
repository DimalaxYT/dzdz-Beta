# DropQR 2.0

Transfert temporaire de fichiers entre appareils : un **code court**, un **QR code**, et le fichier
disparaît à l'expiration ou après le premier téléchargement.

La version 2 a été écrite pour **tourner sur Netlify gratuitement**. C'est possible parce que les
octets ne traversent jamais la fonction serverless : le navigateur envoie le fichier directement dans
un stockage objet compatible S3 (Cloudflare R2 par exemple), et la fonction ne valide que les
métadonnées.

```
Navigateur ──(1) demande une autorisation──► Fonction Netlify
     │                                            │
     │                                            └── prépare les métadonnées
     │
     └──(2) envoie les octets directement───► Stockage objet R2 / S3
                                                  │
                                    (3) la fonction valide, l'objet est prêt
```

Pourquoi c'est nécessaire : **une fonction Netlify n'accepte que 6 Mo par requête** (≈ 4,5 Mo en
binaire) et 20 Mo en réponse. Un serveur Express classique ne peut donc pas recevoir un fichier de
2 Go sur Netlify — mais une URL pré-signée, si.

## Les deux modes

| | Netlify (recommandé, gratuit) | Serveur Node |
| --- | --- | --- |
| Pages | Fonction serverless (rendu à la volée) | Même code, servies localement |
| Octets | Stockage objet S3/R2 via URL pré-signées | Disque de la machine |
| Métadonnées | Netlify Blobs (cohérence forte) | Fichiers JSON sur disque |
| Hôte | Netlify | localhost, VPS, Railway, Render |

Le même `lib/app.mjs` sert de routeur dans les deux cas : aucun comportement divergent.

## Démarrage local

```bash
npm install
npm start
# http://localhost:3000
```

Sans aucune variable : stockage sur disque, tout fonctionne. Pour tester depuis un téléphone sur le
même Wi-Fi :

```bash
PUBLIC_URL="http://192.168.1.25:3000" npm start
```

## Déploiement sur Netlify (pas à pas)

### 1. Créer le compartiment de stockage

Cloudflare R2 : compte gratuit, **10 Go** de stockage et **aucun frais de sortie**.

1. Crée un bucket, par exemple `dropqr`.
2. Dans « Manage R2 API Tokens », crée un jeton avec les droits **Object Read & Write** sur ce bucket.
3. Note trois valeurs : l'identifiant de compte, l'`Access Key ID` et le `Secret Access Key`.

### 2. Ajouter les variables sur Netlify

`Site configuration` → `Environment variables` :

| Variable | Exemple | Rôle |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | `a1b2c3d4e5f6` | construit l'URL de stockage |
| `S3_BUCKET` | `dropqr` | nom du compartiment |
| `S3_ACCESS_KEY_ID` | `8f3a...` | jeton R2 |
| `S3_SECRET_ACCESS_KEY` | `1c9d...` | secret du jeton |
| `PUBLIC_URL` | `https://mon-dropqr.netlify.app` | utilisé pour les liens et le QR |
| `CRON_SECRET` | chaîne aléatoire | protège la route de nettoyage manuel |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/...` | notification optionnelle |
| `MAX_FILE_SIZE` | `2gb` | limite par transfert (défaut 2 Go) |
| `MAX_TTL_MINUTES` | `1440` | durée de vie maximale |

Puis relance un déploiement.

### 3. Autoriser le navigateur (CORS sur R2)

Sans cela, le navigateur bloquera l'envoi direct. Dans les réglages du bucket R2 :

```json
[
  {
    "AllowedOrigins": ["https://mon-dropqr.netlify.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ETag` doit être exposé : c'est ce qui permet d'assembler les morceaux d'un gros fichier. Si tu ne peux
pas l'exposer, l'application demande les ETag au stockage à la place (secours automatique).

### 4. Vérifier

Ouvre `/api/health`. La réponse attendue :

```json
{
  "ok": true,
  "version": "2.0.0",
  "storage": "s3",
  "metadata": "blobs",
  "directUpload": true
}
```

Puis envoie un fichier de test. S'il dépasse la taille d'un morceau, l'envoi passe automatiquement en
multipart avec plusieurs flux parallèles.

### Ce que Netlify exécute

- `netlify/functions/api.mjs` : toutes les routes dynamiques (`/`, `/upload`, `/api/*`, `/r/:id`, …).
- `netlify/functions/purge.mjs` : tâche planifiée toutes les 15 minutes (suppression des fichiers
  expirés, des envois abandonnés et des messages Discord échus).
- `public/` : fichiers statiques (CSS, JavaScript, images) servis par le CDN.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DROPQR_STORAGE` | `auto` | `s3`, `local` ou `auto` (détection) |
| `DROPQR_META` | `auto` | `blobs`, `local` ou `auto` |
| `S3_ENDPOINT` | déduit de `R2_ACCOUNT_ID` | compatible MinIO, B2, AWS |
| `S3_REGION` | `auto` | région de signature |
| `S3_FORCE_PATH_STYLE` | `true` | style d'URL (`/bucket/cle`) |
| `S3_PREFIX` | `dropqr` | préfixe des objets |
| `PART_SIZE_MB` | `8` | taille d'un morceau (multipart) |
| `UPLOAD_CONCURRENCY` | `3` | envois simultanés |
| `DEFAULT_TTL_MINUTES` | `30` | durée de vie par défaut |
| `MAX_TTL_MINUTES` | `1440` | durée de vie maximale |
| `MAX_FILE_SIZE` | `2gb` | limite par transfert (`0` = illimité) |
| `PUBLIC_URL` | déduite | URL publique du site |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | serveur Node |
| `CRON_SECRET` | vide | protection de `POST /api/purge` |

## API

| Route | Rôle |
| --- | --- |
| `GET /api/health` | état, mode de stockage, limites |
| `GET /api/config` | configuration publique du front |
| `POST /api/transfers` | crée un transfert et renvoie le plan d'envoi |
| `POST /api/transfers/:id/parts` | URL pré-signées des morceaux |
| `POST /api/transfers/:id/complete` | valide et marque le transfert comme prêt |
| `GET /api/codes/:code` | recherche par code |
| `GET /api/transfers/:id` | métadonnées publiques |
| `DELETE /api/transfers/:id` | suppression (clé privée requise) |
| `GET /r/:id` | page de téléchargement (QR) |
| `GET /asset/:id` · `GET /download/:id` | lecture / téléchargement |
| `POST /api/notify/discord` | envoi de la notification (clé privée requise) |
| `POST /api/purge` | nettoyage manuel (`x-cron-secret`) |

## Sécurité

- Clé de suppression privée par transfert, stockée sous forme de condensat SHA-256 et comparée en temps
  constant.
- Contenus exécutables (`.html`, `.svg`, `.js`) servis en **pièce jointe** avec
  `application/octet-stream` : jamais exécutés sur l'origine du site.
- CSP stricte, `nosniff`, `frame-ancestors 'self'`, `object-src 'none'`.
- URL de lecture pré-signées à durée limitée : les liens ne sont pas devinables.
- Limite de débit par IP sur la création de transferts et la recherche de codes.
- Les noms de fichiers sont nettoyés, les identifiants tirés de façon cryptographique.
- Suppression après téléchargement : effective dès la fin du flux (mode serveur) ou via une fenêtre de
  grâce de 20 minutes (mode objet), pour ne pas couper un gros transfert en cours.

## Interface

Direction artistique « papier, cuivre, jade » : typographie Fraunces + Outfit, thème clair/sombre
automatique avec bascule manuelle, images générées (aucun texte dans les visuels), **aucun emoji**
(les pictogrammes sont des SVG dessinés à la main).

Widgets : anneau et barre de progression avec débit réel, courbe de vitesse, QR vectoriel animé, code
à sept cases, compte à rebours jours/heures/minutes/secondes, toasts, accordéon, statistiques animées.

Animations : apparition au défilement, inclinaison des cartes, parallaxe (images et fonds), bandeau
défilant, compteurs. Tout se désactive si le système demande de réduire les animations.

## Tests

```bash
npm run check      # analyse syntaxique de tous les fichiers
npm test           # 82 vérifications : pages, sécurité, cycle complet, expiration, débit, SigV4
npm run test:s3    # nécessite : npm install --no-save s3rver
```

`npm test` ne demande aucune dépendance supplémentaire. `npm run test:s3` fait tourner un faux serveur
S3 pour valider la chaîne multipart et les redirections, et revérifie les signatures SigV4 à partir de
la spécification AWS.

## Dépannage

**« Page not found » ou 404 sur `/api/...`**
Vérifie que `netlify.toml` pointe bien `publish = "public"` et `functions = "netlify/functions"`, puis
relance un déploiement complet (pas seulement un « Deploy site » sans build).

**L'envoi démarre puis échoue immédiatement**
C'est presque toujours le CORS du stockage : origine autorisée en `GET`, `PUT`, `HEAD`, et `ETag`
exposé. L'interface affiche un message explicite dans ce cas.

**Un gros fichier s'arrête en cours de route**
Réduis `PART_SIZE_MB` à 5 et `UPLOAD_CONCURRENCY` à 2. Les morceaux déjà envoyés sont conservés lors
d'un nouvel essai.

**Le QR ne s'ouvre pas depuis le téléphone**
`PUBLIC_URL` doit être l'URL publique réelle. En local, utilise l'IP du PC, jamais `localhost`.

**« Missing Traffic Access Token » dans l'aperçu Arena/e2b**
La plateforme de prévisualisation protège les URL par jeton : un téléphone externe ne peut pas ouvrir
le lien. Déploie le site ou teste en local avec `PUBLIC_URL`.

## Structure

```
lib/
  params.mjs      configuration et détection du mode
  s3.mjs          client S3 minimal (signature SigV4, multipart) — sans dépendance
  store.mjs       métadonnées : Netlify Blobs ou disque (écritures atomiques)
  transfers.mjs   logique métier : codes, expiration, suppression, Discord
  qr.mjs          QR en SVG (page) et PNG (Discord)
  layout.mjs      enveloppe HTML, navigation, icônes SVG
  views.mjs       pages rendues à la volée
  app.mjs         routeur unique (Request/Response)
netlify/functions/
  api.mjs         point d'entrée des routes dynamiques
  purge.mjs       tâche planifiée
public/           CSS, JavaScript, images, favicon
server.js         serveur Node autonome (même routeur)
scripts/          suites de tests
```
