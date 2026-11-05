# Le Carnet — comment ça marche

Le Carnet est une application web de gestion de tâches en équipe, pensée pour une équipe, une famille ou un groupe
d'amis. Elle fonctionne dans le navigateur, sur ordinateur comme sur téléphone, et s'installe comme une application.
Ce document explique **comment le site est organisé et comment il fonctionne**.

## Les quatre sites

| Adresse | Public | Rôle |
| --- | --- | --- |
| `/` | tout le monde | Page d'accueil : présentation, nouveautés, connexion. |
| `/app/` | membres d'un serveur | L'application elle-même (tâches, calendrier, messages, notes…). |
| `/admin/` | administrateurs d'un serveur | Espace administrateur : membres, congés, annonces, rapports, données, journal. |
| `/supra/` | propriétaire de la plateforme uniquement | Supra Admin : comptes et bannissements, serveurs, emails, patch notes, maintenance. |

Les quatre partagent la même connexion : on se connecte une fois, dans le même navigateur.

## Les notions de base

- **Serveur** : l'espace d'une équipe. Ses tâches, ses notes et ses membres sont totalement séparés de ceux des autres
  serveurs. Une même personne peut appartenir à plusieurs serveurs avec des comptes liés.
- **Rôles** : administrateur, modérateur, membre ou invité. Chaque rôle a des droits par défaut, que l'administrateur peut
  ajuster personne par personne (créer, modifier ou supprimer des tâches, écrire des messages…).
- **Invitations** : l'administrateur invite par email ou partage le code du serveur ; les demandes d'adhésion passent par lui.
- **Propriétaire de la plateforme** : une personne unique, au-dessus des serveurs, qui peut suspendre un compte ou un
  serveur et pilote le site (maintenance, annonces, patch notes).

## Ce que l'on peut faire dans l'application

- **Tâches** : priorités, échéances, heures, couleurs, étiquettes, sous-tâches, récurrence, assignation à plusieurs
  personnes, pièces jointes, commentaires, réactions, dépendances (« bloquée par »), historique des changements.
  Vues Liste, Kanban, Semaine, Chronologie (Gantt), Tableau et Matrice de priorités ; vues enregistrées ; import CSV ;
  ajout rapide en langage naturel (« Appeler Marie demain 14h30 #client »).
- **Calendrier et réunions** : réunions uniques ou récurrentes, appel vidéo intégré, comptes rendus, détection de conflits
  d'agenda, créneaux communs, synchronisation d'un agenda externe, congés.
- **Équipe** : présence (disponible, en réunion, en congé, hors horaires), statuts personnalisés, points quotidiens,
  objectifs avec résultats clés, rendez-vous sur disponibilités (présentiel ou appel), réservation de salles et de matériel.
- **Communication** : messagerie privée, salons, mentions `@`, notifications dans l'application (la cloche), emails.
- **Organisation personnelle** : notes partagées, suivi du temps, mode concentration (séances de 25 ou 50 minutes),
  suivi d'habitudes (privé), revue de la semaine, recherche globale (Ctrl/⌘ + K), raccourcis clavier.
- **Rapports** : charge de travail, avancement, temps suivi, exports CSV.

## Comment c'est construit

Le projet n'a **aucune étape de compilation** : ce sont des pages HTML statiques qui chargent React et leurs dépendances
directement dans le navigateur.

```
public/            pages servies telles quelles (index, app/, admin/, supra/, confidentialité, maintenance)
api/               fonctions serveur Vercel (emails, invitations, gestion des comptes, outils d'administration)
migration-NN-*.sql historique des évolutions de la base de données
supabase-schema.sql  schéma de départ
vercel.json        planificateur (rappels quotidiens)
```

- **Interface** : React 18 et Babel, chargés dans la page ; un seul fichier par site (`public/app/index.html`,
  `public/admin/index.html`, `public/supra/index.html`). Le style suit la direction « papier quadrillé » : mode clair
  « papier » et mode sombre « ardoise », polices Literata et Figtree.
- **Base de données et comptes** : Supabase (PostgreSQL, authentification, stockage de fichiers, temps réel). Les mises à
  jour apparaissent chez tout le monde sans recharger la page.
- **Hébergement** : Vercel. Les fonctions serveur sont limitées à douze : les actions du Supra Admin passent donc par la
  fonction `api/admin-tools.js`, et les fichiers dont le nom commence par `_` sont des modules partagés, pas des fonctions.
- **Emails** : envoyés via Gmail (invitations, assignations, mentions, rappels d'échéance, résumé hebdomadaire).
  Un planificateur quotidien (cron Vercel) déclenche les rappels.

## La sécurité

- **Les droits sont appliqués par la base de données** (Row Level Security), pas seulement par l'interface : contourner
  l'interface ne donne accès à rien. Chaque ligne n'est visible que par les membres approuvés de son serveur.
- **Les données privées le restent** : messages privés, habitudes, vues enregistrées et rendez-vous ne sont lisibles que par
  les personnes concernées.
- **Mots de passe** : gérés par l'authentification de Supabase, stockés sous forme chiffrée irréversible. Personne ne peut
  les lire, pas même le propriétaire de la plateforme ; il peut seulement envoyer un lien de nouveau mot de passe.
- **Bannissement** : un compte banni ne peut plus se connecter ni lire une seule donnée, et ne reçoit plus aucun email.
  Seul le serveur, sur ordre du propriétaire, peut bannir ou débannir.
- **Clés** : la clé publique (`anon`) est faite pour être visible ; la clé `service_role` ne vit que dans les variables
  d'environnement de Vercel et ne figure jamais dans le code.

## Maintenance et évolutions

- Les évolutions de la base sont des fichiers `migration-NN-*.sql`, à exécuter dans l'ordre. Elles sont conçues pour être
  relancées sans danger.
- Les nouveautés visibles de tous sont dans `public/patchnotes.json` (affichées sur l'accueil) ; le détail technique de
  chaque jour est dans l'onglet « Patch notes » du Supra Admin.
- La maintenance programmée affiche un bandeau puis redirige les visiteurs vers `/maintenance.html` ; l'espace
  administrateur reste accessible.
- Tous les textes s'adressent aux utilisateurs avec « vous ».
