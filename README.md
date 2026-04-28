# Beebs Discord Alerts

Bot Discord en Node.js qui surveille des pages de recherche ou categorie Beebs et envoie une alerte quand une nouvelle annonce correspondante apparait.

Le bot utilise par defaut l'endpoint public Beebs des derniers produits crees :

```text
https://www.beebs.app/api/sitemaps/products/last-created/0
```

Il ne navigue pas sur les pages Beebs avec Playwright en mode principal. Les URLs surveillees servent a extraire les filtres locaux (`searchText` et categorie si possible), puis le bot compare ces filtres aux produits recents du sitemap et deduplique avec SQLite.

## Fonctionnalites

- `discord.js` v14
- Source principale sitemap/API Beebs, sans navigation Playwright
- Playwright optionnel, desactive par defaut avec `ENABLE_PLAYWRIGHT=false`
- SQLite pour les URLs surveillees et les annonces deja vues
- Verification toutes les 2 minutes par defaut
- Extraction limitee a 20 annonces maximum par check
- Filtre d'age configurable avec `MAX_LISTING_AGE_MINUTES`
- Embeds Discord pour les nouvelles annonces
- Protection contre les doublons apres redemarrage
- Logs clairs quand le mode sitemap est utilise

## Installation

```bash
npm install
cp .env.example .env
```

`npm run playwright:install` n'est necessaire que si tu actives `ENABLE_PLAYWRIGHT=true`.

Remplis ensuite `.env` :

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=
BEEBS_SITEMAP_URL=https://www.beebs.app/api/sitemaps/products/last-created/0
ENABLE_PLAYWRIGHT=false
MAX_LISTING_AGE_MINUTES=10
```

`DISCORD_GUILD_ID` est optionnel. S'il est rempli, les slash commands sont enregistrees sur ce serveur et apparaissent rapidement. Sinon elles sont enregistrees globalement et Discord peut prendre du temps a les afficher.

## Lancement

```bash
npm start
```

Pour verifier la syntaxe :

```bash
npm run check
```

## Commandes Discord

- `/watch url:<beebs_url> channel:<discord_channel>`
  - Ajoute ou met a jour une surveillance.
  - Le bot recupere immediatement les produits recents du sitemap, filtre localement, puis memorise les annonces deja presentes sans envoyer d'alerte initiale.

- `/unwatch url:<beebs_url>`
  - Supprime la surveillance de cette URL exacte.

- `/list`
  - Affiche les URLs surveillees, leur salon et le dernier etat connu.

- `/test url:<beebs_url>`
  - Teste les filtres locaux sur le sitemap Beebs sans enregistrer la surveillance.

## Permissions Discord

Le bot doit avoir :

- `applications.commands`
- acces au serveur
- permission de voir et envoyer des messages dans les salons d'alerte
- permission d'envoyer des embeds

## Structure

```text
src/
  client.js
  commands/
    index.js
  services/
    beebsWatcher.js
    scraper.js
  database.js
  config.js
main.js
```

## Notes sur la source Beebs

Le fichier principal a mettre a jour est :

```text
src/services/scraper.js
```

Le sitemap fournit surtout les URLs produits et `lastmod`. Le bot derive donc :

- `uniqueId` depuis `/fr/p/<id>-...`
- `title` depuis le slug de l'URL produit
- `productUrl` depuis `<loc>`
- `price` et `imageUrl` restent vides en mode sitemap si Beebs ne les expose pas dans cet endpoint

Filtrage local :

- les mots du parametre `searchText` doivent apparaitre dans le titre ou l'URL du produit ;
- si l'URL surveillee contient une categorie comme `/fr/ca/coffrets_pokemon-...`, le bot essaie aussi de matcher les mots de cette categorie ;
- les annonces datees par `lastmod` sont gardees uniquement si elles ont moins de `MAX_LISTING_AGE_MINUTES` ;
- si `lastmod` manque, l'age est estime avec la position dans le sitemap et les 50 premieres positions restent considerees recentes ;
- le check s'arrete quand une annonce deja vue est rencontree ;
- `MAX_LISTINGS_PER_CHECK` est limite a 20 maximum dans le code.
