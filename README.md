# Copilot AIC Tracker

Extension VS Code de suivi journalier de la consommation GitHub Copilot :

- **AIC consommés par jour** (GitHub AI Credits, facturation usage-based depuis juin 2026)
- **Consommation AIC par modèle LLM**, avec classement (aujourd'hui + période)
- **Nombre de discussions par jour** et **agents utilisés** (reconstruits depuis les sessions de chat Copilot stockées localement par VS Code — aucune API supplémentaire)
- Indicateur d'AIC du jour dans la barre de statut

## Sources de données

| Métrique | Source |
|---|---|
| AIC / jour, AIC / modèle | API GitHub `GET /users/{username}/settings/billing/ai_credit/usage` (ou l'endpoint organisation avec `?user=` pour Copilot Business) |
| Discussions / jour, agents utilisés | Fichiers locaux `User/workspaceStorage/*/chatSessions/*.json` de VS Code |

Les jours passés sont mis en cache (ils sont immuables) ; seul le jour courant est re-interrogé, toutes les 15 minutes par défaut.

## Installation

```powershell
code --install-extension copilot-aic-tracker-0.1.0.vsix
```

## Configuration

1. **Réglages** (`Ctrl+,` → « AIC Tracker ») :
   - `aicTracker.username` : votre login GitHub (obligatoire)
   - `aicTracker.organization` : le slug de l'organisation si votre licence est Copilot Business (l'extension interrogera alors l'endpoint de l'org avec `?user=<username>`)
   - `aicTracker.historyDays` (14 par défaut), `aicTracker.refreshIntervalMinutes` (15 par défaut)
2. **Token** : palette de commandes → `AIC Tracker: Définir le token GitHub (PAT)`.
   - Endpoint utilisateur : PAT fine-grained avec la permission **Plan : Read-only** sur votre compte.
   - Endpoint organisation : token avec accès facturation de l'organisation.
   - Le token est stocké dans le SecretStorage de VS Code (jamais dans les settings).

## Utilisation

- Palette de commandes → `AIC Tracker: Ouvrir le tableau de bord`, ou clic sur l'item `$(copilot) AIC x,xx` de la barre de statut.
- Le tableau de bord affiche : tuiles du jour (AIC, discussions, agents), classement des LLM par AIC, histogramme AIC/jour, discussions/jour, agents sur la période, et le détail journalier en table.

## Limites connues

- Si la licence Business ne vous donne pas accès à l'endpoint AIC de l'org, l'erreur HTTP est affichée dans le tableau de bord ; les métriques locales (discussions, agents) fonctionnent quand même.
- Le comptage local ne voit que l'activité de **cette machine et de cette installation de VS Code** (le dossier `User` de l'instance courante, tous workspaces confondus).

## Développement

```powershell
npm install
npm run compile   # ou: npm run watch
# F5 dans VS Code pour lancer l'Extension Development Host
npm run package   # génère le .vsix
```

> Note : TypeScript est imposé ici par l'extension host Node.js de VS Code (une extension ne peut pas être écrite en Rust).
