const KEYS = ['main','a','b'];
const FADE_MS = 120;              // 音声切替のクロスフェード時間(ms)。0で瞬時切替
const players = {};
let ready = {main:false, a:false, b:false};
let videoSrc = 'main';
/* 鳴らしている配信。KEYS の並びで持つ。空 = ミュート。
   同時再生モードでは最大3本まで入る */
let audioKeys = [];
/* ミュート（音量0）。鳴らす配信の選択とは独立させる。選択を空にして
   しまうと、音量を戻したとき何が鳴るのかが画面から分からなくなる */
var muted = false;
/* 共有URLから開いたときの「ジェスチャーが無く鳴らせない」状態。
   ミュート解除チップを出すかどうかの判定に使う。unmute() で消える */
var pendingUnmute = false;
var mixMode = false;              // 同時再生（複数を混ぜる）モード
var linkVideo = true;             // Space で音声と一緒に映像も切り替えるか
var diagOn = false;

/* ================================================================
   端末判定
   スマホでは (1) キーボードが無い (2) iOS が HTML5 の音量 API を
   無視する (3) iPhone に要素全画面が無い、の3点でUIを変える。
   ================================================================ */
const isTouch = matchMedia('(hover:none) and (pointer:coarse)').matches;
/* 省帯域は元々モバイル回線の通信量対策。PC は大抵ワイヤード / 安定
   Wi-Fi で3本同時でも問題になりにくく、むしろ切替直後にぼやける方が
   気になるため、既定は「タッチ端末だけ ON」にする（ボタン自体、
   タッチ端末では常に ON 固定で表示すらしない）。PC でも会場Wi-Fiや
   テザリング利用など通信量が気になる場合は手動で ON にできる */
var ecoMode = isTouch;
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

/* ---------- ステータス表示 ----------
   映像にかぶるので常設のガイドは置かない。エラーのときだけ出して、
   数秒で消す（操作の結果はボタンやスイッチの見た目が示す）。
   ショートカットの一覧はヘルプ（?）にある。 */
function setStatusLine(msg){
  const el = document.getElementById('hint');
  el.textContent = msg;
  el.classList.add('alert');   // 導入画面では .alert のときだけ表示する
  clearTimeout(setStatusLine._t);
  setStatusLine._t = setTimeout(() => {
    el.textContent = '';
    el.classList.remove('alert');
  }, 6000);
}

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
let apiReady = false, pending = null, pendingSound = false;
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(tag);
window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
  if(pending){ build(pending, pendingSound); pending = null; }
};

/* 読み込んだ動画ID。getVideoData() が本当にこの動画のものかを照合する */
const loadedId = {main:null, a:null, b:null};

/* withSound: 読み込むボタン経由。クリック済みでブラウザの自動再生の
   条件を満たしているので、最初から音を出せる。共有URLから開いたときは
   ジェスチャーが無いので、音を止めたまま始めてチップで解除してもらう */
function build(ids, withSound){
  resetTransport();               // 遅れ・trim・実状態の記録を持ち越さない
  audioUnlocked = !!withSound;
  resumeEco();                    // 省帯域の一時解除は持ち越さない
  videoSrc = 'main';
  audioKeys = [];
  muted = false;
  pendingUnmute = false;
  KEYS.forEach(k => {
    if(players[k]){ players[k].destroy(); players[k] = null; }
    ready[k] = false;
    loadedId[k] = null;
    if(!ids[k]) return;
    loadedId[k] = ids[k];         // getVideoData() が本物か照合するために覚える
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
          e.target.setVolume(vol[k]);
          e.target.mute();
          e.target.playVideo();
          applyAudio(audioKeys, true);
          syncPlayerToLive(k);
        },
        /* 実状態の記録。UI は「押した結果」ではなくこれを見て描く
           （reconcileTransport）。自動再生ポリシーで再生が止められた、
           シークがクランプされた、といった食い違いを画面に出すため */
        onStateChange: ev => {
          stateOf[k] = ev.data;
          // 再生が始まった位置は、描画のタイマーを待たずにここで採る
          if(ev.data === ST.PLAYING) noteFirstPos(k);
          renderTransport();
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
  renderAvailability();             // 読み込まなかった配信のボタンを落とす
  document.getElementById('splash').classList.add('gone');
  placeSetup();                     // カードから固定ヘッダーの位置へ戻す
  applyOrientationMode();           // 縦=入力欄を常設 / 横=映像優先で出さない
  setVideo(ids.main ? 'main' : (ids.a ? 'a' : 'b'));
  // 共有URLから開いたとき（withSound=false）もジェスチャーが無いだけで、
  // 「解除したら何が鳴るか」は決めておく。MAIN（無ければ先頭）を選んだ
  // 状態にし、実際の音は muted で止めておく
  const firstAudio = KEYS.find(k => players[k]);
  if(!withSound){
    muted = true;
    pendingUnmute = true;
  }
  applyAudio(firstAudio ? [firstAudio] : [], true);
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
  renderVolume();          // 音量バーは映している配信のものに入れ替わる
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
}

/* ================================================================
   Space（A ⇄ B）の切替対象
   既定は映像と音声をまとめて切り替える。映像は据え置きで音声だけ
   行き来したい場面もあるので、A ⇄ B の右のトグルで対象を選べる。
   1/2/3 と Q/W/E は元から別々なので、この設定の影響を受けない。
   ================================================================ */
function renderLinkVideo(){
  const btn = document.getElementById('linkVideo');
  btn.setAttribute('aria-checked', linkVideo ? 'true' : 'false');
  document.getElementById('linkVideoLabel').textContent = linkVideo ? '音声&映像' : '音声';
  btn.title = (linkVideo
    ? 'Space で映像と音声をまとめて切り替える'
    : 'Space で音声だけを切り替える（映像は据え置き）') + ' (S)';
}
function toggleLinkVideo(){
  linkVideo = !linkVideo;
  renderLinkVideo();
}

/* ---------- 音声 ----------
   音量は配信ごとに持つ。同時再生で実況とチームVCを混ぜるとき、片方だけ
   小さくしたいことが多いため。バーが編集するのは「今映している配信」の音量。
   映像を切り替えるとバーもその配信の値に入れ替わる */
const vol = {main:100, a:100, b:100};
/* バーが担当する配信。映像を切り替えても、読み込んでいなければ触らない */
function volKey(){ return players[videoSrc] ? videoSrc : (KEYS.find(k => players[k]) || videoSrc); }
/* 鳴っている中でいちばん大きい音量。0 なら実質ミュート */
function audibleVol(){ return audioKeys.reduce((m, k) => Math.max(m, vol[k]), 0); }
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

/* ================================================================
   読み込んでいる配信だけを選べるようにする
   URL を入れていない配信を選ぶと、映像は動かないのに音声だけ
   無音のほうへ移ってしまう。toggleAudioKey / setVideo で弾き、
   applyAudio も受け取った集合から落とす。ボタンにも disabled を
   付けて、押せないことを見た目でも示す。
   ================================================================ */
function loadedCount(){ return KEYS.filter(k => players[k]).length; }
function renderAvailability(){
  document.querySelectorAll('[data-vid]').forEach(b => b.disabled = !players[b.dataset.vid]);
  document.querySelectorAll('[data-aud]').forEach(b => b.disabled = !players[b.dataset.aud]);
  // ズレ微調整も、無い配信の分は動かしても意味がない
  renderTrim();                   // ズレ微調整は「進める余地」でも押せるかが変わる
  // 同時再生は混ぜる相手が要る
  document.getElementById('mix').disabled = loadedCount() < 2;
  if(loadedCount() < 2 && mixMode) mixMode = false;
  renderMix();
  renderSwapPair();
  renderUnmuteChip();
}

const SRC_LABEL = {main:'MAIN', a:'VC-A', b:'VC-B'};
const SRC_COLOR = {main:'#3ddc84', a:'#4ea8de', b:'#f2a65a'};

/* 鳴らす配信を集合で受け取る。読み込んでいないものは落とし、
   KEYS の並びに揃えてから配る（表示の順を安定させるため） */
function applyAudio(keys, instant){
  audioKeys = KEYS.filter(k => players[k] && keys.includes(k));
  KEYS.forEach(k => fadeTo(k, (!muted && audioKeys.includes(k)) ? vol[k] : 0, instant));

  // 選択の点灯はミュート中も保つ。「いま音量を戻したら何が鳴るか」を残す
  document.querySelectorAll('[data-aud]').forEach(
    b => b.classList.toggle('on', audioKeys.includes(b.dataset.aud)));

  renderNowAudio();
  renderUnmuteChip();
  renderVolume();
}

/* 共有URLから開いた直後、ジェスチャーが無くて鳴らせないあいだだけ出す。
   チップを押すか、音声を選ぶ（音声ボタン / Q・W・E / Space）と解ける。
   どちらも pendingUnmute を落とすので、そのあとに自分でミュートしても
   （M / スピーカー）再び出ることはない */
function renderUnmuteChip(){
  document.getElementById('unmuteChip').hidden =
    !pendingUnmute || !isMuted() || !KEYS.some(k => players[k]);
}

/* 右上のインジケーター。選択そのものだけでなく音量にも左右されるので、
   音量を動かしたときにも描き直す */
function renderNowAudio(){
  const n = audioKeys.length;
  document.getElementById('audioLabel').textContent =
    n === 0 ? 'ミュート'
    : n === 1 ? SRC_LABEL[audioKeys[0]] + ' 音声'
    : audioKeys.map(k => SRC_LABEL[k]).join(' + ');
  // 選んでいても鳴っていない（ミュート中 / 音量0）ときは、赤い点で点滅なし
  const live = n > 0 && !isMuted();
  const dot = document.querySelector('#nowAudio .dot');
  dot.style.background = !live ? '#e5484d' : (n === 1 ? SRC_COLOR[audioKeys[0]] : '#7bc47f');
  dot.classList.toggle('live', live);
}

/* ================================================================
   同時再生
   実況と自チームの VC のように、2本以上を混ぜて聴きたいことがある。
   モードを ON にすると、音声ボタン（と Q/W/E）が「切り替え」から
   「足し引き」に変わる。最大3本。
   全部外して無音になる事故を避けたいので、最後の1本は外せない
   （消したいときは PC ではミュート = M / スピーカーのボタン、
   スマホでは端末の音量ボタンを使う）。
   スマホでは音声行の右端（以前のミュートの位置）にこのスイッチを置く。
   ================================================================ */
function renderMix(){
  const btn = document.getElementById('mix');
  btn.setAttribute('aria-checked', mixMode ? 'true' : 'false');
  btn.title = mixMode
    ? '同時再生 ON — 音声ボタンで足し引きします（最大3本）(R)'
    : '同時再生 OFF — 音声ボタンは1本に切り替えます (R)';
}
function toggleMix(){
  if(loadedCount() < 2) return;
  mixMode = !mixMode;
  // OFF に戻すときは先頭の1本に絞る。混ざったまま切替モードへ戻ると、
  // 次のクリックで一度に減って何が起きたか分からなくなる
  if(!mixMode && audioKeys.length > 1) applyAudio([audioKeys[0]]);
  renderMix();
}
/* 音声ボタン / Q・W・E の共通の入口 */
function toggleAudioKey(k){
  if(!players[k]) return;
  audioUnlocked = true;
  const unlocked = unlockPendingUnmute();
  if(!mixMode){ applyAudio([k]); return; }
  if(!audioKeys.includes(k)){ applyAudio(audioKeys.concat(k)); return; }
  // 最後の1本は外せない。ただし無音を解いたのなら、選択が変わらなくても
  // 鳴らしてチップを引っ込める必要がある
  if(audioKeys.length <= 1){ if(unlocked) applyAudio(audioKeys); return; }
  applyAudio(audioKeys.filter(x => x !== k));
}

/* ================================================================
   ミュート
   音量バーの根元のスピーカーが担当する（YouTube などと同じ位置）。
   押すとバーが最小になりミュート、もう一度押すと元の音量に戻る。
   音量バーと一体の操作なので、止めるのは音量だけにして音声の選択は
   触らない。選択を消してしまうと、音量を戻したときに何が鳴るのかが
   画面から読み取れなくなる。
   ================================================================ */
function isMuted(){ return muted || audioKeys.length === 0 || audibleVol() === 0; }
/* 音量 0 のまま解除しても鳴らない。全部 0 のときだけ戻す */
function restoreSilentVolumes(){
  if(audibleVol() > 0) return;
  (audioKeys.length ? audioKeys : KEYS).forEach(k => { vol[k] = 100; });
}
function muteAll(){
  muted = true;
  applyAudio(audioKeys);          // 選択はそのまま。音量だけ落とす
}
function unmute(){
  audioUnlocked = true;
  muted = false;
  pendingUnmute = false;
  restoreSilentVolumes();
  // まだ何も選んでいなければ（起動直後に選択ボタンで外された等）、
  // 読み込んでいる先頭を鳴らす
  if(!audioKeys.length){
    const first = KEYS.find(k => players[k]);
    applyAudio(first ? [first] : []);
  }else{
    applyAudio(audioKeys);
  }
}
function toggleMute(){ isMuted() ? unmute() : muteAll(); }

/* 自動再生ポリシーのための無音だけを、意図的な音声操作で解く。
   ミュートには2種類ある。自分でかけたもの（M / スピーカー）は
   「選択とは独立の軸」なので選択を動かしても解かない。共有URLから
   開いたときにこちらの都合で挟んだもの（pendingUnmute）は、押した
   本人が望んでいない無音なので、音声を選ぶ操作そのものをジェスチャー
   として扱って解く。これが無いと、音声ボタンが点灯したのに鳴らない。
   実際に音を配るのは呼び出し元の applyAudio に任せる。ここで鳴らすと
   切り替える前の配信が一瞬だけ鳴ってしまう。解いたかどうかを返すので、
   選択が変わらず applyAudio を通らない経路でも反映を落とさずに済む */
function unlockPendingUnmute(){
  if(!pendingUnmute) return false;
  muted = false;
  pendingUnmute = false;
  restoreSilentVolumes();
  return true;
}

/* バーとスピーカーの見た目。バーは「今映している配信」の音量を出す。
   ミュート中は最小で描く（vol は保持） */
function renderVolume(){
  const k = volKey();
  const shown = (muted || audioKeys.length === 0) ? 0 : vol[k];
  const el = document.getElementById('vol');
  if(el.value != shown) el.value = shown;
  // どの配信の音量を触っているかが分かるよう、バーはその配信の色で塗る
  const color = SRC_COLOR[k];
  el.style.background =
    'linear-gradient(to right, ' + color + ' 0%, ' + color + ' ' + shown + '%, #2b3340 '
    + shown + '%, #2b3340 100%)';
  el.title = SRC_LABEL[k] + ' の音量';
  el.setAttribute('aria-label', SRC_LABEL[k] + ' の音量');
  const lab = document.getElementById('volLabel');
  // 2本以上あるときは、どれの音量かを添える（1本なら迷わないので数字だけ）
  lab.textContent = loadedCount() > 1 ? SRC_LABEL[k] + ' ' + shown : String(shown);
  lab.classList.toggle('muted', shown === 0);

  const btn = document.getElementById('volMute');
  const m = isMuted();
  btn.classList.toggle('muted', m);
  btn.title = m ? 'ミュート解除 (M)' : 'ミュート (M)';
  btn.setAttribute('aria-label', m ? 'ミュート解除' : 'ミュート');
}

/* ================================================================
   Space で行き来する2本
   既定は VC-A ⇄ VC-B だが、MAIN と VC-A の2本だけ読み込んで使う
   こともあるので、どの2本を往復するかを選べるようにする。選択は
   A ⇄ B ボタンの右端のカレットから、自前のメニュー（.swapMenu）で行う。
   片方でも読み込んでいない組み合わせは選べない。
   ================================================================ */
const SWAP_PAIRS = [
  {id:'main-a', keys:['main','a'], short:'MAIN ⇄ A', full:'MAIN ⇄ VC-A'},
  {id:'main-b', keys:['main','b'], short:'MAIN ⇄ B', full:'MAIN ⇄ VC-B'},
  {id:'a-b',    keys:['a','b'],    short:'A ⇄ B',    full:'VC-A ⇄ VC-B'}
];
var swapPairId = 'a-b';
function pairReady(p){ return p.keys.every(k => !!players[k]); }
/* いま実際に使える組み合わせ。2本そろっていなければ null */
function currentPair(){
  const p = SWAP_PAIRS.find(x => x.id === swapPairId);
  return p && pairReady(p) ? p : null;
}
function renderSwapPair(){
  // 選んでいた組み合わせが使えなくなったら、使える先頭へ寄せる
  if(!currentPair()){
    const first = SWAP_PAIRS.find(pairReady);
    if(first) swapPairId = first.id;
  }
  const p = currentPair();
  const btn = document.getElementById('swap');
  btn.disabled = !p;
  document.getElementById('swapCaretBtn').disabled = !p;
  document.getElementById('swapLabel').textContent =
    (p || SWAP_PAIRS.find(x => x.id === swapPairId)).short;
  btn.title = p ? p.full + ' を切り替える (Space)'
                : '行き来できる配信が2本そろっていません';

  document.querySelectorAll('.swapMenuItem').forEach(item => {
    const pair = SWAP_PAIRS.find(x => x.id === item.dataset.pair);
    item.setAttribute('aria-disabled', pairReady(pair) ? 'false' : 'true');
    item.setAttribute('aria-checked', item.dataset.pair === swapPairId ? 'true' : 'false');
  });
  if(!p) closeSwapMenu(false);   // 選べる組み合わせが無くなったら開いたままにしない
}

/* ================================================================
   上のメニューの開閉
   ネイティブの <select> は OS 標準の見た目になってしまうため、他の
   パネル（診断・ヘルプ）と同じ配色の自前パネルにする。「メニュー
   ボタン」パターン（role="menu" / menuitemradio）で、開閉・選択・
   Escape・外側クリックだけを面倒みる。
   矢印キーでの移動は実装しない。このアプリは Space と矢印キーを
   画面全体のショートカットとして使っていて、メニューを開いている
   最中でもそちらが先に音量やシークを動かしてしまうため、Tab と
   Enter、クリックで選べれば十分と判断した。
   ================================================================ */
function swapMenuOpen(){ return !document.getElementById('swapMenu').hidden; }
function openSwapMenu(){
  if(document.getElementById('swap').disabled) return;
  const menu = document.getElementById('swapMenu');
  menu.hidden = false;
  document.getElementById('swapCaretBtn').setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onSwapMenuOutside, true);
  document.addEventListener('keydown', onSwapMenuKeydown, true);
  const current = menu.querySelector('[data-pair="' + swapPairId + '"]');
  (current || menu.querySelector('.swapMenuItem')).focus();
}
function closeSwapMenu(returnFocus){
  const menu = document.getElementById('swapMenu');
  if(menu.hidden) return;
  menu.hidden = true;
  document.getElementById('swapCaretBtn').setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onSwapMenuOutside, true);
  document.removeEventListener('keydown', onSwapMenuKeydown, true);
  if(returnFocus) document.getElementById('swapCaretBtn').focus();
}
function onSwapMenuOutside(e){
  if(!document.getElementById('swapWrap').contains(e.target)) closeSwapMenu(false);
}
function onSwapMenuKeydown(e){
  if(e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();            // 全体のショートカット（? のヘルプなど）に渡さない
  closeSwapMenu(true);
}

/* Space: 選んだ2本を交互に。組の外（MAIN やミュート）からは1本目に入る。
   同時再生中は、組のうち鳴っているほうだけを入れ替え、他は鳴らしたまま
   にする（MAIN を流しながら VC だけ行き来する使い方のため）。
   Space連動が ON なら映像も同じ配信へ動かす */
function swapVc(){
  closeSwapMenu(false);
  const pair = currentPair();
  if(!pair) return;
  const from = pair.keys.find(k => audioKeys.includes(k)) || null;
  // 組の両方が鳴っている（同時再生中）。入れ替える先がないので何もしない
  if(pair.keys.every(k => audioKeys.includes(k))) return;
  audioUnlocked = true;
  unlockPendingUnmute();
  const next = from === pair.keys[0] ? pair.keys[1] : pair.keys[0];
  const keys = mixMode
    ? audioKeys.filter(k => k !== from).concat(next)
    : [next];
  if(linkVideo){
    suspendEco();                 // 往復で目立つ「切替直後の画質低下」を避ける
    setVideo(next);
  }
  applyAudio(keys);
}

/* 今映している配信の音量。鳴っていれば即時反映する。鳴っていない配信でも
   値は覚えておき、その配信を鳴らしたときにその音量で出す */
function setVolume(v, silent){
  const k = volKey();
  vol[k] = Math.max(0, Math.min(100, Math.round(v)));
  const p = players[k];
  if(p && ready[k] && audioKeys.includes(k)){
    clearInterval(fades[k]);
    try{
      p.setVolume(vol[k]);
      (vol[k] > 0 && !muted && canUnmute()) ? p.unMute() : p.mute();
    }catch(e){}
  }
  renderNowAudio();
  renderVolume();
}

/* ================================================================
   トランスポート
   各配信は独立したライブなので絶対時刻では揃わない。
   「LIVE最先端からの遅れ秒数」を共通軸にし、全員を同じ量だけ動かす。

   原則1: LIVE端の基準に getDuration() を使わない。
   YouTube のライブでは getDuration() が再生位置と同じ軸に乗らず、序盤は
   3600 などにパディングされた値を返す。これを基準に seekTo() すると常に
   LIVE端より先を指してプレーヤー側でクランプされ、シークが一切効かなくなる
   （実際にこのデグレを出している）。基準は getCurrentTime() の実測だけで作る。

   原則2: 画面には「押した結果」ではなくプレーヤーの実状態を出す。
   要求値をそのまま描くと、シークが失敗してもUI上は戻れたように見え、
   不具合が画面から隠れてしまう。実測と食い違ったら実測へ寄せる。

   原則3: 巻き戻せない配信がある。配信者が DVR を無効にしたライブでは、
   YouTube が seekTo を黙って無視する（本家のページでも戻れない）。
   シークは巻き戻せる配信にだけ掛け、戻せない配信は LIVE のまま流す。
   本配信だけ戻せるときに、戻せない同時視聴の遅れへ本配信を合わせる、
   という使い方ができるよう、あえて全体を止めずに片側だけ動かす。

   原則4: アーカイブは普通の動画として扱う。読み込んだものが配信中でなければ、
   LIVE端の推定をやめ、getDuration() を終端として使う（原則1の禁止はライブに
   限った話。終わった動画の getDuration() は再生位置と同じ軸に乗る）。推定の
   ままだと終端が実時間で伸び続けるので、頭から見ても戻れる幅がほとんど無く、
   一時停止中は遅れ表示が勝手に増えていく。
   見ている最中に配信が終わった場合は、アーカイブへの切り替わりを追いかけない。
   終わったことだけを映像の上に出す（renderEndedNote）。次に読み込めば
   アーカイブとして開ける。

   原則0: 状態は文字ではなく絵で見せる。ズレを付けて見ているあいだは、
   動画ごとのシークバーを並べて出す。「別々の位置で再生している」ことも、
   連動 ON で「1本動かすと全部動く」ことも、つまみの並びと緑の枠で伝わる。
   揃っていれば（＝ズレを付けていなければ）バーは1本に畳む。

   原則5: アーカイブの同時視聴は「共通の遅れ」では揃わない。動画ごとに
   開始時刻も長さも違うので、LIVE端からの遅れという共通軸が意味を持たない。
   そこでアーカイブでは、見ている動画の絶対位置でシークし、他の動画は
   「いまのズレを保ったまま同じ量だけ」動かす（まとめてシーク）。
   まとめてシークを切れば、シークは見ているものだけに効く。これで動画ごとの
   頭出しができる。揃え直したくなったら SYNC で全部を見ている動画の位置に
   合わせる（ライブの LIVE ボタンにあたる操作）。
   ================================================================ */
const ST = {UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, BUFFERING:3, CUED:5};
const SETTLE_MS = 2000;        // コマンド発行後、実状態が追いつくのを待つ時間
const OFFSET_SNAP = 2;         // 実測とのズレがこれ以内なら表示を保つ(ちらつき防止)
const LIVE_EPS = 3;            // 実測の遅れがこれ未満なら LIVE端に居るとみなす
const LIVE_BADGE = 6;          // LIVE 表示にする遅れ。ライブは数秒の揺れが普通
const SEEK_SHORTFALL = 10;     // 要求よりこれ以上手前で止まったら、戻れないと報せる
const LIVE_OVERSHOOT = 86400;  // LIVE へ戻すときに指す「LIVE端のはるか先」(秒)

let targetOffset = 0;          // 巻き戻せる配信に要求している遅れ秒数。実測で補正される
let groupSeek = true;          // シークを全部に効かせるか（OFF = 見ているものだけ）
/* 意図的にズレを付けたか。付けているあいだは動画ごとのシークバーを出す。
   SYNC で揃え直すと下りる。実測のズレで判定すると、再生中のわずかな差で
   表示が出たり消えたりするので、操作の意図で持つ */
let offsetIntent = false;
let msDragKey = null;          // 動画ごとのバーを掴んでいるあいだ、その配信
let paused = false;
let scrubbing = false;
let settleUntil = 0;
let verifyTimer = null;
let transportSeq = 0;          // 操作の通し番号。遅れて届く後処理が新しい操作を踏まないため
const trim = {main:0, a:0, b:0};
const stateOf = {main:ST.UNSTARTED, a:ST.UNSTARTED, b:ST.UNSTARTED};
/* 配信ごとの巻き戻し可否。true = 戻せる / false = 戻せない /
   null = まだ分からない（分からないうちは戻せるものとして扱う） */
const canRewind = {main:null, a:null, b:null};
/* 配信中か。false = アーカイブ / null = まだ分からない */
const isLiveNow = {main:null, a:null, b:null};
const vdSeen = {main:0, a:0, b:0};     // アーカイブと読めた最初の時刻(ms)
const vdRaw = {main:null, a:null, b:null};  // 診断パネル用の生の値
const ARCHIVE_CONFIRM_MS = 1500;       // アーカイブと決めるまで読みを保つ時間
const LIVE_PAD = 3600;                 // ライブの getDuration() が返す詰め物の値
const HEAD_EPS = 15;                   // これ以内から始まったら「頭から」とみなす(秒)
/* 再生が始まった位置。頭（0付近）からなら動画、LIVE端からならライブ。
   null = まだ採れていない。0 も意味のある値なので null と区別する。
   採るのは早いほどよい。裏のタブではタイマーが間引かれて描画が遅れるため、
   タイマー任せにすると動画でも「ずっと先から始まった」ように見えてしまう。
   プレーヤーの状態変化（再生開始）でも採る */
const firstPos = {main:null, a:null, b:null};
function noteFirstPos(k){
  if(firstPos[k] !== null) return;
  const cur = playerTime(k);
  // 再生が始まるまで getCurrentTime() は 0 を返す。その 0 を「頭から始まった」と
  // 読むと、ライブを動画と取り違える。最初の正の値を採る
  if(cur !== null && cur > 0) firstPos[k] = cur;
}
/* ライブは長さが決まらないので、getDuration() がきっちり 3600 の詰め物を返す
   （原則1）。取り違えたときに終端が 60:00 で固定されるのはこれ。

   ただし長さが 3600 なだけでライブと決めてはいけない。本当に 60:00 ちょうどの
   動画（1時間耐久ものなど）を永久にライブ扱いしてしまう。始まった位置で分ける:
   動画は先頭から始まり、ライブは LIVE端（配信開始からの経過）から始まる。 */
function paddedLive(k, d){ return d === LIVE_PAD && firstPos[k] !== null && firstPos[k] > HEAD_EPS; }
/* 「配信は終了しました」を消したか（配信ごと）。シークバーに触れたら消す */
const endedNoteOff = {main:false, a:false, b:false};
/* LIVE端の推定。配信ごとに「ある実時刻に、共通軸のどこが LIVE端だったか」を
   持ち、経過実時間で外挿する。ライブの LIVE端は再生状態にも再生速度にも
   関係なく実時間と同じ速さで進むので、外挿は常に1倍速でよい。 */
const edgeBase = {main:0, a:0, b:0};   // 共通軸の秒
const edgeWall = {main:0, a:0, b:0};   // performance.now() の ms。0 = 未取得

function resetTransport(){
  targetOffset = 0;
  offsetIntent = false;
  msDragKey = null;
  paused = false;
  scrubbing = false;
  settleUntil = 0;
  clearTimeout(verifyTimer);
  verifyTimer = null;
  transportSeq++;
  KEYS.forEach(k => {
    // ズレ調整は配信ごとの補正なので、別の配信を読み込んだら持ち越さない
    trim[k] = 0;
    stateOf[k] = ST.UNSTARTED;
    canRewind[k] = null;
    isLiveNow[k] = null;
    vdSeen[k] = 0;
    vdRaw[k] = null;
    firstPos[k] = null;
    endedNoteOff[k] = false;
    edgeBase[k] = 0;
    edgeWall[k] = 0;
    const el = document.getElementById('tr-'+k);
    if(el) el.textContent = '0.0';
  });
}
function markCommand(){ settleUntil = performance.now() + SETTLE_MS; }
function settling(){ return performance.now() < settleUntil; }
function anyState(s){ return KEYS.some(k => ready[k] && stateOf[k] === s); }

/* 読み込んだものがライブかアーカイブか、巻き戻せるかを読む。公式 API には
   無いが、getVideoData() の isLive / allowLiveDvr で分かる（実機で確認済み）。
   読めるまで呼ぶたびに試し、読めたら確定する。読めない環境では null のまま。

   ここを一度読めた値で即決めると、ライブをアーカイブ扱いしてしまう。
   動画が載る前の getVideoData() は中身が揃っておらず、ライブでも
   isLive:false が返る（実機で、ライブなのに SYNC が出る形で発覚）。
   取り違えの影響はアーカイブ側に倒したときのほうが大きい（シークの軸も
   表示も全部変わる）ので、アーカイブと決めるときだけ手順を踏む:
     - 読み込んだ動画IDと getVideoData() の video_id が一致すること
     - 再生位置が入っていること（再生が始まる前の値は当てにならない）
     - 再生位置が終端を超えていないこと（超える = パディングされたライブ）
     - 長さが詰め物（ちょうど 3600）で、かつ先頭から始まっていないのでない
       こと。ライブは長さが決まらないので getDuration() が詰め物を返し、
       取り違えると終端が 60:00 で固定される。ただし長さだけで決めると、
       本当に 60:00 の動画を永久にライブ扱いするので始まった位置も見る
     - 同じ読みが ARCHIVE_CONFIRM_MS 続くこと
   ライブ（isLive:true）は取り違えても軽いので、読めた時点で決めてよい */
function probeVideoData(k){
  const p = players[k];
  if(!p || !ready[k] || typeof p.getVideoData !== 'function') return;
  const cur = playerTime(k);
  const end = archiveEnd(k);
  // アーカイブと決めたのに再生位置が終端を超えた。アーカイブではありえないので
  // 読み違い。決め直させる（ライブの getDuration() はパディングされる）
  if(isLiveNow[k] === false && (paddedLive(k, end)
      || (cur !== null && end > 0 && cur > end + 1))){
    isLiveNow[k] = null; canRewind[k] = null; vdSeen[k] = 0;
  }
  if(canRewind[k] !== null) return;          // 決まっていれば読み直さない
  if(cur === null || cur <= 0) return;       // まだ再生が始まっていない
  noteFirstPos(k);                           // 始まった位置。頭からか LIVE端か
  let vd = null;
  try{ vd = p.getVideoData(); }catch(e){ return; }
  if(!vd || typeof vd.isLive !== 'boolean') return;
  vdRaw[k] = vd;
  // 別の動画の（または空の）メタデータ。この動画のものが載るまで待つ
  if(loadedId[k] && vd.video_id && vd.video_id !== loadedId[k]) return;
  if(vd.isLive){
    isLiveNow[k] = true;
    canRewind[k] = vd.allowLiveDvr !== false;   // 配信者の DVR 設定次第
    return;
  }
  if(end > 0 && cur > end + 1) return;        // 終端を超えている = ライブ
  if(paddedLive(k, end)) return;              // 長さが詰め物で、頭からでもない
  const now = performance.now();
  if(!vdSeen[k]){ vdSeen[k] = now; return; }  // 一度きりの読みでは決めない
  if(now - vdSeen[k] < ARCHIVE_CONFIRM_MS) return;
  isLiveNow[k] = false;
  canRewind[k] = true;                        // アーカイブは自由にシークできる
}
function readRewind(k){ probeVideoData(k); return canRewind[k]; }
/* 配信中ではない = アーカイブ（普通の動画）か */
function isArchive(k){ probeVideoData(k); return isLiveNow[k] === false; }
/* アーカイブの終端。ライブと違い getDuration() が再生位置と同じ軸に乗る */
function archiveEnd(k){
  const p = players[k];
  if(!p || typeof p.getDuration !== 'function') return 0;
  try{
    const d = p.getDuration();
    return (typeof d === 'number' && isFinite(d) && d > 0) ? d : 0;
  }catch(e){ return 0; }
}
/* シークを掛けてよい配信か */
function seekable(k){ return !!players[k] && ready[k] && readRewind(k) !== false; }
/* 読み込んでいて、巻き戻せないと分かっている配信 */
function noRewindKeys(){ return KEYS.filter(k => players[k] && ready[k] && readRewind(k) === false); }
function noRewindMessage(keys){
  return keys.map(k => SRC_LABEL[k]).join('・') + ' は配信者が巻き戻しを無効にしているため、LIVE のままです';
}

/* 再生位置。取れないときは null を返す（開始直後の 0 と区別するため） */
function playerTime(k){
  const p = players[k];
  if(!p || !ready[k]) return null;
  try{
    const t = p.getCurrentTime();
    return (typeof t === 'number' && isFinite(t) && t >= 0) ? t : null;
  }catch(e){ return null; }
}
/* LIVE端の推定値。実測が推定を追い越していたら、そこまで引き上げる。
   再生位置が LIVE端より先に行くことはないので、これで上振れはしない。

   ここで使うのはプレーヤー自身の再生位置で、ズレ微調整(trim)は混ぜない。
   「再生位置 - trim」を渡すと、trim を動かした瞬間に値が跳ねて引き上げ規則が
   発火し、推定が同じだけ持ち上がって seek をちょうど打ち消してしまう
   （LIVE端でズレ微調整が効かないデグレの原因）。trim は seek 先と
   遅れ秒数を出すときにだけ足す。 */
function liveEdge(k){
  if(isArchive(k)){
    // アーカイブは終端が伸びない。推定を続けると戻れる幅が出ず、
    // 一時停止中に遅れが勝手に増え、seek 先も終端の先を指してしまう
    const end = archiveEnd(k);
    if(end > 0) return end;
    // 取れないときだけ従来の推定へ落とす
  }
  const now = performance.now();
  const cur = playerTime(k);
  if(!edgeWall[k]){
    // 再生が動き出すまで getCurrentTime() は 0 を返す。まだ LIVE端は決められない
    if(cur === null || cur <= 0) return 0;
    edgeBase[k] = cur; edgeWall[k] = now;
    return cur;
  }
  const est = edgeBase[k] + (now - edgeWall[k]) / 1000;
  if(cur !== null && cur > est){
    edgeBase[k] = cur; edgeWall[k] = now;
    return cur;
  }
  return est;
}
/* LIVE端にいると分かっている瞬間に推定を貼り直す。推定を引き下げられる唯一の
   経路で、配信側の一時的な停止などで上振れしたまま残るのを防ぐ */
function noteLiveEdge(k){
  const cur = playerTime(k);
  if(cur === null || cur <= 0) return false;
  edgeBase[k] = cur - trim[k];   // ズレ微調整のぶんは意図した遅れ。LIVE端から外す
  edgeWall[k] = performance.now();
  return true;
}
/* 実測の遅れ秒数。推定が取れていなければ null */
function measuredOffset(k){
  const edge = liveEdge(k);
  const cur = playerTime(k);
  if(edge <= 0 || cur === null) return null;
  return Math.max(0, edge - cur + trim[k]);
}
/* targetOffset の基準にする配信。targetOffset に従うのは巻き戻せる配信だけ
   なので、見ている配信が戻せればそれ、戻せなければ戻せる別の配信を使う */
function refKey(){
  if(seekable(videoSrc)) return videoSrc;
  return KEYS.find(seekable) || null;
}
/* 画面に出す遅れ。見ている配信の実態を出す。巻き戻せない配信を見ている
   あいだは、他の配信を戻していても LIVE のまま */
function shownOffset(){
  if(!players[videoSrc] || seekable(videoSrc)) return targetOffset;
  const m = measuredOffset(videoSrc);
  return m === null ? 0 : m;
}

/* 見ている動画がアーカイブか。アーカイブは共通軸（LIVE端からの遅れ）を
   使わず、見ている動画の絶対位置で動かす */
function archiveMode(){ return isArchive(videoSrc); }
/* シークを掛ける対象。まとめてシークが OFF なら見ているものだけ */
function seekKeys(){
  if(groupSeek) return KEYS.filter(seekable);
  return seekable(videoSrc) ? [videoSrc] : [];
}
/* 見ている動画を pos（動画の先頭からの秒数）へ動かす。他の動画は、いまの
   ズレを保ったまま同じ量だけずらす。開始時刻が違う動画どうしでも、一度
   頭出しすれば以後は揃ったまま動かせる */
function seekArchiveTo(pos, base){
  const key = base || videoSrc;
  const cur = playerTime(key);
  if(cur === null) return false;
  transportSeq++;
  const delta = pos - cur;
  // まとめてシークが OFF なら、動かすのは掴んだ1本だけ
  const targets = groupSeek ? KEYS.filter(seekable) : [key];
  if(!groupSeek) offsetIntent = true;          // ズレを付けにいっている
  let ok = false;
  targets.forEach(k => {
    const c = k === key ? cur : playerTime(k);
    if(c === null) return;
    try{ players[k].seekTo(Math.max(0, c + delta), true); ok = true; }catch(e){}
  });
  // 表示の軸（終端からの遅れ）も、動かした先に合わせておく
  const end = liveEdge(videoSrc);
  const shown = key === videoSrc ? pos : playerTime(videoSrc);
  if(end > 0 && shown !== null) targetOffset = Math.max(0, end - shown);
  if(ok) markCommand();
  return ok;
}
/* 他の動画を、いま映している動画と同じ位置へ揃える。ライブの LIVE ボタンに
   あたる操作で、ズレを付けすぎたときや、偶然ずれたときに戻すためのもの */
function syncToShown(){
  const base = playerTime(videoSrc);
  if(base === null) return;
  transportSeq++;
  offsetIntent = false;            // 揃えた。動画ごとのバーは畳んでよい
  KEYS.forEach(k => {
    if(k === videoSrc || !seekable(k)) return;
    try{ players[k].seekTo(Math.max(0, base), true); }catch(e){}
    trim[k] = 0;
    const el = document.getElementById('tr-'+k);
    if(el) el.textContent = '0.0';
  });
  markCommand();
  renderTransport();
}
/* 絶対シーク。LIVE端の推定が要る。巻き戻せない配信には掛けない。
   アーカイブには掛けない: これは「LIVE端からの遅れ」というライブの共通軸を
   その動画に当てはめる操作で、長さの違うアーカイブでは無関係な位置へ飛ぶ
   （長さ1500秒の動画に「終端から897秒前」を当てて 603秒へ飛ばしていた）。
   アーカイブは seekArchiveTo() で絶対位置を指して動かす */
function seekPlayer(k){
  const p = players[k];
  if(!p || !seekable(k) || isArchive(k)) return false;
  const edge = liveEdge(k);
  // LIVE端が未確定のまま seekTo すると配信の先頭へ飛ばされ再生が壊れる
  if(edge <= 0) return false;
  try{ p.seekTo(Math.max(0, edge - targetOffset + trim[k]), true); return true; }
  catch(e){ return false; }
}
function seekAll(){
  transportSeq++;
  let ok = false;
  seekKeys().forEach(k => { if(seekPlayer(k)) ok = true; });
  const skipped = groupSeek ? noRewindKeys() : [];
  if(targetOffset > 0 && skipped.length) setStatusLine(noRewindMessage(skipped));
  if(ok){ markCommand(); scheduleSeekVerify(); }
  return ok;
}
/* 相対シーク（delta>0 = 過去へ）。LIVE端の推定を通さず再生位置から直接
   動かすので、推定がずれていても要求どおりの量だけ確実に動く */
function seekRelative(delta){
  transportSeq++;
  if(!groupSeek) offsetIntent = true;
  let ok = false;
  seekKeys().forEach(k => {
    const p = players[k];
    const cur = playerTime(k);
    if(!p || cur === null) return;
    try{ p.seekTo(Math.max(0, cur - delta), true); ok = true; }catch(e){}
  });
  const skipped = groupSeek ? noRewindKeys() : [];
  if(skipped.length) setStatusLine(noRewindMessage(skipped));
  if(!ok) return;
  targetOffset = Math.max(0, targetOffset + delta);
  markCommand();
  scheduleSeekVerify();
  renderTransport();
}
/* シークが本当に効いたかを実測で確かめる。DVR の範囲外などでクランプされたら、
   黙って LIVE のまま流し続けずに理由を出す */
function scheduleSeekVerify(){
  clearTimeout(verifyTimer);
  let waits = 0;
  const check = () => {
    verifyTimer = null;
    if(anyState(ST.BUFFERING)){                 // 読み込み中は位置が定まらない
      if(++waits < 8){ verifyTimer = setTimeout(check, 500); return; }
      return;                                   // 長引いているだけ。誤報しない
    }
    const ref = refKey();
    const m = ref ? measuredOffset(ref) : null;
    if(m === null) return;
    if(targetOffset - m > SEEK_SHORTFALL){
      setStatusLine('この配信はここまでしか戻れません（' + fmt(m) + ' 前）');
    }
  };
  verifyTimer = setTimeout(check, SETTLE_MS);
}
function togglePlay(){
  paused = !paused;
  if(!paused) audioUnlocked = true;
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k]) return;
    try{ paused ? p.pauseVideo() : p.playVideo(); }catch(e){}
  });
  if(!paused) applyAudio(audioKeys, true);
  markCommand();
  renderTransport();
  showCenter();
}
/* LIVE へ戻す。LIVE端の推定は使わず、はるか先を指してプレーヤー側のクランプで
   LIVE端に着地させる（実機で確認済み）。推定が何かの理由で壊れていても、
   これで必ず追いつける */
function goLive(){
  const seq = ++transportSeq;
  audioUnlocked = true;
  targetOffset = 0;
  paused = false;
  clearTimeout(verifyTimer);
  verifyTimer = null;
  KEYS.forEach(k => {
    const p = players[k];
    const cur = playerTime(k);
    // アーカイブに LIVE端は無い。終端へ飛ばしても意味が無いので触らない
    if(!p || cur === null || isArchive(k)) return;
    try{ p.seekTo(cur + LIVE_OVERSHOOT, true); }catch(e){}
  });
  applyAudio(audioKeys, true);
  // unmute 後に再生（順序を逆にするとポリシーで止まることがある）
  KEYS.forEach(k => { if(players[k] && ready[k]) players[k].playVideo(); });
  markCommand();
  // 着地した先が本当の LIVE端。推定を貼り直し、ズレ微調整で下げていた配信は
  // そのぶんだけ戻し直す。間に別の操作が入っていたら何もしない
  setTimeout(() => {
    if(seq !== transportSeq) return;
    const now = performance.now();
    KEYS.forEach(k => {
      const cur = playerTime(k);
      if(cur === null || cur <= 0 || isArchive(k)) return;
      edgeBase[k] = cur;
      edgeWall[k] = now;
      if(trim[k] < 0) seekPlayer(k);
    });
    markCommand();
    renderTransport();
  }, SETTLE_MS);
  renderTransport();
}
/* ライブは再生位置が入るまで少し掛かる。取れるまで LIVE へ同期を再試行。
   アーカイブは頭から流すだけ。共通軸に合わせて動かすと、長さの違う動画が
   無関係な位置から始まってしまう（ズレ合わせは利用者が頭出しで決める） */
function syncPlayerToLive(k){
  let attempt = 0;
  const tick = () => {
    const p = players[k];
    if(!p || !ready[k]) return;
    noteFirstPos(k);        // 読み込み直後のここが、位置を採れるいちばん早い経路
    if(isArchive(k)){ try{ p.playVideo(); }catch(e){} renderTransport(); return; }
    // ライブかアーカイブかが読めるまでは、共通軸に合わせない（読めない
    // うちに合わせると、アーカイブを無関係な位置から始めてしまう）
    if(readRewind(k) === null && ++attempt < 40){
      try{ p.playVideo(); }catch(e){}
      setTimeout(tick, 250);
      return;
    }
    if(noteLiveEdge(k)){
      if(targetOffset > 0) seekPlayer(k);
      try{ p.playVideo(); }catch(e){}
      renderTransport();
      return;
    }
    try{ p.playVideo(); }catch(e){}
    if(++attempt < 40) setTimeout(tick, 250);
  };
  tick();
}
/* 再生速度。ライブは 1x 以外を受け付けない配信があるので、押した値ではなく
   プレーヤーが実際に採用した値でボタンを点ける（原則2） */
function actualRate(){
  for(let i = 0; i < KEYS.length; i++){
    const p = players[KEYS[i]];
    if(!p || !ready[KEYS[i]]) continue;
    try{
      const r = p.getPlaybackRate();
      if(typeof r === 'number' && isFinite(r) && r > 0) return r;
    }catch(e){}
  }
  return null;
}
function renderRate(){
  const r = actualRate();
  if(r === null) return;
  document.querySelectorAll('[data-rate]').forEach(b =>
    b.classList.toggle('on', parseFloat(b.dataset.rate) === r));
}
function setRate(r){
  KEYS.forEach(k => {
    const p = players[k];
    if(!p || !ready[k]) return;
    try{ p.setPlaybackRate(r); }catch(e){}
  });
  // 反映に間があるので、落ち着いてから実際の値で描き直す
  setTimeout(() => {
    renderRate();
    const got = actualRate();
    if(got !== null && got !== r) setStatusLine('この配信は ' + r + 'x に対応していません');
  }, 600);
}
/* ズレ微調整。配信ごとの再生位置を 0.5秒 刻みでずらし、3本の時間軸を揃える。
   共通軸の遅れ秒数からは外してあるので、動かしても LIVE からの遅れ表示は動かない。

   「+」は LIVE端へ近づける向き。LIVE端より先のフレームは存在しないため、
   追いついている間は押してもプレーヤー側でクランプされて必ず何も起きない。
   押せてしまうと「効かないだけ」なのか「壊れている」のか区別が付かないので、
   余地がない側のボタンを無効にして、理由を title で示す。
   余地 = いまの遅れ(targetOffset) − その配信の trim */
const TRIM_EPS = 1e-6;
/* ズレ微調整で「進める」余地。ライブは LIVE端より先へは行けない。
   アーカイブは終端まで進められるので、この制約は掛けない */
function trimHeadroom(k){ return isArchive(k) ? Infinity : targetOffset - trim[k]; }
function renderTrim(){
  document.querySelectorAll('[data-trim]').forEach(b => {
    const k = b.dataset.trim;
    const d = parseFloat(b.dataset.d);
    const noPlayer = !players[k];
    const noRewind = !noPlayer && readRewind(k) === false;
    const noRoom = d > 0 && trimHeadroom(k) < d - TRIM_EPS;
    b.disabled = noPlayer || noRewind || noRoom;
    b.title = noPlayer
      ? SRC_LABEL[k] + ' を読み込んでいません'
      : noRewind
        ? SRC_LABEL[k] + ' は配信者が巻き戻しを無効にしているため、ずらせません'
      : noRoom
        ? 'LIVE の最先端に追いついているため、これ以上は進められません。'
          + '戻して見ているあいだは動かせます'
        : SRC_LABEL[k] + ' を 0.5秒 ' + (d > 0 ? '進める' : '戻す');
  });
}
function adjustTrim(k, d){
  // 押せない向きは動かさない（無効化と同じ判定。表示だけ進むのを防ぐ）
  if(!seekable(k)) return;
  if(d > 0 && trimHeadroom(k) < d - TRIM_EPS) return;
  transportSeq++;
  trim[k] = Math.round((trim[k] + d) * 10) / 10;
  document.getElementById('tr-'+k).textContent = trim[k].toFixed(1);
  if(isArchive(k)){
    // アーカイブは共通軸を通さず、その場から要求どおりの量だけ動かす
    offsetIntent = true;
    const cur = playerTime(k);
    if(cur !== null){ try{ players[k].seekTo(Math.max(0, cur + d), true); markCommand(); }catch(e){} }
  } else if(seekPlayer(k)) markCommand();
  renderTrim();
}
function fmt(sec){
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
}

/* スライダーの幅 = さかのぼれる長さの目安。配信開始からの経過（= LIVE端）を
   使い、巻き戻せる配信のうちいちばん短いものに合わせる。2時間で頭打ち。
   アーカイブだけを見ているときは頭打ちにしない。2時間の上限はライブで
   さかのぼれる範囲の目安であって、動画の長さを切る理由は無い（切ると
   2時間を超える動画で、頭のほうがスライダーの左端に潰れて動かせなくなる） */
function scrubSpan(){
  // アーカイブのつまみは見ている動画の絶対位置なので、幅もその動画の長さ
  if(archiveMode()){
    const end = liveEdge(videoSrc);
    if(end > 0) return Math.round(Math.max(60, end));
  }
  const keys = KEYS.filter(seekable);
  const edges = keys.map(k => liveEdge(k)).filter(d => d > 0);
  const span = edges.length ? Math.min.apply(null, edges) : 600;
  const cap = keys.length && keys.every(isArchive) ? span : 7200;
  return Math.round(Math.max(60, Math.min(span, cap)));
}
/* プレーヤーの実状態を UI に取り込む。ここが「押した結果」と実状態の
   突き合わせ点で、シークや再生が効かなかったことを画面に出す役目を持つ */
function reconcileTransport(){
  if(anyState(ST.PLAYING)) paused = false;
  else if(anyState(ST.PAUSED) && !anyState(ST.BUFFERING)) paused = true;

  if(scrubbing) return;
  // 実測で LIVE端に着いている配信は、そこを LIVE端として貼り直す。
  // 配信側の一時的な停止で推定が上振れしたまま残るのを防ぐ。
  // 貼り直しは必ず配信ごとに、その配信自身の実測だけで行うこと。以前は
  // 見ている配信の実測で全配信を貼り直していたため、巻き戻せない MAIN が
  // LIVE端にいるのを見て、60秒戻った VC-A まで「LIVE端にいる」と記録し、
  // 以後 LIVE ボタンでも戻らなくなった（実機で再現）
  if(!paused){
    KEYS.forEach(k => {
      const m = measuredOffset(k);
      if(m !== null && m < LIVE_EPS) noteLiveEdge(k);
    });
  }
  const ref = refKey();
  if(!ref){ targetOffset = 0; return; }       // 巻き戻せる配信が無い
  const m = measuredOffset(ref);
  if(m === null) return;
  if(!paused && m < LIVE_EPS){ targetOffset = 0; return; }
  if(Math.abs(m - targetOffset) > OFFSET_SNAP) targetOffset = m;
}
/* 動画ごとのシークバーを出すか。アーカイブだけを2本以上読み込んでいて、
   かつズレを付けている（付けにいっている）あいだだけ出す */
function multiMode(){
  const loaded = KEYS.filter(k => players[k] && ready[k]);
  if(loaded.length < 2 || !loaded.every(isArchive)) return false;
  return !groupSeek || offsetIntent;
}
/* 動画ごとのシークバー。掴んでいるバーだけは描き換えない（指が滑るため） */
function renderMultiScrub(){
  const wrap = document.getElementById('multiScrub');
  if(!wrap) return;
  const on = multiMode();
  wrap.hidden = !on;
  wrap.classList.toggle('linked', groupSeek);
  document.getElementById('scrub').hidden = on;   // 並べるあいだは共通のバーを引っ込める
  if(!on) return;
  wrap.querySelectorAll('.msRow').forEach(row => {
    const k = row.dataset.ms;
    const has = !!players[k] && ready[k];
    row.hidden = !has;
    if(!has) return;
    row.style.setProperty('--msColor', SRC_COLOR[k]);
    const bar = row.querySelector('input');
    const end = liveEdge(k);
    const cur = playerTime(k);
    if(k !== msDragKey && end > 0 && cur !== null){
      bar.max = Math.round(Math.max(60, end));
      bar.value = Math.round(Math.max(0, Math.min(cur, end)));
    }
    const pct = bar.max > 0 ? (bar.value / bar.max) * 100 : 0;
    bar.style.background = 'linear-gradient(to right, ' + SRC_COLOR[k] + ' 0%, ' + SRC_COLOR[k]
      + ' ' + pct + '%, #2b3340 ' + pct + '%, #2b3340 100%)';
    row.querySelector('.msTime').textContent =
      end > 0 ? fmt(parseFloat(bar.value)) + ' / ' + fmt(end) : '';
  });
}
/* まとめてシーク。1本だけなら意味が無いので、場所を取らずに消す
   （シークバーの幅をできるだけ残す） */
function renderGroupSeek(){
  const b = document.getElementById('groupSeek');
  if(!b) return;
  b.hidden = KEYS.filter(k => players[k]).length < 2;
  b.setAttribute('aria-pressed', String(groupSeek));
  b.title = groupSeek
    ? 'まとめてシーク ON — シークは全部に効きます（ズレは保ったまま）'
    : 'まとめてシーク OFF — シークは今映しているものだけに効きます。'
      + '開始時刻が違う動画の頭出しに使います';
}
function toggleGroupSeek(){
  groupSeek = !groupSeek;
  renderGroupSeek();
  renderTransport();          // 動画ごとのバーの出し入れを、押した瞬間に見せる
  setStatusLine(groupSeek
    ? 'まとめてシーク ON。シークは全部に効きます'
    : 'まとめてシーク OFF。シークは今映しているものだけに効きます');
}
/* 配信が終わったことを映像の上に出す。巻き戻せるかどうかとは関係なく出す。
   巻き戻し始めたら（シークバーに触れたら）邪魔なので消す。
   アーカイブは元から終わっているので、最後まで見ても出さない */
function renderEndedNote(){
  const el = document.getElementById('endedNote');
  if(!el) return;
  const k = videoSrc;
  el.hidden = !(players[k] && ready[k] && stateOf[k] === ST.ENDED
                && !isArchive(k) && !endedNoteOff[k]);
}
/* シーク系の操作が効くか。全配信が巻き戻せないなら押せなくして理由を出す。
   見ている配信だけ戻せないときは押せるままにし、何が起きるかを title で示す */
function renderRewind(scrub){
  const any = KEYS.some(seekable);
  const blocked = noRewindKeys();
  scrub.disabled = !any;
  document.querySelectorAll('[data-seek]').forEach(b => b.disabled = !any);
  const others = KEYS.filter(seekable).map(k => SRC_LABEL[k]).join('・');
  scrub.title = !any
    ? (blocked.length ? noRewindMessage(blocked) : '')
    : (!seekable(videoSrc) && players[videoSrc])
      ? SRC_LABEL[videoSrc] + ' は配信者が巻き戻しを無効にしています。シークは ' + others + ' にだけ効きます'
      : '';
}

/* スライダーは 左=過去 / 右=LIVE */
function renderTransport(){
  const scrub = document.getElementById('scrub');
  // 掴んでいる間に max を動かすと、離した瞬間に読み取る値がずれる
  if(!scrubbing) scrub.max = scrubSpan();
  if(!settling()) reconcileTransport();
  renderRewind(scrub);
  renderEndedNote();

  const off = scrubbing ? (scrub.max - parseFloat(scrub.value)) : shownOffset();
  if(!scrubbing) scrub.value = Math.max(0, scrub.max - Math.min(off, scrub.max));

  const pct = scrub.max > 0 ? (scrub.value / scrub.max) * 100 : 0;
  scrub.style.background =
    'linear-gradient(to right, var(--a) 0%, var(--a) ' + pct + '%, #2b3340 ' + pct + '%, #2b3340 100%)';

  renderGroupSeek();
  renderMultiScrub();
  const label = document.getElementById('offsetLabel');
  const btn = document.getElementById('golive');
  const posEl = document.getElementById('posLabel');
  /* アーカイブを見ているあいだは LIVE と言わない（原則2・原則4）。
     ライブの軸は「LIVE端からの遅れ」だが、動画はふつう頭からの経過で見る。
     スライダーは元から左端=先頭・右端=終端の絶対位置になっているので、
     ラベルも終端までの残りではなく経過時間を出す */
  const archive = isArchive(videoSrc);
  const atEnd = off < LIVE_BADGE && !paused;   // 一時停止中は端にいても追わない
  const atLive = atEnd && !archive;
  const end = liveEdge(videoSrc);
  const elapsed = end > 0 ? Math.max(0, end - off) : 0;
  /* アーカイブでは LIVE ボタンの場所を SYNC（他を今の位置へ揃える）にする。
     時間は隣の読みに出す。1本だけなら揃える相手がいないので出さない */
  const many = KEYS.filter(k => players[k]).length > 1;
  posEl.hidden = !archive;
  if(archive) posEl.textContent = fmt(elapsed) + ' / ' + fmt(end);
  btn.hidden = archive && !many;
  label.textContent = archive ? 'SYNC' : (atEnd ? 'LIVE' : '− ' + fmt(off));
  btn.classList.toggle('live', atLive);
  btn.classList.toggle('sync', archive);
  btn.title = archive
    ? '他の動画を、今映している動画と同じ位置へ揃える (L)'
    : 'LIVEの最先端へ (L)';
  // LIVE 中も押せる。表示が LIVE でも実際には数秒遅れていることがある
  btn.setAttribute('aria-label', archive
    ? '他の動画を、今映している動画（' + fmt(elapsed) + ' 地点）へ揃えます'
    : atEnd
      ? 'LIVE を再生中。押すと最先端へ追いつき直します'
      : fmt(off) + ' 遅れて再生中。押すと LIVE へ戻ります');

  renderRate();
  renderTrim();
  document.body.classList.toggle('paused', paused);
  const playLabel = paused ? '再生' : '一時停止';
  ['centerBtn','playBtn'].forEach(id => {
    const b = document.getElementById(id);
    b.title = playLabel + ' (K)';
    b.setAttribute('aria-label', playLabel);
  });
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
    '音量        ' + KEYS.filter(k => players[k]).map(k => SRC_LABEL[k] + ' ' + vol[k]).join(' / ') + '\n',
    '音声        ' + (audioKeys.join(' + ') || '選択なし')
                    + (muted ? '（ミュート）' : '')
                    + (mixMode ? '（同時再生 ON）' : '') + '\n',
    'Space       ' + (currentPair() ? currentPair().short : '—')
                    + ' / ' + (linkVideo ? '音声+映像' : '音声のみ') + '\n',
    '巻き戻し    ' + (KEYS.filter(k => players[k]).map(k => {
                      const r = readRewind(k);
                      return SRC_LABEL[k] + (r === false ? ' 不可' : r === true ? ' 可' : ' ?')
                             + (isArchive(k) ? '(アーカイブ)' : '');
                    }).join(' / ') || '—') + '\n',
    // 判定の材料そのもの。実機で取り違えが起きたときに確かめられるように出す
    '判定材料    ' + (KEYS.filter(k => players[k]).map(k => {
                      const vd = vdRaw[k] || {};
                      const cur = playerTime(k), end = archiveEnd(k);
                      return SRC_LABEL[k] + ' isLive=' + vd.isLive + ' dvr=' + vd.allowLiveDvr
                             + ' 位置=' + (cur === null ? '-' : Math.round(cur))
                             + ' 開始=' + (firstPos[k] === null ? '-' : Math.round(firstPos[k]))
                             + ' 長さ=' + Math.round(end);
                    }).join('\n            ') || '—')
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
/* ミュート解除チップを操作バーの真上に置くための実測値 */
function syncChromeHeight(){
  const h = Math.round(document.getElementById('bottomChrome').getBoundingClientRect().height);
  document.documentElement.style.setProperty('--chromeH', h + 'px');
}
syncChromeHeight();
window.addEventListener('resize', syncChromeHeight);
if(window.ResizeObserver){
  new ResizeObserver(syncSetupHeight).observe(document.getElementById('setup'));
  new ResizeObserver(syncChromeHeight).observe(document.getElementById('bottomChrome'));
}
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
  if(apiReady) build(ids, true);
  else { pending = ids; pendingSound = true; }
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
/* ライブなら LIVE端へ、アーカイブなら他を今の位置へ揃える */
function goLiveOrSync(){ archiveMode() ? syncToShown() : goLive(); }
document.getElementById('golive').addEventListener('click', goLiveOrSync);
document.getElementById('groupSeek').addEventListener('click', toggleGroupSeek);
document.getElementById('eco').addEventListener('click', toggleEco);
document.getElementById('linkVideo').addEventListener('click', toggleLinkVideo);
document.getElementById('swapCaretBtn').addEventListener('click', () => {
  swapMenuOpen() ? closeSwapMenu(true) : openSwapMenu();
});
document.querySelectorAll('.swapMenuItem').forEach(item => {
  item.addEventListener('click', () => {
    if(item.getAttribute('aria-disabled') === 'true') return;
    swapPairId = item.dataset.pair;
    renderSwapPair();
    // メニューを閉じたあとフォーカスが残ると Space がボタンに吸われる
    closeSwapMenu(false);
    reclaimFocus();
  });
});
document.getElementById('diagbtn').addEventListener('click', toggleDiag);
document.getElementById('playBtn').addEventListener('click', togglePlay);
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
document.querySelectorAll('[data-aud]').forEach(
  b => b.addEventListener('click', () => toggleAudioKey(b.dataset.aud)));
document.getElementById('mix').addEventListener('click', toggleMix);
document.querySelectorAll('[data-seek]').forEach(b => b.addEventListener('click', () => {
  // 映像の上のボタンは、隠れている操作を出したタップでは押さない（中央の
  // 再生ボタンと同じ扱い）。押せたときは、続けて押せるよう表示を延長する
  if(b.classList.contains('centerCtl')){
    if(swallowCenterClick) return;
    showCenter();
  }
  seekRelative(parseFloat(b.dataset.seek));
}));
document.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate))));
document.querySelectorAll('[data-trim]').forEach(b => b.addEventListener('click', () => adjustTrim(b.dataset.trim, parseFloat(b.dataset.d))));

document.getElementById('vol').addEventListener('input', function(){
  // unmute() は renderVolume() でバーを描き直すので、値は先に控えておく
  const v = parseFloat(this.value);
  // ミュート中にバーを動かしたら鳴らす（動かしたのに無音、を避ける）
  if(v > 0 && isMuted()) unmute();
  setVolume(v);
});
document.getElementById('volMute').addEventListener('click', toggleMute);
document.getElementById('unmuteChip').addEventListener('click', () => {
  unmute();
  reclaimFocus();
});
setVolume(100);
renderEco();
renderLinkVideo();
renderAvailability();

/* 動画ごとのシークバー。掴んだ1本を動かし、連動 ON なら残りも同じだけ動く */
document.querySelectorAll('#multiScrub .msRow').forEach(row => {
  const k = row.dataset.ms;
  const bar = row.querySelector('input');
  bar.addEventListener('input', () => { msDragKey = k; renderMultiScrub(); });
  bar.addEventListener('change', () => {
    msDragKey = null;
    seekArchiveTo(parseFloat(bar.value), k);
    scheduleSeekVerify();
    renderTransport();
  });
});

const scrubEl = document.getElementById('scrub');
/* 巻き戻しを始めたら「配信は終了しました」は用済み。つまみを掴んだ時点で消す */
['pointerdown','input','keydown'].forEach(ev =>
  scrubEl.addEventListener(ev, () => { endedNoteOff[videoSrc] = true; }));
scrubEl.addEventListener('input', () => { scrubbing = true; renderTransport(); });
scrubEl.addEventListener('change', () => {
  scrubbing = false;
  if(archiveMode()){
    // アーカイブはつまみの位置がそのまま動画の再生位置
    seekArchiveTo(parseFloat(scrubEl.value));
    scheduleSeekVerify();
  }else{
    targetOffset = Math.max(0, parseFloat(scrubEl.max) - parseFloat(scrubEl.value));
    seekAll();
  }
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
  if(e.key === 'ArrowUp'){ e.preventDefault(); setVolume(vol[volKey()] + (e.shiftKey ? 1 : 5)); return; }
  if(e.key === 'ArrowDown'){ e.preventDefault(); setVolume(vol[volKey()] - (e.shiftKey ? 1 : 5)); return; }

  const map = {
    '1':()=>setVideo('main'), '2':()=>setVideo('a'), '3':()=>setVideo('b'),
    'q':()=>toggleAudioKey('main'),
    'w':()=>toggleAudioKey('a'),
    'e':()=>toggleAudioKey('b'),
    'r':toggleMix,
    'm':toggleMute,
    'k':togglePlay, 'l':goLiveOrSync, 's':toggleLinkVideo, 'v':toggleEco, 'd':toggleDiag,
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
