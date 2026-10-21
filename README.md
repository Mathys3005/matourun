# MatouRun

Calendrier d'entraînement de course à pied, pensé pour le téléphone :

- tu envoies la capture du plan du club et la date de la première séance, MatouRun la transforme en séances structurées ;
- tu vois ta semaine comme un calendrier, chaque séance dessinée en profil d'effort ;
- un bouton par séance (et un pour toute la semaine) l'envoie dans ton calendrier Garmin Connect, avec des cibles calculées à partir de tes allures 5 km, 10 km, semi et marathon ;
- l'onglet **Progrès** compare le volume prévu et réalisé semaine par semaine, avec l'allure moyenne, une grille de régularité, les records de la période et les dernières sorties. Les sorties viennent de Garmin (courses uniquement, importées sur le compte administrateur : synchro automatique toutes les 3 h à l'ouverture de l'onglet, ou bouton *Synchroniser*).

## Déploiement (Render + Neon, gratuit)

1. **Base de données** : crée un projet gratuit sur [neon.tech](https://neon.tech) et copie la chaîne de connexion (`postgres://…?sslmode=require`). La base gratuite de Render est supprimée au bout de 30 jours, d'où Neon.
2. **Clé Gemini (gratuite)** : sur [aistudio.google.com](https://aistudio.google.com), *Get API key* → *Create API key*. Aucune carte bancaire. Elle sert à lire les captures. Si le modèle par défaut (`gemini-flash-latest`) n'est plus disponible, renseigne `GEMINI_MODEL` avec un modèle Flash listé dans AI Studio. Alternative payante : `ANTHROPIC_API_KEY`, utilisée seulement si `GEMINI_API_KEY` est vide.
3. **Render** : sur [dashboard.render.com](https://dashboard.render.com), *New* → *Blueprint*, choisis ce dépôt. Remplis les variables demandées :
   - `DATABASE_URL` : la chaîne Neon ;
   - `SETUP_CODE` : un code que tu inventes, qui sert uniquement à créer le tout premier compte (administrateur) ;
   - `GEMINI_API_KEY` ;
   - `GARMIN_TOKENS` : le jeton Garmin généré sur ton ordinateur (voir ci-dessous).
4. Ouvre l'adresse `https://matourun-xxxx.onrender.com` sur ton téléphone, entre ton e-mail, le `SETUP_CODE` et ton mot de passe : ce premier compte est administrateur. Invite ensuite les autres depuis *Profil → Qui a accès*. Ajoute-la à l'écran d'accueil (Partager → Sur l'écran d'accueil).

Sur l'offre gratuite, le serveur s'endort après 15 min sans visite : la première ouverture prend environ 30 secondes.

## Garmin

Garmin bloque les connexions par mot de passe qui viennent des hébergeurs (adresse Render partagée, erreurs 429 / Cloudflare 1015). La connexion se fait donc **une fois depuis ton ordinateur** :

```bash
mkdir garmin-token && cd garmin-token
npm install garmin-connect@1.6.2
# copie scripts/garmin-token.mjs dans ce dossier, puis :
node garmin-token.mjs
```

Le script demande ton e-mail et ton mot de passe Garmin (le mot de passe n'est envoyé qu'à Garmin, jamais affiché ni enregistré) et affiche un jeton. Colle-le dans la variable `GARMIN_TOKENS` sur Render. Le jeton est valable environ un an ; le serveur renouvelle seul l'accès à court terme et garde la copie à jour chiffrée (AES-256-GCM) en base. Quand il expire, l'appli le dit : relance le script.

`GARMIN_EMAIL` / `GARMIN_PASSWORD` restent possibles en secours, mais le serveur ne tente alors qu'une connexion à la fois, suivie d'un délai d'attente d'une heure en cas de refus, pour ne pas aggraver le blocage. Limites : l'export passe par l'API web de Garmin Connect (non officielle, via `garmin-connect`) et peut cesser de fonctionner si Garmin la change. Les séances de tous les utilisateurs partent sur ce même compte Garmin.

## Sécurité

- **Accès** : la liste des personnes autorisées est en base de données. Le tout premier compte se crée avec `SETUP_CODE` et devient administrateur ; cette porte se ferme dès qu'un compte existe (verrou transactionnel). Ensuite, un administrateur invite chaque personne depuis *Profil → Qui a accès* : l'appli génère un code d'invitation à usage unique (environ 60 bits, stocké haché, valable 7 jours). Retirer quelqu'un supprime son compte, ses séances et ses sessions, et coupe l'accès immédiatement : chaque requête vérifie le compte en base.
- **Mots de passe** : Argon2id, verrouillage 15 min après 5 échecs, limitation de débit sur les routes d'authentification, temps de réponse identique pour un compte inexistant.
- **JWT** : jeton d'accès HS256 de 15 min, gardé uniquement en mémoire côté client (jamais dans `localStorage`). Jeton de rafraîchissement aléatoire de 30 jours dans un cookie `HttpOnly; Secure; SameSite=Strict` limité à `/api/auth`, stocké haché (SHA-256), **rotation à chaque usage** et révocation de toute la famille en cas de réutilisation (vol détecté).
- **CSRF** : les routes protégées par cookie (`refresh`, `logout`) exigent un jeton double-submit dans l'en-tête `X-CSRF-Token` ; toutes les requêtes d'écriture vérifient l'en-tête `Origin`. Le reste de l'API utilise un en-tête `Authorization`, non envoyé automatiquement par le navigateur.
- **Injections SQL** : toutes les requêtes sont paramétrées (`$1, $2…`), aucune valeur n'est concaténée.
- **Validation** : schémas Zod partagés (`shared/schemas.ts`) côté serveur sur chaque entrée, et côté client sur chaque réponse. La sortie de l'IA est validée par le même schéma avant d'être utilisée.
- **XSS** : React échappe tout le contenu, aucun `dangerouslySetInnerHTML` ; CSP stricte (`script-src 'self'`, pas de script inline), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS en production.
- **Fichiers** : 5 Mo max, type réel vérifié par les premiers octets, image réduite et ré-encodée sur le téléphone avant l'envoi (métadonnées EXIF supprimées).

## Développement

```bash
npm install
cp .env.example .env   # puis complète
npm run build && node --env-file=.env server/dist/index.js
# ou, en deux terminaux : npm run dev  /  npm run dev:web
npm test               # nécessite un Postgres de test (TEST_DATABASE_URL)
```

Structure : `shared/` (schémas Zod et calculs d'allure), `server/` (Express, Postgres, auth, Garmin, lecture des captures), `web/` (React + Vite).
