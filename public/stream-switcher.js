const KEYS = ['main','a','b'];
const FADE_MS = 120;              // 音声切替のクロスフェード時間(ms)。0で瞬時切替
const players = {};
let ready = {main:false, a:false, b:false};
let videoSrc = 'main';
let audioSrc = 'main';
var ecoMode = true;
var linkVideo = false;            // Space で音声と一緒に映像も切り替えるか
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
/* タッチ端末では常時空。この行はエラー表示専用として使う */
function hintDefault(){
  if(isTouch) return '';
  return (linkVideo ? 'Space:映像+音声切替' : 'Space:音声切替') +
         '　1/2/3:映像　L:LIVE　F:全画面　?:ヘルプ';
}
function setStatusLine(msg){
  const el = document.getElementById('hint');
  el.textContent = msg;
  el.classList.add('alert');   // 導入画面では .alert のときだけ表示する
  clearTimeout(setStatusLine._t);
  setStatusLine._t = setTimeout(() => {
    el.textContent = hintDefault();
    el.classList.remove('alert');
  }, 6000);
}

document.getElementById('hint').textContent = hintDefault();

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

/* ---------- 読み込み中オーバーレイ ----------
   入力欄がカードから固定ヘッダーへ移る動きを隠す。実際の読み込みより
   長く見せる必要はないので、最初のプレーヤーが準備できたら即消す。 */
function showLoading(){
  document.getElementById('loading').hidden = false;
  clearTimeout(showLoading._t);
  // 埋め込み拒否などで onReady も onError も来ない場合の保険
  showLoading._t = setTimeout(hideLoading, 15000);
}
function hideLoading(){
  clearTimeout(showLoading._t);
  document.getElementById('loading').hidden = true;
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
  resumeEco();                    // 省帯域の一時解除は持ち越さない
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
        fs:0,                            // プレーヤー側の全画面ボタンを出さない
        iv_load_policy:3,                // アノテーション / カードを出さない
        autoplay:1,
        mute:1,
        origin: location.origin          // エラー153対策
      },
      events:{
        onReady: e => {
          ready[k] = true;
          hideLoading();
          // build() の時点では ready が全て false でアイドルタイマーを
          // 仕掛けられない。再生の準備ができたここで改めて仕掛ける
          scheduleHideChrome();
          showCenter();
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
          hideLoading();
          setStatusLine('[' + k.toUpperCase() + '] ' + msg);
        }
      }
    });
  });
  document.getElementById('splash').classList.add('gone');
  placeSetup();                     // カードから固定ヘッダーの位置へ戻す
  applyOrientationMode();           // 縦=入力欄を常設 / 横=映像優先で出さない
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
  });
  applyEcoLayers();
  // 一時解除中の切り替えは「まだ往復している」合図。戻すまでの時間を延ばす
  if(ecoSuspended) armEcoResume();
  document.querySelectorAll('[data-vid]').forEach(b =>
    b.classList.toggle('on', b.dataset.vid === videoSrc));
}

/* ================================================================
   省帯域モード
   背面のレイヤーを 240x200 まで縮め、YouTube の ABR に低い解像度を
   選ばせて帯域を前面に回す。裏は縮んだ状態で受信しているので、前面へ
   出した直後は解像度が上がりきるまで数秒ぼやける。1回だけの切り替え
   なら気にならないが、Space連動で VC-A ⇄ VC-B を往復されると毎回
   見えてしまうので、往復している間だけ一時解除して裏も原寸で温める。
   往復が止まって ECO_RESUME_MS 経ったら元の省帯域に戻す。
   ================================================================ */
const ECO_RESUME_MS = 90000;      // 省帯域へ戻すまでの無操作時間(ms)
let ecoSuspended = false;
let ecoResumeTimer = null;

function ecoActive(){ return ecoMode && !ecoSuspended; }
function applyEcoLayers(){
  const on = ecoActive();
  KEYS.forEach(x => document.getElementById('layer-'+x)
    .classList.toggle('eco', x !== videoSrc && on));
}
function armEcoResume(){
  clearTimeout(ecoResumeTimer);
  ecoResumeTimer = setTimeout(resumeEco, ECO_RESUME_MS);
}
function suspendEco(){
  if(!ecoMode) return;            // 省帯域を使っていないなら解除するものがない
  if(!ecoSuspended){
    ecoSuspended = true;
    applyEcoLayers();
    renderEco();
  }
  armEcoResume();
}
function resumeEco(){
  clearTimeout(ecoResumeTimer);
  ecoResumeTimer = null;
  if(!ecoSuspended) return;
  ecoSuspended = false;
  applyEcoLayers();
  renderEco();
}
/* ボタンは 塗り=省帯域が効いている / 枠線だけ=設定は ON だが一時解除中 */
function renderEco(){
  const btn = document.getElementById('eco');
  btn.classList.toggle('on', ecoMode);
  btn.classList.toggle('suspended', ecoMode && ecoSuspended);
  btn.title = !ecoMode
    ? '省帯域モード OFF (V)'
    : (ecoSuspended
        ? '省帯域モード ON — Space の連動切替中なので一時解除しています (V)'
        : '省帯域モード ON (V)');
}
function toggleEco(){
  ecoMode = !ecoMode;
  // 手で切り替えたときは一時解除の状態を持ち越さない
  clearTimeout(ecoResumeTimer);
  ecoResumeTimer = null;
  ecoSuspended = false;
  applyEcoLayers();
  renderEco();
  setStatusLine(ecoMode
    ? '省帯域モード ON — 背面を低解像度で受信し、前面に帯域を回します'
    : '省帯域モード OFF — 全本を全解像度で受信します（切替時の画質低下なし）');
}

/* ================================================================
   Space連動
   映像と音声を別々に切り替えるのがこのツールの基本なので、Space は
   既定では音声だけを動かす。1つのキーで画面ごと入れ替えたいという
   配信者向けに、映像も一緒に動かすモードを用意する。
   ================================================================ */
function toggleLinkVideo(){
  linkVideo = !linkVideo;
  const btn = document.getElementById('linkVideo');
  btn.classList.toggle('on', linkVideo);
  btn.setAttribute('aria-pressed', linkVideo ? 'true' : 'false');
  document.getElementById('swap').title = linkVideo
    ? 'VC-A ⇄ VC-B を映像と音声まとめて切り替える (Space)'
    : 'VC-A ⇄ VC-B の音声を切り替える (Space)';
  setStatusLine(linkVideo
    ? 'Space連動 ON — 映像と音声を一緒に切り替えます（往復中は省帯域を一時解除）'
    : 'Space連動 OFF — Space は音声だけを切り替えます');
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
  renderVolume();
}

/* ================================================================
   ミュート
   音量バーの根元のスピーカーが担当する（YouTube などと同じ位置）。
   押すとバーが最小になりミュート、もう一度押すと元の音声に戻る。
   ミュートは音量を 0 にするのではなく音声の選択を none にするので、
   解除したときに元の音量へそのまま戻る。
   ================================================================ */
let preMuteSrc = null;
function firstAudioSrc(){ return KEYS.find(k => players[k]) || 'main'; }
function isMuted(){ return audioSrc === 'none' || masterVol === 0; }
function muteAll(){
  if(audioSrc !== 'none') preMuteSrc = audioSrc;
  applyAudio('none');
}
function unmute(){
  audioUnlocked = true;
  const src = (preMuteSrc && players[preMuteSrc]) ? preMuteSrc : firstAudioSrc();
  preMuteSrc = null;
  if(masterVol === 0) setVolume(100);
  applyAudio(src);
}
function toggleMute(){ isMuted() ? unmute() : muteAll(); }

/* バーとスピーカーの見た目。ミュート中はバーを最小で描く（masterVol は保持） */
function renderVolume(){
  const shown = audioSrc === 'none' ? 0 : masterVol;
  const el = document.getElementById('vol');
  if(el.value != shown) el.value = shown;
  el.style.background =
    'linear-gradient(to right, var(--a) 0%, var(--a) ' + shown + '%, #2b3340 ' + shown + '%, #2b3340 100%)';
  const lab = document.getElementById('volLabel');
  lab.textContent = shown;
  lab.classList.toggle('muted', shown === 0);

  const btn = document.getElementById('volMute');
  const m = isMuted();
  btn.classList.toggle('muted', m);
  btn.title = m ? 'ミュート解除 (M)' : 'ミュート (M)';
  btn.setAttribute('aria-label', m ? 'ミュート解除' : 'ミュート');
}

/* Space: A ⇄ B。MAIN / ミュート / A+B からは VC-A に入る。
   Space連動が ON なら映像も同じ配信へ動かす */
function swapVc(){
  audioUnlocked = true;
  const next = audioSrc === 'a' ? 'b' : 'a';
  if(linkVideo && players[next]){
    suspendEco();                 // 往復で目立つ「切替直後の画質低下」を避ける
    setVideo(next);
  }
  applyAudio(next);
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
  renderVolume();
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
  showCenter();
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

  document.body.classList.toggle('paused', paused);
  const cb = document.getElementById('centerBtn');
  cb.title = paused ? '再生 (K)' : '一時停止 (K)';
  cb.setAttribute('aria-label', paused ? '再生' : '一時停止');
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
    '省帯域      ' + (!ecoMode ? 'OFF' : (ecoSuspended ? 'ON（一時解除中）' : 'ON')) + '\n',
    'Space連動   ' + (linkVideo ? 'ON' : 'OFF')
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
/* PC は映像のどこをクリックしても再生 / 停止（YouTube などと同じ） */
document.getElementById('shield').addEventListener('click', e => {
  if(isTouch) return;   // タッチは画面を触って中央ボタンを出す方式
  // 中央ボタン以外の映像上をクリックしたら上下のUIを隠す
  lastPointer = { x: e.clientX, y: e.clientY };
  hideChromeNow();
});
document.getElementById('shield').addEventListener('pointerdown', e => {
  if(e.pointerType === 'mouse'){ e.preventDefault(); reclaimFocus(); return; }
  if(!centerVisible()) swallowCenterClick = true;
  // 縦画面は操作パネルが出たままなので、中央ボタンだけ出し直す
  if(!autoHideEnabled()){ showCenter(); return; }
  // 横画面は操作パネルごと出し入れする。中央ボタンは映像を触ったここでだけ出す
  if(document.body.classList.contains('chrome-hidden')){ showChrome(); showCenter(); }
  else hideChromeNow();
});
window.addEventListener('focus', () => setTimeout(reclaimFocus, 0));
document.addEventListener('visibilitychange', () => { if(!document.hidden) setTimeout(reclaimFocus, 0); });
document.addEventListener('mousemove', e => {
  lastPointer = { x: e.clientX, y: e.clientY };
  reclaimFocus();
  if(isTouch) return;
  if(suppressFrom){
    if(Math.hypot(e.clientX - suppressFrom.x, e.clientY - suppressFrom.y) < SUPPRESS_PX) return;
    suppressFrom = null;
  }
  showChrome();
}, {passive:true});
document.addEventListener('pointerdown', e => {
  if(e.pointerType === 'touch') return;
  // 映像のクリックは隠す側なので、押した時点で出さない
  if(e.target.id === 'shield') return;
  suppressFrom = null;
  showChrome();
}, {passive:true});
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

/* ================================================================
   UI の自動非表示
   縦画面のスマホでは上下の UI が映像（16:9 の黒帯）に収まるので隠す
   意味がない。横画面は高さが足りず映像を隠すので、タップするまで畳む。
   PC は従来どおりアイドルで畳む（キャプチャ用途）。
   ================================================================ */
const landscapeMQ = matchMedia('(max-height:480px) and (orientation:landscape)');
function autoHideEnabled(){ return !isTouch || landscapeMQ.matches; }
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
  if(!autoHideEnabled()) return false;
  if(!document.getElementById('splash').classList.contains('gone')) return false;
  if(!KEYS.some(k => ready[k])) return false;
  if(chromeInteractive()) return false;
  return true;
}
function showChrome(){
  document.body.classList.remove('chrome-hidden');
  scheduleHideChrome();
  // 中央ボタンはここでは出さない。シークバーなど操作バーを触っただけで
  // 停止ボタンが出るのは邪魔なので、映像を触った / クリックしたときだけ出す
}
function hideChrome(){
  if(!canAutoHideChrome()) return;
  document.body.classList.add('chrome-hidden');
}
/* 明示的に隠したあと、マウスのわずかな震えで出し直さないための起点。
   ここから SUPPRESS_PX 動かすまで mousemove では出さない */
const SUPPRESS_PX = 40;
let lastPointer = null;
let suppressFrom = null;

/* タップやクリック、ボタンによる明示的な格納。アイドル判定を待たない。
   自動非表示が効かなくなったときの逃げ道も兼ねるので、
   canAutoHideChrome() を通さずに必ず隠す */
function hideChromeNow(){
  if(!document.getElementById('splash').classList.contains('gone')) return;
  // 先に畳む。toggleMore / toggleHelp は末尾で showChrome() を呼ぶので順序が重要
  toggleMore(false);
  toggleHelp(false);
  // 入力欄にフォーカスが残っていると chromeInteractive() が真のままになり、
  // 以後アイドルでは二度と畳まれなくなる。ここで外して復帰させる
  const ae = document.activeElement;
  if(ae && ae.tagName === 'INPUT') ae.blur();
  reclaimFocus();
  clearTimeout(uiHideTimer);
  uiHideTimer = null;
  suppressFrom = lastPointer && { x: lastPointer.x, y: lastPointer.y };
  document.body.classList.add('chrome-hidden');
}
/* ================================================================
   動画中央の再生 / 一時停止ボタン
   操作パネルが消える環境（PC・横画面）では、パネルと同時に消える。
   消えない縦画面では、止めた映像をそのまま見られるよう時間で消す。
   ================================================================ */
const CENTER_IDLE_MS = 3000;
let centerTimer = null;
/* 隠れている中央ボタンをタップで出したとき、同じタップの click が
   （pointerdown で pointer-events が戻るため）ボタンに入ってしまう。
   出現させたタップの click だけを 1 回捨てる */
let swallowCenterClick = false;
function centerVisible(){
  return !document.body.classList.contains('center-hidden') &&
         !document.body.classList.contains('chrome-hidden');
}
function showCenter(){
  if(!isTouch) return;   // PC はカーソルが中央に来たとき（CSS の :hover）に出す
  document.body.classList.remove('center-hidden');
  clearTimeout(centerTimer);
  centerTimer = null;
  // 横画面スマホは操作パネルと一緒に消えるので独自タイマーは不要
  if(isTouch && autoHideEnabled()) return;
  if(!document.getElementById('splash').classList.contains('gone')) return;
  if(!KEYS.some(k => ready[k])) return;
  centerTimer = setTimeout(() => document.body.classList.add('center-hidden'), CENTER_IDLE_MS);
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
  // 畳んでいるとき、およびカード内に置いているとき（固定ヘッダーではない）は 0。
  // #nowAudio などの逃げ幅もそれに合わせる
  const h = document.body.classList.contains('setupInCard')
    ? 0
    : Math.round(document.getElementById('setup').getBoundingClientRect().height);
  document.documentElement.style.setProperty('--setupH', h + 'px');
}
/* 狭い画面の導入画面では、注意書きを読んでから入力する順に並べたい。
   #setup を固定ヘッダーから説明カードの中へ移す。読み込んだら元へ戻す。 */
const narrowMQ = matchMedia('(max-width:700px)');
function placeSetup(){
  // file:// では警告表示のためカードの中身ごと差し替えるので触らない
  if(location.protocol === 'file:') return;
  const setup = document.getElementById('setup');
  const slot = document.getElementById('setupSlot');
  const inCard = narrowMQ.matches &&
                 !document.getElementById('splash').classList.contains('gone');
  if(inCard){
    if(setup.parentNode !== slot) slot.appendChild(setup);
  }else if(setup.parentNode === slot){
    document.getElementById('setupAnchor').after(setup);
  }
  document.body.classList.toggle('setupInCard', inCard);
  syncSetupHeight();
}
narrowMQ.addEventListener('change', () => { placeSetup(); applyOrientationMode(); });
function toggleSetup(force){
  const hidden = force !== undefined ? !force : !document.body.classList.contains('setupHidden');
  document.body.classList.toggle('setupHidden', hidden);
  syncSetupHeight();
  showChrome();
}
/* 縦横で UI の方針が変わる。向きの変化と、再生開始時に適用する */
function applyOrientationMode(){
  const auto = autoHideEnabled();
  document.body.classList.toggle('autohide', auto);
  if(!document.getElementById('splash').classList.contains('gone')){
    placeSetup();
    return;
  }
  // 再生中: 縦は入力欄を常設、横は映像優先で出さない
  if(isTouch) toggleSetup(!landscapeMQ.matches);
  auto ? scheduleHideChrome() : showChrome();
}
landscapeMQ.addEventListener('change', applyOrientationMode);
if(window.ResizeObserver) new ResizeObserver(syncSetupHeight).observe(document.getElementById('setup'));
window.addEventListener('resize', syncSetupHeight);
window.addEventListener('orientationchange', () => setTimeout(syncSetupHeight, 250));
placeSetup();
applyOrientationMode();

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
  showLoading();
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
  // 記号だけのボタンなので、完了はチェックの記号に差し替えて示す
  const done = () => {
    this.classList.add('copied');
    this.setAttribute('aria-label', 'コピーしました');
    setTimeout(() => {
      this.classList.remove('copied');
      this.setAttribute('aria-label', '設定リンクをコピー');
    }, 1400);
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
document.getElementById('eco').addEventListener('click', toggleEco);
document.getElementById('linkVideo').addEventListener('click', toggleLinkVideo);
document.getElementById('diagbtn').addEventListener('click', toggleDiag);
document.getElementById('centerBtn').addEventListener('click', () => {
  if(swallowCenterClick) return;   // 出現させたタップでは押さない
  togglePlay();
});
/* バブル段階なので、上のボタンの処理が終わってから解除される。
   ボタン以外を押したタップでもここに来るので取り残されない */
window.addEventListener('click', () => { swallowCenterClick = false; });
document.getElementById('fsBtn').addEventListener('click', toggleFs);
document.getElementById('chromeBtn').addEventListener('click', hideChromeNow);
document.getElementById('toggleMore').addEventListener('click', () => toggleMore());
document.getElementById('helpbtn').addEventListener('click', () => toggleHelp(true));
document.getElementById('helpbtn2').addEventListener('click', () => toggleHelp(true));
document.getElementById('helpclose').addEventListener('click', () => toggleHelp(false));

document.querySelectorAll('[data-vid]').forEach(b => b.addEventListener('click', () => setVideo(b.dataset.vid)));
document.querySelectorAll('[data-aud]').forEach(b => b.addEventListener('click', () => {
  if(b.dataset.aud === 'none'){ toggleMute(); return; }
  audioUnlocked = true;
  applyAudio(b.dataset.aud);
}));
document.querySelectorAll('[data-seek]').forEach(b => b.addEventListener('click', () => seekRelative(parseFloat(b.dataset.seek))));
document.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate))));
document.querySelectorAll('[data-trim]').forEach(b => b.addEventListener('click', () => adjustTrim(b.dataset.trim, parseFloat(b.dataset.d))));

document.getElementById('vol').addEventListener('input', function(){
  // unmute() は renderVolume() でバーを描き直すので、値は先に控えておく
  const v = parseFloat(this.value);
  // ミュート中にバーを動かしたら鳴らす（動かしたのに無音、を避ける）
  if(v > 0 && audioSrc === 'none') unmute();
  setVolume(v);
});
document.getElementById('volMute').addEventListener('click', toggleMute);
setVolume(100);
renderEco();

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
    'm':toggleMute,
    'k':togglePlay, 'l':goLive, 's':toggleLinkVideo, 'v':toggleEco, 'd':toggleDiag,
    'f':toggleFs
  };
  const fn = map[e.key.toLowerCase()];
  if(fn){ e.preventDefault(); fn(); }
}, true);

/* ---------- URLパラメータ: ミュートのまま自動再生 ---------- */
if(KEYS.some(k => fromUrl[k])){
  showLoading();
  const iv = setInterval(() => { if(apiReady){ clearInterval(iv); build(fromUrl); } }, 100);
}
