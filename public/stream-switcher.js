const KEYS = ['main','a','b'];
const FADE_MS = 120;              // 音声切替のクロスフェード時間(ms)。0で瞬時切替
const players = {};
let ready = {main:false, a:false, b:false};
let videoSrc = 'main';
let audioSrc = 'main';
var ecoMode = true;
var diagOn = false;

/* ================================================================
   端末判定
   スマホでは (1) キーボードが無い (2) iOS が HTML5 の音量 API を
   無視する (3) iPhone に要素全画面が無い、の3点でUIを変える。
   ================================================================ */
const isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function fsSupported(){
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}
if(isTouch) document.body.classList.add('touch');
/* iOS の <video> 音量はハードウェア固定。効かないスライダーは出さない */
if(isIOS) document.body.classList.add('noVol');
if(!fsSupported()) document.body.classList.add('noFs');

/* ---------- ステータス表示 ---------- */
const HINT_DEFAULT = isTouch
  ? '画面をタップすると操作パネルを表示 / 非表示できます'
  : 'Space:音声切替　1/2/3:映像　L:LIVE　F:全画面　?:ヘルプ';
function setStatusLine(msg){
  const el = document.getElementById('hint');
  el.textContent = msg;
  el.style.color = '#e5484d';
  clearTimeout(setStatusLine._t);
  setStatusLine._t = setTimeout(() => {
    el.textContent = HINT_DEFAULT;
    el.style.color = '';
  }, 6000);
}

document.getElementById('hint').textContent = HINT_DEFAULT;

/* ---------- 動画ID抽出 ---------- */
function extractId(s){
  s = (s||'').trim();
  if(!s) return null;
  const pats = [/youtu\.be\/([\w-]{11})/, /[?&]v=([\w-]{11})/, /embed\/([\w-]{11})/, /live\/([\w-]{11})/];
  for(const p of pats){ const m = s.match(p); if(m) return m[1]; }
  return /^[\w-]{11}$/.test(s) ? s : null;
}

const params = new URLSearchParams(location.search);
const fromUrl = {};
KEYS.forEach(k => {
  fromUrl[k] = extractId(params.get(k));
  if(fromUrl[k]) document.getElementById('u-'+k).value = fromUrl[k];
});

/* ---------- file:// 警告 ---------- */
if(location.protocol === 'file:'){
  window.addEventListener('DOMContentLoaded', () => {
    const card = document.querySelector('#splash .card');
    const h2 = document.createElement('h2');
    h2.style.color = '#e5484d';
    h2.textContent = 'file:// では再生できません';
    const p = document.createElement('p');
    p.className = 'lead';
    const codeCmd = document.createElement('code');
    codeCmd.textContent = 'python -m http.server 8000';
    const codeUrl = document.createElement('code');
    codeUrl.textContent = 'http://localhost:8000/';
    p.append(
      'YouTubeの埋め込みはRefererヘッダーを必要とするため、ファイルを直接開くとエラー153になります。',
      document.createElement('br'),
      'このファイルのあるフォルダで ', codeCmd, ' を実行し、',
      codeUrl, ' から開いてください。'
    );
    card.replaceChildren(h2, p);
  });
}

/* ---------- YouTube API ---------- */
let apiReady = false, pending = null;
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(tag);
window.onYouTubeIframeAPIReady = () => { apiReady = true; if(pending){ build(pending); pending = null; } };

function build(ids){
  paused = false;
  targetOffset = 0;
  audioUnlocked = false;          // 再読み込み時は mute 再生で自動再生を通す
  videoSrc = 'main';
  audioSrc = 'none';              // 起動はミュート。赤いミュートボタンで分かる
  KEYS.forEach(k => {
    if(players[k]){ players[k].destroy(); players[k] = null; }
    ready[k] = false;
    if(!ids[k]) return;
    const holder = document.getElementById('layer-'+k);
    holder.replaceChildren();
    const host = document.createElement('div');
    host.id = 'p-' + k;
    holder.appendChild(host);

    players[k] = new YT.Player(host.id, {
      videoId: ids[k],
      playerVars:{
        rel:0, playsinline:1, controls:0, disablekb:1,
        autoplay:1,
        mute:1,
        origin: location.origin          // エラー153対策
      },
      events:{
        onReady: e => {
          ready[k] = true;
          try{ e.target.getIframe().setAttribute('referrerpolicy','strict-origin-when-cross-origin'); }catch(err){}
          e.target.setVolume(masterVol);
          e.target.mute();
          e.target.playVideo();
          applyAudio(audioSrc, true);
          syncPlayerToLive(k);
        },
        onError: ev => {
          const msg = {
            2:'動画IDが不正です', 5:'プレーヤーの内部エラー',
            100:'動画が見つからない/非公開', 101:'埋め込みが許可されていません',
            150:'埋め込みが許可されていません', 153:'リファラーが送信されていません'
          }[ev.data] || ('エラーコード ' + ev.data);
          setStatusLine('[' + k.toUpperCase() + '] ' + msg);
        }
      }
    });
  });
  document.getElementById('splash').classList.add('gone');
  if(isTouch) toggleSetup(false);   // 狭い画面では映像を優先。「配信URL」で出し直せる
  setVideo(ids.main ? 'main' : (ids.a ? 'a' : 'b'));
  applyAudio(audioSrc, true);
  showChrome();
}

/* ---------- 映像レイヤー ---------- */
function setVideo(k){
  if(!players[k]) return;
  videoSrc = k;
  KEYS.forEach(x => {
    const el = document.getElementById('layer-'+x);
    const isFront = (x === k);
    el.classList.toggle('front', isFront);
    el.classList.toggle('back', !isFront);
    el.classList.toggle('eco', !isFront && ecoMode);
  });
  document.querySelectorAll('[data-vid]').forEach(b =>
    b.classList.toggle('on', b.dataset.vid === videoSrc));
}

function toggleEco(){
  ecoMode = !ecoMode;
  setVideo(videoSrc);
  document.getElementById('eco').classList.toggle('on', ecoMode);
  setStatusLine(ecoMode
    ? '省帯域モード ON — 背面を低解像度で受信し、前面に帯域を回します'
    : '省帯域モード OFF — 全本を全解像度で受信します（切替時の画質低下なし）');
}

/* ---------- 音声 ---------- */
let masterVol = 100;              // 全体音量 (0-100)
const fades = {};
/* クエリURL自動起動など、再生開始前の unmute は自動再生を止めるので初回操作まで待つ */
let audioUnlocked = false;
function canUnmute(){ return audioUnlocked; }
function fadeTo(k, target, instant){
  const p = players[k];
  if(!p || !ready[k]) return;
  clearInterval(fades[k]);
  const wantSound = target > 0 && canUnmute();
  if(instant || FADE_MS <= 0){
    p.setVolume(target);
    wantSound ? p.unMute() : p.mute();
    return;
  }
  let cur;
  try{ cur = p.isMuted() ? 0 : p.getVolume(); }catch(e){ cur = 0; }
  if(wantSound) p.unMute();
  else p.mute();
  const steps = Math.max(1, Math.round(FADE_MS / 20));
  let i = 0;
  fades[k] = setInterval(() => {
    i++;
    try{ p.setVolume(Math.round(cur + (target - cur) * (i / steps))); }catch(e){}
    if(i >= steps){ clearInterval(fades[k]); if(!wantSound) p.mute(); }
  }, 20);
}

function applyAudio(src, instant){
  audioSrc = src;
  const on = src === 'both' ? ['a','b'] : (src === 'none' ? [] : [src]);
  KEYS.forEach(k => fadeTo(k, on.includes(k) ? masterVol : 0, instant));

  document.querySelectorAll('[data-aud]').forEach(b =>
    b.classList.toggle('on', b.dataset.aud === audioSrc));

  const labels = {main:'MAIN 音声', a:'VC-A 音声', b:'VC-B 音声', both:'A + B 同時', none:'ミュート'};
  const colors = {main:'#8b9aa8', a:'#4ea8de', b:'#f2a65a', both:'#7bc47f', none:'#e5484d'};
  document.getElementById('audioLabel').textContent = labels[src];
  const dot = document.querySelector('#nowAudio .dot');
  dot.style.background = colors[src];
  dot.classList.toggle('live', src !== 'none');
}

/* Space: A ⇄ B。MAIN / ミュート / A+B からは VC-A に入る */
function swapVc(){
  audioUnlocked = true;
  applyAudio(audioSrc === 'a' ? 'b' : 'a');
}

/* 全体音量。鳴っているプレーヤーにのみ即時反映する */
function setVolume(v, silent){
  masterVol = Math.max(0, Math.min(100, Math.round(v)));
  const on = audioSrc === 'both' ? ['a','b'] : (audioSrc === 'none' ? [] : [audioSrc]);
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k] || !on.includes(k)) return;
    clearInterval(fades[k]);
    try{
      p.setVolume(masterVol);
      (masterVol > 0 && canUnmute()) ? p.unMute() : p.mute();
    }catch(e){}
  });
  const el = document.getElementById('vol');
  if(el.value != masterVol) el.value = masterVol;
  el.style.background =
    'linear-gradient(to right, var(--a) 0%, var(--a) ' + masterVol + '%, #2b3340 ' + masterVol + '%, #2b3340 100%)';
  const lab = document.getElementById('volLabel');
  lab.textContent = masterVol;
  lab.classList.toggle('muted', masterVol === 0);
}

/* ================================================================
   トランスポート
   各配信は独立したライブなので絶対時刻では揃わない。
   「LIVE最先端からの遅れ秒数」を共通軸にし、全員を同じ量だけ動かす。
   ================================================================ */
let targetOffset = 0;
let paused = false;
let scrubbing = false;
const trim = {main:0, a:0, b:0};

function liveEdge(k){
  const p = players[k];
  if(!p || !ready[k]) return 0;
  try{ return p.getDuration() || 0; }catch(e){ return 0; }
}
/* YouTubeライブは序盤 getDuration() が 3600 などにパディングされ、
   LIVE端でも getDuration()-getCurrentTime() が大きな遅れに見える。
   表示・相対シークは意図した targetOffset を正とする。 */
function seekAll(){
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k]) return;
    const edge = liveEdge(k);
    // duration 未取得のまま seekTo(0) するとライブ先頭へ飛ばされ再生が壊れる
    if(edge <= 0) return;
    try{ p.seekTo(Math.max(0, edge - targetOffset + trim[k]), true); }catch(e){}
  });
}
function seekRelative(delta){
  targetOffset = Math.max(0, targetOffset + delta);
  seekAll();
  renderTransport();
}
function togglePlay(){
  paused = !paused;
  if(!paused) audioUnlocked = true;
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k]) return;
    try{ paused ? p.pauseVideo() : p.playVideo(); }catch(e){}
  });
  if(!paused) applyAudio(audioSrc, true);
  renderTransport();
}
function goLive(){
  audioUnlocked = true;
  targetOffset = 0;
  paused = false;
  seekAll();
  applyAudio(audioSrc, true);
  // unmute 後に再生（順序を逆にするとポリシーで止まることがある）
  KEYS.forEach(k => { if(players[k] && ready[k]) players[k].playVideo(); });
  renderTransport();
}
/* ライブは getDuration() が遅れて入ることがあるので、取れるまで LIVE へ同期を再試行 */
function syncPlayerToLive(k){
  let attempt = 0;
  const tick = () => {
    const p = players[k];
    if(!p || !ready[k]) return;
    const edge = liveEdge(k);
    if(edge > 0){
      try{ p.seekTo(Math.max(0, edge - targetOffset + trim[k]), true); }catch(e){}
      try{ p.playVideo(); }catch(e){}
      renderTransport();
      return;
    }
    try{ p.playVideo(); }catch(e){}
    if(++attempt < 40) setTimeout(tick, 250);
  };
  tick();
}
function setRate(r){
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k]) return;
    try{ p.setPlaybackRate(r); }catch(e){}
  });
  document.querySelectorAll('[data-rate]').forEach(b =>
    b.classList.toggle('on', parseFloat(b.dataset.rate) === r));
}
function adjustTrim(k, d){
  trim[k] = Math.round((trim[k] + d) * 10) / 10;
  document.getElementById('tr-'+k).textContent = trim[k].toFixed(1);
  const p = players[k];
  if(p && ready[k]){
    try{ p.seekTo(Math.max(0, liveEdge(k) - targetOffset + trim[k]), true); }catch(e){}
  }
}
function fmt(sec){
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
}

/* スライダーは 左=過去 / 右=LIVE。表示は targetOffset 基準（上記パディング対策） */
function renderTransport(){
  const scrub = document.getElementById('scrub');
  const durs = KEYS.filter(k => ready[k]).map(k => liveEdge(k)).filter(d => d > 0);
  const span = durs.length ? Math.min(...durs) : 600;
  scrub.max = Math.round(Math.max(60, Math.min(span, 7200)));

  const off = scrubbing ? (scrub.max - parseFloat(scrub.value)) : targetOffset;
  if(!scrubbing) scrub.value = Math.max(0, scrub.max - Math.min(off, scrub.max));

  const pct = scrub.max > 0 ? (scrub.value / scrub.max) * 100 : 0;
  scrub.style.background =
    'linear-gradient(to right, var(--a) 0%, var(--a) ' + pct + '%, #2b3340 ' + pct + '%, #2b3340 100%)';

  const label = document.getElementById('offsetLabel');
  const btn = document.getElementById('golive');
  const atLive = off < 6 && !paused;
  label.textContent = atLive ? 'LIVE' : '− ' + fmt(off);
  btn.classList.toggle('live', atLive);
  // LIVE 中も押せる。表示が LIVE でも実際には数秒遅れていることがある
  btn.setAttribute('aria-label', atLive
    ? 'LIVE を再生中。押すと最先端へ追いつき直します'
    : fmt(off) + ' 遅れて再生中。押すと LIVE へ戻ります');

  document.getElementById('playpause').firstChild.nodeValue = paused ? '▶' : '⏸';
}
setInterval(() => { if(Object.values(ready).some(Boolean)) renderTransport(); }, 300);

/* ================================================================
   診断
   ABRは「CSSピクセルサイズ × devicePixelRatio」で必要解像度を決める。
   モニターやOSスケーリングを変えたときの実効解像度を比較するための表示。
   ================================================================ */
function renderDiag(){
  if(!diagOn) return;
  const el = document.getElementById('layer-' + videoSrc);
  const r = el ? el.getBoundingClientRect() : {width:0, height:0};
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(r.width * dpr), py = Math.round(r.height * dpr);
  const tiers = [2160, 1440, 1080, 720, 480, 360];
  const tier = tiers.find(t => py >= t * 0.95) || 240;

  const diag = document.getElementById('diag');
  const bold = document.createElement('b');
  bold.textContent = px + ' x ' + py;
  const em = document.createElement('em');
  em.textContent = tier + 'p 相当';
  diag.replaceChildren(
    'プレーヤー  ' + Math.round(r.width) + ' x ' + Math.round(r.height) + ' css\n',
    'DPR         ' + dpr.toFixed(2) + '\n',
    '実効解像度  ', bold, ' px\n',
    '要求段階    ', em, '\n',
    '画面        ' + screen.width + ' x ' + screen.height + '\n',
    '省帯域      ' + (ecoMode ? 'ON' : 'OFF')
  );
}
function toggleDiag(){
  diagOn = !diagOn;
  document.getElementById('diag').classList.toggle('show', diagOn);
  document.getElementById('diagbtn').classList.toggle('on', diagOn);
  renderDiag();
}
setInterval(renderDiag, 700);
window.addEventListener('resize', renderDiag);

/* ================================================================
   フォーカス管理
   YouTubeのiframeにフォーカスが移るとキー操作が親ページに届かない。
   シールドでクリックを遮断し、常時ページ側へ引き戻す。
   ================================================================ */
document.body.setAttribute('tabindex','-1');
document.body.style.outline = 'none';

function reclaimFocus(){
  const ae = document.activeElement;
  if(ae && ae.tagName === 'IFRAME'){ try{ ae.blur(); }catch(e){} }
  if(!ae || ae.tagName === 'IFRAME' || ae === document.body){
    try{ document.body.focus({preventScroll:true}); }catch(e){}
  }
}
/* マウスは iframe へのフォーカス移動を止めるだけ。タッチはタップで操作パネルを開閉する */
document.getElementById('shield').addEventListener('pointerdown', e => {
  if(e.pointerType === 'mouse'){ e.preventDefault(); reclaimFocus(); return; }
  toggleChrome();
});
window.addEventListener('focus', () => setTimeout(reclaimFocus, 0));
document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(reclaimFocus, 0); });
document.addEventListener('mousemove', () => { reclaimFocus(); if(!isTouch) showChrome(); }, {passive:true});
document.addEventListener('pointerdown', e => { if(e.pointerType !== 'touch') showChrome(); }, {passive:true});
/* ショートカットキーではメニューを出さない（マウス操作時のみ再表示） */
if(isTouch){
  // タッチには hover が無い。パネルを触るたびに自動非表示までの時間を延長する
  ['bottomChrome','setup'].forEach(id =>
    document.getElementById(id).addEventListener('pointerdown', showChrome, {passive:true}));
}else{
  ['bottomChrome','setup'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('mouseenter', showChrome);
    el.addEventListener('mouseleave', scheduleHideChrome);
  });
}
setInterval(reclaimFocus, 500);

/* ---------- UI（再生中はアイドルで自動非表示） ---------- */
const UI_IDLE_MS = isTouch ? 4500 : 2500;
let uiHideTimer = null;

function chromeInteractive(){
  const ae = document.activeElement;
  if(ae && ae.tagName === 'INPUT') return true;
  if(!isTouch){
    // タッチ端末は :hover がタップ後に貼りつき、自動非表示が永久に効かなくなる
    const bottom = document.getElementById('bottomChrome');
    const setup = document.getElementById('setup');
    if(bottom.matches(':hover') || setup.matches(':hover')) return true;
  }
  if(document.getElementById('help').classList.contains('show')) return true;
  if(!document.getElementById('morePanel').classList.contains('collapsed')) return true;
  return false;
}
function canAutoHideChrome(){
  if(!document.getElementById('splash').classList.contains('gone')) return false;
  if(!KEYS.some(k => ready[k])) return false;
  if(chromeInteractive()) return false;
  return true;
}
function showChrome(){
  document.body.classList.remove('chrome-hidden');
  scheduleHideChrome();
}
function hideChrome(){
  if(!canAutoHideChrome()) return;
  document.body.classList.add('chrome-hidden');
}
/* タップやボタンによる明示的な格納。アイドル判定を待たない */
function hideChromeNow(){
  if(!document.getElementById('splash').classList.contains('gone')) return;
  // 先に畳む。toggleMore / toggleHelp は末尾で showChrome() を呼ぶので順序が重要
  toggleMore(false);
  toggleHelp(false);
  clearTimeout(uiHideTimer);
  uiHideTimer = null;
  document.body.classList.add('chrome-hidden');
}
function toggleChrome(){
  if(document.body.classList.contains('chrome-hidden')) showChrome();
  else hideChromeNow();
}
function scheduleHideChrome(){
  clearTimeout(uiHideTimer);
  uiHideTimer = null;
  if(!canAutoHideChrome()) return;
  uiHideTimer = setTimeout(hideChrome, UI_IDLE_MS);
}

function fsElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
/* スマホでは #setup が3段になる。固定ヘッダーを避ける要素のために実測して配る */
function syncSetupHeight(){
  // 畳んでいるときは 0。#nowAudio などの逃げ幅もそれに合わせる
  const h = Math.round(document.getElementById('setup').getBoundingClientRect().height);
  document.documentElement.style.setProperty('--setupH', h + 'px');
}
function toggleSetup(force){
  const hidden = force !== undefined ? !force : !document.body.classList.contains('setupHidden');
  document.body.classList.toggle('setupHidden', hidden);
  document.getElementById('setupbtn').classList.toggle('on', !hidden);
  syncSetupHeight();
  showChrome();
}
if(window.ResizeObserver) new ResizeObserver(syncSetupHeight).observe(document.getElementById('setup'));
window.addEventListener('resize', syncSetupHeight);
window.addEventListener('orientationchange', () => setTimeout(syncSetupHeight, 250));
syncSetupHeight();

function syncFsButton(){
  const on = !!fsElement();
  const btn = document.getElementById('fsBtn');
  btn.classList.toggle('isFs', on);
  btn.title = on ? '全画面解除 (F)' : '全画面 (F)';
  btn.setAttribute('aria-label', on ? '全画面解除' : '全画面');
}
function toggleFs(){
  if(!fsSupported()) return;
  const el = document.documentElement;
  if(fsElement()){
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }else{
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
}
document.addEventListener('fullscreenchange', syncFsButton);
document.addEventListener('webkitfullscreenchange', syncFsButton);
function toggleMore(force){
  const panel = document.getElementById('morePanel');
  const btn = document.getElementById('toggleMore');
  const open = force !== undefined ? force : panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', !open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  btn.classList.toggle('on', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  showChrome();
}
function toggleHelp(force){
  const el = document.getElementById('help');
  el.classList.toggle('show', force !== undefined ? force : !el.classList.contains('show'));
  showChrome();
}

document.getElementById('load').addEventListener('click', () => {
  const ids = {};
  KEYS.forEach(k => ids[k] = extractId(document.getElementById('u-'+k).value));
  if(!ids.main && !ids.a && !ids.b){ setStatusLine('URLを1つ以上入力してください'); return; }
  if(apiReady) build(ids);
  else pending = ids;
});
document.getElementById('copylink').addEventListener('click', function(){
  const u = new URL(location.href.split('?')[0]);
  KEYS.forEach(k => {
    const id = extractId(document.getElementById('u-'+k).value);
    if(id) u.searchParams.set(k, id);
  });
  const text = u.toString();
  const done = () => {
    this.textContent = 'コピーしました';
    setTimeout(() => this.textContent = '設定リンクをコピー', 1400);
  };
  // clipboard API は非セキュアコンテキストや一部のモバイルブラウザに無い
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, () => setStatusLine('コピーできませんでした: ' + text));
  }else{
    setStatusLine('コピーできませんでした: ' + text);
  }
});

document.getElementById('swap').addEventListener('click', swapVc);
document.getElementById('golive').addEventListener('click', goLive);
document.getElementById('playpause').addEventListener('click', togglePlay);
document.getElementById('eco').addEventListener('click', toggleEco);
document.getElementById('diagbtn').addEventListener('click', toggleDiag);
document.getElementById('fsBtn').addEventListener('click', toggleFs);
document.getElementById('chromeBtn').addEventListener('click', hideChromeNow);
document.getElementById('setupbtn').addEventListener('click', () => toggleSetup());
document.getElementById('toggleMore').addEventListener('click', () => toggleMore());
document.getElementById('helpbtn').addEventListener('click', () => toggleHelp(true));
document.getElementById('helpbtn2').addEventListener('click', () => toggleHelp(true));
document.getElementById('helpclose').addEventListener('click', () => toggleHelp(false));

document.querySelectorAll('[data-vid]').forEach(b => b.addEventListener('click', () => setVideo(b.dataset.vid)));
document.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () => {
  if(b.dataset.aud !== 'none') audioUnlocked = true;
  applyAudio(b.dataset.aud);
}));
document.querySelectorAll('[data-seek]').forEach(b => b.addEventListener('click', () => seekRelative(parseFloat(b.dataset.seek))));
document.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate))));
document.querySelectorAll('[data-trim]').forEach(b => b.addEventListener('click', () => adjustTrim(b.dataset.trim, parseFloat(b.dataset.d))));

document.getElementById('vol').addEventListener('input', function(){ setVolume(this.value); });
setVolume(100);

const scrubEl = document.getElementById('scrub');
scrubEl.addEventListener('input', () => { scrubbing = true; renderTransport(); });
scrubEl.addEventListener('change', () => {
  targetOffset = Math.max(0, parseFloat(scrubEl.max) - parseFloat(scrubEl.value));
  scrubbing = false;
  seekAll();
  renderTransport();
});

/* ---------- ホットキー ---------- */
window.addEventListener('keydown', e => {
  if(e.target.tagName === 'INPUT') return;
  if(e.ctrlKey || e.metaKey || e.altKey) return;   // ブラウザのショートカットを優先
  if(e.key === 'F5') return;

  if(e.key === 'Escape'){ toggleHelp(false); return; }
  if(e.key === '?' || e.key === '/'){ e.preventDefault(); toggleHelp(); return; }
  if(e.code === 'Space'){ e.preventDefault(); swapVc(); return; }
  if(e.key === 'ArrowLeft'){ e.preventDefault(); seekRelative(e.shiftKey ? 30 : 10); return; }
  if(e.key === 'ArrowRight'){ e.preventDefault(); seekRelative(e.shiftKey ? -30 : -10); return; }
  if(e.key === 'ArrowUp'){ e.preventDefault(); setVolume(masterVol + (e.shiftKey ? 1 : 5)); return; }
  if(e.key === 'ArrowDown'){ e.preventDefault(); setVolume(masterVol - (e.shiftKey ? 1 : 5)); return; }

  const map = {
    '1':()=>setVideo('main'), '2':()=>setVideo('a'), '3':()=>setVideo('b'),
    'q':()=>{ audioUnlocked = true; applyAudio('main'); },
    'w':()=>{ audioUnlocked = true; applyAudio('a'); },
    'e':()=>{ audioUnlocked = true; applyAudio('b'); },
    'r':()=>{ audioUnlocked = true; applyAudio('both'); },
    'm':()=>applyAudio('none'),
    'k':togglePlay, 'l':goLive, 'v':toggleEco, 'd':toggleDiag,
    'f':toggleFs
  };
  const fn = map[e.key.toLowerCase()];
  if(fn){ e.preventDefault(); fn(); }
}, true);

/* ---------- URLパラメータ: ミュートのまま自動再生 ---------- */
if(KEYS.some(k => fromUrl[k])){
  const iv = setInterval(() => { if(apiReady){ clearInterval(iv); build(fromUrl); } }, 100);
}
