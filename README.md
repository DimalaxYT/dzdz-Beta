# DropQR

DropQR est un site multi-pages pour transférer temporairement des fichiers entre appareils avec un QR code.

## Pages

- `/` : accueil — transfert immédiat sur mobile, ambiance WebGL sur ordinateur
- `/upload` : création d’un transfert avec barre de progression
- `/receive` : recherche d’un transfert par code
- `/dashboard` : transferts créés depuis le navigateur, avec suppression manuelle par clé privée
- `/help` : aide, déploiement et explication du QR code dans la preview Arena
- `/mentions` : mentions légales, confidentialité et données traitées
- `/d/:id` : page de réception dédiée, utilisable sans JavaScript
- `/t/:id`, `/share/:id`, `/c/:code` : anciens liens toujours compatibles

## Expérience mobile et design commun

- **Envoyer et Recevoir restent visibles en haut**, avec un menu compact pour l’aide, les transferts, les mentions et la connexion Discord facultative.
- `public/assets/landing.css` habille toutes les pages : ambiance sombre de la landing sur ordinateur, papier chaud / encre / lime et parcours tactile sur téléphone. `app.css` ne contient qu’un import de compatibilité.
- `experience.js` détecte les téléphones, tablettes tactiles et fenêtres étroites (y compris en paysage). La 3D est également désactivée avec `prefers-reduced-motion`, l’économie de données ou une mémoire déclarée faible. La taille de la fenêtre seule n’identifie pas un téléphone.
- Sur mobile, **ni Three.js ni le générateur QR décoratif ne sont téléchargés**. Sur ordinateur, `landing.js` charge la scène à la demande, après l’interface. `/?3d=0` force le mode plat ; `/?3d=1` permet un essai explicite en 3D, sans ignorer la préférence de mouvement réduit.
- `upload.js` est le contrôleur commun de l’accueil et de `/upload` : photo via le sélecteur système, aperçu local, morceaux parallèles, nouvelles tentatives, annulation et retour d’erreur. L’accueil envoie dès la sélection ; `/upload` permet une confirmation préalable. Les options de durée sont alignées sur `/api/config`.
- Après l’envoi : **QR SVG à quatre modules de marge**, code, copie, partage natif avec repli vers la copie, téléchargement du QR et suppression manuelle. Le PNG reste dans l’API pour compatibilité. Aucun téléchargement de fichier n’est lancé par l’affichage du QR ou par la navigation.
- La réception `/d/:id` est rendue par le serveur. Le nom, la taille et le bouton Télécharger précèdent tout aperçu vidéo. Les anciens liens et la recherche par code restent pris en charge.
- L’historique et les clés de suppression sont conservés dans le navigateur. Les informations de confidentialité reflètent ce fonctionnement et l’usage facultatif de Discord.

Les écrans utilisent les assets locaux, sans police ni moteur graphique externe. Le partage natif dépend du navigateur, de HTTPS et des autorisations de l’éventuelle iframe ; l’annulation de la feuille de partage n’est pas une erreur. « Prendre une photo » ouvre le sélecteur natif (`capture=environment`) : le choix précis dépend du système du téléphone.

### Vérification

```bash
npm ci
npm run check
npx playwright install chromium
npm test
```

Les tests démarrent leur propre serveur sur le port **3100**, avec le stockage isolé dans `storage/e2e` (ignoré par Git), une limite de 2 Mo et des morceaux de 1 Mo. Ils couvrent les largeurs 320 / 375 / 390 / 430 px, le paysage, la sélection de caméra, l’annulation, les erreurs, le partage, les transferts réels, le décodage du QR, la navigation répétée, la réception sans JS et un contrôle automatisé WCAG AA via axe. Un navigateur système peut être indiqué avec `CHROMIUM_EXECUTABLE=/chemin/vers/chromium npm test`. L’audit automatisé ne remplace pas une vérification avec lecteur d’écran et de vrais téléphones.

## Backend

Backend Node.js/Express avec :

- upload classique avec Multer vers le disque local ;
- upload par morceaux en trois temps : session créée par `POST /api/transfers/chunk/init` (le serveur valide taille totale, taille des morceaux et nombre de morceaux, puis retourne un secret), envoi des morceaux sur `/api/transfers/chunk`, assemblage sur `/api/transfers/complete` ;
- chaque morceau doit avoir exactement la taille attendue par la session : impossible de contourner la limite de taille déclarée ;
- génération de QR code ;
- métadonnées dans `storage/db.json` ;
- suppression après premier téléchargement si activée ;
- suppression automatique à expiration ;
- suppression manuelle via clé privée retournée à l’upload (visible dans le tableau de bord `/dashboard`) ;
- tâche de nettoyage toutes les minutes ;
- limites de débit différenciées : API générale (120 req/min), uploads classiques (2000 req/heure), morceaux (6000 req/10 min par défaut) avec en-tête `Retry-After` ;
- en-têtes de sécurité : CSP stricte same-origin, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ; CORS désactivé par défaut (same-origin), activable via `CORS_ORIGINS`.

## Démarrage

```bash
npm install
npm start
```

Ouvre ensuite :

```txt
http://localhost:3000
```

Le port vient de la variable `PORT` si elle est définie (Render, Railway, etc. l'injectent automatiquement), sinon 3000 par défaut :

```bash
PORT=8080 npm start
```

## Tester avec un téléphone sur le même Wi‑Fi

Ne mets pas `localhost` dans le QR code, car `localhost` sur le téléphone pointe vers le téléphone lui-même.

Utilise l’IP locale du PC :

```bash
PUBLIC_URL="http://192.168.1.25:3000" npm start
```

Puis ouvre `http://192.168.1.25:3000` sur le téléphone.

## Déploiement Netlify : attention

Si tu as mis le ZIP complet sur Netlify en Drag & Drop et que tu vois une page `Page not found`, c’est parce que Netlify sert du statique et ne lance pas `server.js`.

DropQR a besoin d’un backend Node.js pour recevoir les fichiers, générer les QR codes, servir les téléchargements et supprimer automatiquement les documents. Pour la version complète, utilise plutôt Render, Railway, Fly.io ou un VPS.

J’ai quand même ajouté `netlify.toml`, `public/_redirects` et une page d’explication pour éviter le 404 si tu testes en statique, mais l’upload ne fonctionnera pas sans backend.

## Important pour la preview Arena/e2b

La preview Arena/e2b peut bloquer les accès directs depuis un téléphone avec l’erreur :

```txt
Missing Traffic Access Token
```

C’est normal dans cette preview : la plateforme demande un header `e2b-traffic-access-token` que le téléphone n’a pas quand il scanne le QR code.

Pour un vrai scan QR depuis téléphone, il faut :

1. lancer le site sur ton réseau local avec `PUBLIC_URL=http://IP_DU_PC:3000`, ou
2. déployer le site sur un domaine public HTTPS.

## Render : empêcher la mise en veille (keep-alive)

Le plan gratuit de Render endort le service après ~15 minutes sans trafic entrant : le premier chargement suivant met alors 30 à 60 secondes.

DropQR intègre un keep-alive automatique : dès qu'une URL publique est connue (`PUBLIC_URL`, ou `KEEP_ALIVE_URL` si tu veux viser autre chose), le serveur appelle lui-même `URL/api/health` toutes les `KEEP_ALIVE_INTERVAL_MINUTES` (10 par défaut, borné à 14 max pour rester sous le seuil des 15 minutes). Ce trafic entrant suffit à garder le service éveillé.

Pourquoi ce timing : Render endort le service après ~15 minutes sans trafic entrant, donc 10 minutes laisse une marge de 5 minutes. Il est inutile de pinger plus vite : chaque ping est une requête minuscule et le compteur de veille est réinitialisé à chaque requête.

Le scheduler est adaptatif :

- **succès** → prochain ping dans `KEEP_ALIVE_INTERVAL_MINUTES` ;
- **échec** (redéploiement, cold start, coupure réseau) → nouvelle tentative après `KEEP_ALIVE_RETRY_SECONDS` (60 s par défaut), délai qui croît à chaque échec jusqu'à l'intervalle normal — pour ne jamais laisser 15 minutes de silence ;
- **5 échecs d'affilée** (`KEEP_ALIVE_ALERT_AFTER_FAILURES`) → alerte sur le webhook Discord (maximum 1/heure).

⚠️ Limite importante : le keep-alive **prévient** la veille, il ne peut pas en **sortir**. Si le service est déjà endormi (ou en panne), son minuteur meurt avec lui. Pour être réveillé même dans ce cas, ajoute un ping externe gratuit (UptimeRobot, cron-job.org…) sur `https://ton-site.onrender.com/api/health` toutes les 5 minutes — l'alerte Discord te préviendra si les pings internes échouent en chaîne.

Autre limite du plan gratuit : 750 heures/mois au total, soit ~744 h pour un service gardé éveillé 24/7 — ça passe pour un seul service.

```env
PUBLIC_URL=https://ton-site.onrender.com
# KEEP_ALIVE=false                 # pour désactiver
# KEEP_ALIVE_INTERVAL_MINUTES=10   # intervalle du ping
```

Vérifie l'état du keep-alive dans `GET /api/health` (champ `keepAlive`) :

```json
{
  "keepAlive": { "enabled": true, "intervalMinutes": 10, "target": "https://ton-site.onrender.com/api/health" }
}
```

Note : Render met à jour son offre régulièrement ; si le keep-alive ne suffit plus un jour, un service de monitoring externe (UptimeRobot, cron-job.org…) qui appelle `/api/health` reste une alternative équivalente.

## Taille des fichiers

Par défaut, DropQR accepte jusqu’à 10 Go par transfert côté application. La capacité réelle dépend toutefois du disque Render, du proxy, du navigateur et du temps de connexion.

Depuis la version 1.5.0, l’interface envoie les fichiers par morceaux configurables. Ça évite les erreurs fréquentes de plateforme liées aux gros fichiers, comme ton HTTP 400 sur un fichier de 51,7 Mo.

Après déploiement, vérifie absolument :

```txt
https://ton-site.com/api/health
```

La réponse doit contenir :

```json
{
  "version": "1.11.0",
  "chunkedUpload": true,
  "chunkInit": true
}
```

Si `/api/health` ne contient pas ça, ton frontend est à jour mais ton backend ne l’est pas, ou tu as déployé en statique.

Les limites restantes peuvent venir :

- du disque serveur ;
- de l’hébergeur ;
- de Nginx/Apache/Cloudflare ;
- du navigateur ;
- du temps de connexion.

Si tu veux réactiver une limite applicative :

```bash
MAX_FILE_SIZE=2gb npm start
# ou
MAX_FILE_SIZE_MB=2048 npm start
```

## Variables d’environnement

Un modèle sans secret est disponible dans `.env.example`. Pour le charger localement avec Node.js 20.6 ou plus récent :

```bash
cp .env.example .env
node --env-file=.env server.js
```

Avec Node.js 18, exporte les variables dans le shell ou configure-les dans ton hébergeur. `npm start` ne charge pas automatiquement `.env`. Ne versionne jamais les tokens ni les secrets Discord.

| Variable | Défaut | Rôle |
| --- | ---: | --- |
| `PORT` | `3000` | Port HTTP (obligatoire derrière Render/Railway, qui l'injectent) |
| `HOST` | `0.0.0.0` | Adresse d’écoute |
| `STORAGE_DIR` | `storage/` | Dossier local contenant fichiers et métadonnées ; permet un stockage de test séparé |
| `TRUST_PROXY` | `1` | Nombre de reverse proxies de confiance (`false` pour désactiver, `2`… pour enchaîner) |
| `CORS_ORIGINS` | vide | Origines autorisées pour l'API, séparées par des virgules (`*` pour tout autoriser — déconseillé) ; vide = same-origin uniquement |
| `CHUNK_RATE_LIMIT` | `6000` | Nombre maximal de requêtes morceaux par IP par fenêtre de 10 minutes |
| `PUBLIC_URL` | vide | URL mise dans le QR code (sert aussi d'URL de keep-alive) |
| `KEEP_ALIVE` | `true` | Auto-ping anti-veille Render (`false` pour désactiver) |
| `KEEP_ALIVE_URL` | vide | URL pingée par le keep-alive (défaut : `PUBLIC_URL`) |
| `KEEP_ALIVE_INTERVAL_MINUTES` | `10` | Intervalle du keep-alive, borné entre 1 et 14 minutes |
| `KEEP_ALIVE_RETRY_SECONDS` | `60` | Délai de nouvelle tentative après un échec (croît jusqu’à l’intervalle normal) |
| `KEEP_ALIVE_ALERT_AFTER_FAILURES` | `5` | Échecs d’affilée avant alerte Discord (1/heure max) |
| `MAX_FILE_SIZE` | vide | Limite optionnelle, ex: `2gb`, `500mb` |
| `MAX_FILE_SIZE_MB` | vide | Limite optionnelle en Mo |
| `DEFAULT_TTL_MINUTES` | `15` | Durée par défaut |
| `MAX_TTL_MINUTES` | `1440` | Durée max autorisée |
| `CHUNK_SIZE_MB` | `16` | Taille recommandée d’un morceau, plafonnée à 256 Mo |
| `UPLOAD_CONCURRENCY` | `5` | Nombre maximal de morceaux envoyés en parallèle |
| `DISCORD_CONTACT_URL` | vide | Lien Discord de secours affiché dans le footer |
| `DISCORD_INVITE_CHANNEL_ID` | vide | Salon utilisé par la rotation d’invitations |
| `DISCORD_INVITE_REFRESH_HOURS` | `24` | Intervalle de rotation du lien Discord |
| `DISCORD_HEARTBEAT` | `true` | Embed de statut Discord au démarrage + périodique (`false` pour couper) |
| `DISCORD_HEARTBEAT_HOURS` | `24` | Intervalle du heartbeat Discord (1 à 168 h) |
| `DISCORD_CLIENT_ID` | vide | Identifiant OAuth2 de l'application Discord (connexion des visiteurs) |
| `DISCORD_CLIENT_SECRET` | vide | Secret OAuth2 de l'application Discord (jamais côté client) |
| `DISCORD_SESSION_DAYS` | `30` | Durée de la session « connecté avec Discord » (1 à 90 jours) |
| `DISCORD_AUTHORIZE_URL` | `{DISCORD_API_BASE_URL}/oauth2/authorize` | (Optionnel) URL d'autorisation montrée au navigateur si elle diffère de l'API appelée par le serveur (proxy, démo) |

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/stats`
- `POST /api/transfers` (upload classique, multipart)
- `POST /api/transfers/chunk/init` (crée la session d'upload, retourne `uploadId` + `uploadSecret`)
- `POST /api/transfers/chunk` (envoie un morceau : `uploadId`, `uploadSecret`, `chunkIndex`, `chunk`)
- `POST /api/transfers/complete` (assemble le fichier : `uploadId` + `uploadSecret`)
- `GET /api/transfers/:id`
- `DELETE /api/transfers/:id` (en-tête `X-Delete-Key`)
- `GET /api/codes/:code`
- `GET /d/:id` (réception sans JavaScript)
- `GET /t/:id` (compatibilité)
- `GET /view/:id` (lecture vidéo, support des requêtes `Range`)
- `GET /download/:id`

## Stockage externe

Pour une version production plus robuste, branche un stockage S3-compatible comme Cloudflare R2, Backblaze B2 ou AWS S3.

Je déconseille TeraBox comme backend applicatif : l’API n’est pas pensée comme stockage temporaire stable de type S3, et les scripts tiers peuvent nécessiter des cookies/session.

## Envoi Discord du code + QR code

DropQR peut envoyer automatiquement un message Discord après chaque upload.

Le plus simple n’est pas un vrai bot avec token, mais un **webhook Discord** : il poste dans un salon comme un bot, sans garder un token sensible de bot.

### Configuration

Dans Discord :

1. Va dans le salon voulu.
2. `Modifier le salon` → `Intégrations` → `Webhooks`.
3. Crée un webhook nommé `DropQR`.
4. Copie l’URL du webhook.
5. Ajoute-la dans les variables d’environnement de ton hébergeur :

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_USERNAME=DropQR
# Optionnel : mentionner quelqu’un ou un rôle
# DISCORD_MENTION=<@123456789>
# DISCORD_MENTION=<@&123456789>
```

Après redéploiement, `GET /api/health` doit afficher :

```json
{
  "discordConfigured": true
}
```

À chaque upload, Discord reçoit :

- le code court du transfert ;
- le lien ;
- le QR code en image ;
- le nom du fichier ;
- la taille ;
- l’expiration.

Ne colle jamais un token de bot Discord directement dans le chat.

### Rotation quotidienne du lien de contact

DropQR peut aussi actualiser automatiquement le lien de contact Discord. Le serveur crée une invitation classique dans le salon indiqué au démarrage puis la renouvelle selon `DISCORD_INVITE_REFRESH_HOURS`. Le lien public apparaît alors dans le footer du site.

Une URL personnalisée comme `discord.gg/nom` dépend des avantages du serveur Discord et ne peut pas être créée par un bot. Une invitation classique fonctionne sans Nitro, si le bot possède la permission de créer des invitations dans le salon choisi.

Variables Render :

```env
DISCORD_BOT_TOKEN=token_du_bot
DISCORD_INVITE_CHANNEL_ID=id_du_salon
DISCORD_INVITE_REFRESH_HOURS=24
# Facultatif : lien de secours si le bot n’est pas activé
DISCORD_CONTACT_URL=https://discord.gg/ton-invitation
```

Le token reste uniquement dans les variables secrètes de Render. Ne le committe jamais et ne le colle jamais dans le chat. Si le bot n’est pas configuré, le contact légal reste `ano1by` sur Discord et aucun lien automatique n’est affiché.

### Connexion Discord des visiteurs (OAuth2)

DropQR affiche un bouton **Discord** dans la barre de navigation : le visiteur se connecte avec son compte Discord (scope `identify` uniquement — le site ne peut rien publier à sa place), puis :

- à la **première connexion** d'un compte, le webhook staff reçoit « Nouvelle connexion Discord » avec pseudo, ID et avatar (l'utilisateur est répertorié dans `storage/db.json`) ;
- à **chaque envoi de fichier**, l'embed Discord du transfert indique **quel compte** l'a envoyé (`Envoyé par` + avatar) — sinon le transfert est marqué « Anonyme » ;
- la session dure `DISCORD_SESSION_DAYS` (30 jours par défaut), cookie `HttpOnly` opaque ; déconnexion via le « × » à côté du pseudo.

Configuration dans le [portail développeur Discord](https://discord.com/developers/applications) :

1. `New Application` → nomme-la (ex. `DropQR`).
2. Onglet **OAuth2** → `Add Redirect` : `https://ton-site.onrender.com/api/auth/discord/callback` (adapte le domaine ; un redirect par environnement).
3. Copie le **Client ID** et régénère le **Client Secret**, puis ajoute les variables :

```env
DISCORD_CLIENT_ID=1234567890123456789
DISCORD_CLIENT_SECRET=ton_secret
```

4. Redéploie : le bouton Discord apparaît automatiquement dans la navigation (il reste caché tant que `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` ne sont pas configurés).

En cas de problème : `GET /api/auth/me` indique si la fonction est active (`configured: true`) et qui est connecté. Le jeton Discord n'est jamais stocké ni exposé au navigateur — seul un identifiant de session opaque circule dans le cookie.

### Heartbeat de statut et alertes keep-alive

Quand le webhook Discord est configuré, DropQR envoie aussi :

- un **embed de statut au démarrage**, puis toutes les `DISCORD_HEARTBEAT_HOURS` (24 h par défaut) : version, uptime, transferts actifs, stockage utilisé, santé du keep-alive — pratique pour confirmer d’un coup d’œil que le site est en ligne ;
- une **alerte ⚠️** si le keep-alive échoue en chaîne (`KEEP_ALIVE_ALERT_AFTER_FAILURES`, maximum 1/heure) ;
- une **confirmation ✅ de rétablissement** quand les pings redeviennent bons après une alerte.

```env
# DISCORD_HEARTBEAT=false        # pour désactiver le heartbeat
# DISCORD_HEARTBEAT_HOURS=24     # intervalle du message de statut
```

## Version 1.5.0

Changements principaux :

- le QR code pointe maintenant vers `/receive?code=...` au lieu d’un lien technique ;
- si `PUBLIC_URL` est saisi sans `https://`, DropQR ajoute automatiquement `https://` ;
- la page `/receive` permet d’entrer un code et affiche les informations du fichier avant téléchargement ;
- le message Discord est supprimé automatiquement à l’expiration du transfert, ou si le fichier est supprimé avant ;
- upload en parallèle (`UPLOAD_CONCURRENCY`) au lieu d’un morceau après l’autre, avec assemblage serveur en streaming ;
- interface simplifiée, plus sobre, plus rapide au scroll.

Après déploiement Railway, vérifie `/api/health` : la réponse doit contenir la version courante et `chunkedUpload: true`.

## Version 1.6.0

Support vidéo :

- les vidéos peuvent être envoyées comme les autres fichiers ;
- la page `/receive` affiche un lecteur vidéo si le fichier reçu est une vidéo ;
- nouvelle route `GET /view/:id` pour lire les vidéos dans le navigateur ;
- support des requêtes `Range`, indispensable pour avancer dans une vidéo sans tout télécharger ;
- le bouton de téléchargement reste disponible pour récupérer le fichier original.


## Version 1.8.0

Améliorations demandées :

- limite applicative par défaut fixée à **10 Go** par transfert ;
- upload plus agressif par défaut : `CHUNK_SIZE_MB=16` et `UPLOAD_CONCURRENCY=5` ;
- moins de scans disque pendant l’upload : les morceaux sont finalisés par une route dédiée ;
- interface retravaillée pour être plus propre, moins “IA”, plus produit ;
- cartes visuelles sur l’accueil, page Envoyer plus claire, indications 10 Go / upload parallèle / vidéos.

Variables utiles sur Railway :

```env
MAX_FILE_SIZE=10gb
CHUNK_SIZE_MB=16
UPLOAD_CONCURRENCY=5
```

Si Railway ou le réseau montre des erreurs pendant l’upload, réduis progressivement :

```env
CHUNK_SIZE_MB=8
UPLOAD_CONCURRENCY=4
```

## Version 1.9.0

Correctifs de fiabilité et de sécurité :

- **déploiement** : le serveur respecte maintenant `PORT` (il était codé en dur à `3001`, ce qui pouvait empêcher Render/Railway de démarrer) ; valeur par défaut locale : `3000` ;
- **téléchargement** : le préchargement PJAX ne touche plus jamais `/download`, `/view` ni les pages de partage — un téléchargement ne peut plus se déclencher (ni supprimer un fichier à usage unique) avant le clic ;
- **upload par morceaux** : nouvelle session serveur (`/api/transfers/chunk/init`) avec secret d’upload ; chaque morceau doit avoir exactement la taille attendue, ce qui rend impossible le contournement de la limite de taille ou le remplissage du disque ;
- **limites de débit** : les routes de morceaux ont leur propre limiteur (6000/10 min, `CHUNK_RATE_LIMIT`) au lieu de la limite API de 120/min qui cassait les gros uploads ; le client réessaie automatiquement en respectant `Retry-After` ;
- **tableau de bord** : nouvelle page `/dashboard` listant les transferts créés depuis le navigateur, avec leur clé de suppression et une suppression manuelle en un clic (la clé était retournée par l’API mais jamais affichée) ;
- **sécurité** : CSP same-origin, `Referrer-Policy`, `Permissions-Policy` réactivés ; CORS `*` supprimé par défaut (allowlist `CORS_ORIGINS`) ;
- **robustesse** : enregistrement du transfert seulement après génération complète de la réponse ; suppression après téléchargement vérifiée ; avertissement preview Arena présent dans `/api/config` ;
- **interface** : fini les doubles initialisations et les fuites d’écouteurs après navigation PJAX, cache de navigation corrigé ;
- **Render** : keep-alive intégré — le serveur ping automatiquement `PUBLIC_URL/api/health` toutes les 10 minutes pour éviter la mise en veille du plan gratuit, avec reprise rapide après échec et alerte Discord en cas d’échecs en chaîne (`KEEP_ALIVE`, `KEEP_ALIVE_URL`, `KEEP_ALIVE_INTERVAL_MINUTES`, `KEEP_ALIVE_RETRY_SECONDS`, `KEEP_ALIVE_ALERT_AFTER_FAILURES`).

Après redéploiement, vérifie :

```json
GET /api/health
{
  "version": "1.11.0",
  "chunkedUpload": true,
  "chunkInit": true
}
```

## Version 1.10.0

Améliorations du bot / du keep-alive :

- **scheduler adaptatif** : après un ping en échec, nouvelle tentative rapide (`KEEP_ALIVE_RETRY_SECONDS`, 60 s par défaut, délai progressif plafonné à l’intervalle normal) au lieu d’attendre le prochain cycle de 10 minutes ;
- **alerte Discord ⚠️** après 5 échecs d’affilée (`KEEP_ALIVE_ALERT_AFTER_FAILURES`), anti-spam 1/heure ;
- **confirmation ✅ de rétablissement** sur Discord dès que le site répond de nouveau après une alerte ;
- **heartbeat Discord** : embed de statut au démarrage puis toutes les `DISCORD_HEARTBEAT_HOURS` (24 h par défaut) avec version, uptime, transferts actifs, stockage et état du keep-alive ;
- `/api/health` expose les compteurs du keep-alive (`stats.total`, `stats.ok`, `consecutiveFailures`) et l’état du heartbeat (`discordHeartbeat`).

## Version 1.11.0

Connexion Discord des visiteurs :

- bouton **Discord** dans la barre de navigation (OAuth2 `identify`, session cookie `HttpOnly` de 30 jours) ;
- chaque visiteur connecté est **répertorié** : première connexion ⇒ notification staff avec pseudo/ID/avatar, profil et compteur d’envois conservés dans `storage/db.json` ;
- les notifications d’upload indiquent désormais **quel compte Discord a envoyé le fichier** (`Envoyé par` + avatar, embed teinté blurple), ou « Anonyme » sinon ;
- déconnexion en un clic ; sessions expirées purgées par la tâche de nettoyage ;
- endpoints : `GET /api/auth/me`, `GET /api/auth/discord/login`, `GET /api/auth/discord/callback`, `POST /api/auth/logout` ;
- configuration : `DISCORD_CLIENT_ID` + `DISCORD_CLIENT_SECRET` (+ redirect `…/api/auth/discord/callback` dans le portail développeur Discord).

## Version 1.12.0 — lancement initial de la 3D

Les notes ci-dessous décrivent le lancement initial. La refonte mobile et le design commun documentés en début de README remplacent son ancien contrôleur d’upload et sa stratégie mobile.

Nouvelle page d'accueil : **expérience WebGL 3D immersive** (`/`) :

- scène Three.js temps réel dans un espace numérique sombre : fichiers flottants en profondeur, particules réactives au curseur, filaments lumineux, brouillard subtil, parallaxe souris multi-couches ;
- **parcours au scroll en 3 chapitres** pilotant la caméra : *DROP* (les fichiers tombent et convergent vers le portail), *SHARE* (le lien devient un fil de données entre deux appareils), *SCAN* (approche d'un QR géant balayé par une ligne de scan) — la typographie géante est intégrée dans la scène ;
- **Drop Zone 3D réellement fonctionnelle** : glisser-déposer (ou clic) envoie le fichier sur `POST /api/transfers`, avec anneau de progression, puis **métamorphose du fichier en QR de particules** et panneau « Ready to share » (lien réel + boutons *Copy link* / *Download QR*) ;
- quatre mini-scènes 3D pour les features (*Unlimited*, *Fast*, *Private*, *Instant QR*) rendues dans un second contexte WebGL par scissor, uniquement quand la section est visible ;
- dégradation propre : WebGL indisponible ⇒ page pleinement utilisable en 2D ; `prefers-reduced-motion` ⇒ animations réduites ; mobile ⇒ particules/fichiers réduits et pixel-ratio plafonné ;
- assets servis en same-origin (CSP `script-src 'self'` respectée) : `assets/vendor/three.module.min.js`, `assets/vendor/qrcode.min.js`, `assets/landing.css`, `assets/landing3d.js` (aucune dépendance CDN) ;
- le slot de connexion **Discord** (v1.11.0) est conservé dans la nouvelle barre de navigation.

Les routes `/upload`, `/receive`, `/dashboard`, `/help` et `/mentions` restent accessibles ; elles utilisent maintenant le design partagé de la landing.
