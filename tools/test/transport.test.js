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
   Chromium の場所を指定したいときは環境変数 PW_CHROMIUM。
   インストール済みの Chrome / Edge を使うなら PW_CHANNEL=chrome（または msedge）。
   この場合 playwright の代わりに playwright-core だけでも動く。 */
let chromium;
try{ ({ chromium } = require('playwright')); }
catch(e){ ({ chromium } = require('playwright-core')); }
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
  const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM }
                   : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
  const browser = await chromium.launch(launchOpts);

  async function session(cfg){
    const ctx = await browser.newContext(
      (cfg && cfg.phone)
        // スマホ想定。isTouch は (hover:none) and (pointer:coarse) で判定される
        ? { viewport:{width:390, height:844}, hasTouch:true, isMobile:true, deviceScaleFactor:3 }
        : { viewport:{width:1280, height:800} });
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
  // アーカイブの「経過 / 全体」。ピルは SYNC 固定なので、位置はこちらで見る
  const posText = page => page.textContent('#posLabel');

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

  /* 11. ズレ微調整: LIVE端でも「戻す」向きは効く */
  {
    const { ctx, page } = await session({ keys: ['main','a'] });
    const gap = () => page.evaluate(() =>
      window.__FAKE.players['p-main'].getCurrentTime() - window.__FAKE.players['p-a'].getCurrentTime());
    const before = await gap();
    await page.evaluate(() => document.querySelector('[data-trim="main"][data-d="-0.5"]').click());
    await sleep(2500);
    const moved = (await gap()) - before;
    check('LIVE端でも、ズレ微調整の「−」は実際に動く',
          Math.abs(moved + 0.5) < 0.15,
          'MAIN が A に対して ' + moved.toFixed(3) + '秒 動いた（期待 -0.5秒） / 表示 '
            + (await page.textContent('#tr-main')));
    await ctx.close();
  }

  /* 12. ズレ微調整: LIVE端では「+」を押せなくする（黙って無反応にしない） */
  {
    const { ctx, page } = await session({ keys: ['main','a'] });
    const plus = '[data-trim="main"][data-d="0.5"]';
    const atLive = await page.evaluate(sel => ({
      disabled: document.querySelector(sel).disabled,
      title: document.querySelector(sel).title
    }), plus);
    check('LIVE端では「+」が無効で、理由が示される',
          atLive.disabled && /追いついている/.test(atLive.title),
          'disabled=' + atLive.disabled + ' / title "' + atLive.title + '"');

    // 戻して見ているあいだは余地があるので押せる
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(2500);
    const behind = await page.evaluate(sel => document.querySelector(sel).disabled, plus);
    const gap = () => page.evaluate(() =>
      window.__FAKE.players['p-main'].getCurrentTime() - window.__FAKE.players['p-a'].getCurrentTime());
    const before = await gap();
    await page.evaluate(sel => document.querySelector(sel).click(), plus);
    await sleep(2500);
    const moved = (await gap()) - before;
    check('戻して見ているあいだは「+」が押せて、実際に動く',
          !behind && Math.abs(moved - 0.5) < 0.15,
          'disabled=' + behind + ' / MAIN が ' + moved.toFixed(3) + '秒 動いた（期待 +0.5秒）');
    await ctx.close();
  }

  /* 13. ズレ微調整は「もう片方を黙って下げる」形にしない */
  {
    const { ctx, page } = await session({ keys: ['main','a','b'] });
    const pos = () => page.evaluate(() => {
      const o = {};
      for(const k of ['main','a','b']) o[k] = window.__FAKE.players['p-'+k].getCurrentTime();
      return o;
    });
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(2500);
    const before = await pos();
    await page.evaluate(() => document.querySelector('[data-trim="main"][data-d="0.5"]').click());
    await sleep(2500);
    const after = await pos();
    const dMain = after.main - before.main - (after.a - before.a);   // A を基準にした MAIN の移動
    const dB = (after.b - before.b) - (after.a - before.a);          // A を基準にした B の移動
    check('触った配信だけが動き、他の配信は動かされない',
          Math.abs(dMain - 0.5) < 0.15 && Math.abs(dB) < 0.15,
          'MAIN ' + dMain.toFixed(3) + '秒 / B ' + dB.toFixed(3) + '秒（B は 0 であるべき）');
    await ctx.close();
  }

  /* 14. ズレ微調整を入れても、LIVE からの遅れ表示は動かない（共通軸から外す） */
  {
    const { ctx, page } = await session({ keys: ['main','a'] });
    const before = await label(page);
    await page.evaluate(() => document.querySelector('[data-trim="main"][data-d="-0.5"]').click());
    await sleep(3000);
    check('ズレ微調整は LIVE からの遅れ表示を動かさない',
          before.indexOf('LIVE') >= 0 && (await label(page)).indexOf('LIVE') >= 0,
          '調整前 "' + before + '" -> 調整後 "' + (await label(page)) + '"');
    await ctx.close();
  }

  /* 15. 巻き戻せない配信が混ざっているとき: 戻せる配信だけ動かし、戻せない配信は LIVE のまま
         （MAIN = DVR 無効、VC-A = DVR 有効。実機で出た組み合わせ） */
  const MAIN_ID = 'AAAAAAAAAAA';
  const offsets = page => page.evaluate(() => {
    const o = {};
    for(const k of ['main','a']){ const p = window.__FAKE.players['p-'+k]; o[k] = p.edge() - p.getCurrentTime(); }
    return o;
  });
  {
    const { ctx, page } = await session({ keys: ['main','a'], noDvr: [MAIN_ID] });
    await page.evaluate(() => {
      const el = document.getElementById('scrub'); const max = parseFloat(el.max);
      el.value = String(max - 60);
      el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
    });
    const hint = await page.textContent('#hint');
    await sleep(4000);
    const o = await offsets(page);
    const shownMain = await label(page);
    check('巻き戻せない配信が混ざっていても、戻せる配信は実際に戻る',
          Math.abs(o.a - 60) < 4 && o.main < 3,
          'VC-A ' + o.a.toFixed(1) + '秒 / MAIN ' + o.main.toFixed(1) + '秒（MAIN は 0 のまま）');
    check('戻せない配信を見ているあいだは LIVE と出し、理由を伝える',
          shownMain.indexOf('LIVE') >= 0 && /MAIN は配信者が巻き戻しを無効/.test(hint),
          '表示 "' + shownMain + '" / ステータス "' + hint.trim() + '"');
    await page.evaluate(() => setVideo('a'));
    await sleep(800);
    const shownA = await label(page);
    check('戻せる配信に映像を切り替えると、その配信の遅れが出る',
          /− 1:0\d/.test(shownA),
          '映像を VC-A にした表示 "' + shownA + '"');
    await ctx.close();
  }

  /* 16. 上の状態から LIVE を押すと、戻っていた配信も LIVE端へ戻る。
         以前は MAIN の実測で全配信の LIVE端を貼り直していたため、VC-A が
         60秒遅れたまま「LIVE端にいる」と記録され、LIVE を押しても戻らなかった */
  {
    const { ctx, page } = await session({ keys: ['main','a'], noDvr: [MAIN_ID] });
    await page.evaluate(() => document.querySelector('[data-seek="30"]').click());
    await sleep(6000);                          // 突き合わせ処理を何周か通す
    const mid = await offsets(page);
    await page.evaluate(() => document.getElementById('golive').click());
    await sleep(4000);
    const o = await offsets(page);
    check('戻せない配信と混在していても、LIVE で全配信が LIVE端へ戻る',
          mid.a > 25 && o.a < 3 && o.main < 3,
          'LIVE 前 VC-A ' + mid.a.toFixed(1) + '秒 → LIVE 後 VC-A ' + o.a.toFixed(1) + '秒 / MAIN ' + o.main.toFixed(1) + '秒');
    await ctx.close();
  }

  /* 17. 全配信が巻き戻せないなら、シーク系の操作を押せなくする */
  {
    const { ctx, page } = await session({ keys: ['main'], noDvr: [MAIN_ID] });
    const st = await page.evaluate(() => ({
      scrub: document.getElementById('scrub').disabled,
      seek: Array.from(document.querySelectorAll('[data-seek]')).every(b => b.disabled),
      title: document.getElementById('scrub').title
    }));
    check('全配信が巻き戻せないと、シークバーと秒送りが無効になり理由が出る',
          st.scrub && st.seek && /巻き戻しを無効/.test(st.title),
          'scrub.disabled=' + st.scrub + ' / 秒送り disabled=' + st.seek + ' / title "' + st.title + '"');
    await ctx.close();
  }

  /* 18. 巻き戻せない配信のズレ微調整は押せない */
  {
    const { ctx, page } = await session({ keys: ['main','a'], noDvr: [MAIN_ID] });
    const st = await page.evaluate(() => ({
      mainMinus: document.querySelector('[data-trim="main"][data-d="-0.5"]').disabled,
      aMinus: document.querySelector('[data-trim="a"][data-d="-0.5"]').disabled
    }));
    check('巻き戻せない配信のズレ微調整は無効、戻せる配信は押せる',
          st.mainMinus && !st.aMinus,
          'MAIN − disabled=' + st.mainMinus + ' / VC-A − disabled=' + st.aMinus);
    await ctx.close();
  }

  /* 19. アーカイブ（配信済みの動画）は普通の動画として扱う。
         配信中に DVR を無効にしていた配信でも、終わったあと読み込めば戻せる。
         以前は「配信中かどうか」を見ずに LIVE端を推定し続けていたため、
         シークバーが動画の長さぶん開かず、実質どこへも動かせなかった */
  {
    const { ctx, page } = await session({ keys: ['main'], noDvr: [MAIN_ID], archive: [MAIN_ID] });
    const st = await page.evaluate(() => ({
      disabled: document.getElementById('scrub').disabled,
      span: parseFloat(document.getElementById('scrub').max)
    }));
    check('DVR を無効にしていた配信でも、アーカイブなら触れて長さぶん開く',
          !st.disabled && Math.abs(st.span - 600) < 20,
          'scrub.disabled=' + st.disabled + ' / 幅 ' + st.span + '秒（動画の長さ 600秒）');

    // 終端の 60秒前へ動かす
    await page.evaluate(() => {
      const el = document.getElementById('scrub'); const max = parseFloat(el.max);
      el.value = String(max - 60);
      el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await sleep(1500);
    const at = await page.evaluate(() => window.__FAKE.players['p-main'].getCurrentTime());
    check('アーカイブはシークバーで指した位置へ実際に動く',
          Math.abs(at - 540) < 8,
          '再生位置 ' + at.toFixed(1) + '秒（終端 600秒の 60秒前であるべき）');
    await ctx.close();
  }

  /* 20. アーカイブの終端は伸びない。一時停止しても遅れ表示が増えないこと。
         LIVE端の推定（実時間で1倍速に外挿）をアーカイブにも使うと、止めている
         あいだ中ずっと遅れが増え続ける */
  {
    const { ctx, page } = await session({ keys: ['main'], archive: [MAIN_ID] });
    await page.evaluate(() => document.getElementById('playBtn').click());
    await sleep(1000);
    const a = await posText(page);
    await sleep(4000);
    const b = await posText(page);
    check('アーカイブを一時停止しても遅れ表示が増えていかない',
          a === b,
          '停止直後 "' + a + '" → 4秒後 "' + b + '"');
    await ctx.close();
  }

  /* 21. アーカイブは動画として見る。頭（左端）から始まり、ラベルは終端までの
         残りではなく経過時間。LIVE バッジも出さない */
  {
    const { ctx, page } = await session({ keys: ['main'], archive: [MAIN_ID] });
    const st = await page.evaluate(() => ({
      pos: document.getElementById('posLabel').textContent,
      posHidden: document.getElementById('posLabel').hidden,
      live: document.getElementById('golive').classList.contains('live'),
      btnHidden: document.getElementById('golive').hidden,
      value: parseFloat(document.getElementById('scrub').value),
      max: parseFloat(document.getElementById('scrub').max)
    }));
    check('アーカイブはスライダーの左端（先頭）から始まり、経過 / 全体を出す',
          st.value < 20 && st.max > 500 && !st.posHidden && /^0:\d\d \/ 10:00$/.test(st.pos),
          'つまみ ' + st.value + ' / ' + st.max + ' / 表示 "' + st.pos + '"');
    check('アーカイブでは LIVE バッジを出さず、1本だけなら SYNC も出さない',
          !st.live && st.btnHidden,
          'live クラス=' + st.live + ' / SYNC hidden=' + st.btnHidden);
    await ctx.close();
  }

  /* 22. 2時間を超えるアーカイブでも、スライダーは動画の長さぶん開く。
         2時間の頭打ちはライブでさかのぼれる範囲の目安で、動画には関係ない */
  {
    const { ctx, page } = await session({ keys: ['main'], archive: [MAIN_ID], elapsed: 10000 });
    const max = await page.evaluate(() => parseFloat(document.getElementById('scrub').max));
    check('2時間を超えるアーカイブでもスライダーが長さぶん開く',
          Math.abs(max - 10000) < 60,
          '幅 ' + max + '秒（動画の長さ 10000秒）');
    await ctx.close();
  }

  // 要素ごと無いとき（この機能が入る前のコード）は「出ていない」とみなす
  const noteHidden = page => page.evaluate(() => {
    const el = document.getElementById('endedNote');
    return !el || el.hidden;
  });

  /* 23. 配信が終わったら、そのことを映像の上に出す。巻き戻せるかどうかとは
         関係なく出し、巻き戻し始めたら（シークバーに触れたら）消す */
  for(const noDvr of [[], [MAIN_ID]]){
    const { ctx, page } = await session({ keys: ['main'], noDvr });
    const before = await noteHidden(page);
    await page.evaluate(() => window.__FAKE.players['p-main'].endStream());
    await sleep(800);
    const after = await noteHidden(page);
    check('配信が終わったら「配信は終了しました」を出す' + (noDvr.length ? '（巻き戻せない配信でも）' : ''),
          before && !after,
          '配信中 hidden=' + before + ' → 終了後 hidden=' + after);
    await ctx.close();
  }
  {
    const { ctx, page } = await session({ keys: ['main'] });
    await page.evaluate(() => window.__FAKE.players['p-main'].endStream());
    await sleep(800);
    await page.evaluate(() => {
      const el = document.getElementById('scrub');
      el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
    });
    await sleep(600);
    const gone = await noteHidden(page);
    check('シークバーに触れたら「配信は終了しました」は消える',
          gone, 'hidden=' + gone);
    await ctx.close();
  }

  /* 24. アーカイブの同時視聴。動画ごとに開始時刻が違うので、
         「まとめてシーク」を切って1本ずつ頭出しし、戻せばズレを保ったまま
         一緒に動く。揃え直したいときは SYNC */
  {
    const A_ID = 'BBBBBBBBBBB';
    const { ctx, page } = await session({
      keys: ['main','a'], archive: [MAIN_ID, A_ID],
      lengths: {[MAIN_ID]: 900, [A_ID]: 1500}     // 長さが違う動画どうし
    });
    const pos = () => page.evaluate(() => {
      const o = {};
      for(const k of ['main','a']) o[k] = window.__FAKE.players['p-'+k].getCurrentTime();
      return o;
    });
    const seekTo = v => page.evaluate(val => {
      const el = document.getElementById('scrub');
      el.value = String(val);
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    }, v);

    const maxAtMain = await page.evaluate(() => parseFloat(document.getElementById('scrub').max));
    check('シークバーの幅は、見ている動画自身の長さになる',
          Math.abs(maxAtMain - 900) < 60,
          '幅 ' + maxAtMain + '秒（MAIN の長さ 900秒 / VC-A は 1500秒）');

    // まとめてシークを切って、見ている動画だけ頭出しする
    await page.evaluate(() => document.getElementById('groupSeek').click());
    await seekTo(120);
    await sleep(1200);
    const solo = await pos();
    check('まとめてシーク OFF なら、今映している動画だけが動く',
          Math.abs(solo.main - 120) < 8 && solo.a < 40,
          'MAIN ' + solo.main.toFixed(1) + '秒 / VC-A ' + solo.a.toFixed(1) + '秒（VC-A は動かない）');

    // 戻すと、付けたズレを保ったまま一緒に動く
    await page.evaluate(() => document.getElementById('groupSeek').click());
    const before = await pos();
    await seekTo(300);
    await sleep(1200);
    const after = await pos();
    const gap0 = before.main - before.a, gap1 = after.main - after.a;
    check('まとめてシーク ON なら、ズレを保ったまま全部が同じだけ動く',
          Math.abs(after.main - 300) < 8 && Math.abs(gap1 - gap0) < 8,
          'MAIN ' + after.main.toFixed(1) + '秒 / ズレ ' + gap0.toFixed(1) + '秒 → ' + gap1.toFixed(1) + '秒');

    // SYNC で揃え直す
    await page.evaluate(() => document.getElementById('golive').click());
    await sleep(1200);
    const synced = await pos();
    check('SYNC で、他の動画が今映している動画と同じ位置に揃う',
          Math.abs(synced.main - synced.a) < 8,
          'MAIN ' + synced.main.toFixed(1) + '秒 / VC-A ' + synced.a.toFixed(1) + '秒');
    await ctx.close();
  }

  /* 25. スマホでシークバーが画面幅のほとんどを取ること。数時間のアーカイブを
         指で送るので、幅がそのまま操作精度になる。操作類（再生 / 連動 /
         経過 / SYNC）と同じ行に並べると、バーが画面の半分も無くなっていた */
  {
    const { ctx, page } = await session({ keys: ['main','a'], archive: [MAIN_ID], phone: true });
    const m = await page.evaluate(() => {
      const r = document.getElementById('scrub').getBoundingClientRect();
      const pill = document.getElementById('golive').getBoundingClientRect();
      return { w: r.width, vw: window.innerWidth, barBottom: r.bottom, pillTop: pill.top };
    });
    check('スマホではシークバーが画面幅のほとんどを取る',
          m.w / m.vw > 0.8,
          'バー ' + Math.round(m.w) + 'px / 画面 ' + m.vw + 'px（'
            + Math.round(m.w / m.vw * 100) + '%）');
    check('スマホではシークバーと操作類が同じ行に並ばない',
          m.barBottom <= m.pillTop + 1,
          'バーの下端 ' + Math.round(m.barBottom) + 'px / ボタンの上端 ' + Math.round(m.pillTop) + 'px');
    await ctx.close();
  }

  /* 26. ズレを付けているあいだは、動画ごとのシークバーを並べて見せる。
         鎖アイコンだけでは「別々の位置で再生している」「連動している」が
         伝わらないので、状態を絵にする */
  {
    const A_ID = 'BBBBBBBBBBB';
    const { ctx, page } = await session({
      keys: ['main','a'], archive: [MAIN_ID, A_ID],
      lengths: {[MAIN_ID]: 900, [A_ID]: 1500}
    });
    const view = () => page.evaluate(() => ({
      multi: !document.getElementById('multiScrub').hidden,
      rows: Array.from(document.querySelectorAll('#multiScrub .msRow')).filter(r => !r.hidden).length,
      single: !document.getElementById('scrub').hidden,
      linked: document.getElementById('multiScrub').classList.contains('linked')
    }));
    const pos = () => page.evaluate(() => {
      const o = {};
      for(const k of ['main','a']) o[k] = window.__FAKE.players['p-'+k].getCurrentTime();
      return o;
    });
    const dragRow = (k, v) => page.evaluate(([key, val]) => {
      const bar = document.querySelector('#multiScrub .msRow[data-ms="' + key + '"] input');
      bar.value = String(val);
      bar.dispatchEvent(new Event('input', {bubbles:true}));
      bar.dispatchEvent(new Event('change', {bubbles:true}));
    }, [k, v]);
    const toggleLink = () => page.evaluate(() => document.getElementById('groupSeek').click());

    const v0 = await view();
    check('既定（ズレ無し・連動）ではシークバーは1本のまま',
          v0.single && !v0.multi,
          '共通バー=' + v0.single + ' / 動画ごと=' + v0.multi);

    await toggleLink();                       // 連動を切る = ズレを付けにいく
    const v1 = await view();
    check('連動を切ると、読み込んでいる動画のぶんだけバーが並ぶ',
          v1.multi && v1.rows === 2 && !v1.single && !v1.linked,
          '動画ごと=' + v1.multi + ' / 本数=' + v1.rows + ' / 共通バー=' + v1.single
            + ' / 緑枠=' + v1.linked);

    await dragRow('main', 120);               // MAIN だけ頭出し
    await sleep(1200);
    const solo = await pos();
    check('並んだバーは、掴んだ動画だけを動かす',
          Math.abs(solo.main - 120) < 8 && solo.a < 40,
          'MAIN ' + solo.main.toFixed(1) + '秒 / VC-A ' + solo.a.toFixed(1) + '秒');

    await toggleLink();                       // 連動に戻す
    const v2 = await view();
    check('連動に戻してもバーは並んだまま（つまみが緑枠になる）',
          v2.multi && v2.linked,
          '動画ごと=' + v2.multi + ' / 緑枠=' + v2.linked);

    const before = await pos();
    await dragRow('main', 300);
    await sleep(1200);
    const after = await pos();
    const gap0 = before.main - before.a, gap1 = after.main - after.a;
    check('連動中は、1本を動かすと残りもズレを保ったまま動く',
          Math.abs(after.main - 300) < 8 && Math.abs(gap1 - gap0) < 8
            && after.a - before.a > 150,
          'MAIN ' + after.main.toFixed(1) + '秒 / VC-A ' + before.a.toFixed(1) + ' → '
            + after.a.toFixed(1) + '秒 / ズレ ' + gap0.toFixed(1) + ' → ' + gap1.toFixed(1) + '秒');

    await page.evaluate(() => document.getElementById('golive').click());   // SYNC
    await sleep(1200);
    const v3 = await view();
    const synced = await pos();
    check('SYNC で揃えるとバーは1本に畳まれる',
          v3.single && !v3.multi && Math.abs(synced.main - synced.a) < 8,
          '共通バー=' + v3.single + ' / 動画ごと=' + v3.multi
            + ' / MAIN ' + synced.main.toFixed(1) + '秒 VC-A ' + synced.a.toFixed(1) + '秒');
    await ctx.close();
  }

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
