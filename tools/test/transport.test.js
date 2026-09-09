/* トランスポート（シーク / LIVE / 再生速度）の回帰テスト。

   public/ をそのまま読み込み、YouTube IFrame API だけを偽物に差し替えて
   ヘッドレス Chromium で動かす。偽プレーヤーは本物のライブが持つ厄介な性質を
   再現している（詳細は fake-youtube.js）:
     - getDuration() が再生位置と別の軸の値を返す（序盤は 3600 にパディング）
     - seekTo() が [LIVE端-DVR, LIVE端] にクランプされる
     - 再生が始まるまで getCurrentTime() が 0 を返す
   これらを踏んだうえで「押したとおりに実際に動いたか」を偽プレーヤーの
   再生位置で直接確かめる。画面の表示だけを見ても意味がない —— 表示が実状態と
   ずれたまま平気で嘘をつくのが、ここで潰した不具合そのものだったため。

   実行:
     npm i -g playwright && npx playwright install chromium
     node tools/test/transport.test.js              # public/ を検証
     node tools/test/transport.test.js <publicDir>  # 任意のディレクトリを検証
   Chromium の場所を指定したいときは環境変数 PW_CHROMIUM。 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUB = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'public'));
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-youtube.js'), 'utf8');

const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css',
              '.svg':'image/svg+xml','.png':'image/png','.xml':'text/xml','.txt':'text/plain'};

function serve(dir){
  return new Promise(res => {
    const s = http.createServer((req, rp) => {
      let f = decodeURIComponent(req.url.split('?')[0]);
      if(f === '/') f = '/index.html';
      const p = path.join(dir, f);
      if(!p.startsWith(dir) || !fs.existsSync(p)){ rp.writeHead(404); rp.end(); return; }
      rp.writeHead(200, {'Content-Type': MIME[path.extname(p)] || 'application/octet-stream'});
      rp.end(fs.readFileSync(p));
    }).listen(0, '127.0.0.1', () => res(s));
  });
}

const results = [];
function check(name, ok, detail){
  results.push({name, ok, detail});
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = await serve(PUB);
  const base = 'http://127.0.0.1:' + server.address().port;
  const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
  const browser = await chromium.launch(launchOpts);

  async function session(cfg){
    const ctx = await browser.newContext({ viewport:{width:1280, height:800} });
    await ctx.addInitScript('window.__FAKECFG = ' + JSON.stringify(cfg || {}) + ';');
    await ctx.addInitScript(FAKE);
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('  [pageerror] ' + e.message));
    await page.route('**/iframe_api*', r => r.fulfill({status:200, body:''}));
    await page.goto(base + '/index.html');
    const keys = (cfg && cfg.keys) || ['main'];
    const ids = {main:'AAAAAAAAAAA', a:'BBBBBBBBBBB', b:'CCCCCCCCCCC'};
    for(const k of keys) await page.fill('#u-'+k, 'https://www.youtube.com/watch?v=' + ids[k]);
    await page.click('#load');
    await page.waitForFunction(
      ks => ks.every(k => window.__FAKE.players['p-'+k] && window.__FAKE.players['p-'+k].started),
      keys, {timeout:8000});
    await sleep(2500);   // 起動直後の同期と settle を通す
    return { ctx, page };
  }
  // 「LIVE端からどれだけ後ろにいるか」を偽プレーヤーの実測で出す
  const realOffset = page => page.evaluate(() => {
    const p = window.__FAKE.players['p-main'];
    return p.edge() - p.getCurrentTime();
  });
  const label = page => page.textContent('#offsetLabel');

  console.log('\n=== ' + PUB + ' ===');

  /* 1. ボタンによる相対シーク（◀◀30s） */
  {
    const { ctx, page } = await session();
    const before = await realOffset(page);
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(2500);
    const after = await realOffset(page);
    const moved = after - before;
    check('30秒戻るボタンで、実際に約30秒戻る',
          Math.abs(moved - 30) < 4,
          '実測 ' + moved.toFixed(1) + '秒 戻った（期待 約30秒） / 表示 "' + (await label(page)) + '"');
    await ctx.close();
  }

  /* 2. シークバーのドラッグ（実操作と同じ input→change） */
  {
    const { ctx, page } = await session();
    const before = await realOffset(page);
    // スライダーを左へ動かす = 過去へ。max の 40% ぶん戻す
    const asked = await page.evaluate(() => {
      const s = document.getElementById('scrub');
      const max = parseFloat(s.max);
      const want = Math.round(max * 0.4);            // 戻したい秒数
      s.value = String(max - want);
      s.dispatchEvent(new Event('input', {bubbles:true}));
      s.dispatchEvent(new Event('change', {bubbles:true}));
      return want;
    });
    await sleep(2500);
    const after = await realOffset(page);
    const moved = after - before;
    check('シークバーを引いた分だけ、実際に過去へ戻る',
          Math.abs(moved - asked) < 6,
          '要求 ' + asked + '秒 / 実測 ' + moved.toFixed(1) + '秒 戻った / 表示 "' + (await label(page)) + '"');
    await ctx.close();
  }

  /* 3. 戻った状態が維持され、表示が実測と一致する */
  {
    const { ctx, page } = await session();
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(12000);   // 時間が経っても LIVE へ吸い戻されないこと
    const real = await realOffset(page);
    const shown = await label(page);
    const m = /(\d+):(\d+)/.exec(shown);
    const shownSec = m ? (+m[1]) * 60 + (+m[2]) : 0;
    check('戻った位置が時間が経っても維持され、表示と実測が一致する',
          real > 25 && Math.abs(shownSec - real) < 5,
          '12秒経過後: 実測 ' + real.toFixed(1) + '秒 / 表示 "' + shown + '"');
    await ctx.close();
  }

  /* 4. LIVE ボタンで最先端へ戻れる */
  {
    const { ctx, page } = await session();
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(2500);
    await page.evaluate(() => document.getElementById('golive').click());
    await sleep(2500);
    const real = await realOffset(page);
    check('LIVE ボタンで最先端へ追いつく',
          real < 3 && (await label(page)).indexOf('LIVE') >= 0,
          '実測の遅れ ' + real.toFixed(1) + '秒 / 表示 "' + (await label(page)) + '"');
    await ctx.close();
  }

  /* 5. DVR の外へ要求したとき、UI が嘘をつかない */
  {
    const { ctx, page } = await session({ elapsed: 5400, dvr: 600 });   // 600秒しか戻れない配信
    await page.evaluate(() => {
      const s = document.getElementById('scrub');
      s.value = '0';                                   // いちばん左 = 最大まで過去へ
      s.dispatchEvent(new Event('input', {bubbles:true}));
      s.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await sleep(4000);
    const real = await realOffset(page);
    const shown = await label(page);
    const m = /(\d+):(\d+)/.exec(shown);
    const shownSec = m ? (+m[1]) * 60 + (+m[2]) : 0;
    check('戻れる限界で止まったら、表示も実際の位置に合わせる',
          Math.abs(shownSec - real) < 8,
          '実測 ' + real.toFixed(1) + '秒 / 表示 "' + shown + '"（DVR は 600秒）');
    const hint = await page.textContent('#hint');
    check('戻れなかったことを利用者に伝える',
          /戻れません/.test(hint),
          'ステータス: "' + hint.trim() + '"');
    await ctx.close();
  }

  /* 6. 一時停止すると、その分だけ遅れが増えることが表示に出る */
  {
    const { ctx, page } = await session();
    await page.evaluate(() => document.getElementById('playBtn').click());
    await sleep(6000);
    const real = await realOffset(page);
    const shown = await label(page);
    const m = /(\d+):(\d+)/.exec(shown);
    const shownSec = m ? (+m[1]) * 60 + (+m[2]) : 0;
    check('一時停止中に増えた遅れが表示に反映される',
          real > 4 && Math.abs(shownSec - real) < 4,
          '実測 ' + real.toFixed(1) + '秒 / 表示 "' + shown + '"');
    await ctx.close();
  }

  /* 7. 再生速度を受け付けない配信で、ボタンが嘘をつかない */
  {
    const { ctx, page } = await session({ lockRate: true });
    await page.evaluate(() => document.querySelector('[data-rate="1.5"]').click());
    await sleep(1500);
    const on = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-rate]'))
        .filter(b => b.classList.contains('on')).map(b => b.dataset.rate));
    const hint = await page.textContent('#hint');
    check('速度変更を拒否されたら、ボタンの点灯も実際の速度に合わせる',
          on.length === 1 && on[0] === '1',
          '点灯 [' + on.join(',') + '] / ステータス "' + hint.trim() + '"');
    await ctx.close();
  }

  /* 8. 3本同時: 共通軸で全員が同じだけ戻る */
  {
    const { ctx, page } = await session({ keys: ['main','a','b'] });
    const before = await page.evaluate(() => {
      const o = {};
      for(const k of ['main','a','b']){
        const p = window.__FAKE.players['p-'+k];
        o[k] = p.edge() - p.getCurrentTime();
      }
      return o;
    });
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(2500);
    const after = await page.evaluate(() => {
      const o = {};
      for(const k of ['main','a','b']){
        const p = window.__FAKE.players['p-'+k];
        o[k] = p.edge() - p.getCurrentTime();
      }
      return o;
    });
    const moved = ['main','a','b'].map(k => after[k] - before[k]);
    const spread = Math.max.apply(null, moved) - Math.min.apply(null, moved);
    check('3本同時でも、全員が同じだけ過去へ戻る',
          moved.every(m => Math.abs(m - 30) < 4) && spread < 2,
          'MAIN/A/B の移動量 ' + moved.map(m => m.toFixed(1)).join(' / ') + '秒（ばらつき ' + spread.toFixed(2) + '秒）');
    await ctx.close();
  }

  /* 9. 別の配信を読み込み直したら、遅れとズレ調整を持ち越さない */
  {
    const { ctx, page } = await session();
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await page.evaluate(() => document.querySelector('[data-trim="main"][data-d="0.5"]').click());
    await sleep(2000);
    await page.evaluate(() => {
      document.getElementById('u-main').value = 'https://www.youtube.com/watch?v=DDDDDDDDDDD';
      document.getElementById('load').click();
    });
    await page.waitForFunction(
      () => window.__FAKE.players['p-main'] && window.__FAKE.players['p-main'].videoId === 'DDDDDDDDDDD'
            && window.__FAKE.players['p-main'].started, null, {timeout:8000});
    await sleep(2500);
    const st = await page.evaluate(() => ({
      label: document.getElementById('offsetLabel').textContent,
      trim: document.getElementById('tr-main').textContent,
      real: (() => { const p = window.__FAKE.players['p-main']; return p.edge() - p.getCurrentTime(); })()
    }));
    check('読み込み直しで遅れ・ズレ調整を持ち越さない',
          st.label.indexOf('LIVE') >= 0 && st.trim === '0.0' && st.real < 3,
          '表示 "' + st.label + '" / trim ' + st.trim + ' / 実測の遅れ ' + st.real.toFixed(1) + '秒');
    await ctx.close();
  }

  /* 10. 小さなシークが「LIVE とみなす帯」に飲み込まれない */
  {
    const { ctx, page } = await session();
    await page.evaluate(() => document.querySelector('[data-seek="10"]').click());
    await sleep(6000);
    const real = await realOffset(page);
    const shown = await label(page);
    check('10秒だけ戻したときも、戻したことが表示に残る',
          real > 8 && real < 13 && shown.indexOf('LIVE') < 0 && /0:1\d/.test(shown),
          '実測 ' + real.toFixed(1) + '秒 / 表示 "' + shown + '"');
    await ctx.close();
  }

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
