import * as vscode from "vscode";
import { DashboardState } from "./types";

/**
 * Tableau de bord webview. Le HTML est autonome (pas de ressource externe) et
 * s'appuie sur les variables de thème VS Code pour rester lisible en clair
 * comme en sombre. L'état est poussé via postMessage.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static show(onRefreshRequested: () => void): DashboardPanel {
    if (DashboardPanel.current && !DashboardPanel.current.disposed) {
      DashboardPanel.current.panel.reveal();
      return DashboardPanel.current;
    }
    DashboardPanel.current = new DashboardPanel(onRefreshRequested);
    return DashboardPanel.current;
  }

  static get active(): DashboardPanel | undefined {
    return DashboardPanel.current && !DashboardPanel.current.disposed
      ? DashboardPanel.current
      : undefined;
  }

  private constructor(onRefreshRequested: () => void) {
    this.panel = vscode.window.createWebviewPanel(
      "aicTrackerDashboard",
      "Copilot AIC Tracker",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = getHtml();
    this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg?.type === "refresh") onRefreshRequested();
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
    });
  }

  update(state: DashboardState): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "state", state });
    }
  }
}

function getHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 20px 40px;
    margin: 0;
  }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; margin: 24px 0 10px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .errors { margin: 12px 0; }
  .error {
    color: var(--vscode-errorForeground);
    font-size: 12px;
    margin: 2px 0;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 4px 12px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .topbar .spacer { flex: 1; }

  /* Tuiles de stats */
  .tiles { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .tile {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 6px;
    padding: 10px 14px;
    min-width: 130px;
  }
  .tile .label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tile .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  /* Barres horizontales (classement) */
  .hbar-row { display: grid; grid-template-columns: minmax(120px, 220px) 1fr 70px; gap: 8px; align-items: center; margin: 4px 0; font-size: 12px; }
  .hbar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar-track { height: 14px; position: relative; }
  .hbar-fill {
    height: 100%;
    background: var(--vscode-charts-blue);
    border-radius: 0 4px 4px 0;
    min-width: 2px;
  }
  .hbar-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .rank { color: var(--vscode-descriptionForeground); margin-right: 6px; font-variant-numeric: tabular-nums; }

  /* Colonnes (historique journalier) */
  .cols { display: flex; align-items: flex-end; gap: 2px; height: 120px; margin-top: 8px; }
  .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; position: relative; cursor: default; }
  .col-fill { background: var(--vscode-charts-blue); border-radius: 4px 4px 0 0; min-height: 1px; }
  .col:hover .col-fill { background: var(--vscode-charts-purple); }
  .col .tip {
    display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border, transparent);
    border-radius: 4px; padding: 4px 8px; font-size: 11px; white-space: nowrap; z-index: 10;
    pointer-events: none;
  }
  .col:hover .tip { display: block; }
  .cols-labels { display: flex; gap: 2px; margin-top: 4px; }
  .cols-labels span { flex: 1; text-align: center; font-size: 9px; color: var(--vscode-descriptionForeground); overflow: hidden; }
  .axis { border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); }

  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }

  table { border-collapse: collapse; font-size: 12px; margin-top: 6px; }
  th, td { text-align: left; padding: 3px 12px 3px 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  th { color: var(--vscode-descriptionForeground); font-weight: 500; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); }

  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .chip {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 10px; font-size: 11px;
  }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; }
</style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>Copilot AIC Tracker</h1>
      <div class="muted" id="meta">Chargement…</div>
    </div>
    <div class="spacer"></div>
    <button id="refreshBtn">Rafraîchir</button>
  </div>
  <div class="errors" id="errors"></div>

  <div class="tiles" id="tiles"></div>

  <h2 id="rankTitle">Classement LLM par AIC consommés</h2>
  <div class="grid2">
    <div>
      <div class="muted">Aujourd'hui</div>
      <div id="rankToday"></div>
    </div>
    <div>
      <div class="muted" id="rankPeriodLabel">Période</div>
      <div id="rankPeriod"></div>
    </div>
  </div>

  <h2>AIC consommés par jour</h2>
  <div id="aicChart"></div>

  <div class="grid2">
    <div>
      <h2>Discussions par jour</h2>
      <div id="sessionsChart"></div>
    </div>
    <div>
      <h2>Agents utilisés (période)</h2>
      <div id="agents"></div>
    </div>
  </div>

  <h2>Détail journalier</h2>
  <div id="tableWrap" style="overflow-x:auto"></div>

<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('refreshBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'refresh' });
    document.getElementById('meta').textContent = 'Rafraîchissement…';
  });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtAic = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const shortDay = (iso) => iso.slice(8) + '/' + iso.slice(5, 7);

  function renderRank(el, entries) {
    if (!entries.length) { el.innerHTML = '<div class="empty">Aucune consommation.</div>'; return; }
    const max = Math.max(...entries.map(e => e.aic), 0.0001);
    el.innerHTML = entries.map((e, i) =>
      '<div class="hbar-row">' +
        '<div class="hbar-name" title="' + esc(e.model) + '"><span class="rank">' + (i + 1) + '.</span>' + esc(e.model) + '</div>' +
        '<div class="hbar-track"><div class="hbar-fill" style="width:' + Math.max(1, (e.aic / max) * 100) + '%"></div></div>' +
        '<div class="hbar-val">' + fmtAic(e.aic) + '</div>' +
      '</div>').join('');
  }

  function renderCols(el, points, fmt) {
    if (!points.some(p => p.value > 0)) { el.innerHTML = '<div class="empty">Aucune donnée sur la période.</div>'; return; }
    const max = Math.max(...points.map(p => p.value), 0.0001);
    el.innerHTML =
      '<div class="cols axis">' + points.map(p =>
        '<div class="col">' +
          '<div class="tip">' + esc(p.date) + ' — ' + fmt(p.value) + (p.error ? ' (erreur API)' : '') + '</div>' +
          '<div class="col-fill" style="height:' + (p.value / max) * 100 + '%;' + (p.error ? 'opacity:.35;' : '') + '"></div>' +
        '</div>').join('') + '</div>' +
      '<div class="cols-labels">' + points.map(p => '<span>' + shortDay(p.date) + '</span>').join('') + '</div>';
  }

  function render(state) {
    const scope = state.organization
      ? 'org ' + state.organization + ' / ' + state.username
      : state.username || '(utilisateur non configuré)';
    document.getElementById('meta').textContent =
      scope + ' — mis à jour le ' + new Date(state.generatedAt).toLocaleString('fr-FR');

    document.getElementById('errors').innerHTML =
      state.errors.map(e => '<div class="error">⚠ ' + esc(e) + '</div>').join('');

    const t = state.today;
    document.getElementById('tiles').innerHTML =
      tile('AIC aujourd\\u2019hui', fmtAic(t.aicGross), 'facturé hors crédits : ' + fmtAic(t.aicNet)) +
      tile('Discussions aujourd\\u2019hui', t.sessions, t.requests + ' requête(s)') +
      tile('Agents utilisés aujourd\\u2019hui', t.agentsUsed.length, esc(t.agentsUsed.join(', ') || '—'));

    document.getElementById('rankPeriodLabel').textContent = state.historyDays + ' derniers jours';
    renderRank(document.getElementById('rankToday'), state.modelRankingToday);
    renderRank(document.getElementById('rankPeriod'), state.modelRankingPeriod);

    renderCols(document.getElementById('aicChart'),
      state.dailyAic.map(d => ({ date: d.date, value: d.gross, error: d.error })),
      (v) => fmtAic(v) + ' AIC');

    renderCols(document.getElementById('sessionsChart'),
      state.dailyLocal.map(d => ({ date: d.date, value: d.sessionsStarted })),
      (v) => v + ' discussion(s)');

    const agents = Object.entries(state.agentTotalsPeriod).sort((a, b) => b[1] - a[1]);
    document.getElementById('agents').innerHTML = agents.length
      ? '<div class="chips">' + agents.map(([name, n]) =>
          '<span class="chip">' + esc(name) + ' · ' + n + '</span>').join('') + '</div>'
      : '<div class="empty">Aucune session de chat locale trouvée.</div>';

    const rows = state.dailyAic.map((d, i) => {
      const loc = state.dailyLocal[i] || { sessionsStarted: 0, requests: 0, agents: {} };
      return '<tr><td>' + d.date + '</td>' +
        '<td class="num">' + fmtAic(d.gross) + '</td>' +
        '<td class="num">' + fmtAic(d.net) + '</td>' +
        '<td class="num">' + loc.sessionsStarted + '</td>' +
        '<td class="num">' + loc.requests + '</td>' +
        '<td>' + esc(Object.keys(loc.agents).join(', ')) + '</td></tr>';
    }).join('');
    document.getElementById('tableWrap').innerHTML =
      '<table><thead><tr><th>Date</th><th class="num">AIC</th><th class="num">Facturé</th>' +
      '<th class="num">Discussions</th><th class="num">Requêtes</th><th>Agents</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function tile(label, value, sub) {
    return '<div class="tile"><div class="label">' + label + '</div>' +
      '<div class="value">' + value + '</div>' +
      '<div class="sub">' + sub + '</div></div>';
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      render(event.data.state);
    }
  });
</script>
</body>
</html>`;
}
