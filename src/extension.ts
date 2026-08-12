import * as vscode from "vscode";
import { DashboardPanel } from "./dashboard";
import { UsageStore } from "./store";

export function activate(context: vscode.ExtensionContext): void {
  const store = new UsageStore(context);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "aicTracker.openDashboard";
  statusBar.text = "$(copilot) AIC …";
  statusBar.tooltip = "Copilot AIC Tracker — ouvrir le tableau de bord";
  statusBar.show();
  context.subscriptions.push(statusBar);

  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const state = await store.buildState();
      statusBar.text = `$(copilot) AIC ${state.today.aicGross.toLocaleString("fr-FR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
      statusBar.tooltip = new vscode.MarkdownString(
        `**Copilot AIC — aujourd'hui (${state.today.date})**\n\n` +
          `- AIC consommés : **${state.today.aicGross.toFixed(2)}**\n` +
          `- Discussions : **${state.today.sessions}** (${state.today.requests} requêtes)\n` +
          `- Agents : ${state.today.agentsUsed.join(", ") || "—"}\n\n` +
          (state.errors.length ? `⚠ ${state.errors[0]}\n\n` : "") +
          `_Cliquer pour ouvrir le tableau de bord._`
      );
      DashboardPanel.active?.update(state);
    } finally {
      refreshing = false;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("aicTracker.openDashboard", async () => {
      DashboardPanel.show(() => void refresh());
      await refresh();
    }),

    vscode.commands.registerCommand("aicTracker.refresh", () => refresh()),

    vscode.commands.registerCommand("aicTracker.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt:
          "Token GitHub (PAT fine-grained avec permission « Plan: Read-only », " +
          "ou accès facturation de l'organisation pour Copilot Business)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "github_pat_…",
      });
      if (token) {
        await store.setToken(token.trim());
        vscode.window.showInformationMessage("AIC Tracker : token enregistré.");
        await refresh();
      }
    }),

    vscode.commands.registerCommand("aicTracker.clearToken", async () => {
      await store.clearToken();
      vscode.window.showInformationMessage("AIC Tracker : token supprimé.");
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aicTracker")) {
        void refresh();
      }
    })
  );

  const timer = setInterval(() => void refresh(), store.refreshIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  void refresh();
}

export function deactivate(): void {
  /* rien à nettoyer : tout est dans context.subscriptions */
}
