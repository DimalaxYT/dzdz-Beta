# DropQR

DropQR est un site multi-pages pour transférer temporairement des fichiers entre appareils avec un QR code.

## Pages

- `/` : accueil
- `/upload` : création d’un transfert avec barre de progression
- `/dashboard` : suivi local des liens créés depuis ce navigateur
- `/help` : aide, déploiement et explication du QR code dans la preview Arena
- `/t/:id` : page publique de téléchargement

## Backend

Backend Node.js/Express avec :

- upload classique avec Multer vers le disque local ;
- upload par morceaux configurables via `/api/transfers/chunk` pour contourner les limites proxy/hébergeur liées aux gros fichiers ;
- génération de QR code ;
- métadonnées dans `storage/db.json` ;
- suppression après premier téléchargement si activée ;
- suppression automatique à expiration ;
- suppression manuelle via clé privée retournée à l’upload ;
- tâche de nettoyage toutes les minutes.

## Démarrage

```bash
npm install
npm start
```

Ouvre ensuite :

```txt
http://localhost:3000
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

## Taille des fichiers

Par défaut, DropQR n’impose plus de limite de taille côté application.

Depuis la version 1.5.0, l’interface envoie les fichiers par morceaux configurables. Ça évite les erreurs fréquentes de plateforme liées aux gros fichiers, comme ton HTTP 400 sur un fichier de 51,7 Mo.

Après déploiement, vérifie absolument :

```txt
https://ton-site.com/api/health
```

La réponse doit contenir :

```json
{
  "version": "1.7.0",
  "chunkedUpload": true
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

| Variable | Défaut | Rôle |
| --- | ---: | --- |
| `PORT` | `3000` | Port HTTP |
| `HOST` | `0.0.0.0` | Adresse d’écoute |
| `PUBLIC_URL` | vide | URL mise dans le QR code |
| `MAX_FILE_SIZE` | vide | Limite optionnelle, ex: `2gb`, `500mb` |
| `MAX_FILE_SIZE_MB` | vide | Limite optionnelle en Mo |
| `DEFAULT_TTL_MINUTES` | `15` | Durée par défaut |
| `MAX_TTL_MINUTES` | `1440` | Durée max autorisée |

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/stats`
- `POST /api/transfers`
- `POST /api/transfers/chunk`
- `GET /api/transfers/:id`
- `DELETE /api/transfers/:id`
- `GET /t/:id`
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

Ne colle jamais un token de bot Discord directement dans le chat. Si on veut un vrai bot Discord avec commandes slash plus tard, on le fera avec un fichier `.env`.

## Version 1.5.0

Changements principaux :

- le QR code pointe maintenant vers `/receive?code=...` au lieu d’un lien technique ;
- si `PUBLIC_URL` est saisi sans `https://`, DropQR ajoute automatiquement `https://` ;
- la page `/receive` permet d’entrer un code et affiche les informations du fichier avant téléchargement ;
- le message Discord est supprimé automatiquement à l’expiration du transfert ;
- le message Discord est aussi supprimé si le fichier est supprimé avant expiration ;
- interface simplifiée, moins “IA”, plus directe.

Après déploiement Railway, vérifie :

```txt
/api/health
```

La réponse doit contenir :

```json
{
  "version": "1.7.0",
  "discordConfigured": true
}
```


## Version 1.5.0

Améliorations principales :

- interface plus sobre, plus rapide au scroll, sans effets lourds ;
- upload accéléré : morceaux plus grands par défaut (`CHUNK_SIZE_MB=8`) ;
- upload en parallèle (`UPLOAD_CONCURRENCY=4`) au lieu d’un morceau après l’autre ;
- nouvelle route `POST /api/transfers/complete` pour assembler le fichier après l’envoi parallèle ;
- assemblage serveur en streaming pour éviter de charger les morceaux en mémoire ;
- `/api/health` expose maintenant `recommendedChunkSizeBytes` et `uploadConcurrency`.

Variables optionnelles pour ajuster la vitesse :

```env
CHUNK_SIZE_MB=8
UPLOAD_CONCURRENCY=4
```

Si l’hébergeur refuse les uploads, baisse `CHUNK_SIZE_MB` à `4`. Si la connexion et l’hébergeur tiennent bien, tu peux essayer `CHUNK_SIZE_MB=12` et `UPLOAD_CONCURRENCY=5`.

## Version 1.6.0

Support vidéo :

- les vidéos peuvent être envoyées comme les autres fichiers ;
- la page `/receive` affiche un lecteur vidéo si le fichier reçu est une vidéo ;
- nouvelle route `GET /view/:id` pour lire les vidéos dans le navigateur ;
- support des requêtes `Range`, indispensable pour avancer dans une vidéo sans tout télécharger ;
- le bouton de téléchargement reste disponible pour récupérer le fichier original.


## Version 1.7.0

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
