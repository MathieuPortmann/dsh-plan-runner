// DSH plan runner — Client half (Web UI).
// - Above the message box: a strip when this conversation has a plan split into steps
//   ("Plan ready: 5 steps — Run step by step", or the progress while it runs).
// - Right sidebar tab "Plan step by step": the steps with their status, model, access,
//   summaries, links to each step's conversation, the lessons and the journal;
//   buttons Start / Pause / Stop / Resume, and the split proposal to accept or refuse.
window.__ModuleLoader__.load({
  id: 'dsh-plan-runner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-plan-runner';
    const PKG = 'dsh-plan-runner';
    const KIND = 'dsh-plan-runner';
    const CHANNEL = '/plan-runner-api';

    const fr = {
      'tab.title': 'Plan étape par étape',
      'strip.ready': 'Plan « {name} » prêt : {n} étapes, chacune dans une discussion neuve.',
      'strip.running': 'Plan « {name} » en cours : étape {i}/{n}.',
      'strip.paused': 'Plan « {name} » en pause : {reason}',
      'strip.done': 'Plan « {name} » terminé : {n} étapes vérifiées.',
      'strip.stopped': 'Plan « {name} » arrêté : {reason}',
      'btn.run': 'Exécuter étape par étape', 'btn.view': 'Voir', 'btn.pause': 'Pause', 'btn.stop': 'Arrêter',
      'btn.resume': 'Reprendre', 'btn.accept': 'Accepter ce découpage', 'btn.refuse': 'Refuser et arrêter', 'btn.retry': 'Réessayer l’étape',
      'confirm.stop': 'Arrêter le plan ? L’étape en cours est interrompue. Les fichiers déjà écrits restent.',
      'reason.user': 'tu l’as demandé', 'reason.stop-point': 'point d’arrêt : vérifie le résultat, puis clique Reprendre',
      'reason.ollama': 'Ollama ne répond pas (arrêté ou injoignable ?). Relance-le, puis clique Reprendre',
      'reason.battery': 'l’ordinateur est sur batterie. Branche le secteur, puis clique Reprendre',
      'reason.restart': 'DSH a redémarré pendant l’exécution. Clique Reprendre : l’étape en cours repart du début',
      'reason.split': 'une étape a échoué deux fois. Un découpage plus fin t’est proposé ci-dessous',
      'reason.failed': 'une étape a échoué', 'reason.parent-closed': 'la discussion du plan n’est pas chargée',
      'status.draft': 'brouillon', 'status.ready': 'prêt', 'status.running': 'en cours', 'status.paused': 'en pause', 'status.done': 'terminé', 'status.stopped': 'arrêté',
      'step.todo': 'à faire', 'step.running': 'en cours', 'step.ok': 'vérifiée', 'step.failed': 'échec',
      'access.read': 'lecture seule', 'access.write': 'écriture', 'access.full': 'accès complet',
      'chip.stop': 'point d’arrêt', 'chip.important': 'relue', 'chip.budget': '≈ {t} / {l} tokens',
      'items': '{ok}/{total} éléments traités{failed}', 'items.failed': ', {n} en échec',
      'attempts': 'essai {n}', 'failure': 'Dernier échec : {text}', 'checks': 'Vérifications : {text}',
      'sessions': 'Discussions :', 'session.n': '#{n}',
      'split.title': 'Découpage proposé pour l’étape {i} (rien n’est changé sans ton accord) :',
      'lessons': 'Leçons retenues (lues par chaque étape)', 'journal': 'Journal',
      'objective': 'Objectif', 'folder': 'Dossier : {cwd}',
      'empty': 'Aucun plan découpé dans cette discussion. Choisis le mode Plan : l’agent prépare les étapes (plan_begin, plan_add_step), puis tu les lances d’ici.',
      'note.access': 'Les étapes ne peuvent pas te demander d’autorisation : une action que le mode de permission de cette discussion n’autorise pas sans demander est refusée, et l’étape échoue. Pour des étapes qui écrivent, mets la discussion en Auto ou en Écriture dans le dossier.',
      'error': 'Erreur : {error}',
      'review.button': 'Exécuter étape par étape ({n})',
      'review.title': 'Lance les {n} étapes, chacune dans une discussion neuve, vérifiées une par une. Cette discussion reste en mode plan.',
    };
    const en = {
      'tab.title': 'Plan step by step',
      'strip.ready': 'Plan "{name}" ready: {n} steps, each in a fresh conversation.',
      'strip.running': 'Plan "{name}" running: step {i}/{n}.',
      'strip.paused': 'Plan "{name}" paused: {reason}',
      'strip.done': 'Plan "{name}" finished: {n} steps verified.',
      'strip.stopped': 'Plan "{name}" stopped: {reason}',
      'btn.run': 'Run step by step', 'btn.view': 'View', 'btn.pause': 'Pause', 'btn.stop': 'Stop',
      'btn.resume': 'Resume', 'btn.accept': 'Accept this split', 'btn.refuse': 'Refuse and stop', 'btn.retry': 'Retry the step',
      'confirm.stop': 'Stop the plan? The current step is interrupted. Files already written stay.',
      'reason.user': 'you asked', 'reason.stop-point': 'stop point: check the result, then press Resume',
      'reason.ollama': 'Ollama does not answer (stopped or unreachable?). Restart it, then press Resume',
      'reason.battery': 'the computer is on battery. Plug it in, then press Resume',
      'reason.restart': 'DSH restarted during the run. Press Resume: the current step starts again',
      'reason.split': 'a step failed twice. A finer split is proposed below',
      'reason.failed': 'a step failed', 'reason.parent-closed': 'the plan conversation is not loaded',
      'status.draft': 'draft', 'status.ready': 'ready', 'status.running': 'running', 'status.paused': 'paused', 'status.done': 'done', 'status.stopped': 'stopped',
      'step.todo': 'to do', 'step.running': 'running', 'step.ok': 'verified', 'step.failed': 'failed',
      'access.read': 'read only', 'access.write': 'write', 'access.full': 'full access',
      'chip.stop': 'stop point', 'chip.important': 'reviewed', 'chip.budget': '≈ {t} / {l} tokens',
      'items': '{ok}/{total} items done{failed}', 'items.failed': ', {n} failed',
      'attempts': 'try {n}', 'failure': 'Last failure: {text}', 'checks': 'Checks: {text}',
      'sessions': 'Conversations:', 'session.n': '#{n}',
      'split.title': 'Split proposed for step {i} (nothing changes without your approval):',
      'lessons': 'Lessons (read by every step)', 'journal': 'Journal',
      'objective': 'Objective', 'folder': 'Folder: {cwd}',
      'empty': 'No plan split into steps in this conversation. Choose the Plan mode: the agent prepares the steps (plan_begin, plan_add_step), then you run them from here.',
      'note.access': 'Steps cannot ask you for approval: an action the permission mode of this conversation does not allow without asking is refused and the step fails.',
      'error': 'Error: {error}',
      'review.button': 'Run step by step ({n})',
      'review.title': 'Runs the {n} steps, each in a fresh conversation, verified one by one. This conversation stays in plan mode.',
    };

    const C = {
      text: 'var(--dsw-alias-label-primary)', sub: 'var(--dsw-alias-label-secondary)', faint: 'var(--dsw-alias-label-tertiary)',
      bg1: 'var(--dsw-alias-bg-layer-1)', bg2: 'var(--dsw-alias-bg-layer-2)', border: 'var(--dsw-alias-border-l2)', border3: 'var(--dsw-alias-border-l3)',
      link: 'var(--dsw-alias-state-business-primary, #2f7de1)',
      ok: 'var(--dsw-alias-state-success-primary)', warn: 'var(--dsw-alias-state-warn-primary)', err: 'var(--dsw-alias-state-error-primary)', brand: 'var(--dsw-alias-brand-primary)',
    };
    const btn = (kind = 'plain') => ({
      padding: '3px 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 12.5,
      border: kind === 'primary' ? 'none' : `1px solid ${C.border3}`,
      background: kind === 'primary' ? C.brand : 'transparent', color: kind === 'primary' ? C.bg1 : kind === 'danger' ? C.err : C.text,
    });
    const chip = { fontSize: 11, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 6, padding: '0 6px' };
    const ICON = { todo: '○', running: '◐', ok: '✓', failed: '✕' };
    const COLOR = { todo: C.faint, running: C.brand, ok: C.ok, failed: C.err };

    function useRpc(connection) {
      return React.useCallback(async (endpoint, payload) => {
        const r = await connection.rpc.call(CHANNEL, endpoint, payload ?? {});
        if (!r || r.ok === false) throw new Error(r?.error?.message ?? 'no answer');
        return r.value;
      }, [connection]);
    }

    function usePlans(sessionId, rpc, ms) {
      const [plans, setPlans] = React.useState(null);
      const load = React.useCallback(async () => {
        if (!sessionId) return;
        try { setPlans(await rpc('list', { sessionId })); } catch { /* host not ready */ }
      }, [rpc, sessionId]);
      React.useEffect(() => { load(); const id = setInterval(load, ms); return () => clearInterval(id); }, [load, ms]);
      return [plans, load];
    }

    const reasonText = (t, r) => {
      if (!r) return '';
      const k = `reason.${r.split(':')[0]}`;
      const x = t(k);
      return x === k ? r : x;
    };

    function useAct(rpc, sessionId, reload, t) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const act = async (slug, action) => {
        if (action === 'stop' && !window.confirm(t('confirm.stop'))) return;
        setBusy(true); setError(null);
        try { await rpc('action', { sessionId, slug, action }); } catch (e) { setError(reasonText(t, e.message)); }
        setBusy(false); reload();
      };
      return { act, busy, error };
    }

    function Buttons({ p, t, act, busy, openPanel }) {
      const b = (label, action, kind) => h('button', { key: action, type: 'button', disabled: busy, style: btn(kind), onClick: () => act(p.slug, action) }, t(label));
      const out = [];
      if (p.status === 'ready') out.push(b('btn.run', 'start', 'primary'));
      if (p.status === 'paused' && p.reason !== 'split') out.push(b('btn.resume', 'start', 'primary'));
      if (p.status === 'running') out.push(b('btn.pause', 'pause'));
      if (['running', 'paused'].includes(p.status)) out.push(b('btn.stop', 'stop', 'danger'));
      if (p.status === 'stopped' && p.steps.some(s => s.status === 'failed')) out.push(b('btn.retry', 'retryStep'));
      if (openPanel) out.push(h('button', { key: 'view', type: 'button', style: btn(), onClick: openPanel }, t('btn.view')));
      return out;
    }

    // --- 1. Strip above the message box ------------------------------------------------
    function Strip({ sessionId, connection, t, openPanel }) {
      const rpc = useRpc(connection);
      const [plans, reload] = usePlans(sessionId, rpc, 3000);
      const { act, busy, error } = useAct(rpc, sessionId, reload, t);
      // The plan that needs attention first: running, then paused (stop point, split to decide), then the latest.
      const shown = (plans ?? []).filter(x => x.status !== 'draft');
      const p = shown.find(x => x.status === 'running') ?? shown.findLast(x => x.status === 'paused') ?? shown.at(-1);
      if (!p) return null;
      const n = p.steps.length;
      const text = p.status === 'ready' ? t('strip.ready', { name: p.slug, n })
        : p.status === 'running' ? t('strip.running', { name: p.slug, i: Math.min(p.current + 1, n), n })
        : p.status === 'done' ? t('strip.done', { name: p.slug, n })
        : t(`strip.${p.status}`, { name: p.slug, reason: reasonText(t, p.reason) });
      const color = p.status === 'paused' ? C.warn : p.status === 'stopped' ? C.err : p.status === 'done' ? C.ok : C.text;
      return h('div', { 'data-dsh-plan-runner': 'strip', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: `1px solid ${C.border3}`, borderRadius: 10, padding: '5px 10px', margin: '0 0 6px', fontSize: 12.5, color, background: C.bg1 } },
        h('span', { style: { flex: '1 1 200px' } }, '☰ ', text),
        Buttons({ p, t, act, busy, openPanel }),
        error && h('span', { role: 'alert', style: { color: C.err, fontSize: 12 } }, t('error', { error })));
    }

    // --- 2. The panel -------------------------------------------------------------------
    function Step({ s, i, t, openSession }) {
      return h('div', { style: { borderLeft: `3px solid ${COLOR[s.status] ?? C.faint}`, padding: '6px 0 6px 10px', margin: '8px 0' } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { color: COLOR[s.status], fontWeight: 600 } }, ICON[s.status] ?? '○'),
          h('strong', { style: { fontSize: 13.5 } }, `${i + 1}. ${s.title}`),
          h('span', { style: { fontSize: 11.5, color: COLOR[s.status] } }, t(`step.${s.status}`)),
          s.attempts > 0 && s.status !== 'ok' && h('span', { style: { fontSize: 11.5, color: C.warn } }, t('attempts', { n: s.attempts + 1 }))),
        h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', margin: '4px 0' } },
          h('span', { style: chip }, s.model), h('span', { style: chip }, t(`access.${s.access}`)),
          s.stop && h('span', { style: chip }, t('chip.stop')), s.important && h('span', { style: chip }, t('chip.important')),
          s.budget && h('span', { style: chip }, t('chip.budget', { t: s.budget.total, l: s.budget.limit }))),
        s.items && h('div', { style: { fontSize: 12, color: C.sub } }, t('items', { ok: s.items.ok, total: s.items.total, failed: s.items.failed ? t('items.failed', { n: s.items.failed }) : '' })),
        s.summary && h('div', { style: { fontSize: 12.5, color: C.text, margin: '3px 0' } }, s.summary),
        s.failure && s.status !== 'ok' && h('div', { style: { fontSize: 12, color: C.err, margin: '3px 0' } }, t('failure', { text: s.failure })),
        h('details', { style: { fontSize: 11.5, color: C.faint } }, h('summary', { style: { cursor: 'pointer' } }, t('checks', { text: `${s.checks.length}` })), s.checks.map((c, k) => h('div', { key: k, style: { fontFamily: 'monospace' } }, c))),
        s.sessions.length > 0 && h('div', { style: { fontSize: 11.5, color: C.sub, display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 } },
          t('sessions'), s.sessions.map((id, k) => h('a', { key: id, href: '#', style: { color: C.link }, onClick: e => { e.preventDefault(); openSession(id); } }, t('session.n', { n: k + 1 })))));
    }

    function Plan({ p, t, act, busy, openSession }) {
      const splitAt = p.steps.findIndex(s => s.split);
      return h('div', { style: { marginBottom: 22 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('h2', { style: { fontSize: 17, margin: 0 } }, p.slug),
          h('span', { style: { fontSize: 12, color: p.status === 'paused' ? C.warn : p.status === 'stopped' ? C.err : p.status === 'done' ? C.ok : C.sub } }, t(`status.${p.status}`), p.reason ? ` — ${reasonText(t, p.reason)}` : '')),
        h('div', { style: { fontSize: 12.5, color: C.sub, margin: '6px 0' } }, h('strong', null, `${t('objective')} : `), p.objective),
        h('div', { style: { fontSize: 11.5, color: C.faint, wordBreak: 'break-all' } }, t('folder', { cwd: p.cwd })),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' } }, Buttons({ p, t, act, busy })),
        p.steps.map((s, i) => h(Step, { key: i, s, i, t, openSession })),
        splitAt >= 0 && h('div', { style: { border: `1px solid ${C.warn}`, borderRadius: 10, padding: 10, margin: '10px 0' } },
          h('div', { style: { fontSize: 13, marginBottom: 6 } }, t('split.title', { i: splitAt + 1 })),
          p.steps[splitAt].split.map((x, k) => h('div', { key: k, style: { margin: '6px 0', fontSize: 12.5 } },
            h('strong', null, `${splitAt + 1}.${k + 1} ${x.title}`), h('div', { style: { color: C.sub } }, x.instructions),
            h('div', { style: { fontFamily: 'monospace', fontSize: 11.5, color: C.faint } }, x.checks.join(' | ')))),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
            h('button', { type: 'button', disabled: busy, style: btn('primary'), onClick: () => act(p.slug, 'acceptSplit') }, t('btn.accept')),
            h('button', { type: 'button', disabled: busy, style: btn('danger'), onClick: () => act(p.slug, 'refuseSplit') }, t('btn.refuse')))),
        p.lessons.length > 0 && h('details', { style: { fontSize: 12, color: C.sub, marginTop: 8 } }, h('summary', { style: { cursor: 'pointer' } }, t('lessons')), p.lessons.map((l, k) => h('div', { key: k }, `• ${l}`))),
        h('details', { style: { fontSize: 11.5, color: C.faint, marginTop: 6 } }, h('summary', { style: { cursor: 'pointer' } }, t('journal')), p.log.map((l, k) => h('div', { key: k, style: { fontFamily: 'monospace' } }, l))));
    }

    function Panel({ sessionId, connection, t, openSession }) {
      const rpc = useRpc(connection);
      const [plans, reload] = usePlans(sessionId, rpc, 2500);
      const { act, busy, error } = useAct(rpc, sessionId, reload, t);
      const list = (plans ?? []).filter(p => p.status !== 'draft').reverse();
      return h('div', { style: { height: '100%', overflow: 'auto', padding: '12px 16px 40px', boxSizing: 'border-box', color: C.text } },
        error && h('div', { role: 'alert', style: { color: C.err, fontSize: 12.5, marginBottom: 8 } }, t('error', { error })),
        list.length ? list.map(p => h(Plan, { key: p.slug, p, t, act, busy, openSession })) : h('p', { style: { fontSize: 13, color: C.sub } }, t('empty')),
        h('p', { style: { fontSize: 11.5, color: C.faint, marginTop: 16 } }, t('note.access')));
    }

    // --- 3. Button on the plan review card -------------------------------------------
    function ReviewButton({ review, sessionId, connection, t, openPanel }) {
      const rpc = useRpc(connection);
      const [plans] = usePlans(sessionId, rpc, 3000);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const p = (plans ?? []).filter(x => x.status === 'ready').at(-1);
      if (!review?.plan || !p) return null;
      const run = async () => {
        setBusy(true); setError(null);
        try { await rpc('action', { sessionId, slug: p.slug, action: 'start', fromReview: true }); openPanel(); }
        catch (e) { setError(reasonText(t, e.message)); }
        setBusy(false);
      };
      return h(React.Fragment, null,
        h('button', { type: 'button', disabled: busy, onClick: run, title: t('review.title', { n: p.steps.length }), 'data-plan-runner': 'run-from-review',
          style: { padding: '5px 10px', borderRadius: 8, border: 'none', background: C.brand, color: C.bg1, cursor: 'pointer', font: 'inherit', fontSize: 13 } },
          t('review.button', { n: p.steps.length })),
        error && h('span', { role: 'alert', style: { color: C.err, fontSize: 12, marginLeft: 6 } }, t('error', { error })));
    }

    function Title({ t }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, '☰ ', t('tab.title'));
    }

    return {
      inject: ['slots', 'locale', 'connection', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => { try { return ctx.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }); } catch { return () => {}; } }, 'plan-runner: french language');
        ctx.effect(() => ctx.locale.register(NS, { zh: en, en }), 'plan-runner: dictionaries');
        ctx.effect(() => { try { return ctx.locale.register(NS, 'fr', fr); } catch { return () => {}; } }, 'plan-runner: french dictionary');
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: PKG, kind: KIND, keepMounted: true, title: () => t('tab.title') }), 'plan-runner: sidebar type');
        const openPanel = sessionId => () => {
          try { if (typeof ctx.sidebarRight.openTabIn === 'function') ctx.sidebarRight.openTabIn(sessionId, KIND); else ctx.sidebarRight.openTab(KIND); }
          catch (e) { console.warn('[dsh-plan-runner] cannot open the panel', e); }
        };
        const openSession = id => { try { ctx.uiWorkspace.openSession(id); } catch (e) { console.warn('[dsh-plan-runner] cannot open the step conversation', e); } };
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: `${PKG}/strip`, order: 7, locale: NS,
          inject: sessionId => ({ sessionId, connection: ctx.connection, t, openPanel: openPanel(sessionId) }),
        }, Strip));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: PKG, locale: NS,
          inject: sessionId => ({ sessionId, connection: ctx.connection, t, openSession }),
        }, Panel));
        ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
          name: 'conversation.plan-review.actions', id: `${PKG}:run`, locale: NS,
          inject: sessionId => ({ sessionId, connection: ctx.connection, t, openPanel: openPanel(sessionId) }),
        }, ReviewButton));
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: PKG, locale: NS, inject: () => ({ t }),
        }, Title));
      },
    };
  },
});
