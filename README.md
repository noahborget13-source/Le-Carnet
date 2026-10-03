# Le Carnet — guide de déploiement

Cette version est un vrai site indépendant de Claude : lien public, comptes réels
créés uniquement par toi (l'admin), rôles et droits appliqués **côté serveur**
(donc réellement sécurisés, pas juste cachés dans l'interface).

Tout est gratuit pour démarrer (Supabase et Vercel ont des plans gratuits largement
suffisants pour une petite équipe).

Temps estimé : 15-20 minutes, aucune compétence technique poussée requise —
suis les étapes dans l'ordre.

---

## 1. Créer le projet Supabase (la base de données + les comptes)

1. Va sur https://supabase.com et crée un compte (gratuit).
2. Clique sur **"New project"**.
3. Choisis un nom (ex. `le-carnet`), un mot de passe de base de données (garde-le
   de côté, tu n'en auras normalement pas besoin ensuite), et une région proche
   de toi (ex. Europe).
4. Attends 1-2 minutes que le projet soit prêt.

### Récupère tes clés

Dans le projet Supabase, va dans **Project Settings > API**. Tu y trouveras trois
informations à garder de côté :

- **Project URL** (ressemble à `https://xxxxx.supabase.co`)
- **anon public key** (une longue chaîne de caractères)
- **service_role key** (une autre longue chaîne — **ne la partage jamais, ne la
  mets jamais dans le code du site**, elle donne un accès total)

### Crée les tables

1. Dans le menu de gauche, clique sur **SQL Editor > New query**.
2. Ouvre le fichier `supabase-schema.sql` fourni avec ce projet, copie tout son
   contenu, colle-le dans l'éditeur, puis clique sur **Run**.
3. Tu dois voir "Success. No rows returned" — les tables et les règles de
   sécurité sont créées.

---

## 2. Remplir les clés dans le site

Ouvre le fichier `public/index.html` et cherche ces deux lignes (vers le début) :

```js
window.SUPABASE_URL = "https://VOTRE-PROJET.supabase.co";
window.SUPABASE_ANON_KEY = "VOTRE_CLE_ANON_PUBLIQUE";
```

Remplace-les par ton **Project URL** et ta clé **anon public** récupérées à
l'étape précédente. (Cette clé "anon" est faite pour être publique — ne mets
jamais la clé "service_role" ici.)

---

## 3. Déployer sur Vercel

1. Va sur https://vercel.com et crée un compte (gratuit), idéalement en te
   connectant avec GitHub.
2. Le plus simple : mets ce dossier de projet dans un nouveau dépôt GitHub
   (crée un repo, importe tous les fichiers), puis dans Vercel clique sur
   **"Add New… > Project"** et sélectionne ce dépôt.
3. Vercel détecte automatiquement la configuration (`vercel.json`). Avant de
   cliquer sur "Deploy", ouvre la section **Environment Variables** et ajoute :
   - `SUPABASE_URL` → ton Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` → ta clé service_role (celle qu'on garde secrète)
4. Clique sur **Deploy**. Après une minute, Vercel te donne un lien du type
   `https://le-carnet-xxxx.vercel.app` — c'est ton site, déjà en ligne et
   public.

---

## 4. Premier lancement

Ouvre ton lien Vercel. Comme aucun compte n'existe encore, tu verras l'écran
**"Bienvenue"** : crée ton compte administrateur (identifiant, email, mot de
passe). C'est le seul compte qui pourra ensuite créer, modifier ou supprimer
les autres — imposé par la base de données elle-même, pas juste par
l'interface.

Une fois connecté, va dans **Administration** pour créer des comptes pour les
autres personnes (avec leur rôle : modérateur / membre / invité, et leurs
droits individuels).

---

## 5. (Optionnel) Nom de domaine personnalisé + référencement Google

- Dans Vercel, onglet **Domains** du projet, tu peux relier un nom de domaine
  que tu achètes ailleurs (OVH, Namecheap, Google Domains…) — Vercel te guide
  pas à pas (ajouter un enregistrement DNS).
- Une fois le site en ligne avec une vraie URL stable, Google finit par
  l'indexer tout seul avec le temps. Pour accélérer, crée un compte gratuit sur
  **Google Search Console** (https://search.google.com/search-console), ajoute
  ton domaine, et demande une indexation manuelle de la page d'accueil.
- Attention : si tu veux que Google indexe le contenu, garde à l'esprit que
  les tâches/messages restent derrière un écran de connexion (normal pour un
  outil interne) — seule la page de connexion elle-même sera visible dans les
  résultats de recherche, pas le contenu de l'intérieur.

---

## Notes de sécurité

- Les mots de passe sont gérés par Supabase Auth (hachage sécurisé standard de
  l'industrie) — bien plus robuste que la version précédente sur Claude.
- Les droits (qui peut créer/modifier/supprimer quoi) sont vérifiés **dans la
  base de données elle-même** (Row Level Security), pas seulement dans
  l'interface : quelqu'un ne peut pas les contourner en bidouillant le code
  depuis son navigateur.
- Les messages sont réellement privés : seuls les deux participants d'une
  conversation peuvent la lire, imposé par la base de données.
- Ne partage jamais la clé `service_role` publiquement (ni sur GitHub en clair,
  ni ailleurs) — mets-la uniquement dans les variables d'environnement Vercel
  comme indiqué à l'étape 3.
