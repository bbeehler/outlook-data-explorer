/* ---------- sign-in, data loading and access management (Supabase) ---------- */
const SB = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
let IS_ADMIN = false, LOADED_FOR = null;
const INITIAL_HASH = (location.hash || '').slice(1);

function gate(kind, info = {}) {
  document.querySelector('.wrap').classList.add('gated');
  $('#rail').hidden = true; $('#askTop').hidden = true; $('.search').hidden = true;
  const main = $('#main');
  for (const c of main.querySelectorAll('canvas')) { const ch = CHARTS.get(c); if (ch) { ch.destroy(); CHARTS.delete(c); } }
  main.replaceChildren();
  const box = h('section', { class: 'gate', 'aria-live': 'polite' });
  if (kind === 'loading') {
    box.append(h('p', { class: 'gate-muted' }, info.msg || 'Loading the Outlook data…'));
  } else if (kind === 'signin') {
    const form = h('form', { class: 'gate-form' },
      h('label', { for: 'email' }, 'Work email'),
      h('input', { id: 'email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@company.com', value: info.email || '' }),
      h('button', { type: 'submit', class: 'btn-ask' }, 'Email me a sign-in link'));
    const err = h('p', { class: 'gate-err', role: 'alert' }, info.error || '');
    err.hidden = !info.error;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#email').value.trim().toLowerCase();
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Sending…';
      const { error } = await SB.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) {
        btn.disabled = false; btn.textContent = 'Email me a sign-in link';
        err.hidden = false;
        err.textContent = /rate|security purposes|seconds/i.test(error.message) ? 'A link was sent a moment ago. Wait a minute, then try again.' : 'The link could not be sent. Check the address and try again.';
        return;
      }
      gate('sent', { email });
    });
    box.append(h('span', { class: 'eyebrow' }, 'Members and AIA Canada staff'),
      h('h1', {}, 'Sign in to the Outlook Data Explorer'),
      h('p', {}, 'Enter your work email and we’ll send you a sign-in link. No password needed. Access is limited to approved AIA Canada members and staff.'),
      form, err,
      h('p', { class: 'gate-muted' }, `Need access? Contact ${CFG.contactEmail}.`));
  } else if (kind === 'sent') {
    box.append(h('h1', {}, 'Check your email'),
      h('p', {}, h('span', {}, 'We sent a sign-in link to '), h('strong', {}, info.email), h('span', {}, '. Open it on this device. The link works once and expires after an hour.')),
      h('p', { class: 'gate-muted' }, 'No email after a few minutes? Check your junk folder.'),
      h('button', { type: 'button', class: 'act', onclick: () => gate('signin', { email: info.email }) }, 'Use a different email'));
  } else if (kind === 'denied') {
    box.append(h('h1', {}, 'You’re signed in, but not on the access list yet'),
      h('p', {}, h('span', {}, 'You’re signed in as '), h('strong', {}, info.email), h('span', {}, `. The Outlook data is limited to approved members and staff. Ask ${CFG.contactEmail} to add this address, then sign in again.`)),
      h('button', { type: 'button', class: 'act', onclick: signOut }, 'Sign out'));
  } else if (kind === 'error') {
    box.append(h('h1', {}, 'The data could not be loaded'), h('p', {}, 'Check your connection and reload the page.'),
      h('button', { type: 'button', class: 'act', onclick: () => location.reload() }, 'Reload'));
  }
  main.append(box);
}

async function signOut() { await SB.auth.signOut(); LOADED_FOR = null; IS_ADMIN = false; SAMPLE = null; $('#who').hidden = true; gate('signin'); }
$('#signOut').addEventListener('click', signOut);

async function loadApp(session) {
  if (LOADED_FOR === session.user.id) return;
  LOADED_FOR = session.user.id;
  $('#whoEmail').textContent = session.user.email; $('#who').hidden = false;
  gate('loading');
  const { data, error } = await SB.from('outlook_figures').select('payload').eq('edition', '2025').order('sort');
  if (error) { LOADED_FOR = null; gate('error'); return; }
  if (!data.length) { gate('denied', { email: session.user.email }); return; }
  DS = data.map(r => r.payload);
  BYID = Object.fromEntries(DS.map(d => [d.id, d]));
  const adm = await SB.rpc('outlook_is_admin'); IS_ADMIN = adm.data === true;
  DOWNLOADS = { save: async ({ filename, data }) => {
    const url = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000); return { status: 'saved' };
  } };
  document.querySelector('.wrap').classList.remove('gated'); $('#rail').hidden = false; $('.search').hidden = false;
  if (TOPICS.some(t => t.id === INITIAL_HASH)) current = INITIAL_HASH;
  render();
  if (BYID[INITIAL_HASH]) jump(INITIAL_HASH);
  try {
    const r = await askFn({ ping: true });
    if (r.ok && (await r.json()).enabled) { SAMPLE = remoteSample(); $('#askTop').hidden = false; render(); }
  } catch {}
}

async function askFn(body, signal) {
  const { data: { session } } = await SB.auth.getSession();
  return fetch(`${CFG.supabaseUrl}/functions/v1/outlook-ask`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session ? session.access_token : ''}` },
    body: JSON.stringify(body),
  });
}

/* Same shape as the in-Claude sample() so the rest of the page is unchanged */
function remoteSample() {
  const fn = async (turns, opts = {}) => {
    const msgs = [];
    for (const t of (typeof turns === 'string' ? [{ role: 'user', content: turns }] : turns)) {
      const last = msgs[msgs.length - 1];
      if (last && last.role === t.role) last.content += '\n\n' + t.content; else msgs.push({ role: t.role, content: t.content });
    }
    let res;
    try { res = await askFn({ messages: msgs }, opts.signal); }
    catch (e) { throw { code: e && e.name === 'AbortError' ? 'cancelled' : 'upstream_error', message: String(e) }; }
    if (res.status === 429) throw { code: 'rate_limited', message: 'rate limited' };
    if (res.status === 401) throw { code: 'session_expired', message: 'sign in' };
    if (res.status === 403) throw { code: 'not_granted', message: 'no access' };
    if (res.status === 413) throw { code: 'prompt_too_large', message: 'too large' };
    if (!res.ok) throw { code: 'upstream_error', message: 'HTTP ' + res.status };
    const j = await res.json();
    if (!j.text) throw { code: 'empty_completion', message: 'empty' };
    if (opts.onText) opts.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: !!j.truncated, modelTierApplied: 'default' };
  };
  fn.limits = async () => ({ maxPromptBytes: 65536 });
  return fn;
}

/* ---------- access list (admins only) ---------- */
async function renderAccess(main) {
  main.append(h('div', { class: 'topic-head' }, h('span', { class: 'eyebrow' }, 'Admin'), h('h1', {}, 'Manage access'),
    h('p', {}, 'People on this list can sign in with their email and see the Outlook data. Removing someone takes effect the next time they load the page.')));
  const panel = h('section', { class: 'panel' });
  const ta = h('textarea', { id: 'bulk', rows: '4', class: 'bulk', placeholder: 'One or more emails, separated by commas or new lines' });
  const org = h('input', { id: 'bulkOrg', class: 'tsearch', placeholder: 'Organization (optional)' });
  const msg = h('p', { class: 'gate-muted', role: 'status' });
  const add = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
    const emails = [...new Set(ta.value.toLowerCase().split(/[\s,;]+/).map(s => s.trim()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)))];
    if (!emails.length) { msg.textContent = 'Enter at least one valid email address.'; return; }
    add.disabled = true;
    const { error } = await SB.from('outlook_access').upsert(emails.map(email => ({ email, organization: org.value.trim(), source: 'manual' })), { onConflict: 'email', ignoreDuplicates: true });
    add.disabled = false;
    if (error) { msg.textContent = 'Could not add: ' + error.message; return; }
    ta.value = ''; msg.textContent = `Added ${emails.length} ${emails.length === 1 ? 'address' : 'addresses'}. Send them the page link; they sign in with that email.`;
    list();
  } }, 'Add to list');
  panel.append(h('h2', {}, 'Add people by hand'), h('p', { class: 'gate-muted' }, 'For staff, partners or anyone not in Insightly as a member contact.'), ta, h('div', { class: 'chips' }, org, add), msg);
  const listBox = h('section', { class: 'panel' }, h('h2', {}, 'Current list'));
  main.append(panel, listBox);
  const syncBox = h('section', { class: 'panel' });
  main.insertBefore(syncBox, panel);
  async function syncStatus() {
    const { data: runs } = await SB.from('outlook_sync_log').select('started_at, finished_at, ok, member_orgs, member_emails, added, removed, note').order('started_at', { ascending: false }).limit(1);
    const r = runs && runs[0];
    const btn = h('button', { type: 'button', class: 'btn-ask', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Syncing\u2026 (about a minute)';
      try {
        const { data: { session } } = await SB.auth.getSession();
        const res = await fetch(`${CFG.supabaseUrl}/functions/v1/outlook-member-sync`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.supabaseKey, Authorization: `Bearer ${session.access_token}` }, body: '{}' });
        const j = await res.json().catch(() => ({}));
        toast(j.ok ? `Synced: ${j.member_emails} member contacts, ${j.added} added, ${j.removed} removed.` : (j.error || 'The sync did not finish.'));
      } catch { toast('The sync did not finish. Try again in a few minutes.'); }
      syncStatus(); list();
    } }, 'Sync from Insightly now');
    let line;
    if (!r) line = 'No sync has run yet. Member contacts are added automatically once the Insightly key is set up.';
    else if (!r.finished_at) line = `A sync started ${new Date(r.started_at).toLocaleString('en-CA')} and is still running.`;
    else if (r.ok) line = `Last sync ${new Date(r.finished_at).toLocaleString('en-CA')}: ${r.member_orgs} member organisations, ${r.member_emails} contacts with access (${r.added} added, ${r.removed} removed). ${r.note.includes('skipped') ? r.note : ''}`;
    else line = `Last sync failed ${new Date(r.started_at).toLocaleString('en-CA')}: ${r.note}`;
    syncBox.replaceChildren(h('h2', {}, 'Members from Insightly'),
      h('p', { style: 'margin:0;color:var(--ink-2)' }, 'Every contact at an organisation whose Last Membership Year is this year or later gets access automatically. The list refreshes every night, and people are removed when their organisation\u2019s membership lapses. People you add below stay until you remove them.'),
      h('p', { class: 'gate-muted' }, line), h('div', {}, btn));
  }
  syncStatus();
  let q = '';
  async function list() {
    const { data, error } = await SB.from('outlook_access').select('email, full_name, organization, added_at, source').order('organization').order('email').limit(10000);
    const usage = await SB.from('outlook_ai_log').select('id', { count: 'exact', head: true }).gte('asked_at', new Date(Date.now() - 30 * 864e5).toISOString());
    const nIns = data ? data.filter(r => r.source === 'insightly').length : 0;
    listBox.replaceChildren(h('h2', {}, `Current list (${data ? data.length : 0}: ${nIns} from Insightly, ${data ? data.length - nIns : 0} added by hand)`));
    if (usage.count != null) listBox.append(h('p', { class: 'gate-muted' }, `${usage.count} AI questions asked in the last 30 days.`));
    if (error) { listBox.append(h('p', {}, 'Could not load the list.')); return; }
    const search = h('input', { id: 'accessSearch', type: 'search', class: 'tsearch', placeholder: 'Find a person or company', value: q });
    const body = h('tbody', {});
    const draw = () => {
      const f = q.toLowerCase();
      const rows = data.filter(r => !f || (r.email + ' ' + r.full_name + ' ' + r.organization).toLowerCase().includes(f));
      body.replaceChildren(...rows.slice(0, 200).map(r => {
        let act;
        if (r.source === 'insightly') act = h('span', { class: 'gate-muted', title: 'Managed by the nightly Insightly sync' }, 'From Insightly');
        else {
          act = h('button', { type: 'button', class: 'act', onclick: async () => {
            if (act.dataset.armed !== '1') { act.dataset.armed = '1'; act.textContent = 'Confirm remove'; return; }
            act.disabled = true;
            const { error: e2 } = await SB.from('outlook_access').delete().eq('email', r.email);
            if (e2) { act.disabled = false; toast('Could not remove ' + r.email); } else list();
          } }, 'Remove');
        }
        return h('tr', {}, h('th', { scope: 'row' }, r.email), h('td', {}, r.full_name), h('td', {}, r.organization), h('td', {}, new Date(r.added_at).toLocaleDateString('en-CA')), h('td', {}, act));
      }));
      more.textContent = rows.length > 200 ? `Showing 200 of ${rows.length}. Search to narrow the list.` : '';
    };
    const more = h('p', { class: 'gate-muted' });
    search.addEventListener('input', () => { q = search.value; draw(); });
    listBox.append(search, h('div', { class: 'tbl-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Email', 'Name', 'Organization', 'Added', ''].map(c => h('th', { scope: 'col' }, c)))), body)), more);
    draw();
  }
  list();
}

/* ---------- boot ---------- */
(async function boot() {
  const err = new URLSearchParams(location.hash.slice(1)).get('error_description');
  gate('loading', { msg: 'Checking your sign-in…' });
  SB.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) loadApp(session);
    if (event === 'SIGNED_OUT') { LOADED_FOR = null; gate('signin'); }
  });
  const { data: { session } } = await SB.auth.getSession();
  if (session) loadApp(session);
  else gate('signin', { error: err ? 'That sign-in link has expired or was already used. Request a new one.' : '' });
})();