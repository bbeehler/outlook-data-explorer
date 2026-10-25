// Research Hub browser test (WebKit = Safari's engine, plus Chromium for comparison). Uses synthetic data and the public economy file.
// Clicks legend options and Table/Chart on charts and checks the chart is still drawn (including real pixels on the canvas).
const { webkit, chromium } = require('playwright');
const fs = require('fs');
const FX = JSON.parse(fs.readFileSync(__dirname + '/fixtures.json', 'utf8'));
const SB = 'https://bbrdihxafpgexnfvkshl.supabase.co';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'u1', email: 'test@example.com', exp, role: 'authenticated', aud: 'authenticated' }) + '.sig';
const session = { access_token: jwt, refresh_token: 'r', expires_at: exp, expires_in: 3600, token_type: 'bearer', user: { id: 'u1', email: 'test@example.com', aud: 'authenticated', role: 'authenticated' } };
const REP = { id: 'R1', slug: 'test-report', title: 'Test report (synthetic)', series: 'Test', published_on: '2026-03-01', summary: 'Synthetic data.', key_findings: [], source_url: '', status: 'published',
  sections: [{ key: 's1', name: 'Section one', blurb: '' }, { key: 's2', name: 'Section two', blurb: '' }] };
const out = [];
const log = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); out.push(s); try { fs.appendFileSync(`${process.env.OUT}/results.txt`, s + '\n'); } catch {} };
(async () => {
  for (const [name, type, opts] of [['webkit-desktop', webkit, { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 }], ['webkit-iphone', webkit, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }], ['chromium-desktop', chromium, { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 }]]) {
    const br = await type.launch(); const ctx = await br.newContext(opts); const p = await ctx.newPage(); const errs = [];
    try {
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
    await p.route(SB + '/**', r => {
      const u = decodeURIComponent(r.request().url()); const m = r.request().method();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
      if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      const single = (r.request().headers()['accept'] || '').includes('vnd.pgrst.object');
      const j = o => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(single && Array.isArray(o) ? o[0] : o) });
      if (u.includes('/rest/v1/outlook_figures')) return j(FX.outlook);
      if (u.includes('/rpc/outlook_is_admin')) return j(false);
      if (u.includes('/rest/v1/hub_reports')) return j([REP]);
      if (u.includes('/rest/v1/hub_figures')) return j(FX.figs);
      if (u.includes('/functions/v1/outlook-ask')) return j({ enabled: false });
      return j([]);
    });
    await p.addInitScript(s => localStorage.setItem('sb-bbrdihxafpgexnfvkshl-auth-token', s), JSON.stringify(session));
    await p.goto('http://localhost:8000/'); await p.waitForTimeout(2500);
    // pixels: count non-transparent pixels in the chart's canvas
    const state = (card) => p.evaluate(sel => { const c = document.querySelectorAll('article.card')[sel]; const cv = c && c.querySelector('.cv canvas'); if (!cv) return { canvas: false };
      const ch = Chart.getChart(cv); let ink = 0; try { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 16) if (d[i]) ink++; } catch (e) { ink = 'err ' + e.message; }
      return { drawn: !!ch, w: cv.width, h: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight, datasets: ch ? ch.data.datasets.length : 0, ink }; }, card);
    for (const page of ['macro', 'r:test-report~s1']) {
      await p.evaluate(id => go(id), page); await p.waitForTimeout(1200);
      log(name, page, 'start', await state(0));
      const lg = p.locator('article.card').first().locator('.legend .lg');
      if (await lg.count() > 1) {
        await lg.nth(0).click(); await p.waitForTimeout(150); log(name, page, 'legend 1 off +150ms', await state(0));
        await p.waitForTimeout(1500); log(name, page, 'legend 1 off +1.6s', await state(0));
        await lg.nth(0).click(); await p.waitForTimeout(800); log(name, page, 'legend 1 back on', await state(0));
      }
      if (await lg.count() > 1) {
        await lg.nth(1).click(); await p.waitForTimeout(400);
        await p.mouse.click(5, 300); await p.waitForTimeout(800); log(name, page, 'option off, then click elsewhere on page', await state(0));
        await p.evaluate(() => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); }); await p.waitForTimeout(900);
        log(name, page, 'option off, then window loses and regains focus', await state(0));
        await p.mouse.wheel(0, 900); await p.waitForTimeout(500); await p.mouse.wheel(0, -900); await p.waitForTimeout(900);
        log(name, page, 'option off, then scroll away and back', await state(0));
        await p.locator('article.card h2').first().click({ timeout: 3000 }).catch(() => {}); await p.waitForTimeout(600);
        log(name, page, 'option off, then click the chart title', await state(0));
        await p.locator('article.card .cv canvas').first().click({ position: { x: 50, y: 50 }, timeout: 3000 }).catch(() => {}); await p.waitForTimeout(600);
        log(name, page, 'option off, then click inside the chart', await state(0));
        await lg.nth(1).click(); await p.waitForTimeout(600);
      }
      await p.locator('article.card').first().locator('.seg button', { hasText: 'Table' }).click(); await p.waitForTimeout(300);
      await p.locator('article.card').first().locator('.seg button', { hasText: 'Chart' }).click(); await p.waitForTimeout(800);
      log(name, page, 'after Table then Chart', await state(0));
      await p.screenshot({ path: `${process.env.OUT}/${name}-${page.replace(/[^a-z0-9]/gi, '_')}.png` });
    }
    } catch (e) { log(name, 'TEST STEP FAILED', String(e.message || e).split('\n')[0]); }
    log(name, 'errors', errs.slice(0, 8));
    await br.close();
  }
})();
