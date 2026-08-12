# Copilot AIC Tracker

Extension VS Code de suivi journalier de la consommation GitHub Copilot :

- **AIC consommés par jour** (GitHub AI Credits, facturation usage-based depuis juin 2026)
- **Consommation AIC par modèle LLM**, avec classement (aujourd'hui + période)
- **Nombre de discussions par jour** et **agents utilisés** (reconstruits depuis les sessions de chat Copilot stockées localement par VS Code — aucune API supplémentaire)
- Indicateur d'AIC du jour dans la barre de statut

## Sources de données — deux modes

L'extension sonde d'abord l'API de facturation ; si elle répond 403/404 (cas typique d'une licence **Copilot Business** gérée par l'organisation), elle bascule définitivement en **mode quota** et ne réessaie qu'après un changement de configuration ou de token.

| Mode | Source | Ce qu'on obtient |
|---|---|---|
| **billing** | API GitHub `GET /users/{username}/settings/billing/ai_credit/usage` (ou endpoint org avec `?user=`) | AIC exacts par jour **et par modèle** |
| **quota** (repli) | Endpoint interne `GET api.github.com/copilot_internal/user` — celui qu'utilise l'extension Copilot pour afficher votre quota ; accessible avec la simple session GitHub | Compteur cumulatif de la période, échantillonné à chaque rafraîchissement → AIC par jour reconstruits par différence ; le classement LLM passe sur le **nombre de requêtes par modèle** (compté localement) |
| (toujours) | Fichiers locaux `User/workspaceStorage/*/chatSessions/*.json` | Discussions / jour, agents utilisés, requêtes par modèle |

Limites du mode quota : la granularité journalière dépend de la fréquence d'échantillonnage (VS Code doit être ouvert pour relever le compteur ; la consommation faite pendant que VS Code est fermé est attribuée au jour du relevé suivant), et l'AIC par modèle n'est pas disponible (l'endpoint ne le détaille pas).

En mode billing, les jours passés sont mis en cache (ils sont immuables) ; seul le jour courant est re-interrogé, toutes les 15 minutes par défaut.

## Installation

```powershell
code --install-extension copilot-aic-tracker-0.1.3.vsix
```

## Configuration

1. **Réglages** (`Ctrl+,` → « AIC Tracker ») :
   - `aicTracker.username` : optionnel — le login est détecté automatiquement (propriétaire du PAT via `GET /user`, sinon session GitHub de VS Code). Ne le renseigner que pour suivre un autre compte.
   - `aicTracker.organization` : le slug de l'organisation si votre licence est Copilot Business (l'extension interrogera alors l'endpoint de l'org avec `?user=<username>`)
   - `aicTracker.historyDays` (14 par défaut), `aicTracker.refreshIntervalMinutes` (15 par défaut)
2. **Authentification** — deux possibilités :
   - **Sans PAT (recommandé)** : palette de commandes → `AIC Tracker: Se connecter à GitHub`. L'extension réutilise le compte GitHub auquel VS Code est déjà connecté (celui de Copilot) via l'API `vscode.authentication` — une simple demande d'autorisation, aucun token à créer. Une proposition de connexion s'affiche aussi au premier lancement.
   - **Avec PAT** : `AIC Tracker: Définir le token GitHub (PAT, optionnel)` — PAT fine-grained avec la permission **Plan : Read-only** (ou accès facturation de l'org). S'il est défini, il est prioritaire sur la session. Stocké dans le SecretStorage, jamais dans les settings.

## Utilisation

- Palette de commandes → `AIC Tracker: Ouvrir le tableau de bord`, ou clic sur l'item `$(copilot) AIC x,xx` de la barre de statut.
- Le tableau de bord affiche : tuiles du jour (AIC, discussions, agents), classement des LLM par AIC, histogramme AIC/jour, discussions/jour, agents sur la période, et le détail journalier en table.

## Limites connues

- Le comptage local ne voit que l'activité de **cette machine et de cette installation de VS Code** (le dossier `User` de l'instance courante, tous workspaces confondus).
- `copilot_internal/user` est un endpoint non documenté : GitHub peut en changer le format sans préavis (l'extension parse défensivement et affiche l'erreur le cas échéant).

## Développement

```powershell
npm install
npm run compile   # ou: npm run watch
# F5 dans VS Code pour lancer l'Extension Development Host
npm run package   # génère le .vsix
```

> Note : TypeScript est imposé ici par l'extension host Node.js de VS Code (une extension ne peut pas être écrite en Rust).
