# MatouRun

Calendrier d'entraînement de course à pied, pensé pour le téléphone :

- tu envoies la capture du plan du club et la date de la première séance, MatouRun la transforme en séances structurées ;
- tu vois ta semaine comme un calendrier, chaque séance dessinée en profil d'effort ;
- un bouton par séance (et un pour toute la semaine) l'envoie dans ton calendrier Garmin Connect, avec des cibles calculées à partir de tes allures 5 km, 10 km, semi et marathon ;
- l'onglet **Progrès** compare le volume prévu et réalisé semaine par semaine, avec l'allure moyenne, une grille de régularité, les records de la période et les dernières sorties. La partie *Évolution par allure* suit l'allure, la fréquence cardiaque et la cadence des footings (sorties dont 80 % du temps est à allure facile) et des tours courus à allure marathon, semi, 10 km ou 5 km (tours d'au moins une minute, classés d'après les allures du profil), avec un bilan début → fin de période. Les sorties viennent de Garmin (courses uniquement, importées sur le compte administrateur : synchro automatique toutes les 3 h, ou bouton *Synchroniser*). Des alertes signalent un volume en hausse de plus de 15 % par rapport aux 3 semaines précédentes et une FC des footings qui monte 3 semaines de suite ;
- la semaine montre pour chaque séance si elle a été faite (sortie Garmin du jour), et un **appui long** sur une carte permet de la glisser vers un autre jour, calendrier Garmin compris ;
- l'import accepte la **capture** ou le **texte** du message du club ;
- **rappels** : une notification le matin des jours de séance (Profil → Rappels ; sur iPhone, depuis l'icône de l'écran d'accueil) ;
- **hors ligne** : la dernière semaine consultée reste lisible sans réseau ;
- **thèmes** : Violet nuit, Océan, Forêt, Braise, Clair (Profil → Apparence).

## Déploiement (Render + Neon, gratuit)

1. **Base de données** : crée un projet gratuit sur [neon.tech](https://neon.tech) et copie la chaîne de connexion (`postgres://…?sslmode=require`). La base gratuite de Render est supprimée au bout de 30 jours, d'où Neon.
2. **Clé Gemini (gratuite)** : sur [aistudio.google.com](https://aistudio.google.com), *Get API key* → *Create API key*. Aucune carte bancaire. Elle sert à lire les captures. Si le modèle par défaut (`gemini-flash-latest`) n'est plus disponible, renseigne `GEMINI_MODEL` avec un modèle Flash listé dans AI Studio. Alternative payante : `ANTHROPIC_API_KEY`, utilisée seulement si `GEMINI_API_KEY` est vide.
3. **Render** : sur [dashboard.render.com](https://dashboard.render.com), *New* → *Blueprint*, choisis ce dépôt. Remplis les variables demandées :
   - `DATABASE_URL` : la chaîne Neon ;
   - `SETUP_CODE` : un code que tu inventes, qui sert uniquement à créer le tout premier compte (administrateur) ;
   - `GEMINI_API_KEY` ;
   - `GARMIN_TOKENS` : le jeton Garmin généré sur ton ordinateur (voir ci-dessous).
4. Ouvre l'adresse `https://matourun-xxxx.onrender.com` sur ton téléphone, entre ton e-mail, le `SETUP_CODE` et ton mot de passe : ce premier compte est administrateur. Invite ensuite les autres depuis *Profil → Qui a accès*. Ajoute-la à l'écran d'accueil (Partager → Sur l'écran d'accueil).

Sur l'offre gratuite, Render endort le serveur après 15 min sans visite. MatouRun se garde éveillé tout seul en appelant sa propre adresse (`RENDER_EXTERNAL_URL`, fournie par Render) toutes les 10 minutes, ce qui tient dans les 750 h gratuites par mois. Après un redéploiement ou une panne, la première ouverture peut encore prendre une trentaine de secondes.

Dans *Settings → Build & Deploy* du service Render, règle **Auto-Deploy** sur **After CI Checks Pass** : un envoi sur GitHub n'est alors déployé que si les tests passent.

## Tests automatiques et sauvegardes

- **CI** (`.github/workflows/ci.yml`) : à chaque envoi sur `main`, GitHub vérifie les types, lance les tests sur une vraie base Postgres, construit l'appli et refuse toute dépendance de production avec une faille connue de niveau élevé.
- **Sauvegarde** (`.github/workflows/backup.yml`) : chaque nuit, un `pg_dump` de la base, chiffré en AES-256, est conservé 30 jours dans l'onglet *Actions* du dépôt. À configurer une fois dans *Settings → Secrets and variables → Actions* :
  - `DATABASE_URL` : la chaîne de connexion Neon ;
  - `BACKUP_PASSPHRASE` : une longue phrase secrète, à garder ailleurs (sans elle, la sauvegarde est illisible).

  Pour restaurer : télécharger l'artefact, puis
  ```bash
  gpg -d matourun-AAAA-MM-JJ.dump.gpg > matourun.dump
  pg_restore --no-owner --clean --if-exists -d "$DATABASE_URL" matourun.dump
  ```

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

## Développement

```bash
npm install
cp .env.example .env   # puis complète
npm run build && node --env-file=.env server/dist/index.js
# ou, en deux terminaux : npm run dev  /  npm run dev:web
npm test               # nécessite un Postgres de test (TEST_DATABASE_URL)
```

Structure : `shared/` (schémas Zod et calculs d'allure), `server/` (Express, Postgres, auth, Garmin, lecture des captures), `web/` (React + Vite).
